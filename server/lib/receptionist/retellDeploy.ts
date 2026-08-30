import { createHash } from 'node:crypto';
import { env } from '../../config/env';
import { Prisma } from '../../generated/prisma/client';
import { db } from '../db';
import { runWithTenantContext, type TenantTxClient } from '../tenantContext';
import {
  buildRetellConfig,
  generateSystemPrompt,
  type PromptConfig,
  type RetellConfig,
} from '../../modules/receptionist/promptService';
import {
  createRetellAgent,
  createRetellLlm,
  expectedRetellAgentWebhookUrl,
  fingerprintTools,
  hashPrompt,
  publishRetellAgent,
  retellConfigStatus,
  updatePhoneNumberInboundAgent,
  updateRetellAgent,
  updateRetellLlm,
  type RetellProviderResult,
} from '../retell';
import { findPlaceholders, type Placeholder } from './placeholders';
import { assemblePromptConfig, type PromptAssemblyClient } from './promptAssembly';
import type { DeployFailureCode } from './remediation';
import { verifyAgentProvider, type VerifyActor, type VerifyOutcome } from './agentVerification';

// ===========================================================================
// Deploying a campaign to Retell.
//
// The shape of this file is dictated by two facts. Provider calls take
// seconds, and `runWithTenantContext` is a Prisma interactive transaction that
// holds a tenant-wide advisory lock — so no provider call may happen inside
// one. And the API runs on a function with a 60 s ceiling, so the whole thing
// must fit a budget with room to answer.
//
// Hence: two short transactions with the provider work between them, exactly
// like the verify route already does. Transaction #1 plans and claims;
// provider calls run with nothing open; transaction #2 re-reads the agent,
// refuses if it changed underneath us, and commits the deployment, the agent
// and the audit event together. A deploy answers PUBLISHED with verification
// pending, and the client calls verify — publishing and attesting are two
// requests because together they do not fit in one.
// ===========================================================================

export interface DeployPlan {
  config: RetellConfig;
  systemPrompt: string;
  promptHash: string;
  beginMessageHash: string;
  toolFingerprint: string;
  configFingerprint: string;
  intakeFingerprint: string;
  intakeSchemaRevision: number;
  voiceId: string;
  language: string;
  placeholders: Placeholder[];
  mock: boolean;
}

/**
 * Pure. The single source of what a deployment WOULD publish — used by deploy,
 * by the draft-versus-deployed diff, and by readiness, so all three agree.
 */
export function planDeployment(config: PromptConfig, options: { mock?: boolean } = {}): DeployPlan {
  const mock = options.mock ?? retellConfigStatus().mock;
  const built = buildRetellConfig(config, { webhookBaseUrl: env.PUBLIC_API_URL });
  const systemPrompt = generateSystemPrompt(config);
  return {
    config: built,
    systemPrompt,
    promptHash: hashPrompt(systemPrompt, { mock }),
    beginMessageHash: hashPrompt(built.beginMessage, { mock }),
    toolFingerprint: fingerprintTools(built.tools, { mock }),
    // Everything the provider agent carries that is NOT the prompt or the
    // tools, so a voice or language change is visible as its own difference.
    configFingerprint: createHash('sha256').update(JSON.stringify({
      voiceId: built.voiceId,
      language: built.language,
      webhookUrl: built.webhookUrl,
      dynamicVariableKeys: Object.keys(built.dynamicVariables).sort(),
      callOutcomeFields: built.callOutcomeFields,
    })).digest('hex'),
    intakeFingerprint: built.intakeToolFingerprint,
    intakeSchemaRevision: built.intakeSchemaRevision,
    voiceId: built.voiceId,
    language: built.language,
    placeholders: findPlaceholders(config),
    mock,
  };
}

export type DeployChange = 'prompt' | 'beginMessage' | 'tools' | 'intake' | 'voice' | 'language' | 'config';

