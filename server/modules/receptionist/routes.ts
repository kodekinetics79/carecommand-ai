import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { requireFeature } from '../../lib/entitlements';
import {
  hasReceptionistPermission,
  RECEPTIONIST_PERMISSIONS,
  requireReceptionistPermission,
} from '../../lib/receptionist/accessControl';
import {
  generateSystemPrompt,
  generateSamples,
  buildRetellConfig,
  type PromptConfig,
  type PromptIntakeField,
  type PromptBookingRules,
} from './promptService';
import { outboundRoutes, targetStatusAfterOutcome } from './outbound';
import { handleAgentTool, requestHumanHandoff, type TrustedBookingContext } from '../../lib/receptionist/liveTools';
import { ingestCallArtifacts } from '../../lib/receptionist/privacyLifecycle';
import { enterTenantContext, runWithTenantContext } from '../../lib/tenantContext';
import { resolveIngressTenant } from '../../lib/tenantIngressResolvers';
import { isFeatureEnabled } from '../../lib/entitlements';
import { platformDb } from '../../lib/platformDb';
import { MAX_TENANT_ACTIVE_CALLS, DEFAULT_VOICE_MINUTES_LIMIT } from './outbound';
import {
  evaluateRetellAgentReadiness,
  isValidRetellVersionTag,
  probeRetellAgent,
  RETELL_AGENT_VERIFICATION_TTL_MS,
  stopPhoneCall,
  type RetellAgentSnapshot,
} from '../../lib/retell';
import { agentReadinessReason } from '../../lib/receptionist/agentReadiness';
import { validateIanaTimezone } from '../../lib/scheduling';
import { Prisma } from '../../generated/prisma/client';
import { requireRoles } from '../../plugins/roles';
import { lockDncDestinationFence } from '../../lib/receptionist/dncFence';
import {
  enforceInvalidRetellSignatureRateLimit,
  enforceVerifiedRetellRateLimit,
} from '../../lib/receptionist/providerRateLimit';
import { recoverOutboundProviderIntent } from '../../lib/receptionist/providerIntentRecovery';
import { retellRateStore } from '../../lib/receptionist/retellRateStore';
import {
  bookAppointmentToolFingerprint,
  compileIntakeContract,
  fingerprintJson,
  validateIntakeFieldConfiguration,
  type IntakeContractSnapshot,
  type IntakeFieldConfiguration,
} from './intakeContract';

const uuid = z.string().uuid();
const RECEPTIONIST_CALL_LEASE_MS = 4 * 60 * 60 * 1_000;
const idParam = z.object({ id: uuid });
const writeRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.MANAGE);
const bookingReviewRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.BOOKING_REVIEW);
const callArtifactRead = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.CALL_ARTIFACTS_READ);
const ownerAdminRoles = requireRoles('OWNER', 'ADMIN');
const e164Phone = z.string().trim().max(40)
  .transform(value => value.replace(/[().\s-]/g, ''))
  .refine(value => /^\+[1-9]\d{7,14}$/.test(value), 'Phone must include country code in E.164 format');
const optionalE164Phone = e164Phone.optional().nullable();
const timezoneInput = z.string().trim().min(2).max(80).refine(value => {
  try { validateIanaTimezone(value); return true; } catch { return false; }
}, 'Timezone must be a valid IANA timezone identifier');
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Time must use 24-hour HH:mm format');
const hoursWindow = z.object({ open: z.boolean(), start: clockTime.optional(), end: clockTime.optional() }).strict()
  .superRefine((value, ctx) => {
    if (!value.open) return;
    if (!value.start || !value.end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Open days require start and end times.' });
    } else if (value.start >= value.end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Working-hours end time must be after start time.' });
    }
  });
const workingHoursInput = z.object({
  sunday: hoursWindow.optional(), monday: hoursWindow.optional(), tuesday: hoursWindow.optional(),
  wednesday: hoursWindow.optional(), thursday: hoursWindow.optional(), friday: hoursWindow.optional(),
  saturday: hoursWindow.optional(),
}).strict();
const providerAgentIdInput = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/).optional().nullable();
const providerVersionTagInput = z.string().trim().refine(isValidRetellVersionTag, {
  message: 'Deployment tag must start lowercase, use at most 20 lowercase letters, digits, hyphens or underscores, and cannot be latest, latest_published, or v<number>.',
}).optional();

function expectedRetellAgentWebhookUrl() {
  return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`;
}

function providerSnapshotData(snapshot: RetellAgentSnapshot) {
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
  };
}

function providerIntakeEvidenceFailure(snapshot: RetellAgentSnapshot): string | null {
  if (snapshot.bookToolProbeStatus === 'UNAVAILABLE') return 'provider_response_engine_unavailable';
  if (snapshot.bookToolProbeStatus === 'UNSUPPORTED') return 'provider_response_engine_unsupported';
  if (!snapshot.responseEngineGraphFingerprint || !snapshot.bookToolSchema || !snapshot.bookToolFingerprint) {
    return 'provider_intake_contract_unattested';
  }
  if (snapshot.toolCallStrictMode !== true) return 'provider_intake_contract_not_strict';
  return null;
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
  return ['agent_unlinked', 'agent_scope_mismatch', 'agent_inactive', 'agent_unverified', 'agent_configuration_changed', 'agent_verification_stale', 'location_scope_mismatch', 'intake_schema_unattested', 'intake_schema_mismatch', 'intake_schema_not_strict', 'active_intake_contract_immutable', 'active_provider_deployment_conflict'].includes(code)
    ? code
    : null;
}

function intakeConfigurationError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  return message.startsWith('invalid_intake_configuration:') ? message.slice('invalid_intake_configuration:'.length) : null;
}

function isActiveIntakeContractError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('active_intake_contract_immutable');
}

async function compileCampaignIntakeContract(
  tx: Prisma.TransactionClient,
  campaign: { id: string; tenantId: string; clinicId: string; appointmentType: string; eligibleLocationIds: string[]; intakeSchemaRevision: number },
) {
  const [fields, locations] = await Promise.all([
    tx.receptionistIntakeField.findMany({ where: { tenantId: campaign.tenantId, campaignId: campaign.id }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    tx.receptionistLocation.findMany({
      where: {
        tenantId: campaign.tenantId,
        clinicId: campaign.clinicId,
        active: true,
        branchId: { not: null },
        ...(campaign.eligibleLocationIds.length ? { id: { in: campaign.eligibleLocationIds } } : {}),
      },
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  return compileIntakeContract({
    campaignId: campaign.id,
    revision: campaign.intakeSchemaRevision,
    appointmentType: campaign.appointmentType,
    eligibleLocations: locations,
    fields,
    toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${campaign.clinicId}`,
  });
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

function isReceptionistDestinationConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function withPrismaWorkingHours<T extends { workingHours?: unknown }>(input: T) {
  const { workingHours, ...rest } = input;
  if (workingHours === undefined) return rest;
  return { ...rest, workingHours: workingHours === null ? Prisma.DbNull : workingHours };
}

async function lockReceptionistConfiguration(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receptionist-config:${tenantId}`}::text, 0))::text AS locked`;
}

