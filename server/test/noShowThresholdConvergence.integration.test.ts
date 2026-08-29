import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// The Scheduling board, the advisory engine and revenue-protection classify
// the SAME `Appointment.noShowRisk` field. Until this increment the board
// flagged at a hardcoded `>= 50`, the advisors counted at `>= 60` in three
// places, and revenue-protection escalated at `> 65` — one concept, three
// numbers, three layers, none visible to the clinic.
//
// It was the last known money-bearing threshold divergence: two of the
// advisory counts are multiplied into `expectedImpact` ($120 and $150 a
// flag), a currency figure an owner acts on. So, exactly as the reputation
// convergence suite does, these tests check a count AND the dollar figure the
// count produces, and they check the three rules against each other directly
// for the same tenant on the same appointment.
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
const { GROWTH_POLICY_DEFAULTS, THRESHOLD_RESOLUTIONS } = await import('../modules/growth/defaults');
const { isHighNoShowRisk } = await import('../modules/advisory/thresholds');
const { createInsuranceProvider } = await import('../modules/revenue-protection');

const root = new URL('../../', import.meta.url).pathname;
const read = (relative: string) => readFileSync(`${root}${relative}`, 'utf8');

// ---------------------------------------------------------------------------
// The screen's rule, pinned to the screen's source (same technique as the
// reputation suite: the flag expression is module-private to Scheduling.tsx,
// so the exact source text is asserted before anything is compared to a copy
// of it).
// ---------------------------------------------------------------------------
const SCHEDULING_FLAG_SOURCE =
  'const isRisky = receivedNoShowPolicy !== null && appt.noShowRisk >= receivedNoShowPolicy.noShowRiskHigh;';

type ScreenPolicy = { noShowRiskHigh: number };

/** The pinned screen rule with a policy present (no policy → no flag at all). */
function screenFlagsAsRisky(noShowRisk: number, policy: ScreenPolicy): boolean {
  return noShowRisk >= policy.noShowRiskHigh;
}

// The advisor's own pricing arithmetic, kept beside the test so a count
// assertion can be turned into a money assertion.
const IMPACT_PER_NO_SHOW_FLAG_FRONT_DESK = 120;

// The mock eligibility simulation's observable: coinsurance is 0.25 when the
// risk classification says high and 0.15 when it does not.
const COINSURANCE_HIGH = 0.25;
const COINSURANCE_NOT_HIGH = 0.15;

let app: FastifyInstance;
const tenantIds: string[] = [];

