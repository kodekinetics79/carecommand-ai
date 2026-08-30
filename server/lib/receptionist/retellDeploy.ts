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

/**
 * Failure codes Package A adds on top of the catalogue's `DeployFailureCode`.
 * Declared here rather than in `remediation.ts`, which Package B owns this
 * cycle; each one carries its own operator sentence in `message`, and B is
 * asked to add matching CATALOGUE entries so the Fix link resolves too.
 */
export const PACKAGE_A_DEPLOY_FAILURE_CODES = [
  'inbound_number_unassigned',
  'inbound_number_conflict',
  'campaign_active_deploy_blocked',
] as const;

export type ReceptionistDeployFailureCode = DeployFailureCode | typeof PACKAGE_A_DEPLOY_FAILURE_CODES[number];

/** Statuses whose deployment is (or is about to be) answering a live number. */
const LIVE_DEPLOYMENT_STATUSES = ['PUBLISHED', 'VERIFIED'] as const;

// ===========================================================================
// Deploying a campaign to Retell.
//
// The shape of this file is dictated by two facts. Provider calls take
// seconds, and `runWithTenantContext` is a Prisma interactive transaction — so
// no provider call may happen inside one. And the API runs on a function with
// a 60 s ceiling, so the whole thing must fit a budget with room to answer.
//
// Hence: two short transactions with the provider work between them, exactly
// like the verify route already does. Transaction #1 takes the per-agent
// advisory lock, plans and claims; provider calls run with nothing open;
// transaction #2 re-reads the agent, refuses if it changed underneath us, and
// commits the deployment, the agent and the audit event together. A deploy
// answers PUBLISHED with verification pending, and the client calls verify —
// publishing and attesting are two requests because together they do not fit
// in one.
//
// Serialising two racing deploys therefore takes both halves (A6). The
// advisory lock in tx#1 stops two claims being planned against the same agent
// state; the lock cannot be held across the provider window, so tx#2 bumps
// `providerConfigRevision` on EVERY successful deploy and refuses to commit
// against a revision that moved. The loser publishes at the provider but does
// not adopt — which is the only outcome that keeps `currentDeploymentId` and
// the provider's binding describing the same version. The file used to claim a
// lock it never took, and the revision only moved when the agent id changed,
// so two racing deploys both committed.
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
  | { ok: false; code: ReceptionistDeployFailureCode; message: string; deployment: DeploymentRow | null; retryAfterSeconds?: number; placeholders?: Placeholder[] };

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

function fail(code: ReceptionistDeployFailureCode, message: string, deployment: DeploymentRow | null = null, extra: Partial<DeployOutcome & object> = {}): DeployOutcome {
  return { ok: false, code, message, deployment, ...extra } as DeployOutcome;
}

/**
 * The number THIS clinic answers on.
 *
 * Not `env.RETELL_FROM_NUMBER`. That single process-wide value is why the
 * second clinic's deploy repointed the first clinic's line while both
 * checklists stayed green; it degrades here to what it always actually was —
 * the outbound caller-id default used by `createPhoneCall`.
 *
 * A clinic with no assigned line falls back to its own published `phone`,
 * because that is the number patients are told to call, and because `phone`
 * already carries the same global active-unique index — so the fallback can
 * never collapse two clinics onto one line either. The claim is then written
 * back, so from the next deploy on it is an explicit, operator-visible fact
 * rather than a derivation.
 */
export function clinicInboundNumber(clinic: { inboundNumber: string | null; phone: string }): string | null {
  const assigned = clinic.inboundNumber?.trim();
  if (assigned) return assigned;
  const advertised = clinic.phone?.trim();
  return advertised || null;
}

