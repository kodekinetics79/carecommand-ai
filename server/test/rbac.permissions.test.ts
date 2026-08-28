import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves the permission/action RBAC layer is enforced by the BACKEND on direct
// API calls, and — critically — that a tenant's RoleDefinition permission
// override actually CHANGES enforcement (grants and revocations), so custom
// roles are a real control and not a cosmetic catalogue. Also proves overrides
// are tenant-scoped and never leak across tenants.
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

let app: FastifyInstance;
const createdTenantIds: string[] = [];

type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'PROVIDER' | 'FRONT_DESK';

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `rbac-${id.slice(0, 6)}`, slug: `rbac-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const users: Record<Role, string> = {} as Record<Role, string>;
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'PROVIDER', 'FRONT_DESK'] as Role[]) {
    const user = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role}-${id.slice(0, 8)}@rbac.test`, displayName: role },
    });
    users[role] = user.id;
  }
  return { id, branchId: branch.id, users };
}

/** Set (or clear) a tenant's permission override for a role's catalogue name. */
async function setOverride(tenantId: string, name: string, permissions: string[]) {
  await db.roleDefinition.upsert({
    where: { tenantId_name: { tenantId, name } },
    update: { permissions },
    create: { tenantId, name, description: `${name} role`, permissions },
  });
}

const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, type: 'access' });
const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': '203.0.113.9' });

const createPatient = (t: { id: string; branchId: string }, userId: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/patients',
    headers: auth(tok(t.id, userId)),
    payload: { branchId: t.branchId, firstName: 'New', lastName: 'Patient' },
  });

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('permission/action RBAC — backend-enforced, tenant-customisable', () => {
  it('default matrix is enforced: patient:write allows FRONT_DESK/ADMIN (201), denies PROVIDER (403)', async () => {
    const t = await makeTenant();
    expect((await createPatient(t, t.users.FRONT_DESK)).statusCode).toBe(201);
    expect((await createPatient(t, t.users.ADMIN)).statusCode).toBe(201);
    const denied = await createPatient(t, t.users.PROVIDER);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('insufficient_permission');
    expect(denied.json().permission).toBe('patient:write');
  });

  it('a tenant override GRANTS a permission: PROVIDER with patient:write override can now create (201)', async () => {
    const t = await makeTenant();
    expect((await createPatient(t, t.users.PROVIDER)).statusCode).toBe(403); // default
    await setOverride(t.id, 'Provider', ['patient:read', 'patient:write']);
    expect((await createPatient(t, t.users.PROVIDER)).statusCode).toBe(201); // enforced override
  });

  it('a tenant override REVOKES a permission: FRONT_DESK without patient:write is now denied (403)', async () => {
    const t = await makeTenant();
    expect((await createPatient(t, t.users.FRONT_DESK)).statusCode).toBe(201); // default
    await setOverride(t.id, 'Front Desk', ['patient:read']); // strip write
    expect((await createPatient(t, t.users.FRONT_DESK)).statusCode).toBe(403); // enforced revocation
  });

  it('overrides are tenant-scoped: a grant in tenant A does not leak to tenant B', async () => {
    const [a, b] = [await makeTenant(), await makeTenant()];
    await setOverride(a.id, 'Provider', ['patient:read', 'patient:write']);
    expect((await createPatient(a, a.users.PROVIDER)).statusCode).toBe(201); // A granted
    expect((await createPatient(b, b.users.PROVIDER)).statusCode).toBe(403); // B unaffected
  });

  it('settings:write is enforced: MANAGER can create a notification template (201), PROVIDER cannot (403)', async () => {
    const t = await makeTenant();
    const body = { name: 'Welcome', channel: 'SMS' };
    const ok = await app.inject({ method: 'POST', url: '/v1/settings/notification-templates', headers: auth(tok(t.id, t.users.MANAGER)), payload: body });
    expect(ok.statusCode).toBe(201);
    const denied = await app.inject({ method: 'POST', url: '/v1/settings/notification-templates', headers: auth(tok(t.id, t.users.PROVIDER)), payload: body });
    expect(denied.statusCode).toBe(403);
  });

  it('admin:manage is enforced: ADMIN can read the admin overview (200), MANAGER cannot (403)', async () => {
    const t = await makeTenant();
    expect((await app.inject({ method: 'GET', url: '/v1/settings/admin/overview', headers: auth(tok(t.id, t.users.ADMIN)) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/settings/admin/overview', headers: auth(tok(t.id, t.users.MANAGER)) })).statusCode).toBe(403);
  });
});
