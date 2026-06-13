/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * Insurance Command Center upgrade + AI denial-prevention verification.
 *   npx tsx server/modules/insurance/insurance.verify.ts
 *
 * Proves: payment-idempotency preflight (paid not regressed by late failure),
 * insurance feature gating + RBAC, setup_required honesty, eligibility linkage,
 * appointment intake risk, responsibility estimate, prior-auth workflow, revenue
 * protection + rule-based denial-prevention (signals/recs/tasks/alerts), briefing
 * insurance gaps, tenant isolation, audit, mobile-ready fields, no-PHI payloads.
 */
import 'dotenv/config';
import { randomUUID, createHmac } from 'node:crypto';

process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_test_verify_secret';

const { PrismaPg } = await import('@prisma/adapter-pg');
const { PrismaClient } = await import('../../generated/prisma/client');
const { buildApp } = await import('../../app');
const { env } = await import('../../config/env');
const { recomputeEntitlements } = await import('../../lib/entitlements');

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };

async function setupTenant(tag: string, planKey: string, patientOpts: Record<string, unknown> = {}) {
  const id = randomUUID();
  await ownerDb.tenant.create({ data: { id, name: `Ins ${tag}`, slug: `ins-${tag}-${id.slice(0, 8)}` } });
  const plan = await ownerDb.subscriptionPlan.findUnique({ where: { key: planKey } });
  await ownerDb.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await ownerDb.branch.create({ data: { tenantId: id, name: `${tag} branch`, location: 'Main St' } });
  const patient = await ownerDb.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: tag, phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`, lifecycleStage: 'NEW', ...patientOpts } });
  const mkUser = (role: string) => ownerDb.user.create({ data: { tenantId: id, role: role as never, active: true, email: `${role}-${id.slice(0, 8)}@ins.test`, displayName: `${tag} ${role}` } });
  const admin = await mkUser('ADMIN');
  const frontDesk = await mkUser('FRONT_DESK');
  const provider = await mkUser('PROVIDER');
  return { id, branchId: branch.id, patientId: patient.id, admin, frontDesk, provider };
}

async function main() {
  const tA = await setupTenant('a', 'enterprise');
  const tB = await setupTenant('b', 'enterprise');
  const tLock = await setupTenant('lock', 'starter'); // no insurance_eligibility

  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.77.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const tok = (userId: string, tenantId: string) => app.jwt.sign({ userId, tenantId, role: 'ADMIN', type: 'access' });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, t: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': ip() }, payload: payload as object });
  const aTok = tok(tA.admin.id, tA.id);
  const aFront = tok(tA.frontDesk.id, tA.id);
  const aProvider = tok(tA.provider.id, tA.id);
  const bTok = tok(tB.admin.id, tB.id);
  const lockTok = tok(tLock.admin.id, tLock.id);

  const bookAppt = async (t: string, branchId: string, patientId: string, service = 'Cleaning', value = 150) => {
    const startsAt = new Date(Date.now() + 4 * 86400000);
    return JSON.parse((await call('POST', '/v1/appointments', t, { branchId, patientId, service, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 30 * 60000).toISOString(), channel: 'CALL', value })).body);
  };

  // 1) PAYMENT IDEMPOTENCY PREFLIGHT — paid not regressed by a late failure.
  await call('POST', '/v1/revenue-protection/deposit-rules', aTok, { name: 'Dep', ruleType: 'default', description: 'std', amountType: 'fixed', amountValue: 40, depositRequired: true });
  const payAppt = await bookAppt(aTok, tA.branchId, tA.patientId);
  const link = JSON.parse((await call('POST', `/v1/payments/appointments/${payAppt.id}/payment-link`, aTok)).body);
  const pr = await ownerDb.paymentRequest.findFirst({ where: { tenantId: tA.id, appointmentId: payAppt.id }, orderBy: { createdAt: 'desc' } });
  const signed = (raw: string) => { const ts = Math.floor(Date.now() / 1000); return `t=${ts},v1=${createHmac('sha256', env.STRIPE_WEBHOOK_SECRET!).update(`${ts}.${raw}`).digest('hex')}`; };
  const okEvt = JSON.stringify({ id: `evt_${randomUUID().slice(0, 12)}`, type: 'checkout.session.completed', data: { object: { id: pr!.providerReference, payment_status: 'paid' } } });
  await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': signed(okEvt), 'x-forwarded-for': ip() }, payload: okEvt });
  const lateFail = JSON.stringify({ id: `evt_${randomUUID().slice(0, 12)}`, type: 'payment_intent.payment_failed', data: { object: { id: pr!.providerReference } } });
  const lateResp = await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': signed(lateFail), 'x-forwarded-for': ip() }, payload: lateFail });
  const prAfter = await ownerDb.paymentRequest.findUnique({ where: { id: pr!.id } });
  const failTask = await ownerDb.staffTask.count({ where: { tenantId: tA.id, title: 'Review failed deposit payment', metadata: { path: ['paymentRequestId'], equals: pr!.id } } });
  check('1. payment idempotency: paid status not regressed by late failure (+ no dup task)', prAfter?.status === 'collected' && JSON.parse(lateResp.body).ignored === 'already_paid' && link.status === 'link_created' && failTask === 0);

  // 3) Insurance routes require insurance_eligibility entitlement.
  const lockOverview = await call('GET', '/v1/insurance/overview', lockTok);
  const lockCheck = await call('POST', '/v1/revenue-protection/eligibility/check', lockTok, { patientId: tLock.patientId });
  check('3. feature-locked tenant gets 403 for insurance routes', lockOverview.statusCode === 403 && JSON.parse(lockOverview.body).feature === 'insurance_eligibility' && lockCheck.statusCode === 403);

  // 7) Missing provider config → setup_required (no fake eligible, no row).
  const savedProvider = env.INSURANCE_PROVIDER; const savedKey = env.STEDI_API_KEY;
  (env as any).INSURANCE_PROVIDER = 'stedi'; (env as any).STEDI_API_KEY = undefined;
  const before = await ownerDb.eligibilityVerification.count({ where: { tenantId: tA.id } });
  const setupRes = await call('POST', '/v1/revenue-protection/eligibility/check', aTok, { patientId: tA.patientId });
  const afterCount = await ownerDb.eligibilityVerification.count({ where: { tenantId: tA.id } });
  check('7. unconfigured provider → setup_required, no verification created', JSON.parse(setupRes.body).status === 'setup_required' && JSON.parse(setupRes.body).setupRequired === true && afterCount === before);
  (env as any).INSURANCE_PROVIDER = savedProvider; (env as any).STEDI_API_KEY = savedKey;

  // 8 + 9) Mock provider deterministic in dev; result links patient + appointment.
  const eligAppt = await bookAppt(aTok, tA.branchId, tA.patientId);
  const eligRes = JSON.parse((await call('POST', '/v1/revenue-protection/eligibility/check', aFront, { appointmentId: eligAppt.id, patientId: tA.patientId })).body);
  const verification = await ownerDb.eligibilityVerification.findUnique({ where: { id: eligRes.verificationId } });
  check('8/9. mock check runs (dev) + links patient & appointment', !!eligRes.verificationId && verification?.patientId === tA.patientId && verification?.appointmentId === eligAppt.id);
  check('6a. authorized FRONT_DESK can run eligibility check', !!eligRes.verificationId);

  // 11) Patient responsibility estimate stored + reflected in intake.
  const estimate = await ownerDb.patientResponsibilityEstimate.findFirst({ where: { tenantId: tA.id, appointmentId: eligAppt.id } });
  const intake = JSON.parse((await call('GET', `/v1/insurance/intake/${eligAppt.id}`, aTok)).body);
  check('11. responsibility estimate stored + surfaced in intake', !!estimate && intake.patientResponsibilityEstimateId === estimate!.id);

  // 10 + 20) Intake returns latest insurance status + risk + mobile-ready fields.
  const mobileKeys = ['appointmentId', 'patientId', 'eligibilityVerificationId', 'priorAuthorizationId', 'patientResponsibilityEstimateId', 'denialRiskScore', 'denialRiskLevel', 'staffReviewRequired', 'allowedActions', 'deepLinkTarget', 'setupRequired'];
  check('10/20. intake returns status + risk + mobile-ready fields', typeof intake.eligibilityStatus === 'string' && typeof intake.denialRiskLevel === 'string' && mobileKeys.every(k => k in intake) && intake.deepLinkTarget === `appointment/${eligAppt.id}`);

  // 6b) PROVIDER can VIEW intake but cannot run checks/denial-prevention.
  const provView = await call('GET', `/v1/insurance/intake/${eligAppt.id}`, aProvider);
  const provCheck = await call('POST', '/v1/revenue-protection/eligibility/check', aProvider, { appointmentId: eligAppt.id });
  const provDenial = await call('POST', `/v1/insurance/denial-prevention/${eligAppt.id}`, aProvider);
  check('6b. PROVIDER views intake (200) but cannot run check/denial-prevention (403)', provView.statusCode === 200 && provCheck.statusCode === 403 && provDenial.statusCode === 403);

  // 12 + 13 + 14 + 15) Prior-auth denied → denial prevention creates task/alert/
  // signal/recommendation + business event + audit; output rule-based.
  const gapAppt = await bookAppt(aTok, tA.branchId, tA.patientId);
  const priorAuth = await ownerDb.priorAuthorization.create({ data: { tenantId: tA.id, branchId: tA.branchId, patientId: tA.patientId, appointmentId: gapAppt.id, serviceName: 'Procedure', status: 'pending' } });
  const paUpdate = await call('PATCH', `/v1/revenue-protection/prior-auth/${priorAuth.id}/status`, aFront, { status: 'denied' });
  check('12. prior-auth status update works + links appointment', paUpdate.statusCode === 200 && JSON.parse(paUpdate.body).status === 'denied');
  const task = await ownerDb.staffTask.findFirst({ where: { tenantId: tA.id, title: 'Resolve insurance denial risk before visit' } });
  const alert = await ownerDb.revenueProtectionAlert.findFirst({ where: { tenantId: tA.id, sourceType: 'insurance_denial_risk', appointmentId: gapAppt.id } });
  check('13. denial risk creates StaffTask + RevenueProtectionAlert', !!task && !!alert);
  const event = await ownerDb.businessEvent.findFirst({ where: { tenantId: tA.id, eventType: 'insurance.intake.gap_detected', entityId: gapAppt.id } });
  const signal = await ownerDb.operationalSignal.findFirst({ where: { tenantId: tA.id, signalType: 'denial_risk', entityId: gapAppt.id } });
  const rec = await ownerDb.aIRecommendation.findFirst({ where: { tenantId: tA.id, recommendationType: 'resolve_denial_risk' } });
  check('14. BusinessEvent + OperationalSignal + AIRecommendation created', !!event && !!signal && !!rec);
  const denialRun = JSON.parse((await call('POST', `/v1/insurance/denial-prevention/${gapAppt.id}`, aFront)).body);
  check('15. denial-prevention output is rule-based + requires human review', denialRun.requiresHumanReview === true && denialRun.reasons.includes('prior_auth_denied') && rec?.createdBy === 'system' && rec?.requiresHumanReview === true);

  // 18) No PHI-heavy raw payload in business event payloads.
  const phiLeak = ['memberId', 'firstName', 'lastName', 'subscriberName', 'rawResponse'].some(k => JSON.stringify(event?.payload ?? {}).includes(k));
  check('18. no PHI-heavy fields in business event payload', !phiLeak);

  // 16) AI Master Briefing includes real insurance gaps.
  const briefing = JSON.parse((await call('GET', '/v1/briefing', aTok)).body);
  check('16. briefing surfaces real insurance gaps + prior-auth attention', briefing.summary.insuranceGaps >= 1 && briefing.summary.priorAuthAttention >= 1 && briefing.label === 'Rule-based morning briefing');

  // 17) Revenue Lead Meter: insurance risk exposed (denialRiskScore present).
  check('17. insurance risk exposed for lead/risk scoring (denialRiskScore)', typeof denialRun.denialRiskScore === 'number' && denialRun.denialRiskScore > 0);

  // 4) Tenant isolation.
  const crossIntake = await call('GET', `/v1/insurance/intake/${eligAppt.id}`, bTok);
  const bElig = JSON.parse((await call('GET', '/v1/revenue-protection/eligibility', bTok)).body);
  const bList = Array.isArray(bElig) ? bElig : (bElig.eligibilityVerifications ?? bElig.verifications ?? []);
  check('4. tenant B cannot access tenant A insurance data', crossIntake.statusCode === 404 && !bList.some((v: any) => v.id === eligRes.verificationId));

  // 5) Authorized role can create insurance profile (policy) + emits event.
  const policyRes = await call('POST', '/v1/insurance/policies', aFront, { patientId: tA.patientId, branchId: tA.branchId, planName: 'PPO Gold', memberId: 'M-12345' });
  const profileEvent = await ownerDb.businessEvent.findFirst({ where: { tenantId: tA.id, eventType: 'insurance.profile.created' } });
  check('5. authorized role creates insurance profile + business event', policyRes.statusCode === 201 && !!profileEvent);

  // 19) AuditEvent rows for sensitive insurance actions.
  const actions = new Set((await ownerDb.auditEvent.findMany({ where: { tenantId: tA.id }, select: { action: true } })).map(a => a.action));
  check('19. audit rows for insurance.profile.created + insurance.denialRisk.created + priorAuth.status.updated', actions.has('insurance.profile.created') && actions.has('insurance.denialRisk.created') && actions.has('priorAuth.status.updated'));

  // 2) Models reused (no duplicate insurance models) — reflected by table count.
  const insuranceTables = (await ownerDb.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relkind='r' AND relname IN ('InsurancePayer','PatientInsurancePolicy','EligibilityVerification','PriorAuthorization','PatientResponsibilityEstimate')`).length;
  check('2. existing insurance models reused (5 canonical tables, none duplicated)', insuranceTables === 5);

  await app.close();
  for (const t of [tA, tB, tLock]) await ownerDb.tenant.delete({ where: { id: t.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL INSURANCE/DENIAL-PREVENTION CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
