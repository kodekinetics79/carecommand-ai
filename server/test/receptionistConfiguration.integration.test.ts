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

type Role = 'OWNER' | 'MANAGER' | 'BILLING';
type TenantFixture = { id: string; users: Record<Role, string>; branchId: string };
const tenantIds: string[] = [];
let app: FastifyInstance;

const phone = () => `+1${(BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

async function tenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Receptionist config ${id.slice(0, 8)}`, slug: `receptionist-config-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const users = {} as Record<Role, string>;
  for (const role of ['OWNER', 'MANAGER', 'BILLING'] as const) {
    const row = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role.toLowerCase()}-${id.slice(0, 8)}@config.test`, displayName: role },
      select: { id: true },
    });
    users[role] = row.id;
  }
  const branch = await db.branch.create({
    data: { tenantId: id, name: 'Main scheduling branch', location: '1 Main Street', timezone: 'America/New_York', active: true },
    select: { id: true },
  });
  return { id, users, branchId: branch.id };
}

function auth(t: TenantFixture, role: Role) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: t.users[role], tenantId: t.id, role, type: 'access' })}` };
}

async function createClinic(t: TenantFixture, input: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST', url: '/v1/receptionist/clinics', headers: auth(t, 'OWNER'),
    payload: { name: `Clinic ${randomUUID().slice(0, 8)}`, phone: phone(), ...input },
  });
}

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app.close();
  await db.$disconnect();
});

describe('AI receptionist trusted configuration', () => {
  it('enforces management RBAC and validates canonical phones, IANA timezones, and structured hours', async () => {
    const t = await tenant();
    const denied = await app.inject({
      method: 'POST', url: '/v1/receptionist/clinics', headers: auth(t, 'BILLING'),
      payload: { name: 'Denied clinic', phone: phone() },
    });
    expect(denied.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/receptionist/clinics', headers: auth(t, 'BILLING') })).statusCode).toBe(403);

    await db.roleDefinition.upsert({
      where: { tenantId_name: { tenantId: t.id, name: 'Billing' } },
      create: { tenantId: t.id, name: 'Billing', description: 'Test override', permissions: ['receptionist:manage'] },
      update: { permissions: ['receptionist:manage'] },
    });
    expect((await app.inject({ method: 'GET', url: '/v1/receptionist/clinics', headers: auth(t, 'BILLING') })).statusCode).toBe(200);
    await db.roleDefinition.update({ where: { tenantId_name: { tenantId: t.id, name: 'Billing' } }, data: { permissions: ['settings:read'] } });
    expect((await app.inject({ method: 'GET', url: '/v1/receptionist/clinics', headers: auth(t, 'BILLING') })).statusCode).toBe(403);

    const invalid = await createClinic(t, {
      timezone: 'Eastern Time',
      humanFallbackNumber: '555-123-4567',
      workingHours: { monday: { open: true, start: '17:00', end: '09:00' } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(await db.receptionistClinic.count({ where: { tenantId: t.id } })).toBe(0);

    const valid = await app.inject({
      method: 'POST', url: '/v1/receptionist/clinics', headers: auth(t, 'MANAGER'),
      payload: {
        name: 'Valid clinic', phone: '+1 (212) 555-0100', timezone: 'America/New_York',
        humanFallbackNumber: '+1 (212) 555-0199',
        workingHours: { monday: { open: true, start: '09:00', end: '17:00' }, sunday: { open: false } },
      },
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json()).toMatchObject({ phone: '+12125550100', humanFallbackNumber: '+12125550199' });
  });

  it('allows only one active inbound destination globally under concurrent cross-tenant creates and reactivation', async () => {
    const [a, b] = await Promise.all([tenant(), tenant()]);
    const destination = phone();
    const [ra, rb] = await Promise.all([
      createClinic(a, { name: 'Race A', phone: destination }),
      createClinic(b, { name: 'Race B', phone: destination }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([201, 409]);
    expect([ra, rb].find(response => response.statusCode === 409)?.json().message).toContain('already assigned');
    expect(await db.receptionistClinic.count({ where: { phone: destination, active: true } })).toBe(1);

    const winner = ra.statusCode === 201 ? a : b;
    const loser = winner.id === a.id ? b : a;
    const inactive = await createClinic(loser, { name: 'Inactive duplicate', phone: destination, active: false });
    expect(inactive.statusCode).toBe(201);
    const reactivated = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/clinics/${inactive.json().id}`, headers: auth(loser, 'OWNER'), payload: { active: true },
    });
    expect(reactivated.statusCode).toBe(409);
    expect(reactivated.json().message).toContain('already assigned');
  });

  it('requires an explicit active same-tenant scheduling branch and rejects malformed location settings', async () => {
    const [owner, foreign] = await Promise.all([tenant(), tenant()]);
    const clinicResponse = await createClinic(owner, { name: 'Mapped clinic' });
    const clinicId = clinicResponse.json().id as string;
    const base = { clinicId, name: 'Downtown', address: '1 Main Street', timezone: 'America/New_York' };

    const missing = await app.inject({ method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'OWNER'), payload: base });
    expect(missing.statusCode).toBe(400);
    const crossTenant = await app.inject({ method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'OWNER'), payload: { ...base, branchId: foreign.branchId } });
    expect(crossTenant.statusCode).toBe(400);

    const inactiveBranch = await db.branch.create({ data: { tenantId: owner.id, name: 'Closed', location: 'Closed', active: false } });
    const inactive = await app.inject({ method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'OWNER'), payload: { ...base, branchId: inactiveBranch.id } });
    expect(inactive.statusCode).toBe(400);

    const invalidHours = await app.inject({
      method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'OWNER'),
      payload: { ...base, branchId: owner.branchId, phone: '2125550100', workingHours: { monday: { open: true, start: '9am', end: '5pm' } } },
    });
    expect(invalidHours.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'MANAGER'),
      payload: { ...base, branchId: owner.branchId, phone: '+1 212 555 0111', workingHours: { monday: { open: true, start: '09:00', end: '17:00' } } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ branchId: owner.branchId, phone: '+12125550111', active: true });

    await expect(db.receptionistLocation.create({
      data: { tenantId: owner.id, clinicId, branchId: foreign.branchId, name: 'DB bypass', address: 'Foreign' },
    })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.receptionistClinic.create({
      data: { tenantId: owner.id, name: 'Invalid DB phone', phone: '2125550198' },
    })).rejects.toThrow();
    expect(await db.receptionistClinic.count({ where: { tenantId: owner.id, name: 'Invalid DB phone' } })).toBe(0);
  });

  it('rolls the configuration write back when its append-only audit insert fails', async () => {
    const t = await tenant();
    const actorId = t.users.OWNER;
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION receptionist_config_audit_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW."actorUserId" = '${actorId}'::uuid AND NEW.action = 'receptionistClinic.created' THEN
          RAISE EXCEPTION 'injected receptionist audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER receptionist_config_audit_failure_trigger
      BEFORE INSERT ON "AuditEvent"
      FOR EACH ROW EXECUTE FUNCTION receptionist_config_audit_failure();
    `);
    try {
      const response = await createClinic(t, { name: 'Must roll back' });
      expect(response.statusCode).toBe(500);
      expect(await db.receptionistClinic.count({ where: { tenantId: t.id, name: 'Must roll back' } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS receptionist_config_audit_failure_trigger ON "AuditEvent"; DROP FUNCTION IF EXISTS receptionist_config_audit_failure();');
    }
  });

  it('preserves clinic lineage instead of cascading away receptionist history', async () => {
    const t = await tenant();
    const clinicResponse = await createClinic(t, { name: 'History clinic' });
    const clinicId = clinicResponse.json().id as string;
    await db.receptionistAgent.create({ data: { tenantId: t.id, clinicId, name: 'Configured agent' } });
    const deleted = await app.inject({ method: 'DELETE', url: `/v1/receptionist/clinics/${clinicId}`, headers: auth(t, 'OWNER') });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().message).toContain('Deactivate');
    expect(await db.receptionistClinic.count({ where: { id: clinicId } })).toBe(1);
  });
});
