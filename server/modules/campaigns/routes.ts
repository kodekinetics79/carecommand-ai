import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { audit } from '../../lib/audit';
import { requirePermission, requireAnyPermission, hasPermission, denyPermission } from '../../lib/permissions';
import { branchScope, assertBranchAccess } from '../../lib/scope';
import { requireFeature, isFeatureEnabled } from '../../lib/entitlements';
import { emitBusinessEvent, upsertSignal, createRecommendation, type WorkflowEventType } from '../../lib/intelligence';
import type { Campaign } from '../../generated/prisma/client';
import {
  CAMPAIGN_TYPES, AUDIENCE_TYPES, STAFF_FACING_AUDIENCES,
  CAMPAIGN_CLASS_AUTHORITY, CAMPAIGN_ANY_MANAGE_AUTHORITY, CAMPAIGN_ANY_READ_AUTHORITY,
  PAYMENT_FOLLOWUP_CAMPAIGN_TYPES, PAYMENT_FOLLOWUP_AUDIENCE_TYPES, campaignAuthorityClass,
  buildAudience, previewAudience, generateDraft, providerReadiness, countOpenSlots,
  channelStatus, maskDestination, isSuppressed, NON_VOICE_OUTREACH_AUTHORITY_VERSION,
  LIVE_DISPATCH_CHANNELS, LIVE_DISPATCH_FENCE_VERSION,
  resolveDispatchActivations, resolveChannelDispatchActivation,
  type AudienceType, type CommChannel, type CampaignType,
} from '../../lib/campaigns';
import { lockSuppressionFences } from '../../lib/receptionist/dncFence';
import { dispatchCampaign } from '../../lib/campaignDispatch';
import { sendMessage } from '../../lib/commsProvider';
import { aiProviderConfigured, draftWithAI } from '../../lib/campaignAI';
import { RULE_CATALOG, evaluateRule, executeRule } from '../../lib/automationRules';
import { enterTenantContext } from '../../lib/tenantContext';
import { resolveIngressTenant } from '../../lib/tenantIngressResolvers';
import { appendChannelSafetyFooter, buildCampaignLaunchPreview, normalizeProviderDeliveryStatus } from '../../lib/campaignIntegrity';
import { applyCampaignDeliveryWebhook } from '../../lib/campaignDeliveryWebhook';

// ===========================================================================
// CRM Campaign / Reactivation engine routes (mounted at /v1/crm — distinct from
// the existing analytics /v1/campaigns). Feature-gated by campaign_automation;
// audience sources additionally gated by their own entitlement. Consent +
// suppression enforced; delivery never faked. Mobile-ready responses.
// ===========================================================================

const uuid = z.string().uuid();

// --- Guards ---------------------------------------------------------------
// Entitlement (`requireFeature`) answers "does this tenant's plan include the
// product?" — it is NOT an authorization gate. Authorization is the permission
// layer, which is the only guard that honours a tenant's RoleDefinition
// override; `requireRoles` ignores overrides, so a tenant that revoked
// `campaign:manage` from a role still got write access here. Every route below
// therefore carries an explicit `[permission, entitlement]` preHandler pair, in
// that order, so an unauthorized caller is refused before any entitlement or
// resource state is disclosed. This mirrors server/modules/operations/routes.ts.
const campaignFeature = requireFeature('campaign_automation');
// Communication consent is patient data, not campaign automation: it belongs to
// the Patient CRM entitlement that every plan tier includes.
const patientCrmFeature = requireFeature('patient_crm');
const campaignRead = requirePermission('campaign:read');
// Tenant-wide campaign machinery — the live-dispatch activation switch,
// automation rules, the opportunity scan. These are not scoped to one campaign,
// so they keep the single broad grant and are deliberately NOT reachable by the
// narrow payment-follow-up authority.
const campaignManage = requirePermission('campaign:manage');
// Per-campaign routes. Authority over ONE campaign depends on what that
// campaign is (CAMPAIGN_CLASS_AUTHORITY in server/lib/campaigns.ts), which the
// route cannot know until it has read the record — and it must not read the
// record for a caller with no campaign authority at all. So these routes carry
// a coarse any-of gate, which refuses such a caller before any resource state
// is touched, and then run the exact per-class check on the loaded campaign.
const campaignEntityManage = requireAnyPermission(...CAMPAIGN_ANY_MANAGE_AUTHORITY);
const campaignEntityRead = requireAnyPermission(...CAMPAIGN_ANY_READ_AUTHORITY);
// Audience previews, consent, and suppression records expose patient identity
// and contact evidence, so they take the SAME grant as GET /v1/leads.
const crmRead = requirePermission('crm:read');
const crmWrite = requirePermission('crm:write');
const channelEnum = z.enum(['sms', 'email', 'voice', 'whatsapp']);
const voicePurpose = z.enum(['CARE_COORDINATION', 'APPOINTMENT_REMINDER', 'PATIENT_REACTIVATION']);
const voiceCaptureMethod = z.enum(['verbal_recorded', 'written', 'staff_attestation', 'import_verified']);
const voiceEvidenceSource = z.enum(['patient_verbal', 'patient_written', 'staff_attested', 'verified_import']);

const VOICE_SOURCE_BY_METHOD: Record<z.infer<typeof voiceCaptureMethod>, z.infer<typeof voiceEvidenceSource>> = {
  verbal_recorded: 'patient_verbal',
  written: 'patient_written',
  staff_attestation: 'staff_attested',
  import_verified: 'verified_import',
};

// Which entitlement each audience source requires (beyond campaign_automation).
const AUDIENCE_FEATURE: Record<AudienceType, string> = {
  inactive_patients: 'patient_crm', no_show_recovery: 'patient_crm', review_request: 'patient_crm',
  unpaid_deposit_followup: 'payments_deposits', failed_payment_recovery: 'payments_deposits',
  insurance_update_request: 'insurance_eligibility', appointment_request_followup: 'ai_receptionist',
};

/**
 * The exact per-campaign authority check. `mode` is 'manage' for any write or
 * launch surface and 'read' for a disclosure surface. Returns true when the
 * caller may proceed; otherwise it has already sent the 403 naming the broad
 * grant an administrator would assign for that class.
 */
async function authorizedForCampaign(
  request: FastifyRequest,
  reply: FastifyReply,
  campaign: { campaignType?: string | null; audienceType?: string | null },
  mode: 'manage' | 'read',
): Promise<boolean> {
  const accepted = CAMPAIGN_CLASS_AUTHORITY[campaignAuthorityClass(campaign)][mode];
  for (const permission of accepted) {
    if (await hasPermission(request, permission)) return true;
  }
  await denyPermission(reply, accepted[0]);
  return false;
}

/**
 * Tenant + branch predicate for every campaign lookup in this module.
 * `branchScope()` semantics exactly: an exact branchId match for a restricted
 * caller, which means a tenant-wide (NULL-branch) campaign is OUT of scope for
 * them and comes back as "not found". That is deliberate — a branch-restricted
 * manager must not be able to open, edit or LAUNCH a campaign whose audience
 * reaches branches they cannot read.
 */
function campaignScopeWhere(request: FastifyRequest) {
  return { tenantId: request.auth.tenantId, ...branchScope(request) };
}

function mapCampaign(c: Campaign) {
  return {
    id: c.id, name: c.name, campaignType: c.campaignType, audienceType: c.audienceType,
    branchId: c.branchId,
    channel: c.campaignChannel, status: c.status, requiresApproval: c.requiresApproval,
    approvedByUserId: c.approvedByUserId, approvedAt: c.approvedAt?.toISOString() ?? null,
    scheduledAt: c.scheduledAt?.toISOString() ?? null, messageSubject: c.messageSubject,
    messageTemplate: c.messageTemplate, draftSource: c.draftSource, audienceSize: c.audienceSize,
    createdAt: c.createdAt.toISOString(),
    archivedAt: c.archivedAt?.toISOString() ?? null,
    dispatchAuthorizedAt: c.dispatchAuthorizedAt?.toISOString() ?? null,
    dispatchAuthorizedByUserId: c.dispatchAuthorizedByUserId,
    dispatchAuthorizationRecorded: Boolean(c.dispatchAuthorizationFingerprint && c.dispatchAuthorizedByUserId && c.dispatchAuthorizedAt),
    allowedActions: campaignActions(c),
    deepLinkTarget: `campaign/${c.id}`,
    requiresApprovalPending: c.requiresApproval && !c.approvedByUserId,
  };
}

