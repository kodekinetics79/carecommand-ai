import 'dotenv/config';
// Enforce signed Stripe webhooks in this suite — set before app/env import so
// the env schema picks it up (vitest isolates modules per test file).
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_money_path_secret';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves the money path is backend-enforced: the Stripe webhook verifies its
// signature, is idempotent on the Stripe event id (no double transaction), and
// only a verified success event collects a payment; the public checkout route is
// tokenized + patient-safe (no internal ids/PHI); authed payment routes require auth.
vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { claimPaymentLink, persistProviderOutcome, finalizePaymentLink } = await import('../modules/payments/checkout');
const { runInTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const createdTenantIds: string[] = [];
const databaseCleanup: Array<() => Promise<void>> = [];
const SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

function stripeSignature(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `pay-${id.slice(0, 6)}`, slug: `pay-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  return { id, branchId: branch.id };
}

async function makePaymentRequest(tenantId: string, branchId: string, overrides: Record<string, unknown> = {}) {
  return db.paymentRequest.create({
    data: {
      tenantId, branchId, amount: 50, currency: 'USD', status: 'link_sent', reason: 'Appointment deposit',
      mode: 'live', providerReference: `cs_${randomUUID()}`, publicToken: randomUUID(),
      paymentUrl: 'https://pay.example/checkout/abc', ...overrides,
    },
  });
}

const webhook = (body: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', ...headers }, payload: body });

async function installPaymentAuditFailure(
  tenantId: string,
  action: 'payment.webhook.received' | 'payment.succeeded' | 'payment.refunded' | 'payment.dispute.created' | 'payment.failed' | 'payment.expired',
) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_payment_audit_fail_fn_${suffix}`;
  const triggerName = `test_payment_audit_fail_trg_${suffix}`;
  await db.$executeRawUnsafe(`
    CREATE FUNCTION public."${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW."tenantId" = '${tenantId}'::uuid AND NEW.action = '${action}' THEN
        RAISE EXCEPTION 'injected mandatory payment audit failure';
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
  const remove = async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."AuditEvent"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
  };
  databaseCleanup.push(remove);
  return async () => { await remove(); databaseCleanup.pop(); };
}

async function installPaymentSuccessFanoutFailure(tenantId: string) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_payment_fanout_fail_fn_${suffix}`;
  const triggerName = `test_payment_fanout_fail_trg_${suffix}`;
  await db.$executeRawUnsafe(`
    CREATE FUNCTION public."${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW."tenantId" = '${tenantId}'::uuid AND NEW."eventType" = 'payment.succeeded' THEN
        RAISE EXCEPTION 'injected optional payment success fan-out failure';
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."BusinessEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
  const remove = async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."BusinessEvent"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
  };
  databaseCleanup.push(remove);
  return async () => { await remove(); databaseCleanup.pop(); };
}

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const cleanup of databaseCleanup.reverse()) await cleanup().catch(() => {});
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('money path — Stripe webhook is signature-verified and idempotent', () => {
  it('rejects a webhook with an invalid signature (400)', async () => {
    const t = await makeTenant();
    const pr = await makePaymentRequest(t.id, t.branchId);
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'checkout.session.completed', data: { object: { id: pr.providerReference } } });
    const res = await webhook(body, { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=deadbeef` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SIGNATURE');
    // nothing collected
    const after = await db.paymentRequest.findUnique({ where: { id: pr.id }, select: { status: true } });
    expect(after?.status).toBe('link_sent');
  });

  it('collects on a verified success event and is idempotent on redelivery', async () => {
    const t = await makeTenant();
    const pr = await makePaymentRequest(t.id, t.branchId);
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: pr.providerReference } } });

    const first = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(first.statusCode).toBe(200);

    const collected = await db.paymentRequest.findUnique({ where: { id: pr.id }, select: { status: true } });
    expect(collected?.status).toBe('collected');
    let txns = await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } });
    expect(txns).toBe(1);
    const audit = await db.auditEvent.findFirst({ where: { tenantId: t.id, action: 'payment.succeeded', resourceId: pr.id } });
    expect(audit).not.toBeNull();

    // Redelivery of the SAME event id → acknowledged as duplicate, NOT reprocessed.
    const replay = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().duplicate).toBe(true);
    txns = await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } });
    expect(txns).toBe(1); // still exactly one — no double charge recorded
  });

  it('acknowledges a durably committed success when optional workflow fan-out fails', async () => {
    const t = await makeTenant();
    const patient = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchId, firstName: 'Optional', lastName: 'Fanout', outstandingBalance: 100 },
    });
    const pr = await makePaymentRequest(t.id, t.branchId, { patientId: patient.id });
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: pr.providerReference, amount_total: 5000 } } });
    const removeFault = await installPaymentSuccessFanoutFailure(t.id);

    const response = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: true });
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe('collected');
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } })).toBe(1);
    expect(Number((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).outstandingBalance)).toBe(50);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.succeeded' } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: t.id, entityId: pr.id, eventType: 'payment.succeeded' } })).toBe(0);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBe(pr.id);

    await removeFault();
    const retry = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate).toBe(true);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } })).toBe(1);
    expect(Number((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).outstandingBalance)).toBe(50);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.succeeded' } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: t.id, entityId: pr.id, eventType: 'payment.succeeded' } })).toBe(0);
  });

  it('serializes simultaneous delivery of the same success event to one money and audit effect', async () => {
    const t = await makeTenant();
    const patient = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchId, firstName: 'Concurrent', lastName: 'Payment', outstandingBalance: 100 },
    });
    const pr = await makePaymentRequest(t.id, t.branchId, { patientId: patient.id });
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: pr.providerReference, amount_total: 5000 } } });

    const responses = await Promise.all([
      webhook(body, { 'stripe-signature': stripeSignature(body) }),
      webhook(body, { 'stripe-signature': stripeSignature(body) }),
    ]);
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(responses.filter(response => response.json().duplicate === true)).toHaveLength(1);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.succeeded' } })).toBe(1);
    expect(Number((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).outstandingBalance)).toBe(50);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe('collected');
  });

  it('collapses related distinct Stripe success event ids onto one payment transition', async () => {
    const t = await makeTenant();
    const patient = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchId, firstName: 'Related', lastName: 'Events', outstandingBalance: 100 },
    });
    const pr = await makePaymentRequest(t.id, t.branchId, { patientId: patient.id });
    const checkout = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'checkout.session.completed', data: { object: { id: pr.providerReference, amount_total: 5000 } } });
    const paymentIntent = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', data: { object: { id: pr.providerReference, amount_received: 5000 } } });

    const responses = await Promise.all([
      webhook(checkout, { 'stripe-signature': stripeSignature(checkout) }),
      webhook(paymentIntent, { 'stripe-signature': stripeSignature(paymentIntent) }),
    ]);
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(responses.filter(response => response.json().ignored === 'terminal_payment_state')).toHaveLength(1);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.succeeded' } })).toBe(1);
    expect(Number((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).outstandingBalance)).toBe(50);
    const completedClaims = await db.idempotencyKey.count({ where: { scope: 'stripe.webhook', tenantId: t.id, resultId: pr.id } });
    expect(completedClaims).toBe(2);
  });

  it.each(['reconciliation_required', 'reconciliation_required_paid'])('reconciles success from %s and later checkout finalization cannot regress collected', async initialStatus => {
    const t = await makeTenant();
    const patient = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchId, firstName: 'Checkout', lastName: 'Race', outstandingBalance: 100 },
    });
    const appointment = await db.appointment.create({
      data: {
        tenantId: t.id, branchId: t.branchId, patientId: patient.id, service: 'Race test',
        startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 88_200_000),
        status: 'CONFIRMED', channel: 'EMAIL', value: 50,
      },
    });
    const requirement = await db.depositRequirement.create({
      data: {
        tenantId: t.id, branchId: t.branchId, patientId: patient.id, appointmentId: appointment.id,
        status: 'requested', requiredAmount: 50, collectedAmount: 0,
        reason: 'Appointment deposit', mode: 'live',
      },
    });
    const finalizeActor = await db.user.create({
      data: {
        tenantId: t.id,
        email: `billing-${randomUUID()}@payment.test`,
        displayName: 'Payment finalizer',
        role: 'BILLING',
        active: true,
      },
    });
    const runAsBilling = <T>(fn: () => Promise<T>) => runInTenantContext({
      tenantId: t.id,
      actorId: finalizeActor.id,
      actorRole: 'BILLING',
      source: 'request',
    }, fn);
    const claim = await runAsBilling(() => claimPaymentLink(t.id, appointment.id, {
      branchId: t.branchId,
      patientId: patient.id,
      mode: 'live',
    }));
    expect(claim?.kind).toBe('claimed');
    if (!claim || claim.kind !== 'claimed') throw new Error('expected a fresh provider claim');
    expect((await db.depositRequirement.findUniqueOrThrow({ where: { id: requirement.id } })).paymentRequestId).toBe(claim.paymentRequestId);

    const providerReference = `pi_${randomUUID()}`;
    const outcome = {
      currency: 'USD',
      status: initialStatus === 'reconciliation_required_paid' ? 'paid' : 'pending',
      providerMode: 'live',
      providerReference,
      paymentUrl: 'https://pay.example/checkout/race',
    };
    const persisted = await runAsBilling(() => persistProviderOutcome(
      t.id,
      appointment.id,
      claim.paymentRequestId,
      outcome,
      new Date(Date.now() + 3_600_000),
    ));
    expect(persisted.count).toBe(1);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: claim.paymentRequestId } })).status).toBe(initialStatus);

    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'payment_intent.succeeded', data: { object: { id: providerReference, amount_received: 5000 } } });

    const response = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(response.statusCode).toBe(200);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: claim.paymentRequestId } })).status).toBe('collected');
    const reconciledRequirement = await db.depositRequirement.findUniqueOrThrow({ where: { id: requirement.id } });
    expect(reconciledRequirement.status).toBe('collected');
    expect(reconciledRequirement.paymentRequestId).toBe(claim.paymentRequestId);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: claim.paymentRequestId, status: 'succeeded' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: claim.paymentRequestId, action: 'payment.succeeded' } })).toBe(1);
    expect(Number((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).outstandingBalance)).toBe(50);

    const finalizeActorId = finalizeActor.id;
    const finalizeRequest = {
      id: `finalize-${randomUUID()}`,
      ip: '203.0.113.25',
      headers: { 'user-agent': 'payment-race-test' },
      auth: { tenantId: t.id, userId: finalizeActorId, role: 'BILLING' },
    } as never;
    const finalized = await runAsBilling(() => finalizePaymentLink(finalizeRequest, {
        appointmentId: appointment.id,
        requirementId: requirement.id,
        paymentRequestId: claim.paymentRequestId,
        amount: 50,
        providerKey: 'stripe',
        outcome,
      }));
    expect(finalized.status).toBe('collected');
    const afterFinalizeRequirement = await db.depositRequirement.findUniqueOrThrow({ where: { id: requirement.id } });
    expect(afterFinalizeRequirement.status).toBe('collected');
    expect(afterFinalizeRequirement.paymentRequestId).toBe(claim.paymentRequestId);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: claim.paymentRequestId, status: 'succeeded' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: claim.paymentRequestId, action: 'payment.succeeded' } })).toBe(1);
  });

  it('does not reconcile or acknowledge success when mandatory webhook-receipt audit persistence fails', async () => {
    const t = await makeTenant();
    const pr = await makePaymentRequest(t.id, t.branchId);
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: pr.providerReference } } });
    const removeFault = await installPaymentAuditFailure(t.id, 'payment.webhook.received');

    const failed = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(failed.statusCode).toBe(500);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe('link_sent');
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id } })).toBe(0);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBeNull();

    await removeFault();
    const retry = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(retry.statusCode).toBe(200);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe('collected');
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.webhook.received' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.succeeded' } })).toBe(1);
  });

  it('rolls back money movement and completion claim when the mandatory success audit fails', async () => {
    const t = await makeTenant();
    const pr = await makePaymentRequest(t.id, t.branchId);
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: pr.providerReference, amount_total: 5000 } } });
    const removeFault = await installPaymentAuditFailure(t.id, 'payment.succeeded');

    const failed = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(failed.statusCode).toBe(500);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe('link_sent');
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id } })).toBe(0);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.succeeded' } })).toBe(0);

    await removeFault();
    const retry = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(retry.statusCode).toBe(200);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe('collected');
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.succeeded' } })).toBe(1);
  });

  it('rolls back every refund state change when the mandatory refund audit fails, then retries exactly once', async () => {
    const t = await makeTenant();
    const patient = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchId, firstName: 'Refund', lastName: 'Patient', outstandingBalance: 10 },
    });
    const pr = await makePaymentRequest(t.id, t.branchId, { patientId: patient.id, status: 'collected' });
    const deposit = await db.depositRequirement.create({
      data: {
        tenantId: t.id, branchId: t.branchId, patientId: patient.id, paymentRequestId: pr.id,
        status: 'collected', requiredAmount: 50, collectedAmount: 50, collectedAt: new Date(), reason: 'Appointment deposit', mode: 'live',
      },
    });
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'charge.refunded', data: { object: { id: pr.providerReference, amount_refunded: 5000 } } });
    const removeFault = await installPaymentAuditFailure(t.id, 'payment.refunded');

    const failed = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(failed.statusCode).toBe(500);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe('collected');
    expect((await db.depositRequirement.findUniqueOrThrow({ where: { id: deposit.id } })).status).toBe('collected');
    expect(Number((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).outstandingBalance)).toBe(10);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'refunded' } })).toBe(0);
    expect(await db.integrationRunLog.count({ where: { tenantId: t.id, operation: 'webhook.refund' } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.refunded' } })).toBe(0);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBeNull();

    await removeFault();
    const retry = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(retry.statusCode).toBe(200);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe('refunded');
    expect((await db.depositRequirement.findUniqueOrThrow({ where: { id: deposit.id } })).status).toBe('refunded');
    expect(Number((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).outstandingBalance)).toBe(60);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'refunded' } })).toBe(1);
    expect(await db.integrationRunLog.count({ where: { tenantId: t.id, operation: 'webhook.refund' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.refunded' } })).toBe(1);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBe(pr.id);
  });

  it('rolls back the durable dispute fact when its mandatory audit fails, then retries without duplication', async () => {
    const t = await makeTenant();
    const pr = await makePaymentRequest(t.id, t.branchId, { status: 'collected' });
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'charge.dispute.created', data: { object: { id: pr.providerReference, amount: 5000 } } });
    const removeFault = await installPaymentAuditFailure(t.id, 'payment.dispute.created');

    const failed = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(failed.statusCode).toBe(500);
    expect(await db.integrationRunLog.count({ where: { tenantId: t.id, operation: 'webhook.dispute' } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.dispute.created' } })).toBe(0);
    expect(await db.revenueProtectionAlert.count({ where: { tenantId: t.id, sourceType: 'payment_dispute' } })).toBe(0);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBeNull();

    await removeFault();
    const retry = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(retry.statusCode).toBe(200);
    expect(await db.integrationRunLog.count({ where: { tenantId: t.id, operation: 'webhook.dispute' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: 'payment.dispute.created' } })).toBe(1);
    expect(await db.revenueProtectionAlert.count({ where: { tenantId: t.id, sourceType: 'payment_dispute' } })).toBe(1);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBe(pr.id);
  });

  it.each([
    { eventType: 'payment_intent.payment_failed', action: 'payment.failed' as const, status: 'failed' },
    { eventType: 'checkout.session.expired', action: 'payment.expired' as const, status: 'expired' },
  ])('rolls back $action state and evidence on audit failure, then cleanly retries', async ({ eventType, action, status }) => {
    const t = await makeTenant();
    const pr = await makePaymentRequest(t.id, t.branchId);
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: eventType, data: { object: { id: pr.providerReference } } });
    const removeFault = await installPaymentAuditFailure(t.id, action);

    const failed = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(failed.statusCode).toBe(500);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe('link_sent');
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action } })).toBe(0);
    expect(await db.staffTask.count({ where: { tenantId: t.id, metadata: { path: ['paymentRequestId'], equals: pr.id } } })).toBe(0);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBeNull();

    await removeFault();
    const retry = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(retry.statusCode).toBe(200);
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe(status);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action } })).toBe(1);
    expect(await db.staffTask.count({ where: { tenantId: t.id, metadata: { path: ['paymentRequestId'], equals: pr.id } } })).toBe(1);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBe(pr.id);

    const duplicate = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action } })).toBe(1);
    expect(await db.staffTask.count({ where: { tenantId: t.id, metadata: { path: ['paymentRequestId'], equals: pr.id } } })).toBe(1);
  });

  it.each([
    { eventType: 'payment_intent.payment_failed', terminalStatus: 'refunded' },
    { eventType: 'checkout.session.expired', terminalStatus: 'failed' },
  ])('does not regress $terminalStatus on a later $eventType event', async ({ eventType, terminalStatus }) => {
    const t = await makeTenant();
    const pr = await makePaymentRequest(t.id, t.branchId, { status: terminalStatus });
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: eventType, data: { object: { id: pr.providerReference } } });

    const response = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(response.statusCode).toBe(200);
    expect(response.json().ignored).toBe('terminal_payment_state');
    expect((await db.paymentRequest.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe(terminalStatus);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: pr.id, action: { in: ['payment.failed', 'payment.expired'] } } })).toBe(0);
    expect((await db.idempotencyKey.findUniqueOrThrow({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } })).resultId).toBe(pr.id);
  });

  it('acknowledges (200) a verified event with no matching payment request', async () => {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'charge.succeeded', data: { object: { id: `cs_unmatched_${randomUUID()}` } } });
    const res = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(res.statusCode).toBe(200);
  });

  it('is crash-safe: a webhook that throws before completing is REPROCESSED on retry, not permanently skipped', async () => {
    const t = await makeTenant();
    const pr = await makePaymentRequest(t.id, t.branchId);
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: pr.providerReference } } });

    // Inject the failure in the real PostgreSQL engine. Mocking the fixture
    // client cannot affect the restricted runtime transaction and would not be
    // valid rollback evidence. A non-transactional sequence makes the trigger
    // fail exactly once for this payment request; the second delivery exercises
    // the real retry path. Identifiers contain only generated hex characters.
    const suffix = randomUUID().replaceAll('-', '');
    const sequenceName = `test_payment_fail_seq_${suffix}`;
    const functionName = `test_payment_fail_fn_${suffix}`;
    const triggerName = `test_payment_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`CREATE SEQUENCE public."${sequenceName}"`);
    await db.$executeRawUnsafe(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE public."${sequenceName}" TO app_rls`);
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."paymentRequestId" = '${pr.id}'::uuid
           AND nextval('public."${sequenceName}"') = 1 THEN
          RAISE EXCEPTION 'injected payment reconciliation failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON public."PaymentTransaction"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
    `);
    databaseCleanup.push(async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."PaymentTransaction"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
      await db.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS public."${sequenceName}"`);
    });

    const first = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(first.statusCode).toBeGreaterThanOrEqual(500);

    // Nothing collected, no transaction recorded, and the claim is left INCOMPLETE
    // (no resultId) so it remains reprocessable.
    expect((await db.paymentRequest.findUnique({ where: { id: pr.id }, select: { status: true } }))?.status).toBe('link_sent');
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id } })).toBe(0);
    const key = await db.idempotencyKey.findUnique({ where: { scope_key: { scope: 'stripe.webhook', key: eventId } } });
    expect(key).not.toBeNull();
    expect(key?.resultId ?? null).toBeNull();

    // Stripe retries the SAME event id → MUST be reprocessed (not acknowledged as a
    // duplicate) so the payment is finally reconciled exactly once.
    const retry = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate).toBeUndefined();
    expect((await db.paymentRequest.findUnique({ where: { id: pr.id }, select: { status: true } }))?.status).toBe('collected');
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } })).toBe(1);

    // A FURTHER redelivery after completion IS acknowledged as a duplicate — no double record.
    const dup = await webhook(body, { 'stripe-signature': stripeSignature(body) });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().duplicate).toBe(true);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } })).toBe(1);

  });
});

describe('money path — public checkout is tokenized and patient-safe', () => {
  it('returns a minimal patient-safe summary for a valid token and 404 for unknown', async () => {
    const t = await makeTenant();
    const pr = await makePaymentRequest(t.id, t.branchId);

    const ok = await app.inject({ method: 'GET', url: `/v1/payments/public/checkout/${pr.publicToken}` });
    expect(ok.statusCode).toBe(200);
    const bodyText = ok.body;
    // never leak internal identifiers/PHI through the public route
    expect(bodyText).not.toContain(t.id);
    expect(bodyText).not.toContain(pr.id);
    expect(bodyText).not.toContain('tenantId');
    const json = ok.json();
    expect(json.status).toBe('pending');
    expect(typeof json.amount).toBe('number');
    expect(json.checkoutUrl).toBe('https://pay.example/checkout/abc');

    const missing = await app.inject({ method: 'GET', url: `/v1/payments/public/checkout/${randomUUID()}` });
    expect(missing.statusCode).toBe(404);
  });
});

describe('money path — authed payment routes require auth', () => {
  it('rejects unauthenticated access to the payment-request queue (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/payments/payment-requests' });
    expect(res.statusCode).toBe(401);
  });
});
