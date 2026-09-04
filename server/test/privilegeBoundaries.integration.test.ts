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
 * Privilege-boundary contracts.
 *
 * 1. The advisory brief is a PHI-bearing commercial surface and therefore
 *    requires an explicit permission plus audit evidence.
 * 2. RoleDefinition is only a per-tenant override for the nine assignable
 *    UserRole values. It is not a second custom-role system: arbitrary labels
 *    are rejected, built-in edits require admin:manage, and even an admin may
 *    not grant platform-only authority it does not hold.
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
      expect(JSON.stringify(events[0].metadata ?? {})).not.toMatch(/firstName|lastName|dateOfBirth/i);
    }, 30_000);
  });

  describe('role overrides cannot exceed the nine-role authority model', () => {
    it('refuses a manager redefining a built-in role', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('MANAGER'),
        payload: { name: 'Branch Manager', description: 'mine now', permissions: ['patient:read'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('reserved_role_name');
      expect(await db.roleDefinition.count({ where: { tenantId, name: 'Branch Manager' } })).toBe(0);
    });

    it('rejects arbitrary custom role labels instead of creating fake access policy', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('ADMIN'),
        payload: { name: 'Custom Ops', description: 'not assignable', permissions: ['patient:read'] },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('unsupported_role_name');
      expect(await db.roleDefinition.count({ where: { tenantId, name: 'Custom Ops' } })).toBe(0);
    });

    it('refuses an admin granting platform-only authority the admin does not hold', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('ADMIN'),
        payload: { name: 'Auditor', description: 'escalation attempt', permissions: ['platform:voice-line-mechanics:read'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('permission_escalation');
      expect(await db.roleDefinition.count({ where: { tenantId, name: 'Auditor' } })).toBe(0);
    });

    it('lets an admin define a supported built-in role override within its own authority', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/settings/roles', headers: auth('ADMIN'),
        payload: { name: 'Analyst', description: 'tenant override', permissions: ['patient:read', 'appointment:read'] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(expect.objectContaining({ name: 'Analyst' }));
    });

    it('refuses a manager patching an existing built-in override', async () => {
      const existing = await db.roleDefinition.findFirstOrThrow({ where: { tenantId, name: 'Analyst' } });
      const res = await app.inject({
        method: 'PATCH', url: `/v1/settings/roles/${existing.id}`, headers: auth('MANAGER'),
        payload: { permissions: ['patient:read'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('reserved_role_name');
      expect((await db.roleDefinition.findUniqueOrThrow({ where: { id: existing.id } })).permissions).toEqual(['patient:read', 'appointment:read']);
    });
  });
});
