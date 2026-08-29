import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// The configuration spine as an API: does a fresh tenant resolve to today's
// constants, can a manager tune an operational threshold, is a manager stopped
// from restating what a patient is worth, and is every write audited.
//
// Tenants are created per test. The shared dev database accumulates rows, so
// nothing here counts anything global.
// ===========================================================================

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
const { GROWTH_POLICY_DEFAULTS, GROWTH_SEGMENT_DEFAULTS, GROWTH_CHANNEL_COST_DEFAULTS } = await import('../modules/growth/defaults');

type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'FRONT_DESK' | 'ANALYST';
const ROLES: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'ANALYST'];

let app: FastifyInstance;
const tenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `growth-${id.slice(0, 6)}`, slug: `growth-${id.slice(0, 8)}` } });
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const user = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role}-${id.slice(0, 8)}@growth.test`, displayName: role },
    });
    users[role] = user.id;
  }
  return { id, users };
}

type T = Awaited<ReturnType<typeof makeTenant>>;
const headers = (t: T, role: Role) => ({
  authorization: `Bearer ${app.jwt.sign({ userId: t.users[role], tenantId: t.id, role, type: 'access' })}`,
});

const getPolicy = (t: T, role: Role = 'ADMIN') =>
  app.inject({ method: 'GET', url: '/v1/growth/policy', headers: headers(t, role) });
const patchPolicy = (t: T, role: Role, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: '/v1/growth/policy', headers: headers(t, role), payload });

const auditFor = (t: T, action: string) =>
  db.auditEvent.findMany({ where: { tenantId: t.id, action }, orderBy: { occurredAt: 'desc' } });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('growth policy — the seeded configuration reproduces today\'s constants', () => {
  it('resolves a tenant with no stored policy to the code defaults, field for field', async () => {
    const t = await makeTenant();
    const res = await getPolicy(t);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('default');
    for (const [field, value] of Object.entries(GROWTH_POLICY_DEFAULTS)) {
      expect(body[field], `GET /v1/growth/policy returned a different ${field}`).toBe(value);
    }
    // The two thresholds that disagreed with themselves before this increment.
    expect(body.churnRiskHigh).toBe(50);
    expect(body.highValuePatientLtv).toBe(4000);
  });

  it('resolves the six segment definitions and four channel costs', async () => {
    const t = await makeTenant();
    const segments = await app.inject({ method: 'GET', url: '/v1/growth/segments', headers: headers(t, 'ADMIN') });
    expect(segments.statusCode).toBe(200);
    expect(segments.json().segments.map((s: { key: string }) => s.key))
      .toEqual(GROWTH_SEGMENT_DEFAULTS.map(d => d.key));
    expect(segments.json().segments.map((s: { assumedBookingRatePct: number }) => s.assumedBookingRatePct))
      .toEqual([18, 14, 11, 26, 20, 12]);

    const costs = await app.inject({ method: 'GET', url: '/v1/growth/channel-costs', headers: headers(t, 'ADMIN') });
    expect(costs.json().channelCosts).toEqual(
      GROWTH_CHANNEL_COST_DEFAULTS.map(c => ({ ...c, source: 'default' })),
    );
  });
});

describe('growth policy — authorization is by permission, and money is held higher', () => {
  it('lets a MANAGER tune an operational threshold and records the write', async () => {
    const t = await makeTenant();
    const res = await patchPolicy(t, 'MANAGER', { goingColdDays: 21, maxAudienceSize: 750 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ goingColdDays: 21, maxAudienceSize: 750, source: 'tenant' });

    const stored = await db.growthPolicy.findUnique({ where: { tenantId: t.id } });
    expect(stored?.goingColdDays).toBe(21);
    // Untouched fields keep the seeded values.
    expect(stored?.churnRiskHigh).toBe(GROWTH_POLICY_DEFAULTS.churnRiskHigh);

    const events = await auditFor(t, 'growth.policy.updated');
    expect(events).toHaveLength(1);
    expect(events[0].resource).toBe('growthPolicy');
    expect(events[0].actorUserId).toBe(t.users.MANAGER);
    expect(events[0].metadata).toMatchObject({ fields: ['goingColdDays', 'maxAudienceSize'], moneyAffecting: [] });
  });

  it('refuses a MANAGER the money-affecting fields and writes nothing', async () => {
    const t = await makeTenant();
    for (const payload of [{ recoverableLtvFraction: 0.9 }, { highValuePatientLtv: 100 }]) {
      const res = await patchPolicy(t, 'MANAGER', payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'insufficient_permission', permission: 'admin:manage' });
      expect(res.json().fields).toEqual(Object.keys(payload));
    }
    expect(await db.growthPolicy.findUnique({ where: { tenantId: t.id } })).toBeNull();
    expect(await auditFor(t, 'growth.policy.updated')).toHaveLength(0);
    // The refusal is specific to money, not to the manager.
    expect((await patchPolicy(t, 'MANAGER', { goingColdDays: 30 })).statusCode).toBe(200);
  });

  it('rejects a mixed payload outright rather than applying the half a manager may do', async () => {
    const t = await makeTenant();
    const res = await patchPolicy(t, 'MANAGER', { goingColdDays: 45, recoverableLtvFraction: 0.5 });
    expect(res.statusCode).toBe(403);
    expect(await db.growthPolicy.findUnique({ where: { tenantId: t.id } })).toBeNull();
  });

  it('lets an ADMIN set the money-affecting fields and audits them as such', async () => {
    const t = await makeTenant();
    const res = await patchPolicy(t, 'ADMIN', { recoverableLtvFraction: 0.25, highValuePatientLtv: 5500 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recoverableLtvFraction: 0.25, highValuePatientLtv: 5500 });

    const events = await auditFor(t, 'growth.policy.updated');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      moneyAffecting: ['highValuePatientLtv', 'recoverableLtvFraction'],
      changes: { recoverableLtvFraction: 0.25, highValuePatientLtv: 5500 },
    });
  });

  it('closes reads and writes to roles with no settings grant', async () => {
    const t = await makeTenant();
    expect((await getPolicy(t, 'FRONT_DESK')).statusCode).toBe(403);
    const analystWrite = await patchPolicy(t, 'ANALYST', { goingColdDays: 3 });
    expect(analystWrite.statusCode).toBe(403);
    expect(analystWrite.json()).toMatchObject({ error: 'insufficient_permission', permission: 'settings:write' });
    // ANALYST may still read the configuration.
    expect((await getPolicy(t, 'ANALYST')).statusCode).toBe(200);
  });

  it('refuses an incoherent policy instead of storing a band that can never match', async () => {
    const t = await makeTenant();
    expect((await patchPolicy(t, 'ADMIN', { scoreBandMid: 90 })).statusCode).toBe(400);
    expect((await patchPolicy(t, 'ADMIN', { reputationRiskMedium: 95 })).statusCode).toBe(400);
    expect(await db.growthPolicy.findUnique({ where: { tenantId: t.id } })).toBeNull();
  });
});

describe('growth segment definitions — the first write materialises the seeded baseline', () => {
  it('persists all six defaults before applying an edit, so nothing is lost or resurrected', async () => {
    const t = await makeTenant();
    const res = await app.inject({
      method: 'PATCH', url: '/v1/growth/segments/at-risk', headers: headers(t, 'MANAGER'),
      payload: { minChurnRisk: 65, assumedBookingRatePct: 24 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'at-risk', minChurnRisk: 65, assumedBookingRatePct: 24 });

    const rows = await db.growthSegmentDefinition.findMany({ where: { tenantId: t.id }, orderBy: { sortOrder: 'asc' } });
    expect(rows.map(r => r.key)).toEqual(GROWTH_SEGMENT_DEFAULTS.map(d => d.key));

    const listed = await app.inject({ method: 'GET', url: '/v1/growth/segments', headers: headers(t, 'ADMIN') });
    expect(listed.json().segments.every((s: { source: string }) => s.source === 'tenant')).toBe(true);

    const events = await auditFor(t, 'growth.segment.updated');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ key: 'at-risk' });
  });

  it('creates and deletes definitions, and a deleted one stays deleted', async () => {
    const t = await makeTenant();
    const created = await app.inject({
      method: 'POST', url: '/v1/growth/segments', headers: headers(t, 'MANAGER'),
      payload: {
        key: 'lapsed-implant', label: 'Lapsed implant patients', description: 'Implant patients quiet a year',
        minInactiveDays: 365, suggestedChannel: 'Voice', plannedOffer: 'Clinical review call',
        assumedBookingRatePct: 9, sortOrder: 7,
      },
    });
    expect(created.statusCode).toBe(201);
    expect((await auditFor(t, 'growth.segment.created'))).toHaveLength(1);

    const duplicate = await app.inject({
      method: 'POST', url: '/v1/growth/segments', headers: headers(t, 'MANAGER'),
      payload: {
        key: 'lapsed-implant', label: 'Again', description: 'Again',
        suggestedChannel: 'SMS', plannedOffer: 'Again',
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const deleted = await app.inject({ method: 'DELETE', url: '/v1/growth/segments/winback-tagged', headers: headers(t, 'MANAGER') });
    expect(deleted.statusCode).toBe(200);
    expect((await auditFor(t, 'growth.segment.deleted'))).toHaveLength(1);

    const listed = await app.inject({ method: 'GET', url: '/v1/growth/segments', headers: headers(t, 'ADMIN') });
    const keys = listed.json().segments.map((s: { key: string }) => s.key);
    expect(keys).toContain('lapsed-implant');
    expect(keys, 'a deleted definition must not be resurrected from the code defaults').not.toContain('winback-tagged');
  });

  it('changes only the fields the caller sent', async () => {
    // A `.partial()` schema whose fields carry defaults quietly rewrites every
    // key the caller omitted. This is the guard that caught it.
    const t = await makeTenant();
    const res = await app.inject({
      method: 'PATCH', url: '/v1/growth/segments/inactive-30-60', headers: headers(t, 'MANAGER'),
      payload: { assumedBookingRatePct: 22 },
    });
    expect(res.statusCode).toBe(200);
    const row = await db.growthSegmentDefinition.findFirst({ where: { tenantId: t.id, key: 'inactive-30-60' } });
    expect(row).toMatchObject({
      assumedBookingRatePct: 22,
      minInactiveDays: 30, maxInactiveDays: 60, includeNeverVisited: false,
      suggestedChannel: 'SMS', plannedOffer: 'Gentle check-in + booking link',
      active: true, sortOrder: 1,
    });
  });

  it('refuses an empty inactivity window', async () => {
    const t = await makeTenant();
    const res = await app.inject({
      method: 'PATCH', url: '/v1/growth/segments/inactive-30-60', headers: headers(t, 'MANAGER'),
      payload: { minInactiveDays: 90 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('growth channel costs — minor units, an explicit currency, owner-only', () => {
  it('refuses a MANAGER and accepts an ADMIN, storing minor units', async () => {
    const t = await makeTenant();
    const denied = await app.inject({
      method: 'PUT', url: '/v1/growth/channel-costs/Voice', headers: headers(t, 'MANAGER'),
      payload: { unitCostMinor: 900, currency: 'USD' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'insufficient_permission', permission: 'admin:manage' });
    expect(await db.growthChannelCost.count({ where: { tenantId: t.id } })).toBe(0);

    const allowed = await app.inject({
      method: 'PUT', url: '/v1/growth/channel-costs/Voice', headers: headers(t, 'ADMIN'),
      payload: { unitCostMinor: 275, currency: 'GBP' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ channel: 'Voice', unitCostMinor: 275, currency: 'GBP' });

    const events = await auditFor(t, 'growth.channelCost.updated');
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ channel: 'Voice', unitCostMinor: 275, currency: 'GBP' });

    const listed = await app.inject({ method: 'GET', url: '/v1/growth/channel-costs', headers: headers(t, 'ADMIN') });
    const voice = listed.json().channelCosts.find((c: { channel: string }) => c.channel === 'Voice');
    expect(voice).toMatchObject({ unitCostMinor: 275, currency: 'GBP', source: 'tenant' });
  });

  it('rejects a currency that is not an ISO-4217 code', async () => {
    const t = await makeTenant();
    const res = await app.inject({
      method: 'PUT', url: '/v1/growth/channel-costs/SMS', headers: headers(t, 'ADMIN'),
      payload: { unitCostMinor: 100, currency: 'dollars' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('growth configuration — nothing reads it yet', () => {
  it('leaves the Growth module\'s behaviour untouched by a stored policy', async () => {
    // The rewire is a later increment. Until it lands, a tenant that edits its
    // policy must see no change anywhere else, which is what makes this
    // increment safe to ship on its own.
    const t = await makeTenant();
    expect((await patchPolicy(t, 'ADMIN', { churnRiskHigh: 99, hotLeadScore: 5 })).statusCode).toBe(200);
    const summary = await app.inject({ method: 'GET', url: '/v1/patients/summary', headers: headers(t, 'ADMIN') });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toHaveProperty('highRiskCount');
  });
});
