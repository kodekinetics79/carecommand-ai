import { runWithWebhookTenantContext } from '../tenantContext';
import { resolveIngressTenant } from '../tenantIngressResolvers';
import {
  parseProviderIntentCorrelationMetadata,
  verifyProviderIntentCorrelation,
  verifyProviderIntentEnvelopeSignature,
} from './providerIntentCorrelation';

type RecoveryReason =
  | 'metadata_missing_or_invalid'
  | 'metadata_signature_invalid'
  | 'intent_unresolved'
  | 'intent_resolution_mismatch'
  | 'intent_context_mismatch'
  | 'provider_call_replay'
  | 'provider_call_collision'
  | 'intent_terminal'
  | 'outbound_stopped'
  | 'campaign_not_running'
  | 'provider_deployment_unattested'
  | 'provider_deployment_mismatch';

export type ProviderIntentRecoveryResult =
  | { recognized: false; reason: RecoveryReason }
  | {
      recognized: true;
      tenantId: string;
      intentId: string;
      callLogId: string;
      newlyBound: boolean;
      quarantined: boolean;
      stopRequired: boolean;
      reason: RecoveryReason | 'provider_call_bound' | 'provider_call_already_bound';
      deploymentCircuitTripped: boolean;
    };

/**
 * Recovers the provider-acceptance/local-bind crash window from authenticated
 * callback metadata. Callers must first verify Retell's signature over the raw
 * body. This helper independently authenticates the app-issued intent tuple
 * before allowing its tenant id to participate in RLS bootstrap.
 */
