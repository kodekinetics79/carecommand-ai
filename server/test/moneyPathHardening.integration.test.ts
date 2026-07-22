import 'dotenv/config';
// Sign Stripe webhooks in this suite (set before app/env import so the env schema
// picks it up — vitest isolates modules per test file).
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_money_hardening_secret';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Money-path integrity/correctness hardening (Financial-Controller SME + billing UAT):
//  #1 revenueProtected counts each economic event ONCE (a webhook-settled deposit is
//     written as BOTH a transaction AND a collected requirement — must not double).
//  #2 Open-AR excludes failed/expired/cancelled (expiry spawns a fresh row → no double).
//  #3 Cents are preserved ($45.50 → 4550 minor units, 15%-of-$150 → 2250) — never $46/$23.
//  #4 Segregation of duties: FRONT_DESK cannot manually attest a collection; a collected
//     amount can never exceed what was required.
//  #5 Refunds and disputes are handled (refunded txn reduces revenueProtected; dispute
//     raises an alert), and the ACTUAL settled amount from the event is recorded.
//  #7 A successful collection reconciles the patient's outstanding balance.
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
const { db } = await import('../lib/db');
const { recomputeEntitlements } = await import('../lib/entitlements');
const { runWithTenantContext } = await import('../lib/tenantContext');
const { roundMoney, toMinorUnits, StediEligibilityProvider } = await import('../modules/revenue-protection');
const { computeRequiredAmount } = await import('../lib/deposits');

let app: FastifyInstance;
const createdTenantIds: string[] = [];
const SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

function stripeSignature(body: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `mph-${id.slice(0, 6)}`, slug: `mph-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const owner = await db.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `own-${id.slice(0, 8)}@mph.test`, displayName: 'Owner' } });
  const frontDesk = await db.user.create({ data: { tenantId: id, role: 'FRONT_DESK', active: true, email: `fd-${id.slice(0, 8)}@mph.test`, displayName: 'Front Desk' } });
  return { id, branchId: branch.id, ownerId: owner.id, frontDeskId: frontDesk.id };
}

const auth = (t: { id: string }, userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, tenantId: t.id, type: 'access' })}` });
const jsonAuth = (t: { id: string }, userId: string) => ({ ...auth(t, userId), 'content-type': 'application/json' });
const webhook = (body: string) =>
  app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(body) }, payload: body });

