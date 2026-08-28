/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * Platform Admin / Super Admin Console (Phase B) verification.
 *   npx tsx server/modules/platform/platformAdmin.verify.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

// First PLATFORM_OWNER is seeded ONLY from these env vars.
process.env.PLATFORM_OWNER_EMAIL = `owner-${randomUUID().slice(0, 8)}@platform.test`;
process.env.PLATFORM_OWNER_NAME = 'Platform Owner';
process.env.PLATFORM_OWNER_PASSWORD = 'OwnerPass123!';

const { PrismaPg } = await import('@prisma/adapter-pg');
const { PrismaClient } = await import('../../generated/prisma/client');
const { buildApp } = await import('../../app');
const { env } = await import('../../config/env');
const { recomputeEntitlements } = await import('../../lib/entitlements');
const { ensurePlatformOwnerSeed } = await import('../../lib/platformAuth');
const { generateTotp } = await import('../../lib/totp');
const { decryptSecret, generatePasswordHash } = await import('../../lib/security');

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };

async function setupTenant(tag: string, planKey: string) {
  const id = randomUUID();
  await ownerDb.tenant.create({ data: { id, name: `Plat ${tag}`, slug: `plat-${tag}-${id.slice(0, 8)}`, status: 'active' } });
  const plan = await ownerDb.subscriptionPlan.findUnique({ where: { key: planKey } });
  await ownerDb.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, ownerDb);
  const branch = await ownerDb.branch.create({ data: { tenantId: id, name: `${tag} branch`, location: 'St' } });
  const admin = await ownerDb.user.create({ data: { tenantId: id, role: 'ADMIN' as never, active: true, email: `admin-${id.slice(0, 8)}@t.test`, displayName: 'admin', passwordHash: await generatePasswordHash('TenantPass123!') } });
  return { id, branchId: branch.id, admin };
}

