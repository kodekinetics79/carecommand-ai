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

type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'BILLING' | 'PROVIDER' | 'FRONT_DESK' | 'ANALYST' | 'COMPLIANCE_OFFICER' | 'AUDITOR';

type TenantFixture = {
  id: string;
  branchA: string;
  branchB: string;
  users: Record<Role, string>;
};

type GuardedRoute = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  permission: string;
  payload?: Record<string, unknown>;
};

let app: FastifyInstance;
const tenantIds: string[] = [];
const fixedId = '00000000-0000-4000-8000-000000000009';
const ALL_ROLES: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR'];

// `patient_crm` ships in every plan tier; `campaign_automation` is a Growth
// add-on. Both are enabled by default so an authorization failure can never be
// mistaken for an entitlement failure.
async function makeTenant(features: string[] = ['campaign_automation', 'patient_crm']): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `growth-auth-${id.slice(0, 6)}`, slug: `growth-auth-${id.slice(0, 8)}` } });
  for (const featureKey of features) {
    await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey, enabled: true, source: 'test' } });
  }
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId: id, name: 'Branch A', location: 'A' } }),
    db.branch.create({ data: { tenantId: id, name: 'Branch B', location: 'B' } }),
  ]);
  const users = {} as Record<Role, string>;
  for (const role of ALL_ROLES) {
    const user = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role}-${id.slice(0, 8)}@growth-auth.test`, displayName: role },
    });
    users[role] = user.id;
  }
  return { id, branchA: branchA.id, branchB: branchB.id, users };
}

function headers(tenant: TenantFixture, role: Role) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: tenant.users[role], tenantId: tenant.id, role, type: 'access' })}` };
}

function inject(tenant: TenantFixture, role: Role, route: GuardedRoute) {
  return app.inject({
    method: route.method,
    url: route.url,
    headers: headers(tenant, role),
    ...(route.payload === undefined ? {} : { payload: route.payload }),
  });
}

// Every read the Growth module exposes. Before this suite these carried only the
// campaign_automation entitlement hook, so any authenticated role in an entitled
// tenant could read them — including the audience preview, which returns real
// patient names, a reason, and a masked destination.
const guardedReads: GuardedRoute[] = [
  { method: 'GET', url: '/v1/crm/provider-status', permission: 'campaign:read' },
  { method: 'GET', url: '/v1/crm/campaigns', permission: 'campaign:read' },
  { method: 'GET', url: `/v1/crm/campaigns/${fixedId}`, permission: 'campaign:read' },
  { method: 'GET', url: '/v1/crm/audiences/inactive_patients/preview', permission: 'crm:read' },
  { method: 'GET', url: '/v1/crm/automation-rules/catalog', permission: 'campaign:read' },
  { method: 'GET', url: '/v1/crm/automation-rules', permission: 'campaign:read' },
  { method: 'GET', url: `/v1/crm/campaigns/${fixedId}/deliveries`, permission: 'campaign:read' },
  { method: 'GET', url: '/v1/crm/consent', permission: 'crm:read' },
  { method: 'GET', url: '/v1/crm/suppressions', permission: 'crm:read' },
];

const guardedWrites: GuardedRoute[] = [
  { method: 'POST', url: '/v1/crm/campaigns', permission: 'campaign:manage', payload: { name: 'Winback', campaignType: 'custom' } },
  { method: 'PATCH', url: `/v1/crm/campaigns/${fixedId}`, permission: 'campaign:manage', payload: { name: 'Renamed' } },
  { method: 'POST', url: `/v1/crm/campaigns/${fixedId}/draft`, permission: 'campaign:manage' },
  { method: 'POST', url: `/v1/crm/campaigns/${fixedId}/approve`, permission: 'campaign:manage' },
  { method: 'GET', url: `/v1/crm/campaigns/${fixedId}/launch-preview`, permission: 'campaign:manage' },
  { method: 'POST', url: `/v1/crm/campaigns/${fixedId}/pause`, permission: 'campaign:manage' },
  { method: 'POST', url: `/v1/crm/campaigns/${fixedId}/cancel`, permission: 'campaign:manage' },
  { method: 'DELETE', url: `/v1/crm/campaigns/${fixedId}`, permission: 'campaign:manage' },
  { method: 'POST', url: '/v1/crm/automation-rules', permission: 'campaign:manage', payload: { templateKey: 'hot_lead_not_booked' } },
  { method: 'PATCH', url: `/v1/crm/automation-rules/${fixedId}`, permission: 'campaign:manage', payload: { enabled: false } },
  { method: 'DELETE', url: `/v1/crm/automation-rules/${fixedId}`, permission: 'campaign:manage' },
  { method: 'POST', url: `/v1/crm/automation-rules/${fixedId}/run`, permission: 'campaign:manage' },
  { method: 'POST', url: '/v1/crm/opportunities/scan', permission: 'campaign:manage' },
  { method: 'POST', url: `/v1/crm/leads/${fixedId}/send`, permission: 'crm:write', payload: { cta: 'send_follow_up' } },
  { method: 'POST', url: '/v1/crm/consent', permission: 'crm:write', payload: { patientId: fixedId, channel: 'sms', status: 'opted_out' } },
  { method: 'POST', url: '/v1/crm/suppressions', permission: 'crm:write', payload: { patientId: fixedId, channel: 'sms', reason: 'requested' } },
];