async function overview(t: { id: string }, ownerId: string) {
  const res = await app.inject({ method: 'GET', url: '/v1/revenue-protection/overview', headers: auth(t, ownerId) });
  expect(res.statusCode).toBe(200);
  return res.json().summary as Record<string, number>;
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// #3 — Cents preservation (pure math; independent of any live provider).
// ---------------------------------------------------------------------------
describe('#3 cents are preserved end-to-end', () => {
  it('roundMoney keeps 2 decimals and toMinorUnits yields exact integer cents', () => {
    expect(roundMoney(45.5)).toBe(45.5);
    expect(toMinorUnits(45.5)).toBe('4550'); // NOT 4600 (was Math.round($45.50)*100)
    expect(roundMoney(22.5)).toBe(22.5);
    expect(toMinorUnits(22.5)).toBe('2250'); // NOT 2300
  });

  it('a 15%-of-$150 deposit computes $22.50 (not $23) → 2250 minor units', () => {
    const rule = { amountType: 'percentage', amountValue: 15 } as unknown as Parameters<typeof computeRequiredAmount>[0];
    const required = computeRequiredAmount(rule, 150);
    expect(required).toBe(22.5);
    expect(toMinorUnits(required)).toBe('2250');
  });
});

// ---------------------------------------------------------------------------
// #6 — Live Stedi normalizer never fabricates coverage numbers.
// ---------------------------------------------------------------------------
describe('#6 Stedi normalizer does not invent coverage when the 271 omits fields', () => {
  it('a payer response missing copay/deductible/coinsurance is reported unknown, not 25/850/0.2', () => {
    const provider = new StediEligibilityProvider();
    // A 271 that confirms active coverage but omits every financial field.
    const outcome = provider.normalizeEligibilityResponse(
      { benefitsInformation: [{ coverageStatus: 'active' }] },
      { tenantId: randomUUID() },
    );
    expect(outcome.benefitDataIncomplete).toBe(true);
    expect(outcome.missingBenefitFields).toEqual(expect.arrayContaining(['copay', 'deductibleRemaining', 'coinsurance']));
    // The old fabricated defaults (25 / 850 / 0.2) must NOT appear.
    expect(outcome.copay).not.toBe(25);
    expect(outcome.deductibleRemaining).not.toBe(850);
    expect(outcome.coinsurance).not.toBe(0.2);
    expect(outcome.coverageStatus).toBe('uncertain');
    expect(outcome.eligibilityMessage.toLowerCase()).toContain('incomplete');
  });

  it('when the payer DOES return financials, they are used verbatim and marked complete', () => {
    const provider = new StediEligibilityProvider();
    const outcome = provider.normalizeEligibilityResponse(
      { benefitsInformation: [{ coverageStatus: 'active', copay: 40, deductibleRemaining: 300, coinsurance: 0.1 }] },
      { tenantId: randomUUID() },
    );
    expect(outcome.benefitDataIncomplete).toBe(false);
    expect(outcome.missingBenefitFields).toEqual([]);
    expect(outcome.copay).toBe(40);
    expect(outcome.deductibleRemaining).toBe(300);
    expect(outcome.coinsurance).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// #1 — A single Stripe-paid deposit contributes its amount ONCE.
// ---------------------------------------------------------------------------
describe('#1 revenueProtected counts a settled deposit exactly once', () => {
  it('a $50 deposit paid via webhook reports $50 in revenueProtected, not $100', async () => {
    const t = await makeTenant();
    const pr = await db.paymentRequest.create({
      data: { tenantId: t.id, branchId: t.branchId, amount: 50, currency: 'USD', status: 'link_sent', reason: 'Appointment deposit', mode: 'live', providerReference: `cs_${randomUUID()}`, publicToken: randomUUID(), paymentUrl: 'https://pay.example/x' },
    });
    await db.depositRequirement.create({
      data: { tenantId: t.id, branchId: t.branchId, paymentRequestId: pr.id, status: 'requested', requiredAmount: 50, collectedAmount: 0, reason: 'Appointment deposit', mode: 'live' },
    });
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'checkout.session.completed', data: { object: { id: pr.providerReference } } });
    const res = await webhook(body);
    expect(res.statusCode).toBe(200);

    // Both records exist (transaction + collected requirement) but the headline counts once.
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } })).toBe(1);
    const dep = await db.depositRequirement.findFirst({ where: { paymentRequestId: pr.id } });
    expect(dep?.status).toBe('collected');

    const summary = await overview(t, t.ownerId);
    expect(summary.revenueProtected).toBe(50); // not 100
    expect(summary.depositsCollected).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// #2 — Stale AR: an expired request that was regenerated is counted once.
// ---------------------------------------------------------------------------
describe('#2 open AR excludes failed/expired/cancelled (no stale double-count)', () => {
  it('an expired request + its regenerated open request count the balance once', async () => {
    const t = await makeTenant();
    // Same $30 balance: the original link expired, a fresh one was generated.
    await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, amount: 30, currency: 'USD', status: 'expired', reason: 'copay', mode: 'live', providerReference: `cs_${randomUUID()}` } });
    await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, amount: 30, currency: 'USD', status: 'link_sent', reason: 'copay', mode: 'live', providerReference: `cs_${randomUUID()}` } });
    // Also seed a failed + cancelled request that must NOT count as open AR.
    await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, amount: 99, currency: 'USD', status: 'failed', reason: 'copay', mode: 'live', providerReference: `cs_${randomUUID()}` } });
    await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, amount: 77, currency: 'USD', status: 'cancelled', reason: 'copay', mode: 'live', providerReference: `cs_${randomUUID()}` } });

    const summary = await overview(t, t.ownerId);
    expect(summary.unpaidBalances).toBe(30); // only the single genuinely-open request
    expect(summary.copaysExpected).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// #4 — Segregation of duties on manual collect.
// ---------------------------------------------------------------------------
describe('#4 FRONT_DESK cannot fabricate revenue via manual collect', () => {
  it('FRONT_DESK marking a payment collected is 403; OWNER is allowed', async () => {
    const t = await makeTenant();
    const pr = await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, amount: 40, currency: 'USD', status: 'link_sent', reason: 'copay', mode: 'live', providerReference: `cs_${randomUUID()}` } });

    const denied = await app.inject({ method: 'PATCH', url: `/v1/revenue-protection/payment/${pr.id}/status`, headers: jsonAuth(t, t.frontDeskId), payload: JSON.stringify({ status: 'collected' }) });
    expect(denied.statusCode).toBe(403);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id } })).toBe(0);

    const ok = await app.inject({ method: 'PATCH', url: `/v1/revenue-protection/payment/${pr.id}/status`, headers: jsonAuth(t, t.ownerId), payload: JSON.stringify({ status: 'collected' }) });
    expect(ok.statusCode).toBe(200);
    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'succeeded' } })).toBe(1);
  });

  it('FRONT_DESK cannot mark a deposit collected, and an over-required amount is rejected', async () => {
    const t = await makeTenant();
    const dep = await db.depositRequirement.create({ data: { tenantId: t.id, branchId: t.branchId, status: 'requested', requiredAmount: 50, collectedAmount: 0, reason: 'Appointment deposit', mode: 'live' } });

    const denied = await app.inject({ method: 'PATCH', url: `/v1/revenue-protection/deposit-requirements/${dep.id}/status`, headers: jsonAuth(t, t.frontDeskId), payload: JSON.stringify({ status: 'collected', collectedAmount: 50 }) });
    expect(denied.statusCode).toBe(403);

    // Even an authorized controller cannot record MORE than was required.
    const over = await app.inject({ method: 'PATCH', url: `/v1/revenue-protection/deposit-requirements/${dep.id}/status`, headers: jsonAuth(t, t.ownerId), payload: JSON.stringify({ status: 'collected', collectedAmount: 500 }) });
    expect(over.statusCode).toBe(400);

    const still = await db.depositRequirement.findUnique({ where: { id: dep.id } });
    expect(still?.status).toBe('requested');
  });
});

