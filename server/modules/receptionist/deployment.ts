import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { retellConfigStatus, retellProviderMode } from '../../lib/retell';
import { agentReadinessReason } from '../../lib/receptionist/agentReadiness';
import { remediationFor } from '../../lib/receptionist/remediation';
import { confirmationChannelStatus } from '../../lib/receptionist/confirmationOutbox';
import { maskPhone, maskProviderId, evaluateLiveCallAdmission, liveCallUatScope, liveCallUatStatus } from '../../lib/receptionist/liveCallUat';
import {
  campaignPromptConfig,
  deployCampaignToRetell,
  deploymentChanges,
  loadCampaignGraph,
  planDeployment,
} from '../../lib/receptionist/retellDeploy';
import { tenantFacingVoices, voicesCatalogSection } from '../../lib/receptionist/catalogVoices';
import { configurationReference, VOICE } from '../../../src/lib/receptionistVocabulary';
import { uuid, idParam, writeRoles, callArtifactRead } from './shared';

// ===========================================================================
// Deployment, provider status and the voice catalogue.
//
// This is the "go live" surface: publish a campaign to Retell, see what is
// deployed versus what is drafted, and read an honest answer to "can this
// clinic take a call right now?".
// ===========================================================================

type DeploymentRowShape = {
  id: string; status: string; mock: boolean; providerAgentId: string | null; providerAgentVersion: number | null;
  providerLlmVersion: number | null; providerVersionTag: string; promptHash: string; toolFingerprint: string;
  intakeFingerprint: string; configFingerprint: string; voiceId: string; language: string; steps: unknown;
  providerErrorCode: string | null; numberBound: boolean; boundPhoneNumber: string | null;
  deployedBySource: string; startedAt: Date; publishedAt: Date | null; verifiedAt: Date | null;
};

/**
 * Deployment rows are evidence, not a prompt archive for the browser: the
 * deployed prompt text and tool bodies stay server-side.
 *
 * Masking the provider id was not enough. `agen…7f21`, a published version
 * number, an LLM version number, a version tag and four fingerprint hashes
 * were all still on the wire and on the screen, and a clinic owner can act on
 * none of them — they are our supplier's coordinates, printed at the exact
 * moment the owner is anxious about their phone line. They collapse to one
 * `configurationReference`, which is a suffix of CareCommand's own row id and
 * is the string support asks for.
 *
 * The mechanics are not deleted: `platformDeploymentProjection` below returns
 * every one of them, and it is reachable only from the platform routes and
 * from a tenant user holding `platform:voice-line-mechanics:read`, which no
 * default role has.
 */
function deploymentProjection(row: DeploymentRowShape) {
  return {
    id: row.id,
    status: row.status,
    mock: row.mock,
    configurationReference: configurationReference({ deploymentId: row.id }),
    voiceId: row.voiceId,
    language: row.language,
    steps: row.steps,
    providerErrorCode: row.providerErrorCode,
    numberBound: row.numberBound,
    boundPhoneNumberMasked: maskPhone(row.boundPhoneNumber),
    deployedBySource: row.deployedBySource,
    startedAt: row.startedAt,
    publishedAt: row.publishedAt,
    verifiedAt: row.verifiedAt,
  };
}

/**
 * The support view of the same row. Everything `deploymentProjection` drops,
 * plus the reference that ties the two together. Never merged into a tenant
 * response by default — the caller must have proven the permission first.
 */
export function platformDeploymentProjection(row: DeploymentRowShape) {
  return {
    ...deploymentProjection(row),
    providerAgentIdMasked: maskProviderId(row.providerAgentId),
    providerAgentVersion: row.providerAgentVersion,
    providerLlmVersion: row.providerLlmVersion,
    providerVersionTag: row.providerVersionTag,
    promptHash: row.promptHash,
    toolFingerprint: row.toolFingerprint,
    intakeFingerprint: row.intakeFingerprint,
    configFingerprint: row.configFingerprint,
  };
}

