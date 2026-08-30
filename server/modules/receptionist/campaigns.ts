import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { generateSystemPrompt, generateSamples, buildRetellConfig, promptHash } from './promptService';
import { hoursHash } from '../../lib/receptionist/clinicHours';
import { loadHoursSource } from '../../lib/receptionist/hoursSource';
import { knowledgeHash, parseKnowledgeDocument } from '../../lib/receptionist/knowledge';
import { assemblePromptConfig, type PromptConfigResult } from '../../lib/receptionist/promptAssembly';
import { clinicActivationState, isClinicActivationBlocker } from '../../lib/receptionist/activationReadiness';
import { runWithTenantContext } from '../../lib/tenantContext';
import { agentReadinessReason } from '../../lib/receptionist/agentReadiness';
import { Prisma } from '../../generated/prisma/client';
import { bookAppointmentToolFingerprint, fingerprintJson } from './intakeContract';
import { uuid, idParam, writeRoles, receptionistRead, callArtifactRead, intakeConfigurationError, compileCampaignIntakeContract, isReceptionistDestinationConflict, lockReceptionistConfiguration, auditReceptionistMutation, FIELD_TYPES } from './shared';
import { evaluateCampaignReadiness, failingChecks, type ReadinessResponse } from '../../lib/receptionist/campaignReadiness';
import { confirmationChannelStatus } from '../../lib/receptionist/confirmationOutbox';
import { remediationFor } from '../../lib/receptionist/remediation';
import { generateSampleTranscripts, mandatoryOpeningDisclosure } from './promptService';
import { findPlaceholders } from '../../lib/receptionist/placeholders';

// The legacy 409 body is load-bearing: existing clients and suites read
// `message` as `Campaign configuration is not deployable: <code>.`. Readiness
// adds `reasons` alongside it rather than replacing it.
export class CampaignTransitionError extends Error {
  constructor(readonly code: string, readonly reasons: unknown[] = []) {
    super(`Campaign configuration is not deployable: ${code}.`);
  }
}

type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

// Self-transitions are deliberately absent: pausing an already-paused campaign
// is a mistake worth reporting, not a silent success. PATCH only calls this
// when the status actually changes, so an unchanged status is still a no-op.
const ALLOWED_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  PAUSED: ['ACTIVE', 'ARCHIVED', 'DRAFT'],
  ACTIVE: ['PAUSED'],
  ARCHIVED: [],
};

/**
 * The one state machine for a campaign's status, and the one activation gate.
 * PATCH /campaigns/:id delegates here, so a status set through the generic
 * update cannot bypass readiness — there is no second door.
 */
export async function transitionCampaign(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; campaignId: string; to: CampaignStatus; now?: Date },
): Promise<{ campaign: Prisma.ReceptionistCampaignGetPayload<Record<string, never>>; readiness: ReadinessResponse | null }> {
  const existing = await tx.receptionistCampaign.findFirst({ where: { id: input.campaignId, tenantId: input.tenantId } });
  if (!existing) throw new Error('campaign_not_found');
  const from = existing.status as CampaignStatus;
  if (!ALLOWED_TRANSITIONS[from].includes(input.to)) {
    if (input.to === 'PAUSED') throw new CampaignTransitionError('campaign_not_active');
    if (input.to === 'ARCHIVED' && from === 'ACTIVE') throw new CampaignTransitionError('campaign_active_pause_first');
    throw new CampaignTransitionError('campaign_transition_not_allowed');
  }

  if (input.to === 'ARCHIVED') {
    const outbound = await tx.receptionistOutboundCampaign.findMany({
      where: { tenantId: input.tenantId, receptionistCampaignId: input.campaignId, status: { in: ['SCHEDULED', 'RUNNING'] } },
      select: { id: true, name: true },
    });
    if (outbound.length) throw new CampaignTransitionError('campaign_referenced_by_outbound', outbound);
  }

  let readiness: ReadinessResponse | null = null;
  let data: Prisma.ReceptionistCampaignUpdateInput = { status: input.to };
  if (input.to === 'ACTIVE') {
    readiness = await evaluateCampaignReadiness(tx, { tenantId: input.tenantId, campaignId: input.campaignId, now: input.now });
    if (!readiness) throw new Error('campaign_not_found');
    // `intake_attested` is deliberately excluded from the gate decision here.
    // The attestation below IS that check, and it distinguishes unattested
    // from mismatched from not-strict; readiness can only say "not attested".
    // Checking the same thing twice, less precisely, would replace a specific
    // error the operator can act on with a vague one.
    const blocking = failingChecks(readiness).filter(item => item.key !== 'intake_attested');
    if (blocking.length) throw new CampaignTransitionError('campaign_not_ready', blocking);
    // Readiness passing does not replace the attestation write: activation
    // still binds this campaign to the exact provider deployment evidence.
    const campaign = await tx.receptionistCampaign.findFirstOrThrow({ where: { id: input.campaignId, tenantId: input.tenantId }, include: { agent: true } });
    // C2's clinic-side gate: hours/knowledge/transfer target must be usable and
    // a locale pack must exist for the agent's language. Activation records the
    // pack it was attested against, so a later pack edit is detectable.
    const localePack = await assertClinicActivationReadiness(tx, { tenantId: input.tenantId, clinicId: campaign.clinicId, agent: campaign.agent });
    const attestation = await attestCampaignIntakeContract(tx, campaign, campaign.agent);
    data = {
      ...attestation,
      status: 'ACTIVE',
      attestedLocalePackId: localePack?.id ?? null,
      attestedLocalePackHash: localePack?.evidenceHash ?? null,
    };
  }
  const campaign = await tx.receptionistCampaign.update({ where: { id: input.campaignId }, data });
  return { campaign, readiness };
}

