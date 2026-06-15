import type { FastifyPluginAsync } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { audit } from '../../lib/audit';
import { claimIdempotency } from '../revenue-protection';
import { requireRoles } from '../../plugins/roles';
import { requireFeature, isFeatureEnabled } from '../../lib/entitlements';
import { emitBusinessEvent, upsertSignal, createRecommendation, type WorkflowEventType } from '../../lib/intelligence';
import type { Campaign } from '../../generated/prisma/client';
import {
  CAMPAIGN_TYPES, AUDIENCE_TYPES, STAFF_FACING_AUDIENCES,
  buildAudience, previewAudience, generateDraft, providerReadiness, countOpenSlots,
  channelStatus, maskDestination, isSuppressed,
  type AudienceType, type CommChannel, type CampaignType,
} from '../../lib/campaigns';
import { dispatchCampaign } from '../../lib/campaignDispatch';
import { sendMessage } from '../../lib/commsProvider';
import { aiProviderConfigured, draftWithAI } from '../../lib/campaignAI';
import { RULE_CATALOG, evaluateRule, executeRule } from '../../lib/automationRules';

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

  // ----- Communications provider readiness (truthful; no secret values) ---
  app.get('/provider-status', async () => providerReadiness());

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

    // Real send via the provider abstraction (dev mock / live / setup_required).
    // Per-recipient delivery events are emitted inside dispatchCampaign.
    const result = await dispatchCampaign(request.auth.tenantId, id, { force: body.force });
    const newStatus = result.sent > 0 ? 'ACTIVE' : 'SCHEDULED';
    await audit(request, { action: 'campaign.launched', resource: 'campaign', resourceId: id, metadata: { sent: result.sent, suppressed: result.suppressed, skipped: result.skipped, setupRequired: result.setupRequired, failed: result.failed } });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'campaign.launched', entityType: 'campaign', entityId: id, sourceModule: 'crm', payload: { sent: result.sent, suppressed: result.suppressed } }).catch(() => {});

    return reply.send({
      campaignId: id, status: newStatus, setupRequired: result.setupRequired > 0 && result.sent === 0,
      summary: { total: result.total, sent: result.sent, suppressed: result.suppressed, skipped: result.skipped, setupRequired: result.setupRequired, pending: result.pending, failed: result.failed },
      provider: { channel: result.channel, configured: result.provider.configured, setupRequired: result.provider.setupRequired, missing: result.provider.missing, mode: result.provider.mock ? 'mock_dev' : result.provider.configured ? 'configured_pending_provider' : 'unconfigured' },
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

  // ----- Delete (hard-remove a campaign + its delivery rows cascade) -------
  app.delete('/campaigns/:id', { preHandler: launchRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!c) throw app.httpErrors.notFound('Campaign not found');
    // CampaignDelivery has onDelete: Cascade, so deliveries are removed with it.
    await db.campaign.delete({ where: { id } });
    await audit(request, { action: 'campaign.deleted', resource: 'campaign', resourceId: id, metadata: { campaignType: c.campaignType, status: c.status } });
    return reply.code(204).send();
  });

  // ----- Consent-checked per-lead send (Pipeline CTAs) --------------------
  // Sends a single transactional message to a lead via the real comms provider.
  // Enforces consent/suppression; never fakes a send (returns setup_required if
  // the provider isn't configured). Audited; no message body / PHI in the log.
  const LEAD_SEND_CTAS = ['send_booking_link', 'send_deposit_link', 'send_intake_form', 'send_follow_up', 'confirm_visit'] as const;
  type LeadSendCta = typeof LEAD_SEND_CTAS[number];
  const SEND_TEMPLATE: Record<LeadSendCta, { subject: string; body: (name: string, service: string, clinic: string) => string }> = {
    send_booking_link: { subject: 'Book your appointment', body: (n, s, c) => `Hi ${n}, this is ${c}. Ready to book your ${s || 'appointment'}? Reply BOOK and we'll find a time that suits you.` },
    send_deposit_link: { subject: 'Secure your booking', body: (n, s, c) => `Hi ${n}, ${c} here. To reserve your ${s || 'appointment'}, a small deposit secures your slot. Reply YES and we'll send a secure payment link.` },
    send_intake_form: { subject: 'Complete your intake', body: (n, s, c) => `Hi ${n}, before your ${s || 'visit'} at ${c}, please complete a short intake form. Reply FORM and we'll send it over.` },
    send_follow_up: { subject: 'Following up', body: (n, s, c) => `Hi ${n}, it's ${c} following up about your ${s || 'care'}. Would you like to schedule your next visit? Reply YES to book.` },
    confirm_visit: { subject: 'Confirm your visit', body: (n, s, c) => `Hi ${n}, please confirm your upcoming ${s || 'appointment'} at ${c}. Reply C to confirm or R to reschedule.` },
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

  app.post('/leads/:id/send', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ cta: z.enum(LEAD_SEND_CTAS), channel: z.enum(['sms', 'email', 'whatsapp']).optional() }).parse(request.body);
    const lead = await db.lead.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!lead) throw app.httpErrors.notFound('Lead not found');

    const channel = body.channel ?? channelFor(lead.channel, !!lead.phone, !!lead.email);
    if (!channel) return reply.code(400).send({ status: 'no_destination', message: 'Lead has no phone or email on file.' });

    // Consent / suppression gate — never message a suppressed/opted-out contact.
    if (await isSuppressed(request.auth.tenantId, { leadId: id }, channel)) {
      await audit(request, { action: 'crm.lead.send.blocked', resource: 'lead', resourceId: id, metadata: { cta: body.cta, channel, reason: 'consent_or_suppression' } });
      return reply.code(409).send({ status: 'blocked', reason: 'consent_or_suppression', message: 'This contact is suppressed or has opted out for this channel.' });
    }

    const destination = channel === 'email' ? lead.email : lead.phone;
    if (!destination) return reply.code(400).send({ status: 'no_destination', message: `Lead has no ${channel === 'email' ? 'email' : 'phone'} on file.` });

    // Provider readiness — truthful; no fake "sent".
    const status = channelStatus(channel);
    if (status.setupRequired) {
      return reply.code(200).send({ status: 'setup_required', channel, provider: status.provider, missing: status.missing, message: `${channel} provider is not configured.` });
    }

    const tenant = await db.tenant.findUnique({ where: { id: request.auth.tenantId }, select: { name: true } });
    const tpl = SEND_TEMPLATE[body.cta];
    const subject = tpl.subject;
    const message = tpl.body(lead.name.split(' ')[0], lead.service, tenant?.name ?? 'your clinic');
    const idempotencyKey = `lead-send:${id}:${body.cta}:${new Date().toISOString().slice(0, 10)}`;

    const result = await sendMessage(channel, destination, subject, message, idempotencyKey);
    await audit(request, { action: 'crm.lead.message_sent', resource: 'lead', resourceId: id, metadata: { cta: body.cta, channel, status: result.status, mode: result.mode } });

    return reply.code(result.ok ? 200 : 502).send({
      status: result.status, channel, destinationMasked: maskDestination(destination),
      mode: result.mode, providerMessageId: result.providerMessageId ?? null, failureReason: result.failureReason ?? null,
    });
  });

  // ----- Automation Rules (trigger → action engine) ----------------------
  function ruleView(r: { id: string; templateKey: string; name: string; triggerType: string; actionType: string; config: unknown; enabled: boolean; lastRunAt: Date | null; lastMatchCount: number; runCount: number }) {
    return { id: r.id, templateKey: r.templateKey, name: r.name, triggerType: r.triggerType, actionType: r.actionType, config: r.config ?? {}, enabled: r.enabled, lastRunAt: r.lastRunAt?.toISOString() ?? null, lastMatchCount: r.lastMatchCount, runCount: r.runCount };
  }

  app.get('/automation-rules/catalog', async () => RULE_CATALOG);

  app.get('/automation-rules', async request => {
    const rows = await db.automationRule.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { createdAt: 'asc' } });
    // Live match-count so the UI shows how many records each rule currently hits.
    return Promise.all(rows.map(async r => ({ ...ruleView(r), matchesNow: (await evaluateRule(request.auth.tenantId, r)).matched })));
  });

  app.post('/automation-rules', { preHandler: writeRoles }, async (request, reply) => {
    const body = z.object({ templateKey: z.string().min(2).max(60), enabled: z.boolean().default(false), config: z.record(z.string(), z.number()).optional() }).parse(request.body);
    const tpl = RULE_CATALOG.find(t => t.key === body.templateKey);
    if (!tpl) throw app.httpErrors.badRequest('Unknown rule template');
    const row = await db.automationRule.create({ data: { tenantId: request.auth.tenantId, templateKey: tpl.key, name: tpl.name, triggerType: tpl.triggerType, actionType: tpl.actionType, config: body.config ?? tpl.config, enabled: body.enabled, createdById: request.auth.userId } });
    await audit(request, { action: 'automation.rule.created', resource: 'automationRule', resourceId: row.id, metadata: { templateKey: tpl.key, enabled: body.enabled } });
    return reply.code(201).send(ruleView(row));
  });

  app.patch('/automation-rules/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ enabled: z.boolean().optional(), name: z.string().min(2).max(120).optional(), config: z.record(z.string(), z.number()).optional() }).parse(request.body);
    const existing = await db.automationRule.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Rule not found');
    const row = await db.automationRule.update({ where: { id }, data: { enabled: body.enabled, name: body.name, config: body.config } });
    await audit(request, { action: 'automation.rule.updated', resource: 'automationRule', resourceId: id, metadata: { enabled: row.enabled } });
    return ruleView(row);
  });

  app.delete('/automation-rules/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const existing = await db.automationRule.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Rule not found');
    await db.automationRule.delete({ where: { id } });
    await audit(request, { action: 'automation.rule.deleted', resource: 'automationRule', resourceId: id });
    return reply.code(204).send();
  });

  // Evaluate + execute a rule once. Task-creating actions run for real;
  // module-owned actions return a governed preview. Audited.
  app.post('/automation-rules/:id/run', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const rule = await db.automationRule.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!rule) throw app.httpErrors.notFound('Rule not found');
    const result = await executeRule(request.auth.tenantId, rule, request.auth.userId);
    await db.automationRule.update({ where: { id }, data: { lastRunAt: new Date(), lastMatchCount: result.matched, runCount: { increment: 1 } } });
    await audit(request, { action: 'automation.rule.ran', resource: 'automationRule', resourceId: id, metadata: { matched: result.matched, created: result.created, preview: result.preview } });
    return result;
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
      const [pendingRequests, openSlots] = await Promise.all([
        db.appointmentRequest.count({ where: { tenantId, status: { in: ['PENDING_REVIEW', 'MISSING_INFO'] } } }),
        countOpenSlots(tenantId, 7), // real open slots from existing appointment gaps
      ]);
      if (pendingRequests > 0 && openSlots > 0) {
        const matchable = Math.min(pendingRequests, openSlots);
        const signal = await upsertSignal(tenantId, { signalType: 'empty_slot_fill_opportunity', entityType: 'campaignOpportunity', entityId: 'empty_slots', severity: 'low', score: Math.min(100, matchable), reason: `${openSlots} open slots / ${pendingRequests} pending requests over the next 7 days` });
        await createRecommendation(tenantId, { signalId: signal.id, title: 'Fill open appointment slot', recommendationType: 'fill_open_slot', reason: `${openSlots} open slots over the next 7 days; ${pendingRequests} pending requests could fill them (review-only — no auto-booking).`, expectedImpact: 'Increase schedule utilization', confidence: 50, allowedActionType: 'create_campaign', sourceData: { pendingRequests, openSlots } });
        await emitBusinessEvent(tenantId, { eventType: 'empty_slot.fill.recommended', entityType: 'campaignOpportunity', entityId: 'empty_slots', sourceModule: 'crm', payload: { pendingRequests, openSlots } }).catch(() => {});
        scanned.push({ audience: 'empty_slot_fill_opportunity', count: matchable });
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

    // Idempotent on the provider event id — duplicate callbacks are acknowledged.
    const claim = await claimIdempotency('campaign.delivery.webhook', event.data.eventId);
    if (!claim.claimed) return reply.code(200).send({ received: true, duplicate: true });

    const delivery = await db.campaignDelivery.findFirst({ where: { providerMessageId: event.data.providerMessageId } });
    if (!delivery) return reply.code(200).send({ received: true, matched: false });

    const s = event.data.status.toLowerCase();
    const mapped = ['delivered', 'sent'].includes(s) ? 'sent' : ['failed', 'undelivered', 'bounced'].includes(s) ? 'failed' : null;
    // Only transition a non-terminal-from-callback state; never regress a recorded failure.
    if (mapped && delivery.status !== 'failed') {
      await db.campaignDelivery.update({ where: { id: delivery.id }, data: { status: mapped, failureReason: mapped === 'failed' ? event.data.status : delivery.failureReason } });
      await db.auditEvent.create({ data: { tenantId: delivery.tenantId, action: mapped === 'failed' ? 'campaign.delivery.failed' : 'campaign.delivery.sent', resource: 'campaignDelivery', resourceId: delivery.id, ipAddress: request.ip, metadata: { providerStatus: s } } }).catch(() => {});
    }
    return reply.code(200).send({ received: true });
  });
};
