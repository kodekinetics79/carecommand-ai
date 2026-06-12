/**
 * RLS Phase B-3 leakage verification for DepositRule, RevenueProtectionAlert,
 * and RevenueLeak. Run with the restricted role as the runtime connection:
 *   DATABASE_URL=postgres://app_rls:...  DATABASE_MIGRATION_URL=postgres://carecommand:...  \
 *   npx tsx server/lib/rlsWaveB3.verify.ts
 *
 * DATABASE_URL must be the non-superuser app_rls role; DATABASE_MIGRATION_URL is
 * the owner client used for fixtures + the owner-bypass control check.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { db } from './db';
import { runWithTenantContext, type TenantTxClient } from './tenantContext';

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures += 1;
}
async function expectReject(label: string, fn: () => Promise<unknown>) {
  try { await fn(); check(`${label} (expected rejection)`, false); }
  catch { check(label, true); }
}

const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) { console.error('DATABASE_MIGRATION_URL (owner role) is required.'); process.exit(2); }
const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) });

type Row = { id: string; tenantId: string };

interface Battery {
  label: string;
  ownerCreate: (tenantId: string, branchId: string) => Promise<Row>;
  ctxFindMany: (tx: TenantTxClient) => Promise<Row[]>;
  ctxCreate: (tx: TenantTxClient, tenantId: string, branchId: string) => Promise<Row>;
  noCtxFindById: (id: string) => Promise<Row[]>;
  noCtxCreate: (tenantId: string, branchId: string) => Promise<unknown>;
  ownerFindById: (id: string) => Promise<Row | null>;
}

async function runBattery(b: Battery, a: { tenantId: string; branchId: string }, bt: { tenantId: string; branchId: string }) {
  console.log(`\n— ${b.label} —`);
  const aRow = await b.ownerCreate(a.tenantId, a.branchId);
  const bRow = await b.ownerCreate(bt.tenantId, bt.branchId);

  const aReads = await runWithTenantContext(a.tenantId, tx => b.ctxFindMany(tx));
  check(`${b.label}: A sees own row`, aReads.some(r => r.id === aRow.id));
  check(`${b.label}: A does NOT see B row`, !aReads.some(r => r.id === bRow.id));

  const aCreated = await runWithTenantContext(a.tenantId, tx => b.ctxCreate(tx, a.tenantId, a.branchId));
  check(`${b.label}: A can insert own row`, !!aCreated.id);

  const bReads = await runWithTenantContext(bt.tenantId, tx => b.ctxFindMany(tx));
  check(`${b.label}: B cannot see A row`, !bReads.some(r => r.id === aRow.id));

  const noCtx = await b.noCtxFindById(aRow.id);
  check(`${b.label}: no-context read returns 0 rows`, noCtx.length === 0);
  await expectReject(`${b.label}: no-context insert rejected`, () => b.noCtxCreate(a.tenantId, a.branchId));

  await expectReject(`${b.label}: cross-tenant insert rejected (ctx A, tenant B)`, () =>
    runWithTenantContext(a.tenantId, tx => b.ctxCreate(tx, bt.tenantId, bt.branchId)));

  const [ca, cb] = await Promise.all([
    runWithTenantContext(a.tenantId, async tx => { await tx.$executeRaw`SELECT pg_sleep(0.15)`; return b.ctxFindMany(tx); }),
    runWithTenantContext(bt.tenantId, async tx => { await tx.$executeRaw`SELECT pg_sleep(0.15)`; return b.ctxFindMany(tx); }),
  ]);
  check(`${b.label}: concurrent A isolated`, ca.every(r => r.tenantId === a.tenantId));
  check(`${b.label}: concurrent B isolated`, cb.every(r => r.tenantId === bt.tenantId));

  const ownerSees = await b.ownerFindById(aRow.id);
  check(`${b.label}: owner role bypasses RLS (control)`, ownerSees?.id === aRow.id);
}

async function main() {
  const who = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
    SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`;
  check('runtime role is non-superuser/non-bypassrls', who[0]?.rolsuper === false && who[0]?.rolbypassrls === false);
  if (who[0]?.rolsuper || who[0]?.rolbypassrls) {
    console.error('ABORT: DATABASE_URL must be the restricted app_rls role.');
    await cleanup(); process.exit(2);
  }

  const a = { tenantId: randomUUID(), branchId: '' };
  const bt = { tenantId: randomUUID(), branchId: '' };
  await ownerDb.tenant.create({ data: { id: a.tenantId, name: 'B3 Tenant A', slug: `b3a-${a.tenantId.slice(0, 8)}` } });
  await ownerDb.tenant.create({ data: { id: bt.tenantId, name: 'B3 Tenant B', slug: `b3b-${bt.tenantId.slice(0, 8)}` } });
  a.branchId = (await ownerDb.branch.create({ data: { tenantId: a.tenantId, name: 'A branch', location: 'A' } })).id;
  bt.branchId = (await ownerDb.branch.create({ data: { tenantId: bt.tenantId, name: 'B branch', location: 'B' } })).id;

  await runBattery({
    label: 'DepositRule',
    ownerCreate: (tenantId, branchId) => ownerDb.depositRule.create({ data: { tenantId, branchId, name: 'r', ruleType: 'manual', description: 'd', amountType: 'fixed' } }),
    ctxFindMany: tx => tx.depositRule.findMany(),
    ctxCreate: (tx, tenantId, branchId) => tx.depositRule.create({ data: { tenantId, branchId, name: 'r2', ruleType: 'manual', description: 'd', amountType: 'fixed' } }),
    noCtxFindById: id => db.depositRule.findMany({ where: { id } }),
    noCtxCreate: (tenantId, branchId) => db.depositRule.create({ data: { tenantId, branchId, name: 'x', ruleType: 'manual', description: 'd', amountType: 'fixed' } }),
    ownerFindById: id => ownerDb.depositRule.findFirst({ where: { id } }),
  }, a, bt);

  await runBattery({
    label: 'RevenueProtectionAlert',
    ownerCreate: (tenantId, branchId) => ownerDb.revenueProtectionAlert.create({ data: { tenantId, branchId, sourceType: 'eligibility', severity: 'low', title: 't', description: 'd', status: 'open', recommendedAction: 'a' } }),
    ctxFindMany: tx => tx.revenueProtectionAlert.findMany(),
    ctxCreate: (tx, tenantId, branchId) => tx.revenueProtectionAlert.create({ data: { tenantId, branchId, sourceType: 'eligibility', severity: 'low', title: 't2', description: 'd', status: 'open', recommendedAction: 'a' } }),
    noCtxFindById: id => db.revenueProtectionAlert.findMany({ where: { id } }),
    noCtxCreate: (tenantId, branchId) => db.revenueProtectionAlert.create({ data: { tenantId, branchId, sourceType: 'eligibility', severity: 'low', title: 'x', description: 'd', status: 'open', recommendedAction: 'a' } }),
    ownerFindById: id => ownerDb.revenueProtectionAlert.findFirst({ where: { id } }),
  }, a, bt);

  await runBattery({
    label: 'RevenueLeak',
    ownerCreate: (tenantId, branchId) => ownerDb.revenueLeak.create({ data: { tenantId, branchId, category: 'c', source: 's', evidence: 'e', confidence: 50, status: 'open', workflowStatus: 'new', suggestedAction: 'a' } }),
    ctxFindMany: tx => tx.revenueLeak.findMany(),
    ctxCreate: (tx, tenantId, branchId) => tx.revenueLeak.create({ data: { tenantId, branchId, category: 'c', source: 's', evidence: 'e', confidence: 50, status: 'open', workflowStatus: 'new', suggestedAction: 'a' } }),
    noCtxFindById: id => db.revenueLeak.findMany({ where: { id } }),
    noCtxCreate: (tenantId, branchId) => db.revenueLeak.create({ data: { tenantId, branchId, category: 'c', source: 's', evidence: 'e', confidence: 50, status: 'open', workflowStatus: 'new', suggestedAction: 'a' } }),
    ownerFindById: id => ownerDb.revenueLeak.findFirst({ where: { id } }),
  }, a, bt);

  await cleanup(a.tenantId, bt.tenantId);
  console.log(`\n${failures === 0 ? 'ALL B-3 RLS CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function cleanup(tenantA?: string, tenantB?: string) {
  for (const t of [tenantA, tenantB]) {
    if (!t) continue;
    await ownerDb.revenueLeak.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await ownerDb.revenueProtectionAlert.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await ownerDb.depositRule.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await ownerDb.tenant.delete({ where: { id: t } }).catch(() => {});
  }
  await ownerDb.$disconnect();
  await db.$disconnect();
}

await main();
