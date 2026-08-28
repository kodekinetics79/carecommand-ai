import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves the protection model is enforced by the BACKEND on direct API calls —
// not just hidden in the frontend: unauthenticated access, forged tokens, RBAC
// (role) bypass, cross-tenant access by id, and access after tenant suspension
// are all rejected at the server.
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
  await db.tenant.create({ data: { id, name: `sec-${id.slice(0, 6)}`, slug: `sec-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Seed', lastName: 'Patient', lifecycleStage: 'NEW' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@sec.test`, displayName: 'Admin' } });
  const provider = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pr-${id.slice(0, 8)}@sec.test`, displayName: 'Provider' } });
  return { id, branchId: branch.id, patientId: patient.id, adminUserId: admin.id, providerUserId: provider.id };
}

const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
const auth = (t: string, ip = '203.0.113.7') => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': ip });

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('security — backend enforces auth, RBAC, and tenant isolation on direct API calls', () => {
  it('rejects unauthenticated access to a protected route (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/patients' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a forged/malformed token (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/patients', headers: auth('not-a-real-jwt') });
    expect(res.statusCode).toBe(401);
  });

  it('enforces RBAC server-side: PROVIDER cannot create a patient (403); ADMIN can (201)', async () => {
    const t = await makeTenant();
    const payload = { branchId: t.branchId, firstName: 'New', lastName: 'Patient' };
    const denied = await app.inject({ method: 'POST', url: '/v1/patients', headers: auth(tok(t.id, t.providerUserId)), payload });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ method: 'POST', url: '/v1/patients', headers: auth(tok(t.id, t.adminUserId)), payload });
    expect(allowed.statusCode).toBe(201);
  });

  it('enforces tenant isolation: tenant A cannot read tenant B by id (404) or via the list', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const adminA = tok(a.id, a.adminUserId);

    const byId = await app.inject({ method: 'GET', url: `/v1/patients/${b.patientId}`, headers: auth(adminA) });
    expect(byId.statusCode).toBe(404);

    const list = await app.inject({ method: 'GET', url: '/v1/patients', headers: auth(adminA) });
    expect(list.statusCode).toBe(200);
    const ids = (JSON.parse(list.body).data as Array<{ id: string }>).map(p => p.id);
    expect(ids).not.toContain(b.patientId);
    expect(ids).toContain(a.patientId);
  });

  it('blocks an otherwise-valid token once the tenant is suspended (403)', async () => {
    const t = await makeTenant();
    const token = tok(t.id, t.adminUserId);
    const before = await app.inject({ method: 'GET', url: '/v1/patients', headers: auth(token) });
    expect(before.statusCode).toBe(200);

    await db.tenant.update({ where: { id: t.id }, data: { status: 'suspended' } });
    const after = await app.inject({ method: 'GET', url: '/v1/patients', headers: auth(token) });
    expect(after.statusCode).toBe(403);
  });
});
