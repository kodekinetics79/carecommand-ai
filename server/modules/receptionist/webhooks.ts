import type { FastifyPluginAsync } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { targetStatusAfterOutcome, MAX_TENANT_ACTIVE_CALLS, DEFAULT_VOICE_MINUTES_LIMIT } from './outbound';
import { recordUsageEvent, periodUsageTotal, voiceCallDedupeKey, USAGE_METRICS } from '../../lib/usageMetering';
import { liveCallingBlockReason } from '../../lib/tenantMode';
import { handleAgentTool, requestHumanHandoff, type TrustedBookingContext } from '../../lib/receptionist/liveTools';
import { ingestCallArtifacts } from '../../lib/receptionist/privacyLifecycle';
import { enterTenantContext, runWithTenantContext } from '../../lib/tenantContext';
import { resolveIngressTenant } from '../../lib/tenantIngressResolvers';
import { isFeatureEnabled } from '../../lib/entitlements';
import { platformDb } from '../../lib/platformDb';
import { stopPhoneCall } from '../../lib/retell';
import { agentReadinessReason } from '../../lib/receptionist/agentReadiness';
import { lockDncDestinationFence } from '../../lib/receptionist/dncFence';
import { enforceInvalidRetellSignatureRateLimit, enforceVerifiedRetellRateLimit } from '../../lib/receptionist/providerRateLimit';
import { recoverOutboundProviderIntent } from '../../lib/receptionist/providerIntentRecovery';
import { retellRateStore } from '../../lib/receptionist/retellRateStore';
import { fingerprintJson, type IntakeContractSnapshot } from './intakeContract';
import { callHoursStamp } from '../../lib/receptionist/hoursSource';
import { recordWorkflowEvent } from '../../lib/intelligence';
import { uuid } from './shared';

/**
 * Retell reports why a call ended. `call_transfer` is explicit evidence that
 * the provider handed the call to a human; every other reason is 'unknown'
 * rather than an invented failure class (the provider has no transfer_failed
 * disposition). C4's markTransferOutcome reads the stamped column.
 */
function transferOutcomeFor(disconnectionReason: string | undefined): 'connected' | 'unknown' | null {
  if (!disconnectionReason) return null;
  return disconnectionReason === 'call_transfer' ? 'connected' : 'unknown';
}

const RECEPTIONIST_CALL_LEASE_MS = 4 * 60 * 60 * 1_000;

// --- Idempotency + signature helpers for the public webhook ----------------
const RETELL_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1_000;

// Current Retell contract: `v=<unix-ms>,d=<hex>` where the digest covers the
// exact raw body bytes followed by the timestamp text. Strict parsing rejects
// duplicate/extra fields and the freshness window prevents captured replay.
export function verifyRetellSignature(
  rawBody: Buffer | undefined,
  signature: string | string[] | undefined,
  apiKey: string,
  nowMs = Date.now(),
): boolean {
  if (!rawBody || typeof signature !== 'string' || !apiKey) return false;
  const match = /^v=(\d{13}),d=([a-fA-F0-9]{64})$/.exec(signature);
  if (!match) return false;
  const timestampText = match[1];
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs - timestamp) > RETELL_SIGNATURE_TOLERANCE_MS) return false;
  const expected = createHmac('sha256', apiKey).update(rawBody).update(timestampText).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const signatureBuffer = Buffer.from(match[2], 'hex');
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

async function enforceTrustedRetellCallbackRate(tenantId: string, providerCallId: string, kind: 'event' | 'tool') {
  return enforceVerifiedRetellRateLimit({
    tenantId,
    providerCallId,
    kind,
    redis: retellRateStore,
    production: env.NODE_ENV === 'production',
  });
}

async function enforceInvalidRetellCallbackRate(source: string) {
  return enforceInvalidRetellSignatureRateLimit({
    source,
    redis: retellRateStore,
    production: env.NODE_ENV === 'production',
  });
}