async function main() {
  // 1) Owner seed from env.
  const seed = await ensurePlatformOwnerSeed();
  check('1. PLATFORM_OWNER seeded from env vars', seed.seeded === true && seed.reason === 'created');
  // 2) No weak default — without env vars, seeding is a no-op.
  const savedEmail = env.PLATFORM_OWNER_EMAIL; (env as any).PLATFORM_OWNER_EMAIL = undefined;
  const seed2 = await ensurePlatformOwnerSeed();
  check('2. no platform owner seeded without env (no weak default)', seed2.seeded === false && seed2.reason === 'env_not_set');
  (env as any).PLATFORM_OWNER_EMAIL = savedEmail;

  const tManaged = await setupTenant('managed', 'starter');

  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.111.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const post = (url: string, body?: unknown, token?: string) => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: body as object });
  const get = (url: string, token?: string) => app.inject({ method: 'GET', url, headers: { 'x-forwarded-for': ip(), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const patch = (url: string, body: unknown, token: string) => app.inject({ method: 'PATCH', url, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), authorization: `Bearer ${token}` }, payload: body as object });

  const ownerEmail = savedEmail!;

  // 3) Platform login requires MFA enrollment before issuing a session.
  const loginRes = await post('/v1/platform/auth/login', { email: ownerEmail, password: 'OwnerPass123!' });
  const initialLogin = JSON.parse(loginRes.body);
  const enrollmentToken = initialLogin.mfaToken as string;
  check('3. platform password login requires MFA enrollment and returns no session', loginRes.statusCode === 200 && initialLogin.mfaSetupRequired === true && !initialLogin.token && typeof enrollmentToken === 'string');

  const setup = JSON.parse((await post('/v1/platform/auth/mfa/setup', {}, enrollmentToken)).body);
  const enrollment = JSON.parse((await post('/v1/platform/auth/mfa/verify', { code: generateTotp(setup.secret) }, enrollmentToken)).body);
  const ownerSession = enrollment.token as string;
  check('5a. MFA enrollment issues the first platform session', typeof ownerSession === 'string');

  // 4) Login failure audited.
  await post('/v1/platform/auth/login', { email: ownerEmail, password: 'wrong' });
  const failAudit = await ownerDb.platformAuditEvent.findFirst({ where: { action: 'platform.login.failed' } });
  check('4. failed login is audited', !!failAudit);

  // 5) Subsequent login requires an MFA challenge.
  const loginMfa = JSON.parse((await post('/v1/platform/auth/login', { email: ownerEmail, password: 'OwnerPass123!' })).body);
  const ownerRow = await ownerDb.platformUser.findUnique({ where: { email: ownerEmail } });
  const challengeCode = generateTotp(decryptSecret(ownerRow!.mfaSecretEnc!)!);
  const mfaLogin = JSON.parse((await post('/v1/platform/auth/mfa/verify', { code: challengeCode }, loginMfa.mfaToken)).body);
  check('5b. MFA login challenge issues a new session', loginMfa.mfaRequired === true && typeof mfaLogin.token === 'string');

  // 7) Tenant JWT cannot access platform endpoints.
  const tenantJwt = app.jwt.sign({ userId: tManaged.admin.id, tenantId: tManaged.id, role: 'ADMIN', type: 'access' });
  const tenantOnPlatform = await get('/v1/platform/tenants', tenantJwt);
  check('7. tenant JWT cannot access platform endpoints (401)', tenantOnPlatform.statusCode === 401);

  // 8) Platform JWT cannot access tenant endpoints.
  const platformOnTenant = await get('/v1/subscriptions/current', ownerSession);
  check('8. platform JWT cannot access tenant endpoints (401)', platformOnTenant.statusCode === 401);

  // 9) Platform can create tenant.
  const newTag = randomUUID().slice(0, 8);
  const newTenant = await post('/v1/platform/tenants', { name: 'New Clinic', slug: `new-${newTag}`, planKey: 'starter', ownerName: 'New Owner', ownerEmail: `new-${newTag}@tenant.test`, ownerPassword: 'TenantOwnerPass123!' }, ownerSession);
  const createdTenant = JSON.parse(newTenant.body);
  check('9. platform user can create tenant (201, trial)', newTenant.statusCode === 201 && createdTenant.tenant.status === 'active' && createdTenant.subscription.status === 'TRIAL');

  // 10) Tenant list exposes no PHI.
  const list = JSON.parse((await get('/v1/platform/tenants', ownerSession)).body);
  const listStr = JSON.stringify(list);
  check('10. tenant list has summaries + no PHI fields', Array.isArray(list) && list[0].tenant && list[0].subscription !== undefined && !listStr.includes('firstName') && !listStr.includes('patient'));

  // 11) Platform can change plan.
  const changed = await post(`/v1/platform/tenants/${tManaged.id}/subscription/change-plan`, { planKey: 'command' }, ownerSession);
  const subAfter = await ownerDb.tenantSubscription.findUnique({ where: { tenantId: tManaged.id }, include: { plan: true } });
  check('11. platform user can change plan + entitlements recomputed', changed.statusCode === 200 && subAfter?.plan.key === 'command');

  // 12) Tenant admin cannot self-unlock a feature via platform endpoint.
  const selfUnlock = await patch(`/v1/platform/tenants/${tManaged.id}/entitlements/ai_receptionist`, { enabled: true }, tenantJwt);
  check('12. tenant admin cannot self-unlock feature (401 on platform endpoint)', selfUnlock.statusCode === 401);

  // 13) Subscription request approval updates subscription + entitlements.
  const growthPlan = await ownerDb.subscriptionPlan.findUnique({ where: { key: 'growth' } });
  const reqRow = await ownerDb.tenantSubscriptionRequest.create({ data: { tenantId: tManaged.id, requestType: 'DOWNGRADE', requestedPlanId: growthPlan!.id, requestedAddonKeys: [], status: 'PENDING' } });
  const approve = await post(`/v1/platform/subscription-requests/${reqRow.id}/approve`, { reviewerNote: 'ok' }, ownerSession);
  const subAfterApprove = await ownerDb.tenantSubscription.findUnique({ where: { tenantId: tManaged.id }, include: { plan: true } });
  check('13. subscription request approval updates subscription', approve.statusCode === 200 && JSON.parse(approve.body).status === 'APPROVED' && subAfterApprove?.plan.key === 'growth');

  // 14) Add-on enable updates entitlements.
  await post(`/v1/platform/tenants/${tManaged.id}/addons`, { addonKey: 'ai_receptionist' }, ownerSession);
  const aiEnt = await ownerDb.tenantFeatureEntitlement.findUnique({ where: { tenantId_featureKey: { tenantId: tManaged.id, featureKey: 'ai_receptionist' } } });
  check('14. add-on enable updates entitlements (ai_receptionist enabled)', aiEnt?.enabled === true);

  // 15 + 16) Suspension blocks tenant access; reactivation restores it.
  await post(`/v1/platform/tenants/${tManaged.id}/suspend`, {}, ownerSession);
  const suspendedAccess = await get('/v1/subscriptions/current', tenantJwt);
  const suspendedLogin = await post('/v1/auth/login', { email: tManaged.admin.email, password: 'TenantPass123!' });
  await post(`/v1/platform/tenants/${tManaged.id}/reactivate`, {}, ownerSession);
  const restoredAccess = await get('/v1/subscriptions/current', tenantJwt);
  check('15. suspension blocks tenant access (+ login)', suspendedAccess.statusCode === 403 && (suspendedAccess.body.includes('suspended_tenant')) && suspendedLogin.statusCode === 403);
  check('16. reactivation restores tenant access', restoredAccess.statusCode === 200);

  // 6 + 18) Create PLATFORM_ADMIN; ADMIN can manage tenants but not OWNER.
  const adminEmail = `padmin-${randomUUID().slice(0, 8)}@platform.test`;
  const createAdmin = await post('/v1/platform/users', { email: adminEmail, name: 'Admin', password: 'AdminPass123!', role: 'PLATFORM_ADMIN' }, ownerSession);
  const adminLogin = JSON.parse((await post('/v1/platform/auth/login', { email: adminEmail, password: 'AdminPass123!' })).body);
  const adminSetup = JSON.parse((await post('/v1/platform/auth/mfa/setup', {}, adminLogin.mfaToken)).body);
  const adminSession = JSON.parse((await post('/v1/platform/auth/mfa/verify', { code: generateTotp(adminSetup.secret) }, adminLogin.mfaToken)).body).token as string;
  const adminTag = randomUUID().slice(0, 8);
  const adminCreatesTenant = await post('/v1/platform/tenants', { name: 'Admin Clinic', slug: `ac-${adminTag}`, ownerName: 'Admin-created Owner', ownerEmail: `ac-${adminTag}@tenant.test`, ownerPassword: 'TenantOwnerPass123!' }, adminSession);
  check('6. PLATFORM_ADMIN can manage tenants (create 201)', createAdmin.statusCode === 201 && adminCreatesTenant.statusCode === 201);
  const adminTouchesOwner = await patch(`/v1/platform/users/${ownerRow!.id}`, { status: 'disabled' }, adminSession);
  check('18. PLATFORM_ADMIN cannot modify a PLATFORM_OWNER (403)', adminTouchesOwner.statusCode === 403);

  // 17) Last PLATFORM_OWNER cannot be disabled/demoted.
  const activeOwnerCount = await ownerDb.platformUser.count({ where: { role: 'PLATFORM_OWNER', status: 'active' } });
  const disableOwner = await patch(`/v1/platform/users/${ownerRow!.id}`, { status: 'disabled' }, ownerSession);
  check('17. owner lifecycle respects the last-owner invariant', activeOwnerCount === 1 ? disableOwner.statusCode === 409 : disableOwner.statusCode === 200);

  // 19) Platform audit rows exist for key actions.
  const actions = new Set((await ownerDb.platformAuditEvent.findMany({ select: { action: true } })).map(a => a.action));
  check('19. platform audit rows for login/tenant/subscription/user actions', ['platform.login.success', 'tenant.created', 'tenant.suspended', 'tenant.reactivated', 'subscription.plan.changed', 'subscription.request.approved', 'platform.user.created'].every(a => actions.has(a)));

  // 20) No secrets/PHI in platform audit metadata.
  const auditBlob = JSON.stringify(await ownerDb.platformAuditEvent.findMany({ select: { metadata: true } }));
  check('20. no secrets/PHI in platform audit metadata', !auditBlob.includes('OwnerPass123!') && !auditBlob.includes('AdminPass123!') && !auditBlob.includes(setup.secret));

  await app.close();
  // Cleanup.
  await ownerDb.platformUser.deleteMany({ where: { email: { in: [ownerEmail, adminEmail] } } }).catch(() => {});
  for (const id of [tManaged.id, createdTenant.tenant?.id, JSON.parse(adminCreatesTenant.body).tenant?.id].filter(Boolean)) await ownerDb.tenant.delete({ where: { id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL PLATFORM ADMIN CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
