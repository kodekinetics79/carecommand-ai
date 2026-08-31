// ===========================================================================
// The outbound launch path — one dial, every fence, one implementation.
//
// WHY THIS IS NOT IN THE ROUTE ANY MORE
//
// This is the code that decides whether a real phone rings. It enforces, in
// order: campaign status, authority approval and its fingerprint, agent
// readiness, the tenant kill switch, target ownership and identity binding,
// E.164 canonicalisation, live-test authorisation, the ad-hoc refusal, shared
// suppression, DNC opt-out, quiet hours in the CLINIC's timezone, provider
// configuration, per-tenant concurrency and the voice-minute budget under an
// advisory lock, a pre-provider-boundary re-check, and finally a durable
// `ReceptionistOutboundProviderIntent` committed under the DNC fence BEFORE
// the provider is contacted.
//
// It used to be the body of `POST /outbound-campaigns/:id/call`. A worker
// cannot call a Fastify handler, so an automated dialler had exactly two
// options: call this, or write it again. Written again, the two copies drift,
// and the first drift is a call placed to a number on the do-not-call list.
// So it moved here, unchanged in behaviour, and the route became an adapter.
//
// The body below is a deliberate near-verbatim move — including its original
// indentation — so it can be diffed against the pre-extraction route. The only
// systematic edits are the actor seam (`request.auth.*` → `LaunchActor`) and
// the reply seam (`reply.code(n).send(x)` → `answer(n, x)`), both mechanical.
//
// RULES FOR THIS MODULE
//
//   * It must never import a Fastify route, a Fastify type, or `app`. A worker
//     that imports a route module drags the whole HTTP graph into a process
//     that serves no requests — including module-scope key derivation that
//     crashed the worker at boot. Everything here is reachable from a worker.
//   * A caller must already hold a tenant context (the request hook for HTTP,
//     `runInTenantContext` for a job). This asserts it and fails closed.
//   * Nothing here may be duplicated by a caller. If a dialler needs a gate,
//     it calls this; it does not re-decide.
// ===========================================================================

import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { env } from '../../config/env';
import { retellConfigStatus, createPhoneCall, stopPhoneCall } from '../retell';
import { buildHoursDynamicVariables, hoursStatus } from './clinicHours';
import { VOICE_MUTABLE_STATUSES, buildAppointmentDynamicVariables } from './appointmentContext';
import { loadHoursSource } from './hoursSource';
import { resolveLocalePackWithFallback, resolvedLocaleFormat } from './localePacks/resolve';
import { isDestinationOptedOut, isSuppressed, isValidE164, toE164 } from '../campaigns';
import { agentReadinessReason } from './agentReadiness';
import { requireTenantContext, runWithTenantContext } from '../tenantContext';
import { Prisma } from '../../generated/prisma/client';
// Pure hashing helper (node:crypto only). Importing it here does not pull any
// HTTP dependency into a worker.
import { fingerprintJson } from '../../modules/receptionist/intakeContract';
import { authorizeOutboundProviderIntentTx } from './dncFence';
import { issueProviderIntentCorrelation, providerIntentMetadataForRetell } from './providerIntentCorrelation';
import {
  authorizeLiveCallDestination,
  evaluateLiveCallAdmission,
  liveCallUatDisclosure,
  liveCallUatScope,
  maskPhone,
} from './liveCallUat';
import { MAX_TENANT_ACTIVE_CALLS } from './admissionPolicy';
import { periodUsageTotal, USAGE_METRICS } from '../usageMetering';
import { liveCallingBlockReason, TENANT_MODE_DEMO_BLOCK } from '../tenantMode';
import { DEFAULT_VOICE_MINUTES_LIMIT, DIALABLE_TARGET_STATUS, isTargetDialable, targetStatusAfterOutcome } from './outboundPolicy';

export const RUNNABLE_CAMPAIGN_STATUS = 'RUNNING';
export const OUTBOUND_PURPOSES = ['CARE_COORDINATION', 'APPOINTMENT_REMINDER', 'PATIENT_REACTIVATION'] as const;
export const OUTBOUND_LEGAL_BASES = ['EXPLICIT_CONSENT', 'TREATMENT_OPERATIONS'] as const;
export const STRICT_HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const CLIENT_LAUNCH_ATTEMPT_SCOPE = 'receptionist.outbound-client-attempt';

// ---------------------------------------------------------------------------
// The actor seam.
//
// `audit(request, ...)` cannot be reached from a worker, and a worker has no
// user to attribute a row to. A worker actor writes `actorUserId: null` — the
// same shape webhooks already use — and carries its job identity in
// `requestId` and in the audit metadata, so an automated dial is always
// distinguishable from a person clicking Call.
// ---------------------------------------------------------------------------
export type LaunchActor =
  | { kind: 'user'; userId: string; requestId: string; ip?: string; userAgent?: string }
  | { kind: 'worker'; jobId: string; runId: string };

export interface LaunchLogger {
  warn(payload: object, message: string): void;
  error(payload: object, message: string): void;
}

const consoleLaunchLogger: LaunchLogger = {
  warn: (payload, message) => console.warn(payload, message),
  error: (payload, message) => console.error(payload, message),
};

export function actorAuditFields(actor: LaunchActor): {
  actorUserId: string | null;
  requestId: string | undefined;
  ipAddress: string | undefined;
  userAgent: string | undefined;
} {
  return actor.kind === 'user'
    ? { actorUserId: actor.userId, requestId: actor.requestId, ipAddress: actor.ip, userAgent: actor.userAgent }
    : { actorUserId: null, requestId: actor.jobId, ipAddress: undefined, userAgent: undefined };
}

export function mergeActorMetadata(
  actor: LaunchActor,
  metadata: Prisma.InputJsonObject | undefined,
): Prisma.InputJsonObject | undefined {
  if (actor.kind === 'user') return metadata;
  return { ...(metadata ?? {}), dialer: { runId: actor.runId, jobId: actor.jobId } };
}

/** The audit writer `lib/audit.ts` is for a request; this is the same row for
 *  either kind of actor. */
export async function writeLaunchAudit(
  tenantId: string,
  actor: LaunchActor,
  event: { action: string; resource: string; resourceId?: string; metadata?: Prisma.InputJsonObject },
): Promise<void> {
  const attribution = actorAuditFields(actor);
  await runWithTenantContext(tenantId, tx => tx.auditEvent.create({
    data: {
      tenantId,
      actorUserId: attribution.actorUserId,
      action: event.action,
      resource: event.resource,
      resourceId: event.resourceId,
      requestId: attribution.requestId,
      ipAddress: attribution.ipAddress,
      userAgent: attribution.userAgent,
      metadata: mergeActorMetadata(actor, event.metadata),
    },
  }));
}

