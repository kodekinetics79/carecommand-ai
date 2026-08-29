import type { EffectiveGrowthPolicy } from '../growth/service';

// ===========================================================================
// The two thresholds the competitor advisor classifies with.
//
// They live in their own module, next to the advisor that uses them, so a test
// can assert the rule directly instead of inferring it from a count, and so the
// comparison semantics are written down once rather than re-derived at each
// call site.
//
// Why this file exists at all: `buildCompetitorAdvisor` used to classify
// `badReviewRisk` at a hardcoded `>= 60` while src/pages/ClinicRadar.tsx banded
// the SAME field with the tenant's configured `reputationRiskHigh` /
// `reputationRiskMedium`. That divergence was DYNAMIC — a tenant raising
// `reputationRiskHigh` to 90 moved the screen and not the advisor, so the gap
// widened with every configuration edit — and it was priced: the count is
// multiplied into an `expectedImpact` currency figure a clinic acts on. A
// number presented as money must not come from a threshold the customer
// believes they changed.
// ===========================================================================

/**
 * Is this reputation case high-risk?
 *
 * INCLUSIVE LOWER bound, per GROWTH_POLICY_DEFAULTS in
 * server/modules/growth/defaults.ts, and character for character the high band
 * of `severityFromRisk` in src/pages/ClinicRadar.tsx:
 *
 *     if (value >= policy.reputationRiskHigh) return 'high';
 *
 * The advisor counts exactly the cases the board paints red — no more, no less.
 */
export function isHighReputationRisk(
  badReviewRisk: number,
  policy: Pick<EffectiveGrowthPolicy, 'reputationRiskHigh'>,
): boolean {
  return badReviewRisk >= policy.reputationRiskHigh;
}

/**
 * The rating at or below which a single review counts as low-rated.
 *
 * This is the fourth literal that used to sit unnamed in
 * `buildCompetitorAdvisor` (`review.rating <= 3`). It is deliberately a code
 * constant rather than a GrowthPolicy column, and the reasoning is recorded in
 * THRESHOLD_RESOLUTIONS (server/modules/growth/defaults.ts) so it is evidence
 * rather than a commit message nobody reads. In short: no clinic-facing surface
 * classifies an INDIVIDUAL review's rating, so there is no second number to
 * converge on; `reviewRatingGood` / `reviewRatingFair` band a clinic AVERAGE,
 * and binding a per-review money multiplier to a threshold a tenant set for its
 * average would silently repurpose that tenant's rule.
 *
 * `Review.rating` is an `Int` in prisma/schema.prisma, so `<= 3` is exactly
 * "below the 4.0 fair band" for every value the column can hold.
 *
 * INCLUSIVE UPPER bound (rating <= LOW_RATED_REVIEW_MAX).
 */
export const LOW_RATED_REVIEW_MAX = 3;

/** Is this an individual low-rated review? See LOW_RATED_REVIEW_MAX. */
export function isLowRatedReview(rating: number): boolean {
  return rating <= LOW_RATED_REVIEW_MAX;
}

/**
 * One clause naming where the reputation band beside it came from, so an
 * owner-facing evidence line never states a threshold without stating whose it
 * is. Mirrors `growthPolicyProvenance` in src/lib/growthPolicy.ts.
 */
export function reputationBandProvenance(policy: Pick<EffectiveGrowthPolicy, 'source'>): string {
  return policy.source === 'tenant'
    ? 'configured for this workspace'
    : 'product default, not yet configured for this workspace';
}
