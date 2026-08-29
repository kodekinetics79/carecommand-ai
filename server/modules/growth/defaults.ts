// ===========================================================================
// Growth configuration — code source of truth for the seeded defaults.
//
// The Growth module (CRM, smart segments, campaigner, reputation, competitor
// radar) compiled roughly forty clinic business rules into frontend source.
// This file is the one place those numbers are written down; the Prisma column
// defaults and the `-- @growth-seed` blocks in
// prisma/migrations/20260828140000_growth_config_spine/migration.sql carry the
// SAME values, and server/test/growthConfigSeed.unit.test.ts fails the build if
// any of the three drift apart.
//
// Every value here equals the constant the code uses today, so landing the
// spine changes no observable number. Two are resolutions of a conflict that
// already existed (see THRESHOLD_RESOLUTIONS below).
//
// Comparison semantics are part of the configuration, not folklore:
//   * `hotLeadScore`, `scoreBand*`, `churnRiskHigh`, `highValuePatientLtv`,
//     `reviewRating*`, `reputationRisk*`, `minInactiveDays`, `minLifetimeValue`,
//     `minChurnRisk` are INCLUSIVE LOWER bounds  (value >= threshold).
//   * `competitorRating*SeverityMax` are INCLUSIVE UPPER bounds (value <= t).
//   * `maxInactiveDays` is an EXCLUSIVE upper bound (days < threshold), which is
//     what today's 30–60 / 60–90 / 90–180 windows do.
//   * `competitorReviewVolumeHigh` is the single EXCLUSIVE lower bound (> t),
//     preserving ClinicRadar's `reviewVolume > 350`.
// ===========================================================================

export type GrowthPolicyValues = {
  hotLeadScore: number;
  scoreBandHigh: number;
  scoreBandMid: number;
  goingColdDays: number;
  churnRiskHigh: number;
  highValuePatientLtv: number;
  recoverableLtvFraction: number;
  inactiveAudienceDays: number;
  maxAudienceSize: number;
  slotFillHorizonDays: number;
  reviewRatingGood: number;
  reviewRatingFair: number;
  reputationRiskHigh: number;
  reputationRiskMedium: number;
  competitorRatingHighSeverityMax: number;
  competitorRatingMediumSeverityMax: number;
  competitorReviewVolumeHigh: number;
  leadSendCooldownHours: number;
};

/** Today's constants, field by field, with the call site each one came from. */
export const GROWTH_POLICY_DEFAULTS: GrowthPolicyValues = Object.freeze({
  // src/lib/crmService.ts:169 — `open.filter(l => l.score >= 70)`.
  hotLeadScore: 70,
  scoreBandHigh: 70,
  scoreBandMid: 40,
  goingColdDays: 14,
  // RESOLVED CONFLICT — see THRESHOLD_RESOLUTIONS.
  churnRiskHigh: 50,
  highValuePatientLtv: 4000,
  // src/lib/crmService.ts:175,182 — an explicitly unvalidated planning
  // assumption, never presented as a forecast.
  recoverableLtvFraction: 0.30,
  inactiveAudienceDays: 180,
  maxAudienceSize: 500,
  slotFillHorizonDays: 7,
  // src/pages/Reviews.tsx:265 — `score >= 4.5 ? good : score >= 4 ? fair : poor`.
  reviewRatingGood: 4.5,
  reviewRatingFair: 4.0,
  // src/pages/ClinicRadar.tsx:97-101 — severityFromRisk(badReviewRisk).
  reputationRiskHigh: 80,
  reputationRiskMedium: 55,
  // src/pages/ClinicRadar.tsx:155 — `score <= 4.2 || reviewVolume > 350`
  // is high, `score <= 4.5` is medium.
  competitorRatingHighSeverityMax: 4.2,
  competitorRatingMediumSeverityMax: 4.5,
  competitorReviewVolumeHigh: 350,
  leadSendCooldownHours: 24,
});

/**
 * Fields whose value moves money — a recoverable-value headline, a high-value
 * patient list, or a planned campaign spend. Editing one is an OWNER/ADMIN
 * decision even though the rest of the policy is operational tuning.
 */
export const MONEY_AFFECTING_POLICY_FIELDS = Object.freeze([
  'highValuePatientLtv',
  'recoverableLtvFraction',
] as const);

/**
 * The two thresholds where the codebase disagreed with ITSELF before this
 * increment. Recorded here (and asserted in the tests) so the resolution is
 * evidence rather than a commit message nobody reads.
 */
