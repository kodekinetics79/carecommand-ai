import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Integrity/correctness guarantees a technical buyer will check:
//  1. Revenue dashboard headline totals are DB aggregates — correct past 50 rows,
//     not a truncated JS sum of a `take: 50` page (money under-reporting).
//  3. The provider "test" buttons are HONEST — they never synthesize a fake
//     Stripe URL, never persist a fabricated payment request, and never claim
//     'covered' eligibility when the real provider is not configured. Those
//     buttons answered a TENANT JWT under /v1/control-plane until 2026-08-30;
//     they are Platform Console surfaces now, so this suite asserts the gates
//     where they live AND asserts the tenant plane no longer serves them.
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
const { insuranceRailCapability } = await import('../modules/control-plane/routes');
const { signPlatformToken } = await import('../lib/platformAuth');
const { generatePasswordHash } = await import('../lib/security');

let app: FastifyInstance;
const createdTenantIds: string[] = [];
const platformAdminId = randomUUID();

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
// The supplier console lives behind the platform JWT, which a tenant token
// cannot mint. That separation is half of what moving these screens bought.
const platformAuth = () => ({
  authorization: `Bearer ${signPlatformToken(app, { id: platformAdminId, role: 'PLATFORM_ADMIN' })}`,
  'content-type': 'application/json',
});

beforeAll(async () => {
  app = await buildApp();
  await db.platformUser.create({
    data: {
      id: platformAdminId, email: `mi-${platformAdminId.slice(0, 8)}@carecommand.test`, name: 'Money Integrity Admin',
      passwordHash: await generatePasswordHash('Money-integrity-password-2026!'), role: 'PLATFORM_ADMIN', status: 'active',
    },
  });
}, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await db.platformAuditEvent.deleteMany({ where: { platformUserId: platformAdminId } }).catch(() => {});
  await db.platformUser.deleteMany({ where: { id: platformAdminId } }).catch(() => {});
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

  it('counts visible failed payment requests even without a transaction row', async () => {
    const t = await makeTenant();
    await db.paymentRequest.createMany({
      data: [
        { tenantId: t.id, branchId: t.branchId, amount: 80, currency: 'USD', status: 'failed', reason: 'Deposit', mode: 'mock' },
        { tenantId: t.id, branchId: t.branchId, amount: 140, currency: 'USD', status: 'failed', reason: 'Visit', mode: 'mock' },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/v1/revenue-protection/overview', headers: auth(t, t.ownerId) });

    expect(res.statusCode).toBe(200);
    expect(res.json().summary.failedPayments).toBe(2);
    expect(res.json().paymentRequests.filter((row: { status: string }) => row.status === 'failed')).toHaveLength(2);
  });
});

describe('#3 provider test buttons are honest (no fabricated success)', () => {
  it('derives Stedi sandbox/live mode from runtime mode and never configures unavailable adapters', () => {
    expect(insuranceRailCapability('stedi', { selectedProvider: 'stedi', stediApiKey: 'test-key', stediTestMode: true })).toEqual({ configured: true, mode: 'sandbox' });
    expect(insuranceRailCapability('stedi', { selectedProvider: 'stedi', stediApiKey: 'live-key', stediTestMode: false })).toEqual({ configured: true, mode: 'live' });
    expect(insuranceRailCapability('optum', { selectedProvider: 'optum', stediTestMode: false })).toEqual({ configured: false, mode: 'mock' });
  });

  it('reports unavailable payer adapters and prior-auth submission truthfully', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${t.id}/providers`, headers: platformAuth() });
    expect(res.statusCode).toBe(200);
    const rows = res.json().insuranceRails as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.priorAuthSupported).toBe(false);
      expect(row.priorAuthTrackingSupported).toBe(true);
    }
    for (const provider of ['availity', 'pverify', 'optum']) {
      expect(rows.find(row => row.provider === provider)).toMatchObject({ configured: false, mode: 'mock' });
    }
  });

  it('finance test-payment-link returns not_configured and NEVER persists a fake Stripe payment request', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${t.id}/finance-rails/stripe/test-payment-link`, headers: platformAuth() });
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
    const res = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${t.id}/insurance-rails/stedi/test-eligibility`, headers: platformAuth() });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe('not_configured');
    expect(json.configured).toBe(false);
    expect(json.coverageStatus ?? null).toBeNull();
    expect(res.body).not.toContain('covered');
  });

  it('integration test reports not_configured for an unconfigured provider (no "test recorded successfully")', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${t.id}/providers/stripe/test`, headers: platformAuth() });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe('not_configured');
    expect(json.configured).toBe(false);
  });

  /**
   * The other half of the move. A clinic bought a working payment link, not a
   * directory of the companies we buy it from — so an OWNER holding a perfectly
   * valid tenant token must not be able to reach the supplier catalogue at all,
   * however they learned the URL.
   */
  it('no longer serves the supplier catalogue or its test buttons to a tenant token', async () => {
    const t = await makeTenant();
    const withheld = [
      { method: 'GET' as const, url: '/v1/control-plane/integrations' },
      { method: 'POST' as const, url: '/v1/control-plane/integrations/stripe/test' },
      { method: 'GET' as const, url: '/v1/control-plane/insurance-rails' },
      { method: 'POST' as const, url: '/v1/control-plane/insurance-rails/stedi/test-eligibility' },
      { method: 'GET' as const, url: '/v1/control-plane/finance-rails' },
      { method: 'POST' as const, url: '/v1/control-plane/finance-rails/stripe/test-payment-link' },
      { method: 'GET' as const, url: '/v1/integrations/status' },
      { method: 'POST' as const, url: '/v1/integrations/stripe/test' },
    ];
    for (const route of withheld) {
      const res = await app.inject({ ...route, headers: auth(t, t.ownerId) });
      expect(res.statusCode, `${route.method} ${route.url} is still reachable with a tenant token`).toBe(404);
    }

    // And the tenant governance view no longer carries the rails in its body.
    const overview = await app.inject({ method: 'GET', url: '/v1/control-plane/overview', headers: auth(t, t.ownerId) });
    expect(overview.statusCode).toBe(200);
    const body = overview.json();
    expect(body.integrations).toBeUndefined();
    expect(body.insuranceRails).toBeUndefined();
    expect(body.financeRails).toBeUndefined();
    expect(body.summary.mockIntegrations).toBeUndefined();
    expect(body.summary.productionReadinessScore).toBeLessThan(100);
    expect(body.securityPosture.scoreLabel).toBe('Configured control inventory');
    expect(body.securityPosture.scoreLimitations).toContain('Mock and sandbox');
  });

  /**
   * What the clinic gets instead: a capability, a consequence, and us as the
   * next step. Never a supplier name, never an environment variable.
   */
  it('tells the tenant what it can do in our own words, naming no supplier', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'GET', url: '/v1/capabilities', headers: auth(t, t.ownerId) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ key: string; state: string; detail: string; usable: boolean }>;
    expect(rows.map(row => row.key).sort()).toEqual(['card_payments', 'eligibility_checks']);
    for (const row of rows) {
      expect(['available', 'test_data', 'not_set_up']).toContain(row.state);
      expect(row.detail.length).toBeGreaterThan(20);
    }
    const text = res.body.toLowerCase();
    for (const token of ['stedi', 'stripe', 'twilio', 'retell', 'availity', 'optum', '_api_key', '_secret_key']) {
      expect(text, `capability payload names "${token}"`).not.toContain(token);
    }
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
      method: 'POST', url: '/v1/insurance/eligibility/check', headers: { ...auth(t, t.ownerId), 'content-type': 'application/json', 'idempotency-key': 'money-integrity-eligibility' },
      payload: JSON.stringify({ patientId: patient.id, payerName: 'Acme Health', memberId: 'MEM12345' }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toBe('An unexpected error occurred');
    const v = await db.eligibilityVerification.findFirst({ where: { tenantId: t.id, patientId: patient.id } });
    expect(v).toBeNull();
    expect(await db.eligibilityExecution.count({ where: { tenantId: t.id } })).toBe(0);
  });
});

