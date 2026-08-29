import { Prisma } from '../../generated/prisma/client';
import { db } from '../../lib/db';
import {
  GROWTH_ASSUMPTION_NOTICE,
  GROWTH_CLOSED_STAGES,
  GROWTH_INACTIVE_LIFECYCLE_STAGES,
  GROWTH_LEAD_STAGES,
  GROWTH_MISSED_CALL_CHANNEL,
  GROWTH_MISSED_CALL_STAGE,
  GROWTH_STAGE_LABEL,
} from './defaults';
import {
  asLeadStage,
  scoreLead,
  valueDenominator,
  type LeadScoreResult,
} from './scoring';
import type { GrowthLeadStage } from './defaults';
import type { EffectiveChannelCost, EffectiveGrowthPolicy, EffectiveSegmentDefinition } from './service';

// ===========================================================================
// Growth metrics, computed over the WHOLE tenant.
//
// What this replaces: src/lib/crmService.ts fetched `/v1/leads?limit=100` and
// `/v1/patients?limit=100` — the server caps `limit` at 100 and orders patients
// by `id: 'asc'`, i.e. by UUID — threw away `nextCursor`, and then averaged the
// result. "Avg churn risk 49%" and "Avg LTV $363" were averages of an arbitrary
// hundred rows, printed with no qualification. At a thousand patients every
// currency and percentage on the CRM Command View was wrong and nothing on the
// screen said so.
//
// Here the sums, counts and averages are database aggregates over every row the
// caller is entitled to see, and the response states its own scope.
//
// SCOPE, stated honestly rather than assumed:
//   * Patient is branch-scoped exactly as server/modules/patients/routes.ts:193
//     does — `branchScope(request)` narrows a branch-restricted user.
//   * Lead HAS NO branchId COLUMN. `GET /v1/leads` has always returned every
//     lead in the tenant to every entitled caller, and the pipeline board that
//     reads it is tenant-wide. Silently narrowing lead figures here (through the
//     optional patient relation, say) would make the Command View disagree with
//     the board beside it. The scope is reported instead of guessed.
//
// PRECISION: the browser rounded PER PATIENT and then summed
// (`reduce((s, p) => s + Math.round(p.lifetimeValue * fraction), 0)`).
// SUM(ROUND(x)) and ROUND(SUM(x)) are not the same number, so the SQL rounds per
// row too. The fraction itself always comes from GrowthPolicy.
// ===========================================================================

/** Rows read per batch while scoring the tenant's open leads. */
const LEAD_SCAN_BATCH = 1_000;

/**
 * The runtime Prisma client. `server/lib/db.ts` proxies every model call so that,
 * with a request's tenant context active, it runs in a short transaction with the
 * RLS GUCs set — the same isolation `runWithTenantContext` provides, without
 * holding one interactive transaction open for the whole lead scan. Injectable so
 * a unit test can hand in a recorder and assert the `where` clauses.
 */
export type GrowthDbClient = Pick<typeof db, 'lead' | 'patient' | '$queryRaw'>;

export type MetricScope = 'tenant' | 'assigned_branch';

export type GrowthMetricValues = {
  openPipeline: number;
  hotLeads: number;
  winRate: number | null;
  avgDeal: number | null;
  avgChurnRisk: number | null;
  avgLtv: number | null;
  missedCallValue: number;
  inactiveRecoverable: number;
  campaignRoi: number | null;
};

export type GrowthMetricsResult = {
  asOf: string;
  scope: {
    patients: MetricScope;
    leads: MetricScope;
    branchId: string | null;
    note: string;
  };
  basis: {
    leadCount: number;
    openLeadCount: number;
    closedLeadCount: number;
    patientCount: number;
    inactivePatientCount: number;
    unscoredLeadCount: number;
    truncated: false;
  };
  metrics: GrowthMetricValues;
  /** One entry per metric that could not be computed, saying why. Never a zero standing in for a gap. */
  unavailable: Record<string, string>;
  policy: GrowthPolicyEcho;
};

/** The configuration the numbers were produced with, so the UI renders disclosures from data. */
export type GrowthPolicyEcho = {
  source: EffectiveGrowthPolicy['source'];
  hotLeadScore: number;
  scoreBandHigh: number;
  scoreBandMid: number;
  goingColdDays: number;
  churnRiskHigh: number;
  highValuePatientLtv: number;
  recoverableLtvFraction: number;
  recoverableLtvPercent: number;
};

