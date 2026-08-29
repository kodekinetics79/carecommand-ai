import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { getRequestPermissions, requirePermission } from '../../lib/permissions';
import { branchScope } from '../../lib/scope';
import { MONEY_AFFECTING_POLICY_FIELDS } from './defaults';
import {
  computeGrowthMetrics,
  listScoredLeads,
  previewGrowthSegments,
  type GrowthScopeInput,
} from './metrics';
import {
  getEffectiveGrowthPolicy,
  listEffectiveChannelCosts,
  listEffectiveSegmentDefinitions,
  materializeChannelCostDefaults,
  materializeSegmentDefaults,
} from './service';

// ===========================================================================
// Growth configuration API — the tenant-editable home for the Growth module's
// business rules.
//
// Authorization uses the action-permission layer, never a raw role list, so a
// tenant that re-cuts its roles through RoleDefinition re-cuts this surface too:
//   * read                 → settings:read   (OWNER/ADMIN/MANAGER/BILLING/PROVIDER/ANALYST)
//   * operational tuning   → settings:write  (OWNER/ADMIN/MANAGER)
//   * money-affecting      → settings:write AND admin:manage (OWNER/ADMIN)
//
// "Money-affecting" is not a vibe: it is highValuePatientLtv and
// recoverableLtvFraction (they move the recoverable-value headline and the
// high-value patient list) plus every channel cost (it moves planned spend). A
// MANAGER may tune an inactivity window; only an owner or admin may restate what
// a patient is worth.
//
// Nothing reads this configuration yet — the Growth module's call sites are
// rewired in a later increment. Landing the spine changes no observable number.
// ===========================================================================

const configRead = requirePermission('settings:read');
const configWrite = requirePermission('settings:write');

// The reporting surface is a patient-data read, so it takes the grant
// `GET /v1/leads` already requires — `crm:read` (OWNER/ADMIN/MANAGER/FRONT_DESK/
// ANALYST by default). No new permission name is invented, and a tenant that
// re-cuts crm:read through RoleDefinition re-cuts these three routes with it.
const growthRead = requirePermission('crm:read');

/**
 * Read gate for the policy document itself.
 *
 * These thresholds are the rules the product colours and classifies patient
 * data by, so anyone already entitled to see that data is entitled to see the
 * rule applied to it — reading the band is not settings administration. A
 * single `settings:read` guard regressed FRONT_DESK, which holds `crm:read`
 * without it and consequently lost the banded figures on /reviews; a straight
 * swap to `crm:read` would instead have cut off BILLING and PROVIDER, which
 * hold `settings:read` without `crm:read`. Either grant is therefore
 * sufficient. Writes stay administrative: `settings:write`, plus `admin:manage`
 * for the money-affecting fields.
 */
async function policyReadDenied(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const granted = await getRequestPermissions(request);
  if (granted.has('crm:read') || granted.has('settings:read')) return false;
  await reply.code(403).send({
    error: 'insufficient_permission',
    permission: 'crm:read',
    message: 'Reading the growth policy requires crm:read or settings:read.',
  });
  return true;
}

const MONEY_PERMISSION = 'admin:manage' as const;

/**
 * Second gate for money-affecting writes. Returns true when the reply has
 * already been sent (403), matching the shape requirePermission() produces so
 * clients see one error contract.
 */
async function deniedForMoneyFields(request: FastifyRequest, reply: FastifyReply, fields: string[]): Promise<boolean> {
  if (fields.length === 0) return false;
  const granted = await getRequestPermissions(request);
  if (granted.has(MONEY_PERMISSION)) return false;
  await reply.code(403).send({
    error: 'insufficient_permission',
    permission: MONEY_PERMISSION,
    fields,
    message: `Changing ${fields.join(', ')} affects reported patient value and planned spend, so it requires the ${MONEY_PERMISSION} permission.`,
  });
  return true;
}

const score = z.number().int().min(0).max(100);
const positiveDays = z.number().int().min(1).max(3650);
const rating = z.number().min(0).max(5);

