import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const { generatePasswordHash } = await import('../lib/security');

let app: FastifyInstance;
const tenantIds: string[] = [];

async function fixture() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await db.tenant.create({ data: { id: tenantId, name: `Foundation ${tenantId.slice(0, 6)}`, slug: `foundation-${tenantId.slice(0, 8)}` } });
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId, name: 'Main', location: 'New York', timezone: 'America/New_York' } }),
    db.branch.create({ data: { tenantId, name: 'West', location: 'Chicago', timezone: 'America/Chicago' } }),
  ]);
  const password = 'Foundation-Secure-9!';
  const [owner, target] = await Promise.all([
    db.user.create({ data: { tenantId, branchId: branchA.id, email: `owner-${tenantId}@test.invalid`, displayName: 'Owner', role: 'OWNER', passwordHash: await generatePasswordHash(password), passwordChangedAt: new Date() } }),
    db.user.create({ data: { tenantId, branchId: branchA.id, email: `target-${tenantId}@test.invalid`, displayName: 'Target', role: 'FRONT_DESK', passwordHash: await generatePasswordHash(password), passwordChangedAt: new Date() } }),
  ]);
  await db.userClinicAccess.create({ data: { tenantId, userId: target.id, branchId: branchA.id, isPrimary: true } });
  return { tenantId, branchA, branchB, owner, target, password };
}

const bearer = (tenantId: string, userId: string) => ({
  authorization: `Bearer ${app.jwt.sign({ tenantId, userId, role: 'OWNER', type: 'access', sessionIssuedAtMs: Date.now() })}`,
  'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
});

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app.close();
  await db.$disconnect();
});

describe('foundation clinic and workforce master-data integrity', () => {
  it('serializes concurrent cross-deactivation so one active administrator always remains', async () => {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await db.tenant.create({ data: { id: tenantId, name: 'Admin race', slug: `admin-race-${tenantId.slice(0, 8)}` } });
    const [ownerA, ownerB] = await Promise.all([
      db.user.create({ data: { tenantId, email: `a-${tenantId}@test.invalid`, displayName: 'Owner A', role: 'OWNER' } }),
      db.user.create({ data: { tenantId, email: `b-${tenantId}@test.invalid`, displayName: 'Owner B', role: 'OWNER' } }),
    ]);
    const responses = await Promise.all([
      app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${ownerB.id}/status`, headers: bearer(tenantId, ownerA.id), payload: { active: false } }),
      app.inject({ method: 'PATCH', url: `/v1/admin/users/${ownerA.id}/status`, headers: bearer(tenantId, ownerB.id), payload: { active: false } }),
    ]);
    // The losing request is rejected either by the serialized last-admin guard
    // (409) or, when its own actor was deactivated first, by RLS fail-closed
    // visibility (404). It must never be allowed to deactivate both admins.
    expect(responses.map(response => response.statusCode).sort()).toEqual([
      200,
      expect.toSatisfy((status: number) => status === 404 || status === 409),
    ]);
    expect(await db.user.count({ where: { tenantId, active: true, role: { in: ['OWNER', 'ADMIN'] } } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'controlPlane.user.deactivated' } })).toBe(1);

    const remaining = await db.user.findFirstOrThrow({ where: { tenantId, active: true, role: { in: ['OWNER', 'ADMIN'] } } });
    const blocked = await app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${remaining.id}/status`, headers: bearer(tenantId, remaining.id), payload: { active: false } });
    expect(blocked.statusCode).toBe(409);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'admin.roleSafety.blocked' } })).toBe(1);
  });

  it('rejects invalid timezones before they can break scheduling', async () => {
    const t = await fixture();
    const invalid = await app.inject({ method: 'POST', url: '/v1/branches', headers: bearer(t.tenantId, t.owner.id), payload: { name: 'Invalid', location: 'Remote', timezone: 'Mars/Olympus' } });
    const valid = await app.inject({ method: 'POST', url: '/v1/branches', headers: bearer(t.tenantId, t.owner.id), payload: { name: 'Pacific', location: 'Seattle', timezone: 'America/Los_Angeles' } });
    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(201);
    expect(valid.json().timezone).toBe('America/Los_Angeles');
  });

  it('rejects foreign, inactive, or unselected primary clinic access without damaging existing access', async () => {
    const t = await fixture();
    const other = await fixture();
    const headers = bearer(t.tenantId, t.owner.id);
    const foreign = await app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${t.target.id}/clinic-access`, headers, payload: { branchIds: [other.branchA.id], primaryBranchId: other.branchA.id } });
    const primaryNotSelected = await app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${t.target.id}/clinic-access`, headers, payload: { branchIds: [t.branchA.id], primaryBranchId: t.branchB.id } });
    await db.branch.update({ where: { id: t.branchB.id }, data: { active: false } });
    const inactive = await app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${t.target.id}/clinic-access`, headers, payload: { branchIds: [t.branchB.id] } });
    expect([foreign.statusCode, primaryNotSelected.statusCode, inactive.statusCode]).toEqual([400, 400, 400]);
    const access = await db.userClinicAccess.findMany({ where: { tenantId: t.tenantId, userId: t.target.id } });
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ branchId: t.branchA.id, isPrimary: true });
    expect((await db.user.findUniqueOrThrow({ where: { id: t.target.id } })).branchId).toBe(t.branchA.id);
  });

  it('prevents clinic deactivation while active users remain assigned', async () => {
    const t = await fixture();
    const response = await app.inject({ method: 'PATCH', url: `/v1/control-plane/clinics/${t.branchA.id}/status`, headers: bearer(t.tenantId, t.owner.id), payload: { active: false } });
    expect(response.statusCode).toBe(409);
    expect((await db.branch.findUniqueOrThrow({ where: { id: t.branchA.id } })).active).toBe(true);
  });
});

describe('patient identity safeguards', () => {
  it('serializes duplicate identity creation and supports phone/external-reference search', async () => {
    const t = await fixture();
    const headers = bearer(t.tenantId, t.owner.id);
    const payload = { branchId: t.branchA.id, externalRef: 'MRN-9001', firstName: 'Maya', lastName: 'Lopez', dateOfBirth: '1988-04-12', email: 'MAYA@EXAMPLE.COM', phone: '+1 212 555 0100' };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/patients', headers, payload }),
      app.inject({ method: 'POST', url: '/v1/patients', headers, payload }),
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const created = responses.find(response => response.statusCode === 201)!.json();
    expect(created.email).toBe('maya@example.com');
    expect(await db.patient.count({ where: { tenantId: t.tenantId, externalRef: 'MRN-9001' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: 'patient.created', resourceId: created.id } })).toBe(1);

    const byPhone = await app.inject({ method: 'GET', url: '/v1/patients?search=212%20555&limit=20', headers });
    const byRef = await app.inject({ method: 'GET', url: '/v1/patients?search=MRN-9001&limit=20', headers });
    expect(byPhone.json().data.map((row: { id: string }) => row.id)).toContain(created.id);
    expect(byRef.json().data.map((row: { id: string }) => row.id)).toContain(created.id);
  });
});
