import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Integrity/correctness guarantees a technical buyer will check:
//  1. Revenue dashboard headline totals are DB aggregates — correct past 50 rows,
//     not a truncated JS sum of a `take: 50` page (money under-reporting).
//  3. Control-plane "test" buttons are HONEST — they never synthesize a fake
//     Stripe URL, never persist a fabricated payment request, and never claim
//     'covered' eligibility when the real provider is not configured.
//  5. The insurance eligibility route never presents a SIMULATED sandbox result as
//     a real payer response (no 'production' mislabelling of invented benefits).
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
const { recomputeEntitlements } = await import('../lib/entitlements');
const { runWithTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `mi-${id.slice(0, 6)}`, slug: `mi-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const owner = await db.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `own-${id.slice(0, 8)}@mi.test`, displayName: 'Owner' } });
  return { id, branchId: branch.id, ownerId: owner.id };
}

const auth = (t: { id: string }, userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, tenantId: t.id, role: 'OWNER', type: 'access' })}` });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('#1 revenue overview totals are DB aggregates (correct past the 50-row page)', () => {
  it('sums ALL contributing rows, not just the first 50', async () => {
    const t = await makeTenant();
    // 60 unpaid payment requests @ $10 → copaysExpected/unpaidBalances must be $600
    // (a truncated `take: 50` page would wrongly report $500).
    await db.paymentRequest.createMany({
      data: Array.from({ length: 60 }, () => ({
        tenantId: t.id, branchId: t.branchId, amount: 10, currency: 'USD', status: 'link_sent',
        reason: 'copay', mode: 'live', providerReference: `cs_${randomUUID()}`,
      })),
    });
    // 55 succeeded transactions @ $20 → revenueProtected must be $1100.
    await db.paymentTransaction.createMany({
      data: Array.from({ length: 55 }, () => ({ tenantId: t.id, branchId: t.branchId, amount: 20, status: 'succeeded', mode: 'live' })),
    });
    // 55 open alerts @ $5 → revenueAtRisk must be $275. RevenueProtectionAlert is
    // an RLS-protected table, so it must be written under tenant context.
    await runWithTenantContext(t.id, tx => tx.revenueProtectionAlert.createMany({
      data: Array.from({ length: 55 }, () => ({ tenantId: t.id, branchId: t.branchId, sourceType: 'test', severity: 'low', title: 't', description: 'd', estimatedValue: 5, status: 'open', recommendedAction: 'r' })),
    }), { id: t.ownerId, role: 'OWNER' });

    const res = await app.inject({ method: 'GET', url: '/v1/revenue-protection/overview', headers: auth(t, t.ownerId) });
    expect(res.statusCode).toBe(200);
    const { summary } = res.json();
    expect(summary.copaysExpected).toBe(600);
    expect(summary.unpaidBalances).toBe(600);
    expect(summary.revenueProtected).toBe(1100);
    expect(summary.revenueAtRisk).toBe(275);
    // Sanity: these are strictly greater than the truncated (50-row) figures.
    expect(summary.copaysExpected).toBeGreaterThan(500);
  });
});

describe('#3 control-plane test buttons are honest (no fabricated success)', () => {
  it('finance test-payment-link returns not_configured and NEVER persists a fake Stripe payment request', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'POST', url: '/v1/control-plane/finance-rails/stripe/test-payment-link', headers: auth(t, t.ownerId) });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe('not_configured');
    expect(json.configured).toBe(false);
    expect(json.paymentUrl ?? null).toBeNull();
    // Never present a synthesized checkout.stripe.com URL as a real link.
    expect(res.body).not.toContain('checkout.stripe.com');
    // No fabricated payment request persisted for the tenant.
    expect(await db.paymentRequest.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('insurance test-eligibility returns not_configured and NEVER claims coverage', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'POST', url: '/v1/control-plane/insurance-rails/stedi/test-eligibility', headers: auth(t, t.ownerId) });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe('not_configured');
    expect(json.configured).toBe(false);
    expect(json.coverageStatus ?? null).toBeNull();
    expect(res.body).not.toContain('covered');
  });

  it('integration test reports not_configured for an unconfigured provider (no "test recorded successfully")', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'POST', url: '/v1/control-plane/integrations/stripe/test', headers: auth(t, t.ownerId) });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe('not_configured');
    expect(json.configured).toBe(false);
  });
});

describe('#5 insurance eligibility never presents a simulator result as a real payer response', () => {
  it('a provider row in production mode WITHOUT a live key fails closed', async () => {
    const t = await makeTenant();
    const patient = await db.patient.create({ data: { tenantId: t.id, branchId: t.branchId, firstName: 'Pat', lastName: 'Roe' } });
    // Configure Stedi in PRODUCTION mode in the DB — but there is no live STEDI key
    // in this environment, so the result MUST still be labelled sandbox/simulated.
    await db.insuranceProvider.create({ data: { tenantId: t.id, providerKey: 'stedi', displayName: 'Stedi', category: 'INSURANCE', mode: 'production', status: 'ACTIVE' } });

    const res = await app.inject({
      method: 'POST', url: '/v1/insurance/eligibility/check', headers: { ...auth(t, t.ownerId), 'content-type': 'application/json' },
      payload: JSON.stringify({ patientId: patient.id, payerName: 'Acme Health', memberId: 'MEM12345' }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toBe('An unexpected error occurred');
    const v = await db.eligibilityVerification.findFirst({ where: { tenantId: t.id, patientId: patient.id } });
    expect(v).toBeNull();
  });
});