const policyPatchSchema = z.object({
  hotLeadScore: score.optional(),
  scoreBandHigh: score.optional(),
  scoreBandMid: score.optional(),
  goingColdDays: positiveDays.optional(),
  churnRiskHigh: score.optional(),
  highValuePatientLtv: z.number().min(0).max(10_000_000).optional(),
  recoverableLtvFraction: z.number().min(0).max(1).optional(),
  inactiveAudienceDays: positiveDays.optional(),
  maxAudienceSize: z.number().int().min(1).max(1_000_000).optional(),
  slotFillHorizonDays: positiveDays.optional(),
  reviewRatingGood: rating.optional(),
  reviewRatingFair: rating.optional(),
  reputationRiskHigh: score.optional(),
  reputationRiskMedium: score.optional(),
  competitorRatingHighSeverityMax: rating.optional(),
  competitorRatingMediumSeverityMax: rating.optional(),
  competitorReviewVolumeHigh: z.number().int().min(0).max(1_000_000).optional(),
  leadSendCooldownHours: z.number().int().min(0).max(8760).optional(),
}).strict();

const segmentKey = z.string().min(2).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, 'key must be lowercase kebab-case');

const label = z.string().min(2).max(120);
const description = z.string().min(2).max(400);
const inactiveFloor = z.number().int().min(0).max(3650).nullable();
const inactiveCeiling = z.number().int().min(1).max(3650).nullable();
const lifetimeValue = z.number().min(0).max(10_000_000).nullable();
const tag = z.string().min(1).max(60).nullable();
const channelName = z.string().min(2).max(40);
const offer = z.string().min(2).max(200);
const bookingRatePct = z.number().int().min(0).max(100);
const sortOrder = z.number().int().min(0).max(1000);

const segmentCreateSchema = z.object({
  key: segmentKey,
  label,
  description,
  minInactiveDays: inactiveFloor.default(null),
  maxInactiveDays: inactiveCeiling.default(null),
  includeNeverVisited: z.boolean().default(false),
  minLifetimeValue: lifetimeValue.default(null),
  minChurnRisk: score.nullable().default(null),
  requiredTag: tag.default(null),
  suggestedChannel: channelName,
  plannedOffer: offer,
  assumedBookingRatePct: bookingRatePct.default(0),
  active: z.boolean().default(true),
  sortOrder: sortOrder.default(0),
}).strict();

// Written out rather than derived with `.partial()`: in Zod 4 `.partial()` keeps
// each field's `.default(...)`, so a PATCH of one field would have silently
// rewritten every other one back to its default — nulling a segment's window and
// resetting its sort order. Same family of footgun as z.coerce.boolean().
const segmentPatchSchema = z.object({
  label: label.optional(),
  description: description.optional(),
  minInactiveDays: inactiveFloor.optional(),
  maxInactiveDays: inactiveCeiling.optional(),
  includeNeverVisited: z.boolean().optional(),
  minLifetimeValue: lifetimeValue.optional(),
  minChurnRisk: score.nullable().optional(),
  requiredTag: tag.optional(),
  suggestedChannel: channelName.optional(),
  plannedOffer: offer.optional(),
  assumedBookingRatePct: bookingRatePct.optional(),
  active: z.boolean().optional(),
  sortOrder: sortOrder.optional(),
}).strict().refine(
  body => Object.keys(body).length > 0,
  { message: 'At least one field must be supplied' },
);

const channelCostSchema = z.object({
  unitCostMinor: z.number().int().min(0).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 alphabetic code'),
});

/**
 * `limit` is deliberately allowed past the shared `paginationSchema` ceiling of
 * 100: the pipeline board renders every open lead it is given, and a hard 100
 * was exactly what turned a board into a sample. It is still bounded, and the
 * response always reports `total` and `truncated` so a capped board says so.
 */
const leadListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  priorityLimit: z.coerce.number().int().min(0).max(50).default(6),
}).strict();

/**
 * Branch scope, resolved the way every sibling module resolves it. `branchScope`
 * yields `{ branchId }` only for a branch-restricted user; an unrestricted user
 * reads the whole tenant.
 */
function requestScope(request: FastifyRequest): GrowthScopeInput {
  const scope = branchScope(request);
  return { tenantId: request.auth.tenantId, branchId: scope.branchId ?? null };
}

/** A window whose lower bound is not below its exclusive upper bound is empty. */
function invalidWindow(min: number | null | undefined, max: number | null | undefined): boolean {
  return typeof min === 'number' && typeof max === 'number' && max <= min;
}