/**
 * What the launch decided, in the shape the route answers with.
 *
 * `code` is the HTTP status the route sends verbatim, which is also the most
 * precise thing a worker can read: 2xx means the provider was reached or the
 * dial was deliberately skipped, 423 means the kill switch, 409 a fence.
 * `notFound` is set only where the route used to throw `httpErrors.notFound`,
 * so the HTTP envelope for those two cases is unchanged.
 */
export interface LaunchResult {
  code: number;
  body: Record<string, unknown>;
  notFound?: string;
}

export interface LaunchOutboundCallInput {
  tenantId: string;
  campaignId: string;
  actor: LaunchActor;
  targetId?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  clientAttemptToken?: string;
  log?: LaunchLogger;
}

const answer = (code: number, body: Record<string, unknown>): LaunchResult => ({ code, body });
const notFound = (message: string): LaunchResult => ({ code: 404, body: { status: 'not_found' }, notFound: message });

// How long an outbound call may still plausibly be running. This is a CAPACITY
// bound, not a call-duration policy: the provider hard-stops calls far inside
// it, and nothing here ever decides a call's outcome. An attended live test
// already carries a provider-enforced ceiling (`maxCallDurationMs`, from
// LIVE_TEST_MAX_CALL_MINUTES), so that number is used when there is one.
export const OUTBOUND_CALL_MAX_MINUTES = 60;
// Slack for a late `call_ended`/`call_analyzed`, so a call that really did run
// to the bound is not treated as expired while its webhook is still in flight.
export const OUTBOUND_CALL_DEADLINE_MARGIN_MINUTES = 15;

type ProviderBoundaryTestStage = 'before_suppression_fence' | 'suppression_fence_acquired' | 'provider_intent_committed' | 'before_provider_binding_lock' | 'provider_binding_committed' | 'before_call_stopping_evaluation';
let providerBoundaryTestHook: ((stage: ProviderBoundaryTestStage) => Promise<void>) | null = null;

/** Deterministic interleaving support for integration tests only. */
export function setProviderBoundaryTestHookForTests(hook: ((stage: ProviderBoundaryTestStage) => Promise<void>) | null) {
  if (env.NODE_ENV === 'production') throw new Error('provider boundary test hooks are disabled in production');
  providerBoundaryTestHook = hook;
}

export function sameOptionalIdentity(provided: string | undefined, stored: string | null): boolean {
  if (provided === undefined) return true;
  return provided.trim().toLocaleLowerCase() === (stored ?? '').trim().toLocaleLowerCase();
}

