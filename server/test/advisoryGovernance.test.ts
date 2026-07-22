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
const { db } = await import('../lib/db');
const { recomputeEntitlements } = await import('../lib/entitlements');

let app: FastifyInstance;
const tenants: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `adv-${id.slice(0, 6)}`, slug: `adv-${id.slice(0, 8)}` } });
  tenants.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Adv', lastName: 'Patient', lifecycleStage: 'AT_RISK' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `a-${id.slice(0, 8)}@adv.test`, displayName: 'Admin' } });
  return { id, adminId: admin.id };
}

const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, type: 'access' });
const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': '203.0.113.9' });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenants) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('Advisory — honest framing + governed AI path', () => {
  it('labels templated numbers as rule-based/heuristic and never bypasses the gateway to an external provider (mock)', async () => {
    const t = await makeTenant();
    const res = await app.inject({
      method: 'POST', url: '/v1/advisory/ask', headers: auth(tok(t.id, t.adminId)),
      payload: { advisorType: 'revenue', question: 'How do we recover lost revenue this quarter?' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Honest provenance: the answer is deterministic rule-based (mock provider),
    // and the templated arithmetic is explicitly labelled — not "AI confidence".
    expect(body.answerSource).toBe('rule-based');
    expect(body.methodology).toMatch(/rule-based/i);
    expect(typeof body.expectedImpact).toBe('number');
    expect(typeof body.confidence).toBe('number');
    expect(body.answer).toMatch(/Rule-based expected-impact estimate/);
    expect(body.answer).toMatch(/Heuristic confidence/);
    expect(body.answer).not.toMatch(/Expected impact: \$/);

    // Mock provider makes no external call and writes no advisory usage log
    // (no ungoverned bypass). A real provider would route through the gateway.
    const advisoryLogs = await db.aIUsageLog.count({ where: { tenantId: t.id, operation: 'advisory' } });
    expect(advisoryLogs).toBe(0);
  });

  it('brief returns every advisor with honest source + methodology labels', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'GET', url: '/v1/advisory/brief', headers: auth(tok(t.id, t.adminId)) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.advisors.length).toBe(5);
    for (const advisor of body.advisors) {
      expect(advisor.answerSource).toBe('rule-based');
      expect(advisor.methodology).toMatch(/rule-based/i);
    }
  });
});
