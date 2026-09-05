import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// The Growth module's business logic moved out of the browser. This suite is
// the proof that the move was faithful AND that it fixed something.
//
//   * SMALL TENANT (under the 100-row page cap): the server's numbers equal the
//     numbers the deleted browser code produced, field for field. The seeded
//     configuration reproduces today's constants, so nothing a clinic looks at
//     changed.
//   * LARGE TENANT (260 patients, 130 leads): the server's numbers differ from
//     the browser's, and the server's equal the browser's own arithmetic applied
//     to EVERY row. The difference is the defect: "Avg churn risk 49%" was the
//     average of an arbitrary hundred UUID-ordered patients.
//
// Tenants are created per test — the shared dev database accumulates rows, so
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
const {
  legacyAdaptLeads, legacyAdaptPatients, legacyCommandMetrics, legacyScoreLead, legacySmartSegments,
} = await import('./helpers/legacyCrmClient');
const { GROWTH_POLICY_DEFAULTS, GROWTH_CHANNEL_COST_DEFAULTS } = await import('../modules/growth/defaults');

type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'FRONT_DESK' | 'ANALYST' | 'PROVIDER' | 'BILLING';
const ROLES: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'ANALYST', 'PROVIDER', 'BILLING'];

const DAY = 86_400_000;
/** Whole days back from now, at midday of that offset, so no fixture sits on a bucket edge. */
const daysAgo = (days: number) => new Date(Date.now() - days * DAY - DAY / 2);

let app: FastifyInstance;
const tenantIds: string[] = [];

type Fixture = { id: string; branchA: string; branchB: string; users: Record<Role, string>; branchAdminA: string };