/** Postgres advisory lock, transaction-scoped, keyed on the one agent being deployed. */
async function lockAgentDeploy(tx: TenantTxClient, tenantId: string, agentId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-deploy:${tenantId}:${agentId}`}::text, 0))::text AS locked`;
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
    const loaded = await loadCampaignGraph(tx, input.tenantId, input.campaignId);
    if (!loaded) return { kind: 'not_found' as const };
    if (!loaded.agent) return { kind: 'error' as const, code: 'agent_unlinked_and_not_creatable' as ReceptionistDeployFailureCode, message: 'Link an agent to this campaign before deploying.' };

    // A6 — everything decision-relevant below is read AFTER this lock, and the
    // agent is re-read through it, so two concurrent deploys of the same agent
    // cannot both plan against the same state.
    await lockAgentDeploy(tx, input.tenantId, loaded.agent.id);
    const agent = await tx.receptionistAgent.findFirst({ where: { id: loaded.agent.id, tenantId: input.tenantId } });
    if (!agent) return { kind: 'error' as const, code: 'agent_unlinked_and_not_creatable' as ReceptionistDeployFailureCode, message: 'Link an agent to this campaign before deploying.' };
    const campaign = { ...loaded, agent };
    if (!campaign.clinic.active) return { kind: 'error' as const, code: 'agent_inactive' as ReceptionistDeployFailureCode, message: 'The clinic is deactivated.' };
    if (!agent.active) return { kind: 'error' as const, code: 'agent_inactive' as ReceptionistDeployFailureCode, message: 'The agent is deactivated.' };

    const latest = await tx.receptionistAgentDeployment.findFirst({
      where: { tenantId: input.tenantId, agentId: agent.id },
      orderBy: { startedAt: 'desc' },
    });
    // A7 — ownership is a question about THIS provider agent id, not about
    // whether any deployment row happens to exist. Deploy once, then relink
    // `providerAgentId` to a hand-built agent (PATCH /agents/:id allows it),
    // and the old test — "a row exists, so we must own it" — would have let the
    // next deploy PATCH and republish somebody else's agent.
    const owned = agent.providerAgentId
      ? await tx.receptionistAgentDeployment.findFirst({
        where: { tenantId: input.tenantId, agentId: agent.id, providerAgentId: agent.providerAgentId },
        select: { id: true },
      })
      : null;
    if (agent.providerAgentId && !owned) {
      return { kind: 'error' as const, code: 'engine_not_owned' as ReceptionistDeployFailureCode, message: 'This agent points at a Retell agent CareCommand did not create. Unlink it before deploying, so a deployment does not overwrite an agent it does not own.' };
    }

    // A4 — a redeploy flips the agent to UNVERIFIED, and the runtime gate then
    // drops every caller to the five safe tools until verification lands. That
    // is a degrade window on a line that is answering patients right now, so it
    // is refused here exactly as `PATCH /agents/:id` already refuses the
    // analogous change. Pause the campaign, deploy, verify, activate.
    const [activeStudioCampaign, runnableOutboundCampaign] = await Promise.all([
      tx.receptionistCampaign.findFirst({ where: { tenantId: input.tenantId, agentId: agent.id, status: 'ACTIVE' }, select: { id: true, name: true } }),
      tx.receptionistOutboundCampaign.findFirst({ where: { tenantId: input.tenantId, agentId: agent.id, status: { in: ['SCHEDULED', 'RUNNING'] } }, select: { id: true } }),
    ]);
    if (activeStudioCampaign || runnableOutboundCampaign) {
      return {
        kind: 'error' as const,
        code: 'campaign_active_deploy_blocked' as ReceptionistDeployFailureCode,
        message: activeStudioCampaign
          ? `“${activeStudioCampaign.name}” is active and answering calls on this agent. Deploying would publish a new version and leave callers on the reduced safe tool set until it verifies. Pause the campaign, deploy, verify, then activate again.`
          : 'A scheduled or running outbound campaign uses this agent. Pause it, deploy, verify, then resume.',
      };
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
      return { kind: 'error' as const, code: 'placeholders_present' as ReceptionistDeployFailureCode, message: 'Replace the placeholder values before deploying.', placeholders: plan.placeholders };
    }

    // ---- A1: which line does THIS clinic answer on? ------------------------
    const inboundNumber = clinicInboundNumber(campaign.clinic);
    if (!inboundNumber) {
      return { kind: 'error' as const, code: 'inbound_number_unassigned' as ReceptionistDeployFailureCode, message: 'This clinic has no inbound number, so a deployment has nothing to bind. Set the clinic’s inbound line in Studio, then deploy.' };
    }
    // Another live deployment in this tenant already owns the line. Binding
    // anyway is exactly the theft this defect is about: the other clinic's
    // callers would reach this agent, this clinic's hours and this clinic's
    // branch, while both checklists still read green. (Across tenants the
    // clinic-level global unique index settles it before we get here.)
    const numberOwner = await tx.receptionistAgentDeployment.findFirst({
      where: {
        tenantId: input.tenantId,
        boundPhoneNumber: inboundNumber,
        numberBound: true,
        status: { in: [...LIVE_DEPLOYMENT_STATUSES] },
        clinicId: { not: campaign.clinicId },
      },
      select: { id: true, clinicId: true },
    });
    if (numberOwner) {
      return { kind: 'error' as const, code: 'inbound_number_conflict' as ReceptionistDeployFailureCode, message: 'Another clinic’s live deployment already answers on this number. Give this clinic its own inbound line, or retire the other clinic’s deployment first — one number cannot answer for two clinics.' };
    }
    // Persist the claim so the line is an explicit fact from here on and the
    // active-unique index — not whichever deploy ran last — owns it.
    if (campaign.clinic.inboundNumber !== inboundNumber) {
      await tx.receptionistClinic.update({ where: { id: campaign.clinicId }, data: { inboundNumber } });
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
    // A5 — the response engine to reuse is the newest row that actually CARRIES
    // one, not merely the newest row. A failed deploy is still the newest row,
    // and reading `priorLlmId` off it as null is what made every retry mint a
    // fresh orphan LLM: at the 20/hour limit, twenty unreachable engines per
    // tenant per hour, and a response-engine id that churned on every deploy.
    const priorEngine = await tx.receptionistAgentDeployment.findFirst({
      where: { tenantId: input.tenantId, agentId: agent.id, providerLlmId: { not: null }, id: { not: deployment.id } },
      orderBy: { startedAt: 'desc' },
      select: { providerLlmId: true, providerLlmVersion: true, providerAgentVersion: true },
    });
    return {
      kind: 'claimed' as const,
      deployment,
      plan,
      inboundNumber,
      agentName: agent.name,
      providerConfigRevision: agent.providerConfigRevision,
      providerAgentId: agent.providerAgentId,
      priorLlmId: priorEngine?.providerLlmId ?? null,
      priorLlmVersion: priorEngine?.providerLlmVersion ?? 0,
      priorAgentVersion: latest?.providerAgentVersion ?? priorEngine?.providerAgentVersion ?? 0,
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
  // A5 — whatever the provider has already given us is recorded even when the
  // deploy goes on to fail, because it exists at Retell whether or not we
  // remember it. `failDeployment` writes it too: forgetting the engine id was
  // how a flapping provider leaked one orphan LLM per attempt.
  const created: { llmId: string | null; llmVersion: number | null; agentId: string | null; agentVersion: number | null } = {
    llmId: null, llmVersion: null, agentId: null, agentVersion: null,
  };
  const providerEvidence = () => ({
    ...(created.llmId ? { providerLlmId: created.llmId, providerLlmVersion: created.llmVersion } : {}),
    ...(created.agentId ? { providerAgentId: created.agentId } : {}),
  });
  const failDeployment = async (code: ReceptionistDeployFailureCode, providerErrorCode: string, message: string): Promise<DeployOutcome> => {
    const row = await runWithTenantContext(input.tenantId, async tx => {
      const updated = await tx.receptionistAgentDeployment.update({
        where: { id: claim.deployment.id },
        data: { status: 'FAILED', providerErrorCode, steps: steps as unknown as Prisma.InputJsonValue, ...providerEvidence() },
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
        metadata: { agentId: claim.deployment.agentId, campaignId: claim.deployment.campaignId, code, providerErrorCode, mock: claim.plan.mock, providerLlmRetained: Boolean(created.llmId), providerAgentRetained: Boolean(created.agentId) },
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
  created.llmId = llm.value.llmId;
  created.llmVersion = llm.value.version;
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
  created.agentId = providerAgent.value.agentId;
  created.agentVersion = providerAgent.value.version;
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

  // Step 4 — point THIS CLINIC'S inbound number at the published version, so a
  // patient calling this clinic reaches this deployment and not whatever
  // answered before — and so that no other clinic's line is touched. The
  // number is `campaign.clinic.inboundNumber`, claimed and uniqueness-checked
  // in transaction #1; `env.RETELL_FROM_NUMBER` is the outbound caller-id
  // default and has no business deciding who answers an inbound call.
  let numberBound = false;
  const targetNumber = claim.inboundNumber;
  let bindError: string | null = null;
  if (!outOfBudget()) {
    const bound = await updatePhoneNumberInboundAgent(targetNumber, {
      agentId: providerAgent.value.agentId,
      agentVersion: published.value.version,
      inboundWebhookUrl: expectedRetellAgentWebhookUrl(),
    });
    if (bound.ok) {
      numberBound = true;
      stamp('bind_number', 'ok');
    } else {
      // The agent IS published; only the inbound binding failed. Readiness
      // reports `number_bound` as not passing rather than the deploy
      // pretending, and the number we tried is still recorded so an operator
      // can see which line Retell refused.
      bindError = bound.error;
      stamp('bind_number', 'failed', { providerErrorCode: bound.error });
    }
  } else {
    bindError = 'deploy_budget_exhausted';
    stamp('bind_number', 'skipped', { detail: 'deploy budget exhausted' });
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
        // What we ASKED for. `numberBinding*` — what the provider ANSWERS when
        // asked again — stays null until verification reads it back, so a
        // fresh deployment is `pending`, never `pass`.
        numberBound,
        boundPhoneNumber: targetNumber,
        numberBindingReadAt: null,
        numberBindingAgentId: null,
        numberBindingAgentVersion: null,
        numberBindingVerifiedAt: null,
        numberBindingErrorCode: bindError,
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
        // A6 — every successful deploy moves the revision, not only one that
        // repointed the agent id. The revision is what a racing deploy's own
        // transaction #2 compares against, so a revision that stood still let
        // two deploys both commit; and verification re-attests per revision, so
        // moving it is also what forces this exact version to be attested.
        providerConfigRevision: { increment: 1 },
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
        boundPhoneNumber: deployment.boundPhoneNumber,
        clinicId: deployment.clinicId,
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