function canonicalRetellDestination(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/[().\s-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

const INBOUND_DEPLOYMENT_BOUND_TOOLS = new Set([
  'record_recording_preference',
  'verify_patient_identity',
  'list_upcoming_appointments',
  'prepare_appointment_change',
  'cancel_appointment',
  'reschedule_appointment',
  'book_appointment',
  'take_message',
]);

type VerifiedInboundDeployment = {
  localAgentId: string;
  providerAgentId: string;
  providerAgentVersion: number;
  providerConfigRevision: number;
  providerFingerprint: string;
};

async function resolveVerifiedInboundDeployment(input: {
  tenantId: string;
  clinicId: string | undefined;
  providerAgentId: string | undefined;
  providerAgentVersion: number | undefined;
}): Promise<{ deployment: VerifiedInboundDeployment | null; reason: string | null }> {
  if (!input.clinicId) return { deployment: null, reason: 'clinic_binding_missing' };
  if (!input.providerAgentId || input.providerAgentVersion === undefined) {
    return { deployment: null, reason: 'provider_deployment_evidence_missing' };
  }
  const candidates = await db.receptionistAgent.findMany({
    where: {
      tenantId: input.tenantId,
      clinicId: input.clinicId,
      providerAgentId: input.providerAgentId,
      providerVersion: input.providerAgentVersion,
    },
    select: {
      id: true,
      active: true,
      providerAgentId: true,
      providerVersion: true,
      providerStatus: true,
      providerConfigRevision: true,
      providerVerifiedRevision: true,
      providerVerifiedAt: true,
      providerVerificationExpiresAt: true,
      providerFingerprint: true,
    },
    take: 2,
  });
  const ready = candidates.filter(candidate => agentReadinessReason(candidate) === null && Boolean(candidate.providerFingerprint));
  if (ready.length !== 1) {
    return { deployment: null, reason: candidates.length > 1 ? 'provider_deployment_ambiguous' : 'provider_deployment_unverified_or_stale' };
  }
  const deployment = ready[0];
  return {
    deployment: {
      localAgentId: deployment.id,
      providerAgentId: deployment.providerAgentId!,
      providerAgentVersion: deployment.providerVersion!,
      providerConfigRevision: deployment.providerConfigRevision,
      providerFingerprint: deployment.providerFingerprint!,
    },
    reason: null,
  };
}

function callMatchesInboundDeployment(
  call: {
    boundProviderAgentId: string | null;
    boundProviderAgentVersion: number | null;
    boundProviderConfigRevision: number | null;
    boundProviderFingerprint: string | null;
  },
  deployment: VerifiedInboundDeployment,
) {
  const values = [
    call.boundProviderAgentId,
    call.boundProviderAgentVersion,
    call.boundProviderConfigRevision,
    call.boundProviderFingerprint,
  ];
  const unbound = values.every(value => value === null);
  if (unbound) return 'unbound' as const;
  const matches = call.boundProviderAgentId === deployment.providerAgentId
    && call.boundProviderAgentVersion === deployment.providerAgentVersion
    && call.boundProviderConfigRevision === deployment.providerConfigRevision
    && call.boundProviderFingerprint === deployment.providerFingerprint;
  return matches ? 'matched' as const : 'mismatched' as const;
}

function opaqueIngressReference(value: string | undefined): string {
  return createHash('sha256').update(value ?? 'missing').digest('hex');
}

async function flagRetellIngressReview(tenantId: string, callId: string, reason: string) {
  const entityId = opaqueIngressReference(callId);
  await db.operationalSignal.upsert({
    where: { tenantId_signalType_entityType_entityId: { tenantId, signalType: 'RECEPTIONIST_INGRESS_REVIEW', entityType: 'retell_call', entityId } },
    update: { severity: 'high', score: 100, reason, status: 'open' },
    create: { tenantId, signalType: 'RECEPTIONIST_INGRESS_REVIEW', entityType: 'retell_call', entityId, severity: 'high', score: 100, reason, status: 'open' },
  });
}

async function flagUnresolvedRetellIngress(callId: string | undefined, destination: string | null, direction: string | undefined) {
  await platformDb.platformAuditEvent.create({
    data: {
      action: 'receptionist.ingress.unresolved',
      targetType: 'retell_ingress',
      targetId: opaqueIngressReference(callId).slice(0, 32),
      metadata: {
        callRef: opaqueIngressReference(callId).slice(0, 32),
        destinationRef: opaqueIngressReference(destination ?? undefined).slice(0, 32),
        direction: direction ?? 'unknown',
        disposition: 'manual_configuration_review',
      },
    },
  });
}

async function persistProviderIntentRecoveryReview(input: {
  tenantId: string;
  callLogId: string;
  providerCallId: string;
  reason: string;
  providerStopApplied: boolean;
}) {
  let signalId: string | null = null;
  let reviewTaskId: string | null = null;
  try {
    signalId = await runWithTenantContext(input.tenantId, async tx => {
      const signal = await tx.operationalSignal.upsert({
        where: { tenantId_signalType_entityType_entityId: {
          tenantId: input.tenantId,
          signalType: 'receptionist_outbound_provider_intent_recovery',
          entityType: 'receptionistCallLog',
          entityId: input.callLogId,
        } },
        update: {
          severity: 'critical', score: 100, status: 'open',
          reason: `Provider-intent recovery requires staff reconciliation (${input.reason}); provider stop confirmed=${input.providerStopApplied}.`,
        },
        create: {
          tenantId: input.tenantId,
          signalType: 'receptionist_outbound_provider_intent_recovery',
          entityType: 'receptionistCallLog',
          entityId: input.callLogId,
          severity: 'critical', score: 100, status: 'open',
          reason: `Provider-intent recovery requires staff reconciliation (${input.reason}); provider stop confirmed=${input.providerStopApplied}.`,
        },
      });
      return signal.id;
    });
  } catch {
    // The task below is an independent recovery-evidence path.
  }
  try {
    reviewTaskId = await runWithTenantContext(input.tenantId, async tx => {
      const prior = await tx.staffTask.findFirst({
        where: {
          tenantId: input.tenantId,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          AND: [
            { metadata: { path: ['workflow'], equals: 'receptionist_provider_intent_recovery' } },
            { metadata: { path: ['callLogId'], equals: input.callLogId } },
          ],
        },
        select: { id: true },
      });
      if (prior) return prior.id;
      const call = await tx.receptionistCallLog.findFirst({
        where: { id: input.callLogId, tenantId: input.tenantId },
        select: { outboundCampaign: { select: { defaultBranchId: true } } },
      });
      const task = await tx.staffTask.create({ data: {
        tenantId: input.tenantId,
        branchId: call?.outboundCampaign?.defaultBranchId,
        title: 'Urgent: reconcile recovered outbound provider call',
        priority: 'CRITICAL',
        metadata: {
          workflow: 'receptionist_provider_intent_recovery',
          callLogId: input.callLogId,
          providerCallId: input.providerCallId,
          reason: input.reason,
          providerStopApplied: input.providerStopApplied,
        },
      } });
      return task.id;
    });
  } catch {
    // Return both evidence flags so callers can surface degraded tracking.
  }
  return {
    signalId,
    reviewTaskId,
    signalRecorded: signalId !== null,
    reviewRecorded: reviewTaskId !== null,
  };
}

async function admitInboundReceptionist(tenantId: string, providerCallId: string, reservation: {
  clinicId?: string; campaignId?: string; callerPhone?: string; direction?: string; enforceAdmission?: boolean;
} = {}) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-capacity:${tenantId}`})::bigint)`;
    const existing = await tx.receptionistCallLog.findFirst({ where: { tenantId, retellCallId: providerCallId }, select: { id: true } });
    if (reservation.enforceAdmission !== false && !(await isFeatureEnabled(tenantId, 'ai_receptionist', tx))) return { allowed: false as const, reason: 'feature_locked' };
    if (reservation.enforceAdmission === false) {
      // Terminal delivery may bypass a newly enabled kill switch only to
      // reconcile a call that was already admitted. It must not bootstrap an
      // unknown/unadmitted provider call.
      if (!existing) return { allowed: false as const, reason: 'terminal_without_active_call' };
      return { allowed: true as const, reserved: false };
    }
    // A dropped terminal webhook must not consume tenant capacity forever.
    // Expire only clearly stale in-progress rows under the same capacity lock;
    // a late terminal event can still reconcile the provider's final outcome.
    const leaseCutoff = new Date(Date.now() - RECEPTIONIST_CALL_LEASE_MS);
    const staleCalls = await tx.receptionistCallLog.findMany({
      where: {
        tenantId,
        outcome: 'IN_PROGRESS',
        endedAt: null,
        // A committed provider intent with no local provider id may represent
        // acceptance immediately before a process crash. Only signed recovery
        // or explicit operator reconciliation may close that uncertainty.
        outboundProviderIntent: { is: null },
        OR: [
          { startedAt: { lt: leaseCutoff } },
          { startedAt: null, createdAt: { lt: leaseCutoff } },
        ],
      },
      select: { id: true },
    });
    if (staleCalls.length) {
      const endedAt = new Date();
      await tx.receptionistCallLog.updateMany({
        where: { id: { in: staleCalls.map(call => call.id) }, tenantId, outcome: 'IN_PROGRESS', endedAt: null },
        data: { outcome: 'FAILED', endedAt },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          action: 'receptionist.call_lease.expired',
          resource: 'receptionistCapacity',
          resourceId: tenantId,
          userAgent: 'receptionist-admission',
          metadata: { closedCount: staleCalls.length, leaseHours: RECEPTIONIST_CALL_LEASE_MS / 3_600_000, durationUnverified: true },
        },
      });
    }
    const aiUsage = await tx.tenantAiUsage.upsert({
      where: { tenantId },
      update: {},
      create: { tenantId },
      select: { receptionistMinutes: true, overageAllowed: true, killSwitch: true },
    });
    if (aiUsage.killSwitch) return { allowed: false as const, reason: 'kill_switch' };
    // A demonstration workspace must never answer a real patient. Checked above
    // every quota so the answer does not depend on how much allowance is left.
    const modeBlock = await liveCallingBlockReason(tenantId, tx);
    if (modeBlock) return { allowed: false as const, reason: modeBlock };
    const voiceUsage = await tx.tenantUsageLimit.upsert({
      where: { tenantId_key: { tenantId, key: 'voice_minutes' } },
      update: {},
      create: { tenantId, key: 'voice_minutes', limitValue: DEFAULT_VOICE_MINUTES_LIMIT, used: aiUsage.receptionistMinutes },
      select: { used: true, limitValue: true },
    });
    const activeCalls = await tx.receptionistCallLog.count({
      where: { tenantId, outcome: 'IN_PROGRESS', endedAt: null, retellCallId: { not: providerCallId } },
    });
    if (activeCalls >= MAX_TENANT_ACTIVE_CALLS) return { allowed: false as const, reason: 'concurrency_limit_reached' };
    // Included minutes are per billing period. TenantUsageLimit.used and
    // TenantAiUsage.receptionistMinutes are LIFETIME counters that nothing ever
    // resets, so enforcing on them meant a clinic stopped answering its
    // patients' calls permanently once it had used its allowance once.
    const usedMinutes = await periodUsageTotal(tx, tenantId, USAGE_METRICS.voiceMinute);
    if (!aiUsage.overageAllowed && voiceUsage.limitValue !== null && usedMinutes + activeCalls >= voiceUsage.limitValue) {
      return { allowed: false as const, reason: 'voice_minutes_limit_reached' };
    }
    if (!existing) await tx.receptionistCallLog.create({ data: { tenantId, clinicId: reservation.clinicId, campaignId: reservation.campaignId, retellCallId: providerCallId, callerPhone: reservation.callerPhone, direction: reservation.direction ?? 'inbound', startedAt: new Date() } });
    return { allowed: true as const, reserved: !existing };
  });
}

async function flagInboundAdmissionDenied(tenantId: string, providerCallId: string, reason: string) {
  await flagRetellIngressReview(tenantId, providerCallId, `Inbound receptionist admission denied: ${reason}`);
}