export type OutboundAuthorityFingerprintInput = {
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

export function outboundAuthorityFingerprint(campaign: OutboundAuthorityFingerprintInput): string {
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

export async function outboundStopped(tenantId: string): Promise<boolean> {
  const usage = await db.tenantAiUsage.findUnique({ where: { tenantId }, select: { killSwitch: true } });
  return usage?.killSwitch === true;
}

export async function targetIdentityIsBound(
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

export async function lockOutboundConfiguration(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-config:${tenantId}`}::text, 0))::text AS locked`;
}

export async function lockOutboundDispatch(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-outbound-dispatch:${tenantId}`}::text, 0))::text AS locked`;
}

export type ProviderStopIdentity = {
  tenantId: string;
  campaignId: string;
  targetId: string;
  callLogId: string;
  providerCallId: string;
};

export async function applyConfirmedProviderStopTx(
  tx: Prisma.TransactionClient,
  identity: ProviderStopIdentity,
  actor: LaunchActor,
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
    await auditOutboundMutation(tx, { tenantId: identity.tenantId, actor }, {
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

export async function auditOutboundMutation(
  tx: Prisma.TransactionClient,
  context: { tenantId: string; actor: LaunchActor },
  event: { action: string; resource: string; resourceId: string; metadata?: Prisma.InputJsonObject },
) {
  const attribution = actorAuditFields(context.actor);
  await tx.auditEvent.create({ data: {
    tenantId: context.tenantId,
    actorUserId: attribution.actorUserId,
    action: event.action,
    resource: event.resource,
    resourceId: event.resourceId,
    requestId: attribution.requestId,
    ipAddress: attribution.ipAddress,
    userAgent: attribution.userAgent,
    metadata: mergeActorMetadata(context.actor, event.metadata),
  } });
}

export async function validateOutboundAssignments(
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

export function outboundAssignmentReason(error: unknown) {
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

export function providerIntentBlockReason(error: unknown): string | null {
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
/**
 * Place ONE outbound call, enforcing every gate. The route handler and the
 * dialler worker both call this and neither may re-decide anything it decides.
 */
export async function launchOutboundCall(input: LaunchOutboundCallInput): Promise<LaunchResult> {
    const { tenantId, actor, campaignId: id } = input;
    const body = input;
    const log = input.log ?? consoleLaunchLogger;
    const { actorUserId, requestId: actorRequestId, ipAddress: actorIp, userAgent: actorUserAgent } = actorAuditFields(actor);
    const launchAudit = (event: { action: string; resource: string; resourceId?: string; metadata?: Prisma.InputJsonObject }) =>
      writeLaunchAudit(tenantId, actor, event);
    const context = requireTenantContext();
    if (context.tenantId !== tenantId) {
      throw new Error('Outbound launch: active tenant context does not match the tenant being dialled (fail-closed)');
    }

    const campaign = await db.receptionistOutboundCampaign.findFirst({
      where: { id, tenantId: tenantId },
      include: {
        clinic: { select: { id: true, name: true, complianceDisclosure: true, timezone: true, country: true, defaultLanguage: true } },
        agent: true,
        receptionistCampaign: { select: { id: true, offerScript: true, appointmentType: true } },
      },
    });
    if (!campaign) return notFound('Campaign not found');

    if (campaign.status !== RUNNABLE_CAMPAIGN_STATUS) {
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'campaign_not_running', status: campaign.status } });
      return answer(409, { status: 'blocked', reason: 'campaign_not_running' });
    }
    if (!campaign.authorityApprovedAt || !campaign.authorityApprovedById || !campaign.policyVersion) {
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'outbound_authority_unapproved' } });
      return answer(409, { status: 'blocked', reason: 'outbound_authority_unapproved' });
    }

    try {
      await runWithTenantContext(tenantId, tx => validateOutboundAssignments(tx, {
        tenantId: tenantId,
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
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason } });
      return answer(409, { status: 'blocked', reason });
    }

    const initialAgentReadiness = campaign.agent ? agentReadinessReason(campaign.agent) : 'agent_unlinked';
    if (initialAgentReadiness) {
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: initialAgentReadiness } });
      return answer(409, { status: 'blocked', reason: initialAgentReadiness });
    }

    if (await outboundStopped(tenantId)) {
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'outbound_stopped' } });
      return answer(423, { status: 'blocked', reason: 'outbound_stopped' });
    }

    // A target id is an ownership and identity assertion, not merely metadata.
    // Bind the provider payload to the stored target and reject a body that
    // tries to substitute another person or destination.
    const target = body.targetId
      ? await db.receptionistCallTarget.findFirst({ where: { id: body.targetId, tenantId: tenantId, campaignId: campaign.id } })
      : null;
    if (body.targetId && !target) return notFound('Target not found for this campaign');
    const canonicalDialDestination = toE164(body.phone ?? target?.phone ?? '');
    if (!isValidE164(canonicalDialDestination)) {
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'invalid_e164_destination' } });
      return answer(400, { status: 'blocked', reason: 'invalid_e164_destination' });
    }
    const liveAuthorization = env.LIVE_TEST_CALLS_AUTHORIZED
      ? authorizeLiveCallDestination(canonicalDialDestination, new Date(), tenantId)
      : null;
    if (liveAuthorization && !liveAuthorization.allowed) {
      await launchAudit({
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
      return answer(403, { status: 'blocked', reason: liveAuthorization.reason });
    }
    const liveTest = liveAuthorization?.allowed ? liveAuthorization.status : null;
    if (liveTest && !body.clientAttemptToken) {
      await launchAudit({
        action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id,
        metadata: { reason: 'live_test_attempt_token_required', executionId: liveTest.executionId },
      });
      return answer(409, { status: 'blocked', reason: 'live_test_attempt_token_required' });
    }
    if (!target && !(retellConfigStatus().mock && env.NODE_ENV !== 'production')) {
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'adhoc_call_not_authorized' } });
      return answer(403, { status: 'blocked', reason: 'adhoc_call_not_authorized' });
    }
    if (target && !(await targetIdentityIsBound(tenantId, target, canonicalDialDestination))) {
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistCallTarget', resourceId: target.id, metadata: { campaignId: campaign.id, reason: 'target_identity_unbound' } });
      return answer(409, { status: 'blocked', reason: 'target_identity_unbound' });
    }
    if (target) {
      const identityMatches = (body.phone === undefined || toE164(body.phone) === toE164(target.phone))
        && sameOptionalIdentity(body.firstName, target.firstName)
        && sameOptionalIdentity(body.lastName, target.lastName)
        && sameOptionalIdentity(body.email, target.email);
      if (!identityMatches) {
        await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistCallTarget', resourceId: target.id, metadata: { campaignId: campaign.id, reason: 'target_identity_mismatch' } });
        return answer(409, { status: 'blocked', reason: 'target_identity_mismatch' });
      }
      if (!isTargetDialable(target.status, target.attempts, campaign.maxRetryAttempts)) {
        await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistCallTarget', resourceId: target.id, metadata: { campaignId: campaign.id, reason: 'target_not_dialable', targetStatus: target.status } });
        return answer(409, { status: 'blocked', reason: 'target_not_dialable' });
      }
    }

    const dialIdentity = target ?? body;

    // ---- Compliance gate: NEVER dial a suppressed person or number --------
    // Two sources, one consequence. Shared suppression is the cross-module
    // answer (consent revoked, patient-level preference, legacy consent);
    // `ReceptionistOptOut` is the voice-channel do-not-call list (ALL/VOICE
    // both suppress). Outbound targets are queued without a filter, so
    // suppression MUST be enforced here, at the dial, against state that may
    // have changed since the target was queued a moment or a week ago.
    //
    // WHY THEY SHARE ONE BRANCH. Shared suppression used to return `skipped`
    // WITHOUT writing a call log or moving the target, so the target stayed
    // PENDING. With a person clicking Call that is merely untidy — they see
    // the skip and stop. With a dialler it is an infinite loop: every pass
    // re-selects the same suppressed patient, refuses it, and writes another
    // audit row, forever. Suppression is terminal for this target either way,
    // so it is recorded the same way either way; only the audit metadata
    // distinguishes which list said no.
    const sharedSuppression = await isSuppressed(tenantId, {
      patientId: target?.patientId ?? null,
      leadId: target?.leadId ?? null,
      destination: canonicalDialDestination,
    }, 'voice');
    const destinationOptedOut = sharedSuppression
      ? false
      : await isDestinationOptedOut(tenantId, canonicalDialDestination, 'voice');
    if (sharedSuppression || destinationOptedOut) {
      const callLog = await db.receptionistCallLog.create({
        data: {
          tenantId: tenantId, clinicId: campaign.clinicId, outboundCampaignId: campaign.id, targetId: body.targetId,
          callerName: [dialIdentity.firstName, dialIdentity.lastName].filter(Boolean).join(' ') || null, callerPhone: dialIdentity.phone,
          direction: 'outbound', outcome: 'OPTED_OUT', startedAt: new Date(), endedAt: new Date(),
        },
      });
      if (body.targetId) await db.receptionistCallTarget.updateMany({ where: { id: body.targetId, tenantId: tenantId }, data: { status: 'OPTED_OUT', lastOutcome: 'OPTED_OUT', lastCallLogId: callLog.id } });
      await launchAudit({
        action: 'receptionist.call.suppressed',
        resource: 'receptionistCallLog',
        resourceId: callLog.id,
        metadata: {
          campaignId: campaign.id,
          targetId: body.targetId ?? null,
          reason: sharedSuppression ? 'shared_suppression_gate' : 'opted_out',
        },
      });
      return answer(200, { status: 'skipped', reason: 'opted_out', callLogId: callLog.id });
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
      await launchAudit({
        action: 'receptionist.call.blocked',
        resource: 'receptionistOutboundCampaign',
        resourceId: campaign.id,
        metadata: { reason: quietHoursReason, targetId: body.targetId ?? null },
      });
      return answer(409, { status: 'blocked', reason: quietHoursReason });
    }
    if (isWithinQuietHours(campaign.quietHoursStart, campaign.quietHoursEnd, campaign.clinic.timezone)) {
      await launchAudit({ action: 'receptionist.call.skipped', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'quiet_hours', targetId: body.targetId ?? null } });
      return answer(200, { status: 'skipped', reason: 'quiet_hours' });
    }

    // Do NOT fake a call: if Retell isn't configured, return setup_required.
    const status = retellConfigStatus();
    if (!status.configured) {
      return answer(200, { status: 'setup_required', missing: status.missing });
    }

    // Atomically enforce tenant concurrency and the voice-minute budget, then
    // claim a stored target and create its attempt log. The tenant advisory lock
    // makes concurrent launch requests observe one another before any provider
    // request can escape.
    const callLogData = {
      tenantId: tenantId,
      clinicId: campaign.clinicId,
      campaignId: campaign.receptionistCampaignId,
      outboundCampaignId: campaign.id,
      targetId: body.targetId,
      callerName: [dialIdentity.firstName, dialIdentity.lastName].filter(Boolean).join(' ') || null,
      callerPhone: canonicalDialDestination,
      direction: 'outbound',
      outcome: 'IN_PROGRESS' as const,
      startedAt: new Date(),
      // When this row stops counting against tenant capacity if nothing ever
      // closes it. A provider call that is accepted and never connected sends
      // no lifecycle webhook at all — no `call_started`, so no `call_ended` —
      // so without an expiry the row stays IN_PROGRESS forever and the leak is
      // monotonic. `ReceptionistCallLog_non_terminal_needs_deadline_check`
      // makes a non-terminal row impossible to insert without one, so a future
      // path that forgets fails loudly here instead of leaking quietly.
      //
      // Expiring is NOT reconciling: the outcome stays IN_PROGRESS until a
      // signed webhook or an explicit provider read says what happened. All an
      // expired row loses is its claim on a concurrency slot.
      deadlineAt: new Date(Date.now() + (
        (liveTest ? liveTest.maxCallMinutes : OUTBOUND_CALL_MAX_MINUTES) + OUTBOUND_CALL_DEADLINE_MARGIN_MINUTES
      ) * 60_000),
    };
    const reservation = await db.$transaction(async tx => {
          const clientAttemptKey = body.clientAttemptToken
            ? `${tenantId}:${campaign.id}:${body.clientAttemptToken}`
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
            if (!attempt || attempt.tenantId !== tenantId || attempt.resultId !== null) {
              return { blocked: 'client_attempt_not_claimable' as const };
            }
            await finishClientAttempt('dispatching');
          }
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-capacity:${tenantId}`})::bigint)`;
          let liveAttempt: { scope: string; key: string } | null = null;
          if (liveTest) {
            const scope = liveCallUatScope(liveTest.executionId ?? undefined);
            if (!scope || !body.clientAttemptToken) return { blocked: 'live_test_configuration_invalid' as const };
            const key = `${tenantId}:${campaign.id}:${body.clientAttemptToken}`;
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`live-voice-uat:${scope}:${tenantId}`}::text, 0))::text AS locked`;
            const existingAttempt = await tx.idempotencyKey.findUnique({
              where: { scope_key: { scope, key } },
              select: { id: true },
            });
            if (existingAttempt) return { blocked: 'live_test_attempt_replayed' as const };
            const priorAttempts = await tx.idempotencyKey.findMany({
              where: { tenantId: tenantId, scope },
              select: { resultId: true },
              take: liveTest.maxCalls + 1,
            });
            const priorCallIds = priorAttempts
              .map(attempt => attempt.resultId)
              .filter((value): value is string => Boolean(value && value !== 'dispatching' && !value.startsWith('blocked:')));
            const priorCalls = priorCallIds.length
              ? await tx.receptionistCallLog.findMany({
                where: { tenantId: tenantId, id: { in: priorCallIds } },
                select: { durationSeconds: true, endedAt: true, outcome: true },
              })
              : [];
            const admission = evaluateLiveCallAdmission({
              attemptsUsed: priorAttempts.length,
              connectedSeconds: priorCalls.reduce((sum, call) => sum + call.durationSeconds, 0),
              activeCalls: priorCalls.filter(call => !call.endedAt && call.outcome === 'IN_PROGRESS').length,
            }, new Date(), tenantId);
            if (!admission.allowed) return { blocked: admission.reason as 'live_test_call_cap_reached' | 'live_test_single_active_call' | 'live_test_minute_cap_reached' | 'live_test_cost_cap_reached' | 'live_test_not_active' };
            liveAttempt = { scope, key };
          }
          const aiUsage = await tx.tenantAiUsage.upsert({
            where: { tenantId: tenantId },
            update: {},
            create: { tenantId: tenantId },
            select: { receptionistMinutes: true, overageAllowed: true },
          });
          const voiceUsage = await tx.tenantUsageLimit.upsert({
            where: { tenantId_key: { tenantId: tenantId, key: 'voice_minutes' } },
            update: {},
            create: {
              tenantId: tenantId,
              key: 'voice_minutes',
              limitValue: DEFAULT_VOICE_MINUTES_LIMIT,
              used: aiUsage.receptionistMinutes,
            },
            select: { used: true, limitValue: true },
          });
          // Only calls that could still be live hold a slot. Before `deadlineAt`
          // nothing ever decremented this count for a call the provider never
          // connected, so a tenant walked one-way toward its ceiling and stayed
          // there: at the attended-test ceiling of one call that is the line off
          // the air after a single stranded dial, and ~25 of them shut an
          // ordinary clinic. An expired row releasing its slot is what lets a
          // tenant recover on its own even when the reconciler is down.
          //
          // A row with NO deadline still counts. Null means "written before
          // this column existed, or by a writer that does not stamp one yet",
          // and "we cannot tell whether this call is over" must never be read
          // as "this call is over".
          const activeCalls = await tx.receptionistCallLog.count({
            where: {
              tenantId: tenantId, outcome: 'IN_PROGRESS', endedAt: null,
              OR: [{ deadlineAt: null }, { deadlineAt: { gt: new Date() } }],
            },
          });
          // A demonstration workspace must never dial a real number. Checked
          // before concurrency and quota so it cannot be reached by waiting.
          const modeBlock = await liveCallingBlockReason(tenantId, tx);
          if (modeBlock) {
            await finishClientAttempt(`blocked:${TENANT_MODE_DEMO_BLOCK}`);
            return { blocked: TENANT_MODE_DEMO_BLOCK as typeof TENANT_MODE_DEMO_BLOCK };
          }
          const activeCallLimit = liveTest ? 1 : MAX_TENANT_ACTIVE_CALLS;
          if (activeCalls >= activeCallLimit) {
            await finishClientAttempt('blocked:concurrency_limit_reached');
            return { blocked: 'concurrency_limit_reached' as const };
          }
          // Included minutes are per billing period; the lifetime counters above
          // are display-only. Enforcing on them meant a clinic's allowance ran
          // out once and never came back.
          const usedMinutes = await periodUsageTotal(tx, tenantId, USAGE_METRICS.voiceMinute);
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
              tenantId: tenantId,
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
                tenantId: tenantId,
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
                tenantId: tenantId,
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
      await launchAudit({
        action: 'receptionist.call.blocked',
        resource: target ? 'receptionistCallTarget' : 'receptionistOutboundCampaign',
        resourceId: target?.id ?? campaign.id,
        metadata: { campaignId: campaign.id, reason: reservation.blocked },
      });
      return answer(statusCode, { status: 'blocked', reason: reservation.blocked });
    }
    const { callLog } = reservation;
    const releaseReservedAttempt = async (lastOutcome: string) => db.$transaction(async tx => {
      const released = await tx.receptionistCallLog.updateMany({
        where: {
          id: callLog.id,
          tenantId: tenantId,
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
            tenantId: tenantId,
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
      outboundStopped(tenantId),
      db.receptionistOutboundCampaign.findFirst({
        where: { id: campaign.id, tenantId: tenantId },
        include: { agent: true, receptionistCampaign: true },
      }),
      target ? db.receptionistCallTarget.findFirst({ where: { id: target.id, tenantId: tenantId, campaignId: campaign.id } }) : null,
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
          await runWithTenantContext(tenantId, tx => validateOutboundAssignments(tx, {
            tenantId: tenantId,
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
    if (!boundaryAuthorityReason && currentTarget && !(await targetIdentityIsBound(tenantId, currentTarget, canonicalDialDestination))) {
      boundaryAuthorityReason = 'target_identity_unbound';
    }
    if (!boundaryAuthorityReason && await isSuppressed(tenantId, {
      patientId: currentTarget?.patientId ?? null,
      leadId: currentTarget?.leadId ?? null,
      destination: canonicalDialDestination,
    }, 'voice')) boundaryAuthorityReason = 'shared_suppression_gate';
    if (stoppedAtBoundary || currentCampaign?.status !== RUNNABLE_CAMPAIGN_STATUS || boundaryAuthorityReason) {
      await releaseReservedAttempt('BLOCKED');
      const reason = stoppedAtBoundary ? 'outbound_stopped'
        : currentCampaign?.status !== RUNNABLE_CAMPAIGN_STATUS ? 'campaign_not_running'
          : boundaryAuthorityReason!;
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, reason: `${reason}_pre_provider` } });
      if (stoppedAtBoundary) return answer(423, { status: 'blocked', reason, callLogId: callLog.id });
      return answer(409, { status: 'blocked', reason, callLogId: callLog.id });
    }

    await providerBoundaryTestHook?.('before_suppression_fence');
    const providerIntentId = randomUUID();
    const providerCorrelation = issueProviderIntentCorrelation({
      tenantId: tenantId,
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
      await lockOutboundConfiguration(tx, tenantId);
      const finalUsage = await tx.tenantAiUsage.findUnique({ where: { tenantId: tenantId }, select: { killSwitch: true } });
      const finalCampaign = await tx.receptionistOutboundCampaign.findFirst({
          where: { id: campaign.id, tenantId: tenantId },
          include: { agent: true, receptionistCampaign: true, clinic: { select: { timezone: true } } },
        });
      const finalTarget = target
        ? await tx.receptionistCallTarget.findFirst({ where: { id: target.id, tenantId: tenantId, campaignId: campaign.id } })
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
          tenantId: tenantId,
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
        tenantId: tenantId,
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
        tenantId: tenantId, actorUserId: actorUserId,
        action: 'receptionist.outbound.providerIntent.authorized', resource: 'receptionistCallLog', resourceId: callLog.id,
        requestId: actorRequestId, ipAddress: actorIp, userAgent: actorUserAgent, occurredAt: linearizedAt,
        metadata: { campaignId: campaign.id, targetId: body.targetId ?? null, providerIntentId: durableIntent.id, suppressionFence: 'held_at_commit' },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: tenantId, eventType: 'receptionist.outbound.provider_intent_authorized',
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
        await launchAudit({
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
        log.warn({ callLogId: callLog.id, campaignId: campaign.id, reason: blockedReason }, 'Outbound provider intent blocked before provider submission');
      } else {
        log.error({
          err: providerIntentAttempt.error,
          callLogId: callLog.id,
          campaignId: campaign.id,
        }, 'Outbound provider intent evidence failed before provider submission');
      }
      return answer(blockedReason ? 409 : 503, {
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
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistCallLog', resourceId: callLog.id, metadata: { campaignId: campaign.id, reason: `${providerIntent.blocked}_at_provider_intent` } });
      const code = providerIntent.blocked === 'outbound_stopped' ? 423 : 409;
      return answer(code, { status: 'blocked', reason: providerIntent.blocked, callLogId: callLog.id });
    }

    // The committed intent is the linearization point. Any opt-out that held a
    // matching fence first prevented this commit; a later opt-out is ordered
    // after this already-authorized call and suppresses every future attempt.
    await providerBoundaryTestHook?.('provider_intent_committed');
    const authorizedCampaign = providerIntent.campaign;
    const [intentCall, stoppedAfterIntent, campaignAfterIntent] = await Promise.all([
      db.receptionistCallLog.findFirst({ where: { id: callLog.id, tenantId: tenantId }, select: { outcome: true, endedAt: true } }),
      outboundStopped(tenantId),
      db.receptionistOutboundCampaign.findFirst({ where: { id: campaign.id, tenantId: tenantId }, select: { status: true } }),
    ]);
    if (!intentCall || intentCall.outcome !== 'IN_PROGRESS' || intentCall.endedAt || stoppedAfterIntent || campaignAfterIntent?.status !== RUNNABLE_CAMPAIGN_STATUS) {
      const released = await releaseReservedAttempt('PROVIDER_INTENT_CANCELLED');
      let trackingDegraded = false;
      try {
        await launchAudit({
          action: 'receptionist.call.cancelledBeforeProvider', resource: 'receptionistCallLog', resourceId: callLog.id,
          metadata: { campaignId: campaign.id, reason: stoppedAfterIntent ? 'outbound_stopped_after_intent' : 'provider_intent_cancelled', released },
        });
      } catch {
        trackingDegraded = true;
      }
      return answer(423, {
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
      await launchAudit({ action: 'receptionist.call.blocked', resource: 'receptionistOutboundCampaign', resourceId: campaign.id, metadata: { reason: 'agent_required' } });
      return answer(409, { status: 'blocked', reason: 'agent_required', callLogId: callLog.id });
    }

    // Call-time truth for the hours and emergency variables: what the agent
    // says about "are you open" must be resolved now, not at export time.
    const dialBundle = await loadHoursSource(db, { tenantId: tenantId, clinicId: campaign.clinic.id });
    const dialPack = await resolveLocalePackWithFallback(db, {
      tenantId: tenantId,
      language: campaign.agent.language ?? campaign.clinic.defaultLanguage,
      country: campaign.clinic.country,
    });
    const dialLocale = resolvedLocaleFormat(dialPack, campaign.clinic.defaultLanguage);
    const dialStatus = dialBundle ? hoursStatus(dialBundle.source, new Date(), dialLocale) : null;

    // The per-call webhook URL is read by the receiving handler BEFORE the
    // provider signature is verified: its first statement is
    // `z.object({ clinicId: uuid.optional(), campaignId: uuid.optional() }).parse(request.query)`.
    // `receptionistCampaignId` is null on every APPOINTMENT_REQUEST_ONLY
    // campaign — only DIRECT_BOOKING_IF_SLOT_AVAILABLE requires one, and
    // APPOINTMENT_REQUEST_ONLY is the default — so interpolating `?? ''` put a
    // trailing `&campaignId=` on the URL. '' is not a uuid, so the parse threw
    // and the error plugin answered 400 before signature verification and
    // without an audit row. A 400 is permanent to a webhook sender: every
    // lifecycle event for a default-shape outbound campaign was dropped, which
    // is why those call logs never left IN_PROGRESS. Confirmed against
    // production 2026-08-31 — the URL with `&campaignId=` answers 400, the same
    // URL without the parameter answers 401, i.e. it reaches signature
    // verification, which is the correct refusal for an unsigned probe.
    //
    // An optional parameter that is ABSENT has to be omitted, not sent empty.
    // `emptyToNull` (above) exists for exactly this confusion on the way IN
    // from the Studio form; this is the same mistake on the way OUT.
    // The appointment this call is ABOUT, re-read at DIAL time rather than
    // trusted from the target row. A binding made when the list was built can
    // have been cancelled or moved since; speaking a stale appointment down the
    // phone is worse than speaking none. Scoped to the target's own patient, so
    // a mis-set binding cannot read one patient's diary to another.
    const boundAppointment = target?.appointmentId && target.patientId
      ? await db.appointment.findFirst({
        where: {
          id: target.appointmentId,
          tenantId,
          patientId: target.patientId,
          deletedAt: null,
          startsAt: { gt: new Date() },
          status: { in: [...VOICE_MUTABLE_STATUSES] },
        },
        select: {
          id: true, startsAt: true, service: true,
          branch: { select: { name: true, timezone: true } },
          providerProfile: { select: { user: { select: { displayName: true } } } },
        },
      })
      : null;
    if (target?.appointmentId && !boundAppointment) {
      log.warn({
        callLogId: callLog.id, campaignId: campaign.id, targetId: target.id, appointmentId: target.appointmentId,
      }, 'Outbound target is bound to an appointment that is no longer remindable; dialling with no appointment context');
    }

    const callWebhookQuery = new URLSearchParams({ clinicId: campaign.clinicId });
    if (campaign.receptionistCampaignId) callWebhookQuery.set('campaignId', campaign.receptionistCampaignId);
    const result = await createPhoneCall({
      toNumber: canonicalDialDestination,
      agentId: authorizedCampaign.agent!.providerAgentId!,
      agentVersion: authorizedCampaign.agent!.providerVersion!,
      webhookUrl: `${env.PUBLIC_API_URL}/v1/receptionist/webhooks/retell?${callWebhookQuery.toString()}`,
      dynamicVariables: {
        ...buildHoursDynamicVariables({ status: dialStatus, strings: dialPack?.strings ?? null }),
        // This patient's own appointment, in the BRANCH's timezone and this
        // call's locale format. Every key is present on every call: an unbound
        // target sends empty strings, exactly like the optional variables
        // below, never a placeholder the agent could speak as if it were fact.
        ...buildAppointmentDynamicVariables({
          appointment: boundAppointment
            ? {
              id: boundAppointment.id,
              startsAt: boundAppointment.startsAt,
              service: boundAppointment.service,
              timezone: boundAppointment.branch.timezone,
              locationName: boundAppointment.branch.name,
              clinicianName: boundAppointment.providerProfile?.user.displayName ?? null,
            }
            : null,
          locale: dialLocale,
        }),
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
        tenantId: tenantId, outboundCampaignId: campaign.id,
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
        await lockOutboundDispatch(tx, tenantId);
        const existing = await tx.receptionistCallLog.findFirstOrThrow({
          where: { id: callLog.id, tenantId: tenantId }, select: { outcome: true, endedAt: true, retellCallId: true },
        });
        const durableTargetStop = target
          ? await tx.receptionistCallTarget.findFirst({
            where: {
              id: target.id, tenantId: tenantId, campaignId: campaign.id,
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
            where: { tenantId: tenantId, retellCallId: providerCallId },
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
                id: callLog.id, tenantId: tenantId,
                outboundCampaignId: campaign.id, targetId: target.id,
                retellCallId: null, outcome: { in: ['IN_PROGRESS', 'ESCALATED', 'FAILED'] },
              },
              data: { retellCallId: providerCallId },
            });
          }
          await applyConfirmedProviderStopTx(tx, {
            tenantId: tenantId,
            campaignId: campaign.id,
            targetId: target.id,
            callLogId: callLog.id,
            providerCallId,
          }, actor);
        } else {
          await tx.receptionistCallLog.update({
            where: { id: callLog.id },
            data: { retellCallId: nextRetellCallId, outcome: nextOutcome, endedAt: existing.endedAt ?? new Date() },
          });
          if (target) await tx.receptionistCallTarget.updateMany({
            where: {
              id: target.id, tenantId: tenantId, campaignId: campaign.id,
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
          const signal = await runWithTenantContext(tenantId, async tx => {
            await lockOutboundDispatch(tx, tenantId);
            const stillUncertain = target
              ? await tx.receptionistCallTarget.findFirst({
                where: {
                  id: target.id, tenantId: tenantId, campaignId: campaign.id,
                  lastCallLogId: callLog.id, status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
                },
                select: { id: true },
              })
              : null;
            if (!stillUncertain) return null;
            return tx.operationalSignal.upsert({
              where: { tenantId_signalType_entityType_entityId: {
                tenantId: tenantId,
                signalType: 'receptionist_outbound_stop_unconfirmed_after_acceptance',
                entityType: 'receptionistCallLog', entityId: callLog.id,
              } },
              update: { severity: 'critical', score: 100, status: 'open', reason: 'Provider accepted an outbound call after a stop request, but provider cancellation was not confirmed.' },
              create: {
                tenantId: tenantId,
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
          const task = await runWithTenantContext(tenantId, async tx => {
            await lockOutboundDispatch(tx, tenantId);
            const stillUncertain = target
              ? await tx.receptionistCallTarget.findFirst({
                where: {
                  id: target.id, tenantId: tenantId, campaignId: campaign.id,
                  lastCallLogId: callLog.id, status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
                },
                select: { id: true },
              })
              : null;
            if (!stillUncertain) return null;
            const existingTask = await tx.staffTask.findFirst({
              where: { tenantId: tenantId, metadata: { path: ['callLogId'], equals: callLog.id } },
              select: { id: true },
            });
            return existingTask ?? tx.staffTask.create({ data: {
              tenantId: tenantId, branchId: campaign.defaultBranchId,
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
        await runWithTenantContext(tenantId, tx => tx.auditEvent.create({ data: {
          tenantId: tenantId, actorUserId: actorUserId,
          action: effectiveProviderStopApplied ? 'receptionist.call.cancelledAfterProviderAcceptance' : 'receptionist.call.reconciliationRequiredAfterProviderAcceptance',
          resource: 'receptionistCallLog', resourceId: callLog.id,
          requestId: actorRequestId, ipAddress: actorIp, userAgent: actorUserAgent,
          metadata: { campaignId: campaign.id, providerStopApplied: effectiveProviderStopApplied, reviewTaskId, signalId },
        } }));
          return true;
        } catch {
          return false;
        }
      })();
      const businessEventRecorded = await (async () => {
        try {
        await runWithTenantContext(tenantId, tx => tx.businessEvent.create({ data: {
          tenantId: tenantId,
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
        return answer(200, {
          status: 'cancelled', reason: 'outbound_stopped', callLogId: callLog.id, callId: providerCallId,
          providerStopApplied: true, auditRecorded, businessEventRecorded,
        });
      }
      return answer(202, {
        status: 'reconciliation_required', reason: 'outbound_stopped', callLogId: callLog.id,
        callId: providerCallId, providerStopApplied: false, error: providerStop.ok ? 'provider_stop_unconfirmed' : providerStop.error,
        reviewRecorded: reviewTaskId !== null, signalRecorded: signalId !== null,
        reviewTaskId, signalId, auditRecorded, businessEventRecorded,
      });
    };

    if (result.ok) {
      const [callAfterProvider, stoppedDuringProvider] = await Promise.all([
        db.receptionistCallLog.findFirst({ where: { id: callLog.id, tenantId: tenantId }, select: { outcome: true, endedAt: true } }),
        outboundStopped(tenantId),
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
      const safetyState = await runWithTenantContext(tenantId, async tx => {
        // Deployment safety mutations share the same canonical configuration
        // lock as Studio/outbound edits and provider-intent authorization. A
        // concurrent re-verification or campaign activation must therefore be
        // ordered either before this circuit trip (and then be invalidated) or
        // after it (and observe INVALID/PAUSED state).
        if (result.error === 'retell_deployment_mismatch') {
          await lockOutboundConfiguration(tx, tenantId);
        }
        await tx.receptionistCallLog.update({
          where: { id: callLog.id },
          data: { outcome: acceptanceUnknown ? 'ESCALATED' : 'FAILED', endedAt: new Date(), ...(result.callId ? { retellCallId: result.callId } : {}) },
        });
        if (body.targetId) {
          await tx.receptionistCallTarget.updateMany({
            where: { id: body.targetId, tenantId: tenantId, campaignId: campaign.id, status: 'CALLING' },
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
            where: { id: agentId, tenantId: tenantId },
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
              where: { tenantId: tenantId, agentId, status: { in: ['SCHEDULED', 'RUNNING'] } },
              data: { status: 'PAUSED' },
            }),
            tx.receptionistCampaign.updateMany({
              where: { tenantId: tenantId, agentId, status: 'ACTIVE' },
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
          signalId = await runWithTenantContext(tenantId, async tx => {
            const signal = await tx.operationalSignal.create({ data: {
              tenantId: tenantId,
              signalType: 'receptionist_outbound_provider_acceptance_unknown',
              entityType: 'receptionistCallLog', entityId: callLog.id,
              severity: 'critical', score: 100,
              reason: 'The outbound provider may have accepted a call, so automatic retry is disabled pending reconciliation.',
            } });
            const task = await tx.staffTask.create({ data: {
              tenantId: tenantId, branchId: campaign.defaultBranchId,
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
          signalId = await runWithTenantContext(tenantId, async tx => {
            const signal = await tx.operationalSignal.create({
              data: {
                tenantId: tenantId,
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
          tenantId: tenantId,
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
          reviewTaskId = await runWithTenantContext(tenantId, async tx => {
            const task = await tx.staffTask.create({ data: taskData(false) });
            await auditOutboundMutation(tx, { tenantId, actor }, {
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
            await auditOutboundMutation(tx, { tenantId, actor }, {
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
            const fallback = await runWithTenantContext(tenantId, tx => tx.staffTask.create({ data: taskData(true) }));
            reviewTaskId = fallback.id;
            reviewRecorded = true;
          } catch {
            reviewTaskId = null;
          }
        }
      } else if (!acceptanceUnknown) {
        try {
          await runWithTenantContext(tenantId, tx => auditOutboundMutation(tx, { tenantId, actor }, {
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
      return answer(acceptanceUnknown ? 202 : 502, {
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
        await lockOutboundDispatch(tx, tenantId);
        const usage = await tx.tenantAiUsage.findUnique({ where: { tenantId: tenantId }, select: { killSwitch: true } });
        const latestCampaign = await tx.receptionistOutboundCampaign.findFirst({ where: { id: campaign.id, tenantId: tenantId }, select: { status: true } });
        const latestCall = await tx.receptionistCallLog.findFirst({
          where: { id: callLog.id, tenantId: tenantId },
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
          where: { tenantId: tenantId, retellCallId: result.callId },
          select: { id: true },
        });
        if (collidingRetellCall !== null) {
          const endedAt = new Date();
          await tx.receptionistCallLog.update({
            where: { id: callLog.id },
            data: { outcome: 'ESCALATED', endedAt },
          });
          if (target) await tx.receptionistCallTarget.updateMany({
            where: { id: target.id, tenantId: tenantId, campaignId: campaign.id },
            data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: callLog.id },
          });
          await tx.auditEvent.create({ data: {
            tenantId: tenantId,
            actorUserId: actorUserId,
            action: 'receptionist.call.providerIdCollision',
            resource: 'receptionistCallLog',
            resourceId: callLog.id,
            metadata: { reusedRetellCallId: collidingRetellCall.id, providerStopRequired: true },
          } });
          return { cancelled: false as const, bound: 0, reusedRetellCallId: collidingRetellCall.id, collision: true as const };
        }
        const bound = await tx.receptionistCallLog.updateMany({
          where: { id: callLog.id, tenantId: tenantId, retellCallId: null, outcome: 'IN_PROGRESS', endedAt: null },
          data: { retellCallId: result.callId },
        });
        return { cancelled: false as const, bound: bound.count, collision: false as const, reusedRetellCallId: null };
      });
      if (binding.cancelled) return await cancelAcceptedCall(result.callId);
      if (binding.bound !== 1 && !binding.collision) throw new Error('provider_call_binding_lost');
      if (binding.collision) {
        if (binding.reusedRetellCallId) {
          log.warn({
            callLogId: callLog.id, providerCallId: result.callId, reusedRetellCallId: binding.reusedRetellCallId, tenantId: tenantId,
          }, 'Provider call ID collision encountered while binding outbound call intent');
        } else {
          log.warn({
            callLogId: callLog.id, providerCallId: result.callId, tenantId: tenantId,
          }, 'Provider call binding collision encountered while binding outbound call intent');
        }
        throw new Error('provider_call_id_collision');
      }
      await providerBoundaryTestHook?.('provider_binding_committed');
      if (await outboundStopped(tenantId)) {
        const stoppedCall = await db.receptionistCallLog.findFirst({
          where: { id: callLog.id, tenantId: tenantId }, select: { outcome: true, endedAt: true },
        });
        if (stoppedCall?.outcome === 'FAILED' && stoppedCall.endedAt) {
          return answer(200, { status: 'cancelled', reason: 'outbound_stopped', callLogId: callLog.id, callId: result.callId, providerStopApplied: true });
        }
        return await cancelAcceptedCall(result.callId);
      }
    } catch {
      const stopped = await stopPhoneCall(result.callId).catch(() => ({ ok: false, applied: false, error: 'provider_stop_failed' as const }));
      await db.$transaction(async tx => {
        await lockOutboundDispatch(tx, tenantId);
        const exactBoundCall = target ? await tx.receptionistCallLog.findFirst({
          where: {
            id: callLog.id, tenantId: tenantId, outboundCampaignId: campaign.id,
            targetId: target.id, retellCallId: result.callId,
          },
          select: { id: true },
        }) : null;
        if (stopped.ok && stopped.applied && target && exactBoundCall) {
          await applyConfirmedProviderStopTx(tx, {
            tenantId: tenantId,
            campaignId: campaign.id,
            targetId: target.id,
            callLogId: callLog.id,
            providerCallId: result.callId,
          }, actor);
          return;
        }
        const confirmedTarget = target ? await tx.receptionistCallTarget.findFirst({
          where: {
            id: target.id, tenantId: tenantId, campaignId: campaign.id,
            lastCallLogId: callLog.id, status: 'FAILED', lastOutcome: 'OUTBOUND_STOPPED',
          },
          select: { id: true },
        }) : null;
        if (confirmedTarget) return;
        await tx.receptionistCallLog.updateMany({
          where: {
            id: callLog.id, tenantId: tenantId,
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
            id: target.id, tenantId: tenantId, campaignId: campaign.id,
            lastCallLogId: callLog.id,
            OR: [{ status: 'CALLING' }, { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED' }],
          },
          data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: callLog.id },
        });
      }).catch(() => undefined);
      let reviewRecorded = false;
      try {
        await runWithTenantContext(tenantId, async tx => {
          await lockOutboundDispatch(tx, tenantId);
          const stillUncertain = target ? await tx.receptionistCallTarget.findFirst({
            where: {
              id: target.id, tenantId: tenantId, campaignId: campaign.id,
              lastCallLogId: callLog.id, status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
            },
            select: { id: true },
          }) : null;
          if (!stillUncertain) return;
          await tx.operationalSignal.upsert({
            where: { tenantId_signalType_entityType_entityId: {
              tenantId: tenantId,
              signalType: 'receptionist_outbound_local_binding_failed',
              entityType: 'receptionistCallLog', entityId: callLog.id,
            } },
            update: {
              severity: 'critical', score: 100, status: 'open',
              reason: 'Provider accepted the call but local binding failed; provider stop was attempted and staff reconciliation is required.',
            },
            create: {
            tenantId: tenantId, signalType: 'receptionist_outbound_local_binding_failed',
            entityType: 'receptionistCallLog', entityId: callLog.id, severity: 'critical', score: 100,
            reason: 'Provider accepted the call but local binding failed; provider stop was attempted and staff reconciliation is required.',
            },
          });
          const existingTask = await tx.staffTask.findFirst({
            where: { tenantId: tenantId, metadata: { path: ['callLogId'], equals: callLog.id } },
            select: { id: true },
          });
          if (!existingTask) await tx.staffTask.create({ data: {
              tenantId: tenantId, branchId: campaign.defaultBranchId,
              title: 'Reconcile provider-accepted outbound call', priority: 'CRITICAL',
              metadata: { workflow: 'receptionist_outbound_reconciliation', callLogId: callLog.id, providerCallId: result.callId, providerStopApplied: stopped.ok && stopped.applied },
            } });
          reviewRecorded = true;
        });
      } catch {
        // ESCALATED and non-dialable state are the primary durable controls.
      }
      return answer(202, {
        status: 'reconciliation_required', callId: result.callId, callLogId: callLog.id,
        providerStopApplied: stopped.ok && stopped.applied, reviewRecorded,
      });
    }
    let trackingDegraded = false;
    if (body.targetId) {
      const linked = await db.receptionistCallTarget.updateMany({
        where: { id: body.targetId, tenantId: tenantId, campaignId: campaign.id, status: 'CALLING' },
        data: { lastCallLogId: callLog.id },
      }).catch(() => ({ count: 0 }));
      trackingDegraded ||= linked.count !== 1;
    }
    try {
      await launchAudit({
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
    return answer(201, { status: 'launched', callId: result.callId, callLogId: callLog.id, mock: result.mock, trackingDegraded });
}
