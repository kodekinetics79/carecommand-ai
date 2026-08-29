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
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  permission: string;
  payload?: Record<string, unknown>;
};

let app: FastifyInstance;
const tenantIds: string[] = [];
const fixedId = '00000000-0000-4000-8000-000000000001';

async function makeTenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `endpoint-auth-${id.slice(0, 6)}`, slug: `endpoint-auth-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'campaign_automation', enabled: true, source: 'test' } });
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId: id, name: 'Branch A', location: 'A' } }),
    db.branch.create({ data: { tenantId: id, name: 'Branch B', location: 'B' } }),
  ]);
  const users = {} as Record<Role, string>;
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR'] as const) {
    const user = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role}-${id.slice(0, 8)}@endpoint-auth.test`, displayName: role },
    });
    users[role] = user.id;
  }
  return { id, branchA: branchA.id, branchB: branchB.id, users };
}

function token(tenant: TenantFixture, role: Role) {
  return app.jwt.sign({ userId: tenant.users[role], tenantId: tenant.id, role, type: 'access' });
}

function headers(tenant: TenantFixture, role: Role) {
  return { authorization: `Bearer ${token(tenant, role)}` };
}

function inject(tenant: TenantFixture, role: Role, route: GuardedRoute) {
  return app.inject({
    method: route.method,
    url: route.url,
    headers: headers(tenant, role),
    ...(route.payload === undefined ? {} : { payload: route.payload }),
  });
}

