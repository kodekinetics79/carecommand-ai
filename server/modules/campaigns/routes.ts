import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature, isFeatureEnabled } from '../../lib/entitlements';
import { emitBusinessEvent, upsertSignal, createRecommendation, type WorkflowEventType } from '../../lib/intelligence';
import type { Campaign } from '../../generated/prisma/client';
import {
  CAMPAIGN_TYPES, AUDIENCE_TYPES, STAFF_FACING_AUDIENCES,
  buildAudience, previewAudience, channelStatus, resolveDeliveryStatus, isSuppressed,
  generateDraft, maskDestination,
  type AudienceType, type CommChannel, type CampaignType,
} from '../../lib/campaigns';

// ===========================================================================
// CRM Campaign / Reactivation engine routes (mounted at /v1/crm — distinct from
// the existing analytics /v1/campaigns). Feature-gated by campaign_automation;
// audience sources additionally gated by their own entitlement. Consent +
// suppression enforced; delivery never faked. Mobile-ready responses.
// ===========================================================================

const uuid = z.string().uuid();
const campaignFeature = requireFeature('campaign_automation');
const writeRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'FRONT_DESK');
const launchRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'BILLING');
const channelEnum = z.enum(['sms', 'email', 'voice', 'whatsapp']);

// Which entitlement each audience source requires (beyond campaign_automation).
const AUDIENCE_FEATURE: Record<AudienceType, string> = {
  inactive_patients: 'patient_crm', no_show_recovery: 'patient_crm', review_request: 'patient_crm',
  unpaid_deposit_followup: 'payments_deposits', failed_payment_recovery: 'payments_deposits',
  insurance_update_request: 'insurance_eligibility', appointment_request_followup: 'ai_receptionist',
};

function mapCampaign(c: Campaign) {
  return {
    id: c.id, name: c.name, campaignType: c.campaignType, audienceType: c.audienceType,
    channel: c.campaignChannel, status: c.status, requiresApproval: c.requiresApproval,
    approvedByUserId: c.approvedByUserId, approvedAt: c.approvedAt?.toISOString() ?? null,
    scheduledAt: c.scheduledAt?.toISOString() ?? null, messageSubject: c.messageSubject,
    messageTemplate: c.messageTemplate, draftSource: c.draftSource, audienceSize: c.audienceSize,
    createdAt: c.createdAt.toISOString(),
    allowedActions: campaignActions(c),
    deepLinkTarget: `campaign/${c.id}`,
    requiresApprovalPending: c.requiresApproval && !c.approvedByUserId,
  };
}

function campaignActions(c: Campaign): string[] {
  const a: string[] = [];
  if (c.status === 'APPROVAL_REQUIRED') a.push('edit', 'generate_draft', 'approve');
  if (c.status === 'DRAFT') a.push('edit', 'generate_draft', 'launch');
  if (c.status === 'SCHEDULED') a.push('launch');
  if (c.status === 'ACTIVE') a.push('pause');
  if (c.status === 'PAUSED') a.push('launch');
  if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(c.status)) a.push('cancel');
  return a;
}

