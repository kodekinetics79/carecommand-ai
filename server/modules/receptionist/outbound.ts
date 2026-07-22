import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { requireRoles } from '../../plugins/roles';
import { retellConfigStatus, createPhoneCall } from '../../lib/retell';
import { isDestinationOptedOut } from '../../lib/campaigns';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const writeRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');
const REQUIRED_FIELD_KEYS = ['firstName', 'lastName', 'phone', 'email', 'preferredBranch', 'preferredService', 'preferredDateTime'] as const;

// --- Quiet-hours enforcement (per outbound campaign, clinic timezone) --------
function parseHm(value?: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function nowMinutesInTz(timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const h = Number(parts.find(p => p.type === 'hour')?.value);
    const min = Number(parts.find(p => p.type === 'minute')?.value);
    if (Number.isNaN(h) || Number.isNaN(min)) return null;
    return (h % 24) * 60 + min;
  } catch {
    return null;
  }
}

// True when "now" (in the clinic timezone) falls inside the campaign's quiet
// window. Handles overnight windows (e.g. 21:00–08:00 wraps midnight). An unset
// or empty window is never quiet.
export function isWithinQuietHours(start: string | null | undefined, end: string | null | undefined, timezone: string): boolean {
  const s = parseHm(start);
  const e = parseHm(end);
  if (s === null || e === null || s === e) return false;
  const now = nowMinutesInTz(timezone);
  if (now === null) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

// Registered INSIDE receptionistRoutes, so it inherits the ai_receptionist
// feature gate and the authenticated scope.
export const outboundRoutes: FastifyPluginAsync = async app => {
  // ----- Retell setup status (no secrets exposed) -------------------------
  app.get('/retell-status', async () => {
    const status = retellConfigStatus();
    return {
      configured: status.configured,
      mock: status.mock,
      missing: status.missing,
      checklist: [
        { key: 'RETELL_API_KEY', label: 'Retell API key', set: !status.missing.includes('RETELL_API_KEY') },
        { key: 'RETELL_AGENT_ID', label: 'Retell agent id', set: !status.missing.includes('RETELL_AGENT_ID') },
        { key: 'RETELL_FROM_NUMBER', label: 'Outbound caller number', set: !status.missing.includes('RETELL_FROM_NUMBER') },
      ],
    };
  });

  // ----- Outbound campaigns ----------------------------------------------
  const campaignCreate = z.object({
    clinicId: uuid,
    agentId: uuid.optional().nullable(),
    name: z.string().trim().min(2).max(160),
    script: z.string().trim().min(2).max(4000),
    requiredFields: z.array(z.enum(REQUIRED_FIELD_KEYS)).default(['firstName', 'lastName', 'phone']),
    customQuestions: z.any().optional(),
    consentText: z.string().max(2000).optional().nullable(),
    humanHandoffInstruction: z.string().max(1000).optional().nullable(),
    bookingMode: z.enum(['APPOINTMENT_REQUEST_ONLY', 'DIRECT_BOOKING_IF_SLOT_AVAILABLE']).default('APPOINTMENT_REQUEST_ONLY'),
    defaultBranchId: uuid.optional().nullable(),
    defaultService: z.string().max(160).optional().nullable(),
    quietHoursStart: z.string().max(10).optional().nullable(),
    quietHoursEnd: z.string().max(10).optional().nullable(),
    maxRetryAttempts: z.number().int().min(0).max(10).default(1),
  });
  const campaignUpdate = campaignCreate.partial().omit({ clinicId: true }).extend({
    status: z.enum(['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED']).optional(),
  });

  app.get('/outbound-campaigns', async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    return db.receptionistOutboundCampaign.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { targets: true, callLogs: true } } },
    });
  });

  app.get('/outbound-campaigns/:id', async request => {
    const { id } = idParam.parse(request.params);
    const row = await db.receptionistOutboundCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { targets: { orderBy: { createdAt: 'asc' } } } });
    if (!row) throw app.httpErrors.notFound('Campaign not found');
    return row;
  });

  app.post('/outbound-campaigns', { preHandler: writeRoles }, async (request, reply) => {
    const input = campaignCreate.parse(request.body);
    const clinic = await db.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId } });
    if (!clinic) throw app.httpErrors.notFound('Clinic not found');
    const { customQuestions, defaultBranchId, agentId, ...rest } = input;
    const row = await db.receptionistOutboundCampaign.create({
      data: { tenantId: request.auth.tenantId, ...rest, agentId: agentId ?? undefined, defaultBranchId: defaultBranchId ?? undefined, customQuestions: customQuestions ?? undefined },
    });
    await audit(request, { action: 'receptionist.campaign.created', resource: 'receptionistOutboundCampaign', resourceId: row.id, metadata: { name: row.name, bookingMode: row.bookingMode } });
    return reply.code(201).send(row);
  });

  app.patch('/outbound-campaigns/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = campaignUpdate.parse(request.body);
    const existing = await db.receptionistOutboundCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Campaign not found');
    const { customQuestions, ...rest } = input;
    const row = await db.receptionistOutboundCampaign.update({ where: { id }, data: { ...rest, ...(customQuestions !== undefined ? { customQuestions: customQuestions ?? undefined } : {}) } });
    await audit(request, { action: 'receptionist.campaign.updated', resource: 'receptionistOutboundCampaign', resourceId: id, metadata: { status: input.status } });
    return row;
  });

  // ----- Targets ----------------------------------------------------------
  app.get('/outbound-campaigns/:id/targets', async request => {
    const { id } = idParam.parse(request.params);
    return db.receptionistCallTarget.findMany({ where: { tenantId: request.auth.tenantId, campaignId: id }, orderBy: { createdAt: 'asc' } });
  });

  app.post('/outbound-campaigns/:id/targets', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({
      targets: z.array(z.object({
        phone: z.string().trim().min(3).max(40),
        firstName: z.string().trim().max(120).optional(),
        lastName: z.string().trim().max(120).optional(),
        email: z.string().trim().max(160).optional(),
        patientId: uuid.optional(),
        leadId: uuid.optional(),
      })).min(1).max(500),
    }).parse(request.body);
    const campaign = await db.receptionistOutboundCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const created = await db.receptionistCallTarget.createMany({
      data: body.targets.map(t => ({ tenantId: request.auth.tenantId, campaignId: id, phone: t.phone, firstName: t.firstName, lastName: t.lastName, email: t.email, patientId: t.patientId, leadId: t.leadId })),
    });
    return reply.code(201).send({ added: created.count });
  });

  app.delete('/outbound-campaigns/:campaignId/targets/:id', { preHandler: writeRoles }, async (request, reply) => {
    const params = z.object({ campaignId: uuid, id: uuid }).parse(request.params);
    const target = await db.receptionistCallTarget.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId, campaignId: params.campaignId },
    });
    if (!target) throw app.httpErrors.notFound('Target not found');
    await db.receptionistCallTarget.delete({ where: { id: params.id } });
    await audit(request, {
      action: 'receptionist.target.deleted',
      resource: 'receptionistCallTarget',
      resourceId: params.id,
      metadata: { campaignId: params.campaignId, phone: target.phone },
    });
    return reply.code(204).send();
  });

  // ----- Launch a single outbound call (test call or to a target) ---------
  app.post('/outbound-campaigns/:id/call', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({
      phone: z.string().trim().min(3).max(40),
      firstName: z.string().trim().max(120).optional(),
      lastName: z.string().trim().max(120).optional(),
      email: z.string().trim().max(160).optional(),
      targetId: uuid.optional(),
    }).parse(request.body);

    const campaign = await db.receptionistOutboundCampaign.findFirst({
      where: { id, tenantId: request.auth.tenantId },
      include: { clinic: { select: { name: true, complianceDisclosure: true, timezone: true } }, agent: { select: { name: true, voice: true } } },
    });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');

    // ---- Compliance gate: NEVER dial an opted-out number ------------------
    // Consult ReceptionistOptOut (voice channel; ALL/VOICE suppress it), tenant-
    // scoped. This closes gap (c): outbound targets are queued without a filter,
    // so suppression MUST be enforced here at the dial. Record + skip, no dial.
    if (await isDestinationOptedOut(request.auth.tenantId, body.phone, 'voice')) {
      const callLog = await db.receptionistCallLog.create({
        data: {
          tenantId: request.auth.tenantId, clinicId: campaign.clinicId, outboundCampaignId: campaign.id, targetId: body.targetId,
          callerName: [body.firstName, body.lastName].filter(Boolean).join(' ') || null, callerPhone: body.phone,
          direction: 'outbound', outcome: 'OPTED_OUT', startedAt: new Date(), endedAt: new Date(),
        },
      });
      if (body.targetId) await db.receptionistCallTarget.updateMany({ where: { id: body.targetId, tenantId: request.auth.tenantId }, data: { status: 'OPTED_OUT', lastOutcome: 'OPTED_OUT', lastCallLogId: callLog.id } });
      await audit(request, { action: 'receptionist.call.suppressed', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, reason: 'opted_out' } });
      return reply.code(200).send({ status: 'skipped', reason: 'opted_out', callLogId: callLog.id });
    }

    // ---- Quiet-hours gate: never dial during the campaign's quiet window ----
    // Temporary skip (target stays PENDING for a later retry); recorded via audit.
    if (isWithinQuietHours(campaign.quietHoursStart, campaign.quietHoursEnd, campaign.clinic.timezone)) {
      await audit(request, { action: 'receptionist.call.skipped', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'quiet_hours', targetId: body.targetId ?? null } });
      return reply.code(200).send({ status: 'skipped', reason: 'quiet_hours' });
    }

    // Do NOT fake a call: if Retell isn't configured, return setup_required.
    const status = retellConfigStatus();
    if (!status.configured) {
      return reply.code(200).send({ status: 'setup_required', missing: status.missing });
    }

    // Store the call attempt BEFORE calling Retell.
    const callLog = await db.receptionistCallLog.create({
      data: {
        tenantId: request.auth.tenantId, clinicId: campaign.clinicId, outboundCampaignId: campaign.id, targetId: body.targetId,
        callerName: [body.firstName, body.lastName].filter(Boolean).join(' ') || null, callerPhone: body.phone,
        direction: 'outbound', outcome: 'IN_PROGRESS', startedAt: new Date(),
      },
    });

    const result = await createPhoneCall({
      toNumber: body.phone,
      agentId: undefined,
      webhookUrl: `${env.PUBLIC_API_URL}/v1/receptionist/webhooks/retell?clinicId=${campaign.clinicId}`,
      dynamicVariables: {
        clinic_name: campaign.clinic.name,
        agent_name: campaign.agent?.name ?? 'Riley',
        disclosure: campaign.clinic.complianceDisclosure,
        consent_text: campaign.consentText ?? '',
        human_handoff: campaign.humanHandoffInstruction ?? '',
        script: campaign.script,
        required_fields: campaign.requiredFields.join(', '),
        first_name: body.firstName ?? '',
        booking_mode: campaign.bookingMode,
      },
      metadata: { tenantId: request.auth.tenantId, outboundCampaignId: campaign.id, callLogId: callLog.id, targetId: body.targetId ?? null },
    });

    if (!result.ok) {
      await db.receptionistCallLog.update({ where: { id: callLog.id }, data: { outcome: 'FAILED', endedAt: new Date() } });
      await audit(request, { action: 'receptionist.call.failed', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { error: result.error } });
      return reply.code(502).send({ status: 'failed', error: result.error, callLogId: callLog.id });
    }

    await db.receptionistCallLog.update({ where: { id: callLog.id }, data: { retellCallId: result.callId } });
    if (body.targetId) await db.receptionistCallTarget.updateMany({ where: { id: body.targetId, tenantId: request.auth.tenantId }, data: { status: 'CALLING', attempts: { increment: 1 }, lastCallLogId: callLog.id } });
    await audit(request, { action: 'receptionist.call.launched', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, mock: result.mock } });
    return reply.code(201).send({ status: 'launched', callId: result.callId, callLogId: callLog.id, mock: result.mock });
  });

  app.get('/outbound-campaigns/:id/call-logs', async request => {
    const { id } = idParam.parse(request.params);
    return db.receptionistCallLog.findMany({ where: { tenantId: request.auth.tenantId, outboundCampaignId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
  });

  // ----- Appointment request (booking) queue ------------------------------
  app.get('/booking-requests', async request => {
    const query = z.object({ status: z.enum(['PENDING_REVIEW', 'BOOKED', 'REJECTED', 'MISSING_INFO', 'DUPLICATE']).optional() }).parse(request.query);
    return db.appointmentRequest.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.status ? { status: query.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.patch('/booking-requests/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({ status: z.enum(['PENDING_REVIEW', 'BOOKED', 'REJECTED', 'MISSING_INFO', 'DUPLICATE']).optional(), outcomeReason: z.string().max(1000).optional() }).parse(request.body);
    const existing = await db.appointmentRequest.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Request not found');
    const row = await db.appointmentRequest.update({ where: { id }, data: input });
    await audit(request, { action: 'receptionist.appointmentRequest.updated', resource: 'appointmentRequest', resourceId: id, metadata: { status: input.status } });
    return row;
  });
};
