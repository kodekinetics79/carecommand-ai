import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
const { recomputeEntitlements } = await import('../lib/entitlements');
const { resolveRule } = await import('../lib/monitoring');
const { detectMissedReadings } = await import('../lib/connectedCare/safetyDetection');
const { runWithTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `mr-${id.slice(0, 6)}`, slug: `mr-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  // fixtureDb bypasses RLS for setup; the entitlement upsert is refused otherwise.
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'x' } });
  const owner = await db.user.create({
    data: { tenantId: id, email: `owner-${id.slice(0, 8)}@t.test`, displayName: 'Owner', role: 'OWNER', active: true },
  });
  const patient = await db.patient.create({
    data: { tenantId: id, branchId: branch.id, firstName: 'Rules', lastName: 'Patient', lifecycleStage: 'NEW' },
  });
  return { id, branchId: branch.id, ownerId: owner.id, patientId: patient.id };
}

/**
 * resolveRule reads through the RLS-scoped client, so it returns nothing
 * outside a tenant context — the same guard that protects it in production.
 */
function resolveIn(tenantId: string, actorId: string, opts: Parameters<typeof resolveRule>[1]) {
  return runWithTenantContext(tenantId, () => resolveRule(tenantId, opts), { id: actorId, role: 'OWNER' });
}

// The auth plugin derives the effective role from the DB user, not the token.
function auth(tenantId: string, userId: string, role = 'OWNER') {
  return { authorization: `Bearer ${app.jwt.sign({ tenantId, userId, role, type: 'access' })}` };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const tenantId of createdTenantIds) {
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  }
  await app.close();
});

describe('monitoring rules — the write path the module never had', () => {
  it('creates a tenant rule and resolveRule then prefers it over the hardcoded band', async () => {
    const t = await makeTenant();
    const headers = auth(t.id, t.ownerId);

    // Before: no rule exists, so every reading is scored against the built-in
    // default band and the clinic has no way to change that.
    expect(await resolveIn(t.id, t.ownerId, { readingType: 'glucose' })).toBeNull();

    const created = await app.inject({
      method: 'POST', url: '/v1/monitoring/rules', headers,
      payload: { scope: 'organization', readingType: 'glucose', minValue: 80, maxValue: 200, criticalMin: 50, criticalMax: 350, missedAfterHours: 24 },
    });
    expect(created.statusCode).toBe(201);

    const resolved = await resolveIn(t.id, t.ownerId, { readingType: 'glucose' });
    expect(resolved).toMatchObject({ minValue: 80, maxValue: 200, missedAfterHours: 24 });
  });

  it('resolves the most specific rule, and breaks ties deterministically by creation order', async () => {
    const t = await makeTenant();
    const headers = auth(t.id, t.ownerId);

    await app.inject({ method: 'POST', url: '/v1/monitoring/rules', headers, payload: { scope: 'organization', readingType: 'glucose', maxValue: 180 } });
    await app.inject({ method: 'POST', url: '/v1/monitoring/rules', headers, payload: { scope: 'patient', patientId: t.patientId, readingType: 'glucose', maxValue: 250 } });

    // Patient beats organization.
    expect(await resolveIn(t.id, t.ownerId, { readingType: 'glucose', patientId: t.patientId })).toMatchObject({ maxValue: 250 });
    // A different patient still gets the organization default.
    expect(await resolveIn(t.id, t.ownerId, { readingType: 'glucose', patientId: randomUUID() })).toMatchObject({ maxValue: 180 });

    // Two equally specific, equal-priority rules used to resolve by Postgres
    // heap order — the same reading could alert or not depending on physical
    // row placement, and could flip after any UPDATE or VACUUM. The rule
    // written first must win, every time.
    const t2 = await makeTenant();
    const h2 = auth(t2.id, t2.ownerId);
    const first = await app.inject({ method: 'POST', url: '/v1/monitoring/rules', headers: h2, payload: { scope: 'organization', readingType: 'oxygen', minValue: 90 } });
    await app.inject({ method: 'POST', url: '/v1/monitoring/rules', headers: h2, payload: { scope: 'organization', readingType: 'oxygen', minValue: 85 } });
    for (let i = 0; i < 5; i++) {
      expect((await resolveIn(t2.id, t2.ownerId, { readingType: 'oxygen' }))?.id).toBe(first.json().id);
    }
  });

  it('unblocks the missed-reading detector, which could never fire without a rule', async () => {
    const t = await makeTenant();
    const headers = auth(t.id, t.ownerId);
    const device = await db.device.create({ data: { tenantId: t.id, branchId: t.branchId, name: 'Cuff', deviceType: 'vitals_monitor', active: true } });
    await db.patientDeviceEnrollment.create({
      data: {
        tenantId: t.id, patientId: t.patientId, branchId: t.branchId, providerKey: 'withings',
        deviceId: device.id, programType: 'rpm', status: 'active',
        enrolledAt: new Date(Date.now() - 10 * 24 * 60 * 60_000),
      },
    });

    // `missedAfterHours` lives ONLY on MonitoringRule. With no way to create
    // one, the detector skipped every patient and the "Missed Readings" count
    // was structurally zero — the product was not looking.
    const before = await detectMissedReadings(t.id);
    expect(before.checked).toBe(0);
    expect(before.created).toBe(0);

    const created = await app.inject({
      method: 'POST', url: '/v1/monitoring/rules', headers,
      payload: { scope: 'organization', readingType: 'glucose', missedAfterHours: 24 },
    });
    expect(created.statusCode).toBe(201);

    const after = await detectMissedReadings(t.id);
    expect(after.checked).toBe(1);
    expect(after.created).toBe(1);
  });

  it('refuses a band that is inverted or swallows its own critical range', async () => {
    const t = await makeTenant();
    const headers = auth(t.id, t.ownerId);
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/monitoring/rules', headers, payload });

    // A rule whose safe range is inverted never fires the severity it names.
    expect((await post({ readingType: 'glucose', minValue: 200, maxValue: 100 })).statusCode).toBe(400);
    // Critical bounds sitting inside the safe range make "critical" unreachable.
    expect((await post({ readingType: 'glucose', minValue: 70, maxValue: 180, criticalMin: 90 })).statusCode).toBe(400);
    expect((await post({ readingType: 'glucose', minValue: 70, maxValue: 180, criticalMax: 150 })).statusCode).toBe(400);
    // A scoped rule with nothing to scope to would silently never match.
    expect((await post({ scope: 'patient', readingType: 'glucose', maxValue: 200 })).statusCode).toBe(400);
    expect((await post({ scope: 'branch', readingType: 'glucose', maxValue: 200 })).statusCode).toBe(400);
  });

  it('returns the defaults in force so an empty list never reads as "not monitoring"', async () => {
    const t = await makeTenant();
    const listed = await app.inject({ method: 'GET', url: '/v1/monitoring/rules', headers: auth(t.id, t.ownerId) });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { rules: unknown[]; defaults: Record<string, { min: number }> };
    expect(body.rules).toEqual([]);
    expect(body.defaults.glucose.min).toBe(70);
  });

  it('deactivates rather than deletes, so past alerts keep their explanation', async () => {
    const t = await makeTenant();
    const headers = auth(t.id, t.ownerId);
    const created = await app.inject({ method: 'POST', url: '/v1/monitoring/rules', headers, payload: { readingType: 'glucose', maxValue: 200 } });
    const id = created.json().id as string;

    expect((await app.inject({ method: 'DELETE', url: `/v1/monitoring/rules/${id}`, headers })).statusCode).toBe(204);

    const row = await db.monitoringRule.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row?.active).toBe(false);
    // An inactive rule stops resolving.
    expect(await resolveIn(t.id, t.ownerId, { readingType: 'glucose' })).toBeNull();
  });

  it('keeps rules tenant-scoped', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const created = await app.inject({ method: 'POST', url: '/v1/monitoring/rules', headers: auth(a.id, a.ownerId), payload: { readingType: 'glucose', maxValue: 200 } });
    const id = created.json().id as string;

    expect((await app.inject({ method: 'PATCH', url: `/v1/monitoring/rules/${id}`, headers: auth(b.id, b.ownerId), payload: { maxValue: 999 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/monitoring/rules/${id}`, headers: auth(b.id, b.ownerId) })).statusCode).toBe(404);
    expect(await resolveIn(b.id, b.ownerId, { readingType: 'glucose' })).toBeNull();
  });

  it('refuses rule writes from a role that cannot manage the clinic', async () => {
    const t = await makeTenant();
    const analyst = await db.user.create({
      data: { tenantId: t.id, email: `analyst-${randomUUID().slice(0, 8)}@t.test`, displayName: 'Analyst', role: 'ANALYST', active: true },
    });
    // Thresholds decide whether a clinician is alerted. Changing them is a
    // clinical-configuration act, not a reporting one.
    const res = await app.inject({
      method: 'POST', url: '/v1/monitoring/rules',
      headers: auth(t.id, analyst.id, 'ANALYST'),
      payload: { readingType: 'glucose', maxValue: 200 },
    });
    expect(res.statusCode).toBe(403);
  });
});
