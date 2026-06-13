/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * Tenant Onboarding + Platform Control Plane verification.
 *   npx tsx server/modules/platform/platform.verify.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { buildApp } from '../../app';

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
const PLATFORM_TOKEN = process.env.PLATFORM_API_TOKEN ?? 'dev-platform-operator-token';
const DEV_TENANT = process.env.DEV_TENANT_ID!;
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };

async function main() {
  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.7.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const plat = (m: 'GET' | 'PATCH' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method: m, url, headers: { 'x-platform-token': PLATFORM_TOKEN, 'x-forwarded-for': ip() }, payload: payload as object });
  const tenantTok = (userId: string, tenantId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
  const tcall = (m: 'GET' | 'PATCH' | 'POST', url: string, t: string, payload?: unknown) =>
    app.inject({ method: m, url, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': ip() }, payload: payload as object });

  const slug = `clinic-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `owner-${randomUUID().slice(0, 8)}@onb.test`;
  const ownerPassword = 'Owner-Pass-9';

  // 1) Onboarding creates tenant, owner, branch, trial subscription, entitlements
  const onb = await plat('POST', '/v1/onboarding/tenant', {
    clinicName: 'Onboard Clinic', clinicSlug: slug, ownerName: 'Olivia Owner', ownerEmail, ownerPassword,
    defaultBranchName: 'Main Branch', timezone: 'America/New_York',
  });
  const onbBody = JSON.parse(onb.body);
  check('onboarding → 201 with tenant + owner + trial subscription', onb.statusCode === 201 && onbBody.subscription.status === 'TRIAL' && onbBody.subscription.planKey === 'starter');
  check('onboarding does not expose password hash', !JSON.stringify(onbBody).toLowerCase().includes('passwordhash') && !JSON.stringify(onbBody).includes('scrypt$'));
  const tenantA = onbBody.tenant.id; const ownerA = onbBody.owner.id;
  const dbBranch = await ownerDb.branch.count({ where: { tenantId: tenantA } });
  const dbEnt = await ownerDb.tenantFeatureEntitlement.count({ where: { tenantId: tenantA } });
  check('default branch + 15 entitlements created', dbBranch === 1 && dbEnt === 15);

  // 2) New owner can log in
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'x-forwarded-for': ip() }, payload: { email: ownerEmail, password: ownerPassword } });
  check('new tenant owner can log in', login.statusCode === 200 && !!JSON.parse(login.body).accessToken);

  const aTok = tenantTok(ownerA, tenantA);

  // 3) New tenant starts with Starter/trial features only
  const aFeatures = JSON.parse((await tcall('GET', '/v1/subscriptions/features', aTok)).body);
  const enabled = new Set(aFeatures.filter((f: any) => f.enabled).map((f: any) => f.featureKey));
  check('Starter trial enables base features only', enabled.has('appointments') && enabled.has('patient_crm') && !enabled.has('ai_receptionist'));

  // 13a) Feature gate blocks ai_receptionist before upgrade
  const lockedBefore = await tcall('GET', '/v1/receptionist/clinics', aTok);
  check('feature gate: receptionist 403 before upgrade', lockedBefore.statusCode === 403 && JSON.parse(lockedBefore.body).error === 'feature_locked');

  // 4) Tenant admin CANNOT self-upgrade for free → creates a request
  const selfUp = await tcall('PATCH', '/v1/subscriptions/admin/plan', aTok, { planKey: 'enterprise' });
  check('tenant admin self-upgrade blocked → request created', selfUp.statusCode === 202 && JSON.parse(selfUp.body).status === 'plan_change_requires_platform_approval');
  const subAfterAttempt = await ownerDb.tenantSubscription.findUnique({ where: { tenantId: tenantA }, include: { plan: true } });
  check('plan unchanged after self-upgrade attempt (still starter)', subAfterAttempt?.plan.key === 'starter');

  // 5) Request exists pending
  const reqRow = await ownerDb.tenantSubscriptionRequest.findFirst({ where: { tenantId: tenantA, status: 'PENDING' } });
  check('upgrade request is PENDING', !!reqRow);

  // 6) Platform operator approves → entitlements update
  const platReqs = JSON.parse((await plat('GET', '/v1/platform/subscription-requests?status=PENDING')).body);
  const targetReq = platReqs.find((r: any) => r.tenantId === tenantA);
  const approve = await plat('PATCH', `/v1/platform/subscription-requests/${targetReq.id}`, { decision: 'approve', reviewerNote: 'approved for test' });
  check('operator approves request → 200', approve.statusCode === 200 && JSON.parse(approve.body).status === 'APPROVED');
  const entAfter = await ownerDb.tenantFeatureEntitlement.findUnique({ where: { tenantId_featureKey: { tenantId: tenantA, featureKey: 'ai_receptionist' } } });
  check('entitlements updated after approval (ai_receptionist enabled)', entAfter?.enabled === true);

  // 13b) Feature gate now allows after upgrade
  const allowedAfter = await tcall('GET', '/v1/receptionist/clinics', aTok);
  check('feature gate: receptionist 200 after upgrade', allowedAfter.statusCode === 200);

  // 7) Reject leaves entitlements unchanged
  await tcall('POST', '/v1/subscriptions/requests', aTok, { planKey: 'starter', requestType: 'DOWNGRADE' });
  const pendReq2 = await ownerDb.tenantSubscriptionRequest.findFirst({ where: { tenantId: tenantA, status: 'PENDING' } });
  const reject = await plat('PATCH', `/v1/platform/subscription-requests/${pendReq2!.id}`, { decision: 'reject', reviewerNote: 'denied' });
  check('operator rejects request → REJECTED', reject.statusCode === 200 && JSON.parse(reject.body).status === 'REJECTED');
  const subAfterReject = await ownerDb.tenantSubscription.findUnique({ where: { tenantId: tenantA }, include: { plan: true } });
  check('subscription unchanged after rejection (still enterprise)', subAfterReject?.plan.key === 'enterprise');

  // 8) Tenant isolation — onboard tenant B; A cannot see B's data
  const slugB = `clinic-${randomUUID().slice(0, 8)}`;
  const onbB = JSON.parse((await plat('POST', '/v1/onboarding/tenant', { clinicName: 'Clinic B', clinicSlug: slugB, ownerName: 'Bob B', ownerEmail: `b-${randomUUID().slice(0, 8)}@onb.test`, ownerPassword, defaultBranchName: 'B Branch' })).body);
  const bTok = tenantTok(onbB.owner.id, onbB.tenant.id);
  const aReqList = JSON.parse((await tcall('GET', '/v1/subscriptions/requests', aTok)).body);
  const bReqList = JSON.parse((await tcall('GET', '/v1/subscriptions/requests', bTok)).body);
  check('request lists isolated (A has its own, B has none)', aReqList.length >= 1 && bReqList.length === 0);
  const aCur = JSON.parse((await tcall('GET', '/v1/subscriptions/current', aTok)).body);
  const bCur = JSON.parse((await tcall('GET', '/v1/subscriptions/current', bTok)).body);
  check('Tenant A sees enterprise, Tenant B sees starter (isolation)', aCur.plan?.key === 'enterprise' && bCur.plan?.key === 'starter');

  // 9) Tenant users cannot access /v1/platform/*
  const tenantHitsPlatform = await tcall('GET', '/v1/platform/tenants', aTok);
  check('tenant JWT cannot access platform (401)', tenantHitsPlatform.statusCode === 401);
  const noToken = await app.inject({ method: 'GET', url: '/v1/platform/tenants', headers: { 'x-forwarded-for': ip() } });
  check('platform without token → 401', noToken.statusCode === 401);

  // 10) Platform control plane exposes no PHI (patient-level field names / arrays).
  // Note: 'patient_crm' is a feature KEY, not PHI — so check for actual PHI field
  // names and the absence of any patient data array.
  const detail = JSON.parse((await plat('GET', `/v1/platform/tenants/${tenantA}`)).body);
  const detailStr = JSON.stringify(detail).toLowerCase();
  const phiFields = ['firstname', 'lastname', 'dateofbirth', '"dob"', 'ssn', '"mrn"', 'medicalrecord', '"patients"', 'phonenumber'];
  check('platform tenant detail exposes no PHI fields/arrays', phiFields.every(p => !detailStr.includes(p)) && !('patients' in detail));

  // Suspend / reactivate
  const suspend = await plat('PATCH', `/v1/platform/tenants/${tenantA}/status`, { action: 'suspend' });
  const entSuspended = await ownerDb.tenantFeatureEntitlement.count({ where: { tenantId: tenantA, enabled: true } });
  check('suspend tenant locks all features', suspend.statusCode === 200 && entSuspended === 0);
  await plat('PATCH', `/v1/platform/tenants/${tenantA}/status`, { action: 'reactivate' });
  const entReactivated = await ownerDb.tenantFeatureEntitlement.count({ where: { tenantId: tenantA, enabled: true } });
  check('reactivate restores features', entReactivated > 0);

  // 11) Dev tenant remains Enterprise/ACTIVE
  const devSub = await ownerDb.tenantSubscription.findUnique({ where: { tenantId: DEV_TENANT }, include: { plan: true } });
  check('dev tenant remains Enterprise/ACTIVE', devSub?.plan.key === 'enterprise' && devSub.status === 'ACTIVE');

  // 12) Audit events for lifecycle
  const actions = new Set((await ownerDb.auditEvent.findMany({ where: { tenantId: tenantA }, select: { action: true } })).map(a => a.action));
  check('audit: tenant.created + owner.created', actions.has('tenant.created') && actions.has('tenant.owner.created'));
  check('audit: requested + approved + rejected', actions.has('subscription.requested') && actions.has('subscription.request.approved') && actions.has('subscription.request.rejected'));
  check('audit: suspended + reactivated', actions.has('tenant.suspended') && actions.has('tenant.reactivated'));

  await app.close();
  await ownerDb.tenant.delete({ where: { id: tenantA } }).catch(() => {});
  await ownerDb.tenant.delete({ where: { id: onbB.tenant.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL ONBOARDING/PLATFORM CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