export function policyEcho(policy: EffectiveGrowthPolicy): GrowthPolicyEcho {
  return {
    source: policy.source,
    hotLeadScore: policy.hotLeadScore,
    scoreBandHigh: policy.scoreBandHigh,
    scoreBandMid: policy.scoreBandMid,
    goingColdDays: policy.goingColdDays,
    churnRiskHigh: policy.churnRiskHigh,
    highValuePatientLtv: policy.highValuePatientLtv,
    recoverableLtvFraction: policy.recoverableLtvFraction,
    recoverableLtvPercent: Math.round(policy.recoverableLtvFraction * 100),
  };
}

/** The `Channel` enum value inbound phone leads carry. */
const MISSED_CALL_CHANNEL = GROWTH_MISSED_CALL_CHANNEL as Prisma.LeadWhereInput['channel'];

function stageLabel(stage: string): string | null {
  const known = asLeadStage(stage);
  return known === null ? null : GROWTH_STAGE_LABEL[known];
}

const LEAD_SCOPE_NOTE =
  'Patient figures follow your branch assignment. Lead figures are tenant-wide because a lead record carries no branch.';

const decimalToNumber = (value: Prisma.Decimal | number | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : value.toNumber();

const nullableDecimal = (value: Prisma.Decimal | number | null): number | null =>
  value === null ? null : typeof value === 'number' ? value : value.toNumber();

export type GrowthScopeInput = { tenantId: string; branchId: string | null };

function patientWhere(scope: GrowthScopeInput): Prisma.PatientWhereInput {
  return {
    tenantId: scope.tenantId,
    deletedAt: null,
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
  };
}

/**
 * Leads are read with `deletedAt: null`. `GET /v1/leads` omits that filter, so a
 * soft-deleted lead still shows on the pipeline board today; nothing in the
 * codebase sets the column, so this changes no live number, and the list and the
 * metrics agreeing matters more than bug-for-bug fidelity with a dead branch.
 */
function leadWhere(scope: GrowthScopeInput): Prisma.LeadWhereInput {
  return { tenantId: scope.tenantId, deletedAt: null };
}

/** Tenant-wide `MAX("estimatedValue")` — the stable denominator for every lead score. */
export async function tenantMaxLeadValue(scope: GrowthScopeInput, client: GrowthDbClient): Promise<number> {
  const row = await client.lead.aggregate({ where: leadWhere(scope), _max: { estimatedValue: true } });
  return valueDenominator(nullableDecimal(row._max.estimatedValue));
}

export type ScoredLeadRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  channel: string;
  service: string;
  /** The stage EXACTLY as recorded, including one the heuristic does not know. */
  stage: string;
  /** The same stage once recognised, or null when the recorded value is not one of the seven. */
  knownStage: GrowthLeadStage | null;
  source: string;
  estimatedValue: number;
  createdAt: Date;
  patientId: string | null;
} & Omit<LeadScoreResult, 'stage'>;

type LeadScanColumns = {
  id: string;
  stage: string;
  estimatedValue: Prisma.Decimal;
  createdAt: Date;
  channel: string;
};

export type LeadScanResult = {
  hotLeads: number;
  unscored: number;
  scanned: number;
  /** Tenant-wide highest-scoring OPEN leads, not the top of whatever page loaded. */
  priority: LeadScanColumns[];
};

/**
 * Score every open lead in the tenant and keep the hot count plus the top N.
 *
 * Deliberately a batched scan rather than a second copy of the formula in SQL:
 * `hotLeads` and the per-lead score a clinician reads have to be the same
 * arithmetic, and the only way to guarantee that is for there to be one
 * implementation. Memory stays bounded at one batch plus the top-N buffer.
 */
