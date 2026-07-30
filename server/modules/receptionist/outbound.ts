import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { retellConfigStatus, createPhoneCall, stopPhoneCall } from '../../lib/retell';
import { isDestinationOptedOut, toE164 } from '../../lib/campaigns';
import { requireRoles } from '../../plugins/roles';
import {
  hasReceptionistPermission,
  RECEPTIONIST_PERMISSIONS,
  requireReceptionistPermission,
} from '../../lib/receptionist/accessControl';
import { agentReadinessReason } from '../../lib/receptionist/agentReadiness';
import { runWithTenantContext } from '../../lib/tenantContext';
import { Prisma } from '../../generated/prisma/client';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const writeRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.MANAGE);
const callArtifactRead = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.CALL_ARTIFACTS_READ);
const ownerAdminRoles = requireRoles('OWNER', 'ADMIN');
const REQUIRED_FIELD_KEYS = ['firstName', 'lastName', 'phone', 'email', 'preferredBranch', 'preferredService', 'preferredDateTime'] as const;
const RUNNABLE_CAMPAIGN_STATUS = 'RUNNING';
const DIALABLE_TARGET_STATUS = 'PENDING';
export const MAX_TENANT_ACTIVE_CALLS = 3;
export const DEFAULT_VOICE_MINUTES_LIMIT = 500;

function sameOptionalIdentity(provided: string | undefined, stored: string | null): boolean {
  if (provided === undefined) return true;
  return provided.trim().toLocaleLowerCase() === (stored ?? '').trim().toLocaleLowerCase();
}

export function isTargetDialable(status: string, attempts: number, maxRetryAttempts: number): boolean {
  return status === DIALABLE_TARGET_STATUS && attempts <= maxRetryAttempts;
}

export function targetStatusAfterOutcome(
  outcome: string,
  attempts: number,
  maxRetryAttempts: number,
): 'PENDING' | 'COMPLETED' | 'FAILED' | 'OPTED_OUT' | null {
  if (outcome === 'OPTED_OUT') return 'OPTED_OUT';
  if (['BOOKED', 'NOT_INTERESTED', 'ESCALATED'].includes(outcome)) return 'COMPLETED';
  if (['NO_ANSWER', 'VOICEMAIL', 'FAILED'].includes(outcome)) {
    return attempts <= maxRetryAttempts ? 'PENDING' : 'FAILED';
  }
  return null;
}

async function outboundStopped(tenantId: string): Promise<boolean> {
  const usage = await db.tenantAiUsage.findUnique({ where: { tenantId }, select: { killSwitch: true } });
  return usage?.killSwitch === true;
}

async function lockOutboundConfiguration(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-config:${tenantId}`}::text, 0))::text AS locked`;
}

async function auditOutboundMutation(
  tx: Prisma.TransactionClient,
  request: FastifyRequest,
  event: { action: string; resource: string; resourceId: string; metadata?: Prisma.InputJsonObject },
) {
  await tx.auditEvent.create({ data: {
    tenantId: request.auth.tenantId,
    actorUserId: request.auth.userId,
    action: event.action,
    resource: event.resource,
    resourceId: event.resourceId,
    requestId: request.id,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    metadata: event.metadata,
  } });
}

async function validateOutboundAssignments(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; clinicId: string; agentId: string | null | undefined; branchId: string | null | undefined; requireReady: boolean },
) {
  const clinic = await tx.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: input.tenantId, active: true }, select: { id: true } });
  if (!clinic) throw new Error('clinic_inactive_or_foreign');
  if (input.branchId) {
    const branch = await tx.branch.findFirst({ where: { id: input.branchId, tenantId: input.tenantId, active: true }, select: { id: true } });
    if (!branch) throw new Error('branch_inactive_or_foreign');
    const mappedLocation = await tx.receptionistLocation.findFirst({
      where: { tenantId: input.tenantId, clinicId: input.clinicId, branchId: input.branchId, active: true },
      select: { id: true },
    });
    if (!mappedLocation) throw new Error('branch_not_mapped_to_clinic');
  }
  if (!input.agentId) {
    if (input.requireReady) throw new Error('agent_unlinked');
    return;
  }
  const agent = await tx.receptionistAgent.findFirst({ where: { id: input.agentId, tenantId: input.tenantId, clinicId: input.clinicId } });
  if (!agent) throw new Error('agent_scope_mismatch');
  if (!agent.active) throw new Error('agent_inactive');
  if (input.requireReady) {
    const reason = agentReadinessReason(agent);
    if (reason) throw new Error(reason);
  }
}