async function assertCampaignAgent(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; clinicId: string; agentId: string | null | undefined; requireReady: boolean },
) {
  if (!input.agentId) {
    if (input.requireReady) throw new Error('agent_unlinked');
    return null;
  }
  const agent = await tx.receptionistAgent.findFirst({
    where: { id: input.agentId, tenantId: input.tenantId, clinicId: input.clinicId },
  });
  if (!agent) throw new Error('agent_scope_mismatch');
  if (!agent.active) throw new Error('agent_inactive');
  if (input.requireReady) {
    const reason = agentReadinessReason(agent);
    if (reason) throw new Error(reason);
  }
  return agent;
}

async function assertCampaignLocations(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; clinicId: string; locationIds: string[] },
) {
  const uniqueIds = [...new Set(input.locationIds)];
  if (uniqueIds.length !== input.locationIds.length) throw new Error('location_scope_mismatch');
  if (!uniqueIds.length) return;
  const count = await tx.receptionistLocation.count({
    where: { id: { in: uniqueIds }, tenantId: input.tenantId, clinicId: input.clinicId, active: true, branchId: { not: null } },
  });
  if (count !== uniqueIds.length) throw new Error('location_scope_mismatch');
}

function campaignAssignmentError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('active_intake_contract_immutable')) return 'active_intake_contract_immutable';
  // Clinic-level activation blockers (C2). C5's evaluateCampaignReadiness will
  // replace this call site with readiness rows; until then a blocked clinic
  // must not be able to reach a live provider deployment.
  if (isClinicActivationBlocker(code)) return code;
  return ['agent_unlinked', 'agent_scope_mismatch', 'agent_inactive', 'agent_unverified', 'agent_configuration_changed', 'agent_verification_stale', 'location_scope_mismatch', 'intake_schema_unattested', 'intake_schema_mismatch', 'intake_schema_not_strict', 'active_intake_contract_immutable', 'active_provider_deployment_conflict'].includes(code)
    ? code
    : null;
}

/**
 * Clinic configuration that must hold before a campaign may go ACTIVE, and the
 * locale pack the activation binds itself to.
 */
async function assertClinicActivationReadiness(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; clinicId: string; agent: { language: string } | null },
) {
  const state = await clinicActivationState(tx, input);
  if (state.blockers.length) throw new Error(state.blockers[0]);
  return state.localePack;
}