// ---------------------------------------------------------------------------
// #5 — Refunds, disputes, and actual-settled-amount reconciliation.
// ---------------------------------------------------------------------------
describe('#5 refund and dispute webhooks reconcile correctly', () => {
  it('charge.refunded writes a refunded txn and reduces revenueProtected to 0', async () => {
    const t = await makeTenant();
    const pr = await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, amount: 60, currency: 'USD', status: 'link_sent', reason: 'deposit', mode: 'live', providerReference: `cs_${randomUUID()}` } });
    await db.depositRequirement.create({ data: { tenantId: t.id, branchId: t.branchId, paymentRequestId: pr.id, status: 'requested', requiredAmount: 60, collectedAmount: 0, reason: 'deposit', mode: 'live' } });

    // Settle it.
    const paidBody = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'checkout.session.completed', data: { object: { id: pr.providerReference } } });
    expect((await webhook(paidBody)).statusCode).toBe(200);
    expect((await overview(t, t.ownerId)).revenueProtected).toBe(60);

    // Refund it.
    const refundBody = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'charge.refunded', data: { object: { id: pr.providerReference, amount_refunded: 6000 } } });
    expect((await webhook(refundBody)).statusCode).toBe(200);

    expect(await db.paymentTransaction.count({ where: { paymentRequestId: pr.id, status: 'refunded' } })).toBe(1);
    expect((await db.paymentRequest.findUnique({ where: { id: pr.id } }))?.status).toBe('refunded');
    const dep = await db.depositRequirement.findFirst({ where: { paymentRequestId: pr.id } });
    expect(dep?.status).toBe('refunded');
    const audit = await db.auditEvent.findFirst({ where: { tenantId: t.id, action: 'payment.refunded', resourceId: pr.id } });
    expect(audit).not.toBeNull();

    expect((await overview(t, t.ownerId)).revenueProtected).toBe(0); // reduced by the refund
  });

  it('charge.dispute.created raises a high-severity revenue-protection alert', async () => {
    const t = await makeTenant();
    const pr = await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, amount: 80, currency: 'USD', status: 'collected', reason: 'deposit', mode: 'live', providerReference: `cs_${randomUUID()}` } });

    const disputeBody = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'charge.dispute.created', data: { object: { id: pr.providerReference, amount: 8000 } } });
    expect((await webhook(disputeBody)).statusCode).toBe(200);

    const alert = await runWithTenantContext(t.id, tx => tx.revenueProtectionAlert.findFirst({ where: { tenantId: t.id, sourceType: 'payment_dispute' } }));
    expect(alert).not.toBeNull();
    expect(alert?.severity).toBe('high');
    const audit = await db.auditEvent.findFirst({ where: { tenantId: t.id, action: 'payment.dispute.created', resourceId: pr.id } });
    expect(audit).not.toBeNull();
  });

  it('records the ACTUAL settled amount from the event, not the requested amount', async () => {
    const t = await makeTenant();
    const pr = await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, amount: 50, currency: 'USD', status: 'link_sent', reason: 'deposit', mode: 'live', providerReference: `cs_${randomUUID()}` } });
    // Patient paid only $25 (amount_total is in minor units).
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'checkout.session.completed', data: { object: { id: pr.providerReference, amount_total: 2500 } } });
    expect((await webhook(body)).statusCode).toBe(200);
    const txn = await db.paymentTransaction.findFirst({ where: { paymentRequestId: pr.id, status: 'succeeded' } });
    expect(Number(txn?.amount)).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// #7 — Outstanding balance reconciles on collection.
// ---------------------------------------------------------------------------
describe('#7 a successful collection reduces the patient outstanding balance', () => {
  it('webhook settlement decrements Patient.outstandingBalance by the settled amount', async () => {
    const t = await makeTenant();
    const patient = await db.patient.create({ data: { tenantId: t.id, branchId: t.branchId, firstName: 'Pat', lastName: 'Ay', outstandingBalance: 200 } });
    const pr = await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, patientId: patient.id, amount: 50, currency: 'USD', status: 'link_sent', reason: 'copay', mode: 'live', providerReference: `cs_${randomUUID()}` } });

    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'checkout.session.completed', data: { object: { id: pr.providerReference } } });
    expect((await webhook(body)).statusCode).toBe(200);

    const after = await db.patient.findUnique({ where: { id: patient.id }, select: { outstandingBalance: true } });
    expect(Number(after?.outstandingBalance)).toBe(150); // 200 − 50
  });
});
