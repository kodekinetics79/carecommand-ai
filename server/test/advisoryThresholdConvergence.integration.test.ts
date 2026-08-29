import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// The competitor advisor and the Clinic Radar board classify the SAME
// `ReputationCase.badReviewRisk` field. Until this increment the board banded it
// with the tenant's configured `reputationRiskHigh` and the advisor banded it at
// a hardcoded `>= 60`.
//
// That divergence was worse than an inconsistency for two reasons, and both are
// asserted here rather than described:
//
//   1. It was DYNAMIC. Raising `reputationRiskHigh` moved the screen and left
//      the advisor where it was, so the gap widened with every configuration
//      edit and the configuration UI became a control half the product ignored.
//   2. It was PRICED. The advisor multiplies the count into `expectedImpact`, a
//      currency figure an owner acts on. A number presented as money must not
//      come from a threshold the customer believes they changed.
//
// So the tests below check a count AND the dollar figure that count produces,
// and they check the screen's rule and the advisor's rule against each other
// directly instead of trusting both to "read the same field".
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
const { GROWTH_POLICY_DEFAULTS, THRESHOLD_RESOLUTIONS, PENDING_CONFIG_CALL_SITES } = await import('../modules/growth/defaults');
const { isHighReputationRisk, isLowRatedReview, LOW_RATED_REVIEW_MAX } = await import('../modules/advisory/thresholds');

const root = new URL('../../', import.meta.url).pathname;
const read = (relative: string) => readFileSync(`${root}${relative}`, 'utf8');

// ---------------------------------------------------------------------------
// The screen's rule, pinned to the screen's source.
//
// `severityFromRisk` is module-private to src/pages/ClinicRadar.tsx, so it
// cannot be imported. Re-implementing it in a test would prove nothing on its
// own — the copy could drift from the original and the test would keep passing.
// So the exact source text is asserted first: if anyone changes the screen's
// operator, its field, or its band order, this assertion fails BEFORE the
// agreement assertions get to run on a stale copy.
// ---------------------------------------------------------------------------
const CLINIC_RADAR_SEVERITY_SOURCE = `function severityFromRisk(value: number, policy: GrowthPolicy): AlertSeverity {
  if (value >= policy.reputationRiskHigh) return 'high';
  if (value >= policy.reputationRiskMedium) return 'medium';
  return 'low';
}`;

type ScreenPolicy = { reputationRiskHigh: number; reputationRiskMedium: number };

/** Byte-for-byte the body pinned above. */
function screenSeverityFromRisk(value: number, policy: ScreenPolicy): 'high' | 'medium' | 'low' {
  if (value >= policy.reputationRiskHigh) return 'high';
  if (value >= policy.reputationRiskMedium) return 'medium';
  return 'low';
}

// The advisor's own pricing arithmetic, so a count assertion can be turned into
// a money assertion. Kept beside the test rather than exported from the service:
// the point is to check the published dollar figure, not to share a formula.
const IMPACT_PER_HIGH_RISK_CASE = 250;
const IMPACT_PER_LOW_RATED_REVIEW = 120;

let app: FastifyInstance;
const tenantIds: string[] = [];