function campaignActions(c: Campaign): string[] {
  const a: string[] = [];
  if (c.archivedAt) return a;
  if (c.status === 'APPROVAL_REQUIRED') a.push('edit', 'generate_draft', 'approve');
  if (c.status === 'DRAFT') a.push('edit', 'generate_draft', 'launch');
  if (c.status === 'SCHEDULED') a.push('launch');
  if (c.status === 'ACTIVE') a.push('pause');
  if (c.status === 'PAUSED') a.push('launch');
  if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(c.status)) a.push('cancel');
  return a;
}

export const crmRoutes: FastifyPluginAsync = async app => {
  // NOTE: there is deliberately NO module-wide preHandler. A single
  // `app.addHook('preHandler', campaignFeature)` installed only the entitlement
  // check, which left every GET below reachable by ANY authenticated role in an
  // entitled tenant, and coupled the patient-data consent read to the campaign
  // entitlement. Guards are declared per route so each data class is explicit.

  // ----- Communications provider readiness (truthful; no secret values) ---
  // The two live-dispatch booleans are no longer literals: they answer "can THIS
  // tenant submit live regulated campaign traffic right now", and
  // `channelActivation` says exactly what is missing on each channel (fence
  // present? provider configured? tenant activated?).
  app.get('/provider-status', { preHandler: [campaignRead, campaignFeature] }, async request =>
    providerReadiness(await resolveDispatchActivations(request.auth.tenantId)));

  // ----- Live campaign dispatch activation (DEFAULT OFF) ------------------
  // Building the fence does not turn anything on. A tenant may submit live
  // regulated campaign traffic only after an OWNER or ADMIN records an explicit
  // attestation here, for one channel, whose provider is genuinely configured.
  const activationChannel = z.enum(['sms', 'email', 'whatsapp']);

  function activationDenied(request: { auth: { role: string } }): boolean {
    // Deliberately a role test on top of `campaign:manage`. Activating live
    // regulated outreach is an accountable act by a named accountable person,
    // so it is not delegable through a RoleDefinition override the way ordinary
    // campaign management is.
    return !['OWNER', 'ADMIN'].includes(request.auth.role);
  }

  app.get('/live-dispatch-activation', { preHandler: [campaignRead, campaignFeature] }, async request => {
    const activation = await resolveDispatchActivations(request.auth.tenantId);
    return {
      fenceVersion: LIVE_DISPATCH_FENCE_VERSION,
      eligibleChannels: LIVE_DISPATCH_CHANNELS,
      channels: LIVE_DISPATCH_CHANNELS.map(channel => activation[channel]),
    };
  });

  app.post('/live-dispatch-activation', { preHandler: [campaignManage, campaignFeature] }, async (request, reply) => {
    if (activationDenied(request)) {
      return reply.code(403).send({
        error: 'owner_or_admin_required',
        message: 'Activating live campaign delivery requires an OWNER or ADMIN. Nothing was changed.',
      });
    }
    const input = z.object({
      channel: activationChannel,
      // The exact sentence the operator types, stored verbatim as evidence.
      attestation: z.string().trim().min(40).max(1000),
      // An explicit, un-defaultable acknowledgement — never a checkbox default.
      confirmLiveSubmissionToRealRecipients: z.literal(true),
      // Pinning the fence version means an attestation is consent to THIS
      // boundary. A future change to the fence's safety properties bumps the
      // constant and every existing activation stops being sufficient.
      fenceVersion: z.literal(LIVE_DISPATCH_FENCE_VERSION),
    }).parse(request.body);

    const status = channelStatus(input.channel);
    // Refuse activation when the provider is not actually configured: an
    // activation record that cannot send anything is a false assurance.
    const proposed = resolveChannelDispatchActivation(input.channel, null);
    if (!proposed.liveProviderReady) {
      await audit(request, {
        action: 'campaign.live_dispatch.activation_refused', resource: 'campaignLiveDispatchActivation',
        metadata: { channel: input.channel, reason: 'provider_not_live', blockingReasons: proposed.blockingReasons.filter(r => r !== 'tenant_activation_missing') },
      });
      return reply.code(409).send({
        error: 'provider_not_configured',
        channel: input.channel,
        provider: status.provider,
        missing: status.missing,
        providerMode: proposed.providerMode,
        message: `The ${input.channel} provider has no live sender configured, so live dispatch cannot be activated. Nothing was changed.`,
      });
    }

    const attestationHash = createHash('sha256').update(input.attestation).digest('hex');
    const now = new Date();
    const providerSnapshot = {
      provider: status.provider,
      providerMode: proposed.providerMode,
      configured: status.configured,
      // Env key NAMES only — never a value.
      missingEnvKeys: status.missing,
    };
    const row = await db.$transaction(async tx => {
      const activation = await tx.campaignLiveDispatchActivation.upsert({
        where: { tenantId_channel: { tenantId: request.auth.tenantId, channel: input.channel } },
        create: {
          tenantId: request.auth.tenantId, channel: input.channel,
          activatedByUserId: request.auth.userId, activatedAt: now,
          attestation: input.attestation, attestationHash,
          fenceVersion: LIVE_DISPATCH_FENCE_VERSION, providerSnapshot,
        },
        update: {
          activatedByUserId: request.auth.userId, activatedAt: now,
          attestation: input.attestation, attestationHash,
          fenceVersion: LIVE_DISPATCH_FENCE_VERSION, providerSnapshot,
          revokedAt: null, revokedByUserId: null, revocationReason: null,
        },
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'campaign.live_dispatch.activated',
        resource: 'campaignLiveDispatchActivation', resourceId: activation.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: {
          channel: input.channel, fenceVersion: LIVE_DISPATCH_FENCE_VERSION,
          attestationHash, provider: status.provider, providerMode: proposed.providerMode,
        },
      } });
      return activation;
    });
    return reply.code(201).send({
      channel: input.channel,
      activatedAt: row.activatedAt.toISOString(),
      activatedByUserId: row.activatedByUserId,
      fenceVersion: row.fenceVersion,
      attestationHash: row.attestationHash,
      state: await resolveDispatchActivations(request.auth.tenantId).then(a => a[input.channel]),
    });
  });

  app.delete('/live-dispatch-activation/:channel', { preHandler: [campaignManage, campaignFeature] }, async (request, reply) => {
    if (activationDenied(request)) {
      return reply.code(403).send({
        error: 'owner_or_admin_required',
        message: 'Deactivating live campaign delivery requires an OWNER or ADMIN.',
      });
    }
    const { channel } = z.object({ channel: activationChannel }).parse(request.params);
    const reason = z.object({ reason: z.string().trim().min(2).max(240).default('operator_requested') }).parse(request.body ?? {}).reason;
    const existing = await db.campaignLiveDispatchActivation.findUnique({
      where: { tenantId_channel: { tenantId: request.auth.tenantId, channel } },
    });
    if (!existing || existing.revokedAt) {
      return reply.code(200).send({ channel, revoked: true, alreadyInactive: true });
    }
    await db.$transaction(async tx => {
      await tx.campaignLiveDispatchActivation.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), revokedByUserId: request.auth.userId, revocationReason: reason },
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'campaign.live_dispatch.deactivated',
        resource: 'campaignLiveDispatchActivation', resourceId: existing.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { channel, reason },
      } });
    });
    return reply.code(200).send({ channel, revoked: true, alreadyInactive: false });
  });

  // ----- Campaigns CRUD ---------------------------------------------------
  app.get('/campaigns', { preHandler: [campaignEntityRead, campaignFeature] }, async request => {
    // A caller who holds only the payment-follow-up grant is not entitled to
    // learn that a reactivation campaign exists, so the list is narrowed to the
    // classes their grants actually cover rather than 403-ing the whole page.
    const classFilter = await hasPermission(request, 'campaign:read')
      ? {}
      : { campaignType: { in: [...PAYMENT_FOLLOWUP_CAMPAIGN_TYPES] }, audienceType: { in: [...PAYMENT_FOLLOWUP_AUDIENCE_TYPES] } };
    const rows = await db.campaign.findMany({ where: { ...campaignScopeWhere(request), campaignType: { not: null }, archivedAt: null, ...classFilter }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(mapCampaign);
  });

  app.get('/campaigns/:id', { preHandler: [campaignEntityRead, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request) } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, c, 'read'))) return reply;
    const deliveries = await db.campaignDelivery.groupBy({ by: ['status'], where: { tenantId: request.auth.tenantId, campaignId: id }, _count: true });
    return { ...mapCampaign(c), deliveryCounts: Object.fromEntries(deliveries.map(d => [d.status, d._count])) };
  });

  app.post('/campaigns', { preHandler: [campaignEntityManage, campaignFeature] }, async (request, reply) => {
    const input = z.object({
      name: z.string().trim().min(2).max(160),
      campaignType: z.enum(CAMPAIGN_TYPES),
      audienceType: z.enum(AUDIENCE_TYPES).optional(),
      channel: channelEnum.default('sms'),
      messageSubject: z.string().max(200).optional(),
      messageTemplate: z.string().max(2000).optional(),
      scheduledAt: z.coerce.date().optional(),
      // Only meaningful for an unrestricted operator choosing to target one
      // branch. A branch-restricted operator's own branch is stamped below and
      // this field cannot be used to escape it.
      branchId: uuid.optional(),
    }).parse(request.body);
    if (!(await authorizedForCampaign(request, reply, input, 'manage'))) return reply;
    // Branch authority, decided once, at the only moment scope is chosen.
    // A branch-restricted caller ALWAYS gets their own branch and can never
    // create a tenant-wide campaign; assertBranchAccess refuses an attempt to
    // name a different one. An unrestricted caller may name a branch of their
    // own tenant, or omit it for a deliberately tenant-wide campaign.
    let branchId: string | null;
    if (request.auth.branchId) {
      if (input.branchId) assertBranchAccess(request, input.branchId);
      branchId = request.auth.branchId;
    } else if (input.branchId) {
      const branch = await db.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId }, select: { id: true } });
      if (!branch) throw app.httpErrors.notFound('Branch not found');
      branchId = branch.id;
    } else {
      branchId = null;
    }
    const row = await db.campaign.create({
      data: {
        tenantId: request.auth.tenantId, name: input.name, goal: input.campaignType, status: 'APPROVAL_REQUIRED', channels: [],
        branchId,
        campaignType: input.campaignType, audienceType: input.audienceType, campaignChannel: input.channel,
        messageSubject: input.messageSubject, messageTemplate: input.messageTemplate,
        requiresApproval: true, scheduledAt: input.scheduledAt, createdByUserId: request.auth.userId, draftSource: 'rule_based',
      },
    });
    await audit(request, { action: 'campaign.created', resource: 'campaign', resourceId: row.id, metadata: { campaignType: input.campaignType, branchScope: branchId ?? 'tenant' } });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'campaign.created', entityType: 'campaign', entityId: row.id, sourceModule: 'crm', payload: { campaignType: input.campaignType } }).catch(() => {});
    return reply.code(201).send(mapCampaign(row));
  });

  app.patch('/campaigns/:id', { preHandler: [campaignEntityManage, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({ name: z.string().trim().min(2).max(160).optional(), messageSubject: z.string().max(200).optional(), messageTemplate: z.string().max(2000).optional(), channel: channelEnum.optional(), scheduledAt: z.coerce.date().optional() }).parse(request.body);
    const existing = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request) } });
    if (!existing) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, existing, 'manage'))) return reply;
    // Neither branch scope nor campaign/audience type is editable: both are the
    // authority this campaign was created under, and the launch fingerprint is
    // bound to them.
    if (!['DRAFT', 'APPROVAL_REQUIRED'].includes(existing.status)) throw app.httpErrors.conflict('Only draft/approval-required campaigns can be edited');
    const row = await db.campaign.update({ where: { id }, data: { name: input.name, messageSubject: input.messageSubject, messageTemplate: input.messageTemplate, campaignChannel: input.channel, scheduledAt: input.scheduledAt } });
    await audit(request, { action: 'campaign.updated', resource: 'campaign', resourceId: id });
    return mapCampaign(row);
  });

  // ----- Rule-based draft generation (requires approval before launch) ----
  app.post('/campaigns/:id/draft', { preHandler: [campaignEntityManage, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request) } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, c, 'manage'))) return reply;
    const campaignType = (c.campaignType ?? 'custom') as CampaignType;
    const channel = (c.campaignChannel ?? 'sms') as CommChannel;
    const draft = generateDraft(campaignType, channel, (c.audienceType ?? 'inactive_patients') as AudienceType);

    // Real LLM drafting only when an AI provider is safely configured; otherwise
    // the rule-based template is used and labeled rule_based (never "AI generated").
    if (aiProviderConfigured()) {
      const ai = await draftWithAI(campaignType, channel);
      if (ai?.body) {
        draft.body = ai.body;
        draft.draftSource = 'ai';
        // Log model/provider only (no PHI, no prompt content with patient data).
        await db.integrationRunLog.create({ data: { tenantId: request.auth.tenantId, provider: ai.provider, providerMode: 'live', operation: 'campaign.ai_draft', status: 'success', requestSummary: { campaignType, channel }, responseSummary: { model: ai.model } } }).catch(() => {});
      }
    }
    await db.campaign.update({ where: { id }, data: { messageSubject: draft.subject, messageTemplate: draft.body, draftSource: draft.draftSource, requiresApproval: true } });
    return { ...draft, campaignId: id };
  });

  // ----- Audience preview (deterministic, consent-gated) ------------------
  // The preview returns real patient names, a reason string, and a masked
  // destination, so it is a patient-data read: same grant as GET /v1/leads, and
  // scoped to the caller's branch like every other patient-facing surface.
  app.get('/audiences/:type/preview', { preHandler: [crmRead, campaignFeature] }, async (request, reply) => {
    const { type } = z.object({ type: z.enum(AUDIENCE_TYPES) }).parse(request.params);
    const query = z.object({ channel: channelEnum.default('sms') }).parse(request.query);
    if (!(await isFeatureEnabled(request.auth.tenantId, AUDIENCE_FEATURE[type]))) {
      return reply.code(403).send({ error: 'feature_locked', feature: AUDIENCE_FEATURE[type], message: `Audience source ${type} requires ${AUDIENCE_FEATURE[type]}.` });
    }
    return previewAudience(request.auth.tenantId, type, query.channel, { branchId: request.auth.branchId });
  });

  // ----- Approve ----------------------------------------------------------
  app.post('/campaigns/:id/approve', { preHandler: [campaignEntityManage, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const authorization = z.object({
      previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      confirmExactAudienceTemplateProvider: z.literal(true),
    }).optional().parse(request.body);
    const c = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request) } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, c, 'manage'))) return reply;
    let preview: Awaited<ReturnType<typeof buildCampaignLaunchPreview>> | null = null;
    if (authorization) {
      if (!c.audienceType) throw app.httpErrors.badRequest('Campaign has no audience type');
      const audienceType = c.audienceType as AudienceType;
      if (!(await isFeatureEnabled(request.auth.tenantId, AUDIENCE_FEATURE[audienceType]))) {
        throw app.httpErrors.forbidden(`Audience source ${audienceType} is not enabled`);
      }
      if (STAFF_FACING_AUDIENCES.has(audienceType)) throw app.httpErrors.badRequest('This audience is staff-facing and cannot be used for patient outreach');
      preview = await buildCampaignLaunchPreview(request.auth.tenantId, c);
      if (preview.fingerprint !== authorization.previewFingerprint) {
        throw app.httpErrors.conflict('Campaign content, audience eligibility, channel, or provider mode changed. Review a new launch preview before scheduling.');
      }
    }
    const approvedAt = new Date();
    const row = await db.campaign.update({ where: { id }, data: {
      approvedByUserId: request.auth.userId,
      approvedAt,
      status: c.status === 'APPROVAL_REQUIRED' ? 'SCHEDULED' : c.status,
      ...(preview ? {
        dispatchAuthorizationFingerprint: preview.fingerprint,
        dispatchAuthorizedByUserId: request.auth.userId,
        dispatchAuthorizedAt: approvedAt,
      } : {}),
    } });
    await audit(request, { action: 'campaign.approved', resource: 'campaign', resourceId: id, metadata: preview ? {
      dispatchAuthorized: true,
      launchFingerprint: preview.fingerprint,
      templateRevision: preview.templateRevision,
      providerMode: preview.providerMode,
    } : { dispatchAuthorized: false } });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'campaign.approved', entityType: 'campaign', entityId: id, sourceModule: 'crm', payload: {} }).catch(() => {});
    return mapCampaign(row);
  });

  // ----- Server-issued launch preview ------------------------------------
  // The fingerprint binds the exact recipient eligibility snapshot, message
  // revision, channel, provider identity, and provider mode without returning
  // recipient identifiers or destinations to the browser.
  app.get('/campaigns/:id/launch-preview', { preHandler: [campaignEntityManage, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request), archivedAt: null } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, c, 'manage'))) return reply;
    if (!c.audienceType) throw app.httpErrors.badRequest('Campaign has no audience type');
    // Resolved from Campaign.branchId, not from this caller: the preview an
    // operator authorizes is exactly the audience dispatch will resolve.
    return buildCampaignLaunchPreview(request.auth.tenantId, c);
  });

  // ----- Launch (build audience → idempotent deliveries) ------------------
  app.post('/campaigns/:id/launch', { preHandler: [campaignEntityManage, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({
      force: z.boolean().default(false),
      previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      confirmExactAudienceTemplateProvider: z.literal(true),
    }).parse(request.body ?? {});
    if (body.force) {
      return reply.code(409).send({
        error: 'CAMPAIGN_RECONCILIATION_REQUIRED',
        message: 'Bulk force retry is disabled. Reconcile provider evidence and authorize a recipient-scoped retry before resubmission.',
      });
    }
    const c = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request), archivedAt: null } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, c, 'manage'))) return reply;
    if (!c.audienceType) throw app.httpErrors.badRequest('Campaign has no audience type');
    if (c.requiresApproval && !c.approvedByUserId) throw app.httpErrors.conflict('Campaign requires approval before launch');

    const audienceType = c.audienceType as AudienceType;
    if (!(await isFeatureEnabled(request.auth.tenantId, AUDIENCE_FEATURE[audienceType]))) {
      return reply.code(403).send({ error: 'feature_locked', feature: AUDIENCE_FEATURE[audienceType] });
    }
    if (STAFF_FACING_AUDIENCES.has(audienceType)) throw app.httpErrors.badRequest('This audience is staff-facing and cannot be used for patient outreach');

    // Fail closed if content, audience eligibility/destinations, channel, or
    // provider mode changed after the operator reviewed the server preview.
    const launchPreview = await buildCampaignLaunchPreview(request.auth.tenantId, c);
    if (launchPreview.fingerprint !== body.previewFingerprint) {
      return reply.code(409).send({
        error: 'LAUNCH_PREVIEW_STALE',
        message: 'Campaign content, audience eligibility, channel, or provider mode changed. Review a new launch preview before dispatch.',
        currentPreview: launchPreview,
      });
    }

    // Persist the operator's exact authority before any provider boundary. A
    // scheduler can use the same durable evidence, and dispatch revalidates it.
    const authorizedAt = new Date();
    await db.$transaction(async tx => {
      await tx.campaign.update({ where: { id }, data: {
        dispatchAuthorizationFingerprint: launchPreview.fingerprint,
        dispatchAuthorizedByUserId: request.auth.userId,
        dispatchAuthorizedAt: authorizedAt,
      } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: 'campaign.dispatch_authorized',
        resource: 'campaign',
        resourceId: id,
        requestId: request.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { launchFingerprint: launchPreview.fingerprint, templateRevision: launchPreview.templateRevision, providerMode: launchPreview.providerMode },
      } });
    });

    // Real send via the provider abstraction (dev mock / live / setup_required).
    // Per-recipient delivery events are emitted inside dispatchCampaign.
    const result = await dispatchCampaign(request.auth.tenantId, id, { force: body.force, authorizationFingerprint: launchPreview.fingerprint });
    const newStatus = result.authorityBlocked > 0 || result.atomicBoundaryBlocked > 0
      ? 'APPROVAL_REQUIRED'
      : result.accepted > 0 || result.deliveryUnknown > 0 ? 'ACTIVE' : 'SCHEDULED';
    await audit(request, { action: 'campaign.launched', resource: 'campaign', resourceId: id, metadata: { accepted: result.accepted, deliveryUnknown: result.deliveryUnknown, suppressed: result.suppressed, skipped: result.skipped, setupRequired: result.setupRequired, failed: result.failed, authorityBlocked: result.authorityBlocked, atomicBoundaryBlocked: result.atomicBoundaryBlocked, activationBlockers: result.activationBlockers, launchFingerprint: launchPreview.fingerprint, templateRevision: launchPreview.templateRevision, providerMode: launchPreview.providerMode } });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'campaign.launched', entityType: 'campaign', entityId: id, sourceModule: 'crm', payload: { accepted: result.accepted, suppressed: result.suppressed } }).catch(() => {});

    return reply.send({
      campaignId: id, status: newStatus, setupRequired: result.setupRequired > 0 && result.accepted === 0,
      summary: { total: result.total, accepted: result.accepted, deliveryUnknown: result.deliveryUnknown, suppressed: result.suppressed, skipped: result.skipped, setupRequired: result.setupRequired, queued: result.queued, failed: result.failed, authorityBlocked: result.authorityBlocked, atomicBoundaryBlocked: result.atomicBoundaryBlocked },
      provider: { channel: result.channel, configured: result.provider.configured, setupRequired: result.provider.setupRequired, missing: result.provider.missing, mode: launchPreview.providerMode, liveDispatchActivated: launchPreview.liveDispatchActivated, activationBlockers: result.activationBlockers },
      launchFingerprint: launchPreview.fingerprint,
      deepLinkTarget: `campaign/${id}`,
    });
  });

  app.post('/campaigns/:id/pause', { preHandler: [campaignEntityManage, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request) } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, c, 'manage'))) return reply;
    const row = await db.campaign.update({ where: { id }, data: { status: 'PAUSED' } });
    await audit(request, { action: 'campaign.paused', resource: 'campaign', resourceId: id });
    return mapCampaign(row);
  });

  app.post('/campaigns/:id/cancel', { preHandler: [campaignEntityManage, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request) } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, c, 'manage'))) return reply;
    const row = await db.campaign.update({ where: { id }, data: { status: 'CANCELLED' } });
    await audit(request, { action: 'campaign.cancelled', resource: 'campaign', resourceId: id });
    return mapCampaign(row);
  });

  // ----- Archive (preserve campaign + delivery evidence) ------------------
  app.delete('/campaigns/:id', { preHandler: [campaignEntityManage, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request) } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, c, 'manage'))) return reply;
    if (c.archivedAt) return reply.send(mapCampaign(c));
    const row = await db.$transaction(async tx => {
      const archived = await tx.campaign.update({ where: { id }, data: { archivedAt: new Date(), status: 'CANCELLED' } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'campaign.archived', resource: 'campaign', resourceId: id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { campaignType: c.campaignType, priorStatus: c.status, evidencePreserved: true },
      } });
      return archived;
    });
    return reply.send(mapCampaign(row));
  });

  // ----- Consent-checked per-lead send (Pipeline CTAs) --------------------
  // Sends a single transactional message to a lead via the real comms provider.
  // Enforces consent/suppression; never fakes a send (returns setup_required if
  // the provider isn't configured). Audited; no message body / PHI in the log.
  const LEAD_SEND_CTAS = ['send_booking_link', 'send_deposit_link', 'send_intake_form', 'send_follow_up', 'confirm_visit'] as const;
  type LeadSendCta = typeof LEAD_SEND_CTAS[number];
  const SEND_TEMPLATE: Record<LeadSendCta, { subject: string; body: (name: string, service: string, clinic: string) => string }> = {
    send_booking_link: { subject: 'Appointment options', body: (n, s, c) => `Hi ${n}, this is ${c}. Contact the clinic using verified contact details to review options for your ${s || 'appointment'}. No appointment is held until the clinic confirms it.` },
    send_deposit_link: { subject: 'Booking deposit information', body: (n, s, c) => `Hi ${n}, ${c} here. Contact the clinic using verified contact details if you need an approved payment link for your ${s || 'appointment'}. Do not send payment information by reply.` },
    send_intake_form: { subject: 'Intake information', body: (n, s, c) => `Hi ${n}, before your ${s || 'visit'} at ${c}, contact the clinic using verified contact details if you need an approved intake link. Do not send health information by reply.` },
    send_follow_up: { subject: 'Following up', body: (n, s, c) => `Hi ${n}, it's ${c} following up about your ${s || 'visit'}. Contact the clinic using verified contact details if you would like to discuss next steps.` },
    confirm_visit: { subject: 'Upcoming visit', body: (n, s, c) => `Hi ${n}, contact ${c} using verified contact details to confirm or request a change to your upcoming ${s || 'appointment'}. This message does not change the appointment.` },
  };

  function channelFor(leadChannel: string, hasPhone: boolean, hasEmail: boolean): CommChannel | null {
    const c = leadChannel.toUpperCase();
    if (c === 'WHATSAPP' && hasPhone) return 'whatsapp';
    if (c === 'SMS' && hasPhone) return 'sms';
    if (c === 'EMAIL' && hasEmail) return 'email';
    if (hasPhone) return 'sms';
    if (hasEmail) return 'email';
    return null;
  }

  app.post('/leads/:id/send', { preHandler: [crmWrite, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ cta: z.enum(LEAD_SEND_CTAS), channel: z.enum(['sms', 'email', 'whatsapp']).optional() }).parse(request.body);
    const lead = await db.lead.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!lead) throw app.httpErrors.notFound('Lead not found');

    const channel = body.channel ?? channelFor(lead.channel, !!lead.phone, !!lead.email);
    if (!channel) return reply.code(400).send({ status: 'no_destination', message: 'Lead has no phone or email on file.' });

    const destination = channel === 'email' ? lead.email : lead.phone;
    if (!destination) return reply.code(400).send({ status: 'no_destination', message: `Lead has no ${channel === 'email' ? 'email' : 'phone'} on file.` });

    // Consent / suppression gate — never message a suppressed/opted-out contact.
    // Passing the destination also honors an AI-receptionist opt-out (ReceptionistOptOut).
    if (await isSuppressed(request.auth.tenantId, { leadId: id, destination }, channel)) {
      await audit(request, { action: 'crm.lead.send.blocked', resource: 'lead', resourceId: id, metadata: { cta: body.cta, channel, reason: 'consent_or_suppression' } });
      return reply.code(409).send({ status: 'blocked', reason: 'consent_or_suppression', message: 'This contact is suppressed or has opted out for this channel.' });
    }

    // Provider readiness — truthful; no fake "sent".
    const status = channelStatus(channel);
    if (status.setupRequired) {
      return reply.code(200).send({ status: 'setup_required', channel, provider: status.provider, missing: status.missing, message: `${channel} provider is not configured.` });
    }

    const tenant = await db.tenant.findUnique({ where: { id: request.auth.tenantId }, select: { name: true } });
    const tpl = SEND_TEMPLATE[body.cta];
    const subject = tpl.subject;
    const clinicName = tenant?.name ?? 'your clinic';
    const message = appendChannelSafetyFooter(channel, tpl.body(lead.name.split(' ')[0], lead.service, clinicName), clinicName);
    const idempotencyKey = `lead-send:${id}:${body.cta}:${new Date().toISOString().slice(0, 10)}`;

    const result = await sendMessage(channel, destination, subject, message, idempotencyKey, {
      tenantId: request.auth.tenantId,
      leadId: id,
      regulatedOutreach: { purpose: body.cta },
    });
    await audit(request, { action: 'crm.lead.message_submission_result', resource: 'lead', resourceId: id, metadata: { cta: body.cta, channel, status: result.status, mode: result.mode, failureCode: result.failureReason ?? null } });

    if (result.failureReason === 'affirmative_outreach_authority_required') {
      return reply.code(409).send({
        status: 'blocked', reason: 'affirmative_authority_required', channel,
        destinationMasked: maskDestination(destination),
        message: 'No current consent record ties this message purpose to the approved notice version. Nothing was submitted.',
      });
    }
    if (result.failureReason === 'live_outreach_atomic_boundary_not_activated') {
      return reply.code(409).send({
        status: 'blocked', reason: 'live_boundary_not_activated', channel,
        destinationMasked: maskDestination(destination),
        // Truthful and specific: this CTA has no per-recipient submission fence
        // of its own, so it can never take the live regulated path regardless of
        // the tenant's campaign activation.
        blockingReasons: ['no_durable_submission_claim_for_this_path'],
        message: 'Live outreach is not activated for this path. A single-lead send has no durable submission claim, so nothing was submitted.',
      });
    }
    if (result.failureReason?.startsWith('campaign_submission_not_claimed:')) {
      return reply.code(409).send({
        status: 'blocked', reason: 'submission_claim_unavailable', channel,
        destinationMasked: maskDestination(destination),
        message: 'The durable submission claim for this send was already used or is no longer valid. Nothing was submitted.',
      });
    }

    return reply.code(result.ok ? 200 : 502).send({
      status: result.status, channel, destinationMasked: maskDestination(destination),
      mode: result.mode, providerMessageId: result.providerMessageId ?? null, failureReason: result.failureReason ?? null,
    });
  });

  // ----- Automation Rules (trigger → action engine) ----------------------
  function ruleView(r: { id: string; templateKey: string; name: string; triggerType: string; actionType: string; config: unknown; enabled: boolean; lastRunAt: Date | null; lastMatchCount: number; runCount: number }) {
    return { id: r.id, templateKey: r.templateKey, name: r.name, triggerType: r.triggerType, actionType: r.actionType, config: r.config ?? {}, enabled: r.enabled, lastRunAt: r.lastRunAt?.toISOString() ?? null, lastMatchCount: r.lastMatchCount, runCount: r.runCount };
  }

  app.get('/automation-rules/catalog', { preHandler: [campaignRead, campaignFeature] }, async () => RULE_CATALOG);

  app.get('/automation-rules', { preHandler: [campaignRead, campaignFeature] }, async request => {
    const rows = await db.automationRule.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { createdAt: 'asc' } });
    // Live match-count so the UI shows how many records each rule currently hits.
    return Promise.all(rows.map(async r => ({ ...ruleView(r), matchesNow: (await evaluateRule(request.auth.tenantId, r)).matched })));
  });

  app.post('/automation-rules', { preHandler: [campaignManage, campaignFeature] }, async (request, reply) => {
    const body = z.object({ templateKey: z.string().min(2).max(60), enabled: z.boolean().default(false), config: z.record(z.string(), z.number()).optional() }).parse(request.body);
    const tpl = RULE_CATALOG.find(t => t.key === body.templateKey);
    if (!tpl) throw app.httpErrors.badRequest('Unknown rule template');
    const row = await db.automationRule.create({ data: { tenantId: request.auth.tenantId, templateKey: tpl.key, name: tpl.name, triggerType: tpl.triggerType, actionType: tpl.actionType, config: body.config ?? tpl.config, enabled: body.enabled, createdById: request.auth.userId } });
    await audit(request, { action: 'automation.rule.created', resource: 'automationRule', resourceId: row.id, metadata: { templateKey: tpl.key, enabled: body.enabled } });
    return reply.code(201).send(ruleView(row));
  });

  app.patch('/automation-rules/:id', { preHandler: [campaignManage, campaignFeature] }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ enabled: z.boolean().optional(), name: z.string().min(2).max(120).optional(), config: z.record(z.string(), z.number()).optional() }).parse(request.body);
    const existing = await db.automationRule.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Rule not found');
    const row = await db.automationRule.update({ where: { id }, data: { enabled: body.enabled, name: body.name, config: body.config } });
    await audit(request, { action: 'automation.rule.updated', resource: 'automationRule', resourceId: id, metadata: { enabled: row.enabled } });
    return ruleView(row);
  });

  app.delete('/automation-rules/:id', { preHandler: [campaignManage, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const existing = await db.automationRule.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Rule not found');
    await db.automationRule.delete({ where: { id } });
    await audit(request, { action: 'automation.rule.deleted', resource: 'automationRule', resourceId: id });
    return reply.code(204).send();
  });

  // Evaluate + execute a rule once. Task-creating actions run for real;
  // module-owned actions return a governed preview. Audited.
  app.post('/automation-rules/:id/run', { preHandler: [campaignManage, campaignFeature] }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const rule = await db.automationRule.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!rule) throw app.httpErrors.notFound('Rule not found');
    const result = await executeRule(request.auth.tenantId, rule, request.auth.userId);
    await db.automationRule.update({ where: { id }, data: { lastRunAt: new Date(), lastMatchCount: result.matched, runCount: { increment: 1 } } });
    await audit(request, { action: 'automation.rule.ran', resource: 'automationRule', resourceId: id, metadata: { matched: result.matched, created: result.created, preview: result.preview } });
    return result;
  });

  // ----- Delivery log (mobile-ready) --------------------------------------
  app.get('/campaigns/:id/deliveries', { preHandler: [campaignEntityRead, campaignFeature] }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    // The delivery log discloses who a campaign reached, so it takes the same
    // branch scope and the same per-class read authority as the campaign itself.
    const c = await db.campaign.findFirst({ where: { id, ...campaignScopeWhere(request) } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!(await authorizedForCampaign(request, reply, c, 'read'))) return reply;
    const rows = await db.campaignDelivery.findMany({ where: { tenantId: request.auth.tenantId, campaignId: id }, orderBy: { createdAt: 'desc' }, take: 500 });
    return rows.map(d => ({ deliveryId: d.id, campaignId: d.campaignId, patientId: d.patientId, leadId: d.leadId, channel: d.channel, destinationMasked: d.destinationMasked, status: d.status, provider: d.provider, providerMessageId: d.providerMessageId, failureReason: d.failureReason, sentAt: d.sentAt?.toISOString() ?? null, providerAcceptedAt: d.providerAcceptedAt?.toISOString() ?? null, deliveredAt: d.deliveredAt?.toISOString() ?? null, statusUpdatedAt: d.statusUpdatedAt.toISOString(), deepLinkTarget: `campaign/${id}` }));
  });

  // ----- Opportunity scan: connect real audiences → signals + recs --------
  // Rule-based; every recommendation requires human approval before action.
  app.post('/opportunities/scan', { preHandler: [campaignManage, campaignFeature] }, async request => {
    const tenantId = request.auth.tenantId;
    // A branch-restricted operator scans their own branch only; the recorded
    // scope travels with the recommendation so the count is never read as
    // tenant-wide.
    const branchId = request.auth.branchId;
    const defs: Array<{ audience: AudienceType; feature: string; signalType: string; recType: string; title: string; event?: WorkflowEventType }> = [
      { audience: 'inactive_patients', feature: 'patient_crm', signalType: 'inactive_patient_opportunity', recType: 'reactivate_inactive_patient', title: 'Reactivate inactive patient', event: 'patient.reactivation.recommended' },
      { audience: 'no_show_recovery', feature: 'patient_crm', signalType: 'no_show_recovery_needed', recType: 'send_no_show_recovery', title: 'Send no-show recovery message', event: 'no_show.recovery.recommended' },
      { audience: 'unpaid_deposit_followup', feature: 'payments_deposits', signalType: 'unpaid_deposit_followup_needed', recType: 'send_unpaid_deposit_reminder', title: 'Send unpaid deposit reminder', event: 'unpaid_deposit.followup.recommended' },
      { audience: 'failed_payment_recovery', feature: 'payments_deposits', signalType: 'failed_payment_followup_needed', recType: 'send_failed_payment_recovery', title: 'Review failed payment', event: 'failed_payment.followup.recommended' },
      { audience: 'insurance_update_request', feature: 'insurance_eligibility', signalType: 'insurance_update_needed', recType: 'request_insurance_update', title: 'Ask patient to update insurance', event: 'insurance_update.followup.recommended' },
      { audience: 'appointment_request_followup', feature: 'ai_receptionist', signalType: 'appointment_request_followup_needed', recType: 'follow_up_receptionist_lead', title: 'Follow up on AI receptionist lead' },
      { audience: 'review_request', feature: 'patient_crm', signalType: 'review_request_opportunity', recType: 'request_review', title: 'Request review after completed appointment', event: 'review_request.recommended' },
    ];
    const scanned: Array<{ audience: string; count: number }> = [];
    for (const d of defs) {
      if (!(await isFeatureEnabled(tenantId, d.feature))) continue;
      const candidates = await buildAudience(tenantId, d.audience, { branchId });
      if (candidates.length === 0) continue;
      const signal = await upsertSignal(tenantId, { signalType: d.signalType, entityType: 'campaignOpportunity', entityId: d.audience, severity: 'low', score: Math.min(100, candidates.length), reason: `${candidates.length} ${d.audience} candidates` });
      await createRecommendation(tenantId, { signalId: signal.id, title: d.title, recommendationType: d.recType, reason: `${candidates.length} contacts match the ${d.audience} audience.`, expectedImpact: 'Recover/retain patient revenue', confidence: 55, allowedActionType: 'create_campaign', sourceData: { audience: d.audience, count: candidates.length, branchScope: branchId ?? 'tenant' } });
      if (d.event) await emitBusinessEvent(tenantId, { eventType: d.event, entityType: 'campaignOpportunity', entityId: d.audience, sourceModule: 'crm', payload: { count: candidates.length } }).catch(() => {});
      scanned.push({ audience: d.audience, count: candidates.length });
    }

    // Empty-slot fill (rule-based foundation). No availability engine exists, so
    // demand (pending appointment requests) is matched against existing booking
    // gaps only — a recommendation, never automated booking.
    if (await isFeatureEnabled(tenantId, 'patient_crm')) {
      const [pendingRequests, openSlots] = await Promise.all([
        db.appointmentRequest.count({ where: { tenantId, ...(branchId ? { branchId } : {}), status: { in: ['PENDING_REVIEW', 'MISSING_INFO'] } } }),
        countOpenSlots(tenantId, 7, { branchId }), // real open slots from existing appointment gaps
      ]);
      if (pendingRequests > 0 && openSlots > 0) {
        const matchable = Math.min(pendingRequests, openSlots);
        const signal = await upsertSignal(tenantId, { signalType: 'empty_slot_fill_opportunity', entityType: 'campaignOpportunity', entityId: 'empty_slots', severity: 'low', score: Math.min(100, matchable), reason: `${openSlots} open slots / ${pendingRequests} pending requests over the next 7 days` });
        await createRecommendation(tenantId, { signalId: signal.id, title: 'Fill open appointment slot', recommendationType: 'fill_open_slot', reason: `${openSlots} open slots over the next 7 days; ${pendingRequests} pending requests could fill them (review-only — no auto-booking).`, expectedImpact: 'Increase schedule utilization', confidence: 50, allowedActionType: 'create_campaign', sourceData: { pendingRequests, openSlots, branchScope: branchId ?? 'tenant' } });
        await emitBusinessEvent(tenantId, { eventType: 'empty_slot.fill.recommended', entityType: 'campaignOpportunity', entityId: 'empty_slots', sourceModule: 'crm', payload: { pendingRequests, openSlots } }).catch(() => {});
        scanned.push({ audience: 'empty_slot_fill_opportunity', count: matchable });
      }
    }
    await audit(request, { action: 'campaign.opportunities.scanned', resource: 'campaign', resourceId: tenantId, metadata: { scanned: scanned.length } });
    return { scanned, requiresHumanReview: true };
  });

  // ----- Communication consent + suppression ------------------------------
  // Consent evidence is patient data, so it takes `crm:read` (the same grant as
  // GET /v1/leads) and the Patient CRM entitlement it actually serves — NOT
  // campaign_automation. The CRM page requests this alongside /v1/leads and
  // /v1/patients, so gating it on a campaign add-on made a tenant without that
  // add-on fail the whole request set and blank a page it is entitled to.
  app.get('/consent', { preHandler: [crmRead, patientCrmFeature] }, async request => {
    const q = z.object({ patientId: uuid.optional() }).parse(request.query);
    const [legacyRows, patientEvents] = await Promise.all([
      db.communicationConsent.findMany({ where: { tenantId: request.auth.tenantId, ...(q.patientId ? { patientId: q.patientId } : {}) }, orderBy: { updatedAt: 'desc' }, take: 200 }),
      db.consentEvent.findMany({
        where: {
          tenantId: request.auth.tenantId,
          ...(q.patientId ? { patientId: q.patientId } : {}),
          purpose: { in: ['SMS', 'EMAIL', 'WHATSAPP'] },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 500,
        select: { id: true, patientId: true, purpose: true, granted: true, source: true, occurredAt: true },
      }),
    ]);
    const eventKeys = new Set<string>();
    const eventRows = patientEvents.flatMap(event => {
      const channel = event.purpose.toLowerCase();
      const key = `${event.patientId}:${channel}`;
      if (eventKeys.has(key)) return [];
      eventKeys.add(key);
      return [{
        id: event.id, tenantId: request.auth.tenantId, patientId: event.patientId, leadId: null,
        channel, status: event.granted ? 'opted_in' : 'opted_out', source: event.source,
        capturedAt: event.occurredAt, revokedAt: event.granted ? null : event.occurredAt,
        metadata: null, createdAt: event.occurredAt, updatedAt: event.occurredAt,
      }];
    });
    return [
      ...eventRows,
      ...legacyRows.filter(row => !row.patientId || !eventKeys.has(`${row.patientId}:${row.channel.toLowerCase()}`)),
    ].slice(0, 200);
  });

  app.post('/consent', { preHandler: [crmWrite, campaignFeature] }, async (request, reply) => {
    const input = z.object({
      patientId: uuid.optional(), leadId: uuid.optional(), channel: channelEnum,
      status: z.enum(['opted_in', 'opted_out', 'unknown']), source: z.string().trim().max(80).default('staff'),
      purpose: voicePurpose.optional(), policyVersion: z.string().trim().min(1).max(100).optional(),
      outreachPurpose: z.enum(CAMPAIGN_TYPES).optional(),
      disclosureTextHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      evidenceReference: z.string().trim().min(3).max(200).optional(),
      captureMethod: voiceCaptureMethod.optional(), evidenceSource: voiceEvidenceSource.optional(),
      jurisdiction: z.string().trim().min(2).max(100).optional(),
      occurredAt: z.coerce.date().optional(), expiresAt: z.coerce.date().optional(),
    }).parse(request.body);
    if (Boolean(input.patientId) === Boolean(input.leadId)) throw app.httpErrors.badRequest('Exactly one patientId or leadId is required');

    if (input.channel !== 'voice') {
      if (input.status === 'unknown') throw app.httpErrors.badRequest('Non-voice authority must be an explicit grant or revocation');
      if (input.status === 'opted_in' && input.leadId) {
        throw app.httpErrors.conflict('Affirmative lead outreach is unavailable until an immutable, purpose-specific lead authority record is supported');
      }
      if (input.status === 'opted_in' && (!input.outreachPurpose || !input.policyVersion || !input.disclosureTextHash
        || !input.evidenceReference || !input.captureMethod || !input.evidenceSource || !input.jurisdiction)) {
        throw app.httpErrors.badRequest('Affirmative non-voice authority requires outreachPurpose, policyVersion, disclosureTextHash, evidenceReference, captureMethod, evidenceSource, and jurisdiction');
      }
      if (input.captureMethod && input.evidenceSource && VOICE_SOURCE_BY_METHOD[input.captureMethod] !== input.evidenceSource) {
        throw app.httpErrors.badRequest('Evidence source is incompatible with captureMethod');
      }
      if (input.captureMethod === 'import_verified' && !['OWNER', 'ADMIN'].includes(request.auth.role)) {
        throw app.httpErrors.forbidden('Verified consent imports require OWNER or ADMIN review');
      }
      const occurredAt = input.occurredAt ?? new Date();
      if (occurredAt > new Date(Date.now() + 5 * 60_000) || (input.expiresAt && input.expiresAt <= occurredAt)) {
        throw app.httpErrors.badRequest('Authority evidence timestamps are invalid');
      }
      const channelPurpose = input.channel === 'sms' ? 'SMS' as const : input.channel === 'email' ? 'EMAIL' as const : 'WHATSAPP' as const;
      const result = await db.$transaction(async tx => {
        // Serialize with the campaign submission fence and the receptionist
        // outbound/confirmation boundaries, which take these SAME advisory locks
        // before they re-read suppression. Without this a revocation could
        // commit between a dispatcher's last check and its provider request;
        // with it, the revocation is either visible to that check or lands
        // strictly after the authorization it could not have affected.
        await lockSuppressionFences(tx, {
          tenantId: request.auth.tenantId,
          patientId: input.patientId ?? null,
          leadId: input.leadId ?? null,
        });
        const identityExists = input.patientId
          ? await tx.patient.count({ where: { id: input.patientId, tenantId: request.auth.tenantId, deletedAt: null } })
          : await tx.lead.count({ where: { id: input.leadId!, tenantId: request.auth.tenantId } });
        if (identityExists !== 1) throw app.httpErrors.notFound('Consent identity not found in this tenant');

        if (input.patientId) {
          const event = await tx.consentEvent.create({ data: {
            tenantId: request.auth.tenantId,
            patientId: input.patientId,
            purpose: channelPurpose,
            granted: input.status === 'opted_in',
            source: input.evidenceSource ?? input.source,
            occurredAt,
            metadata: input.status === 'opted_in' ? {
              authorityVersion: NON_VOICE_OUTREACH_AUTHORITY_VERSION,
              outreachPurpose: input.outreachPurpose!,
              policyVersion: input.policyVersion!,
              disclosureTextHash: input.disclosureTextHash!,
              evidenceReference: input.evidenceReference!,
              captureMethod: input.captureMethod!,
              evidenceSource: input.evidenceSource!,
              jurisdiction: input.jurisdiction!,
              expiresAt: input.expiresAt?.toISOString() ?? null,
            } : { authorityVersion: NON_VOICE_OUTREACH_AUTHORITY_VERSION, revocationScope: 'channel_all_purposes' },
          } });
          await tx.auditEvent.create({ data: {
            tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
            action: input.status === 'opted_in' ? 'communication.authority.granted' : 'communication.authority.revoked',
            resource: 'consentEvent', resourceId: event.id, requestId: request.id,
            ipAddress: request.ip, userAgent: request.headers['user-agent'],
            metadata: { channel: input.channel, outreachPurpose: input.outreachPurpose ?? null, policyVersion: input.policyVersion ?? null },
          } });
          return { authorityEvent: event };
        }

        // Leads may revoke/suppress a channel, but cannot acquire affirmative
        // live authority through the legacy mutable consent record.
        const existing = await tx.communicationConsent.findFirst({
          where: { tenantId: request.auth.tenantId, patientId: null, leadId: input.leadId!, channel: input.channel },
        });
        const consent = existing
          ? await tx.communicationConsent.update({ where: { id: existing.id }, data: { status: 'opted_out', source: input.source, capturedAt: occurredAt, revokedAt: occurredAt } })
          : await tx.communicationConsent.create({ data: { tenantId: request.auth.tenantId, leadId: input.leadId!, channel: input.channel, status: 'opted_out', source: input.source, capturedAt: occurredAt, revokedAt: occurredAt } });
        await tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
          action: 'communication.authority.revoked', resource: 'communicationConsent', resourceId: consent.id,
          requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
          metadata: { channel: input.channel, identityType: 'lead' },
        } });
        return { consent };
      });
      return reply.code(201).send(result);
    }

    if (input.status === 'unknown') throw app.httpErrors.badRequest('Voice evidence must be an explicit grant or revocation');
    if (!input.purpose || !input.policyVersion || !input.disclosureTextHash || !input.evidenceReference || !input.captureMethod || !input.evidenceSource || !input.jurisdiction) {
      throw app.httpErrors.badRequest('Voice evidence requires purpose, policyVersion, disclosureTextHash, evidenceReference, captureMethod, evidenceSource, and jurisdiction');
    }
    if (VOICE_SOURCE_BY_METHOD[input.captureMethod] !== input.evidenceSource) {
      throw app.httpErrors.badRequest('Voice evidence source is incompatible with captureMethod');
    }
    if (!['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK'].includes(request.auth.role)) {
      throw app.httpErrors.forbidden('This role cannot attest outbound voice-consent evidence');
    }
    if (input.captureMethod === 'import_verified' && !['OWNER', 'ADMIN'].includes(request.auth.role)) {
      throw app.httpErrors.forbidden('Verified consent imports require OWNER or ADMIN review');
    }
    const occurredAt = input.occurredAt ?? new Date();
    if (occurredAt > new Date(Date.now() + 5 * 60_000) || (input.expiresAt && input.expiresAt <= occurredAt)) {
      throw app.httpErrors.badRequest('Voice evidence timestamps are invalid');
    }
    const identityExists = input.patientId
      ? await db.patient.count({ where: { id: input.patientId, tenantId: request.auth.tenantId, deletedAt: null } })
      : await db.lead.count({ where: { id: input.leadId!, tenantId: request.auth.tenantId } });
    if (identityExists !== 1) throw app.httpErrors.notFound('Consent identity not found in this tenant');

    const result = await db.$transaction(async tx => {
      const voiceEvent = await tx.receptionistVoiceConsentEvent.create({ data: {
        tenantId: request.auth.tenantId, patientId: input.patientId, leadId: input.leadId,
        purpose: input.purpose!, granted: input.status === 'opted_in', policyVersion: input.policyVersion!,
        disclosureTextHash: input.disclosureTextHash!, evidenceReference: input.evidenceReference!,
        captureMethod: input.captureMethod!, source: input.evidenceSource!, actorUserId: request.auth.userId,
        jurisdiction: input.jurisdiction!, occurredAt, expiresAt: input.expiresAt,
      } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: input.status === 'opted_in' ? 'receptionist.voiceConsent.granted' : 'receptionist.voiceConsent.revoked',
        resource: 'receptionistVoiceConsentEvent', resourceId: voiceEvent.id, requestId: request.id,
        ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { purpose: input.purpose, policyVersion: input.policyVersion, captureMethod: input.captureMethod },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId,
        eventType: input.status === 'opted_in' ? 'receptionist.voice_consent.granted' : 'receptionist.voice_consent.revoked',
        entityType: 'receptionistVoiceConsentEvent', entityId: voiceEvent.id, sourceModule: 'crm',
        payload: { purpose: input.purpose, policyVersion: input.policyVersion, granted: input.status === 'opted_in' },
      } });
      return { voiceEvent };
    });
    return reply.code(201).send(result);
  });

  app.get('/suppressions', { preHandler: [crmRead, campaignFeature] }, async request => {
    return db.campaignSuppression.findMany({ where: { tenantId: request.auth.tenantId, active: true }, orderBy: { createdAt: 'desc' }, take: 200 });
  });

  app.post('/suppressions', { preHandler: [crmWrite, campaignFeature] }, async (request, reply) => {
    const input = z.object({ patientId: uuid.optional(), leadId: uuid.optional(), channel: channelEnum, reason: z.string().min(2).max(240) }).parse(request.body);
    if (!input.patientId && !input.leadId) throw app.httpErrors.badRequest('patientId or leadId required');
    // CampaignSuppression.patientId carries a bare Patient FK and leadId carries
    // no FK at all, so the identity must be proven to belong to this tenant here
    // — exactly as POST /consent does. Without it an unknown id crashed on the
    // FK and another tenant's id was accepted as a reference.
    const identityExists = input.patientId
      ? await db.patient.count({ where: { id: input.patientId, tenantId: request.auth.tenantId, deletedAt: null } })
      : await db.lead.count({ where: { id: input.leadId!, tenantId: request.auth.tenantId } });
    if (identityExists !== 1) throw app.httpErrors.badRequest('Suppression identity must belong to the authenticated tenant');
    // Same advisory fences as POST /consent: a suppression written here must be
    // seen by any dispatcher that has not yet committed its provider intent.
    const row = await db.$transaction(async tx => {
      await lockSuppressionFences(tx, {
        tenantId: request.auth.tenantId,
        patientId: input.patientId ?? null,
        leadId: input.leadId ?? null,
      });
      return tx.campaignSuppression.create({ data: { tenantId: request.auth.tenantId, patientId: input.patientId, leadId: input.leadId, channel: input.channel, reason: input.reason, active: true } });
    });
    await audit(request, { action: 'suppression.created', resource: 'campaignSuppression', resourceId: row.id, metadata: { channel: input.channel } });
    return reply.code(201).send(row);
  });
};