const guardedRoutes: GuardedRoute[] = [
  { method: 'GET', url: '/v1/telehealth/sessions', permission: 'appointment:read' },
  { method: 'GET', url: '/v1/competitors/radar', permission: 'operations:read' },
  { method: 'GET', url: '/v1/reputation', permission: 'crm:read' },
  { method: 'GET', url: '/v1/revenue-leaks', permission: 'revenue:read' },
  { method: 'PATCH', url: `/v1/revenue-leaks/${fixedId}`, permission: 'revenue:write', payload: { status: 'reviewed' } },
  { method: 'GET', url: '/v1/opportunities', permission: 'revenue:read' },
  { method: 'PATCH', url: `/v1/opportunities/${fixedId}`, permission: 'revenue:write', payload: { status: 'reviewed' } },
  { method: 'GET', url: '/v1/leads', permission: 'crm:read' },
  { method: 'POST', url: '/v1/leads', permission: 'crm:write', payload: {} },
  { method: 'PATCH', url: `/v1/leads/${fixedId}`, permission: 'crm:write', payload: { stage: 'qualified' } },
  { method: 'GET', url: '/v1/campaigns', permission: 'campaign:read' },
  { method: 'POST', url: '/v1/campaigns', permission: 'campaign:manage', payload: {} },
  { method: 'PATCH', url: `/v1/campaigns/${fixedId}`, permission: 'campaign:manage', payload: { status: 'PAUSED' } },
  { method: 'GET', url: '/v1/reviews', permission: 'crm:read' },
  { method: 'POST', url: '/v1/reviews', permission: 'crm:write', payload: {} },
  { method: 'PATCH', url: `/v1/reviews/${fixedId}/respond`, permission: 'crm:write', payload: { response: 'Reviewed response.' } },
  { method: 'GET', url: '/v1/inventory', permission: 'inventory:read' },
  { method: 'POST', url: '/v1/inventory', permission: 'inventory:manage', payload: {} },
  { method: 'PATCH', url: `/v1/inventory/${fixedId}`, permission: 'inventory:write', payload: { restockBy: 1 } },
  { method: 'GET', url: '/v1/partner-reports', permission: 'partner-report:read' },
  { method: 'POST', url: '/v1/partner-reports', permission: 'partner-report:write', payload: {} },
  { method: 'PATCH', url: `/v1/partner-reports/${fixedId}/review`, permission: 'partner-report:review', payload: { status: 'doctor-reviewed' } },
  { method: 'GET', url: '/v1/integrations', permission: 'integrations:read' },
  { method: 'PATCH', url: `/v1/integrations/${fixedId}`, permission: 'integrations:manage', payload: { status: 'DISCONNECTED' } },
  { method: 'GET', url: '/v1/integrations/status', permission: 'integrations:read' },
  { method: 'POST', url: '/v1/integrations/retell/test', permission: 'integrations:manage' },
  { method: 'GET', url: '/v1/tasks', permission: 'staff:read' },
  { method: 'POST', url: '/v1/tasks', permission: 'staff:write', payload: {} },
  { method: 'GET', url: '/v1/staff/assignees', permission: 'staff:write' },
  { method: 'PATCH', url: `/v1/staff/tasks/${fixedId}/assignment`, permission: 'staff:task-status', payload: { assignedToId: null } },
  { method: 'POST', url: `/v1/opportunities/${fixedId}/handoff`, permission: 'revenue:write', payload: { verb: 'send_front_desk' } },
  { method: 'GET', url: '/v1/revenue-snapshots', permission: 'revenue:read' },
  { method: 'GET', url: '/v1/conversations', permission: 'crm:read' },
  { method: 'POST', url: `/v1/conversations/${fixedId}/reply`, permission: 'crm:write', payload: { message: 'Escalate', status: 'escalated' } },
  { method: 'GET', url: '/v1/briefing', permission: 'operations:read' },
  { method: 'GET', url: '/v1/signals', permission: 'operations:read' },
  { method: 'GET', url: '/v1/recommendations', permission: 'operations:read' },
  { method: 'PATCH', url: `/v1/recommendations/${fixedId}`, permission: 'operations:write', payload: { status: 'dismissed' } },
  { method: 'PATCH', url: `/v1/signals/${fixedId}`, permission: 'operations:write', payload: { status: 'dismissed' } },
];

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('cross-module endpoint authorization', () => {
  it('guards every Telehealth and Operations route before resource access or input handling', async () => {
    const tenant = await makeTenant();
    for (const route of guardedRoutes) {
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

  it.each([
    ['/v1/telehealth/sessions', ['OWNER', 'ADMIN', 'MANAGER', 'PROVIDER', 'FRONT_DESK', 'ANALYST'], ['BILLING', 'COMPLIANCE_OFFICER', 'AUDITOR'], 'appointment:read'],
    ['/v1/briefing', ['OWNER', 'ADMIN', 'MANAGER', 'ANALYST'], ['BILLING', 'PROVIDER', 'FRONT_DESK', 'COMPLIANCE_OFFICER', 'AUDITOR'], 'operations:read'],
    ['/v1/leads', ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'ANALYST'], ['BILLING', 'PROVIDER', 'COMPLIANCE_OFFICER', 'AUDITOR'], 'crm:read'],
    ['/v1/revenue-leaks', ['OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'ANALYST'], ['PROVIDER', 'FRONT_DESK', 'COMPLIANCE_OFFICER', 'AUDITOR'], 'revenue:read'],
    ['/v1/inventory', ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'ANALYST'], ['BILLING', 'PROVIDER', 'COMPLIANCE_OFFICER', 'AUDITOR'], 'inventory:read'],
    ['/v1/integrations', ['OWNER', 'ADMIN', 'MANAGER'], ['BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR'], 'integrations:read'],
    ['/v1/partner-reports', ['OWNER', 'ADMIN', 'MANAGER', 'PROVIDER'], ['BILLING', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR'], 'partner-report:read'],
  ] as Array<[string, Role[], Role[], string]>)('enforces the default role matrix for %s', async (url, allowed, denied, permission) => {
    const tenant = await makeTenant();
    for (const role of allowed) expect((await app.inject({ method: 'GET', url, headers: headers(tenant, role) })).statusCode, role).toBe(200);
    for (const role of denied) {
      const response = await app.inject({ method: 'GET', url, headers: headers(tenant, role) });
      expect(response.statusCode, role).toBe(403);
      expect(response.json(), role).toMatchObject({ permission });
    }
  });

  it.each([
    [{ method: 'PATCH', url: `/v1/signals/${fixedId}`, payload: { status: 'dismissed' }, permission: 'operations:write' }, ['OWNER', 'ADMIN', 'MANAGER'], ['BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'POST', url: '/v1/leads', payload: {}, permission: 'crm:write' }, ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK'], ['BILLING', 'PROVIDER', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'POST', url: '/v1/campaigns', payload: {}, permission: 'campaign:manage' }, ['OWNER', 'ADMIN', 'MANAGER'], ['BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'PATCH', url: `/v1/revenue-leaks/${fixedId}`, payload: { status: 'reviewed' }, permission: 'revenue:write' }, ['OWNER', 'ADMIN', 'MANAGER', 'BILLING'], ['PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'PATCH', url: `/v1/inventory/${fixedId}`, payload: { restockBy: 1 }, permission: 'inventory:write' }, ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK'], ['BILLING', 'PROVIDER', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'POST', url: '/v1/inventory', payload: {}, permission: 'inventory:manage' }, ['OWNER', 'ADMIN', 'MANAGER'], ['BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'POST', url: '/v1/partner-reports', payload: {}, permission: 'partner-report:write' }, ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK'], ['BILLING', 'PROVIDER', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'PATCH', url: `/v1/partner-reports/${fixedId}/review`, payload: { status: 'doctor-reviewed' }, permission: 'partner-report:review' }, ['OWNER', 'ADMIN', 'PROVIDER'], ['MANAGER', 'BILLING', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'PATCH', url: `/v1/integrations/${fixedId}`, payload: { status: 'DISCONNECTED' }, permission: 'integrations:manage' }, ['OWNER', 'ADMIN', 'MANAGER'], ['BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'POST', url: '/v1/tasks', payload: {}, permission: 'staff:write' }, ['OWNER', 'ADMIN', 'MANAGER'], ['BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    // Only a role that may hand work to another person gets the roster.
    [{ method: 'GET', url: '/v1/staff/assignees', permission: 'staff:write' }, ['OWNER', 'ADMIN', 'MANAGER'], ['BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    // FRONT_DESK reaches the assignment route (it may take a task itself); the
    // route then refuses assigning to somebody else. See the ownership test below.
    [{ method: 'PATCH', url: `/v1/staff/tasks/${fixedId}/assignment`, payload: { assignedToId: null }, permission: 'staff:task-status' }, ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK'], ['BILLING', 'PROVIDER', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
    [{ method: 'POST', url: `/v1/opportunities/${fixedId}/handoff`, payload: { verb: 'send_front_desk' }, permission: 'revenue:write' }, ['OWNER', 'ADMIN', 'MANAGER', 'BILLING'], ['PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']],
  ] as Array<[GuardedRoute, Role[], Role[]]>)('preserves the intentional before→after mutation matrix for $0.permission', async (route, allowed, denied) => {
    const tenant = await makeTenant();
    for (const role of allowed) expect((await inject(tenant, role, route)).statusCode, role).not.toBe(403);
    for (const role of denied) {
      const response = await inject(tenant, role, route);
      expect(response.statusCode, role).toBe(403);
      expect(response.json(), role).toMatchObject({ permission: route.permission });
    }
  });

  it('reserves doctor review for OWNER, ADMIN, and PROVIDER by default and denies FRONT_DESK and MANAGER', async () => {
    const tenant = await makeTenant();
    const report = await db.partnerReport.create({ data: {
      tenantId: tenant.id, branchId: tenant.branchA, reportType: 'Lab', partner: 'Reference lab', urgency: 'routine', status: 'result-received', summary: 'Clinical summary',
    } });
    for (const role of ['OWNER', 'ADMIN', 'PROVIDER'] as const) {
      const response = await app.inject({
        method: 'PATCH', url: `/v1/partner-reports/${report.id}/review`, headers: headers(tenant, role),
        payload: { status: 'doctor-reviewed', summary: `Reviewed by ${role}` },
      });
      expect(response.statusCode, role).toBe(200);
    }
    for (const role of ['FRONT_DESK', 'MANAGER'] as const) {
      const response = await app.inject({
        method: 'PATCH', url: `/v1/partner-reports/${report.id}/review`, headers: headers(tenant, role),
        payload: { status: 'doctor-reviewed' },
      });
      expect(response.statusCode, role).toBe(403);
      expect(response.json(), role).toMatchObject({ permission: 'partner-report:review' });
    }
  });

  it('keeps new permission overrides tenant-bound', async () => {
    const [tenantA, tenantB] = [await makeTenant(), await makeTenant()];
    await db.roleDefinition.create({ data: {
      tenantId: tenantA.id, name: 'Front Desk', description: 'Revenue reader', permissions: ['revenue:read'],
    } });
    expect((await app.inject({ method: 'GET', url: '/v1/revenue-leaks', headers: headers(tenantA, 'FRONT_DESK') })).statusCode).toBe(200);
    const denied = await app.inject({ method: 'GET', url: '/v1/revenue-leaks', headers: headers(tenantB, 'FRONT_DESK') });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ permission: 'revenue:read' });

    await db.roleDefinition.update({
      where: { tenantId_name: { tenantId: tenantA.id, name: 'Front Desk' } },
      data: { permissions: [] },
    });
    const explicitEmpty = await app.inject({ method: 'GET', url: '/v1/leads', headers: headers(tenantA, 'FRONT_DESK') });
    expect(explicitEmpty.statusCode).toBe(403);
    expect(explicitEmpty.json()).toMatchObject({ permission: 'crm:read' });
  });

  it('does not disclose or mutate another tenant’s telehealth, clinical-report, or integration records', async () => {
    const [tenantA, tenantB] = [await makeTenant(), await makeTenant()];
    const [patientA, patientB] = await Promise.all([
      db.patient.create({ data: { tenantId: tenantA.id, branchId: tenantA.branchA, firstName: 'TenantA', lastName: 'Patient' } }),
      db.patient.create({ data: { tenantId: tenantB.id, branchId: tenantB.branchA, firstName: 'TenantB', lastName: 'Patient' } }),
    ]);
    const now = Date.now();
    const [appointmentA, appointmentB] = await Promise.all([
      db.appointment.create({ data: { tenantId: tenantA.id, branchId: tenantA.branchA, patientId: patientA.id, service: 'A visit', startsAt: new Date(now + 3600000), endsAt: new Date(now + 5400000), channel: 'VIDEO' } }),
      db.appointment.create({ data: { tenantId: tenantB.id, branchId: tenantB.branchA, patientId: patientB.id, service: 'B visit', startsAt: new Date(now + 7200000), endsAt: new Date(now + 9000000), channel: 'VIDEO' } }),
    ]);
    const reportA = await db.partnerReport.create({ data: { tenantId: tenantA.id, branchId: tenantA.branchA, reportType: 'A report', partner: 'A lab', urgency: 'routine', status: 'result-received' } });
    const reportB = await db.partnerReport.create({ data: { tenantId: tenantB.id, branchId: tenantB.branchA, reportType: 'B report', partner: 'B lab', urgency: 'routine', status: 'result-received' } });
    const integrationA = await db.integration.create({ data: { tenantId: tenantA.id, key: 'tenant-a', name: 'Tenant A Integration', category: 'Test' } });
    const integrationB = await db.integration.create({ data: { tenantId: tenantB.id, key: 'tenant-b', name: 'Tenant B Integration', category: 'Test' } });

    const sessions = (await app.inject({ method: 'GET', url: '/v1/telehealth/sessions', headers: headers(tenantB, 'OWNER') })).json() as Array<{ id: string }>;
    expect(sessions.map(row => row.id)).toContain(appointmentB.id);
    expect(sessions.map(row => row.id)).not.toContain(appointmentA.id);
    const reports = (await app.inject({ method: 'GET', url: '/v1/partner-reports', headers: headers(tenantB, 'OWNER') })).json() as Array<{ id: string }>;
    expect(reports.map(row => row.id)).toContain(reportB.id);
    expect(reports.map(row => row.id)).not.toContain(reportA.id);
    const integrations = (await app.inject({ method: 'GET', url: '/v1/integrations', headers: headers(tenantB, 'OWNER') })).json() as Array<{ id: string }>;
    expect(integrations.map(row => row.id)).toContain(integrationB.id);
    expect(integrations.map(row => row.id)).not.toContain(integrationA.id);

    const crossTenantReview = await app.inject({
      method: 'PATCH', url: `/v1/partner-reports/${reportA.id}/review`, headers: headers(tenantB, 'OWNER'), payload: { status: 'doctor-reviewed' },
    });
    expect(crossTenantReview.statusCode).toBe(404);
    expect((await db.partnerReport.findUniqueOrThrow({ where: { id: reportA.id } })).status).toBe('result-received');

    const crossTenantCreates: Array<{ url: string; payload: Record<string, unknown> }> = [
      { url: '/v1/leads', payload: { patientId: patientA.id, name: 'Foreign patient lead', channel: 'SMS', service: 'Consultation', stage: 'new', source: 'test' } },
      { url: '/v1/reviews', payload: { patientId: patientA.id, branchId: tenantA.branchA, rating: 5, text: 'Foreign review', platform: 'test', sentiment: 'positive' } },
      { url: '/v1/inventory', payload: { branchId: tenantA.branchA, name: 'Foreign inventory', category: 'supply', currentStock: 1, unit: 'box', reorderLevel: 1, unitCost: 1, usagePerWeek: 1, supplier: 'supplier' } },
      { url: '/v1/partner-reports', payload: { branchId: tenantA.branchA, patientId: patientA.id, reportType: 'Foreign report', partner: 'Foreign lab', urgency: 'routine', status: 'ordered' } },
      { url: '/v1/tasks', payload: { branchId: tenantB.branchA, assignedToId: tenantA.users.MANAGER, title: 'Foreign assignee', priority: 'high' } },
    ];
    for (const probe of crossTenantCreates) {
      const response = await app.inject({ method: 'POST', url: probe.url, headers: headers(tenantB, 'OWNER'), payload: probe.payload });
      expect(response.statusCode, probe.url).toBe(400);
      expect(response.json().message, probe.url).toMatch(/authenticated tenant/i);
    }
  });

  it('keeps branch-bound reads and mutations inside the authenticated branch even when another branch is requested', async () => {
    const tenant = await makeTenant();
    await db.user.update({ where: { id: tenant.users.OWNER }, data: { branchId: tenant.branchA } });
    const [patientA, patientB] = await Promise.all([
      db.patient.create({ data: { tenantId: tenant.id, branchId: tenant.branchA, firstName: 'BranchA', lastName: 'Patient' } }),
      db.patient.create({ data: { tenantId: tenant.id, branchId: tenant.branchB, firstName: 'BranchB', lastName: 'Patient' } }),
    ]);
    const now = Date.now();
    const [appointmentA, appointmentB] = await Promise.all([
      db.appointment.create({ data: { tenantId: tenant.id, branchId: tenant.branchA, patientId: patientA.id, service: 'Branch A video', startsAt: new Date(now + 3600000), endsAt: new Date(now + 5400000), channel: 'VIDEO' } }),
      db.appointment.create({ data: { tenantId: tenant.id, branchId: tenant.branchB, patientId: patientB.id, service: 'Branch B video', startsAt: new Date(now + 7200000), endsAt: new Date(now + 9000000), channel: 'VIDEO' } }),
    ]);
    const [reviewA, reviewB] = await Promise.all([
      db.review.create({ data: { tenantId: tenant.id, branchId: tenant.branchA, rating: 5, text: 'A review', platform: 'test', sentiment: 'positive' } }),
      db.review.create({ data: { tenantId: tenant.id, branchId: tenant.branchB, rating: 1, text: 'B review', platform: 'test', sentiment: 'negative' } }),
    ]);
    const [inventoryA, inventoryB] = await Promise.all([
      db.inventoryItem.create({ data: { tenantId: tenant.id, branchId: tenant.branchA, name: 'A item', category: 'supply', currentStock: 1, unit: 'box', reorderLevel: 1, supplier: 'A supplier' } }),
      db.inventoryItem.create({ data: { tenantId: tenant.id, branchId: tenant.branchB, name: 'B item', category: 'supply', currentStock: 1, unit: 'box', reorderLevel: 1, supplier: 'B supplier' } }),
    ]);
    const [reportA, reportB] = await Promise.all([
      db.partnerReport.create({ data: { tenantId: tenant.id, branchId: tenant.branchA, reportType: 'A report', partner: 'A lab', urgency: 'routine', status: 'result-received' } }),
      db.partnerReport.create({ data: { tenantId: tenant.id, branchId: tenant.branchB, reportType: 'B report', partner: 'B lab', urgency: 'routine', status: 'result-received' } }),
    ]);
    const [conversationA, conversationB] = await Promise.all([
      db.conversation.create({ data: { tenantId: tenant.id, branchId: tenant.branchA, channel: 'SMS', status: 'pending', latestMessage: 'A message' } }),
      db.conversation.create({ data: { tenantId: tenant.id, branchId: tenant.branchB, channel: 'SMS', status: 'pending', latestMessage: 'B message' } }),
    ]);
    const [snapshotA, snapshotB] = await Promise.all([
      db.revenueSnapshot.create({ data: { tenantId: tenant.id, branchId: tenant.branchA, period: new Date('2026-01-01T00:00:00Z'), revenue: 1 } }),
      db.revenueSnapshot.create({ data: { tenantId: tenant.id, branchId: tenant.branchB, period: new Date('2026-01-01T00:00:00Z'), revenue: 2 } }),
    ]);

    const reads: Array<[string, string, string]> = [
      [`/v1/telehealth/sessions?branchId=${tenant.branchB}`, appointmentA.id, appointmentB.id],
      [`/v1/reviews?branchId=${tenant.branchB}`, reviewA.id, reviewB.id],
      [`/v1/inventory?branchId=${tenant.branchB}`, inventoryA.id, inventoryB.id],
      [`/v1/partner-reports?branchId=${tenant.branchB}`, reportA.id, reportB.id],
      [`/v1/conversations?branchId=${tenant.branchB}`, conversationA.id, conversationB.id],
      [`/v1/revenue-snapshots?branchId=${tenant.branchB}`, snapshotA.id, snapshotB.id],
    ];
    for (const [url, ownId, otherId] of reads) {
      const response = await app.inject({ method: 'GET', url, headers: headers(tenant, 'OWNER') });
      expect(response.statusCode, url).toBe(200);
      const ids = (response.json() as Array<{ id: string }>).map(row => row.id);
      expect(ids, url).toContain(ownId);
      expect(ids, url).not.toContain(otherId);
    }

    const mutations: GuardedRoute[] = [
      { method: 'PATCH', url: `/v1/reviews/${reviewB.id}/respond`, permission: 'crm:write', payload: { response: 'Cross branch' } },
      { method: 'PATCH', url: `/v1/inventory/${inventoryB.id}`, permission: 'inventory:write', payload: { restockBy: 1 } },
      { method: 'PATCH', url: `/v1/partner-reports/${reportB.id}/review`, permission: 'partner-report:review', payload: { status: 'doctor-reviewed' } },
      { method: 'POST', url: `/v1/conversations/${conversationB.id}/reply`, permission: 'crm:write', payload: { message: 'Cross branch', status: 'escalated' } },
    ];
    for (const route of mutations) {
      const response = await inject(tenant, 'OWNER', route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json().message, `${route.method} ${route.url}`).toMatch(/another branch/i);
    }
  });
});