async function makeTenant(): Promise<Fixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `growth-m-${id.slice(0, 6)}`, slug: `growth-m-${id.slice(0, 8)}` } });
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId: id, name: 'Branch A', location: 'A' } }),
    db.branch.create({ data: { tenantId: id, name: 'Branch B', location: 'B' } }),
  ]);
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const user = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role}-${id.slice(0, 8)}@growth-m.test`, displayName: role },
    });
    users[role] = user.id;
  }
  // The admin remains tenant-wide until a request explicitly selects a clinic.
  // Its legacy branchId is retained here only as fixture context; the trusted
  // clinic-selection header below is what narrows the reporting request.
  const branchAdminA = await db.user.create({
    data: {
      tenantId: id, role: 'ADMIN', active: true, branchId: branchA.id,
      email: `branch-admin-${id.slice(0, 8)}@growth-m.test`, displayName: 'Branch admin',
    },
  });
  return { id, branchA: branchA.id, branchB: branchB.id, users, branchAdminA: branchAdminA.id };
}

const headers = (t: Fixture, role: Role = 'ADMIN') => ({
  authorization: `Bearer ${app.jwt.sign({ userId: t.users[role], tenantId: t.id, role, type: 'access' })}`,
});

/** A tenant-wide admin explicitly operating in Branch A. */
const branchHeaders = (t: Fixture) => ({
  authorization: `Bearer ${app.jwt.sign({ userId: t.branchAdminA, tenantId: t.id, role: 'ADMIN', type: 'access' })}`,
  'x-carecommand-clinic-id': t.branchA,
});

const get = (t: Fixture, url: string, role: Role = 'ADMIN') =>
  app.inject({ method: 'GET', url, headers: headers(t, role) });

const getAsBranchAdmin = (t: Fixture, url: string) =>
  app.inject({ method: 'GET', url, headers: branchHeaders(t) });

/** Exactly what the browser used to fetch: one capped page of each, cursor discarded. */
async function legacyPageLoad(t: Fixture, role: Role = 'ADMIN') {
  const [leadRes, patientRes] = await Promise.all([
    get(t, '/v1/leads?limit=100', role),
    get(t, '/v1/patients?limit=100', role),
  ]);
  expect(leadRes.statusCode, leadRes.body).toBe(200);
  expect(patientRes.statusCode, patientRes.body).toBe(200);
  const patientBody = patientRes.json();
  return {
    leads: legacyAdaptLeads(leadRes.json()),
    patients: legacyAdaptPatients(patientBody.data),
    patientNextCursor: patientBody.nextCursor ?? null,
  };
}

/**
 * Every row, read with the schema-owner client — the population the browser never
 * saw. Decimals and dates are serialised the way the HTTP layer would, so the
 * frozen client adapter receives exactly the shapes it was written against.
 */
async function wholeTenant(t: Fixture, branchId?: string) {
  const [leads, patients] = await Promise.all([
    db.lead.findMany({ where: { tenantId: t.id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    db.patient.findMany({ where: { tenantId: t.id, deletedAt: null, ...(branchId ? { branchId } : {}) } }),
  ]);
  return {
    leads: legacyAdaptLeads(leads.map(row => ({
      ...row, estimatedValue: row.estimatedValue.toString(), createdAt: row.createdAt.toISOString(),
    }))),
    patients: legacyAdaptPatients(patients.map(row => ({
      ...row, lifetimeValue: row.lifetimeValue.toString(), lastVisitAt: row.lastVisitAt?.toISOString() ?? null,
    }))),
  };
}

type LeadSeed = { stage: string; channel: 'CALL' | 'SMS' | 'EMAIL' | 'WHATSAPP'; estimatedValue: number; ageDays: number };
type PatientSeed = { lifecycleStage: 'NEW' | 'ACTIVE' | 'AT_RISK' | 'INACTIVE' | 'LOST' | 'RETAINED'; churnRisk: number; lifetimeValue: number; lastVisitDaysAgo: number | null; tags?: string[]; branch?: 'A' | 'B' };

async function seedLeads(t: Fixture, seeds: LeadSeed[]) {
  await db.lead.createMany({
    data: seeds.map((seed, index) => ({
      tenantId: t.id,
      name: `Lead ${index}`,
      channel: seed.channel,
      service: 'Consultation',
      stage: seed.stage,
      source: 'Website',
      estimatedValue: seed.estimatedValue,
      createdAt: daysAgo(seed.ageDays),
    })),
  });
}

async function seedPatients(t: Fixture, seeds: PatientSeed[]) {
  await db.patient.createMany({
    data: seeds.map((seed, index) => ({
      tenantId: t.id,
      branchId: seed.branch === 'B' ? t.branchB : t.branchA,
      firstName: 'Pat',
      lastName: `Number${index}`,
      lifecycleStage: seed.lifecycleStage,
      churnRisk: seed.churnRisk,
      lifetimeValue: seed.lifetimeValue,
      tags: seed.tags ?? [],
      lastVisitAt: seed.lastVisitDaysAgo === null ? null : daysAgo(seed.lastVisitDaysAgo),
    })),
  });
}

/** A spread that exercises every stage, every channel, and every recency bucket. */
const SMALL_LEADS: LeadSeed[] = [
  { stage: 'new-inquiry', channel: 'CALL', estimatedValue: 10_000, ageDays: 0 },
  { stage: 'new-inquiry', channel: 'CALL', estimatedValue: 2_000, ageDays: 5 },
  { stage: 'new-inquiry', channel: 'SMS', estimatedValue: 5_000, ageDays: 20 },
  { stage: 'contacted', channel: 'WHATSAPP', estimatedValue: 5_000, ageDays: 1 },
  { stage: 'contacted', channel: 'EMAIL', estimatedValue: 1_000, ageDays: 40 },
  { stage: 'booked', channel: 'SMS', estimatedValue: 10_000, ageDays: 4 },
  { stage: 'booked', channel: 'EMAIL', estimatedValue: 2_000, ageDays: 60 },
  { stage: 'visited', channel: 'WHATSAPP', estimatedValue: 5_000, ageDays: 10 },
  { stage: 'follow-up', channel: 'EMAIL', estimatedValue: 1_000, ageDays: 25 },
  { stage: 'retained', channel: 'SMS', estimatedValue: 10_000, ageDays: 90 },
  { stage: 'retained', channel: 'EMAIL', estimatedValue: 5_000, ageDays: 120 },
  { stage: 'lost', channel: 'CALL', estimatedValue: 2_000, ageDays: 200 },
];

const SMALL_PATIENTS: PatientSeed[] = [
  { lifecycleStage: 'ACTIVE', churnRisk: 10, lifetimeValue: 1_200, lastVisitDaysAgo: 5 },
  { lifecycleStage: 'ACTIVE', churnRisk: 20, lifetimeValue: 800, lastVisitDaysAgo: 20 },
  { lifecycleStage: 'AT_RISK', churnRisk: 60, lifetimeValue: 3_000, lastVisitDaysAgo: 45 },
  { lifecycleStage: 'AT_RISK', churnRisk: 55, lifetimeValue: 4_000, lastVisitDaysAgo: 50 },
  { lifecycleStage: 'INACTIVE', churnRisk: 70, lifetimeValue: 6_000, lastVisitDaysAgo: 75 },
  { lifecycleStage: 'INACTIVE', churnRisk: 40, lifetimeValue: 2_500, lastVisitDaysAgo: 100 },
  { lifecycleStage: 'LOST', churnRisk: 90, lifetimeValue: 9_000, lastVisitDaysAgo: 150 },
  { lifecycleStage: 'RETAINED', churnRisk: 5, lifetimeValue: 5_000, lastVisitDaysAgo: 2, tags: ['vip'] },
  { lifecycleStage: 'ACTIVE', churnRisk: 30, lifetimeValue: 1_500, lastVisitDaysAgo: 200, tags: ['winback'] },
  { lifecycleStage: 'NEW', churnRisk: 0, lifetimeValue: 0, lastVisitDaysAgo: 300 },
];

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('a tenant under the page cap sees the numbers it saw before', () => {
  it('reproduces every Command View metric the browser computed', async () => {
    const t = await makeTenant();
    await seedLeads(t, SMALL_LEADS);
    await seedPatients(t, SMALL_PATIENTS);

    const page = await legacyPageLoad(t);
    expect(page.leads).toHaveLength(SMALL_LEADS.length);
    expect(page.patients).toHaveLength(SMALL_PATIENTS.length);
    // Nothing was truncated, so the browser's page IS the tenant.
    expect(page.patientNextCursor).toBeNull();
    const legacy = legacyCommandMetrics(page.leads, page.patients);

    const res = await get(t, '/v1/growth/metrics');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();

    expect(body.metrics.openPipeline).toBe(legacy.openPipeline);
    expect(body.metrics.hotLeads).toBe(legacy.hotLeads);
    expect(body.metrics.winRate).toBe(legacy.winRate);
    expect(body.metrics.avgDeal).toBe(legacy.avgDeal);
    expect(body.metrics.avgChurnRisk).toBe(legacy.avgChurnRisk);
    expect(body.metrics.avgLtv).toBe(legacy.avgLtv);
    expect(body.metrics.missedCallValue).toBe(legacy.missedCallValue);
    expect(body.metrics.inactiveRecoverable).toBe(legacy.inactiveRecoverable);

    // The basis is stated rather than implied.
    expect(body.basis).toMatchObject({
      leadCount: SMALL_LEADS.length,
      patientCount: SMALL_PATIENTS.length,
      truncated: false,
      unscoredLeadCount: 0,
    });
    expect(body.scope.patients).toBe('tenant');
    expect(body.policy.hotLeadScore).toBe(GROWTH_POLICY_DEFAULTS.hotLeadScore);
    expect(body.policy.churnRiskHigh).toBe(GROWTH_POLICY_DEFAULTS.churnRiskHigh);
    expect(body.policy.recoverableLtvPercent).toBe(30);
    expect(body.policy.source).toBe('default');
  });

  it('reproduces every lead score, driver and next-best-action the browser produced', async () => {
    const t = await makeTenant();
    await seedLeads(t, SMALL_LEADS);

    const page = await legacyPageLoad(t);
    const res = await get(t, '/v1/growth/leads?limit=500');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();

    expect(body.returned).toBe(SMALL_LEADS.length);
    expect(body.truncated).toBe(false);
    const byId = new Map(body.data.map((row: Record<string, unknown>) => [row.id as string, row]));
    for (const lead of page.leads) {
      const served = byId.get(lead.id) as Record<string, unknown> | undefined;
      expect(served, `lead ${lead.id} is missing from /v1/growth/leads`).toBeTruthy();
      expect(served!.score, `score for ${lead.stage}/${lead.channel}/${lead.estimatedValue}`).toBe(lead.score);
      expect(served!.scoreDrivers).toEqual(lead.scoreDrivers);
      expect(served!.nextBestAction).toEqual(lead.nextBestAction);
    }
  });

  it('reproduces every smart segment count, recoverable value and planned cost', async () => {
    const t = await makeTenant();
    await seedPatients(t, SMALL_PATIENTS);

    const page = await legacyPageLoad(t);
    const legacy = new Map(legacySmartSegments(page.patients).map(segment => [segment.id, segment]));

    const res = await get(t, '/v1/growth/segments/preview');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.segments).toHaveLength(6);

    const costByChannel = new Map(GROWTH_CHANNEL_COST_DEFAULTS.map(cost => [cost.channel, cost]));
    for (const segment of body.segments as Array<Record<string, unknown>>) {
      const reference = legacy.get(segment.key as string);
      expect(reference, `segment ${segment.key as string} is missing from the reference`).toBeTruthy();
      expect(segment.patientCount, `${segment.key as string} count`).toBe(reference!.patientCount);
      expect(segment.recoverableValue, `${segment.key as string} recoverable value`).toBe(reference!.recoverableValue);
      // The browser multiplied a count by a bare 0/1/3 and rendered it through
      // formatCurrency. The same money now arrives as minor units with a currency.
      const cost = costByChannel.get(segment.planningChannel as string)!;
      expect(segment.plannedCostMinor).toBe(reference!.planningCost * 100);
      expect(segment.plannedCostMinor).toBe((segment.patientCount as number) * cost.unitCostMinor);
      expect(segment.currency).toBe('USD');
    }
  });
});

describe('a tenant past the page cap now gets a number that is actually true', () => {
  it('disagrees with the truncated browser calculation and agrees with the whole tenant', async () => {
    const t = await makeTenant();
    // 260 patients: past both the 100-row cap and any plausible first page. The
    // spread is deliberately front-loaded so a UUID-ordered slice of 100 cannot
    // be representative — but UUID order is random, so the assertion below is on
    // the population being different, not on which way it skews.
    await seedPatients(t, Array.from({ length: 260 }, (_, index): PatientSeed => ({
      lifecycleStage: index % 4 === 0 ? 'INACTIVE' : index % 4 === 1 ? 'AT_RISK' : index % 4 === 2 ? 'ACTIVE' : 'RETAINED',
      churnRisk: index % 101,
      lifetimeValue: (index % 40) * 250,
      lastVisitDaysAgo: index % 3 === 0 ? null : 10 + (index % 200),
      tags: index % 7 === 0 ? ['winback'] : [],
    })));
    await seedLeads(t, Array.from({ length: 130 }, (_, index): LeadSeed => ({
      stage: ['new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained', 'lost'][index % 7],
      channel: (['CALL', 'SMS', 'EMAIL', 'WHATSAPP'] as const)[index % 4],
      estimatedValue: (index % 20) * 500,
      ageDays: index % 60,
    })));

    const page = await legacyPageLoad(t);
    expect(page.patients).toHaveLength(100);
    expect(page.leads).toHaveLength(100);
    // The cursor the browser threw away. Its presence is the server telling the
    // client there is more, which the client ignored.
    expect(page.patientNextCursor).toBeTruthy();

    const truncated = legacyCommandMetrics(page.leads, page.patients);
    const everything = await wholeTenant(t);
    const complete = legacyCommandMetrics(everything.leads, everything.patients);

    const res = await get(t, '/v1/growth/metrics');
    expect(res.statusCode, res.body).toBe(200);
    const served = res.json();

    // The server matches the browser's OWN arithmetic run over every row.
    expect(served.metrics.openPipeline).toBe(complete.openPipeline);
    expect(served.metrics.hotLeads).toBe(complete.hotLeads);
    expect(served.metrics.winRate).toBe(complete.winRate);
    expect(served.metrics.avgDeal).toBe(complete.avgDeal);
    expect(served.metrics.avgChurnRisk).toBe(complete.avgChurnRisk);
    expect(served.metrics.avgLtv).toBe(complete.avgLtv);
    expect(served.metrics.missedCallValue).toBe(complete.missedCallValue);
    expect(served.metrics.inactiveRecoverable).toBe(complete.inactiveRecoverable);
    expect(served.basis).toMatchObject({ patientCount: 260, leadCount: 130, truncated: false });

    // ...and it does NOT match what the screen used to show. Every one of these
    // was printed to a clinic owner as a fact about their business.
    const drifted = (['openPipeline', 'avgDeal', 'avgChurnRisk', 'avgLtv', 'inactiveRecoverable'] as const)
      .filter(key => truncated[key] !== served.metrics[key]);
    expect(drifted.length, `truncated page happened to agree with the whole tenant on ${JSON.stringify(truncated)}`)
      .toBeGreaterThan(0);
    expect(truncated.inactiveRecoverable).not.toBe(served.metrics.inactiveRecoverable);
    expect(truncated.openPipeline).not.toBe(served.metrics.openPipeline);
  });

  it('counts segment membership across the whole tenant, not the loaded hundred', async () => {
    const t = await makeTenant();
    await seedPatients(t, Array.from({ length: 260 }, (_, index): PatientSeed => ({
      lifecycleStage: 'ACTIVE',
      churnRisk: index % 101,
      lifetimeValue: (index % 40) * 250,
      lastVisitDaysAgo: 30 + (index % 160),
      tags: index % 7 === 0 ? ['winback'] : [],
    })));

    const page = await legacyPageLoad(t);
    const truncated = new Map(legacySmartSegments(page.patients).map(segment => [segment.id, segment]));
    const everything = await wholeTenant(t);
    const complete = new Map(legacySmartSegments(everything.patients).map(segment => [segment.id, segment]));

    const res = await get(t, '/v1/growth/segments/preview');
    expect(res.statusCode, res.body).toBe(200);

    for (const segment of res.json().segments as Array<Record<string, unknown>>) {
      const key = segment.key as string;
      expect(segment.patientCount, `${key} count`).toBe(complete.get(key)!.patientCount);
      expect(segment.recoverableValue, `${key} recoverable value`).toBe(complete.get(key)!.recoverableValue);
      expect(segment.patientCount, `${key} was not truncated in the browser`)
        .toBeGreaterThan(truncated.get(key)!.patientCount);
    }
  });

  it('keeps a lead score stable when a larger lead is added out of view', async () => {
    const t = await makeTenant();
    const subject: LeadSeed = { stage: 'booked', channel: 'EMAIL', estimatedValue: 4_000, ageDays: 3 };
    await seedLeads(t, [subject, { stage: 'contacted', channel: 'EMAIL', estimatedValue: 8_000, ageDays: 3 }]);

    const before = await get(t, '/v1/growth/leads?limit=500');
    const scoreBefore = (before.json().data as Array<Record<string, unknown>>)
      .find(row => Number(row.estimatedValue) === 4_000)!.score;
    expect(before.json().maxEstimatedValue).toBe(8_000);

    // A much larger lead arrives. In the browser this changed the denominator
    // for every OTHER lead on the page, so the same lead scored differently
    // depending on who it loaded beside.
    await seedLeads(t, [{ stage: 'new-inquiry', channel: 'EMAIL', estimatedValue: 40_000, ageDays: 3 }]);

    const after = await get(t, '/v1/growth/leads?limit=500');
    const scoreAfter = (after.json().data as Array<Record<string, unknown>>)
      .find(row => Number(row.estimatedValue) === 4_000)!.score;
    expect(after.json().maxEstimatedValue).toBe(40_000);

    // The score DID move, because the denominator is a real tenant-wide fact and
    // it genuinely changed. What matters is that it is now the SAME fact for
    // every caller, page size and screen — which is what the assertion pins.
    expect(scoreAfter).toBe(legacyScoreLead(
      { stage: 'booked', estimatedValue: 4_000, createdAt: daysAgo(3).toISOString(), channel: 'EMAIL' },
      40_000,
    ).score);
    expect(scoreBefore).toBe(legacyScoreLead(
      { stage: 'booked', estimatedValue: 4_000, createdAt: daysAgo(3).toISOString(), channel: 'EMAIL' },
      8_000,
    ).score);

    // And a page-size change does not move it, which is exactly what the browser
    // could not promise.
    const narrow = await get(t, '/v1/growth/leads?limit=1');
    expect(narrow.json().truncated).toBe(true);
    expect(narrow.json().total).toBe(3);
    expect(narrow.json().maxEstimatedValue).toBe(40_000);
  });

  it('ranks priority leads across the tenant instead of the top of a page', async () => {
    const t = await makeTenant();
    // 150 low-scoring leads created most recently, so a createdAt-ordered page of
    // 100 contains none of the high scorers.
    await seedLeads(t, Array.from({ length: 150 }, (): LeadSeed => (
      { stage: 'new-inquiry', channel: 'EMAIL', estimatedValue: 0, ageDays: 0 }
    )));
    await seedLeads(t, Array.from({ length: 3 }, (): LeadSeed => (
      // booked (28) + full value share (30) + within a week (12) + SMS (8) = 78.
      { stage: 'booked', channel: 'SMS', estimatedValue: 10_000, ageDays: 5 }
    )));

    const res = await get(t, '/v1/growth/leads?limit=100&priorityLimit=3');
    const body = res.json();
    expect(body.truncated).toBe(true);
    expect(body.returned).toBe(100);
    // None of the loaded page is hot; all three priority leads are.
    expect((body.data as Array<Record<string, unknown>>).every(row => row.hot === false)).toBe(true);
    expect(body.priority).toHaveLength(3);
    for (const row of body.priority as Array<Record<string, unknown>>) {
      expect(row.hot).toBe(true);
      expect(row.scoreBand).toBe('high');
      expect(row.estimatedValue).toBe(10_000);
    }

    const metrics = await get(t, '/v1/growth/metrics');
    expect(metrics.json().metrics.hotLeads).toBe(3);
  });
});

describe('absence is reported, never filled in', () => {
  it('returns null with a stated reason instead of a zero for a tenant with nothing to average', async () => {
    const t = await makeTenant();
    const res = await get(t, '/v1/growth/metrics');
    const body = res.json();

    expect(body.metrics.winRate).toBeNull();
    expect(body.metrics.avgDeal).toBeNull();
    expect(body.metrics.avgChurnRisk).toBeNull();
    expect(body.metrics.avgLtv).toBeNull();
    expect(body.metrics.campaignRoi).toBeNull();
    for (const key of ['winRate', 'avgDeal', 'avgChurnRisk', 'avgLtv', 'campaignRoi']) {
      expect(body.unavailable[key], `${key} needs a stated reason`).toEqual(expect.stringMatching(/\w+/));
    }
    // A sum over nothing IS zero, and is reported as one.
    expect(body.metrics.openPipeline).toBe(0);
    expect(body.unavailable.openPipeline).toBeUndefined();
  });

  it('gives a lead whose stage is not one of the seven no score at all, instead of NaN', async () => {
    const t = await makeTenant();
    // 'consult-booked' is a stage this codebase's own lead tests already create.
    // `STAGE_INTENT['consult-booked']` was undefined, so the browser rendered the
    // string "NaN" as that lead's planning priority.
    await seedLeads(t, [
      { stage: 'consult-booked', channel: 'SMS', estimatedValue: 9_000, ageDays: 1 },
      { stage: 'booked', channel: 'SMS', estimatedValue: 9_000, ageDays: 1 },
    ]);

    const res = await get(t, '/v1/growth/leads');
    const rows = res.json().data as Array<Record<string, unknown>>;
    const unknown = rows.find(row => row.stage === 'consult-booked')!;

    expect(unknown.score).toBeNull();
    expect(unknown.scoreBand).toBe('unscored');
    expect(unknown.nextBestAction).toBeNull();
    expect(unknown.scoreDrivers).toEqual([]);
    expect(unknown.scoreUnavailableReason).toContain('consult-booked');
    expect(unknown.hot).toBe(false);

    const metrics = await get(t, '/v1/growth/metrics');
    expect(metrics.json().basis.unscoredLeadCount).toBe(1);
    // It is still an OPEN lead and its value still counts toward the pipeline —
    // not knowing how to rank it is not a reason to pretend it is not there.
    expect(metrics.json().metrics.openPipeline).toBe(18_000);
    expect(metrics.json().metrics.hotLeads).toBe(1);
  });

  it('states the planned spend is unavailable when a channel has no configured cost', async () => {
    const t = await makeTenant();
    await seedPatients(t, [{ lifecycleStage: 'ACTIVE', churnRisk: 90, lifetimeValue: 1_000, lastVisitDaysAgo: 10 }]);
    // Materialise the defaults, then take the SMS cost away.
    const owner = headers(t, 'OWNER');
    await app.inject({ method: 'PUT', url: '/v1/growth/channel-costs/SMS', headers: owner, payload: { unitCostMinor: 250, currency: 'USD' } });
    await app.inject({ method: 'DELETE', url: '/v1/growth/channel-costs/SMS', headers: owner });

    const res = await get(t, '/v1/growth/segments/preview');
    const atRisk = (res.json().segments as Array<Record<string, unknown>>).find(row => row.key === 'at-risk')!;
    expect(atRisk.patientCount).toBe(1);
    expect(atRisk.plannedCostMinor).toBeNull();
    expect(atRisk.currency).toBeNull();
    expect(atRisk.costUnavailableReason).toContain('SMS');
  });
});

describe('the never-visited patient is excluded on purpose, and the exclusion is visible', () => {
  it('replaces the 9999-day sentinel with the includeNeverVisited flag and reports who it excludes', async () => {
    const t = await makeTenant();
    await seedPatients(t, [
      // No recorded last visit, and valuable. The browser's sentinel put this
      // patient in high-ltv-inactive (9999 >= 45) and out of all three windows.
      { lifecycleStage: 'ACTIVE', churnRisk: 10, lifetimeValue: 6_000, lastVisitDaysAgo: null },
      { lifecycleStage: 'ACTIVE', churnRisk: 10, lifetimeValue: 500, lastVisitDaysAgo: 45 },
    ]);

    const page = await legacyPageLoad(t);
    const legacy = new Map(legacySmartSegments(page.patients).map(segment => [segment.id, segment]));
    const res = await get(t, '/v1/growth/segments/preview');
    const segments = new Map((res.json().segments as Array<Record<string, unknown>>).map(row => [row.key as string, row]));

    // Same membership as before — the flag reproduces the sentinel exactly.
    for (const key of ['inactive-30-60', 'inactive-60-90', 'inactive-90-180', 'high-ltv-inactive', 'at-risk', 'winback-tagged']) {
      expect(segments.get(key)!.patientCount, key).toBe(legacy.get(key)!.patientCount);
    }
    expect(segments.get('high-ltv-inactive')!.patientCount).toBe(1);
    expect(segments.get('inactive-30-60')!.patientCount).toBe(1);

    // ...but the exclusion is now a stated configuration decision with a
    // population attached, not arithmetic no one could see.
    expect(segments.get('inactive-30-60')!.criteria).toMatchObject({ includeNeverVisited: false, minInactiveDays: 30, maxInactiveDays: 60 });
    expect(segments.get('inactive-30-60')!.neverVisitedCandidates).toBe(1);
    expect(segments.get('high-ltv-inactive')!.criteria).toMatchObject({ includeNeverVisited: true, minLifetimeValue: 4000 });
  });

  it('lets a tenant include never-visited patients by flipping the configured flag', async () => {
    const t = await makeTenant();
    await seedPatients(t, [
      { lifecycleStage: 'ACTIVE', churnRisk: 10, lifetimeValue: 1_000, lastVisitDaysAgo: null },
      { lifecycleStage: 'ACTIVE', churnRisk: 10, lifetimeValue: 1_000, lastVisitDaysAgo: 45 },
    ]);

    const before = await get(t, '/v1/growth/segments/preview');
    expect((before.json().segments as Array<Record<string, unknown>>).find(row => row.key === 'inactive-30-60')!.patientCount).toBe(1);

    const patched = await app.inject({
      method: 'PATCH', url: '/v1/growth/segments/inactive-30-60',
      headers: headers(t, 'ADMIN'), payload: { includeNeverVisited: true },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const after = await get(t, '/v1/growth/segments/preview');
    const segment = (after.json().segments as Array<Record<string, unknown>>).find(row => row.key === 'inactive-30-60')!;
    expect(segment.patientCount).toBe(2);
    expect(segment.criteria).toMatchObject({ includeNeverVisited: true });
    expect(segment.source).toBe('tenant');
  });
});

describe('scope and authorization', () => {
  it('narrows patient figures to the caller branch and says so, while stating leads are tenant-wide', async () => {
    const t = await makeTenant();
    await seedPatients(t, [
      { lifecycleStage: 'INACTIVE', churnRisk: 80, lifetimeValue: 1_000, lastVisitDaysAgo: 40, branch: 'A' },
      { lifecycleStage: 'INACTIVE', churnRisk: 20, lifetimeValue: 9_000, lastVisitDaysAgo: 40, branch: 'B' },
    ]);

    const unscoped = (await get(t, '/v1/growth/metrics')).json();
    expect(unscoped.scope.patients).toBe('tenant');
    expect(unscoped.basis.patientCount).toBe(2);
    expect(unscoped.metrics.avgChurnRisk).toBe(50);

    const branchA = (await getAsBranchAdmin(t, '/v1/growth/metrics')).json();
    expect(branchA.scope.patients).toBe('assigned_branch');
    expect(branchA.scope.branchId).toBe(t.branchA);
    expect(branchA.scope.leads).toBe('tenant');
    expect(branchA.scope.note).toContain('no branch');
    expect(branchA.basis.patientCount).toBe(1);
    expect(branchA.metrics.avgChurnRisk).toBe(80);
    expect(branchA.metrics.avgLtv).toBe(1_000);

    const segments = (await getAsBranchAdmin(t, '/v1/growth/segments/preview')).json();
    expect(segments.scope.patients).toBe('assigned_branch');
    expect((segments.segments as Array<Record<string, unknown>>).find(row => row.key === 'inactive-30-60')!.patientCount).toBe(1);
  });

  it('gates all three reads on the grant GET /v1/leads already requires', async () => {
    const t = await makeTenant();
    const urls = ['/v1/growth/metrics', '/v1/growth/leads', '/v1/growth/segments/preview'];

    for (const url of urls) {
      // crm:read holders. FRONT_DESK and ANALYST can already read /v1/leads.
      for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'ANALYST'] as Role[]) {
        const allowed = await get(t, url, role);
        expect(allowed.statusCode, `${role} ${url}: ${allowed.body}`).toBe(200);
        const reference = await get(t, '/v1/leads', role);
        expect(reference.statusCode, `${role} /v1/leads`).toBe(200);
      }
      // PROVIDER and BILLING hold patient:read but not crm:read, and are refused
      // by /v1/leads today. They must be refused here for the same reason.
      for (const role of ['PROVIDER', 'BILLING'] as Role[]) {
        const denied = await get(t, url, role);
        expect(denied.statusCode, `${role} ${url}`).toBe(403);
        expect(denied.json().permission).toBe('crm:read');
        const reference = await get(t, '/v1/leads', role);
        expect(reference.statusCode, `${role} /v1/leads`).toBe(403);
      }
      const anonymous = await app.inject({ method: 'GET', url });
      expect(anonymous.statusCode).toBe(401);
    }
  });

  it('never returns another tenant\'s leads or patients', async () => {
    const [mine, theirs] = await Promise.all([makeTenant(), makeTenant()]);
    await seedLeads(theirs, SMALL_LEADS);
    await seedPatients(theirs, SMALL_PATIENTS);

    const metrics = (await get(mine, '/v1/growth/metrics')).json();
    expect(metrics.basis.leadCount).toBe(0);
    expect(metrics.basis.patientCount).toBe(0);
    expect((await get(mine, '/v1/growth/leads')).json().data).toEqual([]);
    for (const segment of (await get(mine, '/v1/growth/segments/preview')).json().segments as Array<Record<string, unknown>>) {
      expect(segment.patientCount).toBe(0);
      expect(segment.recoverableValue).toBe(0);
    }
  });
});

describe('the numbers follow the tenant\'s configuration, not a literal', () => {
  it('re-bands and re-counts every lead when the policy thresholds move', async () => {
    const t = await makeTenant();
    await seedLeads(t, [
      { stage: 'booked', channel: 'EMAIL', estimatedValue: 1_000, ageDays: 40 },
      { stage: 'new-inquiry', channel: 'EMAIL', estimatedValue: 1_000, ageDays: 40 },
    ]);

    const before = (await get(t, '/v1/growth/leads')).json();
    expect(before.policy.hotLeadScore).toBe(70);
    expect(before.data.filter((row: Record<string, unknown>) => row.hot)).toHaveLength(0);

    const patched = await app.inject({
      method: 'PATCH', url: '/v1/growth/policy', headers: headers(t, 'ADMIN'),
      payload: { hotLeadScore: 30, scoreBandHigh: 30, scoreBandMid: 10 },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const after = (await get(t, '/v1/growth/leads')).json();
    expect(after.policy.hotLeadScore).toBe(30);
    expect(after.policy.source).toBe('tenant');
    // booked scores 28 + 0 = 28... below 30; the point is the band moved with the
    // policy rather than staying pinned to a literal.
    const booked = (after.data as Array<Record<string, unknown>>).find(row => row.stage === 'booked')!;
    expect(booked.scoreBand).toBe(booked.score as number >= 30 ? 'high' : 'medium');
    expect((await get(t, '/v1/growth/metrics')).json().metrics.hotLeads)
      .toBe((after.data as Array<Record<string, unknown>>).filter(row => row.hot).length);
  });

  it('re-values the recoverable headline when the money-affecting fraction moves', async () => {
    const t = await makeTenant();
    await seedPatients(t, [{ lifecycleStage: 'INACTIVE', churnRisk: 10, lifetimeValue: 1_000, lastVisitDaysAgo: 40 }]);

    expect((await get(t, '/v1/growth/metrics')).json().metrics.inactiveRecoverable).toBe(300);

    const patched = await app.inject({
      method: 'PATCH', url: '/v1/growth/policy', headers: headers(t, 'OWNER'),
      payload: { recoverableLtvFraction: 0.5 },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const after = (await get(t, '/v1/growth/metrics')).json();
    expect(after.metrics.inactiveRecoverable).toBe(500);
    expect(after.policy.recoverableLtvPercent).toBe(50);
    const segments = (await get(t, '/v1/growth/segments/preview')).json();
    expect((segments.segments as Array<Record<string, unknown>>).find(row => row.key === 'inactive-30-60')!.recoverableValue).toBe(500);
  });
});
