import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { retellConfigStatus, createPhoneCall, getPhoneCall, stopPhoneCall } from '../../lib/retell';
import { buildHoursDynamicVariables, hoursStatus } from '../../lib/receptionist/clinicHours';
import { loadHoursSource } from '../../lib/receptionist/hoursSource';
import { resolveLocalePackWithFallback, resolvedLocaleFormat } from '../../lib/receptionist/localePacks/resolve';
import { isDestinationOptedOut, isSuppressed, isValidE164, toE164 } from '../../lib/campaigns';
import { requireRoles } from '../../plugins/roles';
import {
  hasReceptionistPermission,
  RECEPTIONIST_PERMISSIONS,
  requireReceptionistPermission,
} from '../../lib/receptionist/accessControl';
import { agentReadinessReason } from '../../lib/receptionist/agentReadiness';
import { runWithTenantContext } from '../../lib/tenantContext';
import { Prisma } from '../../generated/prisma/client';
import { fingerprintJson } from './intakeContract';
import {
  authorizeOutboundProviderIntentTx,
  compatibleVoiceConsentEventTx,
  isChannelSuppressedTx,
} from '../../lib/receptionist/dncFence';
import {
  issueProviderIntentCorrelation,
  providerIntentMetadataForRetell,
} from '../../lib/receptionist/providerIntentCorrelation';
import {
  authorizeLiveCallDestination,
  evaluateLiveCallAdmission,
  liveCallUatDestination,
  liveCallUatDisclosure,
  liveCallUatScope,
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
const RUNNABLE_CAMPAIGN_STATUS = 'RUNNING';
const DIALABLE_TARGET_STATUS = 'PENDING';
const OUTBOUND_PURPOSES = ['CARE_COORDINATION', 'APPOINTMENT_REMINDER', 'PATIENT_REACTIVATION'] as const;
const OUTBOUND_LEGAL_BASES = ['EXPLICIT_CONSENT', 'TREATMENT_OPERATIONS'] as const;
const STRICT_HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CLIENT_LAUNCH_ATTEMPT_SCOPE = 'receptionist.outbound-client-attempt';
const LIVE_UAT_TARGET_SOURCE_PREFIX = 'live_voice_uat:';
export const MAX_TENANT_ACTIVE_CALLS = 3;
import { recordUsageEvent, periodUsageTotal, voiceCallDedupeKey, USAGE_METRICS } from '../../lib/usageMetering';

export const DEFAULT_VOICE_MINUTES_LIMIT = 500;

type ProviderBoundaryTestStage = 'before_suppression_fence' | 'suppression_fence_acquired' | 'provider_intent_committed' | 'before_provider_binding_lock' | 'provider_binding_committed' | 'before_call_stopping_evaluation';
let providerBoundaryTestHook: ((stage: ProviderBoundaryTestStage) => Promise<void>) | null = null;

/** Deterministic interleaving support for integration tests only. */
export function setProviderBoundaryTestHookForTests(hook: ((stage: ProviderBoundaryTestStage) => Promise<void>) | null) {
  if (env.NODE_ENV === 'production') throw new Error('provider boundary test hooks are disabled in production');
  providerBoundaryTestHook = hook;
}

function sameOptionalIdentity(provided: string | undefined, stored: string | null): boolean {
  if (provided === undefined) return true;
  return provided.trim().toLocaleLowerCase() === (stored ?? '').trim().toLocaleLowerCase();
}

type OutboundAuthorityFingerprintInput = {
  id: string;
  bookingMode: string;
  purpose: string | null;
  legalBasis: string | null;
  policyVersion: string | null;
  agentId: string | null;
  receptionistCampaignId: string | null;
  defaultBranchId: string | null;
  defaultService: string | null;
  script: string;
  requiredFields: string[];
  customQuestions: unknown;
  consentText: string | null;
  humanHandoffInstruction: string | null;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  maxRetryAttempts: number;
  receptionistCampaign?: {
    intakeSchemaRevision: number;
    intakeSchemaAttestedRevision: number | null;
    intakeSchemaFingerprint: string | null;
    intakeToolFingerprint: string | null;
  } | null;
  agent?: { providerAgentId: string | null; providerVersion: number | null } | null;
};

function outboundAuthorityFingerprint(campaign: OutboundAuthorityFingerprintInput): string {
  return fingerprintJson({
    outboundCampaignId: campaign.id,
    bookingMode: campaign.bookingMode,
    purpose: campaign.purpose,
    legalBasis: campaign.legalBasis,
    policyVersion: campaign.policyVersion,
    agentId: campaign.agentId,
    receptionistCampaignId: campaign.receptionistCampaignId,
    defaultBranchId: campaign.defaultBranchId,
    defaultService: campaign.defaultService,
    script: campaign.script,
    requiredFields: campaign.requiredFields,
    customQuestions: campaign.customQuestions,
    consentText: campaign.consentText,
    humanHandoffInstruction: campaign.humanHandoffInstruction,
    quietHoursStart: campaign.quietHoursStart,
    quietHoursEnd: campaign.quietHoursEnd,
    maxRetryAttempts: campaign.maxRetryAttempts,
    receptionistCampaignRevision: campaign.receptionistCampaign?.intakeSchemaRevision ?? null,
    receptionistCampaignAttestedRevision: campaign.receptionistCampaign?.intakeSchemaAttestedRevision ?? null,
    receptionistCampaignFingerprint: campaign.receptionistCampaign?.intakeSchemaFingerprint ?? null,
    toolFingerprint: campaign.receptionistCampaign?.intakeToolFingerprint ?? null,
    providerAgentId: campaign.agent?.providerAgentId ?? null,
    providerVersion: campaign.agent?.providerVersion ?? null,
  });
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

async function targetIdentityIsBound(
  tenantId: string,
  target: { patientId?: string | null; leadId?: string | null },
  destination: string,
): Promise<boolean> {
  if (Boolean(target.patientId) === Boolean(target.leadId)) return false;
  return runWithTenantContext(tenantId, async tx => {
    const identity = target.patientId
      ? await tx.patient.findFirst({ where: { id: target.patientId, tenantId, deletedAt: null }, select: { phone: true } })
      : await tx.lead.findFirst({ where: { id: target.leadId!, tenantId }, select: { phone: true } });
    return Boolean(identity && isValidE164(toE164(identity.phone ?? '')) && toE164(identity.phone ?? '') === destination);
  });
}

async function lockOutboundConfiguration(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-config:${tenantId}`}::text, 0))::text AS locked`;
}

async function lockOutboundDispatch(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-outbound-dispatch:${tenantId}`}::text, 0))::text AS locked`;
}

type ProviderStopIdentity = {
  tenantId: string;
  campaignId: string;
  targetId: string;
  callLogId: string;
  providerCallId: string;
};

async function applyConfirmedProviderStopTx(
  tx: Prisma.TransactionClient,
  identity: ProviderStopIdentity,
  request: FastifyRequest,
) {
  const call = await tx.receptionistCallLog.findFirst({
    where: {
      id: identity.callLogId,
      tenantId: identity.tenantId,
      outboundCampaignId: identity.campaignId,
      targetId: identity.targetId,
      retellCallId: identity.providerCallId,
      outcome: { in: ['IN_PROGRESS', 'ESCALATED', 'FAILED'] },
    },
    select: { id: true, outcome: true, endedAt: true },
  });
  const target = await tx.receptionistCallTarget.findFirst({
    where: {
      id: identity.targetId,
      tenantId: identity.tenantId,
      campaignId: identity.campaignId,
      lastCallLogId: identity.callLogId,
      OR: [
        { status: 'CALLING' },
        { status: 'FAILED', lastOutcome: { in: ['RECONCILIATION_REQUIRED', 'OUTBOUND_STOPPED'] } },
      ],
    },
    select: { lastOutcome: true },
  });
  if (!call || !target) return { applied: false, upgraded: false, signalsResolved: 0, tasksResolved: 0 };

  const upgraded = target.lastOutcome !== 'OUTBOUND_STOPPED';
  if (call.outcome === 'IN_PROGRESS') {
    await tx.receptionistCallLog.update({
      where: { id: call.id },
      data: { outcome: 'FAILED', endedAt: call.endedAt ?? new Date() },
    });
  }
  await tx.receptionistCallTarget.update({
    where: { id: identity.targetId },
    data: { status: 'FAILED', lastOutcome: 'OUTBOUND_STOPPED', lastCallLogId: identity.callLogId },
  });

  const signals = await tx.operationalSignal.updateMany({
    where: {
      tenantId: identity.tenantId,
      entityType: 'receptionistCallLog',
      entityId: identity.callLogId,
      signalType: 'receptionist_outbound_stop_unconfirmed_after_acceptance',
      status: 'open',
    },
    data: {
      status: 'resolved',
      reason: 'Superseded by durable confirmation that the provider call was stopped.',
    },
  });
  const candidateTasks = await tx.staffTask.findMany({
    where: {
      tenantId: identity.tenantId,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      metadata: { path: ['callLogId'], equals: identity.callLogId },
    },
    select: { id: true, metadata: true },
  });
  const taskIds = candidateTasks.flatMap(task => {
    const metadata = task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
      ? task.metadata as Prisma.JsonObject
      : null;
    return metadata?.workflow === 'receptionist_outbound_stop_reconciliation' ? [task.id] : [];
  });
  const tasks = taskIds.length
    ? await tx.staffTask.updateMany({ where: { id: { in: taskIds }, tenantId: identity.tenantId }, data: { status: 'CANCELED' } })
    : { count: 0 };

  if (upgraded) {
    await auditOutboundMutation(tx, request, {
      action: 'receptionist.call.providerStopConfirmed',
      resource: 'receptionistCallLog',
      resourceId: identity.callLogId,
      metadata: {
        campaignId: identity.campaignId,
        targetId: identity.targetId,
        evidenceTransition: target.lastOutcome === 'RECONCILIATION_REQUIRED'
          ? 'provider_stop_uncertain_to_provider_stop_confirmed'
          : 'provider_stop_pending_to_provider_stop_confirmed',
        signalsResolved: signals.count,
        tasksResolved: tasks.count,
      },
    });
  }
  return { applied: true, upgraded, signalsResolved: signals.count, tasksResolved: tasks.count };
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
  input: {
    tenantId: string;
    clinicId: string;
    agentId: string | null | undefined;
    branchId: string | null | undefined;
    requireReady: boolean;
    bookingMode: 'APPOINTMENT_REQUEST_ONLY' | 'DIRECT_BOOKING_IF_SLOT_AVAILABLE';
    receptionistCampaignId: string | null | undefined;
    defaultService: string | null | undefined;
    purpose: string | null | undefined;
    legalBasis: string | null | undefined;
    policyVersion: string | null | undefined;
    quietHoursStart: string | null | undefined;
    quietHoursEnd: string | null | undefined;
  },
) {
  const clinic = await tx.receptionistClinic.findFirst({
    where: { id: input.clinicId, tenantId: input.tenantId, active: true },
    select: { id: true, timezone: true },
  });
  if (!clinic) throw new Error('clinic_inactive_or_foreign');
  const quietHoursReason = quietHoursConfigurationReason(
    input.quietHoursStart,
    input.quietHoursEnd,
    clinic.timezone,
    input.requireReady,
  );
  if (quietHoursReason) throw new Error(quietHoursReason);
  if (input.branchId) {
    const branch = await tx.branch.findFirst({ where: { id: input.branchId, tenantId: input.tenantId, active: true }, select: { id: true } });
    if (!branch) throw new Error('branch_inactive_or_foreign');
    const mappedLocation = await tx.receptionistLocation.findFirst({
      where: { tenantId: input.tenantId, clinicId: input.clinicId, branchId: input.branchId, active: true },
      select: { id: true },
    });
    if (!mappedLocation) throw new Error('branch_not_mapped_to_clinic');
  }
  if (!input.purpose?.trim() || !input.legalBasis?.trim() || !input.policyVersion?.trim()) {
    if (input.requireReady || input.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE') throw new Error('outbound_purpose_or_legal_basis_missing');
  }
  if (!input.agentId) {
    if (input.requireReady || input.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE') throw new Error('agent_unlinked');
    return;
  }
  const agent = await tx.receptionistAgent.findFirst({ where: { id: input.agentId, tenantId: input.tenantId, clinicId: input.clinicId } });
  if (!agent) throw new Error('agent_scope_mismatch');
  if (!agent.active) throw new Error('agent_inactive');
  if (input.requireReady || input.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE') {
    const reason = agentReadinessReason(agent);
    if (reason) throw new Error(reason);
  }
  if (input.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE') {
    if (!input.receptionistCampaignId) throw new Error('direct_booking_authority_unlinked');
    if (!input.branchId) throw new Error('direct_booking_branch_missing');
    if (!input.defaultService?.trim()) throw new Error('direct_booking_service_missing');
    const authority = await tx.receptionistCampaign.findFirst({
      where: {
        id: input.receptionistCampaignId,
        tenantId: input.tenantId,
        clinicId: input.clinicId,
        status: 'ACTIVE',
      },
      select: {
        id: true, agentId: true, appointmentType: true, eligibleLocationIds: true,
        intakeSchemaRevision: true, intakeSchemaAttestedRevision: true,
        intakeSchemaSnapshot: true, intakeSchemaFingerprint: true, intakeToolFingerprint: true,
        intakeSchemaProviderAgentId: true, intakeSchemaProviderVersion: true,
        intakeSchemaResponseEngineId: true, intakeSchemaResponseEngineVersion: true,
      },
    });
    if (!authority) throw new Error('direct_booking_authority_inactive_or_foreign');
    if (authority.agentId !== agent.id) throw new Error('direct_booking_agent_mismatch');
    const snapshotValid = authority.intakeSchemaSnapshot
      && typeof authority.intakeSchemaSnapshot === 'object'
      && !Array.isArray(authority.intakeSchemaSnapshot)
      && authority.intakeSchemaFingerprint === fingerprintJson(authority.intakeSchemaSnapshot);
    const deploymentValid = snapshotValid
      && authority.intakeSchemaAttestedRevision === authority.intakeSchemaRevision
      && authority.intakeToolFingerprint === agent.providerBookToolFingerprint
      && authority.intakeSchemaProviderAgentId === agent.providerAgentId
      && authority.intakeSchemaProviderVersion === agent.providerVersion
      && authority.intakeSchemaResponseEngineId === agent.providerResponseEngineId
      && authority.intakeSchemaResponseEngineVersion === agent.providerResponseEngineVersion;
    if (!deploymentValid) throw new Error('direct_booking_authority_unattested');
    if (authority.appointmentType.trim() !== input.defaultService.trim()) throw new Error('direct_booking_service_mismatch');
    const mapped = await tx.receptionistLocation.findFirst({
      where: {
        tenantId: input.tenantId, clinicId: input.clinicId, branchId: input.branchId,
        active: true, id: { in: authority.eligibleLocationIds },
      },
      select: { id: true },
    });
    if (!mapped) throw new Error('direct_booking_branch_not_eligible');
  }
}

function outboundAssignmentReason(error: unknown) {
  const reason = error instanceof Error ? error.message : '';
  return [
    'clinic_inactive_or_foreign', 'branch_inactive_or_foreign', 'branch_not_mapped_to_clinic', 'agent_unlinked', 'agent_scope_mismatch',
    'agent_inactive', 'agent_unverified', 'agent_configuration_changed', 'agent_verification_stale',
    'outbound_purpose_or_legal_basis_missing', 'direct_booking_authority_unlinked', 'direct_booking_branch_missing',
    'direct_booking_service_missing', 'direct_booking_authority_inactive_or_foreign', 'direct_booking_agent_mismatch',
    'direct_booking_authority_unattested', 'direct_booking_service_mismatch', 'direct_booking_branch_not_eligible',
    'direct_booking_authority_immutable', 'outbound_authority_immutable', 'outbound_authority_approval_required',
    'quiet_hours_missing', 'quiet_hours_incomplete', 'quiet_hours_invalid', 'quiet_hours_equal', 'quiet_hours_timezone_invalid',
  ].includes(reason) ? reason : null;
}

function providerIntentBlockReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  // Prisma includes the source invocation in some database error messages. A
  // broad substring check can therefore mistake a different trigger failure
  // for a known compliance rejection merely because the nearby source names
  // one of our sentinel errors. Match direct application sentinels exactly,
  // and database-raised messages only in Prisma/Postgres message fields.
  const direct = (sentinel: string) => message === sentinel;
  const raised = (phrase: string) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:ERROR:\\s*|message:\\s*["'])${escaped}(?:["'\\n]|$)`, 'i').test(message);
  };
  if (direct('outbound_provider_intent_suppressed')
    || raised('Outbound provider intent is suppressed at the linearization point')
    || raised('Outbound provider intent is denied by latest legacy patient consent')) return 'shared_suppression_gate';
  if (direct('outbound_provider_intent_consent_missing')
    || raised('Outbound provider intent requires immutable compatible voice consent evidence')
    || raised('Outbound provider intent voice consent is stale, revoked, expired, or incompatible')) return 'positive_voice_consent_missing';
  if (direct('outbound_provider_intent_target_missing')
    || direct('outbound_provider_intent_destination_mismatch')
    || raised('Outbound provider intent target is not the exact claimed destination')) return 'target_identity_changed';
  if (raised('Outbound provider intent campaign authority/purpose/policy is not current')
    || raised('Outbound provider intent is missing exact authority evidence')) return 'campaign_authority_invalid';
  return null;
}

// --- Quiet-hours enforcement (per outbound campaign, clinic timezone) --------
function parseHm(value?: string | null): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!STRICT_HH_MM.test(normalized)) return null;
  const [hour, minute] = normalized.split(':');
  const h = Number(hour);
  const min = Number(minute);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function timezoneIsValid(timezone: string): boolean {
  if (!timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function quietHoursConfigurationReason(
  start: string | null | undefined,
  end: string | null | undefined,
  timezone: string,
  required: boolean,
): 'quiet_hours_missing' | 'quiet_hours_incomplete' | 'quiet_hours_invalid' | 'quiet_hours_equal' | 'quiet_hours_timezone_invalid' | null {
  const hasStart = typeof start === 'string' && start.trim().length > 0;
  const hasEnd = typeof end === 'string' && end.trim().length > 0;
  if (!hasStart && !hasEnd) return required ? 'quiet_hours_missing' : null;
  if (hasStart !== hasEnd) return 'quiet_hours_incomplete';
  const parsedStart = parseHm(start);
  const parsedEnd = parseHm(end);
  if (parsedStart === null || parsedEnd === null) return 'quiet_hours_invalid';
  if (parsedStart === parsedEnd) return 'quiet_hours_equal';
  if (!timezoneIsValid(timezone)) return 'quiet_hours_timezone_invalid';
  return null;
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
// window. Handles overnight windows (e.g. 21:00–08:00 wraps midnight). Invalid
// configuration is treated as quiet so callers fail closed.
export function isWithinQuietHours(start: string | null | undefined, end: string | null | undefined, timezone: string): boolean {
  const s = parseHm(start);
  const e = parseHm(end);
  if (s === null || e === null || s === e || !timezoneIsValid(timezone)) return true;
  const now = nowMinutesInTz(timezone);
  if (now === null) return true;
  return s < e ? now >= s && now < e : now >= s || now < e;
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
          }, request);
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
    const liveTest = liveCallUatStatus(new Date(), request.auth.tenantId);
    const liveScope = liveCallUatScope();
    const liveAttempts = liveScope
      ? await db.idempotencyKey.findMany({
        where: { tenantId: request.auth.tenantId, scope: liveScope },
        select: { resultId: true },
        take: Math.max(20, liveTest.maxCalls + 1),
      })
      : [];
    const liveCallIds = liveAttempts
      .map(attempt => attempt.resultId)
      .filter((value): value is string => Boolean(value && !value.startsWith('blocked:') && value !== 'dispatching'));
    const liveCalls = liveCallIds.length
      ? await db.receptionistCallLog.findMany({
        where: { tenantId: request.auth.tenantId, id: { in: liveCallIds } },
        select: { durationSeconds: true, endedAt: true, outcome: true },
      })
      : [];
    const connectedSeconds = liveCalls.reduce((sum, call) => sum + call.durationSeconds, 0);
    const liveAdmission = evaluateLiveCallAdmission({
      attemptsUsed: liveAttempts.length,
      connectedSeconds,
      activeCalls: liveCalls.filter(call => !call.endedAt && call.outcome === 'IN_PROGRESS').length,
    }, new Date(), request.auth.tenantId);
    return {
      configured: status.configured && readyAgents > 0,
      mock: status.mock,
      missing: [...status.missing, ...(readyAgents ? [] : ['AGENT_DEPLOYMENT'])],
      readyAgents,
      adhocTestCallsAllowed: status.mock && env.NODE_ENV !== 'production',
      liveTest: {
        ...liveTest,
        attemptsUsed: liveAttempts.length,
        callsRemaining: Math.max(0, liveTest.maxCalls - liveAttempts.length),
        minutesUsed: Math.ceil(connectedSeconds / 60),
        minutesRemaining: Math.max(0, liveTest.maxTotalMinutes - Math.ceil(connectedSeconds / 60)),
        activeCalls: liveCalls.filter(call => !call.endedAt && call.outcome === 'IN_PROGRESS').length,
        admissionReason: liveAdmission.allowed ? null : liveAdmission.reason,
      },
      checklist: [
        { key: 'RETELL_API_KEY', label: 'Retell API key', set: !status.missing.includes('RETELL_API_KEY') },
        { key: 'RETELL_FROM_NUMBER', label: 'Outbound caller number', set: !status.missing.includes('RETELL_FROM_NUMBER') },
        { key: 'AGENT_DEPLOYMENT', label: 'Published agent deployment', set: readyAgents > 0 },
        { key: 'LIVE_TEST_CALLS_AUTHORIZED', label: 'Attended live-test authorization', set: liveTest.active },
      ],
    };
  });

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
        await auditOutboundMutation(tx, request, {
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
      await auditOutboundMutation(tx, request, {
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
          callLogId: call.id, providerCallId: call.retellCallId,
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
      return { cleared: true as const, proof: 'durable_terminal_reconciliation' as const, callLogId: call.id, providerCallId: call.retellCallId };
    });
  });

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

    const campaign = await db.receptionistOutboundCampaign.findFirst({
      where: { id, tenantId: request.auth.tenantId },
      include: {
        clinic: { select: { id: true, name: true, complianceDisclosure: true, timezone: true, country: true, defaultLanguage: true } },
        agent: true,
        receptionistCampaign: { select: { id: true, offerScript: true, appointmentType: true } },
      },
    });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');

    if (campaign.status !== RUNNABLE_CAMPAIGN_STATUS) {
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'campaign_not_running', status: campaign.status } });
      return reply.code(409).send({ status: 'blocked', reason: 'campaign_not_running' });
    }
    if (!campaign.authorityApprovedAt || !campaign.authorityApprovedById || !campaign.policyVersion) {
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'outbound_authority_unapproved' } });
      return reply.code(409).send({ status: 'blocked', reason: 'outbound_authority_unapproved' });
    }

    try {
      await runWithTenantContext(request.auth.tenantId, tx => validateOutboundAssignments(tx, {
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
      }));
    } catch (error) {
      const reason = outboundAssignmentReason(error) ?? 'campaign_authority_invalid';
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason } });
      return reply.code(409).send({ status: 'blocked', reason });
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
    const canonicalDialDestination = toE164(body.phone ?? target?.phone ?? '');
    if (!isValidE164(canonicalDialDestination)) {
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'invalid_e164_destination' } });
      return reply.code(400).send({ status: 'blocked', reason: 'invalid_e164_destination' });
    }
    const liveAuthorization = env.LIVE_TEST_CALLS_AUTHORIZED
      ? authorizeLiveCallDestination(canonicalDialDestination, new Date(), request.auth.tenantId)
      : null;
    if (liveAuthorization && !liveAuthorization.allowed) {
      await audit(request, {
        action: 'receptionist.call.blocked',
        resource: target ? 'receptionistCallTarget' : 'receptionistOutboundCampaign',
        resourceId: target?.id ?? campaign.id,
        metadata: {
          campaignId: campaign.id,
          reason: liveAuthorization.reason,
          destinationMasked: maskPhone(canonicalDialDestination),
          executionId: liveAuthorization.status.executionId,
        },
      });
      return reply.code(403).send({ status: 'blocked', reason: liveAuthorization.reason });
    }
    const liveTest = liveAuthorization?.allowed ? liveAuthorization.status : null;
    if (liveTest && !body.clientAttemptToken) {
      await audit(request, {
        action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id,
        metadata: { reason: 'live_test_attempt_token_required', executionId: liveTest.executionId },
      });
      return reply.code(409).send({ status: 'blocked', reason: 'live_test_attempt_token_required' });
    }
    if (!target && !(retellConfigStatus().mock && env.NODE_ENV !== 'production')) {
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'adhoc_call_not_authorized' } });
      return reply.code(403).send({ status: 'blocked', reason: 'adhoc_call_not_authorized' });
    }
    if (target && !(await targetIdentityIsBound(request.auth.tenantId, target, canonicalDialDestination))) {
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistCallTarget', resourceId: target.id, metadata: { campaignId: campaign.id, reason: 'target_identity_unbound' } });
      return reply.code(409).send({ status: 'blocked', reason: 'target_identity_unbound' });
    }
    if (target) {
      const identityMatches = (body.phone === undefined || toE164(body.phone) === toE164(target.phone))
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

    if (await isSuppressed(request.auth.tenantId, {
      patientId: target?.patientId ?? null,
      leadId: target?.leadId ?? null,
      destination: canonicalDialDestination,
    }, 'voice')) {
      await audit(request, { action: 'receptionist.call.suppressed', resource: target ? 'receptionistCallTarget' : 'receptionistOutboundCampaign', resourceId: target?.id ?? campaign.id, metadata: { campaignId: campaign.id, reason: 'shared_suppression_gate' } });
      return reply.code(200).send({ status: 'skipped', reason: 'opted_out' });
    }

    // ---- Compliance gate: NEVER dial an opted-out number ------------------
    // Consult ReceptionistOptOut (voice channel; ALL/VOICE suppress it), tenant-
    // scoped. This closes gap (c): outbound targets are queued without a filter,
    // so suppression MUST be enforced here at the dial. Record + skip, no dial.
    if (await isDestinationOptedOut(request.auth.tenantId, canonicalDialDestination, 'voice')) {
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
    // Invalid/missing configuration is a deployment error, never an implicit
    // authorization to dial. A valid active window is a temporary skip and the
    // target remains PENDING for a later retry.
    const quietHoursReason = quietHoursConfigurationReason(
      campaign.quietHoursStart,
      campaign.quietHoursEnd,
      campaign.clinic.timezone,
      true,
    );
    if (quietHoursReason) {
      await audit(request, {
        action: 'receptionist.call.blocked',
        resource: 'receptionistOutboundCampaign',
        resourceId: campaign.id,
        metadata: { reason: quietHoursReason, targetId: body.targetId ?? null },
      });
      return reply.code(409).send({ status: 'blocked', reason: quietHoursReason });
    }
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
      campaignId: campaign.receptionistCampaignId,
      outboundCampaignId: campaign.id,
      targetId: body.targetId,
      callerName: [dialIdentity.firstName, dialIdentity.lastName].filter(Boolean).join(' ') || null,
      callerPhone: canonicalDialDestination,
      direction: 'outbound',
      outcome: 'IN_PROGRESS' as const,
      startedAt: new Date(),
    };
    const reservation = await db.$transaction(async tx => {
          const clientAttemptKey = body.clientAttemptToken
            ? `${request.auth.tenantId}:${campaign.id}:${body.clientAttemptToken}`
            : null;
          const finishClientAttempt = async (resultId: string) => {
            if (!clientAttemptKey) return;
            await tx.idempotencyKey.update({
              where: { scope_key: { scope: CLIENT_LAUNCH_ATTEMPT_SCOPE, key: clientAttemptKey } },
              data: { resultId },
            });
          };
          if (clientAttemptKey) {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-client-attempt:${clientAttemptKey}`}::text, 0))::text AS locked`;
            const attempt = await tx.idempotencyKey.findUnique({
              where: { scope_key: { scope: CLIENT_LAUNCH_ATTEMPT_SCOPE, key: clientAttemptKey } },
              select: { tenantId: true, resultId: true },
            });
            if (!attempt || attempt.tenantId !== request.auth.tenantId || attempt.resultId !== null) {
              return { blocked: 'client_attempt_not_claimable' as const };
            }
            await finishClientAttempt('dispatching');
          }
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-capacity:${request.auth.tenantId}`})::bigint)`;
          let liveAttempt: { scope: string; key: string } | null = null;
          if (liveTest) {
            const scope = liveCallUatScope(liveTest.executionId ?? undefined);
            if (!scope || !body.clientAttemptToken) return { blocked: 'live_test_configuration_invalid' as const };
            const key = `${request.auth.tenantId}:${campaign.id}:${body.clientAttemptToken}`;
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`live-voice-uat:${scope}:${request.auth.tenantId}`}::text, 0))::text AS locked`;
            const existingAttempt = await tx.idempotencyKey.findUnique({
              where: { scope_key: { scope, key } },
              select: { id: true },
            });
            if (existingAttempt) return { blocked: 'live_test_attempt_replayed' as const };
            const priorAttempts = await tx.idempotencyKey.findMany({
              where: { tenantId: request.auth.tenantId, scope },
              select: { resultId: true },
              take: liveTest.maxCalls + 1,
            });
            const priorCallIds = priorAttempts
              .map(attempt => attempt.resultId)
              .filter((value): value is string => Boolean(value && value !== 'dispatching' && !value.startsWith('blocked:')));
            const priorCalls = priorCallIds.length
              ? await tx.receptionistCallLog.findMany({
                where: { tenantId: request.auth.tenantId, id: { in: priorCallIds } },
                select: { durationSeconds: true, endedAt: true, outcome: true },
              })
              : [];
            const admission = evaluateLiveCallAdmission({
              attemptsUsed: priorAttempts.length,
              connectedSeconds: priorCalls.reduce((sum, call) => sum + call.durationSeconds, 0),
              activeCalls: priorCalls.filter(call => !call.endedAt && call.outcome === 'IN_PROGRESS').length,
            }, new Date(), request.auth.tenantId);
            if (!admission.allowed) return { blocked: admission.reason as 'live_test_call_cap_reached' | 'live_test_single_active_call' | 'live_test_minute_cap_reached' | 'live_test_cost_cap_reached' | 'live_test_not_active' };
            liveAttempt = { scope, key };
          }
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
          const activeCallLimit = liveTest ? 1 : MAX_TENANT_ACTIVE_CALLS;
          if (activeCalls >= activeCallLimit) {
            await finishClientAttempt('blocked:concurrency_limit_reached');
            return { blocked: 'concurrency_limit_reached' as const };
          }
          // Included minutes are per billing period; the lifetime counters above
          // are display-only. Enforcing on them meant a clinic's allowance ran
          // out once and never came back.
          const usedMinutes = await periodUsageTotal(tx, request.auth.tenantId, USAGE_METRICS.voiceMinute);
          // Each in-progress call reserves at least one billable minute. This
          // prevents parallel launches from consuming the final minute twice.
          if (!aiUsage.overageAllowed && voiceUsage.limitValue !== null && usedMinutes + activeCalls >= voiceUsage.limitValue) {
            await finishClientAttempt('blocked:voice_minutes_limit_reached');
            return { blocked: 'voice_minutes_limit_reached' as const };
          }
          if (target) {
          const claim = await tx.receptionistCallTarget.updateMany({
            where: {
              id: target.id,
              tenantId: request.auth.tenantId,
              campaignId: campaign.id,
              patientId: target.patientId,
              leadId: target.leadId,
              phone: canonicalDialDestination,
              status: DIALABLE_TARGET_STATUS,
              attempts: { lte: campaign.maxRetryAttempts },
            },
            data: { status: 'CALLING', attempts: { increment: 1 } },
          });
            if (claim.count !== 1) {
              await finishClientAttempt('blocked:target_not_dialable');
              return { blocked: 'target_not_dialable' as const };
            }
          }
          const reservedCall = await tx.receptionistCallLog.create({ data: callLogData });
          if (target) {
            const linkedAttempt = await tx.receptionistCallTarget.updateMany({
              where: {
                id: target.id,
                tenantId: request.auth.tenantId,
                campaignId: campaign.id,
                status: 'CALLING',
              },
              data: { lastCallLogId: reservedCall.id },
            });
            if (linkedAttempt.count !== 1) throw new Error('target_attempt_binding_lost');
          }
          if (liveAttempt) {
            await tx.idempotencyKey.create({
              data: {
                tenantId: request.auth.tenantId,
                scope: liveAttempt.scope,
                key: liveAttempt.key,
                resultId: reservedCall.id,
              },
            });
          }
          await finishClientAttempt(reservedCall.id);
          return { callLog: reservedCall };
        });

    if ('blocked' in reservation && reservation.blocked) {
      const statusCode = ['concurrency_limit_reached', 'live_test_call_cap_reached', 'live_test_single_active_call'].includes(reservation.blocked) ? 429
        : ['voice_minutes_limit_reached', 'live_test_minute_cap_reached', 'live_test_cost_cap_reached'].includes(reservation.blocked) ? 402
          : reservation.blocked === 'live_test_not_active' ? 403
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
    const releaseReservedAttempt = async (lastOutcome: string) => db.$transaction(async tx => {
      const released = await tx.receptionistCallLog.updateMany({
        where: {
          id: callLog.id,
          tenantId: request.auth.tenantId,
          outcome: 'IN_PROGRESS',
          endedAt: null,
          retellCallId: null,
        },
        data: { outcome: 'FAILED', endedAt: new Date() },
      });
      if (released.count === 1 && target) {
        await tx.receptionistCallTarget.updateMany({
          where: {
            id: target.id,
            tenantId: request.auth.tenantId,
            campaignId: campaign.id,
            status: 'CALLING',
            attempts: { gt: 0 },
          },
          data: { status: 'PENDING', attempts: { decrement: 1 }, lastOutcome, lastCallLogId: callLog.id },
        });
      }
      return released.count === 1;
    });

    // Re-check immediately before the irreversible provider boundary. This
    // closes the window where an operator stops outbound or pauses a campaign
    // while preflight work is in progress.
    const [stoppedAtBoundary, currentCampaign, currentTarget] = await Promise.all([
      outboundStopped(request.auth.tenantId),
      db.receptionistOutboundCampaign.findFirst({
        where: { id: campaign.id, tenantId: request.auth.tenantId },
        include: { agent: true, receptionistCampaign: true },
      }),
      target ? db.receptionistCallTarget.findFirst({ where: { id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id } }) : null,
    ]);
    let boundaryAuthorityReason: string | null = null;
    if (currentCampaign) {
      const frozenAuthorityMatches = currentCampaign.receptionistCampaignId === campaign.receptionistCampaignId
        && currentCampaign.agentId === campaign.agentId
        && currentCampaign.bookingMode === campaign.bookingMode
        && currentCampaign.defaultBranchId === campaign.defaultBranchId
        && currentCampaign.defaultService === campaign.defaultService
        && currentCampaign.policyVersion === campaign.policyVersion
        && currentCampaign.authorityApprovedAt?.getTime() === campaign.authorityApprovedAt?.getTime()
        && currentCampaign.authorityApprovedById === campaign.authorityApprovedById;
      if (!frozenAuthorityMatches) boundaryAuthorityReason = 'campaign_authority_changed';
      else {
        const currentAuthorityFingerprint = outboundAuthorityFingerprint(currentCampaign);
        if (currentCampaign.authorityFingerprint !== currentAuthorityFingerprint) boundaryAuthorityReason = 'campaign_authority_fingerprint_changed';
      }
      if (!boundaryAuthorityReason) {
        try {
          await runWithTenantContext(request.auth.tenantId, tx => validateOutboundAssignments(tx, {
            tenantId: request.auth.tenantId,
            clinicId: currentCampaign.clinicId,
            agentId: currentCampaign.agentId,
            branchId: currentCampaign.defaultBranchId,
            bookingMode: currentCampaign.bookingMode,
            receptionistCampaignId: currentCampaign.receptionistCampaignId,
            defaultService: currentCampaign.defaultService,
            purpose: currentCampaign.purpose,
            legalBasis: currentCampaign.legalBasis,
            policyVersion: currentCampaign.policyVersion,
            quietHoursStart: currentCampaign.quietHoursStart,
            quietHoursEnd: currentCampaign.quietHoursEnd,
            requireReady: true,
          }));
        } catch (error) {
          boundaryAuthorityReason = outboundAssignmentReason(error) ?? 'campaign_authority_invalid';
        }
      }
    }
    if (!boundaryAuthorityReason && target && (!currentTarget
      || currentTarget.patientId !== target.patientId
      || currentTarget.leadId !== target.leadId
      || currentTarget.phone !== canonicalDialDestination
      || currentTarget.status !== 'CALLING')) boundaryAuthorityReason = 'target_identity_changed';
    if (!boundaryAuthorityReason && currentTarget && !(await targetIdentityIsBound(request.auth.tenantId, currentTarget, canonicalDialDestination))) {
      boundaryAuthorityReason = 'target_identity_unbound';
    }
    if (!boundaryAuthorityReason && await isSuppressed(request.auth.tenantId, {
      patientId: currentTarget?.patientId ?? null,
      leadId: currentTarget?.leadId ?? null,
      destination: canonicalDialDestination,
    }, 'voice')) boundaryAuthorityReason = 'shared_suppression_gate';
    if (stoppedAtBoundary || currentCampaign?.status !== RUNNABLE_CAMPAIGN_STATUS || boundaryAuthorityReason) {
      await releaseReservedAttempt('BLOCKED');
      const reason = stoppedAtBoundary ? 'outbound_stopped'
        : currentCampaign?.status !== RUNNABLE_CAMPAIGN_STATUS ? 'campaign_not_running'
          : boundaryAuthorityReason!;
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, reason: `${reason}_pre_provider` } });
      if (stoppedAtBoundary) return reply.code(423).send({ status: 'blocked', reason, callLogId: callLog.id });
      return reply.code(409).send({ status: 'blocked', reason, callLogId: callLog.id });
    }

    await providerBoundaryTestHook?.('before_suppression_fence');
    const providerIntentId = randomUUID();
    const providerCorrelation = issueProviderIntentCorrelation({
      tenantId: request.auth.tenantId,
      intentId: providerIntentId,
      callLogId: callLog.id,
      outboundCampaignId: campaign.id,
      targetId: target?.id ?? null,
      purpose: campaign.purpose!,
      policyVersion: campaign.policyVersion!,
    });
    const providerIntentAttempt = await db.$transaction(async tx => {
      // Canonical multi-domain lock order is configuration then suppression.
      // Studio pause/configuration writes take the same configuration lock, so
      // either their mutation commits first and this launch observes it, or the
      // provider intent commits first and the mutation is ordered afterward.
      await lockOutboundConfiguration(tx, request.auth.tenantId);
      const finalUsage = await tx.tenantAiUsage.findUnique({ where: { tenantId: request.auth.tenantId }, select: { killSwitch: true } });
      const finalCampaign = await tx.receptionistOutboundCampaign.findFirst({
          where: { id: campaign.id, tenantId: request.auth.tenantId },
          include: { agent: true, receptionistCampaign: true, clinic: { select: { timezone: true } } },
        });
      const finalTarget = target
        ? await tx.receptionistCallTarget.findFirst({ where: { id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id } })
        : null;
      if (finalUsage?.killSwitch) return { blocked: 'outbound_stopped' as const };
      if (!finalCampaign || finalCampaign.status !== RUNNABLE_CAMPAIGN_STATUS) return { blocked: 'campaign_not_running' as const };
      if (!finalCampaign.authorityApprovedAt || !finalCampaign.authorityApprovedById
        || finalCampaign.authorityFingerprint !== outboundAuthorityFingerprint(finalCampaign)) {
        return { blocked: 'outbound_authority_unapproved' as const };
      }
      const finalAuthorityMatches = finalCampaign.receptionistCampaignId === campaign.receptionistCampaignId
        && finalCampaign.agentId === campaign.agentId
        && finalCampaign.bookingMode === campaign.bookingMode
        && finalCampaign.defaultBranchId === campaign.defaultBranchId
        && finalCampaign.defaultService === campaign.defaultService
        && finalCampaign.policyVersion === campaign.policyVersion
        && finalCampaign.authorityApprovedAt?.getTime() === campaign.authorityApprovedAt?.getTime()
        && finalCampaign.authorityApprovedById === campaign.authorityApprovedById;
      if (!finalAuthorityMatches) return { blocked: 'campaign_authority_changed' as const };
      try {
        await validateOutboundAssignments(tx, {
          tenantId: request.auth.tenantId,
          clinicId: finalCampaign.clinicId,
          agentId: finalCampaign.agentId,
          branchId: finalCampaign.defaultBranchId,
          bookingMode: finalCampaign.bookingMode,
          receptionistCampaignId: finalCampaign.receptionistCampaignId,
          defaultService: finalCampaign.defaultService,
          purpose: finalCampaign.purpose,
          legalBasis: finalCampaign.legalBasis,
          policyVersion: finalCampaign.policyVersion,
          quietHoursStart: finalCampaign.quietHoursStart,
          quietHoursEnd: finalCampaign.quietHoursEnd,
          requireReady: true,
        });
      } catch (error) {
        return { blocked: (outboundAssignmentReason(error) ?? 'campaign_authority_invalid') as string };
      }
      const finalQuietHoursReason = quietHoursConfigurationReason(
        finalCampaign.quietHoursStart,
        finalCampaign.quietHoursEnd,
        finalCampaign.clinic.timezone,
        true,
      );
      if (finalQuietHoursReason) return { blocked: finalQuietHoursReason };
      if (isWithinQuietHours(finalCampaign.quietHoursStart, finalCampaign.quietHoursEnd, finalCampaign.clinic.timezone)) {
        return { blocked: 'quiet_hours' as const };
      }
      if (target && (!finalTarget
        || finalTarget.patientId !== target.patientId
        || finalTarget.leadId !== target.leadId
        || finalTarget.phone !== canonicalDialDestination
        || finalTarget.status !== 'CALLING')) return { blocked: 'target_identity_changed' as const };

      const durableIntent = await authorizeOutboundProviderIntentTx(tx, {
        id: providerIntentId,
        correlationNonceHash: providerCorrelation.nonceHash,
        tenantId: request.auth.tenantId,
        callLogId: callLog.id,
        outboundCampaignId: finalCampaign.id,
        targetId: finalTarget?.id,
        destination: canonicalDialDestination,
        purpose: finalCampaign.purpose as (typeof OUTBOUND_PURPOSES)[number],
        policyVersion: finalCampaign.policyVersion!,
        legalBasis: finalCampaign.legalBasis as (typeof OUTBOUND_LEGAL_BASES)[number],
      });
      await providerBoundaryTestHook?.('suppression_fence_acquired');

      const linearizedAt = new Date();
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionist.outbound.providerIntent.authorized', resource: 'receptionistCallLog', resourceId: callLog.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], occurredAt: linearizedAt,
        metadata: { campaignId: campaign.id, targetId: body.targetId ?? null, providerIntentId: durableIntent.id, suppressionFence: 'held_at_commit' },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId, eventType: 'receptionist.outbound.provider_intent_authorized',
        entityType: 'receptionistCallLog', entityId: callLog.id, sourceModule: 'receptionist', occurredAt: linearizedAt,
        payload: { campaignId: campaign.id, targetId: body.targetId ?? null, providerIntentId: durableIntent.id, suppressionFence: 'held_at_commit' },
      } });
      return { campaign: finalCampaign, providerIntentId: durableIntent.id };
    }).then(value => ({ ok: true as const, value })).catch(error => ({ ok: false as const, error }));

    if (!providerIntentAttempt.ok) {
      const blockedReason = providerIntentBlockReason(providerIntentAttempt.error);
      await releaseReservedAttempt(blockedReason ? 'BLOCKED' : 'PROVIDER_INTENT_EVIDENCE_FAILED');
      // An expected compliance rejection is not an observability outage. An
      // unexpected mandatory evidence failure is degraded even when the
      // separate cleanup audit succeeds.
      const trackingDegraded = blockedReason === null;
      let cleanupAuditRecorded = false;
      try {
        await audit(request, {
          action: 'receptionist.call.blocked',
          resource: 'receptionistCallLog',
          resourceId: callLog.id,
          metadata: { campaignId: campaign.id, reason: blockedReason ?? 'provider_intent_evidence_failed' },
        });
        cleanupAuditRecorded = true;
      } catch {
        // The false initializer is the truthful cleanup-audit result.
      }
      if (blockedReason) {
        request.log.warn({ callLogId: callLog.id, campaignId: campaign.id, reason: blockedReason }, 'Outbound provider intent blocked before provider submission');
      } else {
        request.log.error({
          err: providerIntentAttempt.error,
          callLogId: callLog.id,
          campaignId: campaign.id,
        }, 'Outbound provider intent evidence failed before provider submission');
      }
      return reply.code(blockedReason ? 409 : 503).send({
        status: 'blocked',
        reason: blockedReason ?? 'provider_intent_evidence_failed',
        callLogId: callLog.id,
        trackingDegraded,
        cleanupAuditRecorded,
      });
    }
    const providerIntent = providerIntentAttempt.value;

    if ('blocked' in providerIntent) {
      await releaseReservedAttempt('BLOCKED');
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, reason: `${providerIntent.blocked}_at_provider_intent` } });
      const code = providerIntent.blocked === 'outbound_stopped' ? 423 : 409;
      return reply.code(code).send({ status: 'blocked', reason: providerIntent.blocked, callLogId: callLog.id });
    }

    // The committed intent is the linearization point. Any opt-out that held a
    // matching fence first prevented this commit; a later opt-out is ordered
    // after this already-authorized call and suppresses every future attempt.
    await providerBoundaryTestHook?.('provider_intent_committed');
    const authorizedCampaign = providerIntent.campaign;
    const [intentCall, stoppedAfterIntent, campaignAfterIntent] = await Promise.all([
      db.receptionistCallLog.findFirst({ where: { id: callLog.id, tenantId: request.auth.tenantId }, select: { outcome: true, endedAt: true } }),
      outboundStopped(request.auth.tenantId),
      db.receptionistOutboundCampaign.findFirst({ where: { id: campaign.id, tenantId: request.auth.tenantId }, select: { status: true } }),
    ]);
    if (!intentCall || intentCall.outcome !== 'IN_PROGRESS' || intentCall.endedAt || stoppedAfterIntent || campaignAfterIntent?.status !== RUNNABLE_CAMPAIGN_STATUS) {
      const released = await releaseReservedAttempt('PROVIDER_INTENT_CANCELLED');
      let trackingDegraded = false;
      try {
        await audit(request, {
          action: 'receptionist.call.cancelledBeforeProvider', resource: 'receptionistCallLog', resourceId: callLog.id,
          metadata: { campaignId: campaign.id, reason: stoppedAfterIntent ? 'outbound_stopped_after_intent' : 'provider_intent_cancelled', released },
        });
      } catch {
        trackingDegraded = true;
      }
      return reply.code(423).send({
        status: 'cancelled',
        reason: stoppedAfterIntent ? 'outbound_stopped' : 'provider_intent_cancelled',
        callLogId: callLog.id,
        trackingDegraded,
      });
    }
    // A campaign with no linked agent has no name to introduce itself with.
    // Substituting one would put a fabricated identity on a real call, so the
    // dial is refused instead (readiness already blocks this earlier).
    if (!campaign.agent?.name) {
      await releaseReservedAttempt('AGENT_REQUIRED');
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'agent_required' } });
      return reply.code(409).send({ status: 'blocked', reason: 'agent_required', callLogId: callLog.id });
    }

    // Call-time truth for the hours and emergency variables: what the agent
    // says about "are you open" must be resolved now, not at export time.
    const dialBundle = await loadHoursSource(db, { tenantId: request.auth.tenantId, clinicId: campaign.clinic.id });
    const dialPack = await resolveLocalePackWithFallback(db, {
      tenantId: request.auth.tenantId,
      language: campaign.agent.language ?? campaign.clinic.defaultLanguage,
      country: campaign.clinic.country,
    });
    const dialLocale = resolvedLocaleFormat(dialPack, campaign.clinic.defaultLanguage);
    const dialStatus = dialBundle ? hoursStatus(dialBundle.source, new Date(), dialLocale) : null;

    const result = await createPhoneCall({
      toNumber: canonicalDialDestination,
      agentId: authorizedCampaign.agent!.providerAgentId!,
      agentVersion: authorizedCampaign.agent!.providerVersion!,
      webhookUrl: `${env.PUBLIC_API_URL}/v1/receptionist/webhooks/retell?clinicId=${campaign.clinicId}&campaignId=${campaign.receptionistCampaignId ?? ''}`,
      dynamicVariables: {
        ...buildHoursDynamicVariables({ status: dialStatus, strings: dialPack?.strings ?? null }),
        clinic_name: campaign.clinic.name,
        agent_name: campaign.agent.name,
        disclosure: liveTest
          ? liveCallUatDisclosure(campaign.clinic.complianceDisclosure)
          : campaign.clinic.complianceDisclosure ?? '',
        live_test_disclosure: liveTest ? liveCallUatDisclosure(null) : '',
        consent_text: campaign.consentText ?? '',
        human_handoff: campaign.humanHandoffInstruction ?? '',
        script: campaign.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'
          ? authorizedCampaign.receptionistCampaign!.offerScript
          : campaign.script,
        required_fields: campaign.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'
          ? ''
          : campaign.requiredFields.join(', '),
        first_name: dialIdentity.firstName ?? '',
        booking_mode: campaign.bookingMode,
        appointment_type: campaign.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'
          ? authorizedCampaign.receptionistCampaign!.appointmentType
          : campaign.defaultService ?? '',
      },
      metadata: {
        tenantId: request.auth.tenantId, outboundCampaignId: campaign.id,
        receptionistCampaignId: campaign.receptionistCampaignId,
        callLogId: callLog.id, targetId: body.targetId ?? null,
        ...(liveTest ? { liveTestExecutionId: liveTest.executionId } : {}),
        ...providerIntentMetadataForRetell(providerCorrelation),
      },
      ...(liveTest ? { maxCallDurationMs: liveTest.maxCallMinutes * 60_000 } : {}),
      // No verified prior recording consent is attached to this launch. Retell
      // must retain metadata only; an in-call grant cannot upgrade this setting.
      dataStorageSetting: 'basic_attributes_only',
    });
    await providerBoundaryTestHook?.('before_call_stopping_evaluation');

    const cancelAcceptedCall = async (providerCallId: string) => {
      const providerStop = await stopPhoneCall(providerCallId);
      const providerStopApplied = providerStop.ok && providerStop.applied;
      // Primary safety state is isolated from review/audit dependencies. Once
      // provider acceptance is known, the call id and non-dialable terminal
      // state must survive even if every observability table is unavailable.
      const primaryState = await db.$transaction(async tx => {
        await lockOutboundDispatch(tx, request.auth.tenantId);
        const existing = await tx.receptionistCallLog.findFirstOrThrow({
          where: { id: callLog.id, tenantId: request.auth.tenantId }, select: { outcome: true, endedAt: true, retellCallId: true },
        });
        const durableTargetStop = target
          ? await tx.receptionistCallTarget.findFirst({
            where: {
              id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id,
              status: 'FAILED', lastOutcome: 'OUTBOUND_STOPPED', lastCallLogId: callLog.id,
            },
            select: { id: true },
          })
          : null;
      const alreadyConfirmed = existing.outcome === 'FAILED'
          && existing.endedAt !== null
          && existing.retellCallId === providerCallId
          && durableTargetStop !== null;
        const effectiveProviderStopApplied = providerStopApplied || alreadyConfirmed;
        const conflictingRetellCall = existing.retellCallId === null
          ? await tx.receptionistCallLog.findFirst({
            where: { tenantId: request.auth.tenantId, retellCallId: providerCallId },
            select: { id: true },
          })
          : null;
        const nextOutcome = existing.outcome === 'IN_PROGRESS'
          ? (effectiveProviderStopApplied ? 'FAILED' as const : 'ESCALATED' as const)
          : existing.outcome === 'FAILED' && !effectiveProviderStopApplied && existing.retellCallId === null
            ? 'ESCALATED' as const
            : existing.outcome;
        const nextRetellCallId = existing.retellCallId === null && conflictingRetellCall === null
          ? providerCallId
          : existing.retellCallId;
        if (effectiveProviderStopApplied && target && nextRetellCallId === providerCallId) {
          if (existing.retellCallId === null) {
            await tx.receptionistCallLog.updateMany({
              where: {
                id: callLog.id, tenantId: request.auth.tenantId,
                outboundCampaignId: campaign.id, targetId: target.id,
                retellCallId: null, outcome: { in: ['IN_PROGRESS', 'ESCALATED', 'FAILED'] },
              },
              data: { retellCallId: providerCallId },
            });
          }
          await applyConfirmedProviderStopTx(tx, {
            tenantId: request.auth.tenantId,
            campaignId: campaign.id,
            targetId: target.id,
            callLogId: callLog.id,
            providerCallId,
          }, request);
        } else {
          await tx.receptionistCallLog.update({
            where: { id: callLog.id },
            data: { retellCallId: nextRetellCallId, outcome: nextOutcome, endedAt: existing.endedAt ?? new Date() },
          });
          if (target) await tx.receptionistCallTarget.updateMany({
            where: {
              id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id,
              lastCallLogId: callLog.id,
              OR: [
                { status: 'CALLING' },
                { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED' },
              ],
            },
            data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: callLog.id },
          });
        }
        return { effectiveProviderStopApplied };
      });

      const { effectiveProviderStopApplied } = primaryState;

      let signalId: string | null = null;
      let reviewTaskId: string | null = null;
      if (!effectiveProviderStopApplied) {
        try {
          const signal = await runWithTenantContext(request.auth.tenantId, async tx => {
            await lockOutboundDispatch(tx, request.auth.tenantId);
            const stillUncertain = target
              ? await tx.receptionistCallTarget.findFirst({
                where: {
                  id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id,
                  lastCallLogId: callLog.id, status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
                },
                select: { id: true },
              })
              : null;
            if (!stillUncertain) return null;
            return tx.operationalSignal.upsert({
              where: { tenantId_signalType_entityType_entityId: {
                tenantId: request.auth.tenantId,
                signalType: 'receptionist_outbound_stop_unconfirmed_after_acceptance',
                entityType: 'receptionistCallLog', entityId: callLog.id,
              } },
              update: { severity: 'critical', score: 100, status: 'open', reason: 'Provider accepted an outbound call after a stop request, but provider cancellation was not confirmed.' },
              create: {
                tenantId: request.auth.tenantId,
                signalType: 'receptionist_outbound_stop_unconfirmed_after_acceptance',
                entityType: 'receptionistCallLog', entityId: callLog.id,
                severity: 'critical', score: 100,
                reason: 'Provider accepted an outbound call after a stop request, but provider cancellation was not confirmed.',
              },
            });
          });
          signalId = signal?.id ?? null;
        } catch {
          signalId = null;
        }
        try {
          const task = await runWithTenantContext(request.auth.tenantId, async tx => {
            await lockOutboundDispatch(tx, request.auth.tenantId);
            const stillUncertain = target
              ? await tx.receptionistCallTarget.findFirst({
                where: {
                  id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id,
                  lastCallLogId: callLog.id, status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
                },
                select: { id: true },
              })
              : null;
            if (!stillUncertain) return null;
            const existingTask = await tx.staffTask.findFirst({
              where: { tenantId: request.auth.tenantId, metadata: { path: ['callLogId'], equals: callLog.id } },
              select: { id: true },
            });
            return existingTask ?? tx.staffTask.create({ data: {
              tenantId: request.auth.tenantId, branchId: campaign.defaultBranchId,
              title: 'Urgent: reconcile outbound call accepted after stop', priority: 'CRITICAL',
              metadata: {
                workflow: 'receptionist_outbound_stop_reconciliation', callLogId: callLog.id,
                providerCallId, providerStopApplied: false,
                providerStopError: providerStop.ok ? 'provider_stop_unconfirmed' : providerStop.error,
              },
            } });
          });
          reviewTaskId = task?.id ?? null;
        } catch {
          reviewTaskId = null;
        }
      }

      const auditRecorded = await (async () => {
        try {
        await runWithTenantContext(request.auth.tenantId, tx => tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
          action: effectiveProviderStopApplied ? 'receptionist.call.cancelledAfterProviderAcceptance' : 'receptionist.call.reconciliationRequiredAfterProviderAcceptance',
          resource: 'receptionistCallLog', resourceId: callLog.id,
          requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
          metadata: { campaignId: campaign.id, providerStopApplied: effectiveProviderStopApplied, reviewTaskId, signalId },
        } }));
          return true;
        } catch {
          return false;
        }
      })();
      const businessEventRecorded = await (async () => {
        try {
        await runWithTenantContext(request.auth.tenantId, tx => tx.businessEvent.create({ data: {
          tenantId: request.auth.tenantId,
          eventType: effectiveProviderStopApplied ? 'receptionist.outbound.accepted_call_cancelled' : 'receptionist.outbound.accepted_call_reconciliation_required',
          entityType: 'receptionistCallLog', entityId: callLog.id, sourceModule: 'receptionist',
          payload: { campaignId: campaign.id, providerStopApplied: effectiveProviderStopApplied, reviewTaskId, signalId },
        } }));
          return true;
        } catch {
          return false;
        }
      })();
      if (effectiveProviderStopApplied) {
        return reply.code(200).send({
          status: 'cancelled', reason: 'outbound_stopped', callLogId: callLog.id, callId: providerCallId,
          providerStopApplied: true, auditRecorded, businessEventRecorded,
        });
      }
      return reply.code(202).send({
        status: 'reconciliation_required', reason: 'outbound_stopped', callLogId: callLog.id,
        callId: providerCallId, providerStopApplied: false, error: providerStop.ok ? 'provider_stop_unconfirmed' : providerStop.error,
        reviewRecorded: reviewTaskId !== null, signalRecorded: signalId !== null,
        reviewTaskId, signalId, auditRecorded, businessEventRecorded,
      });
    };

    if (result.ok) {
      const [callAfterProvider, stoppedDuringProvider] = await Promise.all([
        db.receptionistCallLog.findFirst({ where: { id: callLog.id, tenantId: request.auth.tenantId }, select: { outcome: true, endedAt: true } }),
        outboundStopped(request.auth.tenantId),
      ]);
      if (!callAfterProvider || callAfterProvider.outcome !== 'IN_PROGRESS' || callAfterProvider.endedAt || stoppedDuringProvider) {
        return await cancelAcceptedCall(result.callId);
      }
    }

    if (!result.ok) {
      const acceptanceUnknown = result.acceptance === 'unknown';
      // Safety state is committed independently from review/audit plumbing.
      // A broken task/signal/audit dependency must never roll a mismatched
      // deployment back to VERIFIED or make its campaigns runnable again.
      const safetyState = await runWithTenantContext(request.auth.tenantId, async tx => {
        // Deployment safety mutations share the same canonical configuration
        // lock as Studio/outbound edits and provider-intent authorization. A
        // concurrent re-verification or campaign activation must therefore be
        // ordered either before this circuit trip (and then be invalidated) or
        // after it (and observe INVALID/PAUSED state).
        if (result.error === 'retell_deployment_mismatch') {
          await lockOutboundConfiguration(tx, request.auth.tenantId);
        }
        await tx.receptionistCallLog.update({
          where: { id: callLog.id },
          data: { outcome: acceptanceUnknown ? 'ESCALATED' : 'FAILED', endedAt: new Date(), ...(result.callId ? { retellCallId: result.callId } : {}) },
        });
        if (body.targetId) {
          await tx.receptionistCallTarget.updateMany({
            where: { id: body.targetId, tenantId: request.auth.tenantId, campaignId: campaign.id, status: 'CALLING' },
            data: {
              status: acceptanceUnknown ? 'FAILED' : (targetStatusAfterOutcome('FAILED', (target?.attempts ?? 0) + 1, campaign.maxRetryAttempts) ?? 'FAILED'),
              lastOutcome: acceptanceUnknown ? 'RECONCILIATION_REQUIRED' : 'FAILED', lastCallLogId: callLog.id,
            },
          });
        }
        if (result.error === 'retell_deployment_mismatch') {
          const trippedAt = new Date();
          const agentId = currentCampaign!.agent!.id;
          await tx.receptionistAgent.updateMany({
            where: { id: agentId, tenantId: request.auth.tenantId },
            data: {
              providerStatus: 'INVALID',
              providerVerifiedRevision: null,
              providerVerifiedAt: null,
              providerVerificationExpiresAt: null,
              providerLastAttemptAt: trippedAt,
              providerLastAttemptStatus: 'FAILED',
              providerLastErrorCode: 'provider_deployment_mismatch',
            },
          });
          const [pausedOutbound, pausedStudio] = await Promise.all([
            tx.receptionistOutboundCampaign.updateMany({
              where: { tenantId: request.auth.tenantId, agentId, status: { in: ['SCHEDULED', 'RUNNING'] } },
              data: { status: 'PAUSED' },
            }),
            tx.receptionistCampaign.updateMany({
              where: { tenantId: request.auth.tenantId, agentId, status: 'ACTIVE' },
              data: { status: 'PAUSED' },
            }),
          ]);
          return { agentId, pausedOutboundCampaigns: pausedOutbound.count, pausedStudioCampaigns: pausedStudio.count };
        }
        return { agentId: null, pausedOutboundCampaigns: 0, pausedStudioCampaigns: 0 };
      });

      let reviewTaskId: string | null = null;
      let reviewRecorded = false;
      let signalId: string | null = null;
      if (acceptanceUnknown) {
        try {
          signalId = await runWithTenantContext(request.auth.tenantId, async tx => {
            const signal = await tx.operationalSignal.create({ data: {
              tenantId: request.auth.tenantId,
              signalType: 'receptionist_outbound_provider_acceptance_unknown',
              entityType: 'receptionistCallLog', entityId: callLog.id,
              severity: 'critical', score: 100,
              reason: 'The outbound provider may have accepted a call, so automatic retry is disabled pending reconciliation.',
            } });
            const task = await tx.staffTask.create({ data: {
              tenantId: request.auth.tenantId, branchId: campaign.defaultBranchId,
              title: 'Reconcile outbound call with provider before any retry', priority: 'CRITICAL',
              metadata: { workflow: 'receptionist_outbound_reconciliation', callLogId: callLog.id, providerCallId: result.callId ?? null, errorCode: result.error },
            } });
            reviewTaskId = task.id;
            return signal.id;
          });
          reviewRecorded = true;
        } catch {
          // ESCALATED/non-dialable state remains the primary fail-safe.
        }
      }
      if (!acceptanceUnknown && result.error === 'retell_deployment_mismatch' && safetyState.agentId) {
        // Operational review records are deliberately outside the core safety
        // transaction. Their failure is reported truthfully but can never
        // restore the invalid deployment or paused campaigns.
        try {
          signalId = await runWithTenantContext(request.auth.tenantId, async tx => {
            const signal = await tx.operationalSignal.create({
              data: {
                tenantId: request.auth.tenantId,
                signalType: 'receptionist_provider_deployment_mismatch',
                entityType: 'receptionistCallLog',
                entityId: callLog.id,
                severity: 'critical',
                score: 100,
                reason: 'Provider started a call with an agent deployment different from the verified immutable binding; campaigns were paused for staff review.',
              },
            });
            return signal.id;
          });
        } catch {
          signalId = null;
        }
        const taskData = (reviewPersistenceDegraded: boolean) => ({
          tenantId: request.auth.tenantId,
          branchId: campaign.defaultBranchId,
          title: 'Critical: review AI receptionist provider deployment mismatch',
          priority: 'CRITICAL',
          metadata: {
            workflow: 'receptionist_provider_deployment_review',
            requiresAcknowledgement: true,
            agentId: safetyState.agentId,
            campaignId: campaign.id,
            callLogId: callLog.id,
            providerStopApplied: result.providerStopApplied ?? false,
            providerStopFailed: Boolean(result.providerStopError),
            reviewPersistenceDegraded,
            signalPersistencePending: signalId === null,
          },
        });
        try {
          reviewTaskId = await runWithTenantContext(request.auth.tenantId, async tx => {
            const task = await tx.staffTask.create({ data: taskData(false) });
            await auditOutboundMutation(tx, request, {
              action: 'receptionist.agentDeploymentSafetyCircuitTripped',
              resource: 'staffTask',
              resourceId: task.id,
              metadata: {
                agentId: safetyState.agentId,
                callLogId: callLog.id,
                pausedOutboundCampaigns: safetyState.pausedOutboundCampaigns,
                pausedStudioCampaigns: safetyState.pausedStudioCampaigns,
                providerStopApplied: result.providerStopApplied ?? false,
                providerStopError: result.providerStopError ?? null,
              },
            });
            await auditOutboundMutation(tx, request, {
              action: 'receptionist.call.providerDeploymentMismatch',
              resource: 'receptionistCallLog',
              resourceId: callLog.id,
              metadata: {
                error: result.error,
                operationalReviewRequired: true,
                providerStopApplied: result.providerStopApplied ?? false,
                providerStopError: result.providerStopError ?? null,
              },
            });
            return task.id;
          });
          reviewRecorded = true;
        } catch {
          // Best-effort degraded task: if signal/audit persistence is the
          // failing dependency, staff still receives a truthful review item.
          // If task persistence itself is down, durable INVALID/PAUSED state
          // and providerLastErrorCode remain the fail-closed retry evidence.
          try {
            const fallback = await runWithTenantContext(request.auth.tenantId, tx => tx.staffTask.create({ data: taskData(true) }));
            reviewTaskId = fallback.id;
            reviewRecorded = true;
          } catch {
            reviewTaskId = null;
          }
        }
      } else if (!acceptanceUnknown) {
        try {
          await runWithTenantContext(request.auth.tenantId, tx => auditOutboundMutation(tx, request, {
            action: 'receptionist.call.failed',
            resource: 'receptionistCallLog',
            resourceId: callLog.id,
            metadata: { error: result.error },
          }));
        } catch {
          // The FAILED call state is already durable and must not be rolled back
          // because the secondary audit dependency is unavailable.
        }
      }
      return reply.code(acceptanceUnknown ? 202 : 502).send({
        status: acceptanceUnknown ? 'reconciliation_required' : 'failed',
        error: result.error,
        callLogId: callLog.id,
        reviewTaskId,
        reviewRecorded,
        signalRecorded: signalId !== null,
        signalId,
      });
    }

    try {
      await providerBoundaryTestHook?.('before_provider_binding_lock');
      const binding = await db.$transaction(async tx => {
        await lockOutboundDispatch(tx, request.auth.tenantId);
        const usage = await tx.tenantAiUsage.findUnique({ where: { tenantId: request.auth.tenantId }, select: { killSwitch: true } });
        const latestCampaign = await tx.receptionistOutboundCampaign.findFirst({ where: { id: campaign.id, tenantId: request.auth.tenantId }, select: { status: true } });
        const latestCall = await tx.receptionistCallLog.findFirst({
          where: { id: callLog.id, tenantId: request.auth.tenantId },
          select: { outcome: true, endedAt: true, retellCallId: true },
        });
        if (usage?.killSwitch || latestCampaign?.status !== RUNNABLE_CAMPAIGN_STATUS
          || !latestCall || latestCall.outcome !== 'IN_PROGRESS' || latestCall.endedAt) {
          return { cancelled: true as const };
        }
        // A signed provider callback may recover and bind the exact call while
        // this request is resuming after provider acceptance. Treat that as
        // the same successful linearized binding; a different id is never
        // interchangeable and falls into the fail-closed reconciliation path.
        if (latestCall.retellCallId === result.callId) {
          return { cancelled: false as const, bound: 1, recoveredByCallback: true as const };
        }
        if (latestCall.retellCallId !== null) throw new Error('provider_call_binding_collision');
        const collidingRetellCall = await tx.receptionistCallLog.findFirst({
          where: { tenantId: request.auth.tenantId, retellCallId: result.callId },
          select: { id: true },
        });
        if (collidingRetellCall !== null) {
          const endedAt = new Date();
          await tx.receptionistCallLog.update({
            where: { id: callLog.id },
            data: { outcome: 'ESCALATED', endedAt },
          });
          if (target) await tx.receptionistCallTarget.updateMany({
            where: { id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id },
            data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: callLog.id },
          });
          await tx.auditEvent.create({ data: {
            tenantId: request.auth.tenantId,
            actorUserId: request.auth.userId,
            action: 'receptionist.call.providerIdCollision',
            resource: 'receptionistCallLog',
            resourceId: callLog.id,
            metadata: { reusedRetellCallId: collidingRetellCall.id, providerStopRequired: true },
          } });
          return { cancelled: false as const, bound: 0, reusedRetellCallId: collidingRetellCall.id, collision: true as const };
        }
        const bound = await tx.receptionistCallLog.updateMany({
          where: { id: callLog.id, tenantId: request.auth.tenantId, retellCallId: null, outcome: 'IN_PROGRESS', endedAt: null },
          data: { retellCallId: result.callId },
        });
        return { cancelled: false as const, bound: bound.count, collision: false as const, reusedRetellCallId: null };
      });
      if (binding.cancelled) return await cancelAcceptedCall(result.callId);
      if (binding.bound !== 1 && !binding.collision) throw new Error('provider_call_binding_lost');
      if (binding.collision) {
        if (binding.reusedRetellCallId) {
          request.log.warn({
            callLogId: callLog.id, providerCallId: result.callId, reusedRetellCallId: binding.reusedRetellCallId, tenantId: request.auth.tenantId,
          }, 'Provider call ID collision encountered while binding outbound call intent');
        } else {
          request.log.warn({
            callLogId: callLog.id, providerCallId: result.callId, tenantId: request.auth.tenantId,
          }, 'Provider call binding collision encountered while binding outbound call intent');
        }
        throw new Error('provider_call_id_collision');
      }
      await providerBoundaryTestHook?.('provider_binding_committed');
      if (await outboundStopped(request.auth.tenantId)) {
        const stoppedCall = await db.receptionistCallLog.findFirst({
          where: { id: callLog.id, tenantId: request.auth.tenantId }, select: { outcome: true, endedAt: true },
        });
        if (stoppedCall?.outcome === 'FAILED' && stoppedCall.endedAt) {
          return reply.code(200).send({ status: 'cancelled', reason: 'outbound_stopped', callLogId: callLog.id, callId: result.callId, providerStopApplied: true });
        }
        return await cancelAcceptedCall(result.callId);
      }
    } catch {
      const stopped = await stopPhoneCall(result.callId).catch(() => ({ ok: false, applied: false, error: 'provider_stop_failed' as const }));
      await db.$transaction(async tx => {
        await lockOutboundDispatch(tx, request.auth.tenantId);
        const exactBoundCall = target ? await tx.receptionistCallLog.findFirst({
          where: {
            id: callLog.id, tenantId: request.auth.tenantId, outboundCampaignId: campaign.id,
            targetId: target.id, retellCallId: result.callId,
          },
          select: { id: true },
        }) : null;
        if (stopped.ok && stopped.applied && target && exactBoundCall) {
          await applyConfirmedProviderStopTx(tx, {
            tenantId: request.auth.tenantId,
            campaignId: campaign.id,
            targetId: target.id,
            callLogId: callLog.id,
            providerCallId: result.callId,
          }, request);
          return;
        }
        const confirmedTarget = target ? await tx.receptionistCallTarget.findFirst({
          where: {
            id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id,
            lastCallLogId: callLog.id, status: 'FAILED', lastOutcome: 'OUTBOUND_STOPPED',
          },
          select: { id: true },
        }) : null;
        if (confirmedTarget) return;
        await tx.receptionistCallLog.updateMany({
          where: {
            id: callLog.id, tenantId: request.auth.tenantId,
            outboundCampaignId: campaign.id, targetId: target?.id,
            outcome: { in: ['IN_PROGRESS', 'ESCALATED'] },
          },
          // A provider ID already bound to another local call can never be
          // attached here. The durable provider intent and manual-review task
          // correlate this accepted-but-quarantined call instead.
          data: { outcome: 'ESCALATED', endedAt: new Date() },
        });
        if (target) await tx.receptionistCallTarget.updateMany({
          where: {
            id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id,
            lastCallLogId: callLog.id,
            OR: [{ status: 'CALLING' }, { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED' }],
          },
          data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: callLog.id },
        });
      }).catch(() => undefined);
      let reviewRecorded = false;
      try {
        await runWithTenantContext(request.auth.tenantId, async tx => {
          await lockOutboundDispatch(tx, request.auth.tenantId);
          const stillUncertain = target ? await tx.receptionistCallTarget.findFirst({
            where: {
              id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id,
              lastCallLogId: callLog.id, status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
            },
            select: { id: true },
          }) : null;
          if (!stillUncertain) return;
          await tx.operationalSignal.upsert({
            where: { tenantId_signalType_entityType_entityId: {
              tenantId: request.auth.tenantId,
              signalType: 'receptionist_outbound_local_binding_failed',
              entityType: 'receptionistCallLog', entityId: callLog.id,
            } },
            update: {
              severity: 'critical', score: 100, status: 'open',
              reason: 'Provider accepted the call but local binding failed; provider stop was attempted and staff reconciliation is required.',
            },
            create: {
            tenantId: request.auth.tenantId, signalType: 'receptionist_outbound_local_binding_failed',
            entityType: 'receptionistCallLog', entityId: callLog.id, severity: 'critical', score: 100,
            reason: 'Provider accepted the call but local binding failed; provider stop was attempted and staff reconciliation is required.',
            },
          });
          const existingTask = await tx.staffTask.findFirst({
            where: { tenantId: request.auth.tenantId, metadata: { path: ['callLogId'], equals: callLog.id } },
            select: { id: true },
          });
          if (!existingTask) await tx.staffTask.create({ data: {
              tenantId: request.auth.tenantId, branchId: campaign.defaultBranchId,
              title: 'Reconcile provider-accepted outbound call', priority: 'CRITICAL',
              metadata: { workflow: 'receptionist_outbound_reconciliation', callLogId: callLog.id, providerCallId: result.callId, providerStopApplied: stopped.ok && stopped.applied },
            } });
          reviewRecorded = true;
        });
      } catch {
        // ESCALATED and non-dialable state are the primary durable controls.
      }
      return reply.code(202).send({
        status: 'reconciliation_required', callId: result.callId, callLogId: callLog.id,
        providerStopApplied: stopped.ok && stopped.applied, reviewRecorded,
      });
    }
    let trackingDegraded = false;
    if (body.targetId) {
      const linked = await db.receptionistCallTarget.updateMany({
        where: { id: body.targetId, tenantId: request.auth.tenantId, campaignId: campaign.id, status: 'CALLING' },
        data: { lastCallLogId: callLog.id },
      }).catch(() => ({ count: 0 }));
      trackingDegraded ||= linked.count !== 1;
    }
    try {
      await audit(request, {
        action: 'receptionist.call.launched', resource: 'receptionistCallLog', resourceId: callLog.id,
        metadata: {
          campaignId: campaign.id,
          mock: result.mock,
          liveTestExecutionId: liveTest?.executionId ?? null,
          destinationMasked: maskPhone(canonicalDialDestination),
        },
      });
    } catch {
      trackingDegraded = true;
    }
    return reply.code(201).send({ status: 'launched', callId: result.callId, callLogId: callLog.id, mock: result.mock, trackingDegraded });
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
    const metadataTenant = typeof snapshot.metadata.tenantId === 'string' ? snapshot.metadata.tenantId : null;
    const metadataCampaign = typeof snapshot.metadata.outboundCampaignId === 'string' ? snapshot.metadata.outboundCampaignId : null;
    const metadataCallLog = typeof snapshot.metadata.callLogId === 'string' ? snapshot.metadata.callLogId : null;
    const expectedAgentId = localCall.outboundCampaign?.agent?.providerAgentId ?? null;
    const expectedAgentVersion = localCall.outboundCampaign?.agent?.providerVersion ?? null;
    if (metadataTenant !== request.auth.tenantId
      || metadataCampaign !== params.campaignId
      || metadataCallLog !== localCall.id
      || (expectedAgentId && snapshot.agentId !== expectedAgentId)
      || (expectedAgentVersion !== null && snapshot.agentVersion !== expectedAgentVersion)) {
      await audit(request, {
        action: 'receptionist.call.providerSyncQuarantined', resource: 'receptionistCallLog', resourceId: localCall.id,
        metadata: { campaignId: params.campaignId, providerStatus: snapshot.status, reason: 'provider_binding_mismatch' },
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
    return rows.map(row => ({
      ...row,
      callerPhone: maskPhone(row.callerPhone),
      retellCallId: maskProviderId(row.retellCallId),
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