async function attestCampaignIntakeContract(
  tx: Prisma.TransactionClient,
  campaign: { id: string; tenantId: string; clinicId: string; appointmentType: string; eligibleLocationIds: string[]; intakeSchemaRevision: number },
  agent: {
    providerBookToolSchema: unknown;
    providerBookToolFingerprint: string | null;
    providerResponseEngineGraphFingerprint: string | null;
    providerEffectiveDynamicVariables: unknown;
    providerToolCallStrictMode: boolean | null;
    providerAgentId: string | null;
    providerVersion: number | null;
    providerResponseEngineId: string | null;
    providerResponseEngineVersion: number | null;
  } | null,
) {
  if (!agent?.providerBookToolSchema || !agent.providerBookToolFingerprint || !agent.providerResponseEngineGraphFingerprint
    || !agent.providerEffectiveDynamicVariables || typeof agent.providerEffectiveDynamicVariables !== 'object' || Array.isArray(agent.providerEffectiveDynamicVariables)
    || agent.providerVersion === null || !agent.providerAgentId || !agent.providerResponseEngineId || agent.providerResponseEngineVersion === null) {
    throw new Error('intake_schema_unattested');
  }
  if (agent.providerToolCallStrictMode !== true) throw new Error('intake_schema_not_strict');
  const contract = await compileCampaignIntakeContract(tx, campaign);
  if (bookAppointmentToolFingerprint(agent.providerBookToolSchema) !== contract.snapshot.bookAppointmentToolFingerprint) {
    throw new Error('intake_schema_mismatch');
  }
  const deploymentConflict = await tx.receptionistCampaign.findFirst({
    where: {
      tenantId: campaign.tenantId,
      id: { not: campaign.id },
      status: 'ACTIVE',
      intakeSchemaProviderAgentId: agent.providerAgentId,
      intakeSchemaProviderVersion: agent.providerVersion,
    },
    select: { id: true },
  });
  if (deploymentConflict) throw new Error('active_provider_deployment_conflict');
  const attestedSnapshot = {
    ...contract.snapshot,
    providerEffectiveDynamicVariables: agent.providerEffectiveDynamicVariables,
  };
  return {
    intakeSchemaSnapshot: attestedSnapshot as unknown as Prisma.InputJsonValue,
    intakeSchemaFingerprint: fingerprintJson(attestedSnapshot),
    intakeToolFingerprint: agent.providerBookToolFingerprint,
    intakeSchemaAttestedRevision: campaign.intakeSchemaRevision,
    intakeSchemaAttestedAt: new Date(),
    intakeSchemaProviderAgentId: agent.providerAgentId,
    intakeSchemaProviderVersion: agent.providerVersion,
    intakeSchemaResponseEngineId: agent.providerResponseEngineId,
    intakeSchemaResponseEngineVersion: agent.providerResponseEngineVersion,
  };
}

const bookingRulesSchema = z
  .object({
    leadTimeHours: z.number().int().min(0).max(720).optional(),
    slotDurationMinutes: z.number().int().min(5).max(240).optional(),
    maxPerDay: z.number().int().min(0).max(200).optional(),
    availableDays: z.array(z.string()).optional(),
    hoursStart: z.string().optional(),
    hoursEnd: z.string().optional(),
    notes: z.string().max(500).optional(),
  })
  .partial();

// --- assembly helper -------------------------------------------------------
type CampaignWithRelations = {
  id: string;
  name: string;
  campaignType: string;
  offerTitle: string;
  offerDescription: string;
  offerScript: string;
  appointmentType: string;
  bookingRules: unknown;
  eligibleLocationIds: string[];
  smsConfirmation: boolean;
  emailConfirmation: boolean;
  intakeSchemaRevision: number;
  clinicId: string;
  agentId: string | null;
  clinic: {
    id: string; name: string; phone: string; website: string | null; addressLine: string | null;
    country: string | null; timezone: string; defaultLanguage: string; complianceDisclosure: string | null;
    humanFallbackNumber: string | null; doNotContactPolicy: string | null; workingHours: unknown;
    locations: Array<{ id: string; name: string; address: string; phone: string | null; accessNotes: string | null }>;
  };
  agent: {
    name: string; voice: string; tone: string; language: string;
    persona: string | null; greetingOverride: string | null;
  } | null;
  intakeFields: Array<{
    fieldType: typeof FIELD_TYPES[number];
    label: string; aiQuestion: string; validationRule: string | null;
    options: string[]; required: boolean; confirmationRequired: boolean; sortOrder: number;
  }>;
};

export type { PromptConfigResult } from '../../lib/receptionist/promptAssembly';