// ===== Public webhook (no JWT — Retell posts events here) =================
export const receptionistWebhookRoutes: FastifyPluginAsync = async app => {
  app.post('/webhooks/retell', {
    // Retell publishes a shared callback IP, so the app's global IP bucket can
    // drop valid callbacks across unrelated tenants. Authentication happens
    // first; trusted tenant/call Redis limits are applied below.
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = z.object({ clinicId: uuid.optional(), campaignId: uuid.optional() }).parse(request.query);
    const body = z.object({
      event: z.string().optional(),
      call: z.object({
        call_id: z.string().optional(),
        agent_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
        agent_version: z.number().int().nonnegative().optional(),
        from_number: z.string().optional(),
        to_number: z.string().optional(),
        direction: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        recording_url: z.string().optional(),
        disconnection_reason: z.string().max(120).optional(),
        call_analysis: z.object({
          call_summary: z.string().optional(),
          user_sentiment: z.string().optional(),
          custom_analysis_data: z.record(z.string(), z.unknown()).optional(),
        }).partial().optional(),
        duration_ms: z.number().optional(),
      }).partial().optional(),
    }).partial().parse(request.body ?? {});

    const call = body.call ?? {};

    // Signature verification — unverifiable webhooks never establish tenant
    // authority in any environment.
    const signatureRaw = request.headers['x-retell-signature'];
    if (env.RETELL_API_KEY) {
      if (!verifyRetellSignature(request.rawBody, signatureRaw, env.RETELL_API_KEY)) {
        const invalidRate = await enforceInvalidRetellCallbackRate(request.ip);
        const sourceRef = opaqueIngressReference(request.ip).slice(0, 16);
        if (!invalidRate.allowed && invalidRate.reason === 'source_limit') {
          request.log.warn({ sourceRef, decision: invalidRate.reason }, 'Retell invalid-signature source rate limited');
          return reply.code(429).send({ error: 'INVALID_SIGNATURE_RATE_LIMITED' });
        }
        request.log.warn({ sourceRef, decision: invalidRate.allowed ? 'rejected' : invalidRate.reason }, 'Retell webhook signature verification failed');
        return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      }
    } else {
      const invalidRate = await enforceInvalidRetellCallbackRate(request.ip);
      const sourceRef = opaqueIngressReference(request.ip).slice(0, 16);
      if (!invalidRate.allowed && invalidRate.reason === 'source_limit') {
        request.log.warn({ sourceRef, decision: invalidRate.reason }, 'Unconfigured Retell webhook source rate limited');
        return reply.code(429).send({ error: 'WEBHOOK_NOT_CONFIGURED_RATE_LIMITED' });
      }
      request.log.error({ sourceRef, decision: invalidRate.allowed ? 'rejected' : invalidRate.reason }, 'Retell webhook rejected: RETELL_API_KEY not configured');
      return reply.code(503).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
    }

    // Retell's signature authenticates the exact provider body globally. A
    // persisted opaque call id remains the primary mapping. For the first event
    // of an inbound call only, the signed destination number may bootstrap a
    // tenant when it maps to exactly one active clinic. Outbound `to_number` is
    // the patient destination and is therefore never tenant authority.
    const providerCallId = call.call_id?.trim();
    const endedEvent = body.event === 'call_ended' || body.event === 'call_analyzed';
    const callResolution = providerCallId
      ? await resolveIngressTenant('retell_call_id', providerCallId)
      : null;
    const intentRecovery = !callResolution && providerCallId
      ? await recoverOutboundProviderIntent({
        metadata: call.metadata,
        providerCallId,
        providerAgentId: call.agent_id,
        providerAgentVersion: call.agent_version,
        terminalEvent: endedEvent,
      })
      : null;
    const recoveredResolution = intentRecovery?.recognized
      ? { tenantId: intentRecovery.tenantId, resourceId: intentRecovery.callLogId }
      : null;
    const signedDestination = call.direction === 'inbound'
      ? canonicalRetellDestination(call.to_number)
      : null;
    const destinationResolution = !callResolution && !recoveredResolution && providerCallId && signedDestination
      ? await resolveIngressTenant('retell_destination_phone', signedDestination)
      : null;
    const resolved = callResolution ?? recoveredResolution ?? destinationResolution;
    const resolvedByDestination = Boolean(destinationResolution);
    if (!resolved || !providerCallId) {
      request.log.warn({
        callRef: opaqueIngressReference(providerCallId).slice(0, 16),
        destinationRef: opaqueIngressReference(signedDestination ?? undefined).slice(0, 16),
        direction: call.direction ?? 'unknown',
      }, 'Signed Retell webhook requires manual ingress mapping review');
      await flagUnresolvedRetellIngress(providerCallId, signedDestination, call.direction);
      return reply.code(202).send({ ok: true, ignored: true, reason: 'unresolved_call' });
    }
    const tenantId = resolved.tenantId;
    enterTenantContext({ tenantId, actorId: `webhook:retell:${resolved.resourceId}`, actorRole: 'WEBHOOK', source: 'webhook', requestId: request.id });
    if (intentRecovery?.recognized && intentRecovery.quarantined) {
      const stopped = intentRecovery.stopRequired
        ? await stopPhoneCall(providerCallId)
        : { applied: false as const };
      await flagRetellIngressReview(
        tenantId,
        providerCallId,
        `Recovered outbound provider intent was quarantined: ${intentRecovery.reason}; provider_stop_applied=${stopped.applied}`,
      ).catch(() => undefined);
      const review = await persistProviderIntentRecoveryReview({
        tenantId,
        callLogId: intentRecovery.callLogId,
        providerCallId,
        reason: intentRecovery.reason,
        providerStopApplied: stopped.applied,
      });
      if (intentRecovery.stopRequired) {
        return reply.code(202).send({
          ok: true,
          ignored: true,
          reason: 'provider_intent_quarantined',
          providerStopApplied: stopped.applied,
          ...review,
        });
      }
    }
    let trustedClinicId: string | undefined = resolvedByDestination ? resolved.resourceId : undefined;
    let trustedCampaignId: string | undefined;
    if (query.campaignId) {
      const campaign = await db.receptionistCampaign.findFirst({ where: { id: query.campaignId, tenantId }, select: { clinicId: true } });
      if (!campaign || (trustedClinicId && campaign.clinicId !== trustedClinicId) || (query.clinicId && campaign.clinicId !== query.clinicId)) {
        await flagRetellIngressReview(tenantId, providerCallId, 'Signed Retell webhook selectors did not match the trusted clinic mapping');
        return reply.code(202).send({ ok: true, ignored: true });
      }
      trustedCampaignId = query.campaignId;
      trustedClinicId = campaign.clinicId;
    } else if (query.clinicId) {
      const clinic = await db.receptionistClinic.findFirst({ where: { id: query.clinicId, tenantId }, select: { id: true } });
      if (!clinic || (trustedClinicId && clinic.id !== trustedClinicId)) {
        await flagRetellIngressReview(tenantId, providerCallId, 'Signed Retell webhook clinic selector did not match the trusted clinic mapping');
        return reply.code(202).send({ ok: true, ignored: true });
      }
      trustedClinicId = clinic.id;
    }

    // Query selectors are not covered by Retell's body signature, so validate
    // them before counting. Never discard terminal lifecycle/usage
    // reconciliation: it is signed, mapped, serialized, and delta-idempotent.
    if (!endedEvent) {
      const rate = await enforceTrustedRetellCallbackRate(tenantId, providerCallId, 'event');
      if (!rate.allowed) {
        const decision = rate.reason;
        const refs = {
          tenantRef: opaqueIngressReference(tenantId).slice(0, 16),
          callRef: opaqueIngressReference(providerCallId).slice(0, 16),
          decision,
        };
        if (decision === 'store_unavailable') {
          request.log.error(refs, 'Retell verified callback rate store unavailable');
          return reply.code(503).send({ error: 'CALLBACK_RATE_LIMIT_UNAVAILABLE' });
        }
        request.log.warn(refs, 'Retell verified callback rate limited');
        return reply.code(429).send({ error: 'CALLBACK_RATE_LIMITED', reason: decision });
      }
    }

    if (call.direction === 'inbound' || resolvedByDestination) {
      const admission = await admitInboundReceptionist(tenantId, providerCallId, {
        clinicId: trustedClinicId,
        campaignId: trustedCampaignId,
        callerPhone: call.from_number,
        direction: 'inbound',
        // A terminal lifecycle event must always reconcile an already-started
        // provider call, even when a kill switch was enabled in the meantime.
        enforceAdmission: !endedEvent,
      });
      if (!admission.allowed) {
        const stopped = await stopPhoneCall(providerCallId);
        await flagInboundAdmissionDenied(tenantId, providerCallId, `${admission.reason}; provider_stop_applied=${stopped.applied}`);
        return reply.code(202).send({ ok: true, ignored: true, reason: 'admission_denied', providerStopApplied: stopped.applied });
      }
    }

    // Audit receipt of the (verified) webhook. No PHI — call id + event only.
    await db.auditEvent.create({
      data: {
        tenantId,
        action: 'receptionist.webhook.received',
        resource: 'receptionistWebhook',
        resourceId: providerCallId,
        ipAddress: request.ip,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
        metadata: { event: body.event ?? null },
      },
    }).catch(() => {});

    const analysis = call.call_analysis ?? {};
    const custom = (analysis.custom_analysis_data ?? {}) as Record<string, unknown>;
    const outcomeRaw = String(custom.outcome ?? '').toUpperCase();
    type CallOutcome = 'IN_PROGRESS' | 'BOOKED' | 'NOT_INTERESTED' | 'NO_ANSWER' | 'VOICEMAIL' | 'ESCALATED' | 'OPTED_OUT' | 'FAILED';
    const validOutcomes: ReadonlyArray<Exclude<CallOutcome, 'IN_PROGRESS'>> = ['BOOKED', 'NOT_INTERESTED', 'NO_ANSWER', 'VOICEMAIL', 'ESCALATED', 'OPTED_OUT', 'FAILED'];
    const durationSeconds = call.duration_ms ? Math.round(call.duration_ms / 1000) : 0;
    const ended = endedEvent;
    const existingCall = await db.receptionistCallLog.findFirst({ where: { retellCallId: providerCallId, tenantId } });
    trustedClinicId ??= existingCall?.clinicId ?? undefined;
    const canonicalBookingRequest = existingCall
      ? await db.appointmentRequest.findFirst({
        where: { tenantId, callLogId: existingCall.id, status: 'BOOKED', bookedAppointmentId: { not: null } },
        select: { bookedAppointmentId: true },
      })
      : null;
    const canonicalBooking = canonicalBookingRequest?.bookedAppointmentId
      ? await db.appointment.findFirst({
        where: { id: canonicalBookingRequest.bookedAppointmentId, tenantId, receptionistCallLogId: existingCall!.id, deletedAt: null },
        select: { id: true },
      })
      : null;
    // Provider/LLM analysis alone is not proof of a booking. Without the
    // canonical Appointment created by the signed live tool, route to review.
    const normalizedOutcomeRaw = outcomeRaw === 'BOOKED' && !canonicalBooking ? 'ESCALATED' : outcomeRaw;
    const outcome: CallOutcome = validOutcomes.includes(normalizedOutcomeRaw as Exclude<CallOutcome, 'IN_PROGRESS'>)
      ? normalizedOutcomeRaw as Exclude<CallOutcome, 'IN_PROGRESS'>
      : 'IN_PROGRESS';

    // Was the clinic open when this call arrived? Computed once, from the
    // clinic's own hours, and stored: recomputing it later against today's
    // configuration would rewrite history. Null means "hours not configured",
    // never "the clinic was open".
    const hoursStamp = existingCall?.outsideHours === undefined || existingCall?.outsideHours === null
      ? await callHoursStamp(db, { tenantId, clinicId: trustedClinicId ?? existingCall?.clinicId ?? null, at: existingCall?.startedAt ?? new Date() })
      : { outsideHours: existingCall.outsideHours };
    const transferOutcome = transferOutcomeFor(call.disconnection_reason);

    // Serialize lifecycle and usage accounting for this provider call. Retell
    // commonly sends call_ended and call_analyzed with the same duration; only
    // the positive billable-minute delta is charged, so replay cannot inflate
    // tenant usage or bypass the outbound spend gate.
    const persistedCall = await db.$transaction(async tx => {
      const lifecycleKey = `receptionist-call-lifecycle:${tenantId}:${providerCallId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lifecycleKey})::bigint)`;
      const current = await tx.receptionistCallLog.findFirst({ where: { retellCallId: providerCallId, tenantId } });
      // Canonical booking evidence wins. Otherwise the first terminal outcome
      // is immutable under later provider analysis/redelivery.
      const persistedOutcome: CallOutcome = canonicalBooking
        ? 'BOOKED'
        : current && current.outcome !== 'IN_PROGRESS'
          ? current.outcome
          : outcome;
      const row = current
        ? await tx.receptionistCallLog.update({
          where: { id: current.id },
          data: {
            outcome: persistedOutcome,
            sentiment: analysis.user_sentiment,
            durationSeconds: Math.max(current.durationSeconds, durationSeconds),
            // Stamped once; a later redelivery must not flip it.
            ...(current.outsideHours === null ? { outsideHours: hoursStamp.outsideHours } : {}),
            ...(transferOutcome && current.transferOutcome === null ? { transferOutcome } : {}),
            endedAt: ended ? (current.endedAt ?? new Date()) : undefined,
          },
        })
        : await tx.receptionistCallLog.create({
          data: {
            tenantId,
            clinicId: trustedClinicId,
            campaignId: trustedCampaignId,
            retellCallId: providerCallId,
            callerPhone: call.from_number,
            direction: call.direction ?? 'outbound',
            outcome: persistedOutcome,
            sentiment: analysis.user_sentiment,
            durationSeconds,
            outsideHours: hoursStamp.outsideHours,
            startedAt: new Date(),
            endedAt: ended ? new Date() : undefined,
          },
        });
      if (ended) {
        const priorMinutes = current ? Math.ceil(current.durationSeconds / 60) : 0;
        const finalMinutes = Math.ceil(row.durationSeconds / 60);
        const delta = Math.max(0, finalMinutes - priorMinutes);
        if (delta > 0) {
          // The billable record, in the same transaction as the call row it
          // describes. Keyed to the cumulative minute total, so a redelivered
          // terminal event is a no-op and a call later corrected upward bills
          // only the increment.
          await recordUsageEvent(tx, {
            tenantId,
            metric: USAGE_METRICS.voiceMinute,
            quantity: delta,
            occurredAt: row.endedAt ?? new Date(),
            sourceModule: 'receptionist',
            sourceType: 'receptionistCallLog',
            sourceId: row.id,
            dedupeKey: voiceCallDedupeKey(providerCallId, finalMinutes),
          });
          // Lifetime totals are kept for the operator's "since day one" view.
          // They are no longer what the quota is enforced against.
          await tx.tenantAiUsage.upsert({
            where: { tenantId },
            update: { receptionistMinutes: { increment: delta } },
            create: { tenantId, receptionistMinutes: delta },
          });
          await tx.tenantUsageLimit.upsert({
            where: { tenantId_key: { tenantId, key: 'voice_minutes' } },
            update: { used: { increment: delta } },
            create: { tenantId, key: 'voice_minutes', limitValue: DEFAULT_VOICE_MINUTES_LIMIT, used: delta },
          });
        }
      }
      return row;
    });

    // An inbound call the clinic was closed for is a real operational fact the
    // front desk needs: emitted once, when the row is first stamped.
    if (persistedCall.outsideHours === true && persistedCall.direction === 'inbound' && existingCall?.outsideHours !== true) {
      await recordWorkflowEvent(tenantId, {
        eventType: 'receptionist.call.after_hours',
        entityType: 'receptionistCallLog',
        entityId: persistedCall.id,
        sourceModule: 'receptionist',
        payload: { clinicId: persistedCall.clinicId, direction: persistedCall.direction },
      });
    }

    // Provider/LLM analysis is never accepted as legal consent evidence. Only
    // the signed, idempotent in-call recording-preference tool may create it.
    await ingestCallArtifacts({
      tenantId,
      callLogId: persistedCall.id,
      recordingUrl: call.recording_url,
      transcriptSummary: analysis.call_summary,
      retentionFrom: ended ? new Date() : undefined,
    });

    // Move an owned outbound target out of CALLING exactly once. Retryable
    // outcomes return to PENDING only while the configured retry allowance
    // remains; terminal states cannot be reopened by webhook redelivery.
    if (existingCall?.targetId && existingCall.outboundCampaignId && ended) {
      const target = await db.receptionistCallTarget.findFirst({
        where: { id: existingCall.targetId, tenantId, campaignId: existingCall.outboundCampaignId },
        include: { campaign: { select: { maxRetryAttempts: true } } },
      });
      const nextStatus = target ? targetStatusAfterOutcome(outcomeRaw, target.attempts, target.campaign.maxRetryAttempts) : null;
      if (target && nextStatus) {
        await db.receptionistCallTarget.updateMany({
          where: { id: target.id, tenantId, campaignId: existingCall.outboundCampaignId, status: 'CALLING' },
          data: { status: nextStatus, lastOutcome: outcomeRaw, lastCallLogId: existingCall.id },
        });
      }
    }

    // Opt-out and booking writes are guarded by the call id so webhook
    // redelivery cannot create duplicate records.
    const idempotencyAnchor = providerCallId;
    // Outbound campaign calls are owned by the booking handoff below (new
    // AppointmentRequest workflow); only studio calls use the legacy request.
    const optOutPhone = existingCall?.direction === 'outbound'
      ? existingCall.callerPhone
      : call.from_number;
    if (outcome === 'OPTED_OUT' && (optOutPhone || custom.email)) {
      const contactEmail = typeof custom.email === 'string' && custom.email.trim().length <= 160
        ? custom.email.trim().toLowerCase()
        : undefined;
      await db.$transaction(async tx => {
        await lockDncDestinationFence(tx, tenantId, [optOutPhone, contactEmail]);
        const scope = 'retell.optout';
        const key = `${tenantId}:${idempotencyAnchor}`;
        const prior = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope, key } }, select: { id: true } });
        if (prior) return;
        const row = await tx.receptionistOptOut.create({
          data: { tenantId, clinicId: trustedClinicId, contactPhone: optOutPhone, contactEmail, channel: 'ALL', reason: 'Requested during AI call' },
        });
        await tx.idempotencyKey.create({ data: { scope, key, tenantId, resultId: row.id } });
        const occurredAt = new Date();
        await tx.auditEvent.create({ data: {
          tenantId, action: 'receptionist.optout.recorded', resource: 'receptionistOptOut', resourceId: row.id,
          occurredAt, metadata: { channel: 'ALL', source: 'retell_webhook' },
        } });
        await tx.businessEvent.create({ data: {
          tenantId, eventType: 'receptionist.dnc.activated', entityType: 'receptionistOptOut', entityId: row.id,
          sourceModule: 'receptionist', occurredAt, payload: { channel: 'ALL', source: 'retell_webhook' },
        } });
      });
    }

    if (outcomeRaw === 'BOOKED' && !canonicalBooking) {
      const boundedText = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
      const mayPersistAnalysisPhi = persistedCall.recordingConsentStatus === 'GRANTED';
      const analysisAnswers = mayPersistAnalysisPhi
        ? Object.fromEntries(Object.entries({
          first_name: boundedText(custom.first_name, 80),
          last_name: boundedText(custom.last_name, 80),
          appointment_date: boundedText(custom.appointment_date ?? custom.preferred_date, 10),
          appointment_time: boundedText(custom.appointment_time ?? custom.preferred_time, 8),
          preferred_service: boundedText(custom.preferred_service, 120),
          email: boundedText(custom.email, 160),
          observed_phone: canonicalRetellDestination(persistedCall.callerPhone ?? undefined),
        }).filter(([, value]) => value !== null))
        : { issue_codes: ['provider_claimed_booking_without_canonical_evidence', 'consent_not_granted_phi_omitted'] };
      await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-call-lifecycle:${tenantId}:${providerCallId}`})::bigint)`;
        const existing = await tx.appointmentRequest.findFirst({ where: { tenantId, callLogId: persistedCall.id }, select: { id: true } });
        if (existing) return existing;
        const requestRow = await tx.appointmentRequest.create({
          data: {
            tenantId, callLogId: persistedCall.id,
            campaignId: persistedCall.campaignId,
            requestedService: mayPersistAnalysisPhi ? boundedText(custom.preferred_service, 120) : null,
            collectedName: mayPersistAnalysisPhi ? ([boundedText(custom.first_name, 80), boundedText(custom.last_name, 80)].filter(Boolean).join(' ') || null) : null,
            collectedPhone: mayPersistAnalysisPhi ? canonicalRetellDestination(persistedCall.callerPhone ?? undefined) : null,
            collectedEmail: mayPersistAnalysisPhi ? boundedText(custom.email, 160) : null,
            rawCollectedFields: analysisAnswers,
            source: 'retell_analysis_review_only', status: 'PENDING_REVIEW', missingFields: [],
            outcomeReason: 'Provider analysis claimed booking without canonical signed-tool appointment evidence',
          },
          select: { id: true },
        });
        await tx.idempotencyKey.upsert({
          where: { scope_key: { scope: 'receptionist.live-booking', key: `${tenantId}:${persistedCall.id}` } },
          update: { tenantId, resultId: requestRow.id },
          create: { tenantId, scope: 'receptionist.live-booking', key: `${tenantId}:${persistedCall.id}`, resultId: requestRow.id },
        });
        await tx.auditEvent.create({ data: {
          tenantId, action: 'receptionist.appointmentRequest.analysisReviewCreated', resource: 'appointmentRequest',
          resourceId: requestRow.id, userAgent: 'retell-webhook', metadata: {
            callLogId: persistedCall.id, bookingAuthority: false,
            outboundCampaignId: persistedCall.outboundCampaignId,
            analysisPhiPersisted: mayPersistAnalysisPhi,
          },
        } });
        await tx.businessEvent.create({ data: {
          tenantId, eventType: 'receptionist.appointmentRequest.created', entityType: 'appointmentRequest',
          entityId: requestRow.id, sourceModule: 'receptionist', payload: { status: 'PENDING_REVIEW', analysisOnly: true },
        } });
        return requestRow;
      });
    }

    // Provider analysis is not an autonomous booking authority. The legacy
    // post-call handoff path was intentionally disabled because it accepted
    // model phone data, split its writes, and could create provider-null
    // appointments outside canonical scheduler protection. Direct booking is
    // owned exclusively by the signed, attested in-call tool transaction.

    return reply.code(200).send({ ok: true });
  });

  // ── Live agent tools (Retell custom functions invoked DURING a call) ──────
  // check_availability / book_appointment. This is a live booking + SMS
  // primitive, so it is signature-verified EXACTLY like the sibling event
  // webhook (never accept an unsigned/invalid call in production). Invalid
  // signatures use a separate source bucket; valid callbacks never share an IP
  // bucket and are limited only after persisted tenant/call authority resolves.
  // Tenant is resolved from persisted call/destination authority; URL selectors
  // cannot establish it.
  app.post('/webhooks/retell/fn', {
    config: { rateLimit: false },
  }, async (request, reply) => {
    const query = z.object({ clinicId: uuid.optional(), campaignId: uuid.optional() }).parse(request.query);
    // Bounded, typed args replace the loose z.record so a caller cannot smuggle
    // oversized or wrong-typed fields into the booking/SMS primitives. Unknown
    // keys pass through (preserving collected intake fields) but the security-
    // sensitive fields are length-capped; liveTools re-sanitizes on top.
    const fnArgs = z.object({
      appointment_date: z.string().max(40).optional(),
      appointment_time: z.string().max(40).optional(),
      first_name: z.string().max(80).optional(),
      last_name: z.string().max(80).optional(),
      phone: z.string().max(40).optional(),
      email: z.string().max(160).optional(),
      service: z.string().max(120).optional(),
      intake_contract_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      intake_schema_revision: z.number().int().positive().optional(),
      caller_name: z.string().max(80).optional(),
      callback_phone: z.string().max(40).optional(),
      reason_category: z.string().max(40).optional(),
      message: z.string().max(500).optional(),
      date_of_birth: z.string().max(10).optional(),
      recording_decision: z.enum(['GRANTED', 'REFUSED', 'WITHDRAWN']).optional(),
      jurisdiction: z.string().max(80).optional(),
    }).passthrough();
    const body = z.object({
      name: z.string().max(64),
      args: fnArgs.default({}),
      call: z.object({
        call_id: z.string().max(128).optional(),
        agent_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
        agent_version: z.number().int().nonnegative().optional(),
        from_number: z.string().max(40).optional(),
        to_number: z.string().max(40).optional(),
        direction: z.enum(['inbound', 'outbound']).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }).optional(),
    }).parse(request.body);

    // Signature verification — MIRRORS /webhooks/retell. Reject when the
    // signature is absent/invalid and fail closed when the key is missing.
    const sig = request.headers['x-retell-signature'];
    if (env.RETELL_API_KEY) {
      if (!verifyRetellSignature(request.rawBody, sig, env.RETELL_API_KEY)) {
        const invalidRate = await enforceInvalidRetellCallbackRate(request.ip);
        const sourceRef = opaqueIngressReference(request.ip).slice(0, 16);
        if (!invalidRate.allowed && invalidRate.reason === 'source_limit') {
          request.log.warn({ sourceRef, decision: invalidRate.reason }, 'Retell invalid-signature tool source rate limited');
          return reply.code(429).send({ error: 'INVALID_SIGNATURE_RATE_LIMITED' });
        }
        request.log.warn({ sourceRef, decision: invalidRate.allowed ? 'rejected' : invalidRate.reason }, 'Retell fn webhook signature verification failed');
        return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      }
    } else {
      const invalidRate = await enforceInvalidRetellCallbackRate(request.ip);
      const sourceRef = opaqueIngressReference(request.ip).slice(0, 16);
      if (!invalidRate.allowed && invalidRate.reason === 'source_limit') {
        request.log.warn({ sourceRef, decision: invalidRate.reason }, 'Unconfigured Retell tool source rate limited');
        return reply.code(429).send({ error: 'WEBHOOK_NOT_CONFIGURED_RATE_LIMITED' });
      }
      request.log.error({ sourceRef, decision: invalidRate.allowed ? 'rejected' : invalidRate.reason }, 'Retell fn webhook rejected: RETELL_API_KEY not configured');
      return reply.code(503).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
    }

    const providerCallId = body.call?.call_id?.trim();
    const callResolution = providerCallId
      ? await resolveIngressTenant('retell_call_id', providerCallId)
      : null;
    const intentRecovery = !callResolution && providerCallId
      ? await recoverOutboundProviderIntent({
        metadata: body.call?.metadata,
        providerCallId,
        providerAgentId: body.call?.agent_id,
        providerAgentVersion: body.call?.agent_version,
        terminalEvent: false,
      })
      : null;
    const recoveredResolution = intentRecovery?.recognized
      ? { tenantId: intentRecovery.tenantId, resourceId: intentRecovery.callLogId }
      : null;
    const signedDestination = body.call?.direction === 'inbound'
      ? canonicalRetellDestination(body.call.to_number)
      : null;
    const destinationResolution = !callResolution && !recoveredResolution && providerCallId && signedDestination
      ? await resolveIngressTenant('retell_destination_phone', signedDestination)
      : null;
    const resolved = callResolution ?? recoveredResolution ?? destinationResolution;
    const resolvedByDestination = Boolean(destinationResolution);
    if (!resolved || !providerCallId) {
      request.log.warn({
        callRef: opaqueIngressReference(providerCallId).slice(0, 16),
        destinationRef: opaqueIngressReference(signedDestination ?? undefined).slice(0, 16),
        direction: body.call?.direction ?? 'unknown',
      }, 'Signed Retell tool call requires manual ingress mapping review');
      await flagUnresolvedRetellIngress(providerCallId, signedDestination, body.call?.direction);
      return reply.code(202).send({ message: "I'm sorry, I can't access this clinic right now." });
    }
    const tenantId = resolved.tenantId;
    enterTenantContext({ tenantId, actorId: `webhook:retell-tool:${resolved.resourceId}`, actorRole: 'WEBHOOK', source: 'webhook', requestId: request.id });
    if (intentRecovery?.recognized && intentRecovery.quarantined) {
      const stopped = await stopPhoneCall(providerCallId);
      await flagRetellIngressReview(
        tenantId,
        providerCallId,
        `Recovered outbound provider intent was quarantined: ${intentRecovery.reason}; provider_stop_applied=${stopped.applied}`,
      ).catch(() => undefined);
      const review = await persistProviderIntentRecoveryReview({
        tenantId,
        callLogId: intentRecovery.callLogId,
        providerCallId,
        reason: intentRecovery.reason,
        providerStopApplied: stopped.applied,
      });
      return reply.code(202).send({
        message: "I'm sorry, this call requires staff reconciliation and cannot continue.",
        providerStopApplied: stopped.applied,
        ...review,
      });
    }
    let trustedClinicId: string | undefined = resolvedByDestination ? resolved.resourceId : undefined;
    // Query selectors are routing hints only. A booking is instead bound below
    // from the signed call's exact provider deployment to one persisted active
    // attested campaign; query values can only cross-check that authority.
    if (body.name !== 'book_appointment' && query.campaignId) {
      const campaign = await db.receptionistCampaign.findFirst({ where: { id: query.campaignId, tenantId }, select: { clinicId: true } });
      if (!campaign || (trustedClinicId && campaign.clinicId !== trustedClinicId) || (query.clinicId && campaign.clinicId !== query.clinicId)) {
        await flagRetellIngressReview(tenantId, providerCallId, 'Signed Retell tool selectors did not match the trusted clinic mapping');
        return reply.code(202).send({ message: "I'm sorry, I can't access this clinic right now." });
      }
      trustedClinicId = campaign.clinicId;
    } else if (body.name !== 'book_appointment' && query.clinicId) {
      const clinic = await db.receptionistClinic.findFirst({ where: { id: query.clinicId, tenantId }, select: { id: true } });
      if (!clinic || (trustedClinicId && clinic.id !== trustedClinicId)) {
        await flagRetellIngressReview(tenantId, providerCallId, 'Signed Retell tool clinic selector did not match the trusted clinic mapping');
        return reply.code(202).send({ message: "I'm sorry, I can't access this clinic right now." });
      }
      trustedClinicId = clinic.id;
    }

    const inboundTool = body.call?.direction === 'inbound' || resolvedByDestination;
    const deploymentBoundTool = inboundTool && INBOUND_DEPLOYMENT_BOUND_TOOLS.has(body.name);
    let trustedInboundDeployment: VerifiedInboundDeployment | undefined;
    if (deploymentBoundTool) {
      // An already-mapped call may not carry a URL selector. Recover only the
      // persisted clinic id; provider agent fields always come from the signed
      // body and must match one currently verified clinic deployment.
      if (!trustedClinicId) {
        const mappedCall = await db.receptionistCallLog.findFirst({
          where: { tenantId, retellCallId: providerCallId },
          select: { clinicId: true },
        });
        trustedClinicId = mappedCall?.clinicId ?? undefined;
      }
      const deploymentResult = await resolveVerifiedInboundDeployment({
        tenantId,
        clinicId: trustedClinicId,
        providerAgentId: body.call?.agent_id,
        providerAgentVersion: body.call?.agent_version,
      });
      if (!deploymentResult.deployment) {
        const stopped = await stopPhoneCall(providerCallId);
        await flagRetellIngressReview(
          tenantId,
          providerCallId,
          `Inbound patient-data tool rejected: ${deploymentResult.reason}; provider_stop_applied=${stopped.applied}`,
        );
        return reply.code(202).send({
          allowed: false,
          needs_human: true,
          message: "I'm sorry, this call is not using the clinic's verified receptionist configuration. I cannot access or change patient information.",
          providerStopApplied: stopped.applied,
        });
      }
      trustedInboundDeployment = deploymentResult.deployment;
    }

    if (inboundTool) {
      const admission = await admitInboundReceptionist(tenantId, providerCallId, { clinicId: trustedClinicId, callerPhone: body.call?.from_number, direction: 'inbound' });
      if (!admission.allowed) {
        const stopped = await stopPhoneCall(providerCallId);
        await flagInboundAdmissionDenied(tenantId, providerCallId, `${admission.reason}; provider_stop_applied=${stopped.applied}`);
        return reply.code(202).send({ message: "I'm sorry, this clinic's AI receptionist is unavailable right now. I can only direct you to staff.", providerStopApplied: stopped.applied });
      }
    }

    // The tool webhook may arrive before the lifecycle event. Serialize the
    // bootstrap so event/tool races create one persisted opaque call mapping.
    const activeCall = await db.$transaction(async tx => {
      const lifecycleKey = `receptionist-call-lifecycle:${tenantId}:${providerCallId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lifecycleKey})::bigint)`;
      let existing = await tx.receptionistCallLog.findFirst({ where: { tenantId, retellCallId: providerCallId } });
      trustedClinicId ??= existing?.clinicId ?? undefined;
      let trustedCampaignId = existing?.campaignId ?? undefined;
      if (trustedInboundDeployment && existing) {
        const bindingState = callMatchesInboundDeployment(existing, trustedInboundDeployment);
        if (bindingState === 'mismatched') return null;
        if (bindingState === 'unbound') {
          existing = await tx.receptionistCallLog.update({
            where: { id: existing.id },
            data: {
              boundProviderAgentId: trustedInboundDeployment.providerAgentId,
              boundProviderAgentVersion: trustedInboundDeployment.providerAgentVersion,
              boundProviderConfigRevision: trustedInboundDeployment.providerConfigRevision,
              boundProviderFingerprint: trustedInboundDeployment.providerFingerprint,
            },
          });
        }
      }
      if (['book_appointment', 'check_availability'].includes(body.name) && body.call?.agent_id && body.call.agent_version !== undefined) {
        const candidates = await tx.receptionistCampaign.findMany({
          where: {
            tenantId,
            status: 'ACTIVE',
            intakeSchemaProviderAgentId: body.call.agent_id,
            intakeSchemaProviderVersion: body.call.agent_version,
            intakeSchemaAttestedRevision: { not: null },
            ...(trustedClinicId ? { clinicId: trustedClinicId } : {}),
            ...(trustedCampaignId ? { id: trustedCampaignId } : {}),
          },
          select: { id: true, clinicId: true },
          take: 2,
        });
        if (candidates.length === 1) {
          trustedCampaignId = candidates[0].id;
          trustedClinicId = candidates[0].clinicId;
          if (existing && (!existing.campaignId || !existing.clinicId)) {
            existing = await tx.receptionistCallLog.update({
              where: { id: existing.id },
              data: { campaignId: trustedCampaignId, clinicId: trustedClinicId },
            });
          }
        }
      }
      if (!existing) {
        return tx.receptionistCallLog.create({
          data: {
            tenantId,
            clinicId: trustedClinicId,
            campaignId: trustedCampaignId,
            retellCallId: providerCallId,
            callerPhone: body.call?.direction === 'outbound' ? body.call.to_number : body.call?.from_number,
            direction: body.call?.direction ?? 'inbound',
            startedAt: new Date(),
            ...(trustedInboundDeployment ? {
              boundProviderAgentId: trustedInboundDeployment.providerAgentId,
              boundProviderAgentVersion: trustedInboundDeployment.providerAgentVersion,
              boundProviderConfigRevision: trustedInboundDeployment.providerConfigRevision,
              boundProviderFingerprint: trustedInboundDeployment.providerFingerprint,
            } : {}),
          },
        });
      }
      return existing;
    });

    if (!activeCall) {
      const stopped = await stopPhoneCall(providerCallId);
      await flagRetellIngressReview(tenantId, providerCallId, `Inbound patient-data tool rejected: persisted provider deployment binding mismatch; provider_stop_applied=${stopped.applied}`);
      return reply.code(202).send({
        allowed: false,
        needs_human: true,
        message: "I'm sorry, the verified receptionist configuration changed for this call. I cannot access or change patient information.",
        providerStopApplied: stopped.applied,
      });
    }

    if (['book_appointment', 'check_availability'].includes(body.name)) {
      const selectorMismatch = (query.campaignId !== undefined && query.campaignId !== activeCall.campaignId)
        || (query.clinicId !== undefined && query.clinicId !== activeCall.clinicId);
      if (selectorMismatch) {
        await flagRetellIngressReview(tenantId, providerCallId, 'Book tool query selector disagreed with persisted call authority');
        return reply.code(202).send({ booked: false, needs_human: true, message: "I'm sorry, I can't access this clinic right now." });
      }
      trustedClinicId = activeCall.clinicId ?? undefined;
    }

    const activeSince = activeCall.startedAt ?? activeCall.createdAt;
    const canonicalBookingReplay = body.name === 'book_appointment' && activeCall.outcome === 'BOOKED';
    if (activeCall.endedAt || (!canonicalBookingReplay && activeCall.outcome !== 'IN_PROGRESS') || activeSince.getTime() < Date.now() - RECEPTIONIST_CALL_LEASE_MS) {
      await flagRetellIngressReview(tenantId, providerCallId, 'Signed Retell tool rejected because the call is ended, terminal, or outside its active lease');
      return reply.code(200).send({ allowed: false, needs_human: true, message: 'This call is no longer active. I cannot access or change patient information.' });
    }

    // Count only a fully authorized, active call context. Query selectors are
    // not signed, and an ended/expired call must never be able to consume a
    // valid call's quota or create a staff task through the overload path. The
    // count intentionally precedes the recording-consent response so repeated
    // denied mutation attempts are bounded too.
    const rate = await enforceTrustedRetellCallbackRate(tenantId, providerCallId, 'tool');
    if (!rate.allowed) {
      const refs = {
        tenantRef: opaqueIngressReference(tenantId).slice(0, 16),
        callRef: opaqueIngressReference(providerCallId).slice(0, 16),
        decision: rate.reason,
      };
      if (rate.reason === 'store_unavailable') request.log.error(refs, 'Retell verified tool rate store unavailable; creating staff handoff');
      else request.log.warn(refs, 'Retell verified tool rate limited; creating staff handoff');
      try {
        const handoff = await requestHumanHandoff({
          tenantId,
          callId: providerCallId,
          callerPhone: (body.call?.direction === 'outbound' ? body.call.to_number : body.call?.from_number) ?? null,
        }, {
          reason_category: 'automated_tool_safety_limit',
          message: 'AI receptionist tool safety limit reached; staff review is required.',
        });
        return reply.code(200).send({
          allowed: false,
          needs_human: true,
          reason: rate.reason,
          ...handoff,
          ...(rate.reason === 'store_unavailable' ? {
            message: 'I cannot safely continue this automated request. I recorded a front desk review request; staff have not acknowledged it yet.',
          } : {}),
        });
      } catch (error) {
        request.log.error({ ...refs, err: error }, 'Retell tool-limit staff handoff could not be persisted');
        await flagRetellIngressReview(tenantId, providerCallId, 'Verified Retell tool limit reached but staff handoff persistence failed').catch(() => {});
        return reply.code(200).send({
          allowed: false,
          needs_human: true,
          handoff_recorded: false,
          message: "I'm sorry, I can't safely continue this automated request. Please contact the front desk directly.",
        });
      }
    }

    // Missing booking deployment authority is evaluated only after the
    // verified, active call's safety quota. This preserves bounded fail-closed
    // behavior during rate-store outages while still rejecting unsigned query
    // selector mismatches before they can consume a trusted call's quota.
    if (['book_appointment', 'check_availability'].includes(body.name) && (!activeCall.campaignId || !activeCall.clinicId)) {
      await flagRetellIngressReview(tenantId, providerCallId, 'Book tool could not resolve one trusted campaign from persisted call authority');
      return reply.code(200).send({ booked: false, needs_human: true, message: 'I cannot safely select the booking campaign. I recorded a staff review request.' });
    }

    const SAFE_WITHOUT_RECORDING_GRANT = new Set(['record_recording_preference', 'record_do_not_call', 'request_human_handoff', 'take_message', 'report_emergency', 'check_availability']);
    if (!SAFE_WITHOUT_RECORDING_GRANT.has(body.name)) {
      const callState = await db.receptionistCallLog.findFirst({ where: { tenantId, retellCallId: providerCallId }, select: { recordingConsentStatus: true } });
      if (callState?.recordingConsentStatus !== 'GRANTED') {
        return reply.code(200).send({ allowed: false, needs_human: true, message: 'I need your explicit agreement to the opening disclosure before I can access or change patient information. I can connect you with staff instead.' });
      }
    }

    let trustedToolArgs: Record<string, unknown> = body.args;
    let trustedBooking: TrustedBookingContext | undefined;
    if (['book_appointment', 'check_availability'].includes(body.name)) {
      const isBookingMutation = body.name === 'book_appointment';
      const campaign = activeCall.campaignId
        ? await db.receptionistCampaign.findFirst({
          where: { id: activeCall.campaignId, tenantId, status: 'ACTIVE' },
          select: {
            appointmentType: true,
            intakeSchemaRevision: true,
            intakeSchemaAttestedRevision: true,
            intakeSchemaSnapshot: true,
            intakeSchemaFingerprint: true,
            intakeSchemaProviderAgentId: true,
            intakeSchemaProviderVersion: true,
          },
        })
        : null;
      const snapshot = campaign?.intakeSchemaSnapshot && typeof campaign.intakeSchemaSnapshot === 'object' && !Array.isArray(campaign.intakeSchemaSnapshot)
        ? campaign.intakeSchemaSnapshot as unknown as IntakeContractSnapshot
        : null;
      const semanticFingerprint = typeof snapshot?.semanticFingerprint === 'string' ? snapshot.semanticFingerprint : null;
      const persistedCallerPhone = canonicalRetellDestination(activeCall.callerPhone ?? undefined);
      const envelopeCallerPhone = canonicalRetellDestination(
        body.call?.direction === 'outbound' ? body.call.to_number : body.call?.from_number,
      );
      const callerIdentityDrift = Boolean(persistedCallerPhone && envelopeCallerPhone && persistedCallerPhone !== envelopeCallerPhone);
      const requiredPhone = Array.isArray(snapshot?.fields) && snapshot.fields.some(value => {
        const field = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
        return field?.fieldType === 'PHONE' && field.required === true;
      });
      const deploymentMatches = Boolean(
        campaign
        && snapshot
        && campaign.intakeSchemaAttestedRevision === campaign.intakeSchemaRevision
        && campaign.intakeSchemaFingerprint === fingerprintJson(snapshot)
        && semanticFingerprint
        && (!isBookingMutation || body.args.intake_contract_fingerprint === semanticFingerprint)
        && (!isBookingMutation || body.args.intake_schema_revision === campaign.intakeSchemaRevision)
        && (!isBookingMutation || body.args.service === campaign.appointmentType)
        && body.call?.agent_id === campaign?.intakeSchemaProviderAgentId
        && body.call?.agent_version === campaign?.intakeSchemaProviderVersion,
      );
      if (!deploymentMatches || callerIdentityDrift) {
        await flagRetellIngressReview(tenantId, providerCallId, 'Book tool intake contract did not match the persisted active campaign attestation');
        return reply.code(200).send({
          booked: false,
          needs_human: true,
          message: 'I cannot safely complete this booking because the active intake configuration changed. I recorded a staff review request.',
        });
      }
      if (isBookingMutation && requiredPhone && !persistedCallerPhone) {
        await flagRetellIngressReview(tenantId, providerCallId, 'Required phone intake identity was unavailable from the persisted signed call context');
        return reply.code(200).send({
          booked: false,
          needs_human: true,
          message: 'I cannot safely confirm the required callback number from this call. I recorded a front desk review request.',
        });
      }
      // Persisted call/campaign state is authoritative. Provider-applied consts
      // are cross-checks only, and model-supplied phone data is never forwarded.
      trustedToolArgs = { ...body.args, service: campaign!.appointmentType };
      delete trustedToolArgs.phone;

      const eligibleLocationIds = Array.isArray(snapshot!.eligibleLocationIds)
        ? snapshot!.eligibleLocationIds.filter((value): value is string => typeof value === 'string')
        : [];
      const requestedLocationId = typeof body.args.location_id === 'string' ? body.args.location_id : null;
      const locationSelector = requestedLocationId
        ? (eligibleLocationIds.includes(requestedLocationId) ? [requestedLocationId] : [])
        : eligibleLocationIds.length === 1 ? eligibleLocationIds : [];
      const locations = locationSelector?.length === 0
        ? []
        : await db.receptionistLocation.findMany({
          where: {
            tenantId, clinicId: activeCall.clinicId!, active: true, branchId: { not: null },
            branch: { active: true },
            ...(locationSelector ? { id: { in: locationSelector } } : {}),
          },
          select: { id: true, branchId: true, branch: { select: { id: true, timezone: true } } },
          take: 2,
        });
      const location = locations.length === 1 ? locations[0] : null;
      trustedBooking = {
        callLogId: activeCall.id,
        campaignId: activeCall.campaignId!,
        clinicId: activeCall.clinicId!,
        locationId: location?.id ?? null,
        branchId: location?.branchId ?? null,
        branchTimezone: location?.branch?.timezone ?? null,
        observedPhone: persistedCallerPhone,
        providerAgentId: campaign!.intakeSchemaProviderAgentId!,
        providerAgentVersion: campaign!.intakeSchemaProviderVersion!,
        intakeSnapshot: snapshot!,
      };
    }

    if (trustedInboundDeployment) {
      // Re-read readiness at the final dispatch boundary. Verification expiry,
      // relinking, revision changes, or provider fingerprint drift after the
      // initial bind must fail closed before the live tool sees patient data.
      const finalDeployment = await resolveVerifiedInboundDeployment({
        tenantId,
        clinicId: activeCall.clinicId ?? undefined,
        providerAgentId: body.call?.agent_id,
        providerAgentVersion: body.call?.agent_version,
      });
      if (!finalDeployment.deployment || callMatchesInboundDeployment(activeCall, finalDeployment.deployment) !== 'matched') {
        const stopped = await stopPhoneCall(providerCallId);
        await flagRetellIngressReview(
          tenantId,
          providerCallId,
          `Inbound patient-data tool rejected at dispatch boundary: ${finalDeployment.reason ?? 'provider_deployment_drift'}; provider_stop_applied=${stopped.applied}`,
        );
        return reply.code(202).send({
          allowed: false,
          needs_human: true,
          message: "I'm sorry, the clinic's verified receptionist configuration is no longer valid for this call. I cannot access or change patient information.",
          providerStopApplied: stopped.applied,
        });
      }
    }

    const result = await handleAgentTool(
      {
        tenantId,
        callId: providerCallId,
        callerPhone: activeCall.callerPhone,
        trustedBooking,
        trustedProviderAgentId: trustedInboundDeployment?.localAgentId,
        // Retell's represented custom-function contract has no documented
        // delivery ID. The raw body is immutable only after signature
        // verification above; hashing it dedupes byte-identical redelivery
        // without persisting DOB or inventing a provider field.
        providerInvocationId: createHash('sha256').update(request.rawBody ?? Buffer.alloc(0)).digest('hex'),
      },
      body.name,
      trustedToolArgs,
    );
    return reply.code(200).send(result);
  });
};