type Tenant = { id: string; ownerId: string; branchId: string; patientId: string };

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `noshow-${id.slice(0, 6)}`, slug: `noshow-${id.slice(0, 8)}` } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'Test' } });
  const owner = await db.user.create({
    data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@noshow.test`, displayName: 'Owner' },
  });
  const patient = await db.patient.create({
    data: { tenantId: id, branchId: branch.id, firstName: 'No', lastName: 'Show' },
  });
  return { id, ownerId: owner.id, branchId: branch.id, patientId: patient.id };
}

const headers = (t: Tenant) => ({
  authorization: `Bearer ${app.jwt.sign({ userId: t.ownerId, tenantId: t.id, role: 'OWNER', type: 'access' })}`,
});

async function seedAppointments(t: Tenant, risks: number[]) {
  const rows = [] as { id: string; noShowRisk: number }[];
  for (const [index, noShowRisk] of risks.entries()) {
    const startsAt = new Date(Date.now() + (index + 1) * 60 * 60_000);
    const row = await db.appointment.create({
      data: {
        tenantId: t.id, branchId: t.branchId, patientId: t.patientId,
        service: `Checkup ${noShowRisk}`, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        channel: 'EMAIL', value: 180, noShowRisk,
      },
    });
    rows.push({ id: row.id, noShowRisk: row.noShowRisk });
  }
  return rows;
}

/** The front-desk advisor as the product serves it. */
async function frontDeskAdvisor(t: Tenant) {
  const res = await app.inject({ method: 'GET', url: '/v1/advisory/brief', headers: headers(t) });
  expect(res.statusCode, res.body).toBe(200);
  const advisor = res.json().advisors.find((a: { advisorType: string }) => a.advisorType === 'front-desk');
  expect(advisor, 'the brief did not include a front-desk advisor').toBeTruthy();
  return advisor as { expectedImpact: number; evidence: string[] };
}

function noShowCountFrom(evidence: string[]): number {
  const line = evidence.find(item => item.startsWith('High no-show risk appointments'));
  expect(line, `no high no-show risk evidence line in ${JSON.stringify(evidence)}`).toBeTruthy();
  return Number(line!.match(/: (\d+)\.$/)![1]);
}

/** The exact policy payload src/pages/Scheduling.tsx loads for its flags. */
async function screenPolicy(t: Tenant): Promise<ScreenPolicy & { source: string }> {
  const res = await app.inject({ method: 'GET', url: '/v1/growth/policy', headers: headers(t) });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  expect(body.noShowRiskHigh, 'GET /v1/growth/policy no longer serves noShowRiskHigh').toBeTypeOf('number');
  return body;
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

// ===========================================================================
// 1. The configuration moves the advisor — the count AND the money.
// ===========================================================================
describe('no-show threshold — a tenant\'s configuration moves the advisor, not just the board', () => {
  // 72 and 55 clear the default bound of 50; 50 is ON the inclusive boundary
  // and must count; 49 and 30 clear nothing. The RETIRED advisory literal of
  // 60 counts only the 72, so the counts discriminate which rule ran.
  const RISKS = [72, 55, 50, 49, 30];

  it('with no stored policy, applies the product default (>= 50) and prices exactly that count', async () => {
    const t = await makeTenant();
    await seedAppointments(t, RISKS);
    const advisor = await frontDeskAdvisor(t);

    const expectedHigh = RISKS.filter(risk => risk >= GROWTH_POLICY_DEFAULTS.noShowRiskHigh).length;
    expect(expectedHigh).toBe(3);
    expect(noShowCountFrom(advisor.evidence)).toBe(expectedHigh);

    // The retired literal would have counted one. If `>= 60` ever comes back,
    // this is the assertion that catches it.
    expect(noShowCountFrom(advisor.evidence)).not.toBe(RISKS.filter(risk => risk >= 60).length);

    // No staff profiles and no tasks are seeded, so the front-desk
    // expectedImpact is exactly this count, priced.
    expect(advisor.expectedImpact).toBe(expectedHigh * IMPACT_PER_NO_SHOW_FLAG_FRONT_DESK);

    // A stated rule the clinic can check, not a bare count.
    expect(advisor.evidence.join(' ')).toContain(
      `High no-show risk appointments (stored risk ≥ ${GROWTH_POLICY_DEFAULTS.noShowRiskHigh}, product default, not yet configured for this workspace)`,
    );
  }, 30_000);

  it('a tenant that raises noShowRiskHigh via PATCH gets a different count AND a different expectedImpact', async () => {
    const t = await makeTenant();
    await seedAppointments(t, RISKS);
    const before = await frontDeskAdvisor(t);
    expect(noShowCountFrom(before.evidence)).toBe(3);

    // Through the real configuration API, so the PATCH schema addition is
    // exercised end to end rather than via a fixture write.
    const patch = await app.inject({
      method: 'PATCH', url: '/v1/growth/policy', headers: headers(t), payload: { noShowRiskHigh: 70 },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().noShowRiskHigh).toBe(70);
    expect(patch.json().source).toBe('tenant');

    const after = await frontDeskAdvisor(t);
    expect(noShowCountFrom(after.evidence)).toBe(1); // only the 72
    // The money moved by exactly two flags' price: the divergence was a MONEY
    // defect, and the owner-facing dollar figure now answers to the tenant's
    // own rule.
    expect(before.expectedImpact - after.expectedImpact).toBe(2 * IMPACT_PER_NO_SHOW_FLAG_FRONT_DESK);
    expect(after.evidence.join(' ')).toContain('stored risk ≥ 70, configured for this workspace');

    // A looser tenant moves it the other way — a live read, not a one-off
    // correction baked in at a different constant. 30 is also the inclusive
    // boundary for the loosest seeded appointment.
    const loosen = await app.inject({
      method: 'PATCH', url: '/v1/growth/policy', headers: headers(t), payload: { noShowRiskHigh: 30 },
    });
    expect(loosen.statusCode, loosen.body).toBe(200);
    const loosened = await frontDeskAdvisor(t);
    expect(noShowCountFrom(loosened.evidence)).toBe(5);
    expect(loosened.expectedImpact).toBe(5 * IMPACT_PER_NO_SHOW_FLAG_FRONT_DESK);
  }, 40_000);

  it('one tenant\'s configuration never moves another tenant\'s advisor', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await seedAppointments(a, RISKS);
    await seedAppointments(b, RISKS);
    await db.growthPolicy.create({ data: { tenantId: a.id, noShowRiskHigh: 96 } });

    expect(noShowCountFrom((await frontDeskAdvisor(a)).evidence)).toBe(0);
    expect(noShowCountFrom((await frontDeskAdvisor(b)).evidence)).toBe(3);
  }, 40_000);
});

// ===========================================================================
// 2. The board, the advisor and revenue-protection agree — for the same
//    tenant, on the same appointment.
// ===========================================================================
describe('no-show threshold — the board, the advisor and revenue-protection classify the same appointment the same way', () => {
  it('pins the board\'s rule before comparing anything to it', () => {
    const scheduling = read('src/pages/Scheduling.tsx');
    expect(
      scheduling,
      'src/pages/Scheduling.tsx no longer contains the policy-driven flag this suite compares the advisor against',
    ).toContain(SCHEDULING_FLAG_SOURCE);
    // The retired hardcoded flag must not come back beside the configured one.
    expect(scheduling).not.toMatch(/noShowRisk >= \d/);
  });

  it('agrees value by value across the boundary, for default and configured policies', () => {
    const values = [0, 29, 30, 49, 50, 51, 59, 60, 61, 65, 66, 69, 70, 71, 100];
    const policies: ScreenPolicy[] = [
      { noShowRiskHigh: GROWTH_POLICY_DEFAULTS.noShowRiskHigh },
      { noShowRiskHigh: 70 },
      { noShowRiskHigh: 30 },
    ];
    for (const policy of policies) {
      for (const value of values) {
        const board = screenFlagsAsRisky(value, policy);
        const advisor = isHighNoShowRisk(value, policy);
        expect(
          advisor,
          `risk ${value} under high=${policy.noShowRiskHigh}: board says ${board ? 'risky' : 'not risky'}, advisor says ${advisor ? 'risky' : 'not risky'}`,
        ).toBe(board);
      }
    }
    // The comparison discriminates: both retired server literals disagree with
    // the board inside the sweep, so identical answers are evidence.
    const defaultPolicy = policies[0]!;
    const retiredAdvisory = (value: number) => value >= 60;
    const retiredEscalation = (value: number) => value > 65;
    expect(values.filter(v => retiredAdvisory(v) !== screenFlagsAsRisky(v, defaultPolicy)).length).toBeGreaterThan(0);
    expect(values.filter(v => retiredEscalation(v) !== screenFlagsAsRisky(v, defaultPolicy)).length).toBeGreaterThan(0);
  });

  it('classifies one live appointment identically across all three layers, under a configured tenant', async () => {
    const t = await makeTenant();
    // 55 is the discriminating value: risky under the default 50, NOT risky
    // under this tenant's 70, risky again under the retired >= 60 literal.
    const [appointment] = await seedAppointments(t, [55]);
    await db.growthPolicy.create({ data: { tenantId: t.id, noShowRiskHigh: 70 } });

    // Board: the real policy payload Scheduling.tsx loads, under the pinned rule.
    const policy = await screenPolicy(t);
    expect(policy.noShowRiskHigh).toBe(70);
    const boardSaysRisky = screenFlagsAsRisky(appointment.noShowRisk, policy);
    expect(boardSaysRisky).toBe(false);

    // Advisor: the real HTTP response an owner reads. Same appointment, same
    // answer, and the money follows (no flag, no $120).
    const advisor = await frontDeskAdvisor(t);
    expect(noShowCountFrom(advisor.evidence)).toBe(0);
    expect(advisor.expectedImpact).toBe(0);

    // Revenue-protection: the mock eligibility simulation for the SAME
    // appointment (no patient in context, so the no-show branch classifies).
    // It resolves the tenant's configured thresholds itself.
    const outcome = await createInsuranceProvider().runEligibilityCheck({
      tenantId: t.id,
      branchId: t.branchId,
      appointment: {
        id: appointment.id, branchId: t.branchId, service: 'Checkup 55',
        startsAt: new Date(), value: 180, noShowRisk: appointment.noShowRisk,
      },
    });
    expect(outcome.coinsurance).toBe(COINSURANCE_NOT_HIGH);
  }, 30_000);

  it('classifies the same appointment as risky in all three layers for an unconfigured tenant', async () => {
    const t = await makeTenant();
    const [appointment] = await seedAppointments(t, [55]);

    const policy = await screenPolicy(t);
    expect(policy.noShowRiskHigh).toBe(GROWTH_POLICY_DEFAULTS.noShowRiskHigh);
    expect(screenFlagsAsRisky(appointment.noShowRisk, policy)).toBe(true);

    const advisor = await frontDeskAdvisor(t);
    expect(noShowCountFrom(advisor.evidence)).toBe(1);
    expect(advisor.expectedImpact).toBe(1 * IMPACT_PER_NO_SHOW_FLAG_FRONT_DESK);

    const outcome = await createInsuranceProvider().runEligibilityCheck({
      tenantId: t.id,
      branchId: t.branchId,
      appointment: {
        id: appointment.id, branchId: t.branchId, service: 'Checkup 55',
        startsAt: new Date(), value: 180, noShowRisk: appointment.noShowRisk,
      },
    });
    expect(outcome.coinsurance).toBe(COINSURANCE_HIGH);
  }, 30_000);

  it('revenue-protection classifies each concept with its own threshold, inclusively', async () => {
    const t = await makeTenant();
    const provider = createInsuranceProvider();
    const appointment = {
      id: randomUUID(), branchId: t.branchId, service: 'Mixed', startsAt: new Date(), value: 180, noShowRisk: 90,
    };
    const basePatient = {
      id: t.patientId, firstName: 'No', lastName: 'Show', branchId: t.branchId,
      lifecycleStage: 'ACTIVE', outstandingBalance: 0, lifetimeValue: 0,
    };

    // A patient in context means the CHURN concept classifies — the
    // appointment's 90 no-show risk must not leak into it. churnRisk 40 is
    // below the default churnRiskHigh of 50: not high, despite noShowRisk 90.
    const churnLow = await provider.runEligibilityCheck({
      tenantId: t.id, branchId: t.branchId,
      patient: { ...basePatient, churnRisk: 40 },
      appointment,
    });
    expect(churnLow.coinsurance).toBe(COINSURANCE_NOT_HIGH);

    // churnRisk exactly at the inclusive bound counts. The retired `> 65`
    // would have said not-high here — this is the operator half of the fix.
    const churnBoundary = await provider.runEligibilityCheck({
      tenantId: t.id, branchId: t.branchId,
      patient: { ...basePatient, churnRisk: GROWTH_POLICY_DEFAULTS.churnRiskHigh },
      appointment,
    });
    expect(churnBoundary.coinsurance).toBe(COINSURANCE_HIGH);

    // No patient: the NO-SHOW concept classifies, at its own inclusive bound.
    const noShowBoundary = await provider.runEligibilityCheck({
      tenantId: t.id, branchId: t.branchId,
      appointment: { ...appointment, noShowRisk: GROWTH_POLICY_DEFAULTS.noShowRiskHigh },
    });
    expect(noShowBoundary.coinsurance).toBe(COINSURANCE_HIGH);
    const noShowBelow = await provider.runEligibilityCheck({
      tenantId: t.id, branchId: t.branchId,
      appointment: { ...appointment, noShowRisk: GROWTH_POLICY_DEFAULTS.noShowRiskHigh - 1 },
    });
    expect(noShowBelow.coinsurance).toBe(COINSURANCE_NOT_HIGH);
  }, 30_000);
});

// ===========================================================================
// 3. The register describes reality after this change.
// ===========================================================================
describe('no-show threshold — the register records the resolution and the literals are gone', () => {
  it('records the divergence as resolved with the value and operator the product uses', () => {
    const entry = THRESHOLD_RESOLUTIONS.find(resolution => resolution.concept === 'noShowRiskHigh');
    expect(entry, 'the no-show divergence is not recorded in THRESHOLD_RESOLUTIONS').toBeTruthy();
    expect(entry!.kind).toBe('divergence-resolved');
    expect(entry!.chosen).toBe(GROWTH_POLICY_DEFAULTS.noShowRiskHigh);
    expect(entry!.comparison).toBe('>=');
    expect(entry!.reasoning.length).toBeGreaterThan(80);
    // The resolution names all three formerly divergent layers.
    expect(entry!.frontend).toContain('Scheduling.tsx');
    expect(entry!.server).toContain('advisory');
    expect(entry!.server).toContain('revenue-protection');
  });

  it('leaves no no-show literal in the advisor or in revenue-protection', () => {
    const advisory = read('server/modules/advisory/service.ts');
    expect(advisory).not.toMatch(/noShowRisk >= \d/);
    expect(advisory).toContain('isHighNoShowRisk');

    const revenueProtection = read('server/modules/revenue-protection.ts');
    expect(revenueProtection).not.toContain('?? appointment?.noShowRisk ?? 0) > 65');
    expect(revenueProtection).toContain('riskThresholds.noShowRiskHigh');
    expect(revenueProtection).toContain('riskThresholds.churnRiskHigh');
  });
});
