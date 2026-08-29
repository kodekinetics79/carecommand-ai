import { apiRequest } from './api';

// ===========================================================================
// Client for the tenant-configurable Growth policy.
//
// `GET /v1/growth/policy` (server/modules/growth/routes.ts) serves the
// GrowthPolicy row for the calling tenant, falling back to the product defaults
// in server/modules/growth/defaults.ts when the tenant has never edited one.
// Either way it answers with the SAME numbers the server itself classifies
// with, which is the point: a screen that draws a colour band or calls a case
// "high priority" is restating a clinic's own rule, and it may only do that
// from the rule it was actually given.
//
// The CRM screens get their policy echoed inside the payload they already read
// (`CommandMetrics.policy`). Reviews and ClinicRadar read no Growth reporting
// endpoint, so they read the policy directly through this module. It is one
// request, one module-scope loader identity, and it goes through `useResource`
// like any other feed — so a policy that has not arrived is a `loading` state
// and a policy that failed is an `error` state. There is deliberately no local
// default to fall back on: a band drawn from a guessed threshold is a clinic
// rule the clinic never set, presented as if it had.
// ===========================================================================

/** Path the policy is read from. Exported so tests can register a fixture. */
export const GROWTH_POLICY_PATH = '/v1/growth/policy';

/**
 * The subset of GrowthPolicy the reputation screens classify with, plus the
 * provenance flag.
 *
 * Comparison semantics come from server/modules/growth/defaults.ts and are
 * repeated here because they are part of the meaning of each number:
 *   * `reviewRatingGood` / `reviewRatingFair`   — inclusive LOWER bounds (>=)
 *   * `reputationRiskHigh` / `reputationRiskMedium` — inclusive LOWER bounds (>=)
 *   * `competitorRating*SeverityMax`            — inclusive UPPER bounds (<=)
 *   * `competitorReviewVolumeHigh`              — EXCLUSIVE lower bound (>)
 */
export interface GrowthPolicy {
  /** 'tenant' when this workspace has edited the policy; 'default' otherwise. */
  source: 'tenant' | 'default';
  /** Rating at or above which a clinic average reads as good. */
  reviewRatingGood: number;
  /** Rating at or above which a clinic average reads as fair rather than poor. */
  reviewRatingFair: number;
  /** Recorded bad-review risk at or above which a case is high severity. */
  reputationRiskHigh: number;
  /** Recorded bad-review risk at or above which a case is medium severity. */
  reputationRiskMedium: number;
  /** Competitor rating at or below which the competitor is high severity. */
  competitorRatingHighSeverityMax: number;
  /** Competitor rating at or below which the competitor is medium severity. */
  competitorRatingMediumSeverityMax: number;
  /** Review count ABOVE which a competitor is high severity on volume alone. */
  competitorReviewVolumeHigh: number;
}

/**
 * Fields validated on the way in. Only what these two screens actually consume
 * is required: a policy that is missing a field neither page reads is not a
 * reason to refuse to draw either page.
 */
const REQUIRED_NUMERIC_FIELDS = [
  'reviewRatingGood',
  'reviewRatingFair',
  'reputationRiskHigh',
  'reputationRiskMedium',
  'competitorRatingHighSeverityMax',
  'competitorRatingMediumSeverityMax',
  'competitorReviewVolumeHigh',
] as const satisfies ReadonlyArray<keyof GrowthPolicy>;

/**
 * Prisma serialises Decimal columns as strings on some paths and numbers on
 * others, so both are accepted — and nothing else is. A field that is absent,
 * null, or unparseable is a policy this screen cannot classify with, and the
 * adapter says so instead of coercing it to a number (`Number(null)` is 0, and
 * a 0 threshold would silently mark every clinic "good").
 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Shapes the response, and refuses one it cannot classify with.
 *
 * Throwing here is the honest outcome: `useResource` turns it into the shared
 * `error` state, so the panel names the failure and renders no band at all,
 * rather than banding a clinic against a NaN comparison (which is always false,
 * so every clinic would quietly come out red).
 */
export function adaptGrowthPolicy(raw: unknown): GrowthPolicy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The configured growth thresholds could not be read, so no rating or severity band can be applied.');
  }
  const row = raw as Record<string, unknown>;

  const values = {} as Record<(typeof REQUIRED_NUMERIC_FIELDS)[number], number>;
  const missing: string[] = [];
  for (const field of REQUIRED_NUMERIC_FIELDS) {
    const parsed = finiteNumber(row[field]);
    if (parsed === null) missing.push(field);
    else values[field] = parsed;
  }
  if (missing.length > 0) {
    throw new Error(
      `The configured growth thresholds are incomplete (${missing.join(', ')}), so no rating or severity band can be applied.`,
    );
  }

  return {
    // Provenance only decorates the copy, so an unrecognised value degrades to
    // the weaker claim rather than failing the read.
    source: row.source === 'tenant' ? 'tenant' : 'default',
    ...values,
  };
}

/**
 * Module-scope loader. `useResource` keys a request by the identity of its
 * source, so this must not be re-created per render — both screens import this
 * exact function.
 */
export const loadGrowthPolicy = async (signal: AbortSignal): Promise<GrowthPolicy> =>
  adaptGrowthPolicy(await apiRequest<unknown>(GROWTH_POLICY_PATH, { signal }));

/**
 * A rating threshold, written the way the ratings beside it are written.
 *
 * `String(4.0)` is "4", so a legend built by interpolation read "amber at ≥ 4"
 * next to averages printed as "4.3". A whole number gets one decimal; anything
 * else is printed exactly as configured. Rounding is deliberately avoided —
 * these columns are Decimal(3,2), so a tenant on 4.55 must not be told its rule
 * is 4.6.
 */
export function formatRatingThreshold(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/** One sentence naming where the numbers in the copy beside it came from. */
export function growthPolicyProvenance(policy: GrowthPolicy): string {
  return policy.source === 'tenant'
    ? 'Configured for this workspace.'
    : 'Product default — this workspace has not set its own thresholds yet.';
}