/**
 * The export routes' entry point into the one shared prompt assembly
 * (`lib/receptionist/promptAssembly.ts`), which deployment and readiness also
 * use — so preview, deploy and readiness can never render different prompts.
 */
export async function promptConfigForCampaign(campaign: CampaignWithRelations, tenantId: string): Promise<PromptConfigResult> {
  return assemblePromptConfig(db, campaign, tenantId);
}

/** Hours + knowledge evidence for the export routes and C5's deployment attestation. */
async function configurationHashes(tenantId: string, clinicId: string) {
  const [bundle, knowledgeRow] = await Promise.all([
    loadHoursSource(db, { tenantId, clinicId }),
    db.receptionistClinicKnowledge.findFirst({ where: { tenantId, clinicId }, select: { approved: true, approvedHash: true } }),
  ]);
  const approved = knowledgeRow?.approved ? parseKnowledgeDocument(knowledgeRow.approved) : null;
  return {
    hoursHash: bundle ? hoursHash(bundle.source) : null,
    knowledgeHash: knowledgeRow?.approvedHash ?? (approved ? knowledgeHash(approved) : null),
  };
}

const campaignInclude = {
  clinic: { include: { locations: { orderBy: { createdAt: 'asc' } } } },
  agent: true,
  intakeFields: { orderBy: { sortOrder: 'asc' } },
} as const;

async function loadCampaign(tenantId: string, campaignId: string) {
  return db.receptionistCampaign.findFirst({
    where: { id: campaignId, tenantId },
    include: campaignInclude,
  });
}


/**
 * One error mapping for every campaign mutation.
 *
 * The legacy 409 message is preserved verbatim — clients and suites read
 * `Campaign configuration is not deployable: <code>.` — and `code`, `reasons`
 * and the remediation copy are added beside it, so a screen can render the fix
 * list rather than a bare identifier. The body is sent directly because the
 * shared error handler keeps only error/message/requestId.
 */
function campaignConflictBody(error: unknown): { status: 400 | 409; body: Record<string, unknown> } | null {
  const invalid = intakeConfigurationError(error);
  if (invalid) return { status: 400, body: { error: 'invalid_intake_configuration', message: invalid } };
  const code = error instanceof CampaignTransitionError ? error.code : campaignAssignmentError(error);
  if (code) {
    const message = error instanceof CampaignTransitionError
      ? error.message
      : `Campaign configuration is not deployable: ${code}.`;
    const remediation = remediationFor(code);
    return {
      status: 409,
      body: {
        error: 'conflict',
        code,
        message,
        reasons: error instanceof CampaignTransitionError ? error.reasons : [],
        title: remediation.title,
        action: remediation.action,
        fixHref: remediation.fixHref,
      },
    };
  }
  if (isReceptionistDestinationConflict(error)) {
    return {
      status: 409,
      body: {
        error: 'conflict',
        code: 'active_provider_deployment_conflict',
        message: 'This provider deployment already owns an active Studio campaign for the tenant.',
        reasons: [],
      },
    };
  }
  return null;
}

