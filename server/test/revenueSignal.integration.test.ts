import 'dotenv/config';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_rev_signal';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves the revenue-intelligence loop end-to-end: a verified Stripe payment
// FAILURE produces a backend operational signal AND a human-review recommendation,
// and the operations morning briefing surfaces that recommendation — i.e. the
// intelligence layer turns a money-path failure into an actionable next step.
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

let app: FastifyInstance;
const createdTenantIds: string[] = [];
const SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

function stripeSig(body: string) {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;
}

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `rev-${id.slice(0, 6)}`, slug: `rev-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Roe', lifecycleStage: 'NEW' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@rev.test`, displayName: 'Admin' } });
  return { id, branchId: branch.id, patientId: patient.id, adminId: admin.id };
}

const staff = (t: { id: string }, userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, tenantId: t.id, type: 'access' })}` });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('revenue intelligence — payment failure → signal + recommendation → briefing', () => {
  it('a verified payment failure raises a signal + recommendation surfaced in the briefing', async () => {
    const t = await makeTenant();
    const providerReference = `cs_${randomUUID()}`;
    const pr = await db.paymentRequest.create({
      data: { tenantId: t.id, branchId: t.branchId, patientId: t.patientId, amount: 50, currency: 'USD', status: 'link_sent', reason: 'Appointment deposit', mode: 'live', providerReference },
    });

    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment_intent.payment_failed', data: { object: { id: providerReference } } });
    const hook = await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig(body) }, payload: body });
    expect(hook.statusCode).toBe(200);

    // payment request moved to failed
    expect((await db.paymentRequest.findUnique({ where: { id: pr.id }, select: { status: true } }))?.status).toBe('failed');

    // backend operational signal + human-review recommendation were created
    const signal = await db.operationalSignal.findFirst({ where: { tenantId: t.id, signalType: 'payment_failed', status: 'open' } });
    expect(signal).not.toBeNull();
    const rec = await db.aIRecommendation.findFirst({ where: { tenantId: t.id, recommendationType: 'review_failed_payment', status: 'pending' } });
    expect(rec).not.toBeNull();

    // the operations briefing surfaces it as an actionable next step
    const briefing = (await app.inject({ method: 'GET', url: '/v1/briefing', headers: staff(t, t.adminId) })).json();
    expect(briefing.summary.failedPayments).toBeGreaterThanOrEqual(1);
    expect(briefing.summary.openSignals).toBeGreaterThanOrEqual(1);
    expect(briefing.topRecommendations.some((r: { recommendationType: string }) => r.recommendationType === 'review_failed_payment')).toBe(true);
  });

  it('is idempotent on redelivery — no duplicate signal storm', async () => {
    const t = await makeTenant();
    const providerReference = `cs_${randomUUID()}`;
    await db.paymentRequest.create({ data: { tenantId: t.id, branchId: t.branchId, patientId: t.patientId, amount: 50, currency: 'USD', status: 'link_sent', reason: 'Deposit', mode: 'live', providerReference } });
    const evt = (id: string) => JSON.stringify({ id, type: 'payment_intent.payment_failed', data: { object: { id: providerReference } } });

    const b1 = evt(`evt_${randomUUID()}`);
    await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig(b1) }, payload: b1 });
    const b2 = evt(`evt_${randomUUID()}`); // distinct event id, same failure
    await app.inject({ method: 'POST', url: '/v1/revenue-protection/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig(b2) }, payload: b2 });

    // the failure-dedupe key keeps it to a single signal/recommendation
    expect(await db.operationalSignal.count({ where: { tenantId: t.id, signalType: 'payment_failed' } })).toBe(1);
    expect(await db.aIRecommendation.count({ where: { tenantId: t.id, recommendationType: 'review_failed_payment' } })).toBe(1);
  });
});
