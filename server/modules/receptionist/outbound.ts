import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { getPhoneCall, stopPhoneCall } from '../../lib/retell';
import { isValidE164, toE164 } from '../../lib/campaigns';
import { requireRoles } from '../../plugins/roles';
import {
  hasReceptionistPermission,
  RECEPTIONIST_PERMISSIONS,
  requireReceptionistPermission,
} from '../../lib/receptionist/accessControl';
import { runWithTenantContext } from '../../lib/tenantContext';
import { Prisma } from '../../generated/prisma/client';
import { fingerprintJson } from './intakeContract';
import {
  compatibleVoiceConsentEventTx,
  isChannelSuppressedTx,
} from '../../lib/receptionist/dncFence';
import {
  liveCallUatDestination,
  liveCallUatStatus,
  maskPhone,
  maskProviderId,
} from '../../lib/receptionist/liveCallUat';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const writeRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.MANAGE);
const bookingReviewRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.BOOKING_REVIEW);
const callArtifactRead = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.CALL_ARTIFACTS_READ);
const ownerAdminRoles = requireRoles('OWNER', 'ADMIN');
const REQUIRED_FIELD_KEYS = ['firstName', 'lastName', 'phone', 'email', 'preferredBranch', 'preferredService', 'preferredDateTime'] as const;
const LIVE_UAT_TARGET_SOURCE_PREFIX = 'live_voice_uat:';
import { recordUsageEvent, voiceCallDedupeKey, USAGE_METRICS } from '../../lib/usageMetering';
// The campaign dialling policy lives outside this route module so the
// reconciliation worker can share it without importing the HTTP graph.
// Re-exported because callers already import these names from here.
import {
  DEFAULT_VOICE_MINUTES_LIMIT, isTargetDialable, targetStatusAfterOutcome,
} from '../../lib/receptionist/outboundPolicy';
export { DEFAULT_VOICE_MINUTES_LIMIT, isTargetDialable, targetStatusAfterOutcome };


// ---------------------------------------------------------------------------
// The launch path and everything it shares with the rest of this module now
// live in a worker-reachable service. They are imported, never re-implemented:
// the dialler calls the same functions, so a gate cannot exist on one path and
// not the other.
// ---------------------------------------------------------------------------
import {
  applyConfirmedProviderStopTx,
  auditOutboundMutation,
  CLIENT_LAUNCH_ATTEMPT_SCOPE,
  isWithinQuietHours,
  launchOutboundCall,
  lockOutboundConfiguration,
  lockOutboundDispatch,
  OUTBOUND_LEGAL_BASES,
  OUTBOUND_PURPOSES,
  outboundAssignmentReason,
  outboundAuthorityFingerprint,
  quietHoursConfigurationReason,
  setProviderBoundaryTestHookForTests,
  STRICT_HH_MM,
  validateOutboundAssignments,
  type LaunchActor,
} from '../../lib/receptionist/outboundLaunch';
export { isWithinQuietHours, quietHoursConfigurationReason, setProviderBoundaryTestHookForTests };

/** The HTTP half of the actor seam. A person clicked Call. */
function requestLaunchActor(request: FastifyRequest): LaunchActor {
  return {
    kind: 'user',
    userId: request.auth.userId,
    requestId: request.id,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
  };
}

/** Tenant + actor for the shared audit writer, from a request. */
function requestAuditContext(request: FastifyRequest): { tenantId: string; actor: LaunchActor } {
  return { tenantId: request.auth.tenantId, actor: requestLaunchActor(request) };
}