export const campaignRoutes: FastifyPluginAsync = async app => {
  // ===== Campaigns ========================================================
  const campaignCreate = z.object({
    clinicId: uuid,
    agentId: uuid.optional().nullable(),
    name: z.string().trim().min(2).max(160),
    campaignType: z.string().trim().max(80).optional(),
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
    offerTitle: z.string().trim().min(2).max(200),
    offerDescription: z.string().trim().min(2).max(1000),
    offerScript: z.string().trim().min(2).max(2000),
    appointmentType: z.string().trim().min(2).max(120),
    bookingRules: bookingRulesSchema.optional().nullable(),
    eligibleLocationIds: z.array(uuid).optional(),
    smsConfirmation: z.boolean().optional(),
    emailConfirmation: z.boolean().optional(),
  });
  const campaignUpdate = campaignCreate.partial().omit({ clinicId: true });

  app.get('/campaigns', { preHandler: receptionistRead }, async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    return db.receptionistCampaign.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
      include: {
        agent: { select: { id: true, name: true, voice: true } },
        clinic: { select: { id: true, name: true } },
        intakeFields: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { callLogs: true } },
      },
    });
  });

  app.get('/campaigns/:id', { preHandler: receptionistRead }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await loadCampaign(request.auth.tenantId, id);
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    return campaign;
  });

  app.post('/campaigns', { preHandler: writeRoles }, async (request, reply) => {
    const input = campaignCreate.parse(request.body);
    try {
      const row = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const clinic = await tx.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId, active: true }, select: { id: true } });
        if (!clinic) throw app.httpErrors.badRequest('An active tenant-owned clinic is required.');
        const agent = await assertCampaignAgent(tx, {
          tenantId: request.auth.tenantId, clinicId: input.clinicId, agentId: input.agentId,
          requireReady: input.status === 'ACTIVE',
        });
        await assertCampaignLocations(tx, { tenantId: request.auth.tenantId, clinicId: input.clinicId, locationIds: input.eligibleLocationIds ?? [] });
        const { bookingRules, eligibleLocationIds, status, ...rest } = input;
        let created = await tx.receptionistCampaign.create({
          data: {
            tenantId: request.auth.tenantId,
            ...rest,
            status: status === 'ACTIVE' ? 'DRAFT' : status,
            eligibleLocationIds: eligibleLocationIds ?? [],
            bookingRules: bookingRules ?? undefined,
          },
        });
        if (status === 'ACTIVE') {
          const localePack = await assertClinicActivationReadiness(tx, { tenantId: request.auth.tenantId, clinicId: input.clinicId, agent });
          const attestation = await attestCampaignIntakeContract(tx, created, agent);
          created = await tx.receptionistCampaign.update({
            where: { id: created.id },
            data: {
              ...attestation,
              status: 'ACTIVE',
              attestedLocalePackId: localePack?.id ?? null,
              attestedLocalePackHash: localePack?.evidenceHash ?? null,
            },
          });
        }
        await auditReceptionistMutation(tx, request, {
          action: 'receptionistCampaign.created', resource: 'receptionistCampaign', resourceId: created.id,
          metadata: { clinicId: created.clinicId, agentId: created.agentId, status: created.status },
        });
        return created;
      });
      return reply.code(201).send(row);
    } catch (error) {
      const mapped = campaignConflictBody(error);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw error;
    }
  });

  app.patch('/campaigns/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = campaignUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const existing = await tx.receptionistCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!existing) throw app.httpErrors.notFound('Campaign not found');
        const nextAgentId = input.agentId === undefined ? existing.agentId : input.agentId;
        const nextStatus = input.status ?? existing.status;
        const nextLocations = input.eligibleLocationIds ?? existing.eligibleLocationIds;
        const schemaRelevantChange = (input.agentId !== undefined && input.agentId !== existing.agentId)
          || (input.appointmentType !== undefined && input.appointmentType !== existing.appointmentType)
          || (input.eligibleLocationIds !== undefined && JSON.stringify(input.eligibleLocationIds) !== JSON.stringify(existing.eligibleLocationIds));
        if (existing.status === 'ACTIVE' && nextStatus === 'ACTIVE' && schemaRelevantChange) throw new Error('active_intake_contract_immutable');
        await assertCampaignAgent(tx, {
          tenantId: request.auth.tenantId, clinicId: existing.clinicId, agentId: nextAgentId,
          requireReady: nextStatus === 'ACTIVE',
        });
        await assertCampaignLocations(tx, { tenantId: request.auth.tenantId, clinicId: existing.clinicId, locationIds: nextLocations });
        // A confirmation the platform cannot deliver must not be switchable
        // on: the agent would promise a text that nothing sends.
        for (const [enabled, channel] of [[input.smsConfirmation, 'sms'] as const, [input.emailConfirmation, 'email'] as const]) {
          if (!enabled) continue;
          const channelStatus = confirmationChannelStatus(channel);
          if (channelStatus.status === 'unconfigured' || channelStatus.status === 'configured_pending') {
            throw new CampaignTransitionError('confirmation_channel_unconfigured', [channelStatus]);
          }
        }
        const { bookingRules, status, ...rest } = input;
        let row = await tx.receptionistCampaign.update({
          where: { id },
          data: {
            ...rest,
            ...(status !== undefined && status !== 'ACTIVE' && status !== existing.status ? {} : {}),
            ...(bookingRules !== undefined ? { bookingRules: bookingRules ?? undefined } : {}),
          },
        });
        // Every status change goes through the one state machine, so a status
        // set here is gated exactly as POST /activate is — including C2's
        // clinic activation readiness and locale-pack attestation, which
        // `transitionCampaign` now performs on the ACTIVE transition.
        if (status !== undefined && status !== existing.status) {
          row = (await transitionCampaign(tx, { tenantId: request.auth.tenantId, campaignId: id, to: status })).campaign;
        }
        await auditReceptionistMutation(tx, request, {
          action: 'receptionistCampaign.updated', resource: 'receptionistCampaign', resourceId: id,
          metadata: { agentId: row.agentId, status: row.status },
        });
        return row;
      });
    } catch (error) {
      const mapped = campaignConflictBody(error);
      if (mapped) return reply.code(mapped.status).send(mapped.body);
      throw error;
    }
  });

  app.delete('/campaigns/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.receptionistCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Campaign not found');
    await db.receptionistCampaign.delete({ where: { id } });
    await audit(request, { action: 'receptionistCampaign.deleted', resource: 'receptionistCampaign', resourceId: id });
    return reply.code(204).send();
  });
};