/** Which parts of the draft differ from what is deployed. Chips, not a diff viewer. */
export function deploymentChanges(
  plan: Pick<DeployPlan, 'promptHash' | 'beginMessageHash' | 'toolFingerprint' | 'intakeFingerprint' | 'configFingerprint' | 'voiceId' | 'language'>,
  deployed: {
    promptHash: string; beginMessageHash: string; toolFingerprint: string;
    intakeFingerprint: string; configFingerprint: string; voiceId: string; language: string;
  } | null,
): DeployChange[] {
  if (!deployed) return ['prompt', 'beginMessage', 'tools', 'intake', 'voice', 'language', 'config'];
  const changed: DeployChange[] = [];
  if (plan.promptHash !== deployed.promptHash) changed.push('prompt');
  if (plan.beginMessageHash !== deployed.beginMessageHash) changed.push('beginMessage');
  if (plan.toolFingerprint !== deployed.toolFingerprint) changed.push('tools');
  if (plan.intakeFingerprint !== deployed.intakeFingerprint) changed.push('intake');
  if (plan.voiceId !== deployed.voiceId) changed.push('voice');
  if (plan.language !== deployed.language) changed.push('language');
  if (plan.configFingerprint !== deployed.configFingerprint && !changed.includes('voice') && !changed.includes('language')) changed.push('config');
  return changed;
}

export type DeployStepName = 'ensure_llm' | 'ensure_agent' | 'publish' | 'bind_number' | 'verify';
export interface DeployStep { name: DeployStepName; status: 'ok' | 'failed' | 'skipped'; at: string; providerErrorCode?: string; detail?: string }

export type DeploymentRow = Prisma.ReceptionistAgentDeploymentGetPayload<Record<string, never>>;

export type DeployOutcome =
  | { ok: true; deployment: DeploymentRow; verification: { status: 'pending' } }
  | { ok: false; code: DeployFailureCode; message: string; deployment: DeploymentRow | null; retryAfterSeconds?: number; placeholders?: Placeholder[] };

export interface DeployInput {
  tenantId: string;
  campaignId: string;
  actor: VerifyActor;
  now?: Date;
}

function userCooldownMs(): number {
  if (env.RECEPTIONIST_DEPLOY_COOLDOWN_MS !== undefined) return env.RECEPTIONIST_DEPLOY_COOLDOWN_MS;
  return env.NODE_ENV === 'test' ? 0 : 60_000;
}

const campaignInclude = {
  clinic: { include: { locations: { orderBy: { createdAt: 'asc' } } } },
  agent: true,
  intakeFields: { orderBy: { sortOrder: 'asc' } },
} as const;

type LoadedCampaign = Prisma.ReceptionistCampaignGetPayload<{ include: typeof campaignInclude }>;

/**
 * Shape a loaded campaign into the prompt config, through the ONE shared
 * assembly. C2 made this a database read (hours, approved knowledge, catalog
 * services, locale pack), so it is async and can report that no locale pack
 * exists for the clinic's country and language — in which case nothing can be
 * rendered, and the caller must say so rather than deploy a half-built prompt.
 */
export async function campaignPromptConfig(
  client: PromptAssemblyClient,
  campaign: LoadedCampaign,
  tenantId: string,
): Promise<PromptConfig | null> {
  const prepared = await assemblePromptConfig(client, campaign, tenantId);
  return prepared.ok ? prepared.config : null;
}

export function loadCampaignGraph(client: TenantTxClient | typeof db, tenantId: string, campaignId: string) {
  return client.receptionistCampaign.findFirst({ where: { id: campaignId, tenantId }, include: campaignInclude });
}

function fail(code: DeployFailureCode, message: string, deployment: DeploymentRow | null = null, extra: Partial<DeployOutcome & object> = {}): DeployOutcome {
  return { ok: false, code, message, deployment, ...extra } as DeployOutcome;
}

function providerFailureCode(error: string): DeployFailureCode {
  if (error === 'unauthorized' || error === 'forbidden') return 'provider_unauthorized';
  if (error === 'rate_limited') return 'provider_rate_limited';
  if (error === 'invalid_request' || error === 'invalid_response') return 'provider_invalid_request';
  if (error === 'setup_required') return 'setup_required';
  return 'provider_unavailable';
}