// Registered INSIDE receptionistRoutes, so it inherits the ai_receptionist
// feature gate and the authenticated scope.
export const outboundRoutes: FastifyPluginAsync = async app => {
  // Tenant operators can stop outbound immediately without waiting for a
  // platform operator. This intentionally reuses the existing tenant-wide AI
  // kill switch so there is one authoritative emergency control. The platform
  // control-tower endpoint remains an independent administrative path.
  app.get('/outbound-control', { preHandler: writeRoles }, async request => {
    const usage = await db.tenantAiUsage.findUnique({
      where: { tenantId: request.auth.tenantId },
      select: { killSwitch: true, killSwitchReason: true, updatedAt: true },
    });
    return {
      stopped: usage?.killSwitch === true,
      reason: usage?.killSwitch ? usage.killSwitchReason : null,
      changedAt: usage?.killSwitch ? usage.updatedAt : null,
    };
  });

  app.post('/outbound-control', { preHandler: ownerAdminRoles }, async request => {
    // Tenant operators may always fail safe. Only the independent platform
    // control-tower can clear the global AI kill switch, preventing a tenant
    // session from overriding a platform-imposed safety stop.
    const body = z.object({ stopped: z.literal(true), reason: z.string().trim().min(5).max(500) }).parse(request.body);
    // The launch gate prevents new calls; independently stop every locally
    // tracked active provider call. A provider failure never reopens outbound,
    // and mock mode is reported as unconfirmed rather than fabricated success.
    const stopSnapshot = await db.$transaction(async tx => {
      await lockOutboundDispatch(tx, request.auth.tenantId);
      await tx.tenantAiUsage.upsert({
        where: { tenantId: request.auth.tenantId },
        update: { killSwitch: true, killSwitchReason: body.reason },
        create: { tenantId: request.auth.tenantId, killSwitch: true, killSwitchReason: body.reason },
      });
      const activeCalls = await tx.receptionistCallLog.findMany({
        where: { tenantId: request.auth.tenantId, outcome: 'IN_PROGRESS', endedAt: null },
        select: { id: true, retellCallId: true, targetId: true, outboundCampaignId: true },
      });
      const pendingProviderIntents = activeCalls.filter(call => !call.retellCallId);
      let unboundIntentsQuarantined = 0;
      if (pendingProviderIntents.length > 0) {
        const endedAt = new Date();
        const changed = await tx.receptionistCallLog.updateMany({
          where: { id: { in: pendingProviderIntents.map(call => call.id) }, tenantId: request.auth.tenantId, outcome: 'IN_PROGRESS', endedAt: null, retellCallId: null },
          data: { outcome: 'ESCALATED', endedAt },
        });
        for (const call of pendingProviderIntents) {
          if (!call.targetId || !call.outboundCampaignId) continue;
          await tx.receptionistCallTarget.updateMany({
            where: { id: call.targetId, tenantId: request.auth.tenantId, campaignId: call.outboundCampaignId, status: 'CALLING' },
            data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: call.id },
          });
        }
        unboundIntentsQuarantined = changed.count;
      }
      const providerActiveCalls = activeCalls.filter((call): call is typeof call & { retellCallId: string } => Boolean(call.retellCallId));
      return { activeCalls: activeCalls.length, providerActiveCalls, unboundIntentsQuarantined };
    });
    const { providerActiveCalls, unboundIntentsQuarantined } = stopSnapshot;
    const cancellationResults = await Promise.all(providerActiveCalls.map(async call => ({
      call,
      result: await stopPhoneCall(call.retellCallId),
    })));
    const confirmed = cancellationResults.filter(row => row.result.ok && row.result.applied);
    if (confirmed.length > 0) {
      await db.$transaction(async tx => {
        await lockOutboundDispatch(tx, request.auth.tenantId);
        for (const row of confirmed) {
          if (!row.call.targetId || !row.call.outboundCampaignId) continue;
          await applyConfirmedProviderStopTx(tx, {
            tenantId: request.auth.tenantId,
            campaignId: row.call.outboundCampaignId,
            targetId: row.call.targetId,
            callLogId: row.call.id,
            providerCallId: row.call.retellCallId,
          }, requestLaunchActor(request));
        }
      });
    }
    const failed = cancellationResults.filter(row => !row.result.ok);
    const unconfirmed = cancellationResults.filter(row => row.result.ok && !row.result.applied);
    const reconciliationCandidates = [...failed, ...unconfirmed];
    const reconciliationIds = new Set<string>();
    if (reconciliationCandidates.length > 0) {
      // Provider stop uncertainty is itself terminal safety evidence. Commit it
      // before review/audit plumbing so a worker or request crash cannot leave
      // a bound call looking healthy and retryable.
      await db.$transaction(async tx => {
        await lockOutboundDispatch(tx, request.auth.tenantId);
        for (const row of reconciliationCandidates) {
          await tx.receptionistCallLog.updateMany({
            where: {
              id: row.call.id, tenantId: request.auth.tenantId,
              outboundCampaignId: row.call.outboundCampaignId,
              targetId: row.call.targetId,
              retellCallId: row.call.retellCallId,
              outcome: 'IN_PROGRESS', endedAt: null,
            },
            data: { outcome: 'ESCALATED', endedAt: new Date() },
          });
          const latest = await tx.receptionistCallLog.findFirst({
              where: {
                id: row.call.id, tenantId: request.auth.tenantId,
                outboundCampaignId: row.call.outboundCampaignId,
                targetId: row.call.targetId,
                retellCallId: row.call.retellCallId,
              },
              select: {
                outcome: true,
                target: { select: { id: true, campaignId: true, lastCallLogId: true, lastOutcome: true } },
              },
            });
          // Another concurrent stop may already have confirmed cancellation
          // and committed FAILED/OUTBOUND_STOPPED. Never downgrade that stronger
          // terminal evidence because this provider request returned 503.
          if (latest?.outcome !== 'ESCALATED'
            || latest.target?.campaignId !== row.call.outboundCampaignId
            || latest.target.lastCallLogId !== row.call.id
            || latest.target.lastOutcome === 'OUTBOUND_STOPPED') continue;
          reconciliationIds.add(row.call.id);
          if (!row.call.targetId || !row.call.outboundCampaignId) continue;
          await tx.receptionistCallTarget.updateMany({
            where: {
              id: row.call.targetId, tenantId: request.auth.tenantId,
              campaignId: row.call.outboundCampaignId, lastCallLogId: row.call.id,
              OR: [
                { status: 'CALLING' },
                { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED' },
              ],
            },
            data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: row.call.id },
          });
        }
      });
    }
    const reconciliationRequired = reconciliationCandidates.filter(row => reconciliationIds.has(row.call.id));
    let signalRecorded = 0;
    let reviewRecorded = 0;
    for (const row of reconciliationRequired) {
      try {
        const recorded = await runWithTenantContext(request.auth.tenantId, async tx => {
          await lockOutboundDispatch(tx, request.auth.tenantId);
          const stillUncertain = row.call.targetId && row.call.outboundCampaignId
            ? await tx.receptionistCallTarget.findFirst({
              where: {
                id: row.call.targetId, tenantId: request.auth.tenantId,
                campaignId: row.call.outboundCampaignId, lastCallLogId: row.call.id,
                status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
              },
              select: { id: true },
            })
            : null;
          if (!stillUncertain) return { signal: false, task: false };
          await tx.operationalSignal.upsert({
            where: { tenantId_signalType_entityType_entityId: {
              tenantId: request.auth.tenantId,
              signalType: 'receptionist_outbound_stop_unconfirmed_after_acceptance',
              entityType: 'receptionistCallLog', entityId: row.call.id,
            } },
            update: { severity: 'critical', score: 100, status: 'open', reason: 'Provider cancellation could not be confirmed after the outbound kill switch was activated.' },
            create: {
              tenantId: request.auth.tenantId,
              signalType: 'receptionist_outbound_stop_unconfirmed_after_acceptance',
              entityType: 'receptionistCallLog', entityId: row.call.id,
              severity: 'critical', score: 100,
              reason: 'Provider cancellation could not be confirmed after the outbound kill switch was activated.',
            },
          });
          const existingTask = await tx.staffTask.findFirst({
            where: {
              tenantId: request.auth.tenantId,
              metadata: { path: ['callLogId'], equals: row.call.id },
            },
            select: { id: true },
          });
          if (!existingTask) await tx.staffTask.create({ data: {
            tenantId: request.auth.tenantId,
            title: 'Urgent: reconcile outbound call after unconfirmed stop', priority: 'CRITICAL',
            metadata: {
              workflow: 'receptionist_outbound_stop_reconciliation', callLogId: row.call.id,
              providerCallId: row.call.retellCallId, providerStopApplied: false,
              providerStopError: row.result.ok ? 'provider_stop_unconfirmed' : row.result.error,
            },
          } });
          return { signal: true, task: !existingTask };
        });
        if (recorded.signal) signalRecorded += 1;
        if (recorded.task) reviewRecorded += 1;
      } catch {
        // Primary ESCALATED/non-dialable state is already committed.
      }
    }
    const auditRecorded = await (async () => {
      try {
        await audit(request, {
        action: 'receptionist.outbound.stopped',
        resource: 'tenantAiUsage',
        resourceId: request.auth.tenantId,
        metadata: {
          reason: body.reason,
          activeCalls: stopSnapshot.activeCalls,
          unboundIntentsQuarantined,
          cancellationConfirmed: confirmed.length,
          cancellationFailed: failed.length,
          cancellationUnconfirmed: unconfirmed.length,
          reconciliationRequired: reconciliationRequired.length,
          signalRecorded,
          reviewRecorded,
        },
        });
        return true;
      } catch {
        return false;
      }
    })();
    return {
      stopped: true,
      activeCancellation: {
        requested: providerActiveCalls.length,
        confirmed: confirmed.length,
        failed: failed.length,
        unconfirmed: unconfirmed.length,
        unboundIntentsQuarantined,
        reconciliationRequired: reconciliationRequired.length,
        signalRecorded,
        reviewRecorded,
        auditRecorded,
      },
    };
  });

  // ----- Retell setup status (no secrets exposed) -------------------------
  // GET /retell-status moved to modules/receptionist/deployment.ts in C5: the
  // tenant-wide checklist could not answer "can THIS campaign take a call?",
  // and it belongs with deployment rather than with outbound dialling.

  // ----- Outbound campaigns ----------------------------------------------
  // The Studio form binds every optional field to a text input, so "unset"
  // arrives as '' as often as null. Treat '' as null for optional ids and
  // strings instead of answering 400 "Invalid UUID" for a field the user
  // never touched.
  const emptyToNull = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(value => (value === '' ? null : value), schema);
  const optionalUuid = emptyToNull(uuid.optional().nullable());
  const optionalText = (max: number, min = 0) => emptyToNull((min > 0 ? z.string().trim().min(min) : z.string()).max(max).optional().nullable());
  const optionalQuietHour = emptyToNull(z.string().trim().regex(STRICT_HH_MM).optional().nullable());
  const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) => emptyToNull(z.enum(values).optional().nullable());
  const REQUIRED_FIELDS_DEFAULT: Array<(typeof REQUIRED_FIELD_KEYS)[number]> = ['firstName', 'lastName', 'phone'];
  const bookingModeEnum = z.enum(['APPOINTMENT_REQUEST_ONLY', 'DIRECT_BOOKING_IF_SLOT_AVAILABLE']);
  const maxRetryAttemptsInput = z.number().int().min(0).max(10);
  // No `.default()` anywhere on the base: Zod 4's `.partial()` keeps defaults,
  // so a one-field PATCH built from a defaulted schema would silently re-apply
  // `requiredFields`/`bookingMode`/`maxRetryAttempts` and trip the authority
  // immutability check on a RUNNING campaign (A6-F01).
  const campaignBase = z.object({
    clinicId: uuid,
    agentId: optionalUuid,
    receptionistCampaignId: optionalUuid,
    name: z.string().trim().min(2).max(160),
    script: z.string().trim().min(2).max(4000),
    purpose: optionalEnum(OUTBOUND_PURPOSES),
    legalBasis: optionalEnum(OUTBOUND_LEGAL_BASES),
    policyVersion: optionalText(80, 3),
    requiredFields: z.array(z.enum(REQUIRED_FIELD_KEYS)),
    customQuestions: z.any().optional(),
    consentText: optionalText(2000),
    humanHandoffInstruction: optionalText(1000),
    bookingMode: bookingModeEnum,
    defaultBranchId: optionalUuid,
    defaultService: optionalText(160),
    quietHoursStart: optionalQuietHour,
    quietHoursEnd: optionalQuietHour,
    maxRetryAttempts: maxRetryAttemptsInput,
  });
  const campaignCreate = campaignBase.extend({
    requiredFields: z.array(z.enum(REQUIRED_FIELD_KEYS)).default(REQUIRED_FIELDS_DEFAULT),
    bookingMode: bookingModeEnum.default('APPOINTMENT_REQUEST_ONLY'),
    maxRetryAttempts: maxRetryAttemptsInput.default(1),
  });
  const campaignUpdate = campaignBase.omit({ clinicId: true }).partial().extend({
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
          bookingMode: input.bookingMode, receptionistCampaignId: input.receptionistCampaignId,
          defaultService: input.defaultService, purpose: input.purpose, legalBasis: input.legalBasis, policyVersion: input.policyVersion,
          quietHoursStart: input.quietHoursStart, quietHoursEnd: input.quietHoursEnd,
          requireReady: false,
        });
        const { customQuestions, defaultBranchId, agentId, receptionistCampaignId, ...rest } = input;
        const created = await tx.receptionistOutboundCampaign.create({
          data: {
            tenantId: request.auth.tenantId, ...rest, agentId: agentId ?? undefined,
            receptionistCampaignId: receptionistCampaignId ?? undefined,
            defaultBranchId: defaultBranchId ?? undefined, customQuestions: customQuestions ?? undefined,
          },
        });
        await auditOutboundMutation(tx, requestAuditContext(request), {
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
        if (input.status === 'SCHEDULED' || input.status === 'RUNNING') {
          throw new Error('outbound_authority_approval_required');
        }
        const nextBookingMode = input.bookingMode ?? existing.bookingMode;
        const authorityChanged = [
          input.agentId !== undefined && input.agentId !== existing.agentId,
          input.receptionistCampaignId !== undefined && input.receptionistCampaignId !== existing.receptionistCampaignId,
          input.bookingMode !== undefined && input.bookingMode !== existing.bookingMode,
          input.defaultBranchId !== undefined && input.defaultBranchId !== existing.defaultBranchId,
          input.defaultService !== undefined && input.defaultService !== existing.defaultService,
          input.script !== undefined && input.script !== existing.script,
          input.purpose !== undefined && input.purpose !== existing.purpose,
          input.legalBasis !== undefined && input.legalBasis !== existing.legalBasis,
          input.policyVersion !== undefined && input.policyVersion !== existing.policyVersion,
          input.consentText !== undefined && input.consentText !== existing.consentText,
          input.humanHandoffInstruction !== undefined && input.humanHandoffInstruction !== existing.humanHandoffInstruction,
          input.quietHoursStart !== undefined && input.quietHoursStart !== existing.quietHoursStart,
          input.quietHoursEnd !== undefined && input.quietHoursEnd !== existing.quietHoursEnd,
          input.maxRetryAttempts !== undefined && input.maxRetryAttempts !== existing.maxRetryAttempts,
          input.requiredFields !== undefined && fingerprintJson(input.requiredFields) !== fingerprintJson(existing.requiredFields),
          input.customQuestions !== undefined && fingerprintJson(input.customQuestions) !== fingerprintJson(existing.customQuestions),
        ].some(Boolean);
        const hasCalls = authorityChanged
          ? await tx.receptionistCallLog.count({ where: { tenantId: request.auth.tenantId, outboundCampaignId: existing.id } }) > 0
          : false;
        if ((existing.status === 'SCHEDULED' || existing.status === 'RUNNING' || hasCalls) && authorityChanged) {
          throw new Error('outbound_authority_immutable');
        }
        await validateOutboundAssignments(tx, {
          tenantId: request.auth.tenantId,
          clinicId: existing.clinicId,
          agentId: input.agentId === undefined ? existing.agentId : input.agentId,
          branchId: input.defaultBranchId === undefined ? existing.defaultBranchId : input.defaultBranchId,
          bookingMode: nextBookingMode,
          receptionistCampaignId: input.receptionistCampaignId === undefined ? existing.receptionistCampaignId : input.receptionistCampaignId,
          defaultService: input.defaultService === undefined ? existing.defaultService : input.defaultService,
          purpose: input.purpose === undefined ? existing.purpose : input.purpose,
          legalBasis: input.legalBasis === undefined ? existing.legalBasis : input.legalBasis,
          policyVersion: input.policyVersion === undefined ? existing.policyVersion : input.policyVersion,
          quietHoursStart: input.quietHoursStart === undefined ? existing.quietHoursStart : input.quietHoursStart,
          quietHoursEnd: input.quietHoursEnd === undefined ? existing.quietHoursEnd : input.quietHoursEnd,
          requireReady: nextStatus === 'SCHEDULED' || nextStatus === 'RUNNING',
        });
        const { customQuestions, ...rest } = input;
        const row = await tx.receptionistOutboundCampaign.update({ where: { id }, data: {
          ...rest,
          ...(customQuestions !== undefined ? { customQuestions: customQuestions ?? undefined } : {}),
          ...(authorityChanged ? {
            authorityApprovedAt: null, authorityApprovedById: null, authorityFingerprint: null,
          } : {}),
        } });
        await auditOutboundMutation(tx, requestAuditContext(request), {
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

  app.post('/outbound-campaigns/:id/approve', { preHandler: [ownerAdminRoles, writeRoles] }, async request => {
    const { id } = idParam.parse(request.params);
    const body = z.object({
      approvalConfirmed: z.literal(true),
      status: z.enum(['SCHEDULED', 'RUNNING']),
    }).strict().parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockOutboundConfiguration(tx, request.auth.tenantId);
        const campaign = await tx.receptionistOutboundCampaign.findFirst({
          where: { id, tenantId: request.auth.tenantId },
          include: { receptionistCampaign: true, agent: true },
        });
        if (!campaign) throw app.httpErrors.notFound('Campaign not found');
        await validateOutboundAssignments(tx, {
          tenantId: request.auth.tenantId,
          clinicId: campaign.clinicId,
          agentId: campaign.agentId,
          branchId: campaign.defaultBranchId,
          bookingMode: campaign.bookingMode,
          receptionistCampaignId: campaign.receptionistCampaignId,
          defaultService: campaign.defaultService,
          purpose: campaign.purpose,
          legalBasis: campaign.legalBasis,
          policyVersion: campaign.policyVersion,
          quietHoursStart: campaign.quietHoursStart,
          quietHoursEnd: campaign.quietHoursEnd,
          requireReady: true,
        });
        const authorityFingerprint = outboundAuthorityFingerprint(campaign);
        const approved = await tx.receptionistOutboundCampaign.update({ where: { id }, data: {
          status: body.status,
          authorityApprovedAt: new Date(),
          authorityApprovedById: request.auth.userId,
          authorityFingerprint,
        } });
        await auditOutboundMutation(tx, requestAuditContext(request), {
          action: 'receptionist.outbound.authorityApproved',
          resource: 'receptionistOutboundCampaign',
          resourceId: id,
          metadata: {
            status: approved.status,
            policyVersion: approved.policyVersion,
            authorityFingerprint,
          },
        });
        return approved;
      });
    } catch (error) {
      const reason = outboundAssignmentReason(error);
      if (reason) throw app.httpErrors.conflict(`Outbound campaign authority cannot be approved: ${reason}.`);
      throw error;
    }
  });

  // ----- Targets ----------------------------------------------------------
  app.get('/outbound-target-candidates', { preHandler: callArtifactRead }, async request => {
    const { q, campaignId } = z.object({ campaignId: uuid, q: z.string().trim().max(120).optional() }).parse(request.query);
    const query = q?.trim();
    const campaign = await db.receptionistOutboundCampaign.findFirst({
      where: { id: campaignId, tenantId: request.auth.tenantId },
      select: { purpose: true, policyVersion: true, legalBasis: true },
    });
    if (!campaign) throw app.httpErrors.notFound('Outbound campaign not found');
    if (!campaign.purpose || !campaign.policyVersion || !campaign.legalBasis) {
      throw app.httpErrors.conflict('Outbound campaign purpose, policy version, and legal basis are required before selecting targets.');
    }
    const [patients, leads] = await runWithTenantContext(request.auth.tenantId, tx => Promise.all([
      tx.patient.findMany({
        where: {
          tenantId: request.auth.tenantId, deletedAt: null, phone: { not: null },
          ...(query ? { OR: [
            { firstName: { contains: query, mode: 'insensitive' } },
            { lastName: { contains: query, mode: 'insensitive' } },
            { phone: { contains: query } },
          ] } : {}),
        },
        select: { id: true, firstName: true, lastName: true, phone: true }, take: 50,
      }),
      tx.lead.findMany({
        where: {
          tenantId: request.auth.tenantId, phone: { not: null },
          ...(query ? { OR: [{ name: { contains: query, mode: 'insensitive' } }, { phone: { contains: query } }] } : {}),
        },
        select: { id: true, name: true, phone: true }, take: 50,
      }),
    ]));
    const identities = [
      ...patients.map(patient => ({ type: 'patient' as const, id: patient.id, name: `${patient.firstName} ${patient.lastName}`, phone: toE164(patient.phone ?? '') })),
      ...leads.map(lead => ({ type: 'lead' as const, id: lead.id, name: lead.name, phone: toE164(lead.phone ?? '') })),
    ].filter(identity => isValidE164(identity.phone));
    const requiresImmutableConsent = campaign.legalBasis === 'EXPLICIT_CONSENT' || campaign.purpose === 'PATIENT_REACTIVATION';
    return runWithTenantContext(request.auth.tenantId, async tx => {
      const candidates: Array<(typeof identities)[number] & {
        voiceAuthorizationReady: boolean;
        voiceAuthorizationReason: 'suppressed' | 'compatible_immutable_consent' | 'consent_missing_or_incompatible' | 'treatment_operations';
      }> = [];
      for (const identity of identities) {
        const targetIdentity = identity.type === 'patient'
          ? { patientId: identity.id, leadId: null }
          : { patientId: null, leadId: identity.id };
        const suppressed = await isChannelSuppressedTx(tx, {
          tenantId: request.auth.tenantId,
          destination: identity.phone,
          channel: 'voice',
          ...targetIdentity,
        });
        const consent = !suppressed && requiresImmutableConsent
          ? await compatibleVoiceConsentEventTx(tx, {
            tenantId: request.auth.tenantId,
            ...targetIdentity,
            purpose: campaign.purpose as (typeof OUTBOUND_PURPOSES)[number],
            policyVersion: campaign.policyVersion!,
          })
          : null;
        const voiceAuthorizationReason = suppressed
          ? 'suppressed' as const
          : requiresImmutableConsent
            ? consent ? 'compatible_immutable_consent' as const : 'consent_missing_or_incompatible' as const
            : 'treatment_operations' as const;
        candidates.push({
          ...identity,
          phone: maskPhone(identity.phone) ?? 'masked',
          voiceAuthorizationReady: !suppressed && (!requiresImmutableConsent || consent !== null),
          voiceAuthorizationReason,
        });
      }
      return candidates;
    });
  });

  app.get('/outbound-campaigns/:id/targets', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const rows = await db.receptionistCallTarget.findMany({ where: { tenantId: request.auth.tenantId, campaignId: id }, orderBy: { createdAt: 'asc' } });
    return rows.map(row => ({ ...row, phone: maskPhone(row.phone) }));
  });

  app.post('/outbound-campaigns/:id/targets', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({
      targets: z.array(z.object({
        phone: z.string().trim().min(3).max(40).optional(),
        firstName: z.string().trim().max(120).optional(),
        lastName: z.string().trim().max(120).optional(),
        email: z.string().trim().max(160).optional(),
        patientId: uuid.optional(),
        leadId: uuid.optional(),
      })).min(1).max(500),
    }).parse(request.body);
    const campaign = await db.receptionistOutboundCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const normalized = await runWithTenantContext(request.auth.tenantId, async tx => {
      const rows: Array<(typeof body.targets)[number] & { phone: string }> = [];
      const seenDestinations = new Set<string>();
      for (const target of body.targets) {
        if (Boolean(target.patientId) === Boolean(target.leadId)) throw new Error('target_exact_identity_required');
        const identity = target.patientId
          ? await tx.patient.findFirst({ where: { id: target.patientId, tenantId: request.auth.tenantId, deletedAt: null }, select: { phone: true } })
          : await tx.lead.findFirst({ where: { id: target.leadId!, tenantId: request.auth.tenantId }, select: { phone: true } });
        if (!identity) throw new Error('target_identity_foreign_or_inactive');
        const identityPhone = toE164(identity.phone ?? '');
        if (!isValidE164(identityPhone)) throw new Error('target_phone_invalid');
        if (target.phone && !target.phone.includes('*') && toE164(target.phone) !== identityPhone) throw new Error('target_phone_identity_mismatch');
        if (seenDestinations.has(identityPhone)) throw new Error('target_destination_duplicate');
        seenDestinations.add(identityPhone);
        if (await tx.receptionistCallTarget.count({ where: { tenantId: request.auth.tenantId, campaignId: id, phone: identityPhone } })) {
          throw new Error('target_destination_duplicate');
        }
        rows.push({ ...target, phone: identityPhone });
      }
      return rows;
    }).catch(error => {
      const reason = error instanceof Error ? error.message : 'target_invalid';
      throw app.httpErrors.conflict(`Outbound target is not deployable: ${reason}.`);
    });
    let created;
    try {
      created = await db.receptionistCallTarget.createMany({
        data: normalized.map(t => ({ tenantId: request.auth.tenantId, campaignId: id, phone: t.phone, firstName: t.firstName, lastName: t.lastName, email: t.email, patientId: t.patientId, leadId: t.leadId })),
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw app.httpErrors.conflict('An outbound target for this destination already exists in the campaign.');
      }
      throw error;
    }
    return reply.code(201).send({ added: created.count });
  });

  // Attach the one environment-authorized destination to an explicitly
  // synthetic lead. The raw destination never comes from the browser and is
  // never returned. This keeps live UAT separate from normal patient data and
  // prevents an operator from changing the recipient at runtime.
  app.post('/outbound-campaigns/:id/live-test-target', { preHandler: [ownerAdminRoles, writeRoles] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({
      firstName: z.string().trim().min(1).max(120).default('Jordan'),
      lastName: z.string().trim().max(120).default('Test'),
      scenario: z.string().trim().min(2).max(120).default('attended synthetic voice UAT'),
      acknowledgeAuthorizedSyntheticRecipient: z.literal(true),
      acknowledgeSyntheticConsentEvidence: z.boolean().default(false),
    }).strict().parse(request.body ?? {});
    const liveTest = liveCallUatStatus(new Date(), request.auth.tenantId);
    const destination = liveCallUatDestination(request.auth.tenantId);
    if (!liveTest.active || !destination || !liveTest.executionId) {
      return reply.code(409).send({ status: 'blocked', reason: liveTest.blockingReason ?? 'live_test_not_active' });
    }
    const campaign = await db.receptionistOutboundCampaign.findFirst({
      where: { id, tenantId: request.auth.tenantId },
      select: {
        id: true, purpose: true, policyVersion: true, legalBasis: true,
        consentText: true, script: true,
      },
    });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    if (!campaign.purpose || !campaign.policyVersion || !campaign.legalBasis) {
      return reply.code(409).send({ status: 'blocked', reason: 'campaign_authority_incomplete' });
    }
    const campaignPurpose = campaign.purpose;
    const campaignPolicyVersion = campaign.policyVersion;
    const requiresConsent = campaign.legalBasis === 'EXPLICIT_CONSENT' || campaignPurpose === 'PATIENT_REACTIVATION';
    if (requiresConsent && !body.acknowledgeSyntheticConsentEvidence) {
      return reply.code(409).send({ status: 'blocked', reason: 'synthetic_consent_attestation_required' });
    }
    const source = `${LIVE_UAT_TARGET_SOURCE_PREFIX}${liveTest.executionId}:${campaign.id}`;
    const evidenceReference = `${source}:staff-authorized`;
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      let lead = await tx.lead.findFirst({
        where: { tenantId: request.auth.tenantId, source, phone: destination, deletedAt: null },
        select: { id: true, name: true, phone: true },
      });
      if (!lead) {
        lead = await tx.lead.create({
          data: {
            tenantId: request.auth.tenantId,
            name: `${body.firstName} ${body.lastName}`.trim(),
            phone: destination,
            channel: 'CALL',
            service: 'Synthetic live voice UAT',
            stage: 'TEST_AUTHORIZED',
            source,
          },
          select: { id: true, name: true, phone: true },
        });
      }
      if (requiresConsent) {
        const existingConsent = await tx.receptionistVoiceConsentEvent.findFirst({
          where: {
            tenantId: request.auth.tenantId,
            leadId: lead.id,
            purpose: campaignPurpose,
            policyVersion: campaignPolicyVersion,
            evidenceReference,
            granted: true,
          },
          select: { id: true },
        });
        if (!existingConsent) {
          await tx.receptionistVoiceConsentEvent.create({ data: {
            tenantId: request.auth.tenantId,
            leadId: lead.id,
            purpose: campaignPurpose,
            granted: true,
            policyVersion: campaignPolicyVersion,
            disclosureTextHash: fingerprintJson({
              policyVersion: campaignPolicyVersion,
              disclosure: campaign.consentText ?? campaign.script,
              scenario: body.scenario,
            }),
            evidenceReference,
            captureMethod: 'STAFF_ATTESTED_SYNTHETIC_UAT',
            source: 'CARECOMMAND_LIVE_UAT',
            actorUserId: request.auth.userId,
            jurisdiction: 'SYNTHETIC_UAT',
          } });
        }
      }
      let target = await tx.receptionistCallTarget.findFirst({
        where: { tenantId: request.auth.tenantId, campaignId: campaign.id, phone: destination },
        select: { id: true, leadId: true, status: true },
      });
      if (!target) {
        target = await tx.receptionistCallTarget.create({
          data: {
            tenantId: request.auth.tenantId,
            campaignId: campaign.id,
            leadId: lead.id,
            firstName: body.firstName,
            lastName: body.lastName,
            phone: destination,
            status: 'PENDING',
          },
          select: { id: true, leadId: true, status: true },
        });
      } else if (target.leadId !== lead.id) {
        throw new Error('live_test_destination_already_bound');
      }
      await auditOutboundMutation(tx, requestAuditContext(request), {
        action: 'receptionist.liveUat.targetAttached',
        resource: 'receptionistCallTarget',
        resourceId: target.id,
        metadata: {
          campaignId: campaign.id,
          executionId: liveTest.executionId,
          destinationMasked: maskPhone(destination),
          scenario: body.scenario,
          synthetic: true,
          consentEvidenceCreated: requiresConsent,
        },
      });
      return { targetId: target.id, leadId: lead.id, status: target.status };
    }).catch(error => {
      const reason = error instanceof Error ? error.message : 'live_test_target_failed';
      throw app.httpErrors.conflict(`Live-test target could not be attached: ${reason}.`);
    });
    return reply.code(201).send({
      status: 'attached',
      targetId: result.targetId,
      leadId: result.leadId,
      targetStatus: result.status,
      destinationMasked: maskPhone(destination),
      executionId: liveTest.executionId,
    });
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
      metadata: { campaignId: params.campaignId, destinationMasked: maskPhone(target.phone) },
    });
    return reply.code(204).send();
  });

  // ----- Launch a single outbound call (test call or to a target) ---------
  app.post('/outbound-campaigns/:id/launch-attempts', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const { token } = z.object({ token: uuid }).strict().parse(request.body);
    const campaign = await db.receptionistOutboundCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { id: true } });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const key = `${request.auth.tenantId}:${id}:${token}`;
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-client-attempt:${key}`}::text, 0))::text AS locked`;
      await tx.idempotencyKey.upsert({
        where: { scope_key: { scope: CLIENT_LAUNCH_ATTEMPT_SCOPE, key } },
        update: { tenantId: request.auth.tenantId },
        create: { tenantId: request.auth.tenantId, scope: CLIENT_LAUNCH_ATTEMPT_SCOPE, key },
      });
    });
    return { status: 'registered' as const, token };
  });

  app.post('/outbound-campaigns/:id/launch-attempts/:token/verify-clear', { preHandler: writeRoles }, async request => {
    const { id, token } = z.object({ id: uuid, token: uuid }).parse(request.params);
    const key = `${request.auth.tenantId}:${id}:${token}`;
    return runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-client-attempt:${key}`}::text, 0))::text AS locked`;
      const attempt = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope: CLIENT_LAUNCH_ATTEMPT_SCOPE, key } } });
      if (!attempt || attempt.tenantId !== request.auth.tenantId) throw app.httpErrors.notFound('Launch attempt not found');
      if (attempt.resultId === null) {
        await tx.idempotencyKey.update({ where: { id: attempt.id }, data: { resultId: 'cancelled_before_dispatch' } });
        await tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
          action: 'receptionist.outbound.clientAttempt.cancelledBeforeDispatch',
          resource: 'receptionistOutboundCampaign', resourceId: id,
          requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
          metadata: { clientAttemptToken: token },
        } });
        return { cleared: true as const, proof: 'non_submission_fenced' as const };
      }
      if (attempt.resultId === 'cancelled_before_dispatch' || attempt.resultId.startsWith('blocked:') || attempt.resultId.startsWith('reconciled:')) {
        return { cleared: true as const, proof: attempt.resultId };
      }
      if (attempt.resultId === 'dispatching') return { cleared: false as const, proof: 'dispatch_in_progress' as const };
      const call = uuid.safeParse(attempt.resultId).success
        ? await tx.receptionistCallLog.findFirst({
          where: { id: attempt.resultId, tenantId: request.auth.tenantId, outboundCampaignId: id },
          include: { target: { select: { status: true } }, outboundProviderIntent: { select: { id: true } } },
        })
        : null;
      if (!call) return { cleared: false as const, proof: 'durable_call_status_unresolved' as const };
      const terminal = call.outcome !== 'IN_PROGRESS' && call.endedAt !== null;
      const targetReleased = !call.target || call.target.status !== 'CALLING';
      const unboundUncertainIntent = Boolean(call.outboundProviderIntent && !call.retellCallId && call.outcome === 'ESCALATED');
      const reconciliationResolved = unboundUncertainIntent ? await (async () => {
        const [signals, tasks] = await Promise.all([
          tx.operationalSignal.findMany({
            where: {
              tenantId: request.auth.tenantId, entityType: 'receptionistCallLog', entityId: call.id,
              signalType: { in: [
                'receptionist_outbound_stop_unconfirmed_after_acceptance',
                'receptionist_outbound_provider_acceptance_unknown',
                'receptionist_outbound_local_binding_failed',
                'receptionist_provider_deployment_mismatch',
                'receptionist_outbound_provider_intent_recovery',
              ] },
            },
            select: { status: true },
          }),
          tx.staffTask.findMany({
            where: {
              tenantId: request.auth.tenantId,
              metadata: { path: ['callLogId'], equals: call.id },
            },
            select: { status: true, metadata: true },
          }),
        ]);
        const reconciliationTasks = tasks.filter(task => {
          const metadata = task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
            ? task.metadata as Prisma.JsonObject
            : null;
          const workflow = typeof metadata?.workflow === 'string' ? metadata.workflow : '';
          return workflow.startsWith('receptionist_') && workflow.includes('reconcil');
        });
        const signalsResolved = signals.length > 0 && signals.every(signal => signal.status === 'resolved');
        const tasksResolved = reconciliationTasks.length > 0 && reconciliationTasks.every(task => task.status === 'COMPLETED');
        return signals.length > 0
          ? signalsResolved && (reconciliationTasks.length === 0 || tasksResolved)
          : tasksResolved;
      })() : true;
      if (!terminal || !targetReleased || (unboundUncertainIntent && !reconciliationResolved)) {
        return {
          cleared: false as const, proof: unboundUncertainIntent ? 'unbound_provider_intent' as const : 'call_not_terminal' as const,
          callLogId: call.id, providerCallId: maskProviderId(call.retellCallId),
        };
      }
      await tx.idempotencyKey.update({ where: { id: attempt.id }, data: { resultId: `reconciled:${call.id}` } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionist.outbound.clientAttempt.reconciled',
        resource: 'receptionistCallLog', resourceId: call.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { clientAttemptToken: token, outcome: call.outcome, targetReleased },
      } });
      return { cleared: true as const, proof: 'durable_terminal_reconciliation' as const, callLogId: call.id, providerCallId: maskProviderId(call.retellCallId) };
    });
  });

  // The launch path itself lives in lib/receptionist/outboundLaunch.ts so the
  // dialler worker can run exactly the same gates. This handler validates the
  // request, names the actor, and renders the result — nothing more. Any fence
  // added here instead of there would be a fence the automated dialler does
  // not have.
  app.post('/outbound-campaigns/:id/call', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({
      phone: z.string().trim().min(3).max(40).optional(),
      firstName: z.string().trim().max(120).optional(),
      lastName: z.string().trim().max(120).optional(),
      email: z.string().trim().max(160).optional(),
      targetId: uuid.optional(),
      clientAttemptToken: uuid.optional(),
    }).parse(request.body);

    const result = await launchOutboundCall({
      tenantId: request.auth.tenantId,
      campaignId: id,
      actor: requestLaunchActor(request),
      log: request.log,
      ...body,
    });
    if (result.notFound) throw app.httpErrors.notFound(result.notFound);
    return reply.code(result.code).send(result.body);
  });


  // Provider lifecycle polling fallback for attended UAT when a public signed
  // webhook is not available. This endpoint never returns transcripts,
  // recordings, phone numbers, or free-text analysis and never invents a
  // successful business outcome from a technically ended provider call.
  app.post('/outbound-campaigns/:campaignId/call-logs/:id/provider-sync', { preHandler: writeRoles }, async (request, reply) => {
    const params = z.object({ campaignId: uuid, id: uuid }).parse(request.params);
    const localCall = await db.receptionistCallLog.findFirst({
      where: {
        id: params.id,
        tenantId: request.auth.tenantId,
        outboundCampaignId: params.campaignId,
      },
      include: {
        outboundCampaign: {
          select: {
            id: true,
            defaultBranchId: true,
            maxRetryAttempts: true,
            agent: { select: { providerAgentId: true, providerVersion: true } },
          },
        },
        target: { select: { id: true, attempts: true, status: true } },
      },
    });
    if (!localCall) throw app.httpErrors.notFound('Call log not found');
    if (!localCall.retellCallId) {
      return reply.code(409).send({ status: 'blocked', reason: 'provider_call_id_missing' });
    }
    const provider = await getPhoneCall(localCall.retellCallId);
    if (!provider.ok) {
      await audit(request, {
        action: 'receptionist.call.providerSyncFailed', resource: 'receptionistCallLog', resourceId: localCall.id,
        metadata: { campaignId: params.campaignId, reason: provider.error },
      });
      return reply.code(502).send({ status: 'provider_unavailable', reason: provider.error });
    }
    const snapshot = provider.call;

    // ---- Reconciliation authority -----------------------------------------
    // Whether this provider record is OURS is decided by evidence we already
    // hold, not by reading our own metadata back off the provider:
    //
    //   * we minted the request under a durable
    //     `ReceptionistOutboundProviderIntent` for THIS call log, committed
    //     before the provider was ever contacted;
    //   * the provider returned this `call_id` synchronously on that same
    //     request, and `getPhoneCall` refuses to answer about any other id
    //     (`retell_call_id_mismatch`);
    //   * `ReceptionistCallLog.retellCallId` is globally `@unique`, so one
    //     provider call cannot be claimed by two tenants — cross-tenant
    //     misattribution is a database invariant, not a policy.
    //
    // The intent is the load-bearing half. A `retellCallId` sitting on a local
    // row with no intent is NOT ours however friendly the provider record
    // looks, and stays quarantined: "the id is on one of our rows, therefore
    // it is ours" is precisely the reasoning this refuses.
    const submissionIntent = await db.receptionistOutboundProviderIntent.findFirst({
      where: {
        tenantId: request.auth.tenantId,
        callLogId: localCall.id,
        outboundCampaignId: params.campaignId,
      },
      select: { id: true },
    });

    // The provider record is corroboration, matched three-valued:
    // match / mismatch / ABSENT. The old check collapsed absent into mismatch,
    // and a call the provider never STARTED carries no metadata at all — no
    // tenant, no campaign, no call log, no `to_number`. So the one population
    // this endpoint exists to rescue (accepted, never connected, no lifecycle
    // webhook ever delivered, row pinned IN_PROGRESS forever) was the exact
    // population it was guaranteed to refuse. Silence is not contradiction.
    // A populated field naming someone ELSE still hard-quarantines.
    const metadataTenant = typeof snapshot.metadata.tenantId === 'string' ? snapshot.metadata.tenantId : null;
    const metadataCampaign = typeof snapshot.metadata.outboundCampaignId === 'string' ? snapshot.metadata.outboundCampaignId : null;
    const metadataCallLog = typeof snapshot.metadata.callLogId === 'string' ? snapshot.metadata.callLogId : null;
    // Agent IDS are stable across a republish, so the campaign's binding is a
    // sound expectation for one. Agent VERSIONS are not: re-verifying or
    // republishing an agent bumps `providerVersion`, and the provider record
    // keeps reporting the version the call actually ran under — so comparing a
    // finished call against the campaign's version NOW quarantined correctly
    // attributed calls every time the deployment moved on. A version may only
    // be contradicted by the version this call was dispatched under, which is
    // the immutable binding stamped on the call row itself (null on rows that
    // carry no binding — absent, and therefore not a contradiction).
    const expectedAgentId = localCall.boundProviderAgentId ?? localCall.outboundCampaign?.agent?.providerAgentId ?? null;
    const dispatchedAgentVersion = localCall.boundProviderAgentVersion;
    const contradicts = (expected: string | number | null, actual: string | number | null) =>
      expected !== null && actual !== null && expected !== actual;
    const bindingContradiction = contradicts(request.auth.tenantId, metadataTenant) ? 'metadata_tenant'
      : contradicts(params.campaignId, metadataCampaign) ? 'metadata_campaign'
        : contradicts(localCall.id, metadataCallLog) ? 'metadata_call_log'
          : contradicts(expectedAgentId, snapshot.agentId) ? 'provider_agent'
            : contradicts(dispatchedAgentVersion, snapshot.agentVersion) ? 'provider_agent_version'
              : null;
    if (!submissionIntent || bindingContradiction) {
      await audit(request, {
        action: 'receptionist.call.providerSyncQuarantined', resource: 'receptionistCallLog', resourceId: localCall.id,
        metadata: {
          campaignId: params.campaignId, providerStatus: snapshot.status, reason: 'provider_binding_mismatch',
          // Which half refused, so an operator can tell "we never submitted
          // this call" apart from "the provider says it belongs to someone
          // else" without reading the provider record by hand.
          quarantine: submissionIntent ? bindingContradiction : 'no_local_submission_intent',
        },
      });
      return reply.code(409).send({ status: 'quarantined', reason: 'provider_binding_mismatch' });
    }

    const reason = (snapshot.disconnectionReason ?? '').toLowerCase();
    const technicallyTerminal = ['ended', 'error', 'not_connected'].includes(snapshot.status);
    const providerTerminalOutcome = snapshot.status === 'error'
      ? 'FAILED' as const
      : snapshot.status === 'not_connected'
        ? reason.includes('voicemail') ? 'VOICEMAIL' as const : 'NO_ANSWER' as const
        : snapshot.status === 'ended'
          ? reason.includes('voicemail')
            ? 'VOICEMAIL' as const
            : (reason.includes('no_answer') || reason.includes('busy') || reason.includes('unanswered'))
              ? 'NO_ANSWER' as const
              : 'ESCALATED' as const
          : 'IN_PROGRESS' as const;
    const durationSeconds = Math.max(0, Math.round(snapshot.durationMs / 1_000));
    const startedAt = snapshot.startTimestamp ? new Date(snapshot.startTimestamp) : null;
    const endedAt = snapshot.endTimestamp ? new Date(snapshot.endTimestamp) : technicallyTerminal ? new Date() : null;

    const persisted = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-call-lifecycle:${request.auth.tenantId}:${localCall.retellCallId}`})::bigint)`;
      const current = await tx.receptionistCallLog.findFirstOrThrow({
        where: { id: localCall.id, tenantId: request.auth.tenantId },
        select: { outcome: true, durationSeconds: true, endedAt: true, startedAt: true },
      });
      const nextOutcome = technicallyTerminal && current.outcome === 'IN_PROGRESS'
        ? providerTerminalOutcome
        : current.outcome;
      const updated = await tx.receptionistCallLog.update({
        where: { id: localCall.id },
        data: {
          outcome: nextOutcome,
          durationSeconds: Math.max(current.durationSeconds, durationSeconds),
          startedAt: current.startedAt ?? startedAt ?? undefined,
          endedAt: technicallyTerminal ? (current.endedAt ?? endedAt ?? new Date()) : undefined,
        },
      });
      if (technicallyTerminal) {
        const priorMinutes = Math.ceil(current.durationSeconds / 60);
        const finalMinutes = Math.ceil(updated.durationSeconds / 60);
        const delta = Math.max(0, finalMinutes - priorMinutes);
        if (delta > 0) {
          // Billable record first, in the same transaction as the call row.
          await recordUsageEvent(tx, {
            tenantId: request.auth.tenantId,
            metric: USAGE_METRICS.voiceMinute,
            quantity: delta,
            occurredAt: updated.endedAt ?? new Date(),
            sourceModule: 'receptionist',
            sourceType: 'receptionistCallLog',
            sourceId: updated.id,
            dedupeKey: voiceCallDedupeKey(localCall.retellCallId ?? updated.id, finalMinutes),
          });
          // Lifetime totals, kept for the operator's "since day one" view only.
          await tx.tenantAiUsage.upsert({
            where: { tenantId: request.auth.tenantId },
            update: { receptionistMinutes: { increment: delta } },
            create: { tenantId: request.auth.tenantId, receptionistMinutes: delta },
          });
          await tx.tenantUsageLimit.upsert({
            where: { tenantId_key: { tenantId: request.auth.tenantId, key: 'voice_minutes' } },
            update: { used: { increment: delta } },
            create: { tenantId: request.auth.tenantId, key: 'voice_minutes', limitValue: DEFAULT_VOICE_MINUTES_LIMIT, used: delta },
          });
        }
      }
      if (technicallyTerminal && localCall.target && localCall.outboundCampaign) {
        const targetStatus = targetStatusAfterOutcome(nextOutcome, localCall.target.attempts, localCall.outboundCampaign.maxRetryAttempts);
        if (targetStatus) {
          await tx.receptionistCallTarget.updateMany({
            where: {
              id: localCall.target.id,
              tenantId: request.auth.tenantId,
              campaignId: params.campaignId,
              lastCallLogId: localCall.id,
            },
            data: { status: targetStatus, lastOutcome: nextOutcome },
          });
        }
      }
      // A technically ended call without a signed analyzed webhook cannot be
      // represented as a successful appointment, consent, or campaign result.
      // Put it in explicit staff review exactly once.
      let reviewTaskId: string | null = null;
      if (snapshot.status === 'ended' && current.outcome === 'IN_PROGRESS' && nextOutcome === 'ESCALATED') {
        const existingTask = await tx.staffTask.findFirst({
          where: {
            tenantId: request.auth.tenantId,
            metadata: { path: ['workflowKey'], equals: `provider_poll_review:${localCall.id}` },
          },
          select: { id: true },
        });
        const task = existingTask ?? await tx.staffTask.create({
          data: {
            tenantId: request.auth.tenantId,
            branchId: localCall.outboundCampaign?.defaultBranchId ?? null,
            title: 'Review ended AI receptionist call',
            priority: 'HIGH',
            metadata: {
              workflow: 'receptionist_provider_poll_reconciliation',
              workflowKey: `provider_poll_review:${localCall.id}`,
              callLogId: localCall.id,
              campaignId: params.campaignId,
              reason: 'provider_ended_without_signed_analysis',
            },
          },
          select: { id: true },
        });
        reviewTaskId = task.id;
      }
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: 'receptionist.call.providerSynchronized',
        resource: 'receptionistCallLog',
        resourceId: localCall.id,
        requestId: request.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          campaignId: params.campaignId,
          providerStatus: snapshot.status,
          providerCallIdMasked: maskProviderId(snapshot.callId),
          durationSeconds: updated.durationSeconds,
          outcome: updated.outcome,
          disconnectionReason: snapshot.disconnectionReason,
          combinedCostNativeUnits: snapshot.combinedCostNativeUnits,
          reviewTaskId,
        },
      } });
      return { updated, reviewTaskId };
    });
    return {
      status: 'synchronized',
      providerStatus: snapshot.status,
      providerCallIdMasked: maskProviderId(snapshot.callId),
      outcome: persisted.updated.outcome,
      durationSeconds: persisted.updated.durationSeconds,
      endedAt: persisted.updated.endedAt,
      destinationMasked: maskPhone(localCall.callerPhone),
      costNativeUnits: snapshot.combinedCostNativeUnits,
      reviewTaskId: persisted.reviewTaskId,
      verification: snapshot.mock ? 'mock' : 'provider_poll',
    };
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
    return rows.map(({ retellCallId, ...row }) => ({
      ...row,
      callerPhone: maskPhone(row.callerPhone),
      // The value was already masked; the KEY was not. A field called
      // `retellCallId` names the supplier in every response body, every
      // network tab and every error report a clinic forwards to us, whatever
      // the value beside it has been reduced to.
      providerCallRef: maskProviderId(retellCallId),
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
      include: {
        bookedAppointment: {
          select: {
            id: true, service: true, startsAt: true,
            branch: { select: { timezone: true, name: true, location: true } },
            providerProfile: { select: { user: { select: { displayName: true } } } },
          },
        },
      },
    });
  });

  app.patch('/booking-requests/:id', { preHandler: bookingReviewRoles }, async request => {
    const { id } = idParam.parse(request.params);
    // A staff status patch is review workflow only. BOOKED can be asserted only
    // by the canonical atomic booking service with an actual Appointment FK.
    const input = z.object({
      status: z.literal('REJECTED'),
      outcomeReason: z.string().trim().min(1).max(1000).optional(),
    }).strict().parse(request.body);
    const source = await db.appointmentRequest.findFirst({
      where: { id, tenantId: request.auth.tenantId },
      select: { callLogId: true, callLog: { select: { retellCallId: true } } },
    });
    if (!source) throw app.httpErrors.notFound('Request not found');
    const lockKey = source.callLogId && source.callLog?.retellCallId
      ? `receptionist-call-lifecycle:${request.auth.tenantId}:${source.callLog.retellCallId}`
      : `receptionist-appointment-request:${request.auth.tenantId}:${id}`;
    const row = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
      const existing = await tx.appointmentRequest.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Request not found');
      if (existing.status === 'REJECTED') {
        if (input.outcomeReason && input.outcomeReason !== existing.outcomeReason) {
          throw app.httpErrors.conflict('A terminal appointment request decision cannot be changed');
        }
        return existing;
      }
      if (!['PENDING_REVIEW', 'MISSING_INFO'].includes(existing.status)) {
        throw app.httpErrors.conflict('A terminal appointment request cannot be reopened or changed through the review endpoint');
      }
      const updated = await tx.appointmentRequest.update({ where: { id }, data: input });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionist.appointmentRequest.reviewTransitioned', resource: 'appointmentRequest', resourceId: id,
        metadata: { fromStatus: existing.status, toStatus: updated.status },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId, eventType: 'receptionist.appointmentRequest.reviewTransitioned',
        entityType: 'appointmentRequest', entityId: id, sourceModule: 'receptionist',
        payload: { fromStatus: existing.status, toStatus: updated.status },
      } });
      return updated;
    });
    return row;
  });
};