export const growthRoutes: FastifyPluginAsync = async app => {

  // ----- Reporting: tenant-wide metrics, scored leads, segment previews -----
  //
  // These three replace arithmetic that used to run in the browser over
  // `/v1/leads?limit=100` and `/v1/patients?limit=100`. Each one states its own
  // scope and its own truncation, because a figure whose basis is invisible is
  // indistinguishable from a wrong figure.

  app.get('/metrics', { preHandler: growthRead }, async request => {
    const scope = requestScope(request);
    const policy = await getEffectiveGrowthPolicy(scope.tenantId);
    return computeGrowthMetrics(scope, policy, new Date());
  });

  app.get('/leads', { preHandler: growthRead }, async request => {
    const query = leadListQuery.parse(request.query);
    const scope = requestScope(request);
    const policy = await getEffectiveGrowthPolicy(scope.tenantId);
    const result = await listScoredLeads(scope, policy, new Date(), {
      limit: query.limit,
      priorityLimit: query.priorityLimit,
    });
    // Identifiable lead records left the system: record the access, ids only.
    await audit(request, {
      action: 'growth.leads.list',
      resource: 'lead',
      metadata: { returned: result.returned, total: result.total, truncated: result.truncated },
    });
    return result;
  });

  app.get('/segments/preview', { preHandler: growthRead }, async request => {
    const scope = requestScope(request);
    const [policy, definitions, channelCosts] = await Promise.all([
      getEffectiveGrowthPolicy(scope.tenantId),
      listEffectiveSegmentDefinitions(scope.tenantId),
      listEffectiveChannelCosts(scope.tenantId),
    ]);
    return previewGrowthSegments(scope, policy, definitions, channelCosts, new Date());
  });

  // ----- Policy ------------------------------------------------------------

  app.get('/policy', async (request, reply) => {
    if (await policyReadDenied(request, reply)) return reply;
    return getEffectiveGrowthPolicy(request.auth.tenantId);
  });

  app.patch('/policy', { preHandler: configWrite }, async (request, reply) => {
    const input = policyPatchSchema.parse(request.body);
    if (Object.keys(input).length === 0) throw app.httpErrors.badRequest('At least one field must be supplied');

    const touchedMoneyFields = MONEY_AFFECTING_POLICY_FIELDS.filter(field => input[field] !== undefined);
    if (await deniedForMoneyFields(request, reply, [...touchedMoneyFields])) return reply;

    const current = await getEffectiveGrowthPolicy(request.auth.tenantId);
    const merged = { ...current, ...input };
    if (merged.scoreBandMid >= merged.scoreBandHigh) {
      throw app.httpErrors.badRequest('scoreBandMid must be below scoreBandHigh');
    }
    if (merged.reviewRatingFair > merged.reviewRatingGood) {
      throw app.httpErrors.badRequest('reviewRatingFair must not exceed reviewRatingGood');
    }
    if (merged.reputationRiskMedium >= merged.reputationRiskHigh) {
      throw app.httpErrors.badRequest('reputationRiskMedium must be below reputationRiskHigh');
    }

    await db.growthPolicy.upsert({
      where: { tenantId: request.auth.tenantId },
      update: input,
      create: { tenantId: request.auth.tenantId, ...input },
    });
    await audit(request, {
      action: 'growth.policy.updated',
      resource: 'growthPolicy',
      resourceId: request.auth.tenantId,
      metadata: { fields: Object.keys(input), changes: input, moneyAffecting: [...touchedMoneyFields] },
    });
    return getEffectiveGrowthPolicy(request.auth.tenantId);
  });

  // ----- Segment definitions ----------------------------------------------

  app.get('/segments', { preHandler: configRead }, async request => ({
    segments: await listEffectiveSegmentDefinitions(request.auth.tenantId),
  }));

  app.post('/segments', { preHandler: configWrite }, async (request, reply) => {
    const input = segmentCreateSchema.parse(request.body);
    if (invalidWindow(input.minInactiveDays, input.maxInactiveDays)) {
      throw app.httpErrors.badRequest('maxInactiveDays must be greater than minInactiveDays');
    }
    await materializeSegmentDefaults(request.auth.tenantId);
    const existing = await db.growthSegmentDefinition.findFirst({
      where: { tenantId: request.auth.tenantId, key: input.key },
      select: { id: true },
    });
    if (existing) throw app.httpErrors.conflict(`A segment definition with key "${input.key}" already exists`);

    const row = await db.growthSegmentDefinition.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, {
      action: 'growth.segment.created', resource: 'growthSegmentDefinition', resourceId: row.id,
      metadata: { key: input.key, fields: Object.keys(input) },
    });
    return reply.code(201).send(row);
  });

  app.patch('/segments/:key', { preHandler: configWrite }, async request => {
    const { key } = z.object({ key: segmentKey }).parse(request.params);
    const input = segmentPatchSchema.parse(request.body);
    await materializeSegmentDefaults(request.auth.tenantId);

    const existing = await db.growthSegmentDefinition.findFirst({ where: { tenantId: request.auth.tenantId, key } });
    if (!existing) throw app.httpErrors.notFound('Segment definition not found');

    const merged = { ...existing, ...input };
    if (invalidWindow(merged.minInactiveDays, merged.maxInactiveDays)) {
      throw app.httpErrors.badRequest('maxInactiveDays must be greater than minInactiveDays');
    }

    const row = await db.growthSegmentDefinition.update({ where: { id: existing.id }, data: input });
    await audit(request, {
      action: 'growth.segment.updated', resource: 'growthSegmentDefinition', resourceId: row.id,
      metadata: { key, fields: Object.keys(input), changes: input },
    });
    return row;
  });

  app.delete('/segments/:key', { preHandler: configWrite }, async request => {
    const { key } = z.object({ key: segmentKey }).parse(request.params);
    await materializeSegmentDefaults(request.auth.tenantId);
    const existing = await db.growthSegmentDefinition.findFirst({ where: { tenantId: request.auth.tenantId, key } });
    if (!existing) throw app.httpErrors.notFound('Segment definition not found');
    await db.growthSegmentDefinition.delete({ where: { id: existing.id } });
    await audit(request, {
      action: 'growth.segment.deleted', resource: 'growthSegmentDefinition', resourceId: existing.id,
      metadata: { key },
    });
    return { deleted: true, key };
  });

  // ----- Channel costs -----------------------------------------------------
  // Every field here is money, so writes always need the money permission.

  app.get('/channel-costs', { preHandler: configRead }, async request => ({
    channelCosts: await listEffectiveChannelCosts(request.auth.tenantId),
  }));

  app.put('/channel-costs/:channel', { preHandler: configWrite }, async (request, reply) => {
    const { channel } = z.object({ channel: z.string().min(2).max(40) }).parse(request.params);
    const input = channelCostSchema.parse(request.body);
    if (await deniedForMoneyFields(request, reply, ['unitCostMinor', 'currency'])) return reply;

    await materializeChannelCostDefaults(request.auth.tenantId);
    const row = await db.growthChannelCost.upsert({
      where: { tenantId_channel: { tenantId: request.auth.tenantId, channel } },
      update: input,
      create: { tenantId: request.auth.tenantId, channel, ...input },
    });
    await audit(request, {
      action: 'growth.channelCost.updated', resource: 'growthChannelCost', resourceId: row.id,
      metadata: { channel, unitCostMinor: input.unitCostMinor, currency: input.currency },
    });
    return row;
  });

  app.delete('/channel-costs/:channel', { preHandler: configWrite }, async (request, reply) => {
    const { channel } = z.object({ channel: z.string().min(2).max(40) }).parse(request.params);
    if (await deniedForMoneyFields(request, reply, ['unitCostMinor'])) return reply;
    await materializeChannelCostDefaults(request.auth.tenantId);
    const existing = await db.growthChannelCost.findFirst({ where: { tenantId: request.auth.tenantId, channel } });
    if (!existing) throw app.httpErrors.notFound('Channel cost not found');
    await db.growthChannelCost.delete({ where: { id: existing.id } });
    await audit(request, {
      action: 'growth.channelCost.deleted', resource: 'growthChannelCost', resourceId: existing.id,
      metadata: { channel },
    });
    return { deleted: true, channel };
  });
};
