import {
  GROWTH_CLOSED_STAGES,
  GROWTH_GOING_COLD_STAGES,
  GROWTH_LEAD_SCORE_WEIGHTS,
  GROWTH_LEAD_STAGES,
  GROWTH_NEXT_BEST_ACTION,
  GROWTH_REVIEW_TIMING,
  GROWTH_STAGE_LABEL,
  type GrowthLeadScoreWeights,
  type GrowthLeadStage,
  type GrowthNextBestAction,
} from './defaults';
import type { EffectiveGrowthPolicy } from './service';

// ===========================================================================
// Lead scoring — moved out of the browser.
//
// This is the SAME arithmetic src/lib/crmService.ts:84-97 ran, with three
// differences that are the point of moving it:
//
//   1. `maxValue` is a tenant-wide `MAX("estimatedValue")`, not the maximum of
//      whichever hundred rows the browser happened to load. A lead's score no
//      longer changes because a bigger lead arrived on the same page.
//   2. Every threshold is read from GrowthPolicy (`hotLeadScore`, `scoreBand*`,
//      `goingColdDays`) and every weight from GROWTH_LEAD_SCORE_WEIGHTS, so a
//      tenant that retunes its policy retunes its scores.
//   3. `Lead.stage` is a free-text column, not an enum. The browser did
//      `STAGE_INTENT[stage]` on it, so a stage outside the seven — 'consult-booked'
//      exists in this codebase's own test data — produced `NaN` and rendered the
//      literal string "NaN" as a lead's priority. Here it produces a null score
//      and a stated reason, and the UI shows the absence.
//
// Nothing is persisted. Scores are computed on read.
// ===========================================================================

const DAY_MS = 86_400_000;

export type ScoreDriver = { label: string; positive: boolean; weight: number };
export type ScoreBand = 'high' | 'medium' | 'low' | 'unscored';

export type ScorableLead = {
  stage: string;
  estimatedValue: number;
  createdAt: Date;
  channel: string;
};

export type LeadScoreResult = {
  stage: GrowthLeadStage | null;
  stageLabel: string | null;
  ageDays: number;
  score: number | null;
  scoreBand: ScoreBand;
  scoreDrivers: ScoreDriver[];
  scoreUnavailableReason: string | null;
  hot: boolean;
  goingCold: boolean;
  open: boolean;
  nextBestAction: GrowthNextBestAction | null;
  bestTime: string;
};

export type ScoringContext = {
  /** Tenant-wide `MAX("estimatedValue")`, floored at 1 exactly as the browser did. */
  maxValue: number;
  policy: EffectiveGrowthPolicy;
  now: Date;
  weights?: GrowthLeadScoreWeights;
};

const KNOWN_STAGES = new Set<string>(GROWTH_LEAD_STAGES);
const CLOSED = new Set<string>(GROWTH_CLOSED_STAGES);
const GOING_COLD = new Set<string>(GROWTH_GOING_COLD_STAGES);

export function asLeadStage(stage: string): GrowthLeadStage | null {
  return KNOWN_STAGES.has(stage) ? stage as GrowthLeadStage : null;
}

/** Open = still in play. Unknown stages are treated as open: they are not won and not written off. */
export function isOpenStage(stage: string): boolean {
  return !CLOSED.has(stage);
}

export function ageInDays(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS));
}

/**
 * The tenant-wide value denominator. `Math.max(1, ...)` reproduces
 * src/lib/crmService.ts:116, which floored the denominator at 1 so a tenant
 * whose every lead is worth 0 scores 0 rather than dividing by zero.
 */
export function valueDenominator(tenantMaxEstimatedValue: number | null): number {
  return Math.max(1, tenantMaxEstimatedValue ?? 0);
}

export function bandFor(score: number, policy: EffectiveGrowthPolicy): ScoreBand {
  if (score >= policy.scoreBandHigh) return 'high';
  if (score >= policy.scoreBandMid) return 'medium';
  return 'low';
}

export function scoreLead(lead: ScorableLead, context: ScoringContext): LeadScoreResult {
  const weights = context.weights ?? GROWTH_LEAD_SCORE_WEIGHTS;
  const ageDays = ageInDays(lead.createdAt, context.now);
  const stage = asLeadStage(lead.stage);
  const open = isOpenStage(lead.stage);

  if (!stage) {
    // No fabricated priority. The stage is not one this heuristic knows, so
    // there is no score, no band, and no suggested action — and the reason says
    // so in the words an operator needs to fix the data.
    return {
      stage: null,
      stageLabel: null,
      ageDays,
      score: null,
      scoreBand: 'unscored',
      scoreDrivers: [],
      scoreUnavailableReason:
        `Recorded stage "${lead.stage}" is not one of the ${GROWTH_LEAD_STAGES.length} pipeline stages, so no planning priority can be derived from it.`,
      hot: false,
      goingCold: false,
      open,
      nextBestAction: null,
      bestTime: bestTimeFor(ageDays),
    };
  }

  const intent = weights.stageIntent[stage] ?? 0;
  const drivers: ScoreDriver[] = [];

  const stageWeight = Math.round(intent * weights.stageIntentMultiplier);
  drivers.push({
    label: `Pipeline stage: ${GROWTH_STAGE_LABEL[stage]}`,
    positive: intent >= weights.stageIntentPositiveMin,
    weight: stageWeight,
  });

  const denominator = context.maxValue;
  const valueScore = denominator > 0 ? Math.round((lead.estimatedValue / denominator) * weights.valueWeight) : 0;
  drivers.push({
    label: `Estimated value ${lead.estimatedValue}`,
    positive: valueScore >= weights.valuePositiveMin,
    weight: valueScore,
  });

  const bucket = weights.recencyBuckets.find(candidate => ageDays <= candidate.maxAgeDays);
  const recency = bucket?.weight ?? 0;
  drivers.push({
    label: bucket?.label ?? `Inquiry age ${ageDays}d`,
    positive: recency >= weights.recencyPositiveMin,
    weight: recency,
  });

  const reachable = weights.reachableChannels.includes(lead.channel.toLowerCase());
  const channelBonus = reachable ? weights.reachableChannelWeight : 0;
  if (reachable) {
    drivers.push({ label: `Reachable channel (${lead.channel})`, positive: true, weight: channelBonus });
  }

  const raw = intent * weights.stageIntentMultiplier + valueScore + recency + channelBonus;
  const score = Math.max(weights.minScore, Math.min(weights.maxScore, Math.round(raw)));

  return {
    stage,
    stageLabel: GROWTH_STAGE_LABEL[stage],
    ageDays,
    score,
    scoreBand: bandFor(score, context.policy),
    scoreDrivers: drivers,
    scoreUnavailableReason: null,
    hot: score >= context.policy.hotLeadScore,
    goingCold: ageDays > context.policy.goingColdDays && GOING_COLD.has(stage),
    open,
    nextBestAction: GROWTH_NEXT_BEST_ACTION[stage],
    bestTime: bestTimeFor(ageDays),
  };
}

function bestTimeFor(ageDays: number): string {
  return ageDays <= GROWTH_REVIEW_TIMING.maxPromptAgeDays
    ? GROWTH_REVIEW_TIMING.prompt
    : GROWTH_REVIEW_TIMING.staffedHours;
}