const CONFIGURATION_ERROR_PREFIXES = [
  'invalid_receptionist_configuration',
  'invalid_intake_configuration',
] as const;

/**
 * A prompt that cannot be generated because the campaign's own configuration
 * is inconsistent (an eligible location no longer maps to a branch, for
 * example) is a state conflict the operator can fix, not a server fault.
 * Surface it as 409 with the reason instead of a masked 500 (M71).
 */
function isConfigurationError(error: unknown): error is Error {
  return error instanceof Error && CONFIGURATION_ERROR_PREFIXES.some(prefix => error.message.startsWith(prefix));
}

function configurationConflict(app: Parameters<FastifyPluginAsync>[0], error: Error) {
  const prefix = CONFIGURATION_ERROR_PREFIXES.find(candidate => error.message.startsWith(candidate))
    ?? CONFIGURATION_ERROR_PREFIXES[0];
  const reason = error.message.slice(prefix.length + 1) || 'unknown';
  const remedy = prefix === 'invalid_intake_configuration'
    ? 'Fix the campaign intake fields before generating the prompt.'
    : 'Fix the campaign locations and agent before generating the prompt.';
  const conflict = app.httpErrors.conflict(`Receptionist configuration is invalid: ${reason.replaceAll('_', ' ')} ${remedy}`);
  (conflict as Error & { code?: string }).code = prefix;
  return conflict;
}