export const THRESHOLD_RESOLUTIONS = Object.freeze([
  Object.freeze({
    concept: 'churnRiskHigh',
    chosen: 50,
    comparison: '>=' as const,
    frontend: 'src/pages/CRM.tsx:193 and src/lib/crmService.ts:188 use churnRisk >= 50',
    server: 'server/modules/patients/routes.ts:202 uses churnRisk >= 60',
    reasoning:
      '50 is the value a clinic actually sees and acts on: it drives the at-risk badge in the patient table and the "Patients at risk" outreach segment. Moving to 60 would silently shrink a visible retention list; keeping 50 only widens a server-side reporting count. For a retention workflow a false positive costs one check-in message and a false negative costs a patient, so the inclusive/wider bound is the safe default.',
  }),
  Object.freeze({
    concept: 'highValuePatientLtv',
    chosen: 4000,
    comparison: '>=' as const,
    frontend: 'src/lib/crmService.ts:187 uses lifetimeValue >= 4000',
    server: 'server/modules/patients/routes.ts:203 uses lifetimeValue > 4000',
    reasoning:
      'Same number, different operator, so a patient at exactly 4000 was high-value on one screen and not on the other. >= wins: a clinic owner reads a "$4,000 high-value threshold" as "$4,000 and up", and the inclusive bound is the one already driving money-affecting outreach.',
  }),
]);

/**
 * The remaining call site to rewire once a module is allowed to read this config.
 *
 * The CRM entries are gone because they are DONE: `commandMetrics`,
 * `smartSegments`, `scoreLead` and the next-best-action map were deleted from
 * src/lib/crmService.ts and now live in server/modules/growth/{scoring,metrics}.ts,
 * reading GrowthPolicy / GrowthSegmentDefinition / GrowthChannelCost. The CRM
 * page's at-risk badge renders the band the server computed from
 * `churnRiskHigh`, so no threshold literal survives in that screen.
 */
export const PENDING_CONFIG_CALL_SITES = Object.freeze([
  'server/modules/patients/routes.ts:202-203 (/v1/patients/summary highRiskCount + highLifetimeValueCount)',
  'src/pages/Reviews.tsx (reviewRatingGood / reviewRatingFair)',
  'src/pages/ClinicRadar.tsx (reputationRisk* / competitor* severity bounds)',
]);

export type GrowthSegmentDefinitionValues = {
  key: string;
  label: string;
  description: string;
  minInactiveDays: number | null;
  maxInactiveDays: number | null;
  includeNeverVisited: boolean;
  minLifetimeValue: number | null;
  minChurnRisk: number | null;
  requiredTag: string | null;
  suggestedChannel: string;
  plannedOffer: string;
  assumedBookingRatePct: number;
  active: boolean;
  sortOrder: number;
};

/**
 * The six definitions in src/lib/crmService.ts:180-202, one for one.
 *
 * `includeNeverVisited` makes an accident explicit: today `daysSince(null)`
 * returns 9999, so a patient with no recorded visit falls out of every bounded
 * window but silently qualifies for the unbounded high-LTV and non-inactivity
 * groups. The flag reproduces that, visibly.
 */
export const GROWTH_SEGMENT_DEFAULTS: readonly GrowthSegmentDefinitionValues[] = Object.freeze([
  Object.freeze({
    key: 'inactive-30-60', label: '30–60 days inactive', description: 'Patients quiet 30–60 days',
    minInactiveDays: 30, maxInactiveDays: 60, includeNeverVisited: false,
    minLifetimeValue: null, minChurnRisk: null, requiredTag: null,
    suggestedChannel: 'SMS', plannedOffer: 'Gentle check-in + booking link',
    assumedBookingRatePct: 18, active: true, sortOrder: 1,
  }),
  Object.freeze({
    key: 'inactive-60-90', label: '60–90 days inactive', description: 'Patients quiet 60–90 days',
    minInactiveDays: 60, maxInactiveDays: 90, includeNeverVisited: false,
    minLifetimeValue: null, minChurnRisk: null, requiredTag: null,
    suggestedChannel: 'Email', plannedOffer: 'Recall reminder + small incentive',
    assumedBookingRatePct: 14, active: true, sortOrder: 2,
  }),
  Object.freeze({
    key: 'inactive-90-180', label: '90–180 days inactive', description: 'Reactivation candidates',
    minInactiveDays: 90, maxInactiveDays: 180, includeNeverVisited: false,
    minLifetimeValue: null, minChurnRisk: null, requiredTag: null,
    suggestedChannel: 'WhatsApp', plannedOffer: 'Winback offer',
    assumedBookingRatePct: 11, active: true, sortOrder: 3,
  }),
  Object.freeze({
    key: 'high-ltv-inactive', label: 'High-LTV inactive', description: 'Valuable patients gone quiet',
    minInactiveDays: 45, maxInactiveDays: null, includeNeverVisited: true,
    minLifetimeValue: 4000, minChurnRisk: null, requiredTag: null,
    suggestedChannel: 'Voice', plannedOffer: 'Personal outreach from care team',
    assumedBookingRatePct: 26, active: true, sortOrder: 4,
  }),
  Object.freeze({
    key: 'at-risk', label: 'Patients at risk', description: 'High churn-risk patients',
    minInactiveDays: null, maxInactiveDays: null, includeNeverVisited: true,
    minLifetimeValue: null, minChurnRisk: 50, requiredTag: null,
    suggestedChannel: 'SMS', plannedOffer: 'Retention outreach + next-visit booking',
    assumedBookingRatePct: 20, active: true, sortOrder: 5,
  }),
  Object.freeze({
    key: 'winback-tagged', label: 'Reactivation candidates', description: 'Tagged for winback',
    minInactiveDays: null, maxInactiveDays: null, includeNeverVisited: true,
    minLifetimeValue: null, minChurnRisk: null, requiredTag: 'winback',
    suggestedChannel: 'WhatsApp', plannedOffer: 'Limited-time winback',
    assumedBookingRatePct: 12, active: true, sortOrder: 6,
  }),
]);

