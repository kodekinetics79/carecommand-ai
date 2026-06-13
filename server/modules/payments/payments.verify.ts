/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * Appointment Checkout — Payments / Deposits Phase A verification.
 *   npx tsx server/modules/payments/payments.verify.ts
 *
 * Proves deposit-rule CRUD, deposit auto-linkage on booking (idempotent),
 * entitlement + RBAC gating, honest Stripe setup_required, mock link creation,
 * signed + idempotent webhook, appointment payment status, revenue-protection
 * signal/task on failure, tenant isolation, audit trail, and mobile-ready fields.
 */
import 'dotenv/config';
import { randomUUID, createHmac } from 'node:crypto';

// A signed Stripe webhook test needs the secret present when env.ts parses.
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_test_verify_secret';

const { PrismaPg } = await import('@prisma/adapter-pg');
const { PrismaClient } = await import('../../generated/prisma/client');
const { buildApp } = await import('../../app');
const { env } = await import('../../config/env');
const { recomputeEntitlements } = await import('../../lib/entitlements');

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };

async function setupTenant(tag: string, planKey: string) {
  const id = randomUUID();
  await ownerDb.tenant.create({ data: { id, name: `Pay ${tag}`, slug: `pay-${tag}-${id.slice(0, 8)}` } });
  const plan = await ownerDb.subscriptionPlan.findUnique({ where: { key: planKey } });
  await ownerDb.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await ownerDb.branch.create({ data: { tenantId: id, name: `${tag} branch`, location: 'Main St' } });
  const patient = await ownerDb.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: tag, phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`, lifecycleStage: 'NEW' } });
  const mkUser = (role: string) => ownerDb.user.create({ data: { tenantId: id, role: role as never, active: true, email: `${role}-${id.slice(0, 8)}@pay.test`, displayName: `${tag} ${role}` } });
  const admin = await mkUser('ADMIN');
  const frontDesk = await mkUser('FRONT_DESK');
  const provider = await mkUser('PROVIDER');
  return { id, branchId: branch.id, patientId: patient.id, admin, frontDesk, provider };
}

async function main() {
  const tEnt = await setupTenant('ent', 'enterprise');  // payments_deposits + appointments
  const tB = await setupTenant('b', 'enterprise');       // isolation peer
  const tLock = await setupTenant('lock', 'starter');    // no payments_deposits

  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.55.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const tok = (userId: string, tenantId: string) => app.jwt.sign({ userId, tenantId, role: 'ADMIN', type: 'access' });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, t: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': ip() }, payload: payload as object });
  const entTok = tok(tEnt.admin.id, tEnt.id);
  const entFront = tok(tEnt.frontDesk.id, tEnt.id);
  const entProvider = tok(tEnt.provider.id, tEnt.id);
  const bTok = tok(tB.admin.id, tB.id);
  const lockTok = tok(tLock.admin.id, tLock.id);

  const bookAppt = async (t: string, branchId: string, patientId: string, value = 200) => {
    const startsAt = new Date(Date.now() + 3 * 86400000);
    const res = await call('POST', '/v1/appointments', t, { branchId, patientId, service: 'Consultation', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 30 * 60000).toISOString(), channel: 'CALL', value });
    return res;
  };

  // 2) Deposit rule CRUD (tenant-default fixed rule).
  const ruleRes = await call('POST', '/v1/revenue-protection/deposit-rules', entTok, { name: 'Default deposit', ruleType: 'default', description: 'Standard appointment deposit', amountType: 'fixed', amountValue: 50, depositRequired: true, dueTiming: 'at_booking' });
  check('2. deposit rule create (201) + readable', ruleRes.statusCode === 201 && JSON.parse(ruleRes.body).amountValue === 50);
  const listRules = await call('GET', '/v1/revenue-protection/deposit-rules', entTok);
  check('2b. deposit rule appears in list', listRules.statusCode === 200 && JSON.parse(listRules.body).depositRules.some((r: any) => r.name === 'Default deposit'));

  // 3) Booking creates a linked deposit requirement.
  const apptRes = await bookAppt(entTok, tEnt.branchId, tEnt.patientId);
  const appt = JSON.parse(apptRes.body);
  check('3. booking creates linked deposit requirement', apptRes.statusCode === 201 && appt.depositEvaluation?.created === true && appt.depositEvaluation?.requiredAmount === 50);
  const reqCount1 = await ownerDb.depositRequirement.count({ where: { tenantId: tEnt.id, appointmentId: appt.id } });
  check('3b. exactly one requirement row exists', reqCount1 === 1);

  // 4) No duplicate requirement on repeated evaluation (idempotent).
  const reEval = await call('POST', `/v1/payments/appointments/${appt.id}/deposit`, entTok);
  const reEvalBody = JSON.parse(reEval.body);
  const reqCount2 = await ownerDb.depositRequirement.count({ where: { tenantId: tEnt.id, appointmentId: appt.id } });
  check('4. repeated evaluation does not duplicate requirement', reEvalBody.evaluation?.created === false && reqCount2 === 1);

  // 5) Feature-locked tenant → 403 on payment/deposit actions.
  const lockAppt = await bookAppt(lockTok, tLock.branchId, tLock.patientId);
  const lockApptId = JSON.parse(lockAppt.body).id;
  const lockedRule = await call('POST', '/v1/revenue-protection/deposit-rules', lockTok, { name: 'x', ruleType: 'default', description: 'xx', amountType: 'fixed', amountValue: 10 });
  const lockedLink = await call('POST', `/v1/payments/appointments/${lockApptId}/payment-link`, lockTok);
  check('5. feature-locked tenant gets 403 feature_locked', lockedRule.statusCode === 403 && JSON.parse(lockedRule.body).feature === 'payments_deposits' && lockedLink.statusCode === 403 && JSON.parse(lockedLink.body).feature === 'payments_deposits');

  // 7) Unauthorized role (PROVIDER) cannot configure deposit rules / deposits.
  const provRule = await call('POST', '/v1/revenue-protection/deposit-rules', entProvider, { name: 'no', ruleType: 'default', description: 'no', amountType: 'fixed', amountValue: 10 });
  const provDeposit = await call('POST', `/v1/payments/appointments/${appt.id}/deposit`, entProvider);
  check('7. PROVIDER cannot configure deposit rules/deposits (403)', provRule.statusCode === 403 && provDeposit.statusCode === 403);
  // PROVIDER can still VIEW payment status.
  const provView = await call('GET', `/v1/payments/appointments/${appt.id}/payment`, entProvider);
  check('7b. PROVIDER can view payment status (200)', provView.statusCode === 200);

  // 8) Missing Stripe config → setup_required (no fake success, no link row).
  const savedProvider = env.PAYMENT_PROVIDER;
  const savedKey = env.STRIPE_SECRET_KEY;
  (env as any).PAYMENT_PROVIDER = 'stripe';
  (env as any).STRIPE_SECRET_KEY = undefined;
  const beforeLinks = await ownerDb.paymentRequest.count({ where: { tenantId: tEnt.id, appointmentId: appt.id } });
  const setupRes = await call('POST', `/v1/payments/appointments/${appt.id}/payment-link`, entTok);
  const setupBody = JSON.parse(setupRes.body);
  const afterLinks = await ownerDb.paymentRequest.count({ where: { tenantId: tEnt.id, appointmentId: appt.id } });
  check('8. unconfigured Stripe → setup_required, no payment request created', setupBody.status === 'setup_required' && setupBody.setupRequired === true && afterLinks === beforeLinks);
  (env as any).PAYMENT_PROVIDER = savedProvider;
  (env as any).STRIPE_SECRET_KEY = savedKey;

  // 9) Available (mock) config creates a real payment-link reference.
  const linkRes = await call('POST', `/v1/payments/appointments/${appt.id}/payment-link`, entFront);
  const linkBody = JSON.parse(linkRes.body);
  check('9. mock config creates link + checkout url + public token', linkRes.statusCode === 201 && linkBody.status === 'link_created' && typeof linkBody.checkoutUrl === 'string' && linkBody.checkoutUrl.length > 0 && typeof linkBody.publicToken === 'string');
  const paymentRequest = await ownerDb.paymentRequest.findFirst({ where: { tenantId: tEnt.id, appointmentId: appt.id }, orderBy: { createdAt: 'desc' } });
  check('9b. payment request persisted with providerReference + publicToken', !!paymentRequest?.providerReference && !!paymentRequest?.publicToken && !!paymentRequest?.paymentUrl);

  // 6) Authorized role created the payment request above (FRONT_DESK).
  check('6. authorized role (FRONT_DESK) created a payment request', !!paymentRequest);

  // 12a) Appointment now shows link_created.
  const statusAfterLink = JSON.parse((await call('GET', `/v1/payments/appointments/${appt.id}/payment`, entTok)).body);
  check('12. appointment shows link_created with mobile-ready fields', statusAfterLink.status === 'link_created' && statusAfterLink.deepLinkTarget === `appointment/${appt.id}` && Array.isArray(statusAfterLink.allowedActions) && statusAfterLink.setupRequired === false);

  // 16) Mobile-ready fields present.
  const mobileOk = ['paymentRequestId', 'appointmentId', 'patientId', 'amount', 'currency', 'status', 'expiresAt', 'allowedActions', 'deepLinkTarget', 'setupRequired'].every(k => k in statusAfterLink);
  check('16. mobile-ready fields present on appointment payment view', mobileOk);

  // Tokenized patient-safe public route (no PHI-heavy payload, no ids).
  const pub = await app.inject({ method: 'GET', url: `/v1/payments/public/checkout/${paymentRequest!.publicToken}` });
  const pubBody = JSON.parse(pub.body);
  check('4b. public tokenized checkout is patient-safe (no patient/tenant ids)', pub.statusCode === 200 && !('patientId' in pubBody) && !('tenantId' in pubBody) && typeof pubBody.amount === 'number' && typeof pubBody.clinicName === 'string');

  // 10) Stripe webhook signature enforced.
  const signed = (raw: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${raw}`).digest('hex')}`; };
  const evtId = `evt_${randomUUID().slice(0, 12)}`;
  const rawOk = JSON.stringify({ id: evtId, type: 'checkout.session.completed', data: { object: { id: paymentRequest!.providerReference, payment_status: 'paid' } } });
  const badSig = await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef', 'x-forwarded-for': ip() }, payload: rawOk });
  check('10. webhook rejects invalid signature (400)', badSig.statusCode === 400);

  // 11) Webhook updates status idempotently.
  const wh1 = await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': signed(rawOk), 'x-forwarded-for': ip() }, payload: rawOk });
  const wh2 = await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': signed(rawOk), 'x-forwarded-for': ip() }, payload: rawOk });
  const txnCount = await ownerDb.paymentTransaction.count({ where: { tenantId: tEnt.id, paymentRequestId: paymentRequest!.id, status: 'succeeded' } });
  check('11. webhook is idempotent on event id (one succeeded txn)', wh1.statusCode === 200 && wh2.statusCode === 200 && JSON.parse(wh2.body).duplicate === true && txnCount === 1);

  // 12b) Appointment now shows paid + deposit requirement collected.
  const paidView = JSON.parse((await call('GET', `/v1/payments/appointments/${appt.id}/payment`, entTok)).body);
  const reqAfter = await ownerDb.depositRequirement.findFirst({ where: { tenantId: tEnt.id, appointmentId: appt.id } });
  check('12c. appointment shows paid + deposit requirement collected', paidView.status === 'paid' && reqAfter?.status === 'collected');

  // 13) Failed payment creates revenue-protection signal + task.
  const failAppt = JSON.parse((await bookAppt(entTok, tEnt.branchId, tEnt.patientId)).body);
  await call('POST', `/v1/payments/appointments/${failAppt.id}/payment-link`, entTok);
  const failPr = await ownerDb.paymentRequest.findFirst({ where: { tenantId: tEnt.id, appointmentId: failAppt.id }, orderBy: { createdAt: 'desc' } });
  const failEvt = `evt_${randomUUID().slice(0, 12)}`;
  const rawFail = JSON.stringify({ id: failEvt, type: 'payment_intent.payment_failed', data: { object: { id: failPr!.providerReference } } });
  await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': signed(rawFail), 'x-forwarded-for': ip() }, payload: rawFail });
  const task = await ownerDb.staffTask.findFirst({ where: { tenantId: tEnt.id, title: 'Review failed deposit payment' } });
  const alert = await ownerDb.revenueProtectionAlert.findFirst({ where: { tenantId: tEnt.id, sourceType: 'deposit_payment', appointmentId: failAppt.id } });
  check('13. failed payment creates staff task + revenue alert', !!task && !!alert);
  const failView = JSON.parse((await call('GET', `/v1/payments/appointments/${failAppt.id}/payment`, entTok)).body);
  check('13b. appointment reflects failed + follow-up needed', failView.status === 'failed' && failView.followUpNeeded === true);

  // 14) Tenant isolation.
  const bAppt = JSON.parse((await bookAppt(bTok, tB.branchId, tB.patientId)).body);
  const bQueue = JSON.parse((await call('GET', '/v1/payments/payment-requests', bTok)).body);
  const crossView = await call('GET', `/v1/payments/appointments/${appt.id}/payment`, bTok);
  check('14. tenant B cannot see tenant A payment data', !bQueue.some((r: any) => r.appointmentId === appt.id) && crossView.statusCode === 404 && !!bAppt.id);

  // 15) Audit trail rows.
  const actions = new Set((await ownerDb.auditEvent.findMany({ where: { tenantId: tEnt.id }, select: { action: true } })).map(a => a.action));
  check('15. audit rows for deposit.required/payment.request.created/payment.link.created/payment.webhook.received/payment.succeeded/payment.failed',
    ['deposit.required', 'payment.request.created', 'payment.link.created', 'payment.webhook.received', 'payment.succeeded', 'payment.failed'].every(a => actions.has(a)));

  // 17) Waiver path + audit.
  const waiveAppt = JSON.parse((await bookAppt(entTok, tEnt.branchId, tEnt.patientId)).body);
  const waiveReq = await ownerDb.depositRequirement.findFirst({ where: { tenantId: tEnt.id, appointmentId: waiveAppt.id } });
  const waiveRes = await call('POST', `/v1/payments/deposit-requirements/${waiveReq!.id}/waive`, entTok, { reason: 'Goodwill waiver' });
  const waived = JSON.parse(waiveRes.body);
  const waiveAudit = await ownerDb.auditEvent.findFirst({ where: { tenantId: tEnt.id, action: 'deposit.waived', resourceId: waiveReq!.id } });
  check('17. deposit waive works + audited + appointment shows waived', waiveRes.statusCode === 200 && waived.status === 'waived' && !!waiveAudit);

  // 18) New tables/columns are not RLS-broken (PaymentRequest readable by webhook globally).
  const rls = new Set((await ownerDb.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relkind='r' AND relrowsecurity=true`).map(r => r.relname));
  check('18. PaymentRequest/DepositRequirement not RLS-forced (webhook-global by design)', !rls.has('PaymentRequest') && !rls.has('DepositRequirement'));

  await app.close();
  for (const t of [tEnt, tB, tLock]) await ownerDb.tenant.delete({ where: { id: t.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL PAYMENTS/DEPOSITS CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