export async function recoverOutboundProviderIntent(input: {
  metadata: unknown;
  providerCallId: string;
  providerAgentId?: string;
  providerAgentVersion?: number;
  terminalEvent: boolean;
}): Promise<ProviderIntentRecoveryResult> {
  const metadata = parseProviderIntentCorrelationMetadata(input.metadata);
  if (!metadata) return { recognized: false, reason: 'metadata_missing_or_invalid' };
  if (!verifyProviderIntentEnvelopeSignature(metadata)) {
    return { recognized: false, reason: 'metadata_signature_invalid' };
  }

  // The resolver accepts only the opaque, authenticated intent UUID and
  // returns the minimum tenant/resource mapping under SECURITY DEFINER.
  const resolution = await resolveIngressTenant('retell_provider_intent', metadata.intentId);
  if (!resolution) return { recognized: false, reason: 'intent_unresolved' };
  if (resolution.tenantId.toLowerCase() !== metadata.tenantId
      || resolution.resourceId.toLowerCase() !== metadata.intentId) {
    return { recognized: false, reason: 'intent_resolution_mismatch' };
  }

  const recovered = await runWithWebhookTenantContext(resolution.tenantId, async tx => {
    // Match outbound's canonical order. Configuration state is frozen before
    // dispatch/lifecycle state so pause, kill-switch and verification races
    // cannot admit a provider call against a stale deployment.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-config:${resolution.tenantId}`}::text, 0))::text AS locked`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-outbound-dispatch:${resolution.tenantId}`}::text, 0))::text AS locked`;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-call-lifecycle:${resolution.tenantId}:${input.providerCallId}`}::text, 0))::text AS locked`;

    const intent = await tx.receptionistOutboundProviderIntent.findFirst({
      where: { id: metadata.intentId, tenantId: resolution.tenantId },
      include: {
        callLog: true,
        outboundCampaign: { include: { agent: true } },
      },
    });
    if (!intent || !verifyProviderIntentCorrelation(metadata, {
      tenantId: intent.tenantId,
      intentId: intent.id,
      callLogId: intent.callLogId,
      outboundCampaignId: intent.outboundCampaignId,
      targetId: intent.targetId,
      purpose: intent.purpose,
      policyVersion: intent.policyVersion,
      nonceHash: intent.correlationNonceHash,
    })) return { kind: 'context_mismatch' as const };

    const callCollision = await tx.receptionistCallLog.findFirst({
      where: { tenantId: resolution.tenantId, retellCallId: input.providerCallId },
      select: { id: true },
    });
    if (callCollision && callCollision.id !== intent.callLogId) {
      await tx.auditEvent.create({ data: {
        tenantId: resolution.tenantId,
        action: 'receptionist.outbound.providerIntent.providerCallCollision',
        resource: 'receptionistOutboundProviderIntent',
        resourceId: intent.id,
        userAgent: 'retell-webhook-recovery',
        metadata: { callLogId: intent.callLogId, providerCallId: input.providerCallId, collisionCallLogId: callCollision.id },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: resolution.tenantId,
        eventType: 'receptionist.outbound.provider_intent_provider_call_collision',
        entityType: 'receptionistOutboundProviderIntent',
        entityId: intent.id,
        sourceModule: 'receptionist',
        payload: { callLogId: intent.callLogId, providerCallId: input.providerCallId, disposition: 'quarantined' },
      } });
      return { kind: 'collision' as const, callLogId: intent.callLogId };
    }
    if (intent.callLog.retellCallId && intent.callLog.retellCallId !== input.providerCallId) {
      await tx.auditEvent.create({ data: {
        tenantId: resolution.tenantId,
        action: 'receptionist.outbound.providerIntent.replayRejected',
        resource: 'receptionistOutboundProviderIntent',
        resourceId: intent.id,
        userAgent: 'retell-webhook-recovery',
        metadata: { callLogId: intent.callLogId, providerCallId: input.providerCallId, boundProviderCallId: intent.callLog.retellCallId },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: resolution.tenantId,
        eventType: 'receptionist.outbound.provider_intent_replay_rejected',
        entityType: 'receptionistOutboundProviderIntent',
        entityId: intent.id,
        sourceModule: 'receptionist',
        payload: { callLogId: intent.callLogId, providerCallId: input.providerCallId, disposition: 'quarantined' },
      } });
      return { kind: 'replay' as const, callLogId: intent.callLogId };
    }

    const deploymentAttested = typeof input.providerAgentId === 'string'
      && input.providerAgentId.length > 0
      && Number.isSafeInteger(input.providerAgentVersion)
      && input.providerAgentVersion! >= 0;
    const deploymentMismatch = deploymentAttested
      && (intent.outboundCampaign.agent?.providerAgentId !== input.providerAgentId
        || intent.outboundCampaign.agent?.providerVersion !== input.providerAgentVersion);
    const usage = await tx.tenantAiUsage.findUnique({
      where: { tenantId: resolution.tenantId },
      select: { killSwitch: true },
    });
    const terminalIntent = intent.callLog.outcome !== 'IN_PROGRESS' || intent.callLog.endedAt !== null;
    const unsafeReason: RecoveryReason | null = deploymentMismatch
      ? 'provider_deployment_mismatch'
      : !deploymentAttested
        ? 'provider_deployment_unattested'
      : terminalIntent
        ? 'intent_terminal'
        : !input.terminalEvent && usage?.killSwitch
          ? 'outbound_stopped'
          : !input.terminalEvent && intent.outboundCampaign.status !== 'RUNNING'
            ? 'campaign_not_running'
            : null;

    let deploymentCircuitTripped = false;
    if (deploymentMismatch && intent.outboundCampaign.agentId) {
      const trippedAt = new Date();
      await tx.receptionistAgent.updateMany({
        where: { id: intent.outboundCampaign.agentId, tenantId: resolution.tenantId },
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
      await tx.receptionistOutboundCampaign.updateMany({
        where: { tenantId: resolution.tenantId, agentId: intent.outboundCampaign.agentId, status: { in: ['SCHEDULED', 'RUNNING'] } },
        data: { status: 'PAUSED' },
      });
      await tx.receptionistCampaign.updateMany({
        where: { tenantId: resolution.tenantId, agentId: intent.outboundCampaign.agentId, status: 'ACTIVE' },
        data: { status: 'PAUSED' },
      });
      deploymentCircuitTripped = true;
    }

    const newlyBound = intent.callLog.retellCallId === null;
    await tx.receptionistCallLog.update({
      where: { id: intent.callLogId },
      data: {
        ...(newlyBound ? { retellCallId: input.providerCallId } : {}),
        ...(unsafeReason ? {
          outcome: intent.callLog.outcome === 'IN_PROGRESS' ? 'ESCALATED' : intent.callLog.outcome,
          endedAt: intent.callLog.endedAt ?? new Date(),
        } : {}),
      },
    });
    if (unsafeReason && intent.targetId) {
      await tx.receptionistCallTarget.updateMany({
        where: {
          id: intent.targetId,
          tenantId: resolution.tenantId,
          campaignId: intent.outboundCampaignId,
        },
        data: {
          status: 'FAILED',
          lastOutcome: 'RECONCILIATION_REQUIRED',
          lastCallLogId: intent.callLogId,
        },
      });
    }
    await tx.auditEvent.create({ data: {
      tenantId: resolution.tenantId,
      action: unsafeReason
        ? 'receptionist.outbound.providerIntent.recoveredAndQuarantined'
        : 'receptionist.outbound.providerIntent.providerCallRecovered',
      resource: 'receptionistOutboundProviderIntent',
      resourceId: intent.id,
      userAgent: 'retell-webhook-recovery',
      metadata: {
        callLogId: intent.callLogId,
        providerCallId: input.providerCallId,
        newlyBound,
        disposition: unsafeReason ?? 'admitted',
        deploymentCircuitTripped,
      },
    } });
    await tx.businessEvent.create({ data: {
      tenantId: resolution.tenantId,
      eventType: unsafeReason
        ? 'receptionist.outbound.provider_intent_recovered_quarantined'
        : 'receptionist.outbound.provider_intent_provider_call_recovered',
      entityType: 'receptionistOutboundProviderIntent',
      entityId: intent.id,
      sourceModule: 'receptionist',
      payload: {
        callLogId: intent.callLogId,
        providerCallId: input.providerCallId,
        newlyBound,
        disposition: unsafeReason ?? 'admitted',
      },
    } });
    return {
      kind: 'recovered' as const,
      callLogId: intent.callLogId,
      newlyBound,
      unsafeReason,
      deploymentCircuitTripped,
    };
  }, `webhook:retell-provider-intent:${metadata.intentId}`);

  if (recovered.kind === 'context_mismatch') {
    return { recognized: false, reason: 'intent_context_mismatch' };
  }
  if (recovered.kind === 'collision') {
    return {
      recognized: true,
      tenantId: resolution.tenantId,
      intentId: metadata.intentId,
      callLogId: recovered.callLogId,
      newlyBound: false,
      quarantined: true,
      stopRequired: true,
      reason: 'provider_call_collision',
      deploymentCircuitTripped: false,
    };
  }
  if (recovered.kind === 'replay') {
    return {
      recognized: true,
      tenantId: resolution.tenantId,
      intentId: metadata.intentId,
      callLogId: recovered.callLogId,
      newlyBound: false,
      quarantined: true,
      stopRequired: true,
      reason: 'provider_call_replay',
      deploymentCircuitTripped: false,
    };
  }
  return {
    recognized: true,
    tenantId: resolution.tenantId,
    intentId: metadata.intentId,
    callLogId: recovered.callLogId,
    newlyBound: recovered.newlyBound,
    quarantined: recovered.unsafeReason !== null,
    stopRequired: recovered.unsafeReason !== null && !input.terminalEvent,
    reason: recovered.unsafeReason
      ?? (recovered.newlyBound ? 'provider_call_bound' : 'provider_call_already_bound'),
    deploymentCircuitTripped: recovered.deploymentCircuitTripped,
  };
}
