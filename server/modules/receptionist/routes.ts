import type { FastifyPluginAsync } from 'fastify';
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
import { runBookingHandoff } from './handoff';
import { handleAgentTool } from '../../lib/receptionist/liveTools';
import { ingestCallArtifacts } from '../../lib/receptionist/privacyLifecycle';
import { enterTenantContext } from '../../lib/tenantContext';
import { resolveIngressTenant } from '../../lib/tenantIngressResolvers';
import { isFeatureEnabled } from '../../lib/entitlements';
import { platformDb } from '../../lib/platformDb';
import { MAX_TENANT_ACTIVE_CALLS, DEFAULT_VOICE_MINUTES_LIMIT } from './outbound';
import { stopPhoneCall } from '../../lib/retell';

const uuid = z.string().uuid();
const RECEPTIONIST_CALL_LEASE_MS = 4 * 60 * 60 * 1_000;
const idParam = z.object({ id: uuid });
const writeRoles = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.MANAGE);
const callArtifactRead = requireReceptionistPermission(RECEPTIONIST_PERMISSIONS.CALL_ARTIFACTS_READ);
const e164Phone = z.string().trim().max(40)
  .transform(value => value.replace(/[().\s-]/g, ''))
  .refine(value => /^\+[1-9]\d{7,14}$/.test(value), 'Phone must include country code in E.164 format');

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
    timezone: z.string().trim().min(2).max(80).optional(),
    defaultLanguage: z.string().trim().min(2).max(20).optional(),
    complianceDisclosure: z.string().trim().min(4).max(600).optional(),
    humanFallbackNumber: z.string().trim().max(40).optional().nullable(),
    doNotContactPolicy: z.string().trim().min(4).max(600).optional(),
    workingHours: z.any().optional(),
    active: z.boolean().optional(),
  });
  const clinicUpdate = clinicCreate.partial();

  app.get('/clinics', async request => {
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
    const row = await db.receptionistClinic.create({
      data: { tenantId: request.auth.tenantId, ...input },
    });
    await audit(request, { action: 'receptionistClinic.created', resource: 'receptionistClinic', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/clinics/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = clinicUpdate.parse(request.body);
    const existing = await db.receptionistClinic.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Clinic not found');
    const row = await db.receptionistClinic.update({ where: { id }, data: input });
    await audit(request, { action: 'receptionistClinic.updated', resource: 'receptionistClinic', resourceId: id });
    return row;
  });

  app.delete('/clinics/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.receptionistClinic.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Clinic not found');
    await db.receptionistClinic.delete({ where: { id } });
    await audit(request, { action: 'receptionistClinic.deleted', resource: 'receptionistClinic', resourceId: id });
    return reply.code(204).send();
  });

  // ===== Locations ========================================================
  const locationCreate = z.object({
    clinicId: uuid,
    name: z.string().trim().min(2).max(160),
    address: z.string().trim().min(2).max(300),
    phone: z.string().trim().max(40).optional().nullable(),
    timezone: z.string().trim().max(80).optional().nullable(),
    workingHours: z.any().optional(),
    active: z.boolean().optional(),
  });
  const locationUpdate = locationCreate.partial().omit({ clinicId: true });

  app.get('/locations', async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    return db.receptionistLocation.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/locations', { preHandler: writeRoles }, async (request, reply) => {
    const input = locationCreate.parse(request.body);
    const clinic = await db.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId } });
    if (!clinic) throw app.httpErrors.notFound('Clinic not found');
    const row = await db.receptionistLocation.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'receptionistLocation.created', resource: 'receptionistLocation', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/locations/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = locationUpdate.parse(request.body);
    const existing = await db.receptionistLocation.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Location not found');
    const row = await db.receptionistLocation.update({ where: { id }, data: input });
    await audit(request, { action: 'receptionistLocation.updated', resource: 'receptionistLocation', resourceId: id });
    return row;
  });

  app.delete('/locations/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.receptionistLocation.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Location not found');
    await db.receptionistLocation.delete({ where: { id } });
    await audit(request, { action: 'receptionistLocation.deleted', resource: 'receptionistLocation', resourceId: id });
    return reply.code(204).send();
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
    active: z.boolean().optional(),
  });
  const agentUpdate = agentCreate.partial().omit({ clinicId: true });

  app.get('/agents', async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    return db.receptionistAgent.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/agents', { preHandler: writeRoles }, async (request, reply) => {
    const input = agentCreate.parse(request.body);
    const clinic = await db.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId } });
    if (!clinic) throw app.httpErrors.notFound('Clinic not found');
    const row = await db.receptionistAgent.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'receptionistAgent.created', resource: 'receptionistAgent', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/agents/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = agentUpdate.parse(request.body);
    const existing = await db.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Agent not found');
    const row = await db.receptionistAgent.update({ where: { id }, data: input });
    await audit(request, { action: 'receptionistAgent.updated', resource: 'receptionistAgent', resourceId: id });
    return row;
  });

  app.delete('/agents/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Agent not found');
    await db.receptionistAgent.delete({ where: { id } });
    await audit(request, { action: 'receptionistAgent.deleted', resource: 'receptionistAgent', resourceId: id });
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

  app.get('/campaigns', async request => {
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

  app.get('/campaigns/:id', async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await loadCampaign(request.auth.tenantId, id);
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    return campaign;
  });

  app.post('/campaigns', { preHandler: writeRoles }, async (request, reply) => {
    const input = campaignCreate.parse(request.body);
    const clinic = await db.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId } });
    if (!clinic) throw app.httpErrors.notFound('Clinic not found');
    const { bookingRules, eligibleLocationIds, ...rest } = input;
    const row = await db.receptionistCampaign.create({
      data: {
        tenantId: request.auth.tenantId,
        ...rest,
        eligibleLocationIds: eligibleLocationIds ?? [],
        bookingRules: bookingRules ?? undefined,
      },
    });
    await audit(request, { action: 'receptionistCampaign.created', resource: 'receptionistCampaign', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/campaigns/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = campaignUpdate.parse(request.body);
    const existing = await db.receptionistCampaign.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Campaign not found');
    const { bookingRules, ...rest } = input;
    const row = await db.receptionistCampaign.update({
      where: { id },
      data: { ...rest, ...(bookingRules !== undefined ? { bookingRules: bookingRules ?? undefined } : {}) },
    });
    await audit(request, { action: 'receptionistCampaign.updated', resource: 'receptionistCampaign', resourceId: id });
    return row;
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
    options: z.array(z.string().trim().min(1).max(120)).optional(),
    required: z.boolean().optional(),
    confirmationRequired: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  });
  const intakeFieldUpdate = intakeFieldCreate.partial().omit({ campaignId: true });

  app.get('/intake-fields', async request => {
    const query = z.object({ campaignId: uuid }).parse(request.query);
    return db.receptionistIntakeField.findMany({
      where: { tenantId: request.auth.tenantId, campaignId: query.campaignId },
      orderBy: { sortOrder: 'asc' },
    });
  });

  app.post('/intake-fields', { preHandler: writeRoles }, async (request, reply) => {
    const input = intakeFieldCreate.parse(request.body);
    const campaign = await db.receptionistCampaign.findFirst({ where: { id: input.campaignId, tenantId: request.auth.tenantId } });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const count = await db.receptionistIntakeField.count({ where: { campaignId: input.campaignId } });
    const row = await db.receptionistIntakeField.create({
      data: {
        tenantId: request.auth.tenantId,
        ...input,
        options: input.options ?? [],
        sortOrder: input.sortOrder ?? count,
      },
    });
    await audit(request, { action: 'receptionistIntakeField.created', resource: 'receptionistIntakeField', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/intake-fields/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = intakeFieldUpdate.parse(request.body);
    const existing = await db.receptionistIntakeField.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Intake field not found');
    const row = await db.receptionistIntakeField.update({ where: { id }, data: input });
    await audit(request, { action: 'receptionistIntakeField.updated', resource: 'receptionistIntakeField', resourceId: id });
    return row;
  });

  app.delete('/intake-fields/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.receptionistIntakeField.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Intake field not found');
    await db.receptionistIntakeField.delete({ where: { id } });
    await audit(request, { action: 'receptionistIntakeField.deleted', resource: 'receptionistIntakeField', resourceId: id });
    return reply.code(204).send();
  });

  app.post('/intake-fields/reorder', { preHandler: writeRoles }, async request => {
    const input = z.object({ campaignId: uuid, orderedIds: z.array(uuid) }).parse(request.body);
    const campaign = await db.receptionistCampaign.findFirst({ where: { id: input.campaignId, tenantId: request.auth.tenantId } });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    await db.$transaction(
      input.orderedIds.map((fieldId, index) =>
        db.receptionistIntakeField.updateMany({
          where: { id: fieldId, tenantId: request.auth.tenantId, campaignId: input.campaignId },
          data: { sortOrder: index },
        }),
      ),
    );
    await audit(request, { action: 'receptionistIntakeField.reordered', resource: 'receptionistCampaign', resourceId: input.campaignId });
    return db.receptionistIntakeField.findMany({
      where: { tenantId: request.auth.tenantId, campaignId: input.campaignId },
      orderBy: { sortOrder: 'asc' },
    });
  });

  // ===== Prompt generation + RetellAI export ==============================
  app.get('/campaigns/:id/prompt', async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await loadCampaign(request.auth.tenantId, id);
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const config = toPromptConfig(campaign as unknown as CampaignWithRelations);
    return {
      systemPrompt: generateSystemPrompt(config),
      samples: generateSamples(config),
    };
  });

  app.get('/campaigns/:id/retell-config', async request => {
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
    contactPhone: z.string().trim().max(40).optional().nullable(),
    contactEmail: z.string().trim().max(160).optional().nullable(),
    channel: z.enum(['VOICE', 'SMS', 'EMAIL', 'ALL']).optional(),
    reason: z.string().trim().max(300).optional().nullable(),
  }).refine(value => value.contactPhone || value.contactEmail, {
    message: 'A phone number or email is required',
  });

  app.get('/opt-outs', { preHandler: callArtifactRead }, async request => {
    return db.receptionistOptOut.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.post('/opt-outs', { preHandler: writeRoles }, async (request, reply) => {
    const input = optOutCreate.parse(request.body);
    const row = await db.receptionistOptOut.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'receptionistOptOut.created', resource: 'receptionistOptOut', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.delete('/opt-outs/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.receptionistOptOut.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Opt-out not found');
    await db.receptionistOptOut.delete({ where: { id } });
    await audit(request, { action: 'receptionistOptOut.deleted', resource: 'receptionistOptOut', resourceId: id });
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
      db.receptionistOptOut.count({ where: { tenantId } }),
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
async function claimWebhookIdempotency(scope: string, key: string, tenantId?: string): Promise<boolean> {
  try {
    await db.idempotencyKey.create({ data: { scope, key, tenantId } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return false;
    throw error;
  }
}

// Retell signs the raw request body with the workspace API key (HMAC-SHA256).
function verifyRetellSignature(rawBody: Buffer | undefined, signature: string | undefined, apiKey: string): boolean {
  if (!rawBody || !signature) return false;
  const expected = createHmac('sha256', apiKey).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
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
  app.post('/webhooks/retell', async (request, reply) => {
    const query = z.object({ clinicId: uuid.optional(), campaignId: uuid.optional() }).parse(request.query);
    const body = z.object({
      event: z.string().optional(),
      call: z.object({
        call_id: z.string().optional(),
        from_number: z.string().optional(),
        to_number: z.string().optional(),
        direction: z.string().optional(),
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
    const signatureHeader = Array.isArray(signatureRaw) ? signatureRaw[0] : signatureRaw;
    if (env.RETELL_API_KEY) {
      if (!verifyRetellSignature(request.rawBody, signatureHeader, env.RETELL_API_KEY)) {
        request.log.warn({ ip: request.ip }, 'Retell webhook signature verification failed');
        return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      }
    } else {
      request.log.error('Retell webhook rejected: RETELL_API_KEY not configured');
      return reply.code(503).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
    }

    // Retell's signature authenticates the exact provider body globally. A
    // persisted opaque call id remains the primary mapping. For the first event
    // of an inbound call only, the signed destination number may bootstrap a
    // tenant when it maps to exactly one active clinic. Outbound `to_number` is
    // the patient destination and is therefore never tenant authority.
    const providerCallId = call.call_id?.trim();
    const callResolution = providerCallId
      ? await resolveIngressTenant('retell_call_id', providerCallId)
      : null;
    const signedDestination = call.direction === 'inbound'
      ? canonicalRetellDestination(call.to_number)
      : null;
    const destinationResolution = !callResolution && providerCallId && signedDestination
      ? await resolveIngressTenant('retell_destination_phone', signedDestination)
      : null;
    const resolved = callResolution ?? destinationResolution;
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

    const endedEvent = body.event === 'call_ended' || body.event === 'call_analyzed';
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
    const isOutbound = Boolean(existingCall?.outboundCampaignId);
    const bookingClaim = outcomeRaw === 'BOOKED' && !isOutbound
      ? await db.idempotencyKey.findFirst({
        where: { tenantId, scope: 'receptionist.live-booking', key: { startsWith: `${providerCallId}:` }, resultId: { not: null } },
        select: { resultId: true },
      })
      : null;
    const canonicalBooking = bookingClaim?.resultId
      ? await db.appointment.findFirst({ where: { id: bookingClaim.resultId, tenantId, deletedAt: null }, select: { id: true } })
      : null;
    // Provider/LLM analysis alone is not proof of a booking. Without the
    // canonical Appointment created by the signed live tool, route to review.
    const normalizedOutcomeRaw = outcomeRaw === 'BOOKED' && !isOutbound && !canonicalBooking ? 'ESCALATED' : outcomeRaw;
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
      const persistedOutcome: CallOutcome = current && outcome === 'IN_PROGRESS' && current.outcome !== 'IN_PROGRESS'
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
      if (await claimWebhookIdempotency('retell.optout', `${tenantId}:${idempotencyAnchor}`, tenantId)) {
        await db.receptionistOptOut.create({
          data: { tenantId, clinicId: trustedClinicId, contactPhone: optOutPhone, contactEmail: typeof custom.email === 'string' ? custom.email : undefined, channel: 'ALL', reason: 'Requested during AI call' },
        });
      }
    }

    if (outcomeRaw === 'BOOKED' && !isOutbound && !canonicalBooking) {
      if (await claimWebhookIdempotency('retell.booking', `${tenantId}:${idempotencyAnchor}`, tenantId)) {
        await db.receptionistAppointmentRequest.create({
          data: {
            tenantId,
            clinicId: trustedClinicId,
            campaignId: trustedCampaignId,
            contactPhone: call.from_number,
            contactName: typeof custom.first_name === 'string' ? custom.first_name : undefined,
            requestedDate: typeof custom.appointment_date === 'string' ? custom.appointment_date : undefined,
            requestedTime: typeof custom.appointment_time === 'string' ? custom.appointment_time : undefined,
            status: 'PENDING',
            collectedData: custom as never,
            source: 'retell',
          },
        });
      }
    }

    // Outbound campaign calls run the booking handoff: link/create patient or
    // lead, create an AppointmentRequest, and book only when safe. The handoff
    // is a no-op for studio (non-outbound) calls and is idempotent on call id.
    if (ended) {
      try {
        const result = await runBookingHandoff(providerCallId, custom);
        if (result.handled && result.reason !== 'duplicate_webhook') {
          request.log.info({ status: result.status }, 'Receptionist booking handoff completed');
        }
      } catch (error) {
        request.log.error({ err: error }, 'Receptionist booking handoff failed');
      }
    }

    return reply.code(200).send({ ok: true });
  });

  // ── Live agent tools (Retell custom functions invoked DURING a call) ──────
  // check_availability / book_appointment. This is a live booking + SMS
  // primitive, so it is signature-verified EXACTLY like the sibling event
  // webhook (never accept an unsigned/invalid call in production) and carries a
  // tight per-route rate limit (the global ceiling is far too loose for a
  // booking primitive). Tenant is resolved from the clinic/campaign on the URL.
  app.post('/webhooks/retell/fn', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
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
        from_number: z.string().max(40).optional(),
        to_number: z.string().max(40).optional(),
        direction: z.enum(['inbound', 'outbound']).optional(),
      }).optional(),
    }).parse(request.body);

    // Signature verification — MIRRORS /webhooks/retell. Reject when the
    // signature is absent/invalid and fail closed when the key is missing.
    const sig = request.headers['x-retell-signature'];
    const sigHeader = Array.isArray(sig) ? sig[0] : sig;
    if (env.RETELL_API_KEY) {
      if (!verifyRetellSignature(request.rawBody, sigHeader, env.RETELL_API_KEY)) {
        request.log.warn({ ip: request.ip }, 'Retell fn webhook signature verification failed');
        return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      }
    } else {
      request.log.error('Retell fn webhook rejected: RETELL_API_KEY not configured');
      return reply.code(503).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
    }

    const providerCallId = body.call?.call_id?.trim();
    const callResolution = providerCallId
      ? await resolveIngressTenant('retell_call_id', providerCallId)
      : null;
    const signedDestination = body.call?.direction === 'inbound'
      ? canonicalRetellDestination(body.call.to_number)
      : null;
    const destinationResolution = !callResolution && providerCallId && signedDestination
      ? await resolveIngressTenant('retell_destination_phone', signedDestination)
      : null;
    const resolved = callResolution ?? destinationResolution;
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
    let trustedClinicId: string | undefined = resolvedByDestination ? resolved.resourceId : undefined;
    if (query.campaignId) {
      const campaign = await db.receptionistCampaign.findFirst({ where: { id: query.campaignId, tenantId }, select: { clinicId: true } });
      if (!campaign || (trustedClinicId && campaign.clinicId !== trustedClinicId) || (query.clinicId && campaign.clinicId !== query.clinicId)) {
        await flagRetellIngressReview(tenantId, providerCallId, 'Signed Retell tool selectors did not match the trusted clinic mapping');
        return reply.code(202).send({ message: "I'm sorry, I can't access this clinic right now." });
      }
      trustedClinicId = campaign.clinicId;
    } else if (query.clinicId) {
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
      const existing = await tx.receptionistCallLog.findFirst({ where: { tenantId, retellCallId: providerCallId } });
      trustedClinicId ??= existing?.clinicId ?? undefined;
      if (!existing) {
        return tx.receptionistCallLog.create({
          data: {
            tenantId,
            clinicId: trustedClinicId,
            retellCallId: providerCallId,
            callerPhone: body.call?.from_number,
            direction: body.call?.direction ?? 'inbound',
            startedAt: new Date(),
          },
        });
      }
      return existing;
    });

    const activeSince = activeCall.startedAt ?? activeCall.createdAt;
    if (activeCall.endedAt || activeCall.outcome !== 'IN_PROGRESS' || activeSince.getTime() < Date.now() - RECEPTIONIST_CALL_LEASE_MS) {
      await flagRetellIngressReview(tenantId, providerCallId, 'Signed Retell tool rejected because the call is ended, terminal, or outside its active lease');
      return reply.code(200).send({ allowed: false, needs_human: true, message: 'This call is no longer active. I cannot access or change patient information.' });
    }

    const SAFE_WITHOUT_RECORDING_GRANT = new Set(['record_recording_preference', 'record_do_not_call', 'request_human_handoff', 'take_message', 'report_emergency', 'check_availability']);
    if (!SAFE_WITHOUT_RECORDING_GRANT.has(body.name)) {
      const callState = await db.receptionistCallLog.findFirst({ where: { tenantId, retellCallId: providerCallId }, select: { recordingConsentStatus: true } });
      if (callState?.recordingConsentStatus !== 'GRANTED') {
        return reply.code(200).send({ allowed: false, needs_human: true, message: 'I need your explicit agreement to the opening disclosure before I can access or change patient information. I can connect you with staff instead.' });
      }
    }

    const result = await handleAgentTool(
      {
        tenantId,
        callId: providerCallId,
        callerPhone: (body.call?.direction === 'outbound' ? body.call.to_number : body.call?.from_number) ?? null,
      },
      body.name,
      body.args,
    );
    return reply.code(200).send(result);
  });
};
