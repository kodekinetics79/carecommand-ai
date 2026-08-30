import { env } from '../../config/env';
import { Prisma } from '../../generated/prisma/client';
import { runWithTenantContext } from '../tenantContext';
import {
  evaluateRetellAgentReadiness,
  expectedRetellAgentWebhookUrl,
  isTransientRetellProviderError,
  probeRetellAgent,
  RETELL_AGENT_VERIFICATION_TTL_MS,
  type MockDeploymentSnapshot,
  type RetellAgentSnapshot,
} from '../retell';

// ===========================================================================
// Provider verification.
//
// One implementation, three callers: the verify route, a deployment, and the
// hourly re-verification worker. Its shape is the one the route already had
// and which the review insists on keeping — probe OUTSIDE any transaction,
// commit INSIDE a short one — because a provider round trip inside
// `runWithTenantContext` would hold the tenant-wide advisory lock for seconds
// and abort on Prisma's transaction timeout.
//
// Verification never upgrades a claim on its own: a transient provider failure
// leaves an existing VERIFIED snapshot exactly as it was, and drift on an
// agent that is answering live calls is refused rather than silently adopted.
// ===========================================================================

export interface VerifyActor {
  userId: string | null;
  source: 'USER' | 'SYSTEM' | 'DEPLOY';
  requestId?: string;
  ip?: string;
  /** Required when no request context exists (worker, seed): tenantContext fails closed without it. */
  trustedActor?: { id: string; role: string; requestId?: string };
}

export type AgentRow = Prisma.ReceptionistAgentGetPayload<Record<string, never>>;

export type VerifyOutcome =
  | { kind: 'verified'; agent: AgentRow; deploymentChanged: boolean }
  | { kind: 'failed'; agent: AgentRow; code: string; permanent: boolean; httpStatus: 200 | 503 }
  | { kind: 'drift_blocked'; agent: AgentRow; code: 'provider_deployment_drift' }
  | { kind: 'not_found' }
  // `unlinked` and `concurrent_change` carry the row so the verify route can
  // answer with the full `{ code, message, agent }` contract (C1 / M20) instead
  // of a bare Fastify error the Studio cannot render against the agent.
  | { kind: 'unlinked'; agent: AgentRow }
  | { kind: 'cooldown'; retryAfterSeconds: number }
  | { kind: 'concurrent_change'; agent: AgentRow };

export interface VerifyInput {
  tenantId: string;
  agentId: string;
  actor: VerifyActor;
  now?: Date;
  skipCooldown?: boolean;
}

const PERMANENT_PROBE_FAILURES = new Set(['not_found', 'invalid_request', 'invalid_response', 'tag_dynamic_variables_not_empty']);

function verifyCooldownMs(): number {
  if (env.RECEPTIONIST_VERIFY_COOLDOWN_MS !== undefined) return env.RECEPTIONIST_VERIFY_COOLDOWN_MS;
  // Zero in tests on purpose: suites verify the same agent repeatedly to prove
  // drift and recovery, and a wall-clock cooldown would make those flaky.
  return env.NODE_ENV === 'test' ? 0 : 60_000;
}

export function providerSnapshotData(snapshot: RetellAgentSnapshot) {
  return {
    providerVersion: snapshot.version,
    providerPublished: snapshot.published,
    providerAssignedTags: snapshot.assignedTags,
    providerVoiceId: snapshot.voiceId,
    providerLanguage: snapshot.language,
    providerWebhookUrl: snapshot.webhookUrl,
    providerWebhookEvents: snapshot.webhookEvents,
    providerDataStorageSetting: snapshot.dataStorageSetting,
    providerSignedUrl: snapshot.signedUrl,
    providerResponseEngineType: snapshot.responseEngineType,
    providerResponseEngineId: snapshot.responseEngineId,
    providerResponseEngineVersion: snapshot.responseEngineVersion,
    providerLastModifiedAt: snapshot.lastModifiedAt,
    providerFingerprint: snapshot.fingerprint,
    providerResponseEngineGraphFingerprint: snapshot.responseEngineGraphFingerprint,
    providerEffectiveDynamicVariables: snapshot.effectiveDynamicVariables as Prisma.InputJsonValue,
    providerBookToolSchema: snapshot.bookToolSchema as Prisma.InputJsonValue,
    providerBookToolFingerprint: snapshot.bookToolFingerprint,
    providerToolCallStrictMode: snapshot.toolCallStrictMode,
    providerPromptHash: snapshot.promptHash,
  };
}

export function providerIntakeEvidenceFailure(snapshot: RetellAgentSnapshot): string | null {
  if (snapshot.bookToolProbeStatus === 'UNAVAILABLE') return 'provider_response_engine_unavailable';
  if (snapshot.bookToolProbeStatus === 'UNSUPPORTED') return 'provider_response_engine_unsupported';
  if (!snapshot.responseEngineGraphFingerprint || !snapshot.bookToolSchema || !snapshot.bookToolFingerprint) {
    return 'provider_intake_contract_unattested';
  }
  if (snapshot.toolCallStrictMode !== true) return 'provider_intake_contract_not_strict';
  return null;
}