type Tenant = { id: string; ownerId: string; branchId: string };

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `advthr-${id.slice(0, 6)}`, slug: `advthr-${id.slice(0, 8)}` } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'Test' } });
  const owner = await db.user.create({
    data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@advthr.test`, displayName: 'Owner' },
  });
  return { id, ownerId: owner.id, branchId: branch.id };
}

const headers = (t: Tenant) => ({
  authorization: `Bearer ${app.jwt.sign({ userId: t.ownerId, tenantId: t.id, role: 'OWNER', type: 'access' })}`,
});

async function seedReputationCases(t: Tenant, risks: number[]) {
  for (const badReviewRisk of risks) {
    await db.reputationCase.create({
      data: {
        tenantId: t.id, branchId: t.branchId, badReviewRisk,
        complaintCategory: 'Wait time', unresolvedComplaint: `risk ${badReviewRisk}`,
        workflowStatus: 'open', recoveryWorkflow: 'callback', suggestedReply: 'We are sorry.',
        npsScore: 20, publicTrend: 'flat',
      },
    });
  }
}

async function seedReviews(t: Tenant, ratings: number[]) {
  for (const rating of ratings) {
    await db.review.create({
      data: {
        tenantId: t.id, branchId: t.branchId, rating,
        text: `rating ${rating}`, platform: 'google', sentiment: rating >= 4 ? 'positive' : 'negative',
      },
    });
  }
}

/** The competitor advisor as the product serves it. */
async function competitorAdvisor(t: Tenant) {
  const res = await app.inject({ method: 'GET', url: '/v1/advisory/brief', headers: headers(t) });
  expect(res.statusCode, res.body).toBe(200);
  const advisor = res.json().advisors.find((a: { advisorType: string }) => a.advisorType === 'competitor');
  expect(advisor, 'the brief did not include a competitor advisor').toBeTruthy();
  return advisor as { expectedImpact: number; evidence: string[] };
}

/** The exact policy payload src/lib/growthPolicy.ts loads for the screens. */
async function screenPolicy(t: Tenant): Promise<ScreenPolicy & { source: string }> {
  const res = await app.inject({ method: 'GET', url: '/v1/growth/policy', headers: headers(t) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

function highRiskCountFrom(evidence: string[]): number {
  const line = evidence.find(item => item.startsWith('High-risk reputation cases'));
  expect(line, `no high-risk reputation evidence line in ${JSON.stringify(evidence)}`).toBeTruthy();
  return Number(line!.match(/: (\d+)\.$/)![1]);
}

function lowRatedCountFrom(evidence: string[]): number {
  const line = evidence.find(item => item.startsWith('Recent low-rated reviews'));
  expect(line, `no low-rated review evidence line in ${JSON.stringify(evidence)}`).toBeTruthy();
  return Number(line!.match(/: (\d+)\.$/)![1]);
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
describe('advisory reputation threshold — a tenant\'s configuration moves the advisor, not just the screen', () => {
  // 95 and 85 clear the default high band of 80. 70 and 62 clear only the
  // RETIRED advisory literal of 60, so they are the cases that prove which rule
  // ran. 50 clears neither.
  const RISKS = [95, 85, 70, 62, 50];
  // Two of these are low-rated at the documented `<= 3`; the 4 is the boundary
  // case that must NOT be counted.
  const RATINGS = [1, 3, 4, 5];

  async function seeded() {
    const t = await makeTenant();
    await seedReputationCases(t, RISKS);
    await seedReviews(t, RATINGS);
    return t;
  }

  it('with no stored policy, applies the product default (>= 80) and prices exactly that count', async () => {
    const t = await seeded();
    const advisor = await competitorAdvisor(t);

    const expectedHigh = RISKS.filter(risk => risk >= GROWTH_POLICY_DEFAULTS.reputationRiskHigh).length;
    expect(expectedHigh).toBe(2);
    expect(highRiskCountFrom(advisor.evidence)).toBe(expectedHigh);

    // The retired literal would have counted four. If `>= 60` ever comes back,
    // this is the assertion that catches it.
    expect(highRiskCountFrom(advisor.evidence)).not.toBe(RISKS.filter(risk => risk >= 60).length);

    // No competitors are seeded, so the competitor term of expectedImpact is 0
    // and the whole figure is these two counts, priced.
    const lowRated = RATINGS.filter(rating => rating <= LOW_RATED_REVIEW_MAX).length;
    expect(advisor.expectedImpact).toBe(
      expectedHigh * IMPACT_PER_HIGH_RISK_CASE + lowRated * IMPACT_PER_LOW_RATED_REVIEW,
    );
  }, 30_000);

  it('a tenant that raises reputationRiskHigh gets a different count AND a different expectedImpact', async () => {
    const t = await seeded();
    const before = await competitorAdvisor(t);
    expect(highRiskCountFrom(before.evidence)).toBe(2);

    // The stricter tenant from the ClinicRadar suite: high starts at 90.
    await db.growthPolicy.create({ data: { tenantId: t.id, reputationRiskHigh: 90 } });
    const after = await competitorAdvisor(t);

    expect(highRiskCountFrom(after.evidence)).toBe(1); // only the 95
    // The money moved by exactly one case's price. This is the assertion that
    // makes the divergence a MONEY defect rather than a display defect: the
    // owner-facing dollar figure now answers to the tenant's own rule.
    expect(before.expectedImpact - after.expectedImpact).toBe(IMPACT_PER_HIGH_RISK_CASE);
    expect(after.expectedImpact).toBe(1 * IMPACT_PER_HIGH_RISK_CASE + 2 * IMPACT_PER_LOW_RATED_REVIEW);

    // A looser tenant moves it the other way, so this is a live read and not a
    // one-off correction baked in at a different constant. 50 is also the
    // inclusive boundary: the case recorded at exactly 50 must count.
    await db.growthPolicy.update({ where: { tenantId: t.id }, data: { reputationRiskHigh: 50, reputationRiskMedium: 20 } });
    const loosened = await competitorAdvisor(t);
    expect(highRiskCountFrom(loosened.evidence)).toBe(5);
    expect(loosened.expectedImpact).toBe(5 * IMPACT_PER_HIGH_RISK_CASE + 2 * IMPACT_PER_LOW_RATED_REVIEW);
  }, 30_000);

  it('states the threshold it used, and whose threshold it is', async () => {
    const t = await seeded();
    const beforeConfig = await competitorAdvisor(t);
    // A stated rule can be checked by the clinic; a bare count cannot.
    expect(beforeConfig.evidence.join(' ')).toContain(
      `High-risk reputation cases (recorded risk ≥ ${GROWTH_POLICY_DEFAULTS.reputationRiskHigh}, product default, not yet configured for this workspace)`,
    );

    await db.growthPolicy.create({ data: { tenantId: t.id, reputationRiskHigh: 90 } });
    const afterConfig = await competitorAdvisor(t);
    expect(afterConfig.evidence.join(' ')).toContain(
      'High-risk reputation cases (recorded risk ≥ 90, configured for this workspace)',
    );
    expect(afterConfig.evidence.join(' ')).not.toContain('recorded risk ≥ 80');
  }, 30_000);

  it('one tenant\'s configuration never moves another tenant\'s advisor', async () => {
    const a = await seeded();
    const b = await seeded();
    await db.growthPolicy.create({ data: { tenantId: a.id, reputationRiskHigh: 96 } });

    expect(highRiskCountFrom((await competitorAdvisor(a)).evidence)).toBe(0);
    expect(highRiskCountFrom((await competitorAdvisor(b)).evidence)).toBe(2);
  }, 40_000);
});

// ===========================================================================
// 2. The screen and the advisor agree — asserted between the two rules, not
//    inferred from both mentioning the same column name.
// ===========================================================================
describe('advisory reputation threshold — the board and the advisor classify the same case the same way', () => {
  it('pins the screen\'s rule before comparing anything to it', () => {
    const clinicRadar = read('src/pages/ClinicRadar.tsx');
    expect(
      clinicRadar,
      'src/pages/ClinicRadar.tsx no longer contains the severityFromRisk this suite compares the advisor against',
    ).toContain(CLINIC_RADAR_SEVERITY_SOURCE);
  });

  it('agrees case by case across the band boundaries, for a default and a configured tenant', () => {
    // Boundary values on both sides of both bands, because an off-by-one in an
    // inclusive bound is exactly how "one field, three numbers" started.
    const values = [0, 49, 54, 55, 56, 59, 60, 61, 79, 80, 81, 89, 90, 91, 100];
    const policies: Array<ScreenPolicy & { source: 'default' | 'tenant' }> = [
      { reputationRiskHigh: GROWTH_POLICY_DEFAULTS.reputationRiskHigh, reputationRiskMedium: GROWTH_POLICY_DEFAULTS.reputationRiskMedium, source: 'default' },
      { reputationRiskHigh: 90, reputationRiskMedium: 60, source: 'tenant' },
      { reputationRiskHigh: 51, reputationRiskMedium: 20, source: 'tenant' },
    ];

    for (const policy of policies) {
      for (const value of values) {
        // LEFT: what the board paints. RIGHT: what the advisor counts.
        const screenSaysHigh = screenSeverityFromRisk(value, policy) === 'high';
        const advisorSaysHigh = isHighReputationRisk(value, policy);
        expect(
          advisorSaysHigh,
          `risk ${value} under high=${policy.reputationRiskHigh}: board says ${screenSaysHigh ? 'high' : 'not high'}, advisor says ${advisorSaysHigh ? 'high' : 'not high'}`,
        ).toBe(screenSaysHigh);
      }
    }

    // The comparison is genuinely discriminating: the retired literal disagrees
    // with the board on values inside the sweep above, so an identical pair of
    // answers is evidence rather than a tautology.
    const retiredSaysHigh = (value: number) => value >= 60;
    const defaultPolicy = policies[0]!;
    const disagreements = values.filter(
      value => retiredSaysHigh(value) !== (screenSeverityFromRisk(value, defaultPolicy) === 'high'),
    );
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it('classifies a live tenant\'s cases identically to the policy payload the board reads', async () => {
    const t = await makeTenant();
    const risks = [95, 85, 70, 62, 50];
    await seedReputationCases(t, risks);
    await seedReviews(t, [2]);
    await db.growthPolicy.create({ data: { tenantId: t.id, reputationRiskHigh: 90, reputationRiskMedium: 60 } });

    // The screen's half of the agreement: the real HTTP payload
    // src/lib/growthPolicy.ts loads, banded by the pinned screen rule.
    const policy = await screenPolicy(t);
    expect(policy.source).toBe('tenant');
    const boardHigh = risks.filter(risk => screenSeverityFromRisk(risk, policy) === 'high');

    // The advisor's half: the real HTTP response an owner reads.
    const advisor = await competitorAdvisor(t);

    expect(highRiskCountFrom(advisor.evidence)).toBe(boardHigh.length);
    expect(advisor.evidence.join(' ')).toContain(`recorded risk ≥ ${policy.reputationRiskHigh}`);
    // Same rule, same money: the priced figure follows the board's classification.
    expect(advisor.expectedImpact).toBe(
      boardHigh.length * IMPACT_PER_HIGH_RISK_CASE + 1 * IMPACT_PER_LOW_RATED_REVIEW,
    );
  }, 30_000);
});

// ===========================================================================
// 3. The fourth literal: `review.rating <= 3`.
// ===========================================================================
describe('advisory low-rated review bound — a named constant that behaves as documented', () => {
  it('is recorded in the threshold register as a deliberate code constant, with a reason', () => {
    const entry = THRESHOLD_RESOLUTIONS.find(resolution => resolution.concept === 'lowRatedReviewMax');
    expect(entry, 'the `review.rating <= 3` bound is not recorded in THRESHOLD_RESOLUTIONS').toBeTruthy();
    expect(entry!.kind).toBe('code-constant');
    // The register and the code cannot drift: this is the number the advisor uses.
    expect(entry!.chosen).toBe(LOW_RATED_REVIEW_MAX);
    expect(entry!.comparison).toBe('<=');
    expect(entry!.reasoning.length).toBeGreaterThan(80);
    // A code constant must say why a tenant does not get to set it.
    expect(entry!.reasoning).toMatch(/reviewRatingFair/);
    expect(entry!.reasoning).toMatch(/average/i);
  });

  it('counts a rating at the bound and not the one above it', async () => {
    const t = await makeTenant();
    // 3 is ON the inclusive bound; 4 is the first rating that is not low-rated.
    await seedReviews(t, [1, 2, 3, 4, 5]);
    const advisor = await competitorAdvisor(t);

    expect([1, 2, 3, 4, 5].filter(isLowRatedReview)).toEqual([1, 2, 3]);
    expect(lowRatedCountFrom(advisor.evidence)).toBe(3);
    expect(advisor.expectedImpact).toBe(3 * IMPACT_PER_LOW_RATED_REVIEW);
    expect(advisor.evidence.join(' ')).toContain(`Recent low-rated reviews (rating ≤ ${LOW_RATED_REVIEW_MAX}, product constant)`);
  }, 30_000);

  it('is deliberately NOT bound to reviewRatingFair, and the register says so', async () => {
    const t = await makeTenant();
    await seedReviews(t, [1, 2, 3, 4, 5]);
    expect(lowRatedCountFrom((await competitorAdvisor(t)).evidence)).toBe(3);

    // `reviewRatingFair` bands a clinic AVERAGE on src/pages/Reviews.tsx. If the
    // advisor silently derived its per-review bound from it, moving it to 4.5
    // would reclassify every 4-star review as low-rated and add $120 apiece to
    // an owner-facing figure the tenant never asked to move. It must not.
    await db.growthPolicy.create({ data: { tenantId: t.id, reviewRatingFair: 4.5, reviewRatingGood: 4.9 } });
    const after = await competitorAdvisor(t);
    expect(lowRatedCountFrom(after.evidence)).toBe(3);
    expect(after.expectedImpact).toBe(3 * IMPACT_PER_LOW_RATED_REVIEW);
  }, 30_000);
});

// ===========================================================================
// 4. The register must describe reality after this change.
// ===========================================================================
describe('growth threshold registers — no stale claims, no false completeness', () => {
  it('no longer lists call sites that are already rewired', () => {
    // Both screens read GET /v1/growth/policy today; claiming them as pending
    // work is how the advisory call site stayed invisible for an increment.
    expect(PENDING_CONFIG_CALL_SITES.some(site => site.includes('ClinicRadar'))).toBe(false);
    expect(PENDING_CONFIG_CALL_SITES.some(site => site.includes('Reviews.tsx'))).toBe(false);
    expect(PENDING_CONFIG_CALL_SITES.some(site => site.includes('patients/routes.ts'))).toBe(false);
    expect(PENDING_CONFIG_CALL_SITES.some(site => site.includes('advisory'))).toBe(false);
  });

  it('records the reputation divergence it just closed', () => {
    const entry = THRESHOLD_RESOLUTIONS.find(resolution => resolution.concept === 'reputationRiskHigh');
    expect(entry, 'the advisory/ClinicRadar divergence is not recorded in THRESHOLD_RESOLUTIONS').toBeTruthy();
    expect(entry!.kind).toBe('divergence-resolved');
    expect(entry!.chosen).toBe(GROWTH_POLICY_DEFAULTS.reputationRiskHigh);
    expect(entry!.comparison).toBe('>=');
    expect(entry!.reasoning.length).toBeGreaterThan(80);
  });

  it('does not claim a completeness it does not have', () => {
    // An empty pending list is a strong claim, so the file has to name what is
    // still divergent and out of the register's reach. No-show risk is the live
    // one: Scheduling.tsx flags at >= 50, advisory counts at >= 60,
    // revenue-protection escalates at > 65 — one concept, three numbers, no
    // GrowthPolicy column to converge on.
    //
    // Only defaults.ts is asserted here, deliberately. Pinning the literals in
    // the three divergent files would make this suite fail the moment somebody
    // FIXES one of them, which is the wrong incentive; what must not disappear
    // is the written record that the divergence exists.
    const defaults = read('server/modules/growth/defaults.ts');
    expect(defaults).toMatch(/noShowRisk/);
    expect(defaults).toMatch(/Scheduling\.tsx/);
    expect(defaults).toMatch(/revenue-protection/);
  });

  it('leaves no reputation or review-rating literal in the advisor', () => {
    const service = read('server/modules/advisory/service.ts');
    expect(service).not.toMatch(/badReviewRisk >= \d/);
    expect(service).not.toMatch(/rating <= \d/);
    expect(service).toContain('isHighReputationRisk');
    expect(service).toContain('isLowRatedReview');
  });
});