export type GrowthChannelCostValues = {
  channel: string;
  unitCostMinor: number;
  currency: string;
};

/**
 * src/lib/crmService.ts:196 computed `count * (channel === 'Email' ? 0 :
 * channel === 'Voice' ? 3 : 1)` and rendered the result through formatCurrency,
 * so a 40-patient Voice group displayed "$120" for every tenant on earth.
 * Stored here as integer MINOR units plus an explicit currency: same numbers,
 * but now they are a tenant's numbers and they can be summed without float drift.
 */
export const GROWTH_CHANNEL_COST_DEFAULTS: readonly GrowthChannelCostValues[] = Object.freeze([
  Object.freeze({ channel: 'Email', unitCostMinor: 0, currency: 'USD' }),
  Object.freeze({ channel: 'SMS', unitCostMinor: 100, currency: 'USD' }),
  Object.freeze({ channel: 'WhatsApp', unitCostMinor: 100, currency: 'USD' }),
  Object.freeze({ channel: 'Voice', unitCostMinor: 300, currency: 'USD' }),
]);

// ===========================================================================
// Lead scoring weights.
//
// `src/lib/crmService.ts:84-97` computed a lead's planning priority in the
// browser from eight bare numbers. They move here so the scorer has ONE source
// of truth, and so `GET /v1/growth/leads` can publish the weights it actually
// used next to the score it produced.
//
// These are deliberately NOT a Prisma model. GrowthPolicy owns the thresholds a
// clinic reads and argues about (`hotLeadScore`, `scoreBand*`, `goingColdDays`);
// these are the internal shape of one heuristic, and this increment adds no
// schema. When a tenant needs to retune the curve itself, that is a migration
// and a new table — not a literal smuggled back into a component.
// ===========================================================================

export type GrowthRecencyBucket = {
  maxAgeDays: number;
  weight: number;
  /**
   * Driver label for a lead inside this bucket. Only the freshest bucket had
   * one in the browser ("Fresh inquiry (< 48h)"); every other age fell through
   * to `Inquiry age Nd`. The copy is carried verbatim rather than derived from
   * `maxAgeDays`, because `<= 2` days is up to 72 hours and the label said 48 —
   * inventing a corrected number here would be a silent copy change, not a fix.
   */
  label?: string;
};

export type GrowthLeadScoreWeights = {
  /** Pipeline-stage intent, before the stage multiplier. */
  stageIntent: Readonly<Record<string, number>>;
  stageIntentMultiplier: number;
  /** Intent at or above which the stage reads as a POSITIVE driver. */
  stageIntentPositiveMin: number;
  /** Points allocated to `estimatedValue / maxValue`. */
  valueWeight: number;
  valuePositiveMin: number;
  /** First bucket whose `maxAgeDays` covers the lead's age wins; otherwise 0. */
  recencyBuckets: readonly GrowthRecencyBucket[];
  recencyPositiveMin: number;
  /** Lower-cased lead channels that are directly reachable. */
  reachableChannels: readonly string[];
  reachableChannelWeight: number;
  minScore: number;
  maxScore: number;
};

/** The seven pipeline stages, in board order (src/lib/crmService.ts:12). */
export const GROWTH_LEAD_STAGES = Object.freeze([
  'new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained', 'lost',
] as const);

