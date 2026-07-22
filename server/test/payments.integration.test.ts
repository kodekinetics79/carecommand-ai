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
const { db } = await import('../lib/db');

let app: FastifyInstance;
const createdTenantIds: string[] = [];
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

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
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

    // First delivery: force the money-movement transaction to throw ONCE, AFTER the
    // idempotency key has already been claimed. Previously this permanently skipped
    // the event (money collected at Stripe, DB never reconciled). We capture the real
    // create first, then throw on the first call only and delegate to the real impl
    // afterwards (avoids Prisma-proxy mockRestore breakage between deliveries).
    const realCreate = db.paymentTransaction.create.bind(db.paymentTransaction);
    let createCalls = 0;
    const spy = vi.spyOn(db.paymentTransaction, 'create').mockImplementation(((...args: unknown[]) => {
      createCalls += 1;
      if (createCalls === 1) throw new Error('boom: processing failed after claim');
      return (realCreate as (...a: unknown[]) => unknown)(...args);
    }) as typeof db.paymentTransaction.create);
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

    spy.mockRestore();
    expect(createCalls).toBe(2); // one throwing call, one successful reprocess
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