async function attendedUatBlock(tenantId: string, now: Date) {
  const liveTest = liveCallUatStatus(now, tenantId);
  const scope = liveCallUatScope();
  const attempts = scope
    ? await db.idempotencyKey.findMany({
      where: { tenantId, scope },
      select: { resultId: true },
      take: Math.max(20, liveTest.maxCalls + 1),
    })
    : [];
  const callIds = attempts
    .map(attempt => attempt.resultId)
    .filter((value): value is string => Boolean(value && !value.startsWith('blocked:') && value !== 'dispatching'));
  const calls = callIds.length
    ? await db.receptionistCallLog.findMany({ where: { tenantId, id: { in: callIds } }, select: { durationSeconds: true, endedAt: true, outcome: true } })
    : [];
  const connectedSeconds = calls.reduce((sum, call) => sum + call.durationSeconds, 0);
  const activeCalls = calls.filter(call => !call.endedAt && call.outcome === 'IN_PROGRESS').length;
  const admission = evaluateLiveCallAdmission({ attemptsUsed: attempts.length, connectedSeconds, activeCalls }, now, tenantId);
  return {
    ...liveTest,
    attemptsUsed: attempts.length,
    callsRemaining: Math.max(0, liveTest.maxCalls - attempts.length),
    minutesUsed: Math.ceil(connectedSeconds / 60),
    minutesRemaining: Math.max(0, liveTest.maxTotalMinutes - Math.ceil(connectedSeconds / 60)),
    activeCalls,
    admissionReason: admission.allowed ? null : admission.reason,
  };
}

