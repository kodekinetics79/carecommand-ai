 
/**
 * Subscription commercial-layer verification.
 *   npx tsx server/modules/subscriptions/subscriptions.verify.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { buildApp } from '../../app';
import { recomputeEntitlements } from '../../lib/entitlements';

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };
const DEV_TENANT = process.env.DEV_TENANT_ID!;
const DEV_USER = process.env.DEV_USER_ID!;

async function setupTenant(tag: string, planKey: string) {
  const id = randomUUID();
  await ownerDb.tenant.create({ data: { id, name: `Sub ${tag}`, slug: `sub-${tag}-${id.slice(0, 8)}` } });
  const user = await ownerDb.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `${tag}-${id.slice(0, 8)}@sub.test`, displayName: tag } });
  const plan = await ownerDb.subscriptionPlan.findUnique({ where: { key: planKey } });
  await ownerDb.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  return { id, userId: user.id };
}

async function main() {
  // 1) Plans seeded once + idempotent
  check('exactly 4 plans seeded', (await ownerDb.subscriptionPlan.count()) === 4);
  check('8 add-ons seeded', (await ownerDb.subscriptionAddon.count()) === 8);

  // 2) Existing dev tenant has a subscription
  const devSub = await ownerDb.tenantSubscription.findUnique({ where: { tenantId: DEV_TENANT }, include: { plan: true } });
  check('dev tenant has a subscription (Enterprise)', devSub?.plan.key === 'enterprise');

  const tLock = await setupTenant('lock', 'starter');   // no ai_receptionist
  const tB = await setupTenant('b', 'growth');

  // 3) Feature entitlement resolution
  const lockEnts = await ownerDb.tenantFeatureEntitlement.findMany({ where: { tenantId: tLock.id } });
  const enabledKeys = new Set(lockEnts.filter(e => e.enabled).map(e => e.featureKey));
  check('Starter resolves base features only (idempotent count 15 rows)', lockEnts.length === 15 && enabledKeys.has('appointments') && enabledKeys.has('patient_crm') && !enabledKeys.has('ai_receptionist'));
  // idempotency: recompute again → still 15 rows, no dupes
  await recomputeEntitlements(tLock.id);
  check('recompute is idempotent (no duplicate entitlement rows)', (await ownerDb.tenantFeatureEntitlement.count({ where: { tenantId: tLock.id } })) === 15);

  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.9.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const tok = (userId: string, tenantId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
  const call = (method: 'GET' | 'PATCH', url: string, t: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': ip() }, payload: payload as object });
  const devTok = tok(DEV_USER, DEV_TENANT);
  const lockTok = tok(tLock.userId, tLock.id);
  const bTok = tok(tB.userId, tB.id);

  // 4) Locked feature → 403 feature_locked
  const locked = await call('GET', '/v1/receptionist/clinics', lockTok);
  const lockedBody = JSON.parse(locked.body);
  check('locked feature returns 403 feature_locked', locked.statusCode === 403 && lockedBody.error === 'feature_locked' && lockedBody.feature === 'ai_receptionist');

  // 5) Enabled feature → 200 (dev tenant Enterprise has ai_receptionist)
  const enabled = await call('GET', '/v1/receptionist/clinics', devTok);
  check('enabled feature returns 200', enabled.statusCode === 200);

  // 6) Tenant isolation — each /current shows its own plan only
  const lockCur = JSON.parse((await call('GET', '/v1/subscriptions/current', lockTok)).body);
  const bCur = JSON.parse((await call('GET', '/v1/subscriptions/current', bTok)).body);
  check('Tenant A sees own plan (starter), not B', lockCur.plan?.key === 'starter');
  check('Tenant B sees own plan (growth)', bCur.plan?.key === 'growth');

  // 9) Feature matrix renders from real API
  const matrix = JSON.parse((await call('GET', '/v1/subscriptions/features', lockTok)).body);
  check('features matrix returns 15 entitlements', Array.isArray(matrix) && matrix.length === 15);

  // 7) Tenant-admin plan change is now an APPROVAL REQUEST (no free self-upgrade).
  const patch = await call('PATCH', '/v1/subscriptions/admin/plan', lockTok, { planKey: 'command' });
  check('admin plan change creates request (202, not direct change)', patch.statusCode === 202 && JSON.parse(patch.body).status === 'plan_change_requires_platform_approval');
  const auditRow = await ownerDb.auditEvent.findFirst({ where: { tenantId: tLock.id, action: 'subscription.requested' } });
  check('plan request writes AuditEvent (subscription.requested)', !!auditRow);
  const afterAttempt = await ownerDb.tenantSubscription.findUnique({ where: { tenantId: tLock.id }, include: { plan: true } });
  check('plan NOT changed by tenant admin (still starter)', afterAttempt?.plan.key === 'starter');
  const stillLocked = await call('GET', '/v1/receptionist/clinics', lockTok);
  check('feature still locked (no free self-upgrade)', stillLocked.statusCode === 403);

  // 10) Compliance still works for entitled tenant (no wording regression)
  const dash = await call('GET', '/v1/compliance/dashboard', devTok);
  check('compliance dashboard still 200 for entitled tenant + MFA integrated', dash.statusCode === 200 && JSON.parse(dash.body).mfaStatus?.integrated === true);

  // 11) No RLS on subscription tables
  const rls = new Set((await ownerDb.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relkind='r' AND relrowsecurity=true`).map(r => r.relname));
  check('no RLS on subscription tables', !rls.has('TenantSubscription') && !rls.has('TenantFeatureEntitlement') && !rls.has('SubscriptionPlan'));

  await app.close();
  await ownerDb.tenant.delete({ where: { id: tLock.id } }).catch(() => {});
  await ownerDb.tenant.delete({ where: { id: tB.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL SUBSCRIPTION CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
