import type { Prisma } from '../../generated/prisma/client';
import { db } from '../../lib/db';
import {
  GROWTH_CHANNEL_COST_DEFAULTS,
  GROWTH_POLICY_DEFAULTS,
  GROWTH_SEGMENT_DEFAULTS,
  type GrowthChannelCostValues,
  type GrowthPolicyValues,
  type GrowthSegmentDefinitionValues,
} from './defaults';

// ===========================================================================
// Growth configuration service.
//
// Resolution contract, identical to SchedulingPolicy's: a tenant with no stored
// configuration resolves to the code defaults, which are today's constants, so
// absence never changes behaviour. The first write materialises the baseline
// rows and from then on the table is the truth — otherwise deleting a segment
// would silently resurrect it from the defaults on the next read.
//
// Nothing outside this module and its tests reads any of this yet. Rewiring
// crmService.ts and the /v1/patients/summary counters is a later increment.
// ===========================================================================

type Client = Pick<typeof db, 'growthPolicy' | 'growthSegmentDefinition' | 'growthChannelCost'>;

export type ConfigSource = 'tenant' | 'default';

/** Prisma Decimal → JSON number, so the API contract is plain JSON. */
function toNumber(value: Prisma.Decimal | number): number {
  return typeof value === 'number' ? value : value.toNumber();
}

export type EffectiveGrowthPolicy = GrowthPolicyValues & {
  source: ConfigSource;
  updatedAt: Date | null;
};

export async function getEffectiveGrowthPolicy(tenantId: string, client: Client = db): Promise<EffectiveGrowthPolicy> {
  const row = await client.growthPolicy.findUnique({ where: { tenantId } });
  if (!row) return { ...GROWTH_POLICY_DEFAULTS, source: 'default', updatedAt: null };
  return {
    hotLeadScore: row.hotLeadScore,
    scoreBandHigh: row.scoreBandHigh,
    scoreBandMid: row.scoreBandMid,
    goingColdDays: row.goingColdDays,
    churnRiskHigh: row.churnRiskHigh,
    highValuePatientLtv: toNumber(row.highValuePatientLtv),
    recoverableLtvFraction: toNumber(row.recoverableLtvFraction),
    inactiveAudienceDays: row.inactiveAudienceDays,
    maxAudienceSize: row.maxAudienceSize,
    slotFillHorizonDays: row.slotFillHorizonDays,
    reviewRatingGood: toNumber(row.reviewRatingGood),
    reviewRatingFair: toNumber(row.reviewRatingFair),
    reputationRiskHigh: row.reputationRiskHigh,
    reputationRiskMedium: row.reputationRiskMedium,
    competitorRatingHighSeverityMax: toNumber(row.competitorRatingHighSeverityMax),
    competitorRatingMediumSeverityMax: toNumber(row.competitorRatingMediumSeverityMax),
    competitorReviewVolumeHigh: row.competitorReviewVolumeHigh,
    leadSendCooldownHours: row.leadSendCooldownHours,
    source: 'tenant',
    updatedAt: row.updatedAt,
  };
}

export type EffectiveSegmentDefinition = GrowthSegmentDefinitionValues & { source: ConfigSource };

export async function listEffectiveSegmentDefinitions(tenantId: string, client: Client = db): Promise<EffectiveSegmentDefinition[]> {
  const rows = await client.growthSegmentDefinition.findMany({
    where: { tenantId },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });
  if (rows.length === 0) return GROWTH_SEGMENT_DEFAULTS.map(d => ({ ...d, source: 'default' as const }));
  return rows.map(row => ({
    key: row.key,
    label: row.label,
    description: row.description,
    minInactiveDays: row.minInactiveDays,
    maxInactiveDays: row.maxInactiveDays,
    includeNeverVisited: row.includeNeverVisited,
    minLifetimeValue: row.minLifetimeValue === null ? null : toNumber(row.minLifetimeValue),
    minChurnRisk: row.minChurnRisk,
    requiredTag: row.requiredTag,
    suggestedChannel: row.suggestedChannel,
    plannedOffer: row.plannedOffer,
    assumedBookingRatePct: row.assumedBookingRatePct,
    active: row.active,
    sortOrder: row.sortOrder,
    source: 'tenant' as const,
  }));
}

export type EffectiveChannelCost = GrowthChannelCostValues & { source: ConfigSource };

export async function listEffectiveChannelCosts(tenantId: string, client: Client = db): Promise<EffectiveChannelCost[]> {
  const rows = await client.growthChannelCost.findMany({ where: { tenantId }, orderBy: { channel: 'asc' } });
  if (rows.length === 0) return GROWTH_CHANNEL_COST_DEFAULTS.map(d => ({ ...d, source: 'default' as const }));
  return rows.map(row => ({
    channel: row.channel,
    unitCostMinor: row.unitCostMinor,
    currency: row.currency,
    source: 'tenant' as const,
  }));
}

/**
 * Persist the code defaults for a tenant that has never stored any. Called
 * before the first write so an edit is applied to a complete, visible baseline
 * rather than to an empty table that silently falls back to code.
 */
export async function materializeSegmentDefaults(tenantId: string, client: Client = db): Promise<number> {
  const existing = await client.growthSegmentDefinition.count({ where: { tenantId } });
  if (existing > 0) return 0;
  const created = await client.growthSegmentDefinition.createMany({
    data: GROWTH_SEGMENT_DEFAULTS.map(d => ({ tenantId, ...d })),
    skipDuplicates: true,
  });
  return created.count;
}

export async function materializeChannelCostDefaults(tenantId: string, client: Client = db): Promise<number> {
  const existing = await client.growthChannelCost.count({ where: { tenantId } });
  if (existing > 0) return 0;
  const created = await client.growthChannelCost.createMany({
    data: GROWTH_CHANNEL_COST_DEFAULTS.map(d => ({ tenantId, ...d })),
    skipDuplicates: true,
  });
  return created.count;
}