// ===== Provider delivery/status webhook (public, no JWT) ===================
// Signature-verified, idempotent. Maps a provider callback to a CampaignDelivery
// by providerMessageId and transitions status truthfully (delivered/failed) —
// never claims delivered without a real, verified provider event. When no signing
// secret is configured (no provider wired) it returns provider_not_integrated.
function verifyCampaignSignature(rawBody: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!rawBody || !header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const crmWebhookRoutes: FastifyPluginAsync = async app => {
  app.post('/webhooks/delivery', async (request, reply) => {
    // No provider integrated → acknowledge without mutating any state.
    if (!env.CAMPAIGN_WEBHOOK_SECRET) {
      if (env.NODE_ENV === 'production') return reply.code(503).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
      return reply.code(501).send({ status: 'provider_not_integrated', idempotentBy: 'providerMessageId', signatureReady: true });
    }
    const sigRaw = request.headers['x-provider-signature'];
    const signature = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
    if (!verifyCampaignSignature(request.rawBody, signature, env.CAMPAIGN_WEBHOOK_SECRET)) {
      request.log.warn({ ip: request.ip }, 'Campaign delivery webhook signature verification failed');
      return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
    }
    const event = z.object({ eventId: z.string().min(1), providerMessageId: z.string().min(1), status: z.string().min(1) }).safeParse(request.body ?? {});
    if (!event.success) return reply.code(400).send({ error: 'INVALID_EVENT' });

    const resolved = await resolveIngressTenant('campaign_provider_message', event.data.providerMessageId);
    if (!resolved) return reply.code(200).send({ received: true, matched: false });
    enterTenantContext({ tenantId: resolved.tenantId, actorId: `webhook:campaign:${resolved.resourceId}`, actorRole: 'WEBHOOK', source: 'webhook', requestId: request.id });

    const normalizedStatus = normalizeProviderDeliveryStatus(event.data.status);
    if (!normalizedStatus) return reply.code(400).send({ error: 'UNSUPPORTED_PROVIDER_STATUS' });
    try {
      const result = await applyCampaignDeliveryWebhook({
        tenantId: resolved.tenantId,
        deliveryId: resolved.resourceId,
        providerMessageId: event.data.providerMessageId,
        eventId: event.data.eventId,
        providerStatus: event.data.status,
        normalizedStatus,
        requestId: request.id,
        ipAddress: request.ip,
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof Error && error.message === 'CAMPAIGN_DELIVERY_NOT_FOUND') {
        return reply.code(200).send({ received: true, matched: false });
      }
      throw error;
    }
  });
};
