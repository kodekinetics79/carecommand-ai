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

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `brief-${id.slice(0, 6)}`, slug: `brief-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'HQ' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Morning', lastName: 'Briefing', lifecycleStage: 'NEW' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `admin-${id.slice(0, 8)}@brief.test`, displayName: 'Admin' } });
  return { id, branchId: branch.id, patientId: patient.id, adminId: admin.id };
}

const auth = (tenantId: string, userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' })}` });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('morning briefing signal CRUD + aggregate', () => {
  it('creates, updates, deletes, and surfaces briefing signals in the morning briefing', async () => {
    const t = await makeTenant();
    const headers = auth(t.id, t.adminId);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/monitoring/morning-briefing/signals',
      headers,
      payload: {
        branchId: t.branchId,
        patientId: t.patientId,
        signalType: 'rpm_opportunity',
        title: 'RPM follow-up needed',
        detail: 'Patient has two elevated glucose readings this week.',
        severity: 'warning',
        metricValue: 2,
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json();
    expect(createdBody.title).toBe('RPM follow-up needed');
    expect(createdBody.signalType).toBe('rpm_opportunity');

    const listed = await app.inject({ method: 'GET', url: '/v1/monitoring/morning-briefing/signals', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);

    const brief1 = await app.inject({ method: 'GET', url: '/v1/monitoring/morning-briefing', headers });
    expect(brief1.statusCode).toBe(200);
    const briefBody1 = brief1.json();
    expect(briefBody1.signals.some((s: { title: string }) => s.title === 'RPM follow-up needed')).toBe(true);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/monitoring/morning-briefing/signals/${createdBody.id}`,
      headers,
      payload: {
        title: 'RPM outreach needed',
        severity: 'critical',
        metricValue: 3,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().severity).toBe('critical');

    const brief2 = await app.inject({ method: 'GET', url: '/v1/monitoring/morning-briefing', headers });
    expect(brief2.statusCode).toBe(200);
    const briefBody2 = brief2.json();
    expect(briefBody2.signals.some((s: { title: string; severity: string }) => s.title === 'RPM outreach needed' && s.severity === 'critical')).toBe(true);

    const deleted = await app.inject({ method: 'DELETE', url: `/v1/monitoring/morning-briefing/signals/${createdBody.id}`, headers });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    const listedAfter = await app.inject({ method: 'GET', url: '/v1/monitoring/morning-briefing/signals', headers });
    expect(listedAfter.statusCode).toBe(200);
    expect(listedAfter.json()).toHaveLength(0);

    const brief3 = await app.inject({ method: 'GET', url: '/v1/monitoring/morning-briefing', headers });
    expect(brief3.statusCode).toBe(200);
    expect(brief3.json().signals.some((s: { id: string }) => s.id === createdBody.id)).toBe(false);
  });
});
