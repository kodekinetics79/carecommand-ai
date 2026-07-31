import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { retellConfigStatus, createPhoneCall, stopPhoneCall } from '../../lib/retell';
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
import { isVoiceSuppressedTx, lockSuppressionFences } from '../../lib/receptionist/dncFence';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const writeRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.MANAGE);
const callArtifactRead = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.CALL_ARTIFACTS_READ);
const ownerAdminRoles = requireRoles('OWNER', 'ADMIN');
const REQUIRED_FIELD_KEYS = ['firstName', 'lastName', 'phone', 'email', 'preferredBranch', 'preferredService', 'preferredDateTime'] as const;
const RUNNABLE_CAMPAIGN_STATUS = 'RUNNING';
const DIALABLE_TARGET_STATUS = 'PENDING';
const OUTBOUND_PURPOSES = ['CARE_COORDINATION', 'APPOINTMENT_REMINDER', 'PATIENT_REACTIVATION'] as const;
const OUTBOUND_LEGAL_BASES = ['EXPLICIT_CONSENT', 'TREATMENT_OPERATIONS'] as const;
export const MAX_TENANT_ACTIVE_CALLS = 3;
export const DEFAULT_VOICE_MINUTES_LIMIT = 500;

type ProviderBoundaryTestStage = 'before_suppression_fence' | 'suppression_fence_acquired' | 'provider_intent_committed' | 'before_provider_binding_lock' | 'provider_binding_committed';
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