export const deploymentRoutes: FastifyPluginAsync = async app => {
  // Deploy publishes; verification is a SECOND request. Four provider round
  // trips plus a verification probe do not fit inside one serverless
  // invocation, so this answers `verification: pending` and the client calls
  // verify-provider next. Nothing is ever reported verified that was not read
  // back from the provider.
  app.post('/campaigns/:id/deploy', {
    preHandler: writeRoles,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const outcome = await deployCampaignToRetell({
      tenantId: request.auth.tenantId,
      campaignId: id,
      actor: { userId: request.auth.userId, source: 'USER', requestId: request.id, ip: request.ip },
    });
    if (outcome.ok) {
      return reply.code(200).send({
        deployment: deploymentProjection(outcome.deployment),
        verification: { status: 'pending' as const },
        message: `Published to the line. Run the ${VOICE.checkLower} to confirm the live line is running exactly this configuration.`,
      });
    }
    const remediation = remediationFor(outcome.code, { campaignId: id });
    const body = {
      code: outcome.code,
      message: outcome.message,
      title: remediation.title,
      action: remediation.action,
      fixHref: remediation.fixHref,
      deployment: outcome.deployment ? deploymentProjection(outcome.deployment) : null,
      ...(outcome.placeholders ? { placeholders: outcome.placeholders } : {}),
      ...(outcome.retryAfterSeconds !== undefined ? { retryAfterSeconds: outcome.retryAfterSeconds } : {}),
    };
    if (outcome.code === 'cooldown' || outcome.code === 'tenant_rate_limited') return reply.code(429).send(body);
    if (outcome.code === 'provider_unavailable' || outcome.code === 'provider_unauthorized' || outcome.code === 'provider_rate_limited') {
      return reply.code(503).send(body);
    }
    return reply.code(409).send(body);
  });

  // Latest only. Deployment history is an audit question and AuditEvent already
  // answers it (contract §13 cuts the history view for the pilot).
  app.get('/campaigns/:id/deployments/latest', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await db.receptionistCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { id: true } });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const row = await db.receptionistAgentDeployment.findFirst({
      where: { tenantId: request.auth.tenantId, campaignId: id },
      orderBy: { startedAt: 'desc' },
    });
    return { deployment: row ? deploymentProjection(row) : null };
  });

  // What differs between the draft and what is deployed — chips only. The
  // line-diff viewer is a cut (contract §13); the chips are what an operator
  // acts on and the hashes are the evidence behind them.
  app.get('/campaigns/:id/deployment-diff', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await loadCampaignGraph(db, request.auth.tenantId, id);
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const deployment = await db.receptionistAgentDeployment.findFirst({
      where: { tenantId: request.auth.tenantId, campaignId: id, status: { in: ['PUBLISHED', 'VERIFIED'] } },
      orderBy: { startedAt: 'desc' },
    });
    const promptConfig = await campaignPromptConfig(db, campaign, request.auth.tenantId);
    if (!promptConfig) {
      throw app.httpErrors.conflict('No locale pack is available for this clinic’s country and language, so the prompt cannot be rendered. Approve a locale pack for the clinic.');
    }
    const plan = planDeployment(promptConfig, { mock: deployment?.mock });
    // The diff is a set of CHIPS — "Prompt changed", "Voice changed". The
    // hashes behind them were the evidence, and shipping them let the browser
    // print `prompt a91f0c3d…` beside a version number in a card whose whole
    // job is to answer "is my phone line current?". `changed` already answers
    // that; the fingerprints only ever told a reader which supplier we call.
    // They stay server-side and reach support through the platform route.
    return {
      deployment: deployment
        ? {
          id: deployment.id, status: deployment.status, verifiedAt: deployment.verifiedAt,
          configurationReference: configurationReference({ deploymentId: deployment.id }),
          voiceId: deployment.voiceId, language: deployment.language,
        }
        : null,
      draft: {
        voiceId: plan.voiceId,
        language: plan.language,
        toolNames: plan.config.tools.map(tool => String(tool.name ?? '')).sort(),
      },
      changed: deploymentChanges(plan, deployment),
      placeholders: plan.placeholders,
    };
  });

  // Voice-line and receptionist readiness for one scope, with server-authored
  // blockers. Replaces the tenant-wide checklist that conflated "are the
  // environment variables set" with "can any receptionist actually answer a
  // call".
  //
  // The path used to be `/retell-status`. A URL is not private: it is in the
  // network tab, in a copied cURL, in any error a clinic forwards to us. It
  // named the supplier on every poll of the Go live screen. `/retell-status`
  // is kept below as a silent alias so nothing that already calls it breaks.
  const voiceLineStatus = async (request: Parameters<typeof callArtifactRead>[0]) => {
    const query = z.object({ clinicId: uuid.optional(), campaignId: uuid.optional() }).parse(request.query);
    const status = retellConfigStatus();
    const blockers: Array<{ code: string; severity: 'blocking' | 'warning'; title: string; action: string; fixHref: string | null; scope: string }> = [];
    for (const missing of status.missing) {
      // The missing ENV VAR NAME stays here and never leaves the server: which
      // credential is absent is CareCommand's operational fact, and naming it
      // told the clinic who we buy from without telling them anything they
      // could act on. The code they receive is provider-neutral.
      const code = missing === 'RETELL_API_KEY' ? 'voice_service_key_missing' : 'voice_service_number_missing';
      const remediation = remediationFor(code);
      blockers.push({ code, severity: 'blocking', title: remediation.title, action: remediation.action, fixHref: null, scope: 'server' });
    }

    const campaign = query.campaignId
      ? await db.receptionistCampaign.findFirst({
        where: { id: query.campaignId, tenantId: request.auth.tenantId },
        select: { id: true, clinicId: true, agent: true },
      })
      : null;
    const agent = campaign?.agent
      ?? await db.receptionistAgent.findFirst({
        where: {
          tenantId: request.auth.tenantId,
          active: true,
          ...(query.clinicId ? { clinicId: query.clinicId } : campaign ? { clinicId: campaign.clinicId } : {}),
        },
        orderBy: [{ providerVerifiedAt: 'desc' }, { createdAt: 'asc' }],
      });

    const reason = agent ? agentReadinessReason(agent) : null;
    if (agent && reason) {
      // An INVALID agent has a specific provider reason; show that, not the
      // generic "unverified", so the operator knows what to fix.
      const code = agent.providerStatus === 'INVALID' && agent.providerLastErrorCode ? agent.providerLastErrorCode : reason;
      const remediation = remediationFor(code, { clinicId: agent.clinicId, agentId: agent.id, campaignId: campaign?.id ?? null });
      blockers.push({ code, severity: 'blocking', title: remediation.title, action: remediation.action, fixHref: remediation.fixHref, scope: 'agent' });
    } else if (!agent) {
      const remediation = remediationFor('agent_linked', { clinicId: query.clinicId ?? null, campaignId: campaign?.id ?? null });
      blockers.push({ code: 'agent_linked', severity: 'blocking', title: remediation.title, action: remediation.action, fixHref: remediation.fixHref, scope: 'clinic' });
    }

    const now = new Date();
    const expiresAt = agent?.providerVerificationExpiresAt ?? null;
    // The attended live-UAT block is demo-only. Outside the demo profile it is
    // not merely unavailable — it must not appear as something switchable on.
    const attendedUat = env.DEPLOYMENT_PROFILE === 'demo' ? await attendedUatBlock(request.auth.tenantId, now) : null;

    return {
      providerConfigured: status.configured,
      providerMode: retellProviderMode(),
      agentReady: Boolean(agent) && reason === null,
      agentScope: {
        clinicId: agent?.clinicId ?? query.clinicId ?? null,
        campaignId: campaign?.id ?? null,
        agentId: agent?.id ?? null,
        agentName: agent?.name ?? null,
      },
      verification: {
        status: agent?.providerStatus ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
        expiresInMs: expiresAt ? Math.max(0, expiresAt.getTime() - now.getTime()) : null,
        autoRenew: {
          enabled: env.QUEUES_ENABLED,
          lastSystemAttemptAt: agent?.providerLastAttemptSource === 'SYSTEM' ? agent.providerLastAttemptAt?.toISOString() ?? null : null,
        },
      },
      blockers,
      attendedUat,
      adhocTestCallsAllowed: status.mock && env.NODE_ENV !== 'production',
    };
  };

  app.get('/voice-line-status', { preHandler: callArtifactRead }, voiceLineStatus);
  // Compatibility alias. Removed once no printed fix link and no cached client
  // bundle still asks for it; the ratchet stops any NEW caller being written.
  app.get('/retell-status', { preHandler: callArtifactRead }, voiceLineStatus);

  // Whether an enabled confirmation can actually be delivered. The campaign
  // toggle is refused when it cannot: the agent must never promise a text that
  // nothing will send.
  app.get('/confirmation-channels', { preHandler: callArtifactRead }, async () => ({
    sms: confirmationChannelStatus('sms'),
    email: confirmationChannelStatus('email'),
  }));

  // Voice catalogue, with the cache/provider state the catalog read does not
  // carry. GET /catalog serves the same list (contract §7); this route adds
  // `source`, `fetchedAt` and `error`, which is what lets the client say WHY a
  // voice select is empty rather than showing an unexplained blank. The client
  // asks for it only when the catalog came back with no voices.
  //
  // `provider` is dropped on the way out by `tenantFacingVoices`, the same
  // helper the catalog uses. The catalogue upstream tags each voice with the
  // house that synthesised it, and the Studio's voice select printed it after a
  // middot — so the dropdown where an owner names their receptionist also named
  // two of our suppliers, five times over, on a screen nobody thinks of as an
  // integration screen. Nothing chooses a voice on that field: gender and
  // accent are what an owner picks on, and they stay.
  app.get('/voices', { preHandler: callArtifactRead }, async () => {
    const section = await voicesCatalogSection();
    return { ...section, voices: tenantFacingVoices(section.voices) };
  });
};