export async function scanOpenLeadScores(
  scope: GrowthScopeInput,
  client: GrowthDbClient,
  context: { maxValue: number; policy: EffectiveGrowthPolicy; now: Date },
  topN: number,
): Promise<LeadScanResult> {
  const where: Prisma.LeadWhereInput = {
    ...leadWhere(scope),
    stage: { notIn: [...GROWTH_CLOSED_STAGES] },
  };

  let cursor: string | undefined;
  let hotLeads = 0;
  let unscored = 0;
  let scanned = 0;
  const priority: Array<{ row: LeadScanColumns; score: number }> = [];

  for (;;) {
    const batch = await client.lead.findMany({
      where,
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: LEAD_SCAN_BATCH,
      select: { id: true, stage: true, estimatedValue: true, createdAt: true, channel: true },
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      scanned += 1;
      const result = scoreLead(
        {
          stage: row.stage,
          estimatedValue: decimalToNumber(row.estimatedValue),
          createdAt: row.createdAt,
          channel: row.channel,
        },
        context,
      );
      if (result.score === null) { unscored += 1; continue; }
      if (result.hot) hotLeads += 1;
      priority.push({ row, score: result.score });
    }
    // Keeping the buffer trimmed is what makes this O(batch + topN) rather than
    // O(tenant) — the thing the browser got wrong in the first place.
    priority.sort((a, b) => b.score - a.score);
    priority.length = Math.min(priority.length, topN);

    cursor = batch.at(-1)?.id;
    if (batch.length < LEAD_SCAN_BATCH) break;
  }

  return { hotLeads, unscored, scanned, priority: priority.map(entry => entry.row) };
}

export async function computeGrowthMetrics(
  scope: GrowthScopeInput,
  policy: EffectiveGrowthPolicy,
  now: Date,
  client: GrowthDbClient = db,
): Promise<GrowthMetricsResult> {
  const leads = leadWhere(scope);
  const patients = patientWhere(scope);
  const openStageFilter: Prisma.LeadWhereInput = { ...leads, stage: { notIn: [...GROWTH_CLOSED_STAGES] } };

  // Every figure below is an aggregate over the whole scoped table. Nothing here
  // reads a page.
  const openAggregate = await client.lead.aggregate({ where: openStageFilter, _sum: { estimatedValue: true }, _count: { _all: true } });
  const stageGroups = await client.lead.groupBy({ by: ['stage'], where: leads, _count: { _all: true } });
  const missedCall = await client.lead.aggregate({
    where: { ...leads, channel: MISSED_CALL_CHANNEL, stage: GROWTH_MISSED_CALL_STAGE },
    _sum: { estimatedValue: true },
  });
  const maxValue = await tenantMaxLeadValue(scope, client);
  // `_sum` + `_count` rather than `_avg`: the browser computed `round(sum / n)`,
  // and asking Postgres for the mean instead would change the last digit of a
  // number a clinic reads as a percentage.
  const patientAggregate = await client.patient.aggregate({
    where: patients,
    _count: { _all: true },
    _sum: { churnRisk: true, lifetimeValue: true },
  });
  const lifecycleGroups = await client.patient.groupBy({ by: ['lifecycleStage'], where: patients, _count: { _all: true } });
  const scan = await scanOpenLeadScores(scope, client, { maxValue, policy, now }, 0);
  const inactiveRecoverable = await sumRecoverableValue(client, scope, policy.recoverableLtvFraction);
  const computed = { openAggregate, stageGroups, missedCall, patientAggregate, lifecycleGroups, scan, inactiveRecoverable };

  const stageCount = (stage: string) =>
    computed.stageGroups.find(row => row.stage === stage)?._count._all ?? 0;

  const won = stageCount('retained');
  const lost = stageCount('lost');
  const decided = won + lost;
  const leadCount = computed.stageGroups.reduce((sum, row) => sum + row._count._all, 0);
  const openCount = computed.openAggregate._count._all;
  const openValue = decimalToNumber(computed.openAggregate._sum.estimatedValue);

  const patientCount = computed.patientAggregate._count._all;
  const churnSum = computed.patientAggregate._sum.churnRisk ?? 0;
  const ltvSum = decimalToNumber(computed.patientAggregate._sum.lifetimeValue);
  const inactivePatientCount = computed.lifecycleGroups
    .filter(row => (GROWTH_INACTIVE_LIFECYCLE_STAGES as readonly string[]).includes(row.lifecycleStage))
    .reduce((sum, row) => sum + row._count._all, 0);

  const unavailable: Record<string, string> = {};
  if (decided === 0) {
    unavailable.winRate = 'No lead has reached retained or lost yet, so there is no won/lost ratio to report.';
  }
  if (openCount === 0) {
    unavailable.avgDeal = 'There are no open leads, so an average open-lead value cannot be computed.';
  }
  if (patientCount === 0) {
    unavailable.avgChurnRisk = 'No patient records are in scope, so an average churn risk cannot be computed.';
    unavailable.avgLtv = 'No patient records are in scope, so an average lifetime value cannot be computed.';
  }
  unavailable.campaignRoi =
    'Campaign return on investment is not derived from any recorded spend, so it is not reported.';

  return {
    asOf: now.toISOString(),
    scope: {
      patients: scope.branchId ? 'assigned_branch' : 'tenant',
      leads: 'tenant',
      branchId: scope.branchId,
      note: LEAD_SCOPE_NOTE,
    },
    basis: {
      leadCount,
      openLeadCount: openCount,
      closedLeadCount: decided,
      patientCount,
      inactivePatientCount,
      unscoredLeadCount: computed.scan.unscored,
      truncated: false,
    },
    metrics: {
      openPipeline: openValue,
      hotLeads: computed.scan.hotLeads,
      winRate: decided > 0 ? Math.round((won / decided) * 100) : null,
      avgDeal: openCount > 0 ? Math.round(openValue / openCount) : null,
      avgChurnRisk: patientCount > 0 ? Math.round(churnSum / patientCount) : null,
      avgLtv: patientCount > 0 ? Math.round(ltvSum / patientCount) : null,
      missedCallValue: decimalToNumber(computed.missedCall._sum.estimatedValue),
      inactiveRecoverable: computed.inactiveRecoverable,
      campaignRoi: null,
    },
    unavailable,
    policy: policyEcho(policy),
  };
}

/**
 * SUM(ROUND(lifetimeValue x fraction)) over the inactive lifecycle stages.
 *
 * Per-row rounding, matching what the browser did. The fraction is bound as text
 * so Postgres parses it as an exact `numeric` instead of receiving a float and
 * introducing drift into a figure a clinic reads as money.
 */
async function sumRecoverableValue(
  client: GrowthDbClient,
  scope: GrowthScopeInput,
  fraction: number,
): Promise<number> {
  const rows = await client.$queryRaw<Array<{ recoverable: string }>>`
    SELECT COALESCE(SUM(ROUND(p."lifetimeValue" * ${String(fraction)}::numeric)), 0)::text AS recoverable
    FROM "Patient" p
    WHERE p."tenantId" = ${scope.tenantId}::uuid
      AND p."deletedAt" IS NULL
      AND (${scope.branchId}::uuid IS NULL OR p."branchId" = ${scope.branchId}::uuid)
      AND p."lifecycleStage"::text IN (${Prisma.join([...GROWTH_INACTIVE_LIFECYCLE_STAGES])})
  `;
  return Number(rows[0]?.recoverable ?? 0);
}

// ---------------------------------------------------------------------------
// Smart segments
// ---------------------------------------------------------------------------

export type SegmentPreview = {
  key: string;
  label: string;
  description: string;
  patientCount: number;
  recoverableValue: number;
  planningChannel: string;
  planningOffer: string;
  planningBookingRatePct: number;
  plannedCostMinor: number | null;
  currency: string | null;
  costUnavailableReason: string | null;
  /** Membership criteria, echoed so a card can explain itself without hardcoding them. */
  criteria: {
    minInactiveDays: number | null;
    maxInactiveDays: number | null;
    includeNeverVisited: boolean;
    minLifetimeValue: number | null;
    minChurnRisk: number | null;
    requiredTag: string | null;
  };
  /**
   * Patients that meet every other criterion but have NO recorded last visit.
   * The browser mapped a null last visit to a far-future day-count sentinel,
   * which silently failed the upper bound of all three inactive-day windows —
   * those groups were unreachable for such a patient and nothing said so. The
   * exclusion is now the `includeNeverVisited` flag, and this is the population
   * it is excluding.
   */
  neverVisitedCandidates: number;
  source: EffectiveSegmentDefinition['source'];
  assumptionNotice: string;
};

export type SegmentPreviewResult = {
  asOf: string;
  scope: { patients: MetricScope; branchId: string | null };
  segments: SegmentPreview[];
  policy: GrowthPolicyEcho;
};

export async function previewGrowthSegments(
  scope: GrowthScopeInput,
  policy: EffectiveGrowthPolicy,
  definitions: EffectiveSegmentDefinition[],
  channelCosts: EffectiveChannelCost[],
  now: Date,
  client: GrowthDbClient = db,
): Promise<SegmentPreviewResult> {
  const active = definitions.filter(definition => definition.active);
  const costByChannel = new Map(channelCosts.map(cost => [cost.channel.toLowerCase(), cost]));

  const counted: Array<{ definition: EffectiveSegmentDefinition; members: number; recoverable: number; neverVisited: number }> = [];
  for (const definition of active) {
    const row = await countSegment(client, scope, definition, policy.recoverableLtvFraction, now);
    counted.push({ definition, ...row });
  }

  return {
    asOf: now.toISOString(),
    scope: { patients: scope.branchId ? 'assigned_branch' : 'tenant', branchId: scope.branchId },
    segments: counted.map(({ definition, members, recoverable, neverVisited }) => {
      const cost = costByChannel.get(definition.suggestedChannel.toLowerCase());
      return {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        patientCount: members,
        recoverableValue: recoverable,
        planningChannel: definition.suggestedChannel,
        planningOffer: definition.plannedOffer,
        planningBookingRatePct: definition.assumedBookingRatePct,
        plannedCostMinor: cost ? members * cost.unitCostMinor : null,
        currency: cost?.currency ?? null,
        costUnavailableReason: cost
          ? null
          : `No per-message cost is configured for ${definition.suggestedChannel}, so a planned spend cannot be stated.`,
        criteria: {
          minInactiveDays: definition.minInactiveDays,
          maxInactiveDays: definition.maxInactiveDays,
          includeNeverVisited: definition.includeNeverVisited,
          minLifetimeValue: definition.minLifetimeValue,
          minChurnRisk: definition.minChurnRisk,
          requiredTag: definition.requiredTag,
        },
        neverVisitedCandidates: neverVisited,
        source: definition.source,
        assumptionNotice: GROWTH_ASSUMPTION_NOTICE,
      };
    }),
    policy: policyEcho(policy),
  };
}

/**
 * One query per definition: member count, per-row-rounded recoverable value, and
 * the never-visited population the inactivity window is deciding about.
 */
async function countSegment(
  client: GrowthDbClient,
  scope: GrowthScopeInput,
  definition: EffectiveSegmentDefinition,
  fraction: number,
  now: Date,
): Promise<{ members: number; recoverable: number; neverVisited: number }> {
  // ISO string cast to `timestamp`, not a bound Date cast to `timestamptz`:
  // `Patient."lastVisitAt"` is TIMESTAMP(3) WITHOUT time zone holding UTC wall
  // time, so comparing it against a timestamptz would silently apply the
  // session's TimeZone and shift every window by the server's offset.
  const nowLiteral = Prisma.sql`${now.toISOString()}::timestamp`;
  const daysSinceVisit = Prisma.sql`floor(extract(epoch from (${nowLiteral} - p."lastVisitAt")) / 86400)`;

  const base: Prisma.Sql[] = [
    Prisma.sql`p."tenantId" = ${scope.tenantId}::uuid`,
    Prisma.sql`p."deletedAt" IS NULL`,
    Prisma.sql`(${scope.branchId}::uuid IS NULL OR p."branchId" = ${scope.branchId}::uuid)`,
  ];
  if (definition.minLifetimeValue !== null) {
    base.push(Prisma.sql`p."lifetimeValue" >= ${String(definition.minLifetimeValue)}::numeric`);
  }
  if (definition.minChurnRisk !== null) {
    base.push(Prisma.sql`p."churnRisk" >= ${definition.minChurnRisk}`);
  }
  if (definition.requiredTag !== null) {
    base.push(Prisma.sql`EXISTS (SELECT 1 FROM unnest(p.tags) AS tag WHERE lower(tag) = lower(${definition.requiredTag}))`);
  }

  const bounds: Prisma.Sql[] = [];
  if (definition.minInactiveDays !== null) bounds.push(Prisma.sql`${daysSinceVisit} >= ${definition.minInactiveDays}`);
  // Exclusive upper bound: today's 30–60 / 60–90 / 90–180 windows are [min, max).
  if (definition.maxInactiveDays !== null) bounds.push(Prisma.sql`${daysSinceVisit} < ${definition.maxInactiveDays}`);

  const visited = bounds.length > 0
    ? Prisma.sql`(p."lastVisitAt" IS NOT NULL AND ${Prisma.join(bounds, ' AND ')})`
    : Prisma.sql`p."lastVisitAt" IS NOT NULL`;
  const membership = definition.includeNeverVisited
    ? (bounds.length > 0 ? Prisma.sql`(p."lastVisitAt" IS NULL OR ${visited})` : Prisma.sql`TRUE`)
    : visited;

  const rows = await client.$queryRaw<Array<{ members: string; recoverable: string; never_visited: string }>>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE ${membership})::text AS members,
      COALESCE(SUM(ROUND(p."lifetimeValue" * ${String(fraction)}::numeric)) FILTER (WHERE ${membership}), 0)::text AS recoverable,
      count(*) FILTER (WHERE p."lastVisitAt" IS NULL)::text AS never_visited
    FROM "Patient" p
    WHERE ${Prisma.join(base, ' AND ')}
  `);

  const row = rows[0];
  return {
    members: Number(row?.members ?? 0),
    recoverable: Number(row?.recoverable ?? 0),
    neverVisited: Number(row?.never_visited ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Scored lead list
// ---------------------------------------------------------------------------

export type StageTotal = { stage: string; known: boolean; label: string | null; count: number; value: number };

export type ScoredLeadListResult = {
  asOf: string;
  scope: { leads: MetricScope; branchId: string | null; note: string };
  data: ScoredLeadRow[];
  /** Honest truncation contract: what was asked for, what came back, and how much exists. */
  limit: number;
  returned: number;
  total: number;
  truncated: boolean;
  /** Tenant-wide per-stage counts and value. The board no longer sums a page. */
  stageTotals: StageTotal[];
  /** Tenant-wide highest-priority open leads, not the top of the loaded page. */
  priority: ScoredLeadRow[];
  maxEstimatedValue: number;
  policy: GrowthPolicyEcho;
};

const LEAD_SELECT = {
  id: true, name: true, phone: true, email: true, channel: true, service: true,
  stage: true, source: true, estimatedValue: true, createdAt: true, patientId: true,
} as const;

type LeadRow = {
  id: string; name: string; phone: string | null; email: string | null;
  channel: string; service: string; stage: string; source: string;
  estimatedValue: Prisma.Decimal; createdAt: Date; patientId: string | null;
};

function toScoredRow(row: LeadRow, context: { maxValue: number; policy: EffectiveGrowthPolicy; now: Date }): ScoredLeadRow {
  const estimatedValue = decimalToNumber(row.estimatedValue);
  const { stage: knownStage, ...scored } = scoreLead(
    { stage: row.stage, estimatedValue, createdAt: row.createdAt, channel: row.channel },
    context,
  );
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    channel: row.channel,
    service: row.service,
    stage: row.stage,
    knownStage,
    source: row.source,
    estimatedValue,
    createdAt: row.createdAt,
    patientId: row.patientId,
    ...scored,
  };
}

export async function listScoredLeads(
  scope: GrowthScopeInput,
  policy: EffectiveGrowthPolicy,
  now: Date,
  options: { limit: number; priorityLimit: number },
  client: GrowthDbClient = db,
): Promise<ScoredLeadListResult> {
  const where = leadWhere(scope);

  const maxValue = await tenantMaxLeadValue(scope, client);
  const rows = await client.lead.findMany({
    where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: options.limit, select: LEAD_SELECT,
  });
  const total = await client.lead.count({ where });
  // Tenant-wide per-stage count and value. The board used to sum the loaded page,
  // so a lane header reported the value of whichever leads happened to arrive.
  const stageGroups = await client.lead.groupBy({ by: ['stage'], where, _count: { _all: true }, _sum: { estimatedValue: true } });
  const scan = await scanOpenLeadScores(scope, client, { maxValue, policy, now }, options.priorityLimit);
  const priorityRows = scan.priority.length === 0
    ? []
    : await client.lead.findMany({ where: { ...where, id: { in: scan.priority.map(row => row.id) } }, select: LEAD_SELECT });
  const loaded = { maxValue, rows, total, stageGroups, priorityRows };

  const context = { maxValue: loaded.maxValue, policy, now };
  const priority = loaded.priorityRows
    .map(row => toScoredRow(row as LeadRow, context))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const stageTotals: StageTotal[] = loaded.stageGroups.map(group => ({
    stage: group.stage,
    known: asLeadStage(group.stage) !== null,
    label: stageLabel(group.stage),
    count: group._count._all,
    value: decimalToNumber(group._sum.estimatedValue),
  }));
  // Every board column exists even when empty, so a lane reads as "no leads"
  // rather than vanishing.
  for (const stage of GROWTH_LEAD_STAGES) {
    if (!stageTotals.some(total => total.stage === stage)) {
      stageTotals.push({ stage, known: true, label: GROWTH_STAGE_LABEL[stage], count: 0, value: 0 });
    }
  }

  return {
    asOf: now.toISOString(),
    scope: { leads: 'tenant', branchId: scope.branchId, note: LEAD_SCOPE_NOTE },
    data: loaded.rows.map(row => toScoredRow(row as LeadRow, context)),
    limit: options.limit,
    returned: loaded.rows.length,
    total: loaded.total,
    truncated: loaded.total > loaded.rows.length,
    stageTotals,
    priority,
    maxEstimatedValue: loaded.maxValue,
    policy: policyEcho(policy),
  };
}