function outboundAssignmentReason(error: unknown) {
  const reason = error instanceof Error ? error.message : '';
  return [
    'clinic_inactive_or_foreign', 'branch_inactive_or_foreign', 'branch_not_mapped_to_clinic', 'agent_unlinked', 'agent_scope_mismatch',
    'agent_inactive', 'agent_unverified', 'agent_configuration_changed', 'agent_verification_stale',
  ].includes(reason) ? reason : null;
}

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
  // Tenant operators can stop outbound immediately without waiting for a
  // platform operator. This intentionally reuses the existing tenant-wide AI
  // kill switch so there is one authoritative emergency control. The platform
  // control-tower endpoint remains an independent administrative path.
  app.get('/outbound-control', { preHandler: writeRoles }, async request => ({
    stopped: await outboundStopped(request.auth.tenantId),
  }));

  app.post('/outbound-control', { preHandler: ownerAdminRoles }, async request => {
    // Tenant operators may always fail safe. Only the independent platform
    // control-tower can clear the global AI kill switch, preventing a tenant
    // session from overriding a platform-imposed safety stop.
    const body = z.object({ stopped: z.literal(true), reason: z.string().trim().min(5).max(500) }).parse(request.body);
    await db.tenantAiUsage.upsert({
      where: { tenantId: request.auth.tenantId },
      update: { killSwitch: true, killSwitchReason: body.reason },
      create: { tenantId: request.auth.tenantId, killSwitch: true, killSwitchReason: body.reason },
    });

    // The launch gate prevents new calls; independently stop every locally
    // tracked active provider call. A provider failure never reopens outbound,
    // and mock mode is reported as unconfirmed rather than fabricated success.
    const activeCalls = await db.receptionistCallLog.findMany({
      where: {
        tenantId: request.auth.tenantId,
        outcome: 'IN_PROGRESS',
        endedAt: null,
        retellCallId: { not: null },
      },
      select: { id: true, retellCallId: true },
    });
    const cancellationResults = await Promise.all(activeCalls.map(async call => ({
      call,
      result: await stopPhoneCall(call.retellCallId!),
    })));
    const confirmed = cancellationResults.filter(row => row.result.ok && row.result.applied);
    if (confirmed.length > 0) {
      await db.receptionistCallLog.updateMany({
        where: { id: { in: confirmed.map(row => row.call.id) }, tenantId: request.auth.tenantId, endedAt: null },
        data: { outcome: 'FAILED', endedAt: new Date() },
      });
    }
    const failed = cancellationResults.filter(row => !row.result.ok);
    const unconfirmed = cancellationResults.filter(row => row.result.ok && !row.result.applied);
    await audit(request, {
      action: 'receptionist.outbound.stopped',
      resource: 'tenantAiUsage',
      resourceId: request.auth.tenantId,
      metadata: {
        reason: body.reason,
        activeCalls: activeCalls.length,
        cancellationConfirmed: confirmed.length,
        cancellationFailed: failed.length,
        cancellationUnconfirmed: unconfirmed.length,
      },
    });
    return {
      stopped: true,
      activeCancellation: {
        requested: activeCalls.length,
        confirmed: confirmed.length,
        failed: failed.length,
        unconfirmed: unconfirmed.length,
      },
    };
  });

  // ----- Retell setup status (no secrets exposed) -------------------------
  app.get('/retell-status', async request => {
    const status = retellConfigStatus();
    const linkedAgents = await db.receptionistAgent.findMany({
      where: { tenantId: request.auth.tenantId, active: true },
      select: {
        active: true, providerAgentId: true, providerVersion: true, providerStatus: true,
        providerConfigRevision: true, providerVerifiedRevision: true, providerVerifiedAt: true,
        providerVerificationExpiresAt: true,
      },
    });
    const readyAgents = linkedAgents.filter(agent => !agentReadinessReason(agent)).length;
    return {
      configured: status.configured && readyAgents > 0,
      mock: status.mock,
      missing: [...status.missing, ...(readyAgents ? [] : ['AGENT_DEPLOYMENT'])],
      readyAgents,
      checklist: [
        { key: 'RETELL_API_KEY', label: 'Retell API key', set: !status.missing.includes('RETELL_API_KEY') },
        { key: 'RETELL_FROM_NUMBER', label: 'Outbound caller number', set: !status.missing.includes('RETELL_FROM_NUMBER') },
        { key: 'AGENT_DEPLOYMENT', label: 'Published agent deployment', set: readyAgents > 0 },
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

  app.get('/outbound-campaigns/:id', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const row = await db.receptionistOutboundCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { targets: { orderBy: { createdAt: 'asc' } } } });
    if (!row) throw app.httpErrors.notFound('Campaign not found');
    return row;
  });

  app.post('/outbound-campaigns', { preHandler: writeRoles }, async (request, reply) => {
    const input = campaignCreate.parse(request.body);
    try {
      const row = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockOutboundConfiguration(tx, request.auth.tenantId);
        await validateOutboundAssignments(tx, {
          tenantId: request.auth.tenantId, clinicId: input.clinicId, agentId: input.agentId, branchId: input.defaultBranchId,
          requireReady: false,
        });
        const { customQuestions, defaultBranchId, agentId, ...rest } = input;
        const created = await tx.receptionistOutboundCampaign.create({
          data: { tenantId: request.auth.tenantId, ...rest, agentId: agentId ?? undefined, defaultBranchId: defaultBranchId ?? undefined, customQuestions: customQuestions ?? undefined },
        });
        await auditOutboundMutation(tx, request, {
          action: 'receptionist.campaign.created', resource: 'receptionistOutboundCampaign', resourceId: created.id,
          metadata: { name: created.name, bookingMode: created.bookingMode, agentId: created.agentId, status: created.status },
        });
        return created;
      });
      return reply.code(201).send(row);
    } catch (error) {
      const reason = outboundAssignmentReason(error);
      if (reason) throw app.httpErrors.conflict(`Outbound campaign configuration is not deployable: ${reason}.`);
      throw error;
    }
  });

  app.patch('/outbound-campaigns/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = campaignUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockOutboundConfiguration(tx, request.auth.tenantId);
        const existing = await tx.receptionistOutboundCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!existing) throw app.httpErrors.notFound('Campaign not found');
        const nextStatus = input.status ?? existing.status;
        await validateOutboundAssignments(tx, {
          tenantId: request.auth.tenantId,
          clinicId: existing.clinicId,
          agentId: input.agentId === undefined ? existing.agentId : input.agentId,
          branchId: input.defaultBranchId === undefined ? existing.defaultBranchId : input.defaultBranchId,
          requireReady: nextStatus === 'SCHEDULED' || nextStatus === 'RUNNING',
        });
        const { customQuestions, ...rest } = input;
        const row = await tx.receptionistOutboundCampaign.update({ where: { id }, data: { ...rest, ...(customQuestions !== undefined ? { customQuestions: customQuestions ?? undefined } : {}) } });
        await auditOutboundMutation(tx, request, {
          action: 'receptionist.campaign.updated', resource: 'receptionistOutboundCampaign', resourceId: id,
          metadata: { status: row.status, agentId: row.agentId },
        });
        return row;
      });
    } catch (error) {
      const reason = outboundAssignmentReason(error);
      if (reason) throw app.httpErrors.conflict(`Outbound campaign configuration is not deployable: ${reason}.`);
      throw error;
    }
  });

  // ----- Targets ----------------------------------------------------------
  app.get('/outbound-campaigns/:id/targets', { preHandler: callArtifactRead }, async request => {
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
      include: { clinic: { select: { name: true, complianceDisclosure: true, timezone: true } }, agent: true },
    });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');

    if (campaign.status !== RUNNABLE_CAMPAIGN_STATUS) {
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'campaign_not_running', status: campaign.status } });
      return reply.code(409).send({ status: 'blocked', reason: 'campaign_not_running' });
    }

    const initialAgentReadiness = campaign.agent ? agentReadinessReason(campaign.agent) : 'agent_unlinked';
    if (initialAgentReadiness) {
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: initialAgentReadiness } });
      return reply.code(409).send({ status: 'blocked', reason: initialAgentReadiness });
    }

    if (await outboundStopped(request.auth.tenantId)) {
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'outbound_stopped' } });
      return reply.code(423).send({ status: 'blocked', reason: 'outbound_stopped' });
    }

    // A target id is an ownership and identity assertion, not merely metadata.
    // Bind the provider payload to the stored target and reject a body that
    // tries to substitute another person or destination.
    const target = body.targetId
      ? await db.receptionistCallTarget.findFirst({ where: { id: body.targetId, tenantId: request.auth.tenantId, campaignId: campaign.id } })
      : null;
    if (body.targetId && !target) throw app.httpErrors.notFound('Target not found for this campaign');
    if (target) {
      const identityMatches = toE164(body.phone) === toE164(target.phone)
        && sameOptionalIdentity(body.firstName, target.firstName)
        && sameOptionalIdentity(body.lastName, target.lastName)
        && sameOptionalIdentity(body.email, target.email);
      if (!identityMatches) {
        await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistCallTarget', resourceId: target.id, metadata: { campaignId: campaign.id, reason: 'target_identity_mismatch' } });
        return reply.code(409).send({ status: 'blocked', reason: 'target_identity_mismatch' });
      }
      if (!isTargetDialable(target.status, target.attempts, campaign.maxRetryAttempts)) {
        await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistCallTarget', resourceId: target.id, metadata: { campaignId: campaign.id, reason: 'target_not_dialable', targetStatus: target.status } });
        return reply.code(409).send({ status: 'blocked', reason: 'target_not_dialable' });
      }
    }

    const dialIdentity = target ?? body;

    // ---- Compliance gate: NEVER dial an opted-out number ------------------
    // Consult ReceptionistOptOut (voice channel; ALL/VOICE suppress it), tenant-
    // scoped. This closes gap (c): outbound targets are queued without a filter,
    // so suppression MUST be enforced here at the dial. Record + skip, no dial.
    if (await isDestinationOptedOut(request.auth.tenantId, dialIdentity.phone, 'voice')) {
      const callLog = await db.receptionistCallLog.create({
        data: {
          tenantId: request.auth.tenantId, clinicId: campaign.clinicId, outboundCampaignId: campaign.id, targetId: body.targetId,
          callerName: [dialIdentity.firstName, dialIdentity.lastName].filter(Boolean).join(' ') || null, callerPhone: dialIdentity.phone,
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

    // Atomically enforce tenant concurrency and the voice-minute budget, then
    // claim a stored target and create its attempt log. The tenant advisory lock
    // makes concurrent launch requests observe one another before any provider
    // request can escape.
    const callLogData = {
      tenantId: request.auth.tenantId,
      clinicId: campaign.clinicId,
      outboundCampaignId: campaign.id,
      targetId: body.targetId,
      callerName: [dialIdentity.firstName, dialIdentity.lastName].filter(Boolean).join(' ') || null,
      callerPhone: dialIdentity.phone,
      direction: 'outbound',
      outcome: 'IN_PROGRESS' as const,
      startedAt: new Date(),
    };
    const reservation = await db.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-capacity:${request.auth.tenantId}`})::bigint)`;
          const aiUsage = await tx.tenantAiUsage.upsert({
            where: { tenantId: request.auth.tenantId },
            update: {},
            create: { tenantId: request.auth.tenantId },
            select: { receptionistMinutes: true, overageAllowed: true },
          });
          const voiceUsage = await tx.tenantUsageLimit.upsert({
            where: { tenantId_key: { tenantId: request.auth.tenantId, key: 'voice_minutes' } },
            update: {},
            create: {
              tenantId: request.auth.tenantId,
              key: 'voice_minutes',
              limitValue: DEFAULT_VOICE_MINUTES_LIMIT,
              used: aiUsage.receptionistMinutes,
            },
            select: { used: true, limitValue: true },
          });
          const activeCalls = await tx.receptionistCallLog.count({
            where: { tenantId: request.auth.tenantId, outcome: 'IN_PROGRESS', endedAt: null },
          });
          if (activeCalls >= MAX_TENANT_ACTIVE_CALLS) return { blocked: 'concurrency_limit_reached' as const };
          const usedMinutes = Math.max(voiceUsage.used, aiUsage.receptionistMinutes);
          // Each in-progress call reserves at least one billable minute. This
          // prevents parallel launches from consuming the final minute twice.
          if (!aiUsage.overageAllowed && voiceUsage.limitValue !== null && usedMinutes + activeCalls >= voiceUsage.limitValue) {
            return { blocked: 'voice_minutes_limit_reached' as const };
          }
          if (target) {
          const claim = await tx.receptionistCallTarget.updateMany({
            where: {
              id: target.id,
              tenantId: request.auth.tenantId,
              campaignId: campaign.id,
              status: DIALABLE_TARGET_STATUS,
              attempts: { lte: campaign.maxRetryAttempts },
            },
            data: { status: 'CALLING', attempts: { increment: 1 } },
          });
            if (claim.count !== 1) return { blocked: 'target_not_dialable' as const };
          }
          return { callLog: await tx.receptionistCallLog.create({ data: callLogData }) };
        });

    if ('blocked' in reservation) {
      const statusCode = reservation.blocked === 'concurrency_limit_reached' ? 429
        : reservation.blocked === 'voice_minutes_limit_reached' ? 402
          : 409;
      await audit(request, {
        action: 'receptionist.call.blocked',
        resource: target ? 'receptionistCallTarget' : 'receptionistOutboundCampaign',
        resourceId: target?.id ?? campaign.id,
        metadata: { campaignId: campaign.id, reason: reservation.blocked },
      });
      return reply.code(statusCode).send({ status: 'blocked', reason: reservation.blocked });
    }
    const { callLog } = reservation;

    // Re-check immediately before the irreversible provider boundary. This
    // closes the window where an operator stops outbound or pauses a campaign
    // while preflight work is in progress.
    const [stoppedAtBoundary, currentCampaign] = await Promise.all([
      outboundStopped(request.auth.tenantId),
      db.receptionistOutboundCampaign.findFirst({
        where: { id: campaign.id, tenantId: request.auth.tenantId },
        select: { status: true, agent: true },
      }),
    ]);
    const boundaryAgentReadiness = currentCampaign?.agent ? agentReadinessReason(currentCampaign.agent) : 'agent_unlinked';
    if (stoppedAtBoundary || currentCampaign?.status !== RUNNABLE_CAMPAIGN_STATUS || boundaryAgentReadiness) {
      await db.$transaction(async tx => {
        await tx.receptionistCallLog.update({ where: { id: callLog.id }, data: { outcome: 'FAILED', endedAt: new Date() } });
        if (target) {
          await tx.receptionistCallTarget.updateMany({
            where: { id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id, status: 'CALLING' },
            data: { status: 'PENDING', attempts: { decrement: 1 }, lastOutcome: 'BLOCKED', lastCallLogId: callLog.id },
          });
        }
      });
      const reason = stoppedAtBoundary ? 'outbound_stopped'
        : currentCampaign?.status !== RUNNABLE_CAMPAIGN_STATUS ? 'campaign_not_running'
          : boundaryAgentReadiness!;
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, reason: `${reason}_pre_provider` } });
      if (stoppedAtBoundary) return reply.code(423).send({ status: 'blocked', reason, callLogId: callLog.id });
      return reply.code(409).send({ status: 'blocked', reason, callLogId: callLog.id });
    }

    const result = await createPhoneCall({
      toNumber: dialIdentity.phone,
      agentId: currentCampaign!.agent!.providerAgentId!,
      agentVersion: currentCampaign!.agent!.providerVersion!,
      webhookUrl: `${env.PUBLIC_API_URL}/v1/receptionist/webhooks/retell?clinicId=${campaign.clinicId}`,
      dynamicVariables: {
        clinic_name: campaign.clinic.name,
        agent_name: campaign.agent?.name ?? 'Riley',
        disclosure: campaign.clinic.complianceDisclosure,
        consent_text: campaign.consentText ?? '',
        human_handoff: campaign.humanHandoffInstruction ?? '',
        script: campaign.script,
        required_fields: campaign.requiredFields.join(', '),
        first_name: dialIdentity.firstName ?? '',
        booking_mode: campaign.bookingMode,
      },
      metadata: { tenantId: request.auth.tenantId, outboundCampaignId: campaign.id, callLogId: callLog.id, targetId: body.targetId ?? null },
      // No verified prior recording consent is attached to this launch. Retell
      // must retain metadata only; an in-call grant cannot upgrade this setting.
      dataStorageSetting: 'basic_attributes_only',
    });

    if (!result.ok) {
      await runWithTenantContext(request.auth.tenantId, async tx => {
        await tx.receptionistCallLog.update({
          where: { id: callLog.id },
          data: { outcome: 'FAILED', endedAt: new Date(), ...(result.callId ? { retellCallId: result.callId } : {}) },
        });
        if (body.targetId) {
          await tx.receptionistCallTarget.updateMany({
            where: { id: body.targetId, tenantId: request.auth.tenantId, campaignId: campaign.id, status: 'CALLING' },
            data: { status: targetStatusAfterOutcome('FAILED', (target?.attempts ?? 0) + 1, campaign.maxRetryAttempts) ?? 'FAILED', lastOutcome: 'FAILED', lastCallLogId: callLog.id },
          });
        }
        await auditOutboundMutation(tx, request, {
          action: result.error === 'retell_deployment_mismatch'
            ? 'receptionist.call.providerDeploymentMismatch'
            : 'receptionist.call.failed',
          resource: 'receptionistCallLog',
          resourceId: callLog.id,
          metadata: {
            error: result.error,
            operationalReviewRequired: result.error === 'retell_deployment_mismatch',
            providerStopApplied: result.providerStopApplied ?? null,
            providerStopError: result.providerStopError ?? null,
          },
        });
      });
      return reply.code(502).send({ status: 'failed', error: result.error, callLogId: callLog.id });
    }

    await db.receptionistCallLog.update({ where: { id: callLog.id }, data: { retellCallId: result.callId } });
    if (body.targetId) await db.receptionistCallTarget.updateMany({ where: { id: body.targetId, tenantId: request.auth.tenantId, campaignId: campaign.id, status: 'CALLING' }, data: { lastCallLogId: callLog.id } });
    await audit(request, { action: 'receptionist.call.launched', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, mock: result.mock } });
    return reply.code(201).send({ status: 'launched', callId: result.callId, callLogId: callLog.id, mock: result.mock });
  });

  app.get('/outbound-campaigns/:id/call-logs', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const rows = await db.receptionistCallLog.findMany({ where: { tenantId: request.auth.tenantId, outboundCampaignId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
    const canReadRecordings = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.RECORDINGS_READ);
    await audit(request, {
      action: 'receptionistCallLog.outboundListRead',
      resource: 'receptionistOutboundCampaign',
      resourceId: id,
      metadata: { count: rows.length, recordingsDisclosed: canReadRecordings },
    });
    return rows.map(row => ({
      ...row,
      recordingAvailable: Boolean(row.recordingUrl),
      recordingUrl: canReadRecordings ? row.recordingUrl : null,
    }));
  });

  // ----- Appointment request (booking) queue ------------------------------
  app.get('/booking-requests', { preHandler: callArtifactRead }, async request => {
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
