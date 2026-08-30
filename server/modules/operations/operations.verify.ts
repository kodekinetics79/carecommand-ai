/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * Core operations + intelligence + risk-closure verification.
 *   npx tsx server/modules/operations/operations.verify.ts
 *
 * Proves the REAL existing operational flow: appointment create/cancel/
 * reschedule with deposit wiring, service catalog CRUD, rule-based intelligence
 * (events/signals/recommendations), AI-ready morning briefing, integration hub
 * truthful states, tenant isolation, RBAC, and audit. Does not fake unavailable
 * features — branch/provider/availability modules are exercised only as they exist.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const { PrismaPg } = await import('@prisma/adapter-pg');
const { PrismaClient } = await import('../../generated/prisma/client');
const { buildApp } = await import('../../app');
const { recomputeEntitlements } = await import('../../lib/entitlements');
const { recordWorkflowEvent } = await import('../../lib/intelligence');

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };

async function setupTenant(tag: string, planKey: string) {
  const id = randomUUID();
  await ownerDb.tenant.create({ data: { id, name: `Ops ${tag}`, slug: `ops-${tag}-${id.slice(0, 8)}` } });
  const plan = await ownerDb.subscriptionPlan.findUnique({ where: { key: planKey } });
  await ownerDb.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await ownerDb.branch.create({ data: { tenantId: id, name: `${tag} branch`, location: 'Main St' } });
  const patient = await ownerDb.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: tag, phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`, lifecycleStage: 'NEW' } });
  const mkUser = (role: string) => ownerDb.user.create({ data: { tenantId: id, role: role as never, active: true, email: `${role}-${id.slice(0, 8)}@ops.test`, displayName: `${tag} ${role}` } });
  const admin = await mkUser('ADMIN');
  const provider = await mkUser('PROVIDER');
  return { id, branchId: branch.id, patientId: patient.id, admin, provider };
}

async function main() {
  const tA = await setupTenant('a', 'enterprise');
  const tB = await setupTenant('b', 'enterprise');

  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.66.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const tok = (userId: string, tenantId: string) => app.jwt.sign({ userId, tenantId, role: 'ADMIN', type: 'access' });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, t: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': ip() }, payload: payload as object });
  const aTok = tok(tA.admin.id, tA.id);
  const aProvider = tok(tA.provider.id, tA.id);
  const bTok = tok(tB.admin.id, tB.id);

  // Deposit rule so bookings link a requirement.
  await call('POST', '/v1/revenue-protection/deposit-rules', aTok, { name: 'Ops deposit', ruleType: 'default', description: 'Std deposit', amountType: 'fixed', amountValue: 40, depositRequired: true, dueTiming: 'at_booking' });

  // --- Service Catalog (Risk B) ------------------------------------------
  const svcRes = await call('POST', '/v1/services', aTok, { name: 'Cleaning', category: 'dental', defaultDurationMinutes: 45, defaultAppointmentValue: 150 });
  check('Service catalog: create (201) + mapped value', svcRes.statusCode === 201 && JSON.parse(svcRes.body).defaultAppointmentValue === 150);
  const svcList = await call('GET', '/v1/services', aTok);
  check('Service catalog: list contains item', svcList.statusCode === 200 && JSON.parse(svcList.body).some((s: any) => s.name === 'Cleaning'));
  const provSvc = await call('POST', '/v1/services', aProvider, { name: 'Nope', category: 'x' });
  check('Service catalog: PROVIDER cannot create (403)', provSvc.statusCode === 403);

  // --- Appointment booking + deposit linkage + event ---------------------
  const book = async (t: string, branchId: string, patientId: string) => {
    const startsAt = new Date(Date.now() + 4 * 86400000);
    return call('POST', '/v1/appointments', t, { branchId, patientId, service: 'Cleaning', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 45 * 60000).toISOString(), channel: 'CALL', value: 150 });
  };
  const appt = JSON.parse((await book(aTok, tA.branchId, tA.patientId)).body);
  check('Appointment booking links deposit requirement', appt.depositEvaluation?.created === true);
  const evtCreated = await ownerDb.businessEvent.findFirst({ where: { tenantId: tA.id, eventType: 'appointment.created', entityId: appt.id } });
  const evtDeposit = await ownerDb.businessEvent.findFirst({ where: { tenantId: tA.id, eventType: 'deposit.required' } });
  check('Intelligence: appointment.created + deposit.required events emitted', !!evtCreated && !!evtDeposit);

  // --- Cancel wires deposit void (no fake refund) (Risk A) ---------------
  const cancelRes = await call('PATCH', `/v1/appointments/${appt.id}/cancel`, aTok, { reason: 'patient request' });
  const cancelBody = JSON.parse(cancelRes.body);
  const reqAfterCancel = await ownerDb.depositRequirement.findFirst({ where: { tenantId: tA.id, appointmentId: appt.id } });
  check('Cancel: status CANCELED + unpaid deposit voided (not refunded)', cancelRes.statusCode === 200 && cancelBody.status === 'CANCELED' && cancelBody.deposit.updated === 1 && cancelBody.deposit.needsManualRefund === false && reqAfterCancel?.status === 'cancelled');
  const auditCancel = await ownerDb.auditEvent.findFirst({ where: { tenantId: tA.id, action: 'appointment.cancelled', resourceId: appt.id } });
  const evtCancel = await ownerDb.businessEvent.findFirst({ where: { tenantId: tA.id, eventType: 'appointment.cancelled', entityId: appt.id } });
  check('Cancel: audit + business event recorded', !!auditCancel && !!evtCancel);

  // --- Reschedule preserves deposit idempotently (Risk A) ----------------
  const appt2 = JSON.parse((await book(aTok, tA.branchId, tA.patientId)).body);
  const reqCountBefore = await ownerDb.depositRequirement.count({ where: { tenantId: tA.id, appointmentId: appt2.id } });
  const newStart = new Date(Date.now() + 6 * 86400000);
  const reschedRes = await call('PATCH', `/v1/appointments/${appt2.id}/reschedule`, aTok, { startsAt: newStart.toISOString(), endsAt: new Date(newStart.getTime() + 45 * 60000).toISOString() });
  const reqCountAfter = await ownerDb.depositRequirement.count({ where: { tenantId: tA.id, appointmentId: appt2.id } });
  const reschedBody = JSON.parse(reschedRes.body);
  check('Reschedule: deposit preserved, not duplicated (idempotent)', reschedRes.statusCode === 200 && reqCountBefore === 1 && reqCountAfter === 1 && reschedBody.depositEvaluation?.created === false);
  const auditResched = await ownerDb.auditEvent.findFirst({ where: { tenantId: tA.id, action: 'appointment.rescheduled', resourceId: appt2.id } });
  check('Reschedule: audit + correct payment status returned', !!auditResched && reschedBody.payment?.status === 'required_unpaid');

  // --- Rule-based intelligence: signal + recommendation (Part 3) ---------
  const fakePr = randomUUID();
  await recordWorkflowEvent(tA.id, { eventType: 'payment.failed', entityType: 'paymentRequest', entityId: fakePr, sourceModule: 'test', payload: {} });
  await recordWorkflowEvent(tA.id, { eventType: 'payment.failed', entityType: 'paymentRequest', entityId: fakePr, sourceModule: 'test', payload: {} });
  const signals = await ownerDb.operationalSignal.count({ where: { tenantId: tA.id, signalType: 'payment_failed', entityId: fakePr } });
  const recs = await ownerDb.aIRecommendation.count({ where: { tenantId: tA.id, recommendationType: 'review_failed_payment', status: 'pending' } });
  check('Intelligence: payment.failed derives one signal + one rec (idempotent)', signals === 1 && recs === 1);

  // --- AI-ready morning briefing (Part 4) — real data only ---------------
  const briefing = JSON.parse((await call('GET', '/v1/briefing', aTok)).body);
  check('Briefing: rule-based label + real numeric summary', briefing.label === 'Rule-based morning briefing' && typeof briefing.summary.failedPayments === 'number' && typeof briefing.summary.openSignals === 'number' && Array.isArray(briefing.topRecommendations));
  check('Briefing: surfaces the rule-based recommendation', briefing.topRecommendations.some((r: any) => r.recommendationType === 'review_failed_payment' && r.requiresHumanReview === true && r.createdBy === 'system'));

  // --- Recommendation triage + audit -------------------------------------
  const recRow = JSON.parse((await call('GET', '/v1/recommendations?status=pending', aTok)).body).find((r: any) => r.recommendationType === 'review_failed_payment');
  const triage = await call('PATCH', `/v1/recommendations/${recRow.id}`, aTok, { status: 'accepted' });
  const triageAudit = await ownerDb.auditEvent.findFirst({ where: { tenantId: tA.id, action: 'aiRecommendation.statusChanged', resourceId: recRow.id } });
  check('Recommendation triage updates status + audits', triage.statusCode === 200 && JSON.parse(triage.body).status === 'accepted' && !!triageAudit);

  // --- Capabilities: our words, no supplier, no credential names ---------
  // This checked the tenant integration hub's provider rows until the supplier
  // catalogue moved to the platform console. What a tenant receives now is a
  // capability statement, and the assertion is that it carries no vendor name
  // and no environment variable.
  const caps = JSON.parse((await call('GET', '/v1/capabilities', aTok)).body);
  const capsText = JSON.stringify(caps).toLowerCase();
  check('Capabilities: eligibility + card payments, each with a state and a next step',
    Array.isArray(caps) && caps.length === 2
    && caps.every((c: any) => ['available', 'test_data', 'not_set_up'].includes(c.state) && typeof c.detail === 'string' && c.detail.length > 20));
  check('Capabilities: name no supplier and no credential variable',
    !['stedi', 'stripe', 'twilio', 'retell', '_api_key', '_secret_key'].some(token => capsText.includes(token)));

  // --- Tenant isolation (Part 7 #13) -------------------------------------
  const bRecs = JSON.parse((await call('GET', '/v1/recommendations', bTok)).body);
  const bSignals = JSON.parse((await call('GET', '/v1/signals', bTok)).body);
  const bServices = JSON.parse((await call('GET', '/v1/services', bTok)).body);
  check('Tenant isolation: B sees none of A signals/recs/services', !bRecs.some((r: any) => r.id === recRow.id) && bSignals.length === 0 && !bServices.some((s: any) => s.name === 'Cleaning'));
  const crossBrief = JSON.parse((await call('GET', '/v1/briefing', bTok)).body);
  check('Tenant isolation: B briefing does not include A failed payments', crossBrief.summary.failedPayments === 0);

  // --- New intelligence tables are not RLS-forced (RLS-ready only) -------
  const rls = new Set((await ownerDb.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relkind='r' AND relrowsecurity=true`).map(r => r.relname));
  check('Intelligence/service tables RLS-ready but not enabled', !rls.has('BusinessEvent') && !rls.has('OperationalSignal') && !rls.has('AIRecommendation') && !rls.has('ServiceCatalogItem'));

  await app.close();
  for (const t of [tA, tB]) await ownerDb.tenant.delete({ where: { id: t.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL CORE OPERATIONS CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