// Foreign-identity probes: the guard must refuse before the route ever looks at
// the referenced record, and an authorized caller must still be refused a
// reference that is not theirs.
const foreignIdentityWrites: GuardedRoute[] = [
  { method: 'POST', url: '/v1/crm/suppressions', permission: 'crm:write', payload: { patientId: fixedId, channel: 'sms', reason: 'requested' } },
  { method: 'POST', url: '/v1/crm/consent', permission: 'crm:write', payload: { patientId: fixedId, channel: 'sms', status: 'opted_out' } },
];

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('Growth module authorization', () => {
  it('authorizes every Growth read before returning campaign or patient data', async () => {
    const tenant = await makeTenant();
    for (const route of guardedReads) {
      const denied = await inject(tenant, 'AUDITOR', route);
      expect(denied.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(denied.json(), `${route.method} ${route.url}`).toMatchObject({
        error: 'insufficient_permission', permission: route.permission,
      });

      const allowed = await inject(tenant, 'OWNER', route);
      expect(allowed.statusCode, `${route.method} ${route.url}`).not.toBe(403);
      expect(allowed.statusCode, `${route.method} ${route.url}`).toBeLessThan(500);
    }
  });

  it('authorizes every Growth write through the permission layer, not a role list', async () => {
    const tenant = await makeTenant();
    for (const route of guardedWrites) {
      const denied = await inject(tenant, 'AUDITOR', route);
      expect(denied.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(denied.json(), `${route.method} ${route.url}`).toMatchObject({
        error: 'insufficient_permission', permission: route.permission,
      });
      const allowed = await inject(tenant, 'OWNER', route);
      expect(allowed.statusCode, `${route.method} ${route.url}`).not.toBe(403);
      expect(allowed.statusCode, `${route.method} ${route.url}`).toBeLessThan(500);
    }
  });

  // The defect: /v1/leads deliberately denies BILLING, PROVIDER,
  // COMPLIANCE_OFFICER and AUDITOR under crm:read, while the same data class was
  // wide open one prefix over.
  it.each([
    '/v1/leads',
    '/v1/crm/audiences/inactive_patients/preview',
    '/v1/crm/consent',
    '/v1/crm/suppressions',
  ])('denies %s to exactly the roles that cannot read patient CRM data', async url => {
    const tenant = await makeTenant();
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'ANALYST'] as Role[]) {
      expect((await app.inject({ method: 'GET', url, headers: headers(tenant, role) })).statusCode, `${url} ${role}`).toBe(200);
    }
    for (const role of ['BILLING', 'PROVIDER', 'COMPLIANCE_OFFICER', 'AUDITOR'] as Role[]) {
      const response = await app.inject({ method: 'GET', url, headers: headers(tenant, role) });
      expect(response.statusCode, `${url} ${role}`).toBe(403);
      expect(response.json(), `${url} ${role}`).toMatchObject({ error: 'insufficient_permission', permission: 'crm:read' });
    }
  });

  it('never leaks a patient name to a role that cannot read /v1/leads', async () => {
    const tenant = await makeTenant();
    await db.patient.create({ data: {
      tenantId: tenant.id, branchId: tenant.branchA, firstName: 'Preview', lastName: 'Leak',
      phone: '+15550000001', lastVisitAt: new Date(Date.now() - 400 * 86400000),
    } });
    for (const role of ['BILLING', 'PROVIDER', 'COMPLIANCE_OFFICER', 'AUDITOR'] as Role[]) {
      const response = await app.inject({
        method: 'GET', url: '/v1/crm/audiences/inactive_patients/preview?channel=sms', headers: headers(tenant, role),
      });
      expect(response.statusCode, role).toBe(403);
      expect(response.body, role).not.toContain('Preview');
    }
  });

  // A tenant RoleDefinition override must reach these routes. requireRoles()
  // ignored it, so a tenant that revoked campaign:manage from MANAGER still had
  // full campaign write access here.
  it('honours a per-tenant RoleDefinition override on Growth writes', async () => {
    const [tenantA, tenantB] = [await makeTenant(), await makeTenant()];
    const create: GuardedRoute = { method: 'POST', url: '/v1/crm/campaigns', permission: 'campaign:manage', payload: { name: 'Winback', campaignType: 'custom' } };

    expect((await inject(tenantB, 'MANAGER', create)).statusCode).toBe(201);

    await db.roleDefinition.create({ data: {
      tenantId: tenantA.id, name: 'Branch Manager', description: 'Read-only manager', permissions: ['campaign:read'],
    } });
    const revoked = await inject(tenantA, 'MANAGER', create);
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json()).toMatchObject({ error: 'insufficient_permission', permission: 'campaign:manage' });
    // The override is tenant-bound: tenant B is unaffected.
    expect((await inject(tenantB, 'MANAGER', create)).statusCode).toBe(201);
  });

  it('keeps the consent read available to a tenant without campaign automation', async () => {
    const tenant = await makeTenant(['patient_crm']);
    // The CRM page requests consent alongside /v1/leads and /v1/patients. Gating
    // it on the campaign add-on failed the whole request set for this tenant.
    expect((await app.inject({ method: 'GET', url: '/v1/leads', headers: headers(tenant, 'OWNER') })).statusCode).toBe(200);
    const consent = await app.inject({ method: 'GET', url: '/v1/crm/consent', headers: headers(tenant, 'OWNER') });
    expect(consent.statusCode).toBe(200);
    expect(Array.isArray(consent.json())).toBe(true);

    // The campaign surfaces stay entitlement-locked for the same tenant.
    const campaigns = await app.inject({ method: 'GET', url: '/v1/crm/campaigns', headers: headers(tenant, 'OWNER') });
    expect(campaigns.statusCode).toBe(403);
    expect(campaigns.json()).toMatchObject({ error: 'feature_locked', feature: 'campaign_automation' });
  });

  it('excludes other branches from a branch-scoped campaign audience', async () => {
    const tenant = await makeTenant();
    await db.user.update({ where: { id: tenant.users.MANAGER }, data: { branchId: tenant.branchA } });
    const stale = new Date(Date.now() - 400 * 86400000);
    await Promise.all([
      db.patient.create({ data: { tenantId: tenant.id, branchId: tenant.branchA, firstName: 'Alpha', lastName: 'Branchpatient', phone: '+15550000101', lastVisitAt: stale } }),
      db.patient.create({ data: { tenantId: tenant.id, branchId: tenant.branchB, firstName: 'Bravo', lastName: 'Branchpatient', phone: '+15550000102', lastVisitAt: stale } }),
    ]);

    const url = '/v1/crm/audiences/inactive_patients/preview?channel=sms';
    const scoped = await app.inject({ method: 'GET', url, headers: headers(tenant, 'MANAGER') });
    expect(scoped.statusCode).toBe(200);
    const scopedBody = scoped.json() as { total: number; sample: Array<{ name: string }> };
    expect(scopedBody.sample.map(row => row.name)).toContain('Alpha Branchpatient');
    expect(scopedBody.sample.map(row => row.name)).not.toContain('Bravo Branchpatient');
    expect(scopedBody.total).toBe(1);
    expect(scoped.body).not.toContain('Bravo');

    // An unrestricted operator in the same tenant still sees both branches.
    const tenantWide = await app.inject({ method: 'GET', url, headers: headers(tenant, 'ADMIN') });
    expect(tenantWide.statusCode).toBe(200);
    const wideBody = tenantWide.json() as { total: number; sample: Array<{ name: string }> };
    expect(wideBody.total).toBe(2);
    expect(wideBody.sample.map(row => row.name)).toEqual(expect.arrayContaining(['Alpha Branchpatient', 'Bravo Branchpatient']));
  });

  it('refuses a suppression or consent reference that belongs to another tenant', async () => {
    const [tenantA, tenantB] = [await makeTenant(), await makeTenant()];
    const foreign = await db.patient.create({ data: {
      tenantId: tenantB.id, branchId: tenantB.branchA, firstName: 'Foreign', lastName: 'Patient',
    } });
    for (const route of foreignIdentityWrites) {
      const payload = { ...route.payload, patientId: foreign.id };
      const denied = await inject(tenantA, 'AUDITOR', { ...route, payload });
      expect(denied.statusCode, route.url).toBe(403);
      expect(denied.json(), route.url).toMatchObject({ error: 'insufficient_permission', permission: route.permission });

      const authorized = await inject(tenantA, 'OWNER', { ...route, payload });
      expect(authorized.statusCode, route.url).toBeGreaterThanOrEqual(400);
      expect(authorized.statusCode, route.url).toBeLessThan(500);
    }
    expect(await db.campaignSuppression.count({ where: { patientId: foreign.id } })).toBe(0);
    expect(await db.consentEvent.count({ where: { patientId: foreign.id } })).toBe(0);
  });
});
