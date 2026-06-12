/**
 * RLS Phase B-2 leakage verification for the pilot table NotificationTemplate
 * (representative of the 3 pilot tables — all share the identical policy).
 *
 * Run with the RESTRICTED role as the runtime connection:
 *   DATABASE_URL=postgres://app_rls:...@host/db \
 *   DATABASE_MIGRATION_URL=postgres://carecommand:...@host/db \
 *   npx tsx server/lib/rlsPilot.verify.ts
 *
 * - The shared `db` (DATABASE_URL) must be the non-superuser app_rls role, or
 *   the test refuses to run (a superuser would bypass RLS and false-pass).
 * - DATABASE_MIGRATION_URL is the owner client used for fixtures + the control
 *   check that proves the owner bypasses RLS (so the restricted role matters).
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { db } from './db';
import { runWithTenantContext } from './tenantContext';

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures += 1;
}
async function expectReject(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(`${label} (expected rejection)`, false);
  } catch {
    check(label, true);
  }
}

const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) {
  console.error('DATABASE_MIGRATION_URL (owner role) is required for fixtures.');
  process.exit(2);
}
const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) });

async function main() {
  // Guard: the runtime connection must NOT be a superuser/bypassrls role.
  const who = await db.$queryRaw<Array<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>>`
    SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`;
  const runtime = who[0];
  console.log(`runtime role: ${runtime?.current_user} (super=${runtime?.rolsuper}, bypassrls=${runtime?.rolbypassrls})`);
  check('runtime role is non-superuser', runtime?.rolsuper === false);
  check('runtime role is non-bypassrls', runtime?.rolbypassrls === false);
  if (runtime?.rolsuper || runtime?.rolbypassrls) {
    console.error('\nABORT: DATABASE_URL must point at the restricted app_rls role for a valid RLS test.');
    await cleanupAndExit();
    return;
  }

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  // Fixtures via the owner (bypasses RLS): two tenants + one pilot row each.
  await ownerDb.tenant.create({ data: { id: tenantA, name: 'RLS Tenant A', slug: `rls-a-${tenantA.slice(0, 8)}` } });
  await ownerDb.tenant.create({ data: { id: tenantB, name: 'RLS Tenant B', slug: `rls-b-${tenantB.slice(0, 8)}` } });
  const aRow = await ownerDb.notificationTemplate.create({ data: { tenantId: tenantA, name: 'A template', channel: 'email' } });
  const bRow = await ownerDb.notificationTemplate.create({ data: { tenantId: tenantB, name: 'B template', channel: 'sms' } });

  // 1) Tenant A can read its own rows (and only its own).
  const aReads = await runWithTenantContext(tenantA, tx => tx.notificationTemplate.findMany());
  check('A sees its own row', aReads.some(r => r.id === aRow.id));
  check('A does NOT see B row', !aReads.some(r => r.id === bRow.id));

  // 2) Tenant A can write its own rows.
  const aCreated = await runWithTenantContext(tenantA, tx =>
    tx.notificationTemplate.create({ data: { tenantId: tenantA, name: 'A second', channel: 'whatsapp' } }));
  check('A can insert its own row', !!aCreated.id);

  // 3) Tenant B cannot read Tenant A rows.
  const bSeesA = await runWithTenantContext(tenantB, tx => tx.notificationTemplate.findFirst({ where: { id: aRow.id } }));
  check('B cannot read A row by id', bSeesA === null);

  // 4) Missing tenant context (no GUC) returns no rows and rejects inserts.
  const noCtxReads = await db.notificationTemplate.findMany({ where: { id: aRow.id } });
  check('no-context read returns 0 rows (fail closed)', noCtxReads.length === 0);
  await expectReject('no-context insert is rejected by WITH CHECK', () =>
    db.notificationTemplate.create({ data: { tenantId: tenantA, name: 'no ctx', channel: 'email' } }));

  // 5) Cross-tenant write is rejected by WITH CHECK (context A, row tenant B).
  await expectReject('cross-tenant insert rejected (ctx A, tenantId B)', () =>
    runWithTenantContext(tenantA, tx => tx.notificationTemplate.create({ data: { tenantId: tenantB, name: 'evil', channel: 'email' } })));
  await expectReject('cross-tenant update rejected (ctx B targets A row)', () =>
    runWithTenantContext(tenantB, async tx => {
      const n = await tx.notificationTemplate.updateMany({ where: { id: aRow.id }, data: { name: 'hijacked' } });
      if (n.count === 0) throw new Error('no rows updated'); // RLS hid the row → treated as rejection
    }));

  // 6) Concurrent A/B contexts do not leak.
  const [ca, cb] = await Promise.all([
    runWithTenantContext(tenantA, async tx => { await tx.$executeRaw`SELECT pg_sleep(0.2)`; return tx.notificationTemplate.findMany(); }),
    runWithTenantContext(tenantB, async tx => { await tx.$executeRaw`SELECT pg_sleep(0.2)`; return tx.notificationTemplate.findMany(); }),
  ]);
  check('concurrent A sees only A rows', ca.every(r => r.tenantId === tenantA));
  check('concurrent B sees only B rows', cb.every(r => r.tenantId === tenantB));

  // 7) Control: the OWNER role bypasses RLS — proves the restricted role is what enforces.
  const ownerSeesA = await ownerDb.notificationTemplate.findFirst({ where: { id: aRow.id } });
  check('owner role bypasses RLS (sees A row) → restricted role is the enforcer', ownerSeesA?.id === aRow.id);

  await cleanupAndExit(tenantA, tenantB);
}

async function cleanupAndExit(tenantA?: string, tenantB?: string) {
  if (tenantA) await ownerDb.tenant.delete({ where: { id: tenantA } }).catch(() => {});
  if (tenantB) await ownerDb.tenant.delete({ where: { id: tenantB } }).catch(() => {});
  await ownerDb.$disconnect();
  await db.$disconnect();
  console.log(`\n${failures === 0 ? 'ALL RLS CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