async function auditReceptionistMutation(
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

const FIELD_TYPES = [
  'FIRST_NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'PREFERRED_DATE', 'PREFERRED_TIME',
  'PREFERRED_LOCATION', 'PATIENT_STATUS', 'INSURANCE_PROVIDER', 'REASON_FOR_VISIT',
  'PREFERRED_PROVIDER', 'LANGUAGE_PREFERENCE', 'CONSENT', 'CUSTOM_TEXT',
  'CUSTOM_DROPDOWN', 'CUSTOM_YES_NO',
] as const;

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
    timezone: string; defaultLanguage: string; complianceDisclosure: string;
    humanFallbackNumber: string | null; doNotContactPolicy: string; workingHours: unknown;
    locations: Array<{ id: string; name: string; address: string; phone: string | null }>;
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

function toPromptConfig(campaign: CampaignWithRelations): PromptConfig {
  const agent = campaign.agent ?? {
    name: 'Riley', voice: '11labs-Adrian', tone: 'Warm and professional',
    language: campaign.clinic.defaultLanguage, persona: null, greetingOverride: null,
  };
  return {
    clinic: {
      id: campaign.clinic.id,
      name: campaign.clinic.name,
      phone: campaign.clinic.phone,
      website: campaign.clinic.website,
      addressLine: campaign.clinic.addressLine,
      timezone: campaign.clinic.timezone,
      defaultLanguage: campaign.clinic.defaultLanguage,
      complianceDisclosure: campaign.clinic.complianceDisclosure,
      humanFallbackNumber: campaign.clinic.humanFallbackNumber,
      doNotContactPolicy: campaign.clinic.doNotContactPolicy,
      workingHours: campaign.clinic.workingHours,
    },
    agent,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      campaignType: campaign.campaignType,
      offerTitle: campaign.offerTitle,
      offerDescription: campaign.offerDescription,
      offerScript: campaign.offerScript,
      appointmentType: campaign.appointmentType,
      bookingRules: (campaign.bookingRules as PromptBookingRules | null) ?? null,
      eligibleLocationIds: campaign.eligibleLocationIds,
      smsConfirmation: campaign.smsConfirmation,
      emailConfirmation: campaign.emailConfirmation,
      intakeSchemaRevision: campaign.intakeSchemaRevision,
    },
    locations: campaign.clinic.locations,
    intakeFields: campaign.intakeFields as PromptIntakeField[],
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

export const receptionistRoutes: FastifyPluginAsync = async app => {
  // Feature gate: the entire authenticated AI receptionist surface requires the
  // ai_receptionist entitlement (the public Retell webhook is a separate plugin).
  app.addHook('preHandler', requireFeature('ai_receptionist'));

  // ===== Clinics ==========================================================
  const clinicCreate = z.object({
    name: z.string().trim().min(2).max(160),
    phone: e164Phone,
    logoUrl: z.string().trim().max(500).optional().nullable(),
    website: z.string().trim().max(300).optional().nullable(),
    addressLine: z.string().trim().max(300).optional().nullable(),
    timezone: timezoneInput.optional(),
    defaultLanguage: z.string().trim().min(2).max(20).optional(),
    complianceDisclosure: z.string().trim().min(4).max(600).optional(),
    humanFallbackNumber: optionalE164Phone,
    doNotContactPolicy: z.string().trim().min(4).max(600).optional(),
    workingHours: workingHoursInput.optional().nullable(),
    active: z.boolean().optional(),
  });
  const clinicUpdate = clinicCreate.partial();

  app.get('/clinics', { preHandler: writeRoles }, async request => {
    return db.receptionistClinic.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { createdAt: 'asc' },
      include: {
        locations: { orderBy: { createdAt: 'asc' } },
        agents: { orderBy: { createdAt: 'asc' } },
        _count: { select: { campaigns: true } },
      },
    });
  });

  app.post('/clinics', { preHandler: writeRoles }, async (request, reply) => {
    const input = clinicCreate.parse(request.body);
    let row;
    try {
      row = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const duplicate = await tx.receptionistClinic.findFirst({
          where: {
            tenantId: request.auth.tenantId,
            OR: [
              { name: { equals: input.name, mode: 'insensitive' } },
              ...(input.active !== false ? [{ phone: input.phone, active: true }] : []),
            ],
          },
          select: { id: true, name: true, phone: true, active: true },
        });
        if (duplicate) {
          throw app.httpErrors.conflict(
            duplicate.phone === input.phone && duplicate.active
              ? 'This inbound destination is already assigned to an active receptionist clinic.'
              : 'A receptionist clinic with this name already exists in this tenant.',
          );
        }
        const created = await tx.receptionistClinic.create({
          data: { tenantId: request.auth.tenantId, ...withPrismaWorkingHours(input) } as Prisma.ReceptionistClinicUncheckedCreateInput,
        });
        await auditReceptionistMutation(tx, request, { action: 'receptionistClinic.created', resource: 'receptionistClinic', resourceId: created.id, metadata: { active: created.active } });
        return created;
      });
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This inbound destination is already assigned to an active receptionist clinic.');
      throw error;
    }
    return reply.code(201).send(row);
  });

  app.patch('/clinics/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = clinicUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const existing = await tx.receptionistClinic.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!existing) throw app.httpErrors.notFound('Clinic not found');
        const merged = { ...existing, ...input };
        if (!merged.active) {
          const [activeCampaigns, runningOutbound, activeCalls] = await Promise.all([
            tx.receptionistCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id, status: 'ACTIVE' } }),
            tx.receptionistOutboundCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id, status: { in: ['SCHEDULED', 'RUNNING'] } } }),
            tx.receptionistCallLog.count({ where: { tenantId: request.auth.tenantId, clinicId: id, outcome: 'IN_PROGRESS', endedAt: null } }),
          ]);
          if (activeCampaigns || runningOutbound || activeCalls) throw app.httpErrors.conflict('Pause campaigns and finish active calls before deactivating this clinic.');
        }
        const duplicate = await tx.receptionistClinic.findFirst({
          where: {
            tenantId: request.auth.tenantId,
            id: { not: id },
            OR: [
              { name: { equals: merged.name, mode: 'insensitive' } },
              ...(merged.active ? [{ phone: merged.phone, active: true }] : []),
            ],
          },
          select: { name: true, phone: true, active: true },
        });
        if (duplicate) {
          throw app.httpErrors.conflict(
            duplicate.phone === merged.phone && duplicate.active
              ? 'This inbound destination is already assigned to an active receptionist clinic.'
              : 'A receptionist clinic with this name already exists in this tenant.',
          );
        }
        const row = await tx.receptionistClinic.update({
          where: { id },
          data: withPrismaWorkingHours(input) as Prisma.ReceptionistClinicUncheckedUpdateInput,
        });
        await auditReceptionistMutation(tx, request, { action: 'receptionistClinic.updated', resource: 'receptionistClinic', resourceId: id, metadata: { active: row.active } });
        return row;
      });
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This inbound destination is already assigned to an active receptionist clinic.');
      throw error;
    }
  });

  app.delete('/clinics/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistClinic.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Clinic not found');
      const [locations, agents, campaigns, outboundCampaigns, calls, requests] = await Promise.all([
        tx.receptionistLocation.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistAgent.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistOutboundCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistCallLog.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistAppointmentRequest.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
      ]);
      if (locations || agents || campaigns || outboundCampaigns || calls || requests) {
        throw app.httpErrors.conflict('This clinic has receptionist history or dependent configuration. Deactivate it to preserve audit lineage.');
      }
      await tx.receptionistClinic.delete({ where: { id } });
      await auditReceptionistMutation(tx, request, { action: 'receptionistClinic.deleted', resource: 'receptionistClinic', resourceId: id });
    });
    return reply.code(204).send();
  });

  // ===== Locations ========================================================
  app.get('/scheduling-branches', { preHandler: writeRoles }, async request => {
    return db.branch.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, location: true, timezone: true, active: true },
    });
  });

  const locationCreate = z.object({
    clinicId: uuid,
    branchId: uuid,
    name: z.string().trim().min(2).max(160),
    address: z.string().trim().min(2).max(300),
    phone: optionalE164Phone,
    timezone: timezoneInput.optional().nullable(),
    workingHours: workingHoursInput.optional().nullable(),
    active: z.boolean().optional(),
  });
  const locationUpdate = locationCreate.partial().omit({ clinicId: true });

  app.get('/locations', { preHandler: writeRoles }, async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    return db.receptionistLocation.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/locations', { preHandler: writeRoles }, async (request, reply) => {
    const input = locationCreate.parse(request.body);
    try {
      const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const clinic = await tx.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId, active: true } });
      if (!clinic) throw app.httpErrors.badRequest('Location must belong to an active receptionist clinic in this tenant.');
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId, active: true }, select: { id: true } });
      if (!branch) throw app.httpErrors.badRequest('Location must map to an active scheduling branch in this tenant.');
      const duplicate = await tx.receptionistLocation.findFirst({ where: { tenantId: request.auth.tenantId, clinicId: input.clinicId, name: { equals: input.name, mode: 'insensitive' } }, select: { id: true } });
      if (duplicate) throw app.httpErrors.conflict('A location with this name already exists for the clinic.');
      const created = await tx.receptionistLocation.create({
        data: { tenantId: request.auth.tenantId, ...withPrismaWorkingHours(input) } as Prisma.ReceptionistLocationUncheckedCreateInput,
      });
      await auditReceptionistMutation(tx, request, { action: 'receptionistLocation.created', resource: 'receptionistLocation', resourceId: created.id, metadata: { clinicId: created.clinicId, active: created.active } });
      return created;
      });
      return reply.code(201).send(row);
    } catch (error) {
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause active campaigns before changing their attested location configuration.');
      throw error;
    }
  });

  app.patch('/locations/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = locationUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistLocation.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Location not found');
      const merged = { ...existing, ...input };
      if (merged.active) {
        const [clinic, branch] = await Promise.all([
          tx.receptionistClinic.findFirst({ where: { id: existing.clinicId, tenantId: request.auth.tenantId, active: true }, select: { id: true } }),
          merged.branchId ? tx.branch.findFirst({ where: { id: merged.branchId, tenantId: request.auth.tenantId, active: true }, select: { id: true } }) : null,
        ]);
        if (!clinic) throw app.httpErrors.conflict('An active location requires an active receptionist clinic.');
        if (!branch) throw app.httpErrors.conflict('An active location requires an active scheduling branch in this tenant.');
      } else {
        const activeCampaign = await tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, status: 'ACTIVE', eligibleLocationIds: { has: id } }, select: { id: true } });
        if (activeCampaign) throw app.httpErrors.conflict('Remove this location from active campaigns before deactivating it.');
      }
      const duplicate = await tx.receptionistLocation.findFirst({ where: { tenantId: request.auth.tenantId, clinicId: existing.clinicId, id: { not: id }, name: { equals: merged.name, mode: 'insensitive' } }, select: { id: true } });
      if (duplicate) throw app.httpErrors.conflict('A location with this name already exists for the clinic.');
      const row = await tx.receptionistLocation.update({
        where: { id },
        data: withPrismaWorkingHours(input) as Prisma.ReceptionistLocationUncheckedUpdateInput,
      });
      await auditReceptionistMutation(tx, request, { action: 'receptionistLocation.updated', resource: 'receptionistLocation', resourceId: id, metadata: { clinicId: row.clinicId, active: row.active } });
      return row;
      });
    } catch (error) {
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause active campaigns before changing their attested location configuration.');
      throw error;
    }
  });

  app.delete('/locations/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    try {
      await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistLocation.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Location not found');
      const campaign = await tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, eligibleLocationIds: { has: id } }, select: { id: true } });
      if (campaign) throw app.httpErrors.conflict('Remove this location from receptionist campaigns before deleting it.');
      await tx.receptionistLocation.delete({ where: { id } });
      await auditReceptionistMutation(tx, request, { action: 'receptionistLocation.deleted', resource: 'receptionistLocation', resourceId: id, metadata: { clinicId: existing.clinicId } });
      });
      return reply.code(204).send();
    } catch (error) {
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause active campaigns before changing their attested location configuration.');
      throw error;
    }
  });

  // ===== Agents ===========================================================
  const agentCreate = z.object({
    clinicId: uuid,
    name: z.string().trim().min(1).max(80),
    voice: z.string().trim().max(80).optional(),
    tone: z.string().trim().max(120).optional(),
    language: z.string().trim().max(20).optional(),
    persona: z.string().trim().max(600).optional().nullable(),
    greetingOverride: z.string().trim().max(600).optional().nullable(),
    providerAgentId: providerAgentIdInput,
    providerVersionTag: providerVersionTagInput,
    active: z.boolean().optional(),
  });
  const agentUpdate = agentCreate.partial().omit({ clinicId: true });

  app.get('/agents', { preHandler: writeRoles }, async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    return db.receptionistAgent.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/agents', { preHandler: writeRoles }, async (request, reply) => {
    const input = agentCreate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const clinic = await tx.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId, active: true }, select: { id: true } });
      if (!clinic) throw app.httpErrors.badRequest('An active tenant-owned clinic is required.');
      const duplicate = await tx.receptionistAgent.findFirst({
        where: { tenantId: request.auth.tenantId, clinicId: input.clinicId, name: { equals: input.name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (duplicate) throw app.httpErrors.conflict('An agent with this name already exists for the clinic.');
      const created = await tx.receptionistAgent.create({ data: { tenantId: request.auth.tenantId, ...input } });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistAgent.created', resource: 'receptionistAgent', resourceId: created.id,
        metadata: { clinicId: created.clinicId, providerLinked: Boolean(created.providerAgentId), providerStatus: created.providerStatus },
      });
      return created;
    });
    return reply.code(201).send(row);
  });

  app.patch('/agents/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = agentUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Agent not found');
      const providerBindingChanged = (input.providerAgentId !== undefined && input.providerAgentId !== existing.providerAgentId)
        || (input.providerVersionTag !== undefined && input.providerVersionTag !== existing.providerVersionTag);
      const deactivating = input.active === false && existing.active;
      if (providerBindingChanged || deactivating) {
        const [studioReference, outboundReference] = await Promise.all([
          tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id, status: 'ACTIVE' }, select: { id: true } }),
          tx.receptionistOutboundCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id, status: { in: ['SCHEDULED', 'RUNNING'] } }, select: { id: true } }),
        ]);
        if (studioReference || outboundReference) throw app.httpErrors.conflict('Pause active and runnable campaigns before changing or deactivating this provider binding.');
      }
      if (input.name !== undefined) {
        const duplicate = await tx.receptionistAgent.findFirst({
          where: { tenantId: request.auth.tenantId, clinicId: existing.clinicId, id: { not: id }, name: { equals: input.name, mode: 'insensitive' } },
          select: { id: true },
        });
        if (duplicate) throw app.httpErrors.conflict('An agent with this name already exists for the clinic.');
      }
      const data: Prisma.ReceptionistAgentUpdateInput = { ...input };
      if (providerBindingChanged) Object.assign(data, {
        providerStatus: 'UNVERIFIED',
        providerVersion: null,
        providerPublished: null,
        providerAssignedTags: { set: [] },
        providerVoiceId: null,
        providerLanguage: null,
        providerWebhookUrl: null,
        providerWebhookEvents: { set: [] },
        providerDataStorageSetting: null,
        providerSignedUrl: null,
        providerResponseEngineType: null,
        providerResponseEngineId: null,
        providerResponseEngineVersion: null,
        providerResponseEngineGraphFingerprint: null,
        providerEffectiveDynamicVariables: Prisma.DbNull,
        providerBookToolSchema: Prisma.DbNull,
        providerBookToolFingerprint: null,
        providerToolCallStrictMode: null,
        providerLastModifiedAt: null,
        providerFingerprint: null,
        providerConfigRevision: { increment: 1 },
        providerVerifiedRevision: null,
        providerVerifiedAt: null,
        providerVerificationExpiresAt: null,
        providerLastAttemptStatus: 'NEVER',
        providerLastAttemptAt: null,
        providerLastErrorCode: null,
      });
      const row = await tx.receptionistAgent.update({ where: { id }, data });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistAgent.updated', resource: 'receptionistAgent', resourceId: id,
        metadata: { active: row.active, providerBindingChanged, providerStatus: row.providerStatus },
      });
        return row;
      });
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This active provider deployment is already assigned to another agent.');
      throw error;
    }
  });

  app.post('/agents/:id/verify-provider', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const before = await db.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!before) throw app.httpErrors.notFound('Agent not found');
    if (!before.providerAgentId) throw app.httpErrors.conflict('Link a Retell agent before verification.');

    const attemptedAt = new Date();
    const probe = await probeRetellAgent(before.providerAgentId, before.providerVersionTag);
    const permanentProbeFailure = !probe.ok && ['not_found', 'invalid_request', 'invalid_response'].includes(probe.error);
    const readinessFailure = probe.ok
      ? evaluateRetellAgentReadiness(probe.snapshot, { versionTag: before.providerVersionTag, webhookUrl: expectedRetellAgentWebhookUrl() })
      : null;
    const intakeEvidenceFailure = probe.ok ? providerIntakeEvidenceFailure(probe.snapshot) : null;
    const safeError = probe.ok ? readinessFailure ?? intakeEvidenceFailure : probe.error;

    try {
      const updated = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const current = await tx.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!current) throw app.httpErrors.notFound('Agent not found');
        if (current.providerConfigRevision !== before.providerConfigRevision
          || current.providerAgentId !== before.providerAgentId
          || current.providerVersionTag !== before.providerVersionTag) {
          throw app.httpErrors.conflict('Agent configuration changed while provider verification was in progress. Retry verification.');
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
            tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id, status: 'ACTIVE' }, select: { id: true } }),
            tx.receptionistOutboundCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id, status: { in: ['SCHEDULED', 'RUNNING'] } }, select: { id: true } }),
          ]);
          if (studioReference || outboundReference) {
            const row = await tx.receptionistAgent.update({
              where: { id },
              data: {
                providerLastAttemptAt: attemptedAt,
                providerLastAttemptStatus: 'FAILED',
                providerLastErrorCode: 'provider_deployment_drift',
              },
            });
            await auditReceptionistMutation(tx, request, {
              action: 'receptionistAgent.providerDeploymentDriftDetected',
              resource: 'receptionistAgent',
              resourceId: id,
              metadata: {
                pinnedVersion: current.providerVersion,
                detectedVersion: probe.snapshot.version,
                studioCampaignActive: Boolean(studioReference),
                outboundCampaignRunnable: Boolean(outboundReference),
              },
            });
            return { row, driftBlocked: true };
          }
        }
        const data: Prisma.ReceptionistAgentUpdateInput = {
          providerLastAttemptAt: attemptedAt,
          providerLastAttemptStatus: success ? 'SUCCEEDED' : 'FAILED',
          providerLastErrorCode: safeError,
          ...(success ? providerSnapshotData(probe.snapshot) : {}),
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
        const row = await tx.receptionistAgent.update({ where: { id }, data });
        await auditReceptionistMutation(tx, request, {
          action: success
            ? deploymentChanged ? 'receptionistAgent.providerDeploymentUpdated' : 'receptionistAgent.providerVerified'
            : 'receptionistAgent.providerVerificationFailed',
          resource: 'receptionistAgent', resourceId: id,
          metadata: {
            providerStatus: row.providerStatus,
            providerVersion: row.providerVersion,
            providerVersionTag: row.providerVersionTag,
            deploymentChanged,
            reason: safeError,
          },
        });
        return { row, driftBlocked: false };
      });
      if (updated.driftBlocked) {
        return reply.code(409).send({
          ...updated.row,
          code: 'provider_deployment_drift',
          message: 'Provider deployment drift detected. Pause active and runnable campaigns before approving the new immutable version.',
        });
      }
      if ((!probe.ok && !permanentProbeFailure) || intakeEvidenceFailure === 'provider_response_engine_unavailable') {
        return reply.code(503).send(updated.row);
      }
      return reply.code(200).send(updated.row);
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This active provider deployment is already assigned to another agent.');
      throw error;
    }
  });

  app.delete('/agents/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Agent not found');
      const [studioReference, outboundReference] = await Promise.all([
        tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id }, select: { id: true } }),
        tx.receptionistOutboundCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id }, select: { id: true } }),
      ]);
      if (studioReference || outboundReference) throw app.httpErrors.conflict('Agent history is referenced by a campaign. Deactivate the agent instead of deleting it.');
      await tx.receptionistAgent.delete({ where: { id } });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistAgent.deleted', resource: 'receptionistAgent', resourceId: id,
        metadata: { clinicId: existing.clinicId, providerLinked: Boolean(existing.providerAgentId) },
      });
    });
    return reply.code(204).send();
  });

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

  app.get('/campaigns', { preHandler: writeRoles }, async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    return db.receptionistCampaign.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
      include: {
        agent: { select: { id: true, name: true, voice: true } },
        clinic: { select: { id: true, name: true } },
        intakeFields: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { callLogs: true, appointmentRequests: true } },
      },
    });
  });

  app.get('/campaigns/:id', { preHandler: writeRoles }, async request => {
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
          const attestation = await attestCampaignIntakeContract(tx, created, agent);
          created = await tx.receptionistCampaign.update({ where: { id: created.id }, data: { ...attestation, status: 'ACTIVE' } });
        }
        await auditReceptionistMutation(tx, request, {
          action: 'receptionistCampaign.created', resource: 'receptionistCampaign', resourceId: created.id,
          metadata: { clinicId: created.clinicId, agentId: created.agentId, status: created.status },
        });
        return created;
      });
      return reply.code(201).send(row);
    } catch (error) {
      const invalid = intakeConfigurationError(error);
      if (invalid) throw app.httpErrors.badRequest(invalid);
      const reason = campaignAssignmentError(error);
      if (reason) throw app.httpErrors.conflict(`Campaign configuration is not deployable: ${reason}.`);
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This provider deployment already owns an active Studio campaign for the tenant.');
      throw error;
    }
  });

  app.patch('/campaigns/:id', { preHandler: writeRoles }, async request => {
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
        const agent = await assertCampaignAgent(tx, {
          tenantId: request.auth.tenantId, clinicId: existing.clinicId, agentId: nextAgentId,
          requireReady: nextStatus === 'ACTIVE',
        });
        await assertCampaignLocations(tx, { tenantId: request.auth.tenantId, clinicId: existing.clinicId, locationIds: nextLocations });
        const { bookingRules, status, ...rest } = input;
        let row = await tx.receptionistCampaign.update({
          where: { id },
          data: {
            ...rest,
            ...(status !== undefined && !(status === 'ACTIVE' && existing.status !== 'ACTIVE') ? { status } : {}),
            ...(bookingRules !== undefined ? { bookingRules: bookingRules ?? undefined } : {}),
          },
        });
        if (nextStatus === 'ACTIVE' && existing.status !== 'ACTIVE') {
          const attestation = await attestCampaignIntakeContract(tx, row, agent);
          row = await tx.receptionistCampaign.update({ where: { id }, data: { ...attestation, status: 'ACTIVE' } });
        }
        await auditReceptionistMutation(tx, request, {
          action: 'receptionistCampaign.updated', resource: 'receptionistCampaign', resourceId: id,
          metadata: { agentId: row.agentId, status: row.status },
        });
        return row;
      });
    } catch (error) {
      const invalid = intakeConfigurationError(error);
      if (invalid) throw app.httpErrors.badRequest(invalid);
      const reason = campaignAssignmentError(error);
      if (reason) throw app.httpErrors.conflict(`Campaign configuration is not deployable: ${reason}.`);
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This provider deployment already owns an active Studio campaign for the tenant.');
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

  // ===== Intake fields ====================================================
  const intakeFieldCreate = z.object({
    campaignId: uuid,
    fieldType: z.enum(FIELD_TYPES),
    label: z.string().trim().min(1).max(160),
    aiQuestion: z.string().trim().min(2).max(500),
    validationRule: z.string().trim().max(200).optional().nullable(),
    placeholder: z.string().trim().max(200).optional().nullable(),
    options: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    required: z.boolean().optional(),
    confirmationRequired: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  }).strict();
  const intakeFieldUpdate = intakeFieldCreate.partial().omit({ campaignId: true });

  app.get('/intake-fields', { preHandler: writeRoles }, async request => {
    const query = z.object({ campaignId: uuid }).parse(request.query);
    return db.receptionistIntakeField.findMany({
      where: { tenantId: request.auth.tenantId, campaignId: query.campaignId },
      orderBy: { sortOrder: 'asc' },
    });
  });

  app.post('/intake-fields', { preHandler: writeRoles }, async (request, reply) => {
    const input = intakeFieldCreate.parse(request.body);
    try {
      const row = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const campaign = await tx.receptionistCampaign.findFirst({ where: { id: input.campaignId, tenantId: request.auth.tenantId } });
        if (!campaign) throw app.httpErrors.notFound('Campaign not found');
        if (campaign.status === 'ACTIVE') throw new Error('active_intake_contract_immutable');
        const existing = await tx.receptionistIntakeField.findMany({ where: { tenantId: request.auth.tenantId, campaignId: input.campaignId }, orderBy: { sortOrder: 'asc' } });
        const sortOrder = input.sortOrder ?? (existing.length ? Math.max(...existing.map(field => field.sortOrder)) + 1 : 0);
        const candidate: IntakeFieldConfiguration = {
          ...input,
          options: input.options ?? [],
          required: input.required ?? true,
          confirmationRequired: input.confirmationRequired ?? false,
          sortOrder,
        };
        const issues = validateIntakeFieldConfiguration([...existing, candidate]);
        if (issues.length) throw new Error(`invalid_intake_configuration:${issues.join('|')}`);
        const created = await tx.receptionistIntakeField.create({ data: { tenantId: request.auth.tenantId, ...candidate, campaignId: input.campaignId } });
        // Compile inside the same transaction so location-dependent schema
        // invariants fail atomically with the field mutation.
        await compileCampaignIntakeContract(tx, await tx.receptionistCampaign.findUniqueOrThrow({ where: { id: campaign.id } }));
        await auditReceptionistMutation(tx, request, { action: 'receptionistIntakeField.created', resource: 'receptionistIntakeField', resourceId: created.id, metadata: { campaignId: input.campaignId } });
        return created;
      });
      return reply.code(201).send(row);
    } catch (error) {
      const invalid = intakeConfigurationError(error);
      if (invalid) throw app.httpErrors.badRequest(invalid);
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause the active campaign before changing its attested intake contract.');
      throw error;
    }
  });

  app.patch('/intake-fields/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = intakeFieldUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const existing = await tx.receptionistIntakeField.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!existing) throw app.httpErrors.notFound('Intake field not found');
        const campaign = await tx.receptionistCampaign.findFirst({ where: { id: existing.campaignId, tenantId: request.auth.tenantId }, select: { status: true } });
        if (campaign?.status === 'ACTIVE') throw new Error('active_intake_contract_immutable');
        const fields = await tx.receptionistIntakeField.findMany({ where: { tenantId: request.auth.tenantId, campaignId: existing.campaignId } });
        const candidate = { ...existing, ...input } as IntakeFieldConfiguration;
        const issues = validateIntakeFieldConfiguration(fields.map(field => field.id === id ? candidate : field));
        if (issues.length) throw new Error(`invalid_intake_configuration:${issues.join('|')}`);
        const row = await tx.receptionistIntakeField.update({ where: { id }, data: input });
        const currentCampaign = await tx.receptionistCampaign.findUniqueOrThrow({ where: { id: existing.campaignId } });
        await compileCampaignIntakeContract(tx, currentCampaign);
        await auditReceptionistMutation(tx, request, { action: 'receptionistIntakeField.updated', resource: 'receptionistIntakeField', resourceId: id, metadata: { campaignId: existing.campaignId } });
        return row;
      });
    } catch (error) {
      const invalid = intakeConfigurationError(error);
      if (invalid) throw app.httpErrors.badRequest(invalid);
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause the active campaign before changing its attested intake contract.');
      throw error;
    }
  });

  app.delete('/intake-fields/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    try {
      await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const existing = await tx.receptionistIntakeField.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!existing) throw app.httpErrors.notFound('Intake field not found');
        const campaign = await tx.receptionistCampaign.findFirst({ where: { id: existing.campaignId, tenantId: request.auth.tenantId }, select: { status: true } });
        if (campaign?.status === 'ACTIVE') throw new Error('active_intake_contract_immutable');
        await tx.receptionistIntakeField.delete({ where: { id } });
        await auditReceptionistMutation(tx, request, { action: 'receptionistIntakeField.deleted', resource: 'receptionistIntakeField', resourceId: id, metadata: { campaignId: existing.campaignId } });
      });
      return reply.code(204).send();
    } catch (error) {
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause the active campaign before changing its attested intake contract.');
      throw error;
    }
  });

  app.post('/intake-fields/reorder', { preHandler: writeRoles }, async request => {
    const input = z.object({ campaignId: uuid, orderedIds: z.array(uuid).max(24) }).strict().parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const campaign = await tx.receptionistCampaign.findFirst({ where: { id: input.campaignId, tenantId: request.auth.tenantId } });
        if (!campaign) throw app.httpErrors.notFound('Campaign not found');
        if (campaign.status === 'ACTIVE') throw new Error('active_intake_contract_immutable');
        const fields = await tx.receptionistIntakeField.findMany({ where: { tenantId: request.auth.tenantId, campaignId: input.campaignId } });
        if (new Set(input.orderedIds).size !== input.orderedIds.length
          || fields.length !== input.orderedIds.length
          || fields.some(field => !input.orderedIds.includes(field.id))) {
          throw new Error('invalid_intake_configuration:Reorder must contain every campaign field exactly once.');
        }
        const future = fields.map(field => ({ ...field, sortOrder: input.orderedIds.indexOf(field.id) }));
        const issues = validateIntakeFieldConfiguration(future);
        if (issues.length) throw new Error(`invalid_intake_configuration:${issues.join('|')}`);
        for (const [index, fieldId] of input.orderedIds.entries()) {
          await tx.receptionistIntakeField.update({ where: { id: fieldId }, data: { sortOrder: index } });
        }
        await auditReceptionistMutation(tx, request, { action: 'receptionistIntakeField.reordered', resource: 'receptionistCampaign', resourceId: input.campaignId });
        return tx.receptionistIntakeField.findMany({ where: { tenantId: request.auth.tenantId, campaignId: input.campaignId }, orderBy: { sortOrder: 'asc' } });
      });
    } catch (error) {
      const invalid = intakeConfigurationError(error);
      if (invalid) throw app.httpErrors.badRequest(invalid);
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause the active campaign before changing its attested intake contract.');
      throw error;
    }
  });

  // ===== Prompt generation + RetellAI export ==============================
  app.get('/campaigns/:id/prompt', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await loadCampaign(request.auth.tenantId, id);
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const config = toPromptConfig(campaign as unknown as CampaignWithRelations);
    return {
      systemPrompt: generateSystemPrompt(config),
      samples: generateSamples(config),
    };
  });

  app.get('/campaigns/:id/retell-config', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await loadCampaign(request.auth.tenantId, id);
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const config = toPromptConfig(campaign as unknown as CampaignWithRelations);
    return buildRetellConfig(config, { webhookBaseUrl: env.PUBLIC_API_URL });
  });

  // ===== Appointment requests (read) ======================================
  app.get('/appointment-requests', { preHandler: callArtifactRead }, async request => {
    const query = z.object({
      clinicId: uuid.optional(),
      campaignId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    return db.receptionistAppointmentRequest.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...(query.clinicId ? { clinicId: query.clinicId } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { campaign: { select: { id: true, name: true } } },
    });
  });

  app.patch('/appointment-requests/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      status: z.enum(['PENDING', 'CONFIRMED', 'CANCELED', 'COMPLETED', 'NO_SLOTS']).optional(),
      bookedSlot: z.string().trim().max(120).optional().nullable(),
      notes: z.string().trim().max(1000).optional().nullable(),
    }).parse(request.body);
    const existing = await db.receptionistAppointmentRequest.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Appointment request not found');
    const row = await db.receptionistAppointmentRequest.update({ where: { id }, data: input });
    await audit(request, { action: 'receptionistAppointmentRequest.updated', resource: 'receptionistAppointmentRequest', resourceId: id });
    return row;
  });

  // Persistent, minimum-necessary reconciliation state for the Studio. This
  // is rebuilt from durable call/target safety state on every refresh; a
  // transient launch toast is never the only warning that a provider call may
  // still be live. Explicitly resolved signal/task evidence removes the row.
  app.get('/outbound-campaigns/:id/reconciliations', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await db.receptionistOutboundCampaign.findFirst({
      where: { id, tenantId: request.auth.tenantId }, select: { id: true },
    });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const reconciliationSignalTypes = [
      'receptionist_outbound_stop_unconfirmed_after_acceptance',
      'receptionist_outbound_provider_acceptance_unknown',
      'receptionist_outbound_local_binding_failed',
      'receptionist_provider_deployment_mismatch',
      'receptionist_outbound_provider_intent_recovery',
    ];
    const reconciliationTaskWorkflows = [
      'receptionist_outbound_reconciliation',
      'receptionist_outbound_stop_reconciliation',
      'receptionist_provider_intent_recovery',
    ];
    // Candidate discovery is driven by durable reconciliation evidence, not
    // the generic ESCALATED outcome (which is also used for ordinary handoffs
    // and incomplete booking payloads). Target lastCallLogIds are fetched
    // exactly, so a critical older row cannot fall out of a recent-log window.
    const [targets, signals, taskRows, unboundIntents] = await Promise.all([
      db.receptionistCallTarget.findMany({
        where: { tenantId: request.auth.tenantId, campaignId: id, lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: { not: null } },
        select: { id: true, lastCallLogId: true },
      }),
      db.operationalSignal.findMany({
        where: {
          tenantId: request.auth.tenantId, entityType: 'receptionistCallLog',
          entityId: { not: null }, signalType: { in: reconciliationSignalTypes },
        },
        select: { id: true, entityId: true, status: true }, orderBy: { createdAt: 'asc' },
      }),
      db.staffTask.findMany({
        where: {
          tenantId: request.auth.tenantId,
          OR: reconciliationTaskWorkflows.map(workflow => ({ metadata: { path: ['workflow'], equals: workflow } })),
        },
        select: { id: true, status: true, metadata: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.receptionistOutboundProviderIntent.findMany({
        where: {
          tenantId: request.auth.tenantId,
          outboundCampaignId: id,
          callLog: { retellCallId: null, outcome: { in: ['IN_PROGRESS', 'ESCALATED'] } },
        },
        select: { callLogId: true },
      }),
    ]);
    const tasks = taskRows.flatMap(task => {
      const metadata = task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
        ? task.metadata as Prisma.JsonObject
        : null;
      const workflow = typeof metadata?.workflow === 'string' ? metadata.workflow : '';
      const callLogId = typeof metadata?.callLogId === 'string' ? metadata.callLogId : null;
      return callLogId && workflow.startsWith('receptionist_') && workflow.includes('reconcil')
        ? [{ id: task.id, status: task.status, callLogId }]
        : [];
    });
    const isUuid = (value: string | null): value is string => value !== null && uuid.safeParse(value).success;
    const candidateCallLogIds = [...new Set([
      ...targets.map(target => target.lastCallLogId).filter(isUuid),
      ...signals.map(signal => signal.entityId).filter(isUuid),
      ...tasks.map(task => task.callLogId).filter(isUuid),
      ...unboundIntents.map(intent => intent.callLogId),
    ])];
    const candidateLogs = candidateCallLogIds.length === 0 ? [] : await db.receptionistCallLog.findMany({
      where: {
        tenantId: request.auth.tenantId, outboundCampaignId: id,
        id: { in: candidateCallLogIds },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, retellCallId: true, targetId: true, outcome: true, createdAt: true },
    });
    const targetByCall = new Map(targets.map(target => [target.lastCallLogId!, target.id]));
    const unboundIntentCalls = new Set(unboundIntents.map(intent => intent.callLogId));
    const active = candidateLogs.flatMap(log => {
      const callSignals = signals.filter(signal => signal.entityId === log.id);
      const callTasks = tasks.filter(task => task.callLogId === log.id);
      const signalsResolved = callSignals.length > 0 && callSignals.every(signal => signal.status === 'resolved');
      const tasksResolved = callTasks.length > 0 && callTasks.every(task => task.status === 'COMPLETED');
      const durableResolution = callSignals.length > 0
        ? signalsResolved && (callTasks.length === 0 || tasksResolved)
        : tasksResolved;
      // A terminal unbound intent remains visible until the dedicated signal
      // and task evidence prove that staff reconciled provider state. The
      // immutable intent itself is retained for audit and is never deleted.
      if (durableResolution) return [];
      return [{
        localCallLogId: log.id,
        providerCallId: log.retellCallId,
        targetId: log.targetId ?? targetByCall.get(log.id) ?? null,
        triggerSources: [
          ...(targetByCall.has(log.id) ? ['RECONCILIATION_REQUIRED' as const] : []),
          ...(callSignals.length > 0 ? ['RECONCILIATION_SIGNAL' as const] : []),
          ...(callTasks.length > 0 ? ['RECONCILIATION_TASK' as const] : []),
          ...(unboundIntentCalls.has(log.id) ? ['UNBOUND_PROVIDER_INTENT' as const] : []),
        ],
        signalIds: callSignals.map(signal => signal.id),
        signalStatuses: callSignals.map(signal => signal.status),
        reviewTaskIds: callTasks.map(task => task.id),
        reviewTaskStatuses: callTasks.map(task => task.status),
        createdAt: log.createdAt,
      }];
    });
    await audit(request, {
      action: 'receptionist.outboundReconciliation.listRead', resource: 'receptionistOutboundCampaign',
      resourceId: id, metadata: { activeCount: active.length },
    });
    return active;
  });

  // Staff never "mark" a request booked. They first create the appointment
  // through the canonical scheduler, then bind that exact provider-backed
  // appointment here. The request, source-call link, and audit evidence commit
  // atomically so the queue cannot claim success without an Appointment FK.
  app.post('/booking-requests/:id/reconcile', { preHandler: bookingReviewRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      appointmentId: uuid,
      outcomeReason: z.string().trim().min(5).max(1000),
      acknowledgeRequestDifferences: z.literal(true),
    }).strict().parse(request.body);

    return runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-request-reconcile:${request.auth.tenantId}:${id}`})::bigint)`;
      const existing = await tx.appointmentRequest.findFirst({
        where: { id, tenantId: request.auth.tenantId },
        include: { callLog: { select: { retellCallId: true } } },
      });
      if (!existing) throw app.httpErrors.notFound('Request not found');
      if (existing.status === 'BOOKED') {
        if (existing.bookedAppointmentId !== input.appointmentId) {
          throw app.httpErrors.conflict('This request is already linked to a different canonical appointment.');
        }
        const replay = await tx.appointment.findFirst({
          where: { id: input.appointmentId, tenantId: request.auth.tenantId, deletedAt: null },
          select: {
            id: true, service: true, startsAt: true,
            branch: { select: { timezone: true, name: true, location: true } },
            providerProfile: { select: { user: { select: { displayName: true } } } },
          },
        });
        if (!replay) throw app.httpErrors.conflict('The linked canonical appointment is no longer available.');
        return {
          status: 'BOOKED' as const, requestId: existing.id, appointmentId: replay.id, duplicate: true,
          appointment: {
            service: replay.service, startsAt: replay.startsAt, timezone: replay.branch.timezone,
            locationName: replay.branch.name, locationAddress: replay.branch.location.trim() || null,
            providerName: replay.providerProfile?.user.displayName ?? null,
          },
        };
      }
      if (!['PENDING_REVIEW', 'MISSING_INFO'].includes(existing.status)) {
        throw app.httpErrors.conflict('A terminal appointment request cannot be reconciled to a booking.');
      }
      if (existing.source === 'ai_receptionist' && !existing.callLogId) {
        throw app.httpErrors.conflict('The AI receptionist request has no trusted source call and cannot be marked booked.');
      }

      const appointment = await tx.appointment.findFirst({
        where: {
          id: input.appointmentId, tenantId: request.auth.tenantId, deletedAt: null,
          status: { notIn: ['CANCELED', 'NO_SHOW'] },
        },
        select: {
          id: true, branchId: true, patientId: true, providerProfileId: true,
          receptionistCallLogId: true, service: true, startsAt: true,
          branch: { select: { timezone: true, name: true, location: true } },
          providerProfile: { select: { user: { select: { displayName: true } } } },
        },
      });
      if (!appointment) throw app.httpErrors.badRequest('Select an active canonical appointment.');
      if (!appointment.providerProfileId || !appointment.providerProfile?.user.displayName) {
        throw app.httpErrors.conflict('The appointment has no canonical provider and cannot reconcile this request.');
      }
      let identityProof: 'request_patient' | 'verified_call_identity' | 'appointment_source_call' | null = null;
      if (existing.patientId) {
        if (appointment.patientId !== existing.patientId) {
          throw app.httpErrors.conflict('The appointment belongs to a different patient than the request.');
        }
        identityProof = 'request_patient';
      } else if (existing.callLogId && appointment.receptionistCallLogId === existing.callLogId) {
        identityProof = 'appointment_source_call';
      } else if (existing.callLogId && existing.callLog?.retellCallId) {
        const verifiedIdentity = await tx.idempotencyKey.findUnique({
          where: { scope_key: {
            scope: 'receptionist.voice-identity',
            key: `${request.auth.tenantId}:${existing.callLog.retellCallId}`,
          } },
          select: { resultId: true },
        });
        if (verifiedIdentity?.resultId === appointment.patientId) identityProof = 'verified_call_identity';
      }
      if (!identityProof) {
        throw app.httpErrors.conflict('This request has no durable patient identity proof for the selected appointment. Verify identity or bind the canonical appointment to the exact source call before reconciling.');
      }
      if (existing.branchId && appointment.branchId !== existing.branchId) {
        throw app.httpErrors.conflict('The appointment belongs to a different branch than the request.');
      }
      if (appointment.receptionistCallLogId && appointment.receptionistCallLogId !== existing.callLogId) {
        throw app.httpErrors.conflict('The appointment is already bound to another receptionist call.');
      }
      const alreadyLinked = await tx.appointmentRequest.findFirst({
        where: { tenantId: request.auth.tenantId, bookedAppointmentId: appointment.id, id: { not: existing.id } },
        select: { id: true },
      });
      if (alreadyLinked) throw app.httpErrors.conflict('The appointment is already linked to another request.');

      const differences = [
        existing.requestedService && existing.requestedService.trim().toLocaleLowerCase() !== appointment.service.trim().toLocaleLowerCase() ? 'service' : null,
        existing.requestedDateTime && existing.requestedDateTime.getTime() !== appointment.startsAt.getTime() ? 'dateTime' : null,
      ].filter((value): value is string => value !== null);
      if (existing.callLogId && !appointment.receptionistCallLogId) {
        await tx.appointment.update({ where: { id: appointment.id }, data: { receptionistCallLogId: existing.callLogId } });
      }
      const updated = await tx.appointmentRequest.update({
        where: { id: existing.id },
        data: {
          status: 'BOOKED', bookedAppointmentId: appointment.id,
          branchId: appointment.branchId, patientId: appointment.patientId,
          missingFields: [], outcomeReason: input.outcomeReason,
        },
      });
      if (existing.callLogId) {
        await tx.receptionistCallLog.updateMany({
          where: { id: existing.callLogId, tenantId: request.auth.tenantId, outcome: 'IN_PROGRESS' },
          data: { outcome: 'BOOKED' },
        });
      }
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionist.appointmentRequest.reconciledToCanonicalAppointment',
        resource: 'appointmentRequest', resourceId: existing.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { appointmentId: appointment.id, differences, identityProof, reasonRecorded: true, requestDifferencesAcknowledged: true },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId, eventType: 'receptionist.appointmentRequest.reconciled',
        entityType: 'appointmentRequest', entityId: existing.id, sourceModule: 'receptionist',
        payload: { appointmentId: appointment.id, differences, identityProof },
      } });
      return {
        status: 'BOOKED' as const, requestId: updated.id, appointmentId: appointment.id, duplicate: false,
        appointment: {
          service: appointment.service, startsAt: appointment.startsAt, timezone: appointment.branch.timezone,
          locationName: appointment.branch.name, locationAddress: appointment.branch.location.trim() || null,
          providerName: appointment.providerProfile.user.displayName,
        },
      };
    });
  });

  // Delivery state is operational evidence, not a cosmetic "sent" flag. Staff
  // must be able to distinguish provider acceptance from proven delivery and
  // see ambiguous/dead-lettered confirmations that require reconciliation.
  app.get('/confirmation-deliveries', { preHandler: callArtifactRead }, async request => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    const rows = await db.notificationEvent.findMany({
      where: { tenantId: request.auth.tenantId, source: 'receptionist.appointment_confirmation' },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      select: {
        id: true, appointmentId: true, patientId: true, channel: true, status: true,
        attempts: true, maxAttempts: true, failureReason: true, provider: true,
        acceptedAt: true, deliveredAt: true, deadLetteredAt: true, createdAt: true,
        appointment: { select: { service: true, startsAt: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    await audit(request, {
      action: 'receptionist.confirmationDelivery.listRead',
      resource: 'notificationEvent',
      metadata: { count: rows.length },
    });
    return rows.map(row => ({
      ...row,
      patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}`.trim() : null,
      appointmentService: row.appointment?.service ?? null,
      appointmentStartsAt: row.appointment?.startsAt ?? null,
      patient: undefined,
      appointment: undefined,
    }));
  });

  // ===== Call logs (read) =================================================
  app.get('/call-logs', { preHandler: callArtifactRead }, async request => {
    const query = z.object({
      clinicId: uuid.optional(),
      campaignId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    const rows = await db.receptionistCallLog.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...(query.clinicId ? { clinicId: query.clinicId } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { campaign: { select: { id: true, name: true } } },
    });
    const canReadRecordings = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.RECORDINGS_READ);
    await audit(request, {
      action: 'receptionistCallLog.listRead',
      resource: 'receptionistCallLog',
      metadata: { count: rows.length, recordingsDisclosed: canReadRecordings },
    });
    return rows.map(row => ({
      ...row,
      recordingAvailable: Boolean(row.recordingUrl),
      recordingUrl: canReadRecordings ? row.recordingUrl : null,
    }));
  });

  app.get('/call-logs/:id', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const row = await db.receptionistCallLog.findFirst({
      where: { id, tenantId: request.auth.tenantId },
      include: { campaign: { select: { id: true, name: true } } },
    });
    if (!row) throw app.httpErrors.notFound('Call log not found');
    const canReadRecording = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.RECORDINGS_READ);
    await audit(request, {
      action: 'receptionistCallLog.read',
      resource: 'receptionistCallLog',
      resourceId: row.id,
      metadata: { recordingDisclosed: canReadRecording && Boolean(row.recordingUrl) },
    });
    return {
      ...row,
      recordingAvailable: Boolean(row.recordingUrl),
      recordingUrl: canReadRecording ? row.recordingUrl : null,
    };
  });

  // ===== Opt-outs =========================================================
  const optOutCreate = z.object({
    clinicId: uuid.optional().nullable(),
    contactPhone: optionalE164Phone,
    contactEmail: z.string().trim().email().max(160).transform(value => value.toLowerCase()).optional().nullable(),
    channel: z.enum(['VOICE', 'SMS', 'EMAIL', 'ALL']).optional(),
    reason: z.string().trim().min(3).max(300),
  }).strict().superRefine((value, ctx) => {
    if (!value.contactPhone && !value.contactEmail) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A phone number or email is required' });
    if ((value.channel === 'VOICE' || value.channel === 'SMS') && !value.contactPhone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.channel} opt-outs require a phone number` });
    }
    if (value.channel === 'EMAIL' && !value.contactEmail) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'EMAIL opt-outs require an email address' });
  });
  const optOutRevocation = z.object({
    reason: z.string().trim().min(5).max(500),
    acknowledgeReactivationRisk: z.literal(true),
  }).strict();

  app.get('/opt-outs', { preHandler: callArtifactRead }, async request => {
    return db.receptionistOptOut.findMany({
      where: { tenantId: request.auth.tenantId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.post('/opt-outs', { preHandler: writeRoles }, async (request, reply) => {
    const input = optOutCreate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockDncDestinationFence(tx, request.auth.tenantId, [input.contactPhone, input.contactEmail]);
      if (input.clinicId && !(await tx.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId }, select: { id: true } }))) {
        throw app.httpErrors.badRequest('Clinic does not belong to this tenant.');
      }
      const created = await tx.receptionistOptOut.create({ data: { tenantId: request.auth.tenantId, ...input } });
      const occurredAt = new Date();
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionistOptOut.created', resource: 'receptionistOptOut', resourceId: created.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], occurredAt,
        metadata: { channel: created.channel, clinicId: created.clinicId, reasonRecorded: true, source: 'manual_api' },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId, eventType: 'receptionist.dnc.activated', entityType: 'receptionistOptOut',
        entityId: created.id, sourceModule: 'receptionist', occurredAt,
        payload: { channel: created.channel, clinicId: created.clinicId, source: 'manual_api' },
      } });
      return created;
    });
    return reply.code(201).send(row);
  });

  app.delete('/opt-outs/:id', { preHandler: [ownerAdminRoles, writeRoles] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = optOutRevocation.parse(request.body);
    await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.receptionistOptOut.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Opt-out not found');
      await lockDncDestinationFence(tx, request.auth.tenantId, [existing.contactPhone, existing.contactEmail]);
      const revokedAt = new Date();
      const changed = await tx.receptionistOptOut.updateMany({
        where: { id, tenantId: request.auth.tenantId, revokedAt: null },
        data: { revokedAt, revokedByUserId: request.auth.userId, revocationReason: input.reason },
      });
      if (changed.count !== 1) throw app.httpErrors.conflict('Opt-out suppression has already been revoked.');
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionistOptOut.revoked', resource: 'receptionistOptOut', resourceId: id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], occurredAt: revokedAt,
        metadata: { channel: existing.channel, clinicId: existing.clinicId, reasonRecorded: true, acknowledgement: 'reactivation_risk_confirmed' },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId, eventType: 'receptionist.dnc.revoked', entityType: 'receptionistOptOut',
        entityId: id, sourceModule: 'receptionist', occurredAt: revokedAt,
        payload: { channel: existing.channel, clinicId: existing.clinicId, authorizedRole: request.auth.role, acknowledgement: 'reactivation_risk_confirmed' },
      } });
    });
    return reply.code(204).send();
  });

  // ===== Overview (dashboard metrics) =====================================
  app.get('/overview', async request => {
    const tenantId = request.auth.tenantId;
    const [clinics, campaigns, callLogs, requests, optOuts] = await Promise.all([
      db.receptionistClinic.count({ where: { tenantId } }),
      db.receptionistCampaign.findMany({ where: { tenantId }, select: { status: true } }),
      db.receptionistCallLog.findMany({ where: { tenantId }, select: { outcome: true, durationSeconds: true } }),
      db.receptionistAppointmentRequest.count({ where: { tenantId } }),
      db.receptionistOptOut.count({ where: { tenantId, revokedAt: null } }),
    ]);
    const booked = callLogs.filter(call => call.outcome === 'BOOKED').length;
    const totalCalls = callLogs.length;
    const avgDuration = totalCalls
      ? Math.round(callLogs.reduce((sum, call) => sum + call.durationSeconds, 0) / totalCalls)
      : 0;
    return {
      clinics,
      activeCampaigns: campaigns.filter(campaign => campaign.status === 'ACTIVE').length,
      totalCampaigns: campaigns.length,
      totalCalls,
      booked,
      bookingRate: totalCalls ? Math.round((booked / totalCalls) * 100) : 0,
      appointmentRequests: requests,
      optOuts,
      avgDurationSeconds: avgDuration,
    };
  });

  // ===== Outbound calling (campaigns, targets, launch, booking queue) =====
  // Registered here so it inherits the ai_receptionist feature gate above.
  await app.register(outboundRoutes);
};

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
    const usedMinutes = Math.max(voiceUsage.used, aiUsage.receptionistMinutes);
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
            startedAt: new Date(),
            endedAt: ended ? new Date() : undefined,
          },
        });
      if (ended) {
        const priorMinutes = current ? Math.ceil(current.durationSeconds / 60) : 0;
        const finalMinutes = Math.ceil(row.durationSeconds / 60);
        const delta = Math.max(0, finalMinutes - priorMinutes);
        if (delta > 0) {
          await tx.tenantAiUsage.upsert({
            where: { tenantId },
            update: { receptionistMinutes: { increment: delta } },
            create: { tenantId, receptionistMinutes: delta },
          });
          await tx.tenantUsageLimit.upsert({
            where: { tenantId_key: { tenantId, key: 'voice_minutes' } },
            update: { used: { increment: delta } },
            create: { tenantId, key: 'voice_minutes', limitValue: 500, used: delta },
          });
        }
      }
      return row;
    });

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

    if (body.call?.direction === 'inbound' || resolvedByDestination) {
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
          },
        });
      }
      return existing;
    });

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

    const result = await handleAgentTool(
      {
        tenantId,
        callId: providerCallId,
        callerPhone: activeCall.callerPhone,
        trustedBooking,
      },
      body.name,
      trustedToolArgs,
    );
    return reply.code(200).send(result);
  });
};
