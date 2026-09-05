import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined }, registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined }, registerCampaignSchedules: async () => undefined,
}));
import { buildApp } from '../app';
import { fixtureDb as db } from './helpers/fixtureDb';
const app = await buildApp();
async function actor(role: 'OWNER' | 'FRONT_DESK' = 'OWNER') {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: 'Synthetic branch setup', slug: `branches-${id}` } });
  if (role === 'FRONT_DESK') await db.branch.create({ data: { tenantId: id, name: 'Assigned clinic', location: 'Synthetic site' } });
  const user = await db.user.create({ data: { tenantId: id, role, email: `${id}@example.test`, displayName: 'Synthetic owner', active: true } });
  return { id, headers: { authorization: `Bearer ${app.jwt.sign({ tenantId: id, userId: user.id, role, type: 'access' })}` } };
}
beforeAll(() => app.ready());
// Audit evidence is append-only. The disposable database runner owns cleanup;
// never disable its trigger or silently treat a failed cascade as a pass.
afterAll(async () => { await app.close(); await db.$disconnect(); });
describe('tenant branch provisioning', () => {
  it('serializes duplicate creation and audits the single committed clinic', async () => {
    const tenant = await actor();
    const payload = { name: 'Synthetic Irvine', location: 'Synthetic site', timezone: 'America/Los_Angeles' };
    const create = () => app.inject({ method: 'POST', url: '/v1/branches', headers: tenant.headers, payload });
    const results = await Promise.all([create(), create()]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409]);
    const branch = results.find(r => r.statusCode === 201)!.json();
    expect(branch).toMatchObject({ tenantId: tenant.id, timezone: 'America/Los_Angeles' });
    expect(await db.branch.count({ where: { tenantId: tenant.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: 'branch.created', resourceId: branch.id } })).toBe(1);
  });
  it('allows identical names in separate tenants, never the supplied foreign tenant ID', async () => {
    const a = await actor(); const b = await actor();
    for (const tenant of [a, b]) {
      const response = await app.inject({ method: 'POST', url: '/v1/branches', headers: tenant.headers, payload: { name: 'Main Clinic', location: 'Synthetic site', timezone: 'America/New_York', tenantId: a.id } });
      expect(response.statusCode).toBe(201);
      expect(response.json().tenantId).toBe(tenant.id);
    }
  });
  it('rejects unauthorized roles and invalid timezones without creating rows', async () => {
    const desk = await actor('FRONT_DESK'); const owner = await actor();
    const payload = { name: 'Test Clinic', location: 'Synthetic site', timezone: 'Invalid/Timezone' };
    expect((await app.inject({ method: 'POST', url: '/v1/branches', headers: desk.headers, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/branches', headers: owner.headers, payload })).statusCode).toBe(400);
    expect(await db.branch.count({ where: { tenantId: { in: [desk.id, owner.id] }, name: payload.name } })).toBe(0);
  });
});