async function hasPositiveVoiceConsent(tenantId: string, target: { patientId?: string | null; leadId?: string | null }): Promise<boolean> {
  if (!target.patientId && !target.leadId) return false;
  return runWithTenantContext(tenantId, async tx => (await tx.communicationConsent.count({
    where: {
      tenantId,
      patientId: target.patientId ?? null,
      leadId: target.leadId ?? null,
      channel: 'voice',
      status: { in: ['opted_in', 'granted'] },
    },
  })) > 0);
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
  },
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
        await tx.receptionistCallLog.updateMany({
          where: { id: { in: confirmed.map(row => row.call.id) }, tenantId: request.auth.tenantId, endedAt: null },
          data: { outcome: 'FAILED', endedAt: new Date() },
        });
        for (const row of confirmed) {
          if (!row.call.targetId || !row.call.outboundCampaignId) continue;
          await tx.receptionistCallTarget.updateMany({
            where: { id: row.call.targetId, tenantId: request.auth.tenantId, campaignId: row.call.outboundCampaignId, status: 'CALLING' },
            data: { status: 'FAILED', lastOutcome: 'OUTBOUND_STOPPED', lastCallLogId: row.call.id },
          });
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
          const changed = await tx.receptionistCallLog.updateMany({
            where: { id: row.call.id, tenantId: request.auth.tenantId, outcome: 'IN_PROGRESS', endedAt: null },
            data: { outcome: 'ESCALATED', endedAt: new Date() },
          });
          const latest = changed.count === 1
            ? { outcome: 'ESCALATED' }
            : await tx.receptionistCallLog.findFirst({
              where: { id: row.call.id, tenantId: request.auth.tenantId }, select: { outcome: true },
            });
          // Another concurrent stop may already have confirmed cancellation
          // and committed FAILED/OUTBOUND_STOPPED. Never downgrade that stronger
          // terminal evidence because this provider request returned 503.
          if (latest?.outcome !== 'ESCALATED') continue;
          reconciliationIds.add(row.call.id);
          if (!row.call.targetId || !row.call.outboundCampaignId) continue;
          await tx.receptionistCallTarget.updateMany({
            where: { id: row.call.targetId, tenantId: request.auth.tenantId, campaignId: row.call.outboundCampaignId },
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
        await runWithTenantContext(request.auth.tenantId, tx => tx.operationalSignal.upsert({
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
        }));
        signalRecorded += 1;
      } catch {
        // Primary ESCALATED/non-dialable state is already committed.
      }
      try {
        await runWithTenantContext(request.auth.tenantId, tx => tx.staffTask.create({ data: {
          tenantId: request.auth.tenantId,
          title: 'Urgent: reconcile outbound call after unconfirmed stop', priority: 'CRITICAL',
          metadata: {
            workflow: 'receptionist_outbound_stop_reconciliation', callLogId: row.call.id,
            providerCallId: row.call.retellCallId, providerStopApplied: false,
            providerStopError: row.result.ok ? 'provider_stop_unconfirmed' : row.result.error,
          },
        } }));
        reviewRecorded += 1;
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
    return {
      configured: status.configured && readyAgents > 0,
      mock: status.mock,
      missing: [...status.missing, ...(readyAgents ? [] : ['AGENT_DEPLOYMENT'])],
      readyAgents,
      adhocTestCallsAllowed: status.mock && env.NODE_ENV !== 'production',
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
    receptionistCampaignId: uuid.optional().nullable(),
    name: z.string().trim().min(2).max(160),
    script: z.string().trim().min(2).max(4000),
    purpose: z.enum(OUTBOUND_PURPOSES).optional().nullable(),
    legalBasis: z.enum(OUTBOUND_LEGAL_BASES).optional().nullable(),
    policyVersion: z.string().trim().min(3).max(80).optional().nullable(),
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
          bookingMode: input.bookingMode, receptionistCampaignId: input.receptionistCampaignId,
          defaultService: input.defaultService, purpose: input.purpose, legalBasis: input.legalBasis, policyVersion: input.policyVersion,
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
    const { q } = z.object({ q: z.string().trim().max(120).optional() }).parse(request.query);
    const query = q?.trim();
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
    const consents = await runWithTenantContext(request.auth.tenantId, tx => tx.communicationConsent.findMany({
      where: {
        tenantId: request.auth.tenantId, channel: 'voice', status: { in: ['opted_in', 'granted'] },
        OR: identities.map(identity => identity.type === 'patient' ? { patientId: identity.id } : { leadId: identity.id }),
      },
      select: { patientId: true, leadId: true },
    }));
    return identities.map(identity => ({
      ...identity,
      voiceConsentReady: consents.some(consent => identity.type === 'patient' ? consent.patientId === identity.id : consent.leadId === identity.id),
    }));
  });

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
    const normalized = await runWithTenantContext(request.auth.tenantId, async tx => {
      const rows: Array<(typeof body.targets)[number] & { phone: string }> = [];
      const seenDestinations = new Set<string>();
      for (const target of body.targets) {
        if (Boolean(target.patientId) === Boolean(target.leadId)) throw new Error('target_exact_identity_required');
        const phone = toE164(target.phone);
        if (!isValidE164(phone)) throw new Error('target_phone_invalid');
        if (seenDestinations.has(phone)) throw new Error('target_destination_duplicate');
        seenDestinations.add(phone);
        if (await tx.receptionistCallTarget.count({ where: { tenantId: request.auth.tenantId, campaignId: id, phone } })) {
          throw new Error('target_destination_duplicate');
        }
        const identity = target.patientId
          ? await tx.patient.findFirst({ where: { id: target.patientId, tenantId: request.auth.tenantId, deletedAt: null }, select: { phone: true } })
          : await tx.lead.findFirst({ where: { id: target.leadId!, tenantId: request.auth.tenantId }, select: { phone: true } });
        if (!identity) throw new Error('target_identity_foreign_or_inactive');
        const identityPhone = toE164(identity.phone ?? '');
        if (!isValidE164(identityPhone) || identityPhone !== phone) throw new Error('target_phone_identity_mismatch');
        rows.push({ ...target, phone });
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
      include: {
        clinic: { select: { name: true, complianceDisclosure: true, timezone: true } },
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
    const canonicalDialDestination = toE164(body.phone);
    if (!isValidE164(canonicalDialDestination)) {
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'invalid_e164_destination' } });
      return reply.code(400).send({ status: 'blocked', reason: 'invalid_e164_destination' });
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

    const requiresPositiveConsent = campaign.legalBasis === 'EXPLICIT_CONSENT' || campaign.purpose === 'PATIENT_REACTIVATION';
    if (target && requiresPositiveConsent && !(await hasPositiveVoiceConsent(request.auth.tenantId, target))) {
      await audit(request, { action: 'receptionist.call.suppressed', resource: 'receptionistCallTarget', resourceId: target.id, metadata: { campaignId: campaign.id, reason: 'positive_voice_consent_missing' } });
      return reply.code(409).send({ status: 'blocked', reason: 'positive_voice_consent_missing' });
    }
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
              patientId: target.patientId,
              leadId: target.leadId,
              phone: canonicalDialDestination,
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
    if (!boundaryAuthorityReason && currentTarget && requiresPositiveConsent && !(await hasPositiveVoiceConsent(request.auth.tenantId, currentTarget))) {
      boundaryAuthorityReason = 'positive_voice_consent_missing';
    }
    if (!boundaryAuthorityReason && currentTarget && !(await targetIdentityIsBound(request.auth.tenantId, currentTarget, canonicalDialDestination))) {
      boundaryAuthorityReason = 'target_identity_unbound';
    }
    if (!boundaryAuthorityReason && await isSuppressed(request.auth.tenantId, {
      patientId: currentTarget?.patientId ?? null,
      leadId: currentTarget?.leadId ?? null,
      destination: canonicalDialDestination,
    }, 'voice')) boundaryAuthorityReason = 'shared_suppression_gate';
    if (stoppedAtBoundary || currentCampaign?.status !== RUNNABLE_CAMPAIGN_STATUS || boundaryAuthorityReason) {
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
          : boundaryAuthorityReason!;
      await audit(request, { action: 'receptionist.call.blocked', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, reason: `${reason}_pre_provider` } });
      if (stoppedAtBoundary) return reply.code(423).send({ status: 'blocked', reason, callLogId: callLog.id });
      return reply.code(409).send({ status: 'blocked', reason, callLogId: callLog.id });
    }

    await providerBoundaryTestHook?.('before_suppression_fence');
    const providerIntent = await db.$transaction(async tx => {
      await lockSuppressionFences(tx, {
        tenantId: request.auth.tenantId,
        destinations: [canonicalDialDestination],
        patientId: currentTarget?.patientId,
        leadId: currentTarget?.leadId,
      });
      await providerBoundaryTestHook?.('suppression_fence_acquired');

      const finalUsage = await tx.tenantAiUsage.findUnique({ where: { tenantId: request.auth.tenantId }, select: { killSwitch: true } });
      const finalCampaign = await tx.receptionistOutboundCampaign.findFirst({
          where: { id: campaign.id, tenantId: request.auth.tenantId },
          include: { agent: true, receptionistCampaign: true },
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
      if (target && (!finalTarget
        || finalTarget.patientId !== target.patientId
        || finalTarget.leadId !== target.leadId
        || finalTarget.phone !== canonicalDialDestination
        || finalTarget.status !== 'CALLING')) return { blocked: 'target_identity_changed' as const };

      if (finalTarget && requiresPositiveConsent) {
        const positiveConsent = await tx.communicationConsent.count({ where: {
          tenantId: request.auth.tenantId,
          patientId: finalTarget.patientId ?? null,
          leadId: finalTarget.leadId ?? null,
          channel: 'voice', status: { in: ['opted_in', 'granted'] },
        } });
        if (positiveConsent === 0) return { blocked: 'positive_voice_consent_missing' as const };
      }
      if (await isVoiceSuppressedTx(tx, {
        tenantId: request.auth.tenantId,
        destination: canonicalDialDestination,
        patientId: finalTarget?.patientId,
        leadId: finalTarget?.leadId,
      })) return { blocked: 'shared_suppression_gate' as const };

      const linearizedAt = new Date();
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionist.outbound.providerIntent.authorized', resource: 'receptionistCallLog', resourceId: callLog.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], occurredAt: linearizedAt,
        metadata: { campaignId: campaign.id, targetId: body.targetId ?? null, suppressionFence: 'held_at_commit' },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId, eventType: 'receptionist.outbound.provider_intent_authorized',
        entityType: 'receptionistCallLog', entityId: callLog.id, sourceModule: 'receptionist', occurredAt: linearizedAt,
        payload: { campaignId: campaign.id, targetId: body.targetId ?? null, suppressionFence: 'held_at_commit' },
      } });
      return { campaign: finalCampaign };
    });

    if ('blocked' in providerIntent) {
      await db.$transaction(async tx => {
        await tx.receptionistCallLog.update({ where: { id: callLog.id }, data: { outcome: 'FAILED', endedAt: new Date() } });
        if (target) await tx.receptionistCallTarget.updateMany({
          where: { id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id, status: 'CALLING' },
          data: { status: 'PENDING', attempts: { decrement: 1 }, lastOutcome: 'BLOCKED', lastCallLogId: callLog.id },
        });
      });
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
      await db.receptionistCallLog.updateMany({
        where: { id: callLog.id, tenantId: request.auth.tenantId, outcome: 'IN_PROGRESS', endedAt: null, retellCallId: null },
        data: { outcome: 'FAILED', endedAt: new Date() },
      });
      await audit(request, {
        action: 'receptionist.call.cancelledBeforeProvider', resource: 'receptionistCallLog', resourceId: callLog.id,
        metadata: { campaignId: campaign.id, reason: stoppedAfterIntent ? 'outbound_stopped_after_intent' : 'provider_intent_cancelled' },
      });
      return reply.code(423).send({ status: 'cancelled', reason: stoppedAfterIntent ? 'outbound_stopped' : 'provider_intent_cancelled', callLogId: callLog.id });
    }
    const result = await createPhoneCall({
      toNumber: canonicalDialDestination,
      agentId: authorizedCampaign.agent!.providerAgentId!,
      agentVersion: authorizedCampaign.agent!.providerVersion!,
      webhookUrl: `${env.PUBLIC_API_URL}/v1/receptionist/webhooks/retell?clinicId=${campaign.clinicId}&campaignId=${campaign.receptionistCampaignId ?? ''}`,
      dynamicVariables: {
        clinic_name: campaign.clinic.name,
        agent_name: campaign.agent?.name ?? 'Riley',
        disclosure: campaign.clinic.complianceDisclosure,
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
      },
      // No verified prior recording consent is attached to this launch. Retell
      // must retain metadata only; an in-call grant cannot upgrade this setting.
      dataStorageSetting: 'basic_attributes_only',
    });

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
        const nextOutcome = existing.outcome === 'IN_PROGRESS'
          ? (effectiveProviderStopApplied ? 'FAILED' as const : 'ESCALATED' as const)
          : existing.outcome === 'FAILED' && !effectiveProviderStopApplied && existing.retellCallId === null
            ? 'ESCALATED' as const
            : existing.outcome;
        await tx.receptionistCallLog.update({
          where: { id: callLog.id },
          data: { retellCallId: existing.retellCallId ?? providerCallId, outcome: nextOutcome, endedAt: existing.endedAt ?? new Date() },
        });
        if (target) await tx.receptionistCallTarget.updateMany({
          where: { id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id },
          data: { status: 'FAILED', lastOutcome: effectiveProviderStopApplied ? 'OUTBOUND_STOPPED' : 'RECONCILIATION_REQUIRED', lastCallLogId: callLog.id },
        });
        return { effectiveProviderStopApplied };
      });

      const { effectiveProviderStopApplied } = primaryState;

      let signalId: string | null = null;
      let reviewTaskId: string | null = null;
      if (!effectiveProviderStopApplied) {
        try {
          const signal = await runWithTenantContext(request.auth.tenantId, tx => tx.operationalSignal.upsert({
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
          }));
          signalId = signal.id;
        } catch {
          signalId = null;
        }
        try {
          const task = await runWithTenantContext(request.auth.tenantId, tx => tx.staffTask.create({ data: {
            tenantId: request.auth.tenantId, branchId: campaign.defaultBranchId,
            title: 'Urgent: reconcile outbound call accepted after stop', priority: 'CRITICAL',
            metadata: {
              workflow: 'receptionist_outbound_stop_reconciliation', callLogId: callLog.id,
              providerCallId, providerStopApplied: false,
              providerStopError: providerStop.ok ? 'provider_stop_unconfirmed' : providerStop.error,
            },
          } }));
          reviewTaskId = task.id;
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
        const bound = await tx.receptionistCallLog.updateMany({
          where: { id: callLog.id, tenantId: request.auth.tenantId, retellCallId: null, outcome: 'IN_PROGRESS', endedAt: null },
          data: { retellCallId: result.callId },
        });
        return { cancelled: false as const, bound: bound.count };
      });
      if (binding.cancelled) return await cancelAcceptedCall(result.callId);
      if (binding.bound !== 1) throw new Error('provider_call_binding_lost');
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
      await db.receptionistCallLog.updateMany({
        where: { id: callLog.id, tenantId: request.auth.tenantId },
        data: { outcome: 'ESCALATED', endedAt: new Date(), retellCallId: result.callId },
      }).catch(() => undefined);
      if (target) await db.receptionistCallTarget.updateMany({
        where: { id: target.id, tenantId: request.auth.tenantId, campaignId: campaign.id },
        data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: callLog.id },
      }).catch(() => undefined);
      let reviewRecorded = false;
      try {
        await runWithTenantContext(request.auth.tenantId, async tx => {
          await tx.operationalSignal.create({ data: {
            tenantId: request.auth.tenantId, signalType: 'receptionist_outbound_local_binding_failed',
            entityType: 'receptionistCallLog', entityId: callLog.id, severity: 'critical', score: 100,
            reason: 'Provider accepted the call but local binding failed; provider stop was attempted and staff reconciliation is required.',
          } });
          await tx.staffTask.create({ data: {
            tenantId: request.auth.tenantId, branchId: campaign.defaultBranchId,
            title: 'Reconcile provider-accepted outbound call', priority: 'CRITICAL',
            metadata: { workflow: 'receptionist_outbound_reconciliation', callLogId: callLog.id, providerCallId: result.callId, providerStopApplied: stopped.ok && stopped.applied },
          } });
        });
        reviewRecorded = true;
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
      await audit(request, { action: 'receptionist.call.launched', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, mock: result.mock } });
    } catch {
      trackingDegraded = true;
    }
    return reply.code(201).send({ status: 'launched', callId: result.callId, callLogId: callLog.id, mock: result.mock, trackingDegraded });
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