export const campaignLifecycleRoutes: FastifyPluginAsync = async app => {
  // The one readiness evaluation. Studio badges, the go-live card and the
  // activation gate all read this, so a screen can never disagree with what
  // activation will actually do.
  app.get('/campaigns/:id/readiness', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const readiness = await runWithTenantContext(request.auth.tenantId, tx =>
      evaluateCampaignReadiness(tx, { tenantId: request.auth.tenantId, campaignId: id }));
    if (!readiness) throw app.httpErrors.notFound('Campaign not found');
    return readiness;
  });

  for (const [path, target] of [['activate', 'ACTIVE'], ['pause', 'PAUSED'], ['archive', 'ARCHIVED']] as const) {
    app.post(`/campaigns/:id/${path}`, { preHandler: writeRoles }, async (request, reply) => {
      const { id } = idParam.parse(request.params);
      try {
        const result = await runWithTenantContext(request.auth.tenantId, async tx => {
          await lockReceptionistConfiguration(tx, request.auth.tenantId);
          const transition = await transitionCampaign(tx, { tenantId: request.auth.tenantId, campaignId: id, to: target });
          await auditReceptionistMutation(tx, request, {
            action: `receptionistCampaign.${path}d`, resource: 'receptionistCampaign', resourceId: id,
            metadata: { status: transition.campaign.status, agentId: transition.campaign.agentId },
          });
          return transition.campaign;
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (error instanceof Error && error.message === 'campaign_not_found') throw app.httpErrors.notFound('Campaign not found');
        const mapped = campaignConflictBody(error);
        if (mapped) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }
    });
  }

  // What this campaign would actually say, built from the same prompt facts
  // that get deployed — so the preview cannot drift from the live call.
  app.get('/campaigns/:id/preview', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await loadCampaign(request.auth.tenantId, id);
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    // C2's assembly: hours, approved knowledge, catalog services and the locale
    // pack. Preview reads exactly what deployment reads, so it cannot drift.
    let prepared;
    try {
      prepared = await promptConfigForCampaign(campaign as unknown as CampaignWithRelations, request.auth.tenantId);
    } catch (error) {
      // A configuration gap is a 409 the operator can act on, never a 500 (M71).
      if (isConfigurationError(error)) throw configurationConflict(app, error);
      throw error;
    }
    if (!prepared.ok) {
      throw app.httpErrors.conflict('No approved locale pack is available for this clinic language and country. Approve one before previewing the campaign.');
    }
    const config = prepared.config;
    const built = buildRetellConfig(config, { webhookBaseUrl: env.PUBLIC_API_URL });
    const transcripts = generateSampleTranscripts(config);
    const clinicDisclosure = (config.clinic.complianceDisclosure ?? '').trim();
    return {
      ...transcripts,
      tools: built.tools.map(tool => ({
        name: String(tool.name ?? ''),
        kind: tool.type === 'transfer_call' ? 'transfer' as const : 'custom' as const,
        description: String(tool.description ?? ''),
        // The consent tool is what every other patient-data tool waits on.
        requiresConsent: !['record_recording_preference', 'report_emergency'].includes(String(tool.name ?? '')),
      })),
      disclosure: {
        baseline: mandatoryOpeningDisclosure({ ...config, clinic: { ...config.clinic, complianceDisclosure: '' } }),
        additional: clinicDisclosure,
        composed: built.beginMessage,
      },
      placeholders: findPlaceholders(config),
      agent: {
        name: config.agent.name,
        voice: config.agent.voice,
        language: config.agent.language,
        // True when no agent row exists: Preview falls back to a stock identity
        // so the screen renders, and says so rather than implying it is real.
        placeholder: campaign.agentId === null,
      },
      systemPrompt: built.systemPrompt,
    };
  });
};

export const campaignExportRoutes: FastifyPluginAsync = async app => {
  // ===== Prompt generation + RetellAI export ==============================
  app.get('/campaigns/:id/prompt', { preHandler: receptionistRead }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await loadCampaign(request.auth.tenantId, id);
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    try {
      const prepared = await promptConfigForCampaign(campaign as unknown as CampaignWithRelations, request.auth.tenantId);
      if (!prepared.ok) {
        throw app.httpErrors.conflict('No approved locale pack is available for this clinic language and country. Approve one before previewing the prompt.');
      }
      const systemPrompt = generateSystemPrompt(prepared.config);
      const hashes = await configurationHashes(request.auth.tenantId, campaign.clinicId);
      return {
        systemPrompt,
        samples: generateSamples(prepared.config),
        promptHash: promptHash(systemPrompt),
        localePack: { id: prepared.localePackId, evidenceHash: prepared.evidenceHash },
        ...hashes,
        drift: campaign.status === 'ACTIVE'
          ? { localePack: campaign.attestedLocalePackHash !== null && campaign.attestedLocalePackHash !== prepared.evidenceHash }
          : { localePack: false },
      };
    } catch (error) {
      // A configuration gap is a 409 the operator can act on, never a 500 (M71).
      if (isConfigurationError(error)) throw configurationConflict(app, error);
      throw error;
    }
  });

  app.get('/campaigns/:id/retell-config', { preHandler: receptionistRead }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await loadCampaign(request.auth.tenantId, id);
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    try {
      const prepared = await promptConfigForCampaign(campaign as unknown as CampaignWithRelations, request.auth.tenantId);
      if (!prepared.ok) {
        throw app.httpErrors.conflict('No approved locale pack is available for this clinic language and country. Approve one before exporting the agent configuration.');
      }
      const built = buildRetellConfig(prepared.config, { webhookBaseUrl: env.PUBLIC_API_URL });
      const hashes = await configurationHashes(request.auth.tenantId, campaign.clinicId);
      return {
        ...built,
        promptHash: promptHash(built.systemPrompt),
        localePack: { id: prepared.localePackId, evidenceHash: prepared.evidenceHash },
        ...hashes,
      };
    } catch (error) {
      if (isConfigurationError(error)) throw configurationConflict(app, error);
      throw error;
    }
  });
};