export type GrowthLeadStage = (typeof GROWTH_LEAD_STAGES)[number];

export const GROWTH_STAGE_LABEL: Readonly<Record<GrowthLeadStage, string>> = Object.freeze({
  'new-inquiry': 'New Inquiry', contacted: 'Contacted', booked: 'Booked', visited: 'Visited',
  'follow-up': 'Follow-up', retained: 'Retained', lost: 'Lost',
});

/** Stages that are still in play — neither won nor written off. */
export const GROWTH_CLOSED_STAGES = Object.freeze(['retained', 'lost'] as const);

/** Stages a "going cold" warning applies to (src/components/crm/PipelineBoard.tsx:20). */
export const GROWTH_GOING_COLD_STAGES = Object.freeze(['new-inquiry', 'contacted'] as const);

/** Lifecycle stages the recoverable-value assumption is applied to. */
export const GROWTH_INACTIVE_LIFECYCLE_STAGES = Object.freeze(['INACTIVE', 'AT_RISK', 'LOST'] as const);

/** `missedCallValue` counts uncontacted inbound callers only. */
export const GROWTH_MISSED_CALL_CHANNEL = 'CALL';
export const GROWTH_MISSED_CALL_STAGE: GrowthLeadStage = 'new-inquiry';

export const GROWTH_LEAD_SCORE_WEIGHTS: GrowthLeadScoreWeights = Object.freeze({
  // src/lib/crmService.ts:84 — STAGE_INTENT, value for value.
  stageIntent: Object.freeze({
    'new-inquiry': 20, contacted: 40, booked: 70, visited: 80, 'follow-up': 55, retained: 90, lost: 0,
  }),
  // src/lib/crmService.ts:88,95 — `intent * 0.4`.
  stageIntentMultiplier: 0.4,
  // src/lib/crmService.ts:88 — `positive: intent >= 40`.
  stageIntentPositiveMin: 40,
  // src/lib/crmService.ts:89 — `(estimatedValue / maxValue) * 30`.
  valueWeight: 30,
  // src/lib/crmService.ts:90 — `positive: valueScore >= 12`.
  valuePositiveMin: 12,
  // src/lib/crmService.ts:92 — `<= 2 ? 20 : <= 7 ? 12 : <= 30 ? 4 : 0`.
  recencyBuckets: Object.freeze([
    Object.freeze({ maxAgeDays: 2, weight: 20, label: 'Fresh inquiry (< 48h)' }),
    Object.freeze({ maxAgeDays: 7, weight: 12 }),
    Object.freeze({ maxAgeDays: 30, weight: 4 }),
  ]),
  // src/lib/crmService.ts:93 — `positive: recency >= 12`.
  recencyPositiveMin: 12,
  // src/lib/crmService.ts:94-95 — `['whatsapp', 'sms'].includes(...)` worth 8.
  reachableChannels: Object.freeze(['whatsapp', 'sms']),
  reachableChannelWeight: 8,
  // src/lib/crmService.ts:95 — `Math.max(0, Math.min(100, ...))`.
  minScore: 0,
  maxScore: 100,
});

export type GrowthNextBestAction = { label: string; cta: string };

/** src/lib/crmService.ts:99-107 — NBA, stage for stage. */
export const GROWTH_NEXT_BEST_ACTION: Readonly<Record<GrowthLeadStage, GrowthNextBestAction>> = Object.freeze({
  'new-inquiry': Object.freeze({ label: 'Call now & send booking link', cta: 'call_now' }),
  contacted: Object.freeze({ label: 'Send booking link', cta: 'send_booking_link' }),
  booked: Object.freeze({ label: 'Send intake form + deposit link', cta: 'send_intake_form' }),
  visited: Object.freeze({ label: 'Send follow-up to rebook', cta: 'send_follow_up' }),
  'follow-up': Object.freeze({ label: 'Confirm next visit', cta: 'confirm_visit' }),
  retained: Object.freeze({ label: 'Nurture & request review', cta: 'mark_retained' }),
  lost: Object.freeze({ label: 'Launch winback', cta: 'launch_winback' }),
});

/** src/lib/crmService.ts:129 — the two review-timing planning strings. */
export const GROWTH_REVIEW_TIMING = Object.freeze({
  maxPromptAgeDays: 1,
  prompt: 'Planning assumption: prompt review now',
  staffedHours: 'Planning assumption: review during staffed hours',
});

/** src/lib/crmService.ts:206 — the notice every planning number carries. */
export const GROWTH_ASSUMPTION_NOTICE =
  'Unvalidated planning assumptions only; not a forecast or consent decision.';
