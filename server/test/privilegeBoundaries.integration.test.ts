import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

/**
 * Two privilege boundaries that were open.
 *
 * 1. The advisory brief returns named patients with churn risk, lifetime value
 *    and outstanding balance. It had no permission check at all - every
 *    authenticated role could read it - and recorded no audit event.
 * 2. A RoleDefinition named after a built-in role REPLACES that role's default
 *    grants. Role CRUD is gated on `settings:write`, which MANAGER holds, so a
 *    Branch Manager could write a "Branch Manager" definition granting itself
 *    admin:manage and hold it on the next request.
 */
describe('privilege boundaries', () => {
  let app: FastifyInstance;
  const tenantId = randomUUID();
  const users: Record<string, string> = {};

  const auth = (role: string) => ({
    authorization: `Bearer ${app.jwt.sign({ userId: users[role], tenantId, role, type: 'access' })}`,
    'content-type': 'application/json',
  });

  beforeAll(async () => {
    app = await buildApp();
    await db.tenant.create({ data: { id: tenantId, name: `priv-${tenantId.slice(0, 6)}`, slug: `priv-${tenantId.slice(0, 8)}` } });
    const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'Main' } });
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'ANALYST'] as const) {
      const user = await db.user.create({
        data: { tenantId, branchId: branch.id, role, active: true, email: `${role}-${tenantId.slice(0, 8)}@priv.test`, displayName: role },
      });
      users[role] = user.id;
    }
  }, 90_000);

  afterAll(async () => {
    // The advisory assertions write tenant AuditEvent rows, and AuditEvent is
    // append-only for every database role by trigger - so deleting the users or
    // the tenant would cascade into it and correctly raise P0001. Retire the
    // fixture instead; every assertion is scoped to this tenant id.
    await db.roleDefinition.deleteMany({ where: { tenantId } });
    await db.user.updateMany({ where: { tenantId }, data: { active: false } });
    await db.tenant.updateMany({ where: { id: tenantId }, data: { status: 'cancelled', name: 'ZZ test fixture (privilege boundaries)' } });
    await app.close();
  });

  describe('the advisory brief is a PHI surface, not a public one', () => {
    it('refuses a role that has no business reading a commercial brief naming patients', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/advisory/brief', headers: auth('FRONT_DESK') });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('insufficient_permission');
    });

    it('refuses the same role on the ask endpoint', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/advisory/ask', headers: auth('FRONT_DESK'),
        payload: { advisorType: 'revenue', question: 'How is the month tracking?' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows an analyst, and records the disclosure by count rather than by patient', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/advisory/brief', headers: auth('ANALYST') });
      expect(res.statusCode).toBe(200);
      const events = await db.auditEvent.findMany({ where: { tenantId, action: 'advisory.brief.read' } });
      expect(events.length).toBeGreaterThan(0);
      // The record must never become a second copy of the PHI it describes.
      expect(JSON.stringify(events[0].metadata ?? {})).not.toMatch(/firstName|lastName|dateOfBirth/i);
    }, 30_000);
  });

  describe('a role edit cannot exceed the editor', () => {
    it('refuses a manager redefining a built-in role', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('MANAGER'),
        payload: { name: 'Branch Manager', description: 'mine now', permissions: ['patient:read'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('reserved_role_name');
      expect(await db.roleDefinition.count({ where: { tenantId, name: 'Branch Manager' } })).toBe(0);
    });

    it('refuses a manager granting a permission it does not hold', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('MANAGER'),
        payload: { name: 'Custom Ops', description: 'escalation attempt', permissions: ['admin:manage'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('permission_escalation');
    });

    it('still lets a manager create a role within its own authority', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('MANAGER'),
        payload: { name: 'Front Desk Lead', description: 'legitimate', permissions: ['patient:read', 'appointment:read'] },
      });
      expect(res.statusCode).toBe(201);
    });

    it('refuses a manager escalating an existing role by patch', async () => {
      const created = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('ADMIN'),
        payload: { name: 'Patchable', description: 'seed', permissions: ['patient:read'] },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id as string;
      const res = await app.inject({
        method: 'PATCH', url: `/v1/settings/roles/${id}`, headers: auth('MANAGER'),
        payload: { permissions: ['admin:manage'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('permission_escalation');
    });

    it('refuses a manager renaming a role onto a built-in name', async () => {
      const created = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('MANAGER'),
        payload: { name: 'Renamable', description: 'seed', permissions: ['patient:read'] },
      });
      expect(created.statusCode).toBe(201);
      const res = await app.inject({
        method: 'PATCH', url: `/v1/settings/roles/${created.json().id}`, headers: auth('MANAGER'),
        payload: { name: 'Admin' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('reserved_role_name');
    });

    it('leaves an admin able to define a built-in role, which is the point of overrides', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('ADMIN'),
        payload: { name: 'Branch Manager', description: 'tenant override', permissions: ['patient:read', 'appointment:read'] },
      });
      expect(res.statusCode).toBe(201);
    });
  });
});
