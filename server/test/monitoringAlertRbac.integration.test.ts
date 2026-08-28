import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function fixture() {
  const tenantId = randomUUID();
  await db.tenant.create({ data: { id: tenantId, name: 'Monitoring RBAC', slug: `monitoring-${tenantId.slice(0, 8)}` } });
  createdTenantIds.push(tenantId);
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);
  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'Test' } });
  const [admin, provider] = await Promise.all([
    db.user.create({ data: { tenantId, email: `admin-${tenantId}@test.invalid`, displayName: 'Admin', role: 'ADMIN', branchId: branch.id } }),
    db.user.create({ data: { tenantId, email: `provider-${tenantId}@test.invalid`, displayName: 'Provider', role: 'PROVIDER', branchId: branch.id } }),
  ]);
  const alert = await db.readingAlert.create({
    data: { tenantId, branchId: branch.id, severity: 'high', alertType: 'abnormal_reading', generatedReason: 'Synthetic regression fixture' },
  });
  return { tenantId, adminId: admin.id, providerId: provider.id, alertId: alert.id };
}

function auth(tenantId: string, userId: string) {
  return { authorization: `Bearer ${app.jwt.sign({ tenantId, userId, role: 'OWNER', type: 'access' })}` };
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('monitoring alert mutation RBAC', () => {
  it('permits browser PATCH preflight for authenticated monitoring mutations', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: `/v1/monitoring/alerts/${randomUUID()}/acknowledge`,
      headers: {
        origin: 'http://localhost:12000',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization',
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:12000');
    expect(preflight.headers['access-control-allow-methods']).toContain('PATCH');
    expect(preflight.headers['access-control-allow-headers']).toContain('authorization');
  });

  it.each([
    ['acknowledge', undefined],
    ['assign', 'self'],
    ['resolve', { note: 'reviewed' }],
  ] as const)('allows PROVIDER read access but denies PATCH /alerts/:id/%s', async (action, body) => {
    const t = await fixture();
    const list = await app.inject({ method: 'GET', url: '/v1/monitoring/alerts', headers: auth(t.tenantId, t.providerId) });
    expect(list.statusCode).toBe(200);

    const payload = body === 'self' ? { assignedToUserId: t.providerId } : body;
    const denied = await app.inject({
      method: 'PATCH', url: `/v1/monitoring/alerts/${t.alertId}/${action}`,
      headers: auth(t.tenantId, t.providerId),
      ...(payload ? { payload } : {}),
    });
    expect(denied.statusCode).toBe(403);
    expect((await db.readingAlert.findUnique({ where: { id: t.alertId } }))?.status).toBe('open');
  });

  it('allows an ADMIN to acknowledge an alert', async () => {
    const t = await fixture();
    const allowed = await app.inject({
      method: 'PATCH', url: `/v1/monitoring/alerts/${t.alertId}/acknowledge`,
      headers: auth(t.tenantId, t.adminId),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().status).toBe('acknowledged');
  });
});