export const crmRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', campaignFeature);

  // ----- Campaigns CRUD ---------------------------------------------------
  app.get('/campaigns', async request => {
    const rows = await db.campaign.findMany({ where: { tenantId: request.auth.tenantId, campaignType: { not: null } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(mapCampaign);
  });

  app.get('/campaigns/:id', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    const deliveries = await db.campaignDelivery.groupBy({ by: ['status'], where: { tenantId: request.auth.tenantId, campaignId: id }, _count: true });
    return { ...mapCampaign(c), deliveryCounts: Object.fromEntries(deliveries.map(d => [d.status, d._count])) };
  });

  app.post('/campaigns', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({
      name: z.string().trim().min(2).max(160),
      campaignType: z.enum(CAMPAIGN_TYPES),
      audienceType: z.enum(AUDIENCE_TYPES).optional(),
      channel: channelEnum.default('sms'),
      messageSubject: z.string().max(200).optional(),
      messageTemplate: z.string().max(2000).optional(),
      scheduledAt: z.coerce.date().optional(),
    }).parse(request.body);
    const row = await db.campaign.create({
      data: {
        tenantId: request.auth.tenantId, name: input.name, goal: input.campaignType, status: 'APPROVAL_REQUIRED', channels: [],
        campaignType: input.campaignType, audienceType: input.audienceType, campaignChannel: input.channel,
        messageSubject: input.messageSubject, messageTemplate: input.messageTemplate,
        requiresApproval: true, scheduledAt: input.scheduledAt, createdByUserId: request.auth.userId, draftSource: 'rule_based',
      },
    });
    await audit(request, { action: 'campaign.created', resource: 'campaign', resourceId: row.id, metadata: { campaignType: input.campaignType } });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'campaign.created', entityType: 'campaign', entityId: row.id, sourceModule: 'crm', payload: { campaignType: input.campaignType } }).catch(() => {});
    return reply.code(201).send(mapCampaign(row));
  });

  app.patch('/campaigns/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({ name: z.string().trim().min(2).max(160).optional(), messageSubject: z.string().max(200).optional(), messageTemplate: z.string().max(2000).optional(), channel: channelEnum.optional(), scheduledAt: z.coerce.date().optional() }).parse(request.body);
    const existing = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Campaign not found');
    if (!['DRAFT', 'APPROVAL_REQUIRED'].includes(existing.status)) throw app.httpErrors.conflict('Only draft/approval-required campaigns can be edited');
    const row = await db.campaign.update({ where: { id }, data: { name: input.name, messageSubject: input.messageSubject, messageTemplate: input.messageTemplate, campaignChannel: input.channel, scheduledAt: input.scheduledAt } });
    await audit(request, { action: 'campaign.updated', resource: 'campaign', resourceId: id });
    return mapCampaign(row);
  });

  // ----- Rule-based draft generation (requires approval before launch) ----
  app.post('/campaigns/:id/draft', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    const draft = generateDraft((c.campaignType ?? 'custom') as CampaignType, (c.campaignChannel ?? 'sms') as CommChannel, (c.audienceType ?? 'inactive_patients') as AudienceType);
    await db.campaign.update({ where: { id }, data: { messageSubject: draft.subject, messageTemplate: draft.body, draftSource: draft.draftSource, requiresApproval: true } });
    return { ...draft, campaignId: id };
  });

  // ----- Audience preview (deterministic, consent-gated) ------------------
  app.get('/audiences/:type/preview', async (request, reply) => {
    const { type } = z.object({ type: z.enum(AUDIENCE_TYPES) }).parse(request.params);
    const query = z.object({ channel: channelEnum.default('sms') }).parse(request.query);
    if (!(await isFeatureEnabled(request.auth.tenantId, AUDIENCE_FEATURE[type]))) {
      return reply.code(403).send({ error: 'feature_locked', feature: AUDIENCE_FEATURE[type], message: `Audience source ${type} requires ${AUDIENCE_FEATURE[type]}.` });
    }
    return previewAudience(request.auth.tenantId, type, query.channel);
  });

  // ----- Approve ----------------------------------------------------------
  app.post('/campaigns/:id/approve', { preHandler: launchRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    const row = await db.campaign.update({ where: { id }, data: { approvedByUserId: request.auth.userId, approvedAt: new Date(), status: c.status === 'APPROVAL_REQUIRED' ? 'SCHEDULED' : c.status } });
    await audit(request, { action: 'campaign.approved', resource: 'campaign', resourceId: id });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'campaign.approved', entityType: 'campaign', entityId: id, sourceModule: 'crm', payload: {} }).catch(() => {});
    return mapCampaign(row);
  });

  // ----- Launch (build audience → idempotent deliveries) ------------------
  app.post('/campaigns/:id/launch', { preHandler: launchRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ force: z.boolean().default(false) }).parse(request.body ?? {});
    const c = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    if (!c.audienceType) throw app.httpErrors.badRequest('Campaign has no audience type');
    if (c.requiresApproval && !c.approvedByUserId) throw app.httpErrors.conflict('Campaign requires approval before launch');

    const audienceType = c.audienceType as AudienceType;
    if (!(await isFeatureEnabled(request.auth.tenantId, AUDIENCE_FEATURE[audienceType]))) {
      return reply.code(403).send({ error: 'feature_locked', feature: AUDIENCE_FEATURE[audienceType] });
    }
    if (STAFF_FACING_AUDIENCES.has(audienceType)) throw app.httpErrors.badRequest('This audience is staff-facing and cannot be used for patient outreach');

    const channel = (c.campaignChannel ?? 'sms') as CommChannel;
    const status = channelStatus(channel);
    const candidates = await buildAudience(request.auth.tenantId, audienceType);

    let sent = 0, suppressed = 0, skipped = 0, setupRequired = 0, pending = 0;
    for (const cand of candidates) {
      const contact = channel === 'email' ? cand.email : cand.phone;
      const isSupp = await isSuppressed(request.auth.tenantId, cand, channel);
      const deliveryStatus = resolveDeliveryStatus({ suppressed: isSupp, hasContact: !!contact, status });
      const key = `${id}:${cand.patientId ?? cand.leadId ?? 'x'}:${channel}`;

      const existing = await db.campaignDelivery.findFirst({ where: { tenantId: request.auth.tenantId, campaignId: id, patientId: cand.patientId, leadId: cand.leadId, channel } });
      if (existing) {
        // Idempotent: never resend an already-sent recipient unless forced.
        if (existing.status === 'sent' && !body.force) { sent++; continue; }
        await db.campaignDelivery.update({ where: { id: existing.id }, data: { status: deliveryStatus, destinationMasked: maskDestination(contact), provider: status.provider, providerMessageId: deliveryStatus === 'sent' ? `mock_${key.slice(0, 24)}` : existing.providerMessageId, idempotencyKey: key, sentAt: deliveryStatus === 'sent' ? new Date() : existing.sentAt } });
      } else {
        await db.campaignDelivery.create({ data: { tenantId: request.auth.tenantId, campaignId: id, patientId: cand.patientId, leadId: cand.leadId, channel, destinationMasked: maskDestination(contact), status: deliveryStatus, provider: status.provider, providerMessageId: deliveryStatus === 'sent' ? `mock_${key.slice(0, 24)}` : null, idempotencyKey: key, sentAt: deliveryStatus === 'sent' ? new Date() : null } });
      }
      if (deliveryStatus === 'sent') sent++; else if (deliveryStatus === 'suppressed') suppressed++; else if (deliveryStatus === 'skipped') skipped++; else if (deliveryStatus === 'setup_required') setupRequired++; else pending++;
    }

    // Truthful: a launch that could only queue setup_required rows stays
    // SCHEDULED (provider not configured) rather than claiming it ran.
    const newStatus = sent > 0 ? 'ACTIVE' : 'SCHEDULED';
    await db.campaign.update({ where: { id }, data: { status: newStatus as never, audienceSize: candidates.length, sent } });
    await audit(request, { action: 'campaign.launched', resource: 'campaign', resourceId: id, metadata: { sent, suppressed, skipped, setupRequired } });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'campaign.launched', entityType: 'campaign', entityId: id, sourceModule: 'crm', payload: { sent, suppressed } }).catch(() => {});
    if (sent > 0) await emitBusinessEvent(request.auth.tenantId, { eventType: 'campaign.delivery.sent', entityType: 'campaign', entityId: id, sourceModule: 'crm', payload: { count: sent } }).catch(() => {});
    if (suppressed > 0) await emitBusinessEvent(request.auth.tenantId, { eventType: 'campaign.delivery.suppressed', entityType: 'campaign', entityId: id, sourceModule: 'crm', payload: { count: suppressed } }).catch(() => {});

    return reply.send({
      campaignId: id, status: newStatus, setupRequired: setupRequired > 0 && sent === 0,
      summary: { total: candidates.length, sent, suppressed, skipped, setupRequired, pending },
      provider: { channel, configured: status.configured, setupRequired: status.setupRequired, missing: status.missing },
      deepLinkTarget: `campaign/${id}`,
    });
  });

  app.post('/campaigns/:id/pause', { preHandler: launchRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    const row = await db.campaign.update({ where: { id }, data: { status: 'PAUSED' } });
    await audit(request, { action: 'campaign.paused', resource: 'campaign', resourceId: id });
    return mapCampaign(row);
  });

  app.post('/campaigns/:id/cancel', { preHandler: launchRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    const row = await db.campaign.update({ where: { id }, data: { status: 'CANCELLED' } });
    await audit(request, { action: 'campaign.cancelled', resource: 'campaign', resourceId: id });
    return mapCampaign(row);
  });

  // ----- Delivery log (mobile-ready) --------------------------------------
  app.get('/campaigns/:id/deliveries', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const rows = await db.campaignDelivery.findMany({ where: { tenantId: request.auth.tenantId, campaignId: id }, orderBy: { createdAt: 'desc' }, take: 500 });
    return rows.map(d => ({ deliveryId: d.id, campaignId: d.campaignId, patientId: d.patientId, leadId: d.leadId, channel: d.channel, destinationMasked: d.destinationMasked, status: d.status, provider: d.provider, providerMessageId: d.providerMessageId, failureReason: d.failureReason, sentAt: d.sentAt?.toISOString() ?? null, deepLinkTarget: `campaign/${id}` }));
  });

  // ----- Opportunity scan: connect real audiences → signals + recs --------
  // Rule-based; every recommendation requires human approval before action.
  app.post('/opportunities/scan', { preHandler: writeRoles }, async request => {
    const tenantId = request.auth.tenantId;
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
      const candidates = await buildAudience(tenantId, d.audience);
      if (candidates.length === 0) continue;
      const signal = await upsertSignal(tenantId, { signalType: d.signalType, entityType: 'campaignOpportunity', entityId: d.audience, severity: 'low', score: Math.min(100, candidates.length), reason: `${candidates.length} ${d.audience} candidates` });
      await createRecommendation(tenantId, { signalId: signal.id, title: d.title, recommendationType: d.recType, reason: `${candidates.length} contacts match the ${d.audience} audience.`, expectedImpact: 'Recover/retain patient revenue', confidence: 55, allowedActionType: 'create_campaign', sourceData: { audience: d.audience, count: candidates.length } });
      if (d.event) await emitBusinessEvent(tenantId, { eventType: d.event, entityType: 'campaignOpportunity', entityId: d.audience, sourceModule: 'crm', payload: { count: candidates.length } }).catch(() => {});
      scanned.push({ audience: d.audience, count: candidates.length });
    }

    // Empty-slot fill (rule-based foundation). No availability engine exists, so
    // demand (pending appointment requests) is matched against existing booking
    // gaps only — a recommendation, never automated booking.
    if (await isFeatureEnabled(tenantId, 'patient_crm')) {
      const pendingRequests = await db.appointmentRequest.count({ where: { tenantId, status: { in: ['PENDING_REVIEW', 'MISSING_INFO'] } } });
      if (pendingRequests > 0) {
        const signal = await upsertSignal(tenantId, { signalType: 'empty_slot_fill_opportunity', entityType: 'campaignOpportunity', entityId: 'empty_slots', severity: 'low', score: Math.min(100, pendingRequests), reason: `${pendingRequests} pending requests available to fill open slots` });
        await createRecommendation(tenantId, { signalId: signal.id, title: 'Fill open appointment slot', recommendationType: 'fill_open_slot', reason: `${pendingRequests} pending appointment requests can fill open slots (review-only).`, expectedImpact: 'Increase schedule utilization', confidence: 50, allowedActionType: 'create_campaign', sourceData: { pendingRequests } });
        await emitBusinessEvent(tenantId, { eventType: 'empty_slot.fill.recommended', entityType: 'campaignOpportunity', entityId: 'empty_slots', sourceModule: 'crm', payload: { pendingRequests } }).catch(() => {});
        scanned.push({ audience: 'empty_slot_fill_opportunity', count: pendingRequests });
      }
    }
    await audit(request, { action: 'campaign.opportunities.scanned', resource: 'campaign', resourceId: tenantId, metadata: { scanned: scanned.length } });
    return { scanned, requiresHumanReview: true };
  });

  // ----- Communication consent + suppression ------------------------------
  app.get('/consent', async request => {
    const q = z.object({ patientId: uuid.optional() }).parse(request.query);
    return db.communicationConsent.findMany({ where: { tenantId: request.auth.tenantId, ...(q.patientId ? { patientId: q.patientId } : {}) }, orderBy: { updatedAt: 'desc' }, take: 200 });
  });

  app.post('/consent', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({ patientId: uuid.optional(), leadId: uuid.optional(), channel: channelEnum, status: z.enum(['opted_in', 'opted_out', 'unknown']), source: z.string().max(80).default('staff') }).parse(request.body);
    if (!input.patientId && !input.leadId) throw app.httpErrors.badRequest('patientId or leadId required');
    const existing = await db.communicationConsent.findFirst({ where: { tenantId: request.auth.tenantId, patientId: input.patientId ?? null, leadId: input.leadId ?? null, channel: input.channel } });
    const row = existing
      ? await db.communicationConsent.update({ where: { id: existing.id }, data: { status: input.status, source: input.source, capturedAt: new Date(), revokedAt: input.status === 'opted_out' ? new Date() : null } })
      : await db.communicationConsent.create({ data: { tenantId: request.auth.tenantId, patientId: input.patientId, leadId: input.leadId, channel: input.channel, status: input.status, source: input.source, revokedAt: input.status === 'opted_out' ? new Date() : null } });
    await audit(request, { action: 'consent.updated', resource: 'communicationConsent', resourceId: row.id, metadata: { channel: input.channel, status: input.status } });
    return reply.code(201).send(row);
  });

  app.get('/suppressions', async request => {
    return db.campaignSuppression.findMany({ where: { tenantId: request.auth.tenantId, active: true }, orderBy: { createdAt: 'desc' }, take: 200 });
  });

  app.post('/suppressions', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({ patientId: uuid.optional(), leadId: uuid.optional(), channel: channelEnum, reason: z.string().min(2).max(240) }).parse(request.body);
    if (!input.patientId && !input.leadId) throw app.httpErrors.badRequest('patientId or leadId required');
    const row = await db.campaignSuppression.create({ data: { tenantId: request.auth.tenantId, patientId: input.patientId, leadId: input.leadId, channel: input.channel, reason: input.reason, active: true } });
    await audit(request, { action: 'suppression.created', resource: 'campaignSuppression', resourceId: row.id, metadata: { channel: input.channel } });
    return reply.code(201).send(row);
  });
};
