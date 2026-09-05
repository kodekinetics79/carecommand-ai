import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

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
const { aiGateway, AiGatewayBlockedError } = await import('../lib/ai/gateway');
const { aiContextBuilder } = await import('../lib/ai/context');
const { runInTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const tenants: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `ai-${id.slice(0, 6)}`, slug: `ai-${id.slice(0, 8)}` } });
  tenants.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'AI', lastName: 'Patient', lifecycleStage: 'NEW' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `a-${id.slice(0, 8)}@ai.test`, displayName: 'Admin' } });
  const provider = await db.user.create({ data: { tenantId: id, branchId: branch.id, role: 'PROVIDER', active: true, email: `p-${id.slice(0, 8)}@ai.test`, displayName: 'Provider' } });
  // Seed an open critical alert so the de-identified snapshot has real evidence.
  await db.readingAlert.create({ data: { tenantId: id, patientId: patient.id, branchId: branch.id, severity: 'critical', alertType: 'abnormal_reading', status: 'open', generatedReason: 'seeded for test' } });
  return { id, adminId: admin.id, providerId: provider.id };
}
const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': '203.0.113.9' });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenants) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('AI model gateway (integration, mock provider)', () => {
  it('fails closed for branch-scoped roles because legacy AI evidence is tenant-wide', async () => {
    const t = await makeTenant();
    const provider = auth(tok(t.id, t.providerId));
    for (const [method, url] of [
      ['GET', '/v1/ai/recommendations'],
      ['GET', '/v1/ai/usage'],
      ['GET', '/v1/ai/evaluations'],
      ['POST', '/v1/ai/recommendations/generate'],
      ['POST', '/v1/ai/providers/health-check'],
    ] as const) {
      expect((await app.inject({ method, url, headers: provider })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('generates evidence-backed recommendations and records usage', async () => {
    const t = await makeTenant();
    const admin = tok(t.id, t.adminId);

    const gen = await app.inject({ method: 'POST', url: '/v1/ai/recommendations/generate', headers: auth(admin) });
    expect(gen.statusCode).toBe(201);
    const body = JSON.parse(gen.body);
    expect(body.recommendations.length).toBeGreaterThan(0);
    // Every AI recommendation carries evidence.
    for (const r of body.recommendations) {
      expect(Array.isArray(r.evidence)).toBe(true);
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.evidence[0]).toHaveProperty('source');
      expect(r.aiProvider).toBe('mock');
      expect(r.requiresHumanReview).toBe(true); // AI_REQUIRE_HUMAN_APPROVAL default
    }

    const usage = JSON.parse((await app.inject({ method: 'GET', url: '/v1/ai/usage', headers: auth(admin) })).body);
    expect(usage.today.requests).toBeGreaterThanOrEqual(1);
    expect(usage.budgetDailyUsd).toBeGreaterThan(0);

    const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/ai/recommendations', headers: auth(admin) })).body);
    expect(list.length).toBe(body.recommendations.length);

    const evals = JSON.parse((await app.inject({ method: 'GET', url: '/v1/ai/evaluations', headers: auth(admin) })).body);
    expect(evals.length).toBeGreaterThanOrEqual(1);
    expect(evals[0].grounded).toBe(true);
  });

  it('health-checks the configured provider', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'POST', url: '/v1/ai/providers/health-check', headers: auth(tok(t.id, t.adminId)) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.provider).toBe('mock');
    expect(body.healthy).toBe(true);
  });

  it('blocks PHI when AI_ENABLE_PHI=false and logs the block', async () => {
    const t = await makeTenant();
    await expect(
      runInTenantContext(
        { tenantId: t.id, actorId: t.adminId, actorRole: 'ADMIN', source: 'request' },
        () => aiGateway.generate({ tenantId: t.id, operation: 'recommendation', containsPhi: true, messages: [{ role: 'user', content: 'x' }] }),
      ),
    ).rejects.toBeInstanceOf(AiGatewayBlockedError);
    const blocked = await db.aIUsageLog.findFirst({ where: { tenantId: t.id, status: 'blocked' } });
    expect(blocked?.error).toMatch(/PHI/);
  });

  it('context builder produces a de-identified snapshot (counts only, no PHI)', async () => {
    const t = await makeTenant();
    const snap = await runInTenantContext(
      { tenantId: t.id, actorId: t.adminId, actorRole: 'ADMIN', source: 'request' },
      () => aiContextBuilder.buildOperationalSnapshot(t.id),
    );
    expect(snap.phiEnabled).toBe(false);
    expect(snap.metrics.every(m => typeof m.value === 'number')).toBe(true);
    // No patient identifiers anywhere in the snapshot payload.
    expect(JSON.stringify(snap)).not.toMatch(/firstName|lastName|patientId|email/i);
    expect(snap.metrics.find(m => m.metric === 'open_critical_alerts')!.value).toBeGreaterThanOrEqual(1);
  });
});