describe('#6 both eligibility surfaces use the durable execution boundary', () => {
  it('replays revenue-protection eligibility without duplicating canonical or downstream rows', async () => {
    const t = await makeTenant();
    const patient = await db.patient.create({ data: { tenantId: t.id, branchId: t.branchId, firstName: 'Revenue', lastName: 'Patient' } });
    const payer = await db.insurancePayer.create({ data: { tenantId: t.id, name: 'Revenue Test Payer', sourceProvider: 'mock' } });
    const policy = await db.patientInsurancePolicy.create({
      data: { tenantId: t.id, branchId: t.branchId, patientId: patient.id, payerId: payer.id, planName: 'Test PPO', memberId: 'REV-MEMBER-1234' },
    });
    const headers = { ...auth(t, t.ownerId), 'idempotency-key': 'revenue-eligibility-replay' };
    const payload = { branchId: t.branchId, patientId: patient.id, payerId: payer.id, policyId: policy.id, serviceType: 'office visit' };

    const first = await app.inject({ method: 'POST', url: '/v1/revenue-protection/eligibility/check', headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);
    const replay = await app.inject({ method: 'POST', url: '/v1/revenue-protection/eligibility/check', headers, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      verificationId: first.json().verificationId,
      executionId: first.json().executionId,
      replayed: true,
    });

    expect(await db.eligibilityExecution.count({ where: { tenantId: t.id } })).toBe(1);
    expect(await db.eligibilityVerification.count({ where: { tenantId: t.id } })).toBe(1);
    expect(await db.benefitSnapshot.count({ where: { tenantId: t.id } })).toBe(1);
    expect(await db.patientResponsibilityEstimate.count({ where: { tenantId: t.id } })).toBe(1);
    expect(await db.integrationRunLog.count({ where: { tenantId: t.id, operation: 'eligibility.check', status: 'success' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'eligibility.checked' } })).toBe(1);
    const storedVerification = await db.eligibilityVerification.findFirstOrThrow({ where: { tenantId: t.id } });
    expect(storedVerification.rawResponse).toBeNull();
    expect(JSON.stringify(storedVerification.normalizedResponse)).not.toContain('REV-MEMBER-1234');
  });
});