export async function verifyAgentProvider(input: VerifyInput): Promise<VerifyOutcome> {
  const now = input.now ?? new Date();

  // ---- Load + cooldown, in a short read transaction -------------------------
  const prepared = await runWithTenantContext(input.tenantId, async tx => {
    const agent = await tx.receptionistAgent.findFirst({ where: { id: input.agentId, tenantId: input.tenantId } });
    if (!agent) return { kind: 'not_found' as const };
    if (!agent.providerAgentId) return { kind: 'unlinked' as const, agent };
    const cooldown = verifyCooldownMs();
    // A cooldown only protects the provider from pointless repeats: it applies
    // when the last attempt failed transiently, or succeeded with nothing
    // changed since. A configuration change or a permanent failure is always
    // allowed straight through, because those are what the operator is fixing.
    if (!input.skipCooldown && input.actor.source === 'USER' && cooldown > 0 && agent.providerLastAttemptAt) {
      const sinceMs = now.getTime() - agent.providerLastAttemptAt.getTime();
      const repeatOfSuccess = agent.providerLastAttemptStatus === 'SUCCEEDED' && agent.providerVerifiedRevision === agent.providerConfigRevision;
      const transientRetry = agent.providerLastAttemptStatus === 'FAILED' && isTransientRetellProviderError(agent.providerLastErrorCode);
      if (sinceMs < cooldown && (repeatOfSuccess || transientRetry)) {
        return { kind: 'cooldown' as const, retryAfterSeconds: Math.ceil((cooldown - sinceMs) / 1_000) };
      }
    }
    const deployment = agent.currentDeploymentId
      ? await tx.receptionistAgentDeployment.findFirst({ where: { id: agent.currentDeploymentId, tenantId: input.tenantId } })
      : null;
    return { kind: 'ready' as const, agent, deployment };
  }, input.actor.trustedActor);

  if (prepared.kind !== 'ready') return prepared;
  const before = prepared.agent;
  const deployment = prepared.deployment;

  // Mock evidence is resolved HERE, inside the tenant context, and handed to
  // the probe. The provider client stays database-free, and the probe cannot
  // silently read zero rows when RLS is enforced at runtime.
  const mockDeployment: MockDeploymentSnapshot | null = deployment && deployment.mock
    && deployment.providerAgentId && deployment.providerAgentVersion !== null
    && deployment.providerLlmId && deployment.providerLlmVersion !== null
    ? {
      providerAgentId: deployment.providerAgentId,
      providerAgentVersion: deployment.providerAgentVersion,
      providerLlmId: deployment.providerLlmId,
      providerLlmVersion: deployment.providerLlmVersion,
      providerVersionTag: deployment.providerVersionTag,
      promptHash: deployment.promptHash,
      beginMessageHash: deployment.beginMessageHash,
      toolFingerprint: deployment.toolFingerprint,
      voiceId: deployment.voiceId,
      language: deployment.language,
      toolsJson: deployment.toolsJson,
    }
    : null;

  // ---- Provider probe, with nothing open -----------------------------------
  const attemptedAt = new Date();
  const probe = await probeRetellAgent(before.providerAgentId!, before.providerVersionTag, {
    // A CareCommand deployment is pinned to the exact version it published;
    // Retell exposes no public tag-assignment write, so the tag would never be
    // assigned and a live deployment could otherwise never reach VERIFIED.
    pinnedVersion: deployment?.providerAgentVersion ?? null,
    mockDeployment,
  });
  const permanentProbeFailure = !probe.ok && PERMANENT_PROBE_FAILURES.has(probe.error);
  const readinessFailure = probe.ok
    ? evaluateRetellAgentReadiness(probe.snapshot, {
      versionTag: before.providerVersionTag,
      webhookUrl: expectedRetellAgentWebhookUrl(),
      pinnedVersion: deployment?.providerAgentVersion ?? null,
      expectedPromptHash: deployment?.promptHash ?? null,
      expectedToolsFingerprint: deployment?.toolFingerprint ?? null,
    })
    : null;
  const intakeEvidenceFailure = probe.ok ? providerIntakeEvidenceFailure(probe.snapshot) : null;
  const safeError = probe.ok ? readinessFailure ?? intakeEvidenceFailure : probe.error;

  // ---- Commit, in a short write transaction ---------------------------------
  return runWithTenantContext(input.tenantId, async tx => {
    const current = await tx.receptionistAgent.findFirst({ where: { id: input.agentId, tenantId: input.tenantId } });
    if (!current) return { kind: 'not_found' as const };
    if (current.providerConfigRevision !== before.providerConfigRevision
      || current.providerAgentId !== before.providerAgentId
      || current.providerVersionTag !== before.providerVersionTag) {
      return { kind: 'concurrent_change' as const, agent: current };
    }

    const success = probe.ok && !readinessFailure && !intakeEvidenceFailure;
    const failedCandidateChanged = probe.ok && current.providerStatus === 'VERIFIED'
      && (
        current.providerVersion !== probe.snapshot.version
        || current.providerFingerprint !== probe.snapshot.fingerprint
        || current.providerResponseEngineType !== probe.snapshot.responseEngineType
        || current.providerResponseEngineId !== probe.snapshot.responseEngineId
        || current.providerResponseEngineVersion !== probe.snapshot.responseEngineVersion
      );
    const deploymentChanged = success && current.providerStatus === 'VERIFIED'
      && (
        current.providerVersion !== probe.snapshot.version
        || current.providerFingerprint !== probe.snapshot.fingerprint
        || (probe.snapshot.bookToolProbeStatus === 'SUCCEEDED'
          && (current.providerResponseEngineGraphFingerprint !== probe.snapshot.responseEngineGraphFingerprint
            || current.providerBookToolFingerprint !== probe.snapshot.bookToolFingerprint))
      );

    if (deploymentChanged) {
      const [studioReference, outboundReference] = await Promise.all([
        tx.receptionistCampaign.findFirst({ where: { tenantId: input.tenantId, agentId: input.agentId, status: 'ACTIVE' }, select: { id: true } }),
        tx.receptionistOutboundCampaign.findFirst({ where: { tenantId: input.tenantId, agentId: input.agentId, status: { in: ['SCHEDULED', 'RUNNING'] } }, select: { id: true } }),
      ]);
      if (studioReference || outboundReference) {
        const row = await tx.receptionistAgent.update({
          where: { id: input.agentId },
          data: {
            providerLastAttemptAt: attemptedAt,
            providerLastAttemptStatus: 'FAILED',
            providerLastAttemptSource: input.actor.source,
            providerLastErrorCode: 'provider_deployment_drift',
          },
        });
        await writeAudit(tx, input, {
          action: 'receptionistAgent.providerDeploymentDriftDetected',
          resourceId: input.agentId,
          metadata: {
            pinnedVersion: current.providerVersion,
            detectedVersion: probe.ok ? probe.snapshot.version : null,
            studioCampaignActive: Boolean(studioReference),
            outboundCampaignRunnable: Boolean(outboundReference),
          },
        });
        return { kind: 'drift_blocked' as const, agent: row, code: 'provider_deployment_drift' as const };
      }
    }

    const data: Prisma.ReceptionistAgentUpdateInput = {
      providerLastAttemptAt: attemptedAt,
      providerLastAttemptStatus: success ? 'SUCCEEDED' : 'FAILED',
      providerLastAttemptSource: input.actor.source,
      providerLastErrorCode: safeError,
      ...(success && probe.ok ? providerSnapshotData(probe.snapshot) : {}),
      ...(success ? {
        providerStatus: 'VERIFIED' as const,
        providerVerifiedRevision: current.providerConfigRevision,
        providerVerifiedAt: attemptedAt,
        providerVerificationExpiresAt: new Date(attemptedAt.getTime() + RETELL_AGENT_VERIFICATION_TTL_MS),
      } : (permanentProbeFailure || (probe.ok && (current.providerStatus !== 'VERIFIED' || failedCandidateChanged))) ? {
        providerStatus: 'INVALID' as const,
        providerVerifiedRevision: null,
        providerVerifiedAt: null,
        providerVerificationExpiresAt: null,
      } : {}),
    };
    const row = await tx.receptionistAgent.update({ where: { id: input.agentId }, data });

    if (deployment) {
      await tx.receptionistAgentDeployment.update({
        where: { id: deployment.id },
        data: success
          ? { status: 'VERIFIED', verifiedAt: attemptedAt, providerErrorCode: null }
          : { status: deployment.status === 'VERIFIED' ? 'VERIFIED' : deployment.status, providerErrorCode: safeError },
      });
    }

    await writeAudit(tx, input, {
      action: success
        ? deploymentChanged ? 'receptionistAgent.providerDeploymentUpdated' : 'receptionistAgent.providerVerified'
        : 'receptionistAgent.providerVerificationFailed',
      resourceId: input.agentId,
      metadata: {
        providerStatus: row.providerStatus,
        providerVersion: row.providerVersion,
        providerVersionTag: row.providerVersionTag,
        deploymentId: deployment?.id ?? null,
        deploymentChanged,
        source: input.actor.source,
        reason: safeError,
      },
    });

    if (success) return { kind: 'verified' as const, agent: row, deploymentChanged };
    const transient = (!probe.ok && !permanentProbeFailure) || intakeEvidenceFailure === 'provider_response_engine_unavailable';
    return {
      kind: 'failed' as const,
      agent: row,
      code: safeError ?? 'invalid_response',
      permanent: !transient,
      httpStatus: transient ? 503 as const : 200 as const,
    };
  }, input.actor.trustedActor);
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  input: VerifyInput,
  event: { action: string; resourceId: string; metadata: Prisma.InputJsonObject },
) {
  await tx.auditEvent.create({ data: {
    tenantId: input.tenantId,
    actorUserId: input.actor.userId,
    action: event.action,
    resource: 'receptionistAgent',
    resourceId: event.resourceId,
    requestId: input.actor.requestId,
    ipAddress: input.actor.ip,
    metadata: event.metadata,
  } });
}