/**
 * Publish a campaign's prompt and tools to Retell.
 *
 * Verification is deliberately NOT part of this call: four provider round
 * trips plus a verification probe do not fit inside one serverless request, so
 * this returns PUBLISHED with `verification: 'pending'` and the caller verifies
 * next. Nothing is reported as verified that has not been read back from the
 * provider.
 */
export async function deployCampaignToRetell(input: DeployInput): Promise<DeployOutcome> {
  const now = input.now ?? new Date();
  const deadline = now.getTime() + env.RECEPTIONIST_DEPLOY_BUDGET_MS;
  const status = retellConfigStatus();
  if (!status.configured) return fail('setup_required', 'The voice provider is not configured, so nothing was deployed.');
  if (status.mock && env.DEPLOYMENT_PROFILE !== 'demo') {
    return fail('mock_forbidden_in_profile', 'A mock voice provider cannot answer patient calls in this deployment profile.');
  }

  // ---- Transaction #1: plan, gate, claim -----------------------------------
  const claim = await runWithTenantContext(input.tenantId, async tx => {
    const campaign = await loadCampaignGraph(tx, input.tenantId, input.campaignId);
    if (!campaign) return { kind: 'not_found' as const };
    if (!campaign.clinic.active) return { kind: 'error' as const, code: 'agent_inactive' as DeployFailureCode, message: 'The clinic is deactivated.' };
    const agent = campaign.agent;
    if (!agent) return { kind: 'error' as const, code: 'agent_unlinked_and_not_creatable' as DeployFailureCode, message: 'Link an agent to this campaign before deploying.' };
    if (!agent.active) return { kind: 'error' as const, code: 'agent_inactive' as DeployFailureCode, message: 'The agent is deactivated.' };

    const latest = await tx.receptionistAgentDeployment.findFirst({
      where: { tenantId: input.tenantId, agentId: agent.id },
      orderBy: { startedAt: 'desc' },
    });
    // An agent that already points at a provider agent CareCommand never
    // deployed is somebody's hand-built agent; deploying would overwrite it.
    if (agent.providerAgentId && !latest) {
      return { kind: 'error' as const, code: 'engine_not_owned' as DeployFailureCode, message: 'This agent was linked manually. Unlink it before deploying, so CareCommand does not overwrite an agent it did not create.' };
    }
    const cooldown = userCooldownMs();
    if (input.actor.source === 'USER' && cooldown > 0 && latest && now.getTime() - latest.startedAt.getTime() < cooldown) {
      const retryAfterSeconds = Math.ceil((cooldown - (now.getTime() - latest.startedAt.getTime())) / 1_000);
      return { kind: 'error' as const, code: 'cooldown' as DeployFailureCode, message: 'A deployment for this agent started moments ago.', retryAfterSeconds };
    }
    const hourly = await tx.receptionistAgentDeployment.count({
      where: { tenantId: input.tenantId, startedAt: { gt: new Date(now.getTime() - 3_600_000) } },
    });
    if (hourly >= env.RECEPTIONIST_DEPLOY_HOURLY_LIMIT) {
      return { kind: 'error' as const, code: 'tenant_rate_limited' as DeployFailureCode, message: 'This tenant reached its hourly deployment limit.', retryAfterSeconds: 600 };
    }

    const promptConfig = await campaignPromptConfig(tx, campaign, input.tenantId);
    if (!promptConfig) {
      return { kind: 'error' as const, code: 'locale_pack_unavailable' as DeployFailureCode, message: 'No locale pack is available for this clinic’s country and language, so the prompt cannot be rendered.' };
    }
    const plan = planDeployment(promptConfig, { mock: status.mock });
    if (plan.placeholders.length) {
      return { kind: 'error' as const, code: 'placeholders_present' as DeployFailureCode, message: 'Replace the placeholder values before deploying.', placeholders: plan.placeholders };
    }

    const deployment = await tx.receptionistAgentDeployment.create({
      data: {
        tenantId: input.tenantId,
        clinicId: campaign.clinicId,
        agentId: agent.id,
        campaignId: campaign.id,
        status: 'PENDING',
        mock: plan.mock,
        providerVersionTag: agent.providerVersionTag,
        promptHash: plan.promptHash,
        beginMessageHash: plan.beginMessageHash,
        toolFingerprint: plan.toolFingerprint,
        intakeFingerprint: plan.intakeFingerprint,
        intakeSchemaRevision: plan.intakeSchemaRevision,
        configFingerprint: plan.configFingerprint,
        voiceId: plan.voiceId,
        language: plan.language,
        promptText: plan.systemPrompt,
        toolsJson: plan.config.tools as unknown as Prisma.InputJsonValue,
        steps: [],
        deployedById: input.actor.userId,
        deployedBySource: input.actor.source,
        startedAt: now,
      },
    });
    return {
      kind: 'claimed' as const,
      deployment,
      plan,
      agentName: agent.name,
      providerConfigRevision: agent.providerConfigRevision,
      providerAgentId: agent.providerAgentId,
      priorLlmId: latest?.providerLlmId ?? null,
      priorLlmVersion: latest?.providerLlmVersion ?? 0,
      priorAgentVersion: latest?.providerAgentVersion ?? 0,
    };
  }, input.actor.trustedActor);

  if (claim.kind === 'not_found') return fail('agent_unlinked_and_not_creatable', 'Campaign not found.');
  if (claim.kind === 'error') {
    return fail(claim.code, claim.message, null, {
      ...(claim.retryAfterSeconds !== undefined ? { retryAfterSeconds: claim.retryAfterSeconds } : {}),
      ...(claim.placeholders ? { placeholders: claim.placeholders } : {}),
    });
  }

  // ---- Provider calls, with NO transaction open -----------------------------
  const steps: DeployStep[] = [];
  const stamp = (name: DeployStepName, status: DeployStep['status'], extra: Partial<DeployStep> = {}) => {
    steps.push({ name, status, at: new Date().toISOString(), ...extra });
  };
  const outOfBudget = () => Date.now() >= deadline;
  const failDeployment = async (code: DeployFailureCode, providerErrorCode: string, message: string): Promise<DeployOutcome> => {
    const row = await runWithTenantContext(input.tenantId, async tx => {
      const updated = await tx.receptionistAgentDeployment.update({
        where: { id: claim.deployment.id },
        data: { status: 'FAILED', providerErrorCode, steps: steps as unknown as Prisma.InputJsonValue },
      });
      // The agent itself is untouched except for the attempt stamp: a failed
      // deploy must never downgrade a deployment that is currently working.
      await tx.receptionistAgent.update({
        where: { id: claim.deployment.agentId },
        data: { providerLastAttemptAt: new Date(), providerLastAttemptStatus: 'FAILED', providerLastAttemptSource: 'DEPLOY', providerLastErrorCode: providerErrorCode },
      });
      await tx.auditEvent.create({ data: {
        tenantId: input.tenantId,
        actorUserId: input.actor.userId,
        action: 'receptionistAgent.deployFailed',
        resource: 'receptionistAgentDeployment',
        resourceId: claim.deployment.id,
        requestId: input.actor.requestId,
        ipAddress: input.actor.ip,
        metadata: { agentId: claim.deployment.agentId, campaignId: claim.deployment.campaignId, code, providerErrorCode, mock: claim.plan.mock },
      } });
      return updated;
    }, input.actor.trustedActor);
    return fail(code, message, row);
  };

  const llmSpec = {
    generalPrompt: claim.plan.systemPrompt,
    beginMessage: claim.plan.config.beginMessage,
    tools: claim.plan.config.tools,
  };

  // Step 1 — the response engine. We update the one we own, or create a fresh
  // one; creating is only ever chosen when we hold no id, which is what makes
  // a retry after a partial failure idempotent.
  let llm: RetellProviderResult<{ llmId: string; version: number }>;
  if (claim.priorLlmId) {
    llm = await updateRetellLlm(claim.priorLlmId, llmSpec, claim.priorLlmVersion);
  } else {
    llm = await createRetellLlm(llmSpec);
  }
  if (!llm.ok) {
    stamp('ensure_llm', 'failed', { providerErrorCode: llm.error });
    return failDeployment(providerFailureCode(llm.error), llm.error, 'Retell did not accept the prompt. Nothing was published.');
  }
  stamp('ensure_llm', 'ok');
  if (outOfBudget()) {
    stamp('ensure_agent', 'skipped', { detail: 'deploy budget exhausted' });
    return failDeployment('deploy_budget_exhausted', 'deploy_budget_exhausted', 'The deployment ran out of time after the prompt was accepted. Deploy again to continue.');
  }

  // Step 2 — the agent. `response_engine.version` carries the LLM version we
  // just wrote; without it Retell would publish an agent still pinned to the
  // previous engine version and our own verification would read prompt drift.
  const agentSpec = {
    agentName: claim.agentName,
    llmId: llm.value.llmId,
    llmVersion: llm.value.version,
    voiceId: claim.plan.voiceId,
    language: claim.plan.language,
    webhookUrl: expectedRetellAgentWebhookUrl(),
    postCallAnalysisData: claim.plan.config.callOutcomeFields,
  };
  const providerAgent = claim.providerAgentId
    ? await updateRetellAgent(claim.providerAgentId, agentSpec, claim.priorAgentVersion)
    : await createRetellAgent(agentSpec);
  if (!providerAgent.ok) {
    stamp('ensure_agent', 'failed', { providerErrorCode: providerAgent.error });
    return failDeployment(providerFailureCode(providerAgent.error), providerAgent.error, 'Retell did not accept the agent configuration. Nothing was published.');
  }
  stamp('ensure_agent', 'ok');
  if (outOfBudget()) {
    stamp('publish', 'skipped', { detail: 'deploy budget exhausted' });
    return failDeployment('deploy_budget_exhausted', 'deploy_budget_exhausted', 'The deployment ran out of time before publishing. Deploy again to continue.');
  }

  // Step 3 — publish that exact draft version.
  const published = await publishRetellAgent(providerAgent.value.agentId, providerAgent.value.version);
  if (!published.ok) {
    stamp('publish', 'failed', { providerErrorCode: published.error });
    return failDeployment(providerFailureCode(published.error), published.error, 'Retell accepted the agent but did not publish it.');
  }
  stamp('publish', 'ok');

  // Step 4 — point the inbound number at the published version, so a patient
  // calling the clinic reaches this deployment and not whatever answered before.
  let boundNumber: string | null = null;
  if (env.RETELL_FROM_NUMBER && !outOfBudget()) {
    const bound = await updatePhoneNumberInboundAgent(env.RETELL_FROM_NUMBER, {
      agentId: providerAgent.value.agentId,
      agentVersion: published.value.version,
      inboundWebhookUrl: expectedRetellAgentWebhookUrl(),
    });
    if (bound.ok) {
      boundNumber = bound.value.phoneNumber;
      stamp('bind_number', 'ok');
    } else {
      // The agent IS published; only the inbound binding failed. Readiness
      // reports `number_bound` as failing rather than the deploy pretending.
      stamp('bind_number', 'failed', { providerErrorCode: bound.error });
    }
  } else {
    stamp('bind_number', 'skipped', { detail: env.RETELL_FROM_NUMBER ? 'deploy budget exhausted' : 'no RETELL_FROM_NUMBER configured' });
  }
  stamp('verify', 'skipped', { detail: 'verification runs as a separate request' });

  // ---- Transaction #2: commit the deployment, agent and audit atomically -----
  const committed = await runWithTenantContext(input.tenantId, async tx => {
    const current = await tx.receptionistAgent.findFirst({ where: { id: claim.deployment.agentId, tenantId: input.tenantId } });
    if (!current) return { kind: 'gone' as const };
    if (current.providerConfigRevision !== claim.providerConfigRevision || current.providerAgentId !== claim.providerAgentId) {
      const row = await tx.receptionistAgentDeployment.update({
        where: { id: claim.deployment.id },
        data: { status: 'FAILED', providerErrorCode: 'concurrent_change', steps: steps as unknown as Prisma.InputJsonValue },
      });
      return { kind: 'conflict' as const, deployment: row };
    }
    const deployment = await tx.receptionistAgentDeployment.update({
      where: { id: claim.deployment.id },
      data: {
        status: 'PUBLISHED',
        providerAgentId: providerAgent.value.agentId,
        providerAgentVersion: published.value.version,
        providerLlmId: llm.value.llmId,
        providerLlmVersion: llm.value.version,
        numberBound: boundNumber !== null,
        boundPhoneNumber: boundNumber,
        publishedAt: new Date(),
        steps: steps as unknown as Prisma.InputJsonValue,
        providerErrorCode: null,
      },
    });
    await tx.receptionistAgentDeployment.updateMany({
      where: { tenantId: input.tenantId, agentId: claim.deployment.agentId, id: { not: deployment.id }, status: { in: ['PENDING', 'PUBLISHED', 'VERIFIED'] } },
      data: { status: 'SUPERSEDED' },
    });
    // A newly published version is not yet attested: the agent goes back to
    // UNVERIFIED and the client's verify call is what can make it VERIFIED.
    await tx.receptionistAgent.update({
      where: { id: claim.deployment.agentId },
      data: {
        providerAgentId: providerAgent.value.agentId,
        currentDeploymentId: deployment.id,
        providerStatus: 'UNVERIFIED',
        providerVerifiedRevision: null,
        providerVerifiedAt: null,
        providerVerificationExpiresAt: null,
        providerLastAttemptAt: new Date(),
        providerLastAttemptStatus: 'SUCCEEDED',
        providerLastAttemptSource: 'DEPLOY',
        providerLastErrorCode: null,
        ...(current.providerAgentId !== providerAgent.value.agentId ? { providerConfigRevision: { increment: 1 } } : {}),
      },
    });
    await tx.auditEvent.create({ data: {
      tenantId: input.tenantId,
      actorUserId: input.actor.userId,
      action: 'receptionistAgent.deployed',
      resource: 'receptionistAgentDeployment',
      resourceId: deployment.id,
      requestId: input.actor.requestId,
      ipAddress: input.actor.ip,
      metadata: {
        agentId: deployment.agentId,
        campaignId: deployment.campaignId,
        promptHash: deployment.promptHash,
        toolFingerprint: deployment.toolFingerprint,
        providerAgentVersion: deployment.providerAgentVersion,
        numberBound: deployment.numberBound,
        mock: deployment.mock,
      },
    } });
    return { kind: 'ok' as const, deployment };
  }, input.actor.trustedActor);

  if (committed.kind === 'gone') return fail('concurrent_change', 'The agent was removed while the deployment was in flight.');
  if (committed.kind === 'conflict') {
    return fail('concurrent_change', 'The agent changed while the deployment was in flight. The published provider version was not adopted; deploy again.', committed.deployment);
  }
  return { ok: true, deployment: committed.deployment, verification: { status: 'pending' } };
}

/** Convenience for the seed/e2e path: deploy, then verify, in two requests' worth of work. */
export async function deployAndVerify(input: DeployInput): Promise<{ deploy: DeployOutcome; verification: VerifyOutcome | null }> {
  const deploy = await deployCampaignToRetell(input);
  if (!deploy.ok) return { deploy, verification: null };
  const verification = await verifyAgentProvider({
    tenantId: input.tenantId,
    agentId: deploy.deployment.agentId,
    actor: input.actor,
    skipCooldown: true,
  });
  return { deploy, verification };
}
