import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';

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
const { effectivePlatformToken } = await import('../lib/platform');
const { provisionTenant, ProvisionError } = await import('../lib/tenantProvisioning');
const { platformProvisionTenant } = await import('../lib/platformTenantProvisioning');

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
  it('retires legacy tenant onboarding without touching tenant data', async () => {
    const slug = `retired-onboarding-${randomUUID().slice(0, 8)}`;
    const payload = {
      clinicName: 'Retired Onboarding', clinicSlug: slug, ownerName: 'Legacy Operator',
      ownerEmail: `${slug}@example.invalid`, ownerPassword: 'Legacy-Secure-9!', defaultBranchName: 'Main',
    };
    const unauthorized = await app.inject({ method: 'POST', url: '/v1/onboarding/tenant', payload });
    expect(unauthorized.statusCode).toBe(401);
    const token = effectivePlatformToken();
    expect(token).toBeTruthy();
    const retired = await app.inject({ method: 'POST', url: '/v1/onboarding/tenant', headers: { 'x-platform-token': token! }, payload });
    expect(retired.statusCode).toBe(410);
    expect(retired.json()).toMatchObject({
      error: 'legacy_onboarding_retired',
      successor: { method: 'POST', path: '/v1/platform/tenants', authentication: 'PlatformUser session' },
    });
    expect(await db.tenant.count({ where: { slug } })).toBe(0);
  });

  it('reports the configured refresh-cookie SameSite policy truthfully', async () => {
    const t = await fixture();
    const response = await app.inject({ method: 'GET', url: '/v1/security/posture', headers: bearer(t.tenantId, t.owner.id) });
    expect(response.statusCode).toBe(200);
    expect(response.json().refreshCookie.sameSite).toBe(env.COOKIE_SAMESITE);
  });

  it('serializes concurrent control-plane user creation by canonical tenant email', async () => {
    const t = await fixture();
    const email = `Race.User-${randomUUID().slice(0, 8)}@Example.Invalid`;
    const payload = {
      email,
      name: 'Race User',
      password: 'Race-User-Secure-9!',
      role: 'FRONT_DESK',
      branchIds: [t.branchA.id],
      primaryBranchId: t.branchA.id,
    };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/control-plane/users', headers: bearer(t.tenantId, t.owner.id), payload }),
      app.inject({ method: 'POST', url: '/v1/control-plane/users', headers: bearer(t.tenantId, t.owner.id), payload: { ...payload, email: email.toLowerCase() } }),
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const users = await db.user.findMany({ where: { tenantId: t.tenantId, email: email.toLowerCase() }, select: { id: true } });
    expect(users).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: 'controlPlane.user.created', resourceId: users[0].id } })).toBe(1);
  });

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

  it('lists only the assigned clinic for a branch-scoped user', async () => {
    const t = await fixture();
    const token = app.jwt.sign({
      tenantId: t.tenantId,
      userId: t.target.id,
      role: 'FRONT_DESK',
      branchId: t.branchA.id,
      type: 'access',
      sessionIssuedAtMs: Date.now(),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/branches',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.51.100.210' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].id).toBe(t.branchA.id);
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

  it('serializes clinic deactivation against access grants so no active user can retain an inactive clinic', async () => {
    const t = await fixture();
    const headers = bearer(t.tenantId, t.owner.id);
    const responses = await Promise.all([
      app.inject({ method: 'PATCH', url: `/v1/control-plane/clinics/${t.branchB.id}/status`, headers, payload: { active: false } }),
      app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${t.target.id}/clinic-access`, headers, payload: { branchIds: [t.branchB.id], primaryBranchId: t.branchB.id } }),
    ]);
    expect(responses.filter(response => response.statusCode === 200)).toHaveLength(1);
    expect(responses.some(response => response.statusCode === 400 || response.statusCode === 409)).toBe(true);
    const branch = await db.branch.findUniqueOrThrow({ where: { id: t.branchB.id } });
    const hasAccess = await db.userClinicAccess.count({ where: { tenantId: t.tenantId, userId: t.target.id, branchId: t.branchB.id } });
    expect(branch.active || hasAccess === 0).toBe(true);
  });

  it('blocks sequential and concurrent user activation when retained clinic access is inactive', async () => {
    const t = await fixture();
    const headers = bearer(t.tenantId, t.owner.id);
    await db.user.update({ where: { id: t.target.id }, data: { active: false, branchId: t.branchB.id } });
    await db.userClinicAccess.deleteMany({ where: { tenantId: t.tenantId, userId: t.target.id } });
    await db.userClinicAccess.create({ data: { tenantId: t.tenantId, userId: t.target.id, branchId: t.branchB.id, isPrimary: true } });
    await db.branch.update({ where: { id: t.branchB.id }, data: { active: false } });
    const sequential = await app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${t.target.id}/status`, headers, payload: { active: true } });
    expect(sequential.statusCode).toBe(409);
    expect((await db.user.findUniqueOrThrow({ where: { id: t.target.id } })).active).toBe(false);

    await db.branch.update({ where: { id: t.branchB.id }, data: { active: true } });
    const raced = await Promise.all([
      app.inject({ method: 'PATCH', url: `/v1/control-plane/clinics/${t.branchB.id}/status`, headers, payload: { active: false } }),
      app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${t.target.id}/status`, headers, payload: { active: true } }),
    ]);
    const branch = await db.branch.findUniqueOrThrow({ where: { id: t.branchB.id } });
    const user = await db.user.findUniqueOrThrow({ where: { id: t.target.id } });
    expect(!(user.active && !branch.active)).toBe(true);
    expect(raced.some(response => response.statusCode === 200)).toBe(true);
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

    const byPhone = await app.inject({ method: 'GET', url: '/v1/patients?search=212%20555%200100&limit=20', headers });
    const byRef = await app.inject({ method: 'GET', url: '/v1/patients?search=MRN-9001&limit=20', headers });
    expect(byPhone.json().data.map((row: { id: string }) => row.id)).toContain(created.id);
    expect(byRef.json().data.map((row: { id: string }) => row.id)).toContain(created.id);
  });

  it('locks canonical identity keys across payload variants and phone formatting', async () => {
    const t = await fixture();
    const headers = bearer(t.tenantId, t.owner.id);
    const base = { branchId: t.branchA.id, externalRef: 'MRN-VARIANT', firstName: 'Ana', lastName: 'Rivera' };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/patients', headers, payload: { ...base, email: 'ana@example.com', phone: '+1 (646) 555-0101' } }),
      app.inject({ method: 'POST', url: '/v1/patients', headers, payload: { ...base, dateOfBirth: '1990-05-02', phone: '16465550101' } }),
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(await db.patient.count({ where: { tenantId: t.tenantId, externalRef: 'MRN-VARIANT' } })).toBe(1);
    const legacy = await db.patient.create({ data: { tenantId: t.tenantId, branchId: t.branchA.id, externalRef: 'LEGACY-PHONE', firstName: 'Legacy', lastName: 'Phone', phone: '+1 (646) 555-0101' } });
    const legacySearch = await app.inject({ method: 'GET', url: '/v1/patients?search=16465550101', headers });
    const legacyLocalSearch = await app.inject({ method: 'GET', url: '/v1/patients?search=646%20555%200101', headers });
    expect(legacySearch.json().data.map((row: { id: string }) => row.id)).toContain(legacy.id);
    expect(legacyLocalSearch.json().data.map((row: { id: string }) => row.id)).toContain(legacy.id);
  });

  it('reserves archived external references, rejects inactive branches, and returns PATCH collisions as 409', async () => {
    const t = await fixture();
    const headers = bearer(t.tenantId, t.owner.id);
    const archived = await db.patient.create({ data: { tenantId: t.tenantId, branchId: t.branchA.id, externalRef: 'ARCHIVED-1', firstName: 'Old', lastName: 'Record', deletedAt: new Date() } });
    const activeA = await db.patient.create({ data: { tenantId: t.tenantId, branchId: t.branchA.id, externalRef: 'ACTIVE-A', firstName: 'Ava', lastName: 'One', email: 'ava.one@example.com' } });
    const activeB = await db.patient.create({ data: { tenantId: t.tenantId, branchId: t.branchA.id, externalRef: 'ACTIVE-B', firstName: 'Bea', lastName: 'Two', email: 'bea.two@example.com' } });
    await db.branch.update({ where: { id: t.branchB.id }, data: { active: false } });
    await db.user.update({ where: { id: t.owner.id }, data: { branchId: null } });

    const archivedReuse = await app.inject({ method: 'POST', url: '/v1/patients', headers, payload: { branchId: t.branchA.id, externalRef: archived.externalRef, firstName: 'New', lastName: 'Record' } });
    const inactiveBranch = await app.inject({ method: 'POST', url: '/v1/patients', headers, payload: { branchId: t.branchB.id, externalRef: 'INACTIVE-BRANCH', firstName: 'Ina', lastName: 'Ctive' } });
    const collision = await app.inject({ method: 'PATCH', url: `/v1/patients/${activeB.id}`, headers, payload: { externalRef: activeA.externalRef } });
    expect([archivedReuse.statusCode, inactiveBranch.statusCode, collision.statusCode]).toEqual([409, 400, 409]);
    expect((await db.patient.findUniqueOrThrow({ where: { id: activeB.id } })).externalRef).toBe('ACTIVE-B');
  });

  it('derives tenant summary from full appointment and latest consent facts without cross-tenant leakage', async () => {
    const t = await fixture();
    const other = await fixture();
    const patient = await db.patient.create({ data: { tenantId: t.tenantId, branchId: t.branchA.id, firstName: 'Summary', lastName: 'Patient', lifecycleStage: 'AT_RISK', churnRisk: 75, lifetimeValue: 5000, outstandingBalance: 125 } });
    await db.patient.create({ data: { tenantId: t.tenantId, branchId: t.branchB.id, firstName: 'Other', lastName: 'Branch' } });
    const otherPatient = await db.patient.create({ data: { tenantId: other.tenantId, branchId: other.branchA.id, firstName: 'Other', lastName: 'Tenant', churnRisk: 99, lifetimeValue: 9000, outstandingBalance: 999 } });
    await db.appointment.createMany({ data: [
      { tenantId: t.tenantId, branchId: t.branchA.id, patientId: patient.id, service: 'One', startsAt: new Date('2026-01-01T10:00:00Z'), endsAt: new Date('2026-01-01T10:30:00Z'), channel: 'EMAIL' },
      { tenantId: t.tenantId, branchId: t.branchA.id, patientId: patient.id, service: 'Two', startsAt: new Date('2026-02-01T10:00:00Z'), endsAt: new Date('2026-02-01T10:30:00Z'), channel: 'EMAIL' },
    ] });
    await db.consentEvent.createMany({ data: [
      { tenantId: t.tenantId, patientId: patient.id, purpose: 'MARKETING', granted: true, source: 'test', occurredAt: new Date('2026-01-01T00:00:00Z') },
      { tenantId: t.tenantId, patientId: patient.id, purpose: 'MARKETING', granted: false, source: 'test', occurredAt: new Date('2026-02-01T00:00:00Z') },
      { tenantId: t.tenantId, patientId: patient.id, purpose: 'SMS', granted: true, source: 'test', occurredAt: new Date('2026-02-01T00:00:00Z') },
      { tenantId: other.tenantId, patientId: otherPatient.id, purpose: 'MARKETING', granted: true, source: 'test' },
    ] });
    await db.user.update({ where: { id: t.owner.id }, data: { branchId: null } });
    const summary = await app.inject({ method: 'GET', url: '/v1/patients/summary', headers: bearer(t.tenantId, t.owner.id) });
    const branchSummary = await app.inject({ method: 'GET', url: '/v1/patients/summary', headers: bearer(t.tenantId, t.target.id) });
    const list = await app.inject({ method: 'GET', url: '/v1/patients?search=Summary', headers: bearer(t.tenantId, t.owner.id) });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ scope: 'tenant', patientCount: 2, highRiskCount: 1, highLifetimeValueCount: 1, outstandingBalance: 125, marketingConsentRate: 0, activeConsentCounts: { MARKETING: 0, SMS: 1 } });
    expect(branchSummary.json()).toMatchObject({ scope: 'assigned_branch', patientCount: 1, highRiskCount: 1, outstandingBalance: 125 });
    expect(list.json().data[0]._count.appointments).toBe(2);
  });
});

describe('tenant provisioning atomicity', () => {
  const provisionInput = (slug: string, email: string, planKey: string) => ({
    clinicName: `Clinic ${slug}`,
    clinicSlug: slug,
    ownerName: 'Provision Owner',
    ownerEmail: email,
    ownerPassword: 'Provision-Secure-9!',
    defaultBranchName: 'Main',
    planKey,
  });

  it('serializes canonical global owner email across distinct tenant slugs and rejects mixed-case legacy collisions', async () => {
    const plan = await db.subscriptionPlan.findFirstOrThrow({ where: { active: true }, select: { key: true } });
    const seed = randomUUID().slice(0, 8);
    const email = `Owner-${seed}@Example.Invalid`;
    const outcomes = await Promise.allSettled([
      provisionTenant(provisionInput(`race-a-${seed}`, email, plan.key), db),
      provisionTenant(provisionInput(`race-b-${seed}`, email.toLowerCase(), plan.key), db),
    ]);
    const success = outcomes.find(outcome => outcome.status === 'fulfilled');
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    if (success?.status === 'fulfilled') tenantIds.push(success.value.tenant.id);
    const loser = outcomes.find(outcome => outcome.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason instanceof ProvisionError && loser.reason.code === 'email_taken').toBe(true);

    const existing = await fixture();
    const mixedSlug = `mixed-${seed}`;
    await expect(provisionTenant(provisionInput(mixedSlug, existing.owner.email.toUpperCase(), plan.key), db)).rejects.toMatchObject({ code: 'email_taken' });
    expect(await db.tenant.findUnique({ where: { slug: mixedSlug } })).toBeNull();
  });

  it('serializes concurrent same-slug provisioning and returns one typed slug conflict without a partial graph', async () => {
    const plan = await db.subscriptionPlan.findFirstOrThrow({ where: { active: true }, select: { key: true } });
    const seed = randomUUID().slice(0, 8);
    const slug = `slug-race-${seed}`;
    const outcomes = await Promise.allSettled([
      provisionTenant(provisionInput(slug.toUpperCase(), `slug-a-${seed}@example.invalid`, plan.key), db),
      provisionTenant(provisionInput(slug, `slug-b-${seed}@example.invalid`, plan.key), db),
    ]);
    const winner = outcomes.find(outcome => outcome.status === 'fulfilled');
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect(outcomes.some(outcome => outcome.status === 'rejected' && outcome.reason instanceof ProvisionError && outcome.reason.code === 'slug_taken')).toBe(true);
    if (winner?.status !== 'fulfilled') throw new Error('Expected one successful provisioning result');
    tenantIds.push(winner.value.tenant.id);
    expect(await db.tenant.count({ where: { slug } })).toBe(1);
    expect(await db.branch.count({ where: { tenantId: winner.value.tenant.id } })).toBe(1);
    expect(await db.user.count({ where: { tenantId: winner.value.tenant.id, role: 'OWNER' } })).toBe(1);
    expect(await db.tenantSubscription.count({ where: { tenantId: winner.value.tenant.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: winner.value.tenant.id, action: { in: ['tenant.created', 'tenant.owner.created'] } } })).toBe(2);
  });

  it('rolls back a mid-provision failure completely and permits a clean retry', async () => {
    const plan = await db.subscriptionPlan.findFirstOrThrow({ where: { active: true }, select: { key: true } });
    const seed = randomUUID().slice(0, 8);
    const slug = `rollback-${seed}`;
    const input = provisionInput(slug, `rollback-${seed}@example.invalid`, plan.key);
    const failingClient = {
      $transaction: (operation: (tx: unknown) => Promise<unknown>) => db.$transaction(async tx => {
        const wrapped = new Proxy(tx as object, {
          get(target, property, receiver) {
            if (property === 'tenantSubscription') {
              const model = Reflect.get(target, property, receiver) as object;
              return new Proxy(model, {
                get(modelTarget, modelProperty, modelReceiver) {
                  if (modelProperty === 'create') return async () => { throw new Error('injected_subscription_failure'); };
                  return Reflect.get(modelTarget, modelProperty, modelReceiver);
                },
              });
            }
            return Reflect.get(target, property, receiver);
          },
        });
        return operation(wrapped);
      }),
    } as unknown as NonNullable<Parameters<typeof provisionTenant>[1]>;
    await expect(provisionTenant(input, failingClient)).rejects.toThrow('injected_subscription_failure');
    expect(await db.tenant.findUnique({ where: { slug } })).toBeNull();
    const retry = await provisionTenant(input, db);
    tenantIds.push(retry.tenant.id);
    expect(await db.user.count({ where: { tenantId: retry.tenant.id, role: 'OWNER' } })).toBe(1);
    expect(await db.branch.count({ where: { tenantId: retry.tenant.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: retry.tenant.id, action: { in: ['tenant.created', 'tenant.owner.created'] } } })).toBe(2);
  });

  it('wraps standalone platform provisioning, baseline, and entitlements in one rollback-safe transaction', async () => {
    let committedTenants = 0;
    let failBaseline = true;
    const lockKeys: string[] = [];
    const fakeRoot = {
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        let draftTenants = committedTenants;
        const tx = {
          $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
            if (typeof values[0] === 'string' && values[0].startsWith('tenant-')) {
              lockKeys.push(values[0]);
              return [];
            }
            draftTenants += 1;
            return [{
              tenant_id: '10000000-0000-4000-8000-000000000001', tenant_name: 'Platform Atomic', tenant_slug: 'platform-atomic',
              owner_id: '10000000-0000-4000-8000-000000000002', owner_email: 'atomic@example.invalid',
              branch_id: '10000000-0000-4000-8000-000000000003', branch_name: 'Main', subscription_status: 'TRIAL', trial_ends_at: new Date('2026-08-30T00:00:00Z'),
            }];
          },
          complianceFramework: { upsert: async () => ({ id: 'framework' }) },
          complianceControl: { upsert: async () => { if (failBaseline) throw new Error('injected_platform_baseline_failure'); return {}; } },
          tenantSecurityPolicy: { upsert: async () => ({}) },
          dataRetentionPolicy: { upsert: async () => ({}) },
          tenantSubscription: { findUnique: async () => ({ status: 'TRIAL', plan: { features: [] }, addons: [] }) },
          tenantFeatureEntitlement: { upsert: async () => ({}) },
        };
        const result = await operation(tx);
        committedTenants = draftTenants;
        return result;
      },
    } as unknown as NonNullable<Parameters<typeof platformProvisionTenant>[1]>;
    const input = {
      clinicName: 'Platform Atomic', clinicSlug: 'platform-atomic', ownerName: 'Atomic Owner', ownerEmail: 'Atomic@Example.Invalid',
      ownerPassword: 'Platform-Atomic-9!', defaultBranchName: 'Main', planKey: 'starter', trialDays: 30,
    };
    await expect(platformProvisionTenant(input, fakeRoot)).rejects.toThrow('injected_platform_baseline_failure');
    expect(committedTenants).toBe(0);
    failBaseline = false;
    const retry = await platformProvisionTenant(input, fakeRoot);
    expect(retry.tenant.slug).toBe('platform-atomic');
    expect(committedTenants).toBe(1);
    expect(lockKeys).toEqual([
      'tenant-owner-email:atomic@example.invalid', 'tenant-slug:platform-atomic',
      'tenant-owner-email:atomic@example.invalid', 'tenant-slug:platform-atomic',
    ]);
  });
});
