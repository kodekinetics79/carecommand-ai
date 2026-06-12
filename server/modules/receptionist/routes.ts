import type { FastifyPluginAsync } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { requireRoles } from '../../plugins/roles';
import {
  generateSystemPrompt,
  generateSamples,
  buildRetellConfig,
  type PromptConfig,
  type PromptIntakeField,
  type PromptBookingRules,
} from './promptService';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const writeRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');

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
  // ===== Clinics ==========================================================
  const clinicCreate = z.object({
    name: z.string().trim().min(2).max(160),
    phone: z.string().trim().min(3).max(40),
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
  app.get('/appointment-requests', async request => {
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
  app.get('/call-logs', async request => {
    const query = z.object({
      clinicId: uuid.optional(),
      campaignId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    return db.receptionistCallLog.findMany({
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

  app.get('/opt-outs', async request => {
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
    let tenantId: string | undefined;
    if (query.campaignId) {
      const campaign = await db.receptionistCampaign.findUnique({ where: { id: query.campaignId }, select: { tenantId: true, clinicId: true } });
      tenantId = campaign?.tenantId;
    } else if (query.clinicId) {
      const clinic = await db.receptionistClinic.findUnique({ where: { id: query.clinicId }, select: { tenantId: true } });
      tenantId = clinic?.tenantId;
    }

    // Signature verification — never accept unsigned production webhooks.
    const signatureRaw = request.headers['x-retell-signature'];
    const signatureHeader = Array.isArray(signatureRaw) ? signatureRaw[0] : signatureRaw;
    if (env.RETELL_API_KEY) {
      if (!verifyRetellSignature(request.rawBody, signatureHeader, env.RETELL_API_KEY)) {
        request.log.warn({ ip: request.ip, clinicId: query.clinicId, campaignId: query.campaignId }, 'Retell webhook signature verification failed');
        if (tenantId) {
          await db.auditEvent.create({
            data: {
              tenantId,
              action: 'receptionist.webhook.verification_failed',
              resource: 'receptionistWebhook',
              ipAddress: request.ip,
              userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined,
              metadata: { clinicId: query.clinicId ?? null, campaignId: query.campaignId ?? null },
            },
          });
        }
        return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      }
    } else if (env.NODE_ENV === 'production') {
      request.log.error('Retell webhook rejected: RETELL_API_KEY not configured in production');
      return reply.code(503).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
    } else {
      request.log.warn('Retell webhook accepted WITHOUT verification (non-production; set RETELL_API_KEY to enforce)');
    }

    if (!tenantId) return reply.code(202).send({ ok: true, ignored: true });

    const analysis = call.call_analysis ?? {};
    const custom = (analysis.custom_analysis_data ?? {}) as Record<string, unknown>;
    const outcomeRaw = String(custom.outcome ?? '').toUpperCase();
    const validOutcomes = ['BOOKED', 'NOT_INTERESTED', 'NO_ANSWER', 'VOICEMAIL', 'ESCALATED', 'OPTED_OUT', 'FAILED'];
    const outcome = validOutcomes.includes(outcomeRaw) ? (outcomeRaw as never) : ('IN_PROGRESS' as never);

    const durationSeconds = call.duration_ms ? Math.round(call.duration_ms / 1000) : 0;
    const ended = body.event === 'call_ended' || body.event === 'call_analyzed';
    const existingCall = call.call_id
      ? await db.receptionistCallLog.findFirst({ where: { retellCallId: call.call_id, tenantId } })
      : null;

    if (existingCall) {
      await db.receptionistCallLog.update({
        where: { id: existingCall.id },
        data: {
          outcome,
          recordingUrl: call.recording_url,
          transcriptSummary: analysis.call_summary,
          sentiment: analysis.user_sentiment,
          durationSeconds,
          endedAt: ended ? new Date() : undefined,
        },
      });
    } else {
      await db.receptionistCallLog.create({
        data: {
          tenantId,
          clinicId: query.clinicId,
          campaignId: query.campaignId,
          retellCallId: call.call_id,
          callerPhone: call.from_number,
          direction: call.direction ?? 'outbound',
          outcome,
          recordingUrl: call.recording_url,
          transcriptSummary: analysis.call_summary,
          sentiment: analysis.user_sentiment,
          durationSeconds,
          startedAt: new Date(),
          endedAt: ended ? new Date() : undefined,
        },
      });
    }

    // Opt-out and booking writes are guarded by the call id so webhook
    // redelivery cannot create duplicate records.
    const idempotencyAnchor = call.call_id ?? `${call.from_number ?? 'unknown'}:${body.event ?? 'event'}`;

    if (outcome === 'OPTED_OUT' && (call.from_number || custom.email)) {
      if (await claimWebhookIdempotency('retell.optout', `${tenantId}:${idempotencyAnchor}`, tenantId)) {
        await db.receptionistOptOut.create({
          data: { tenantId, clinicId: query.clinicId, contactPhone: call.from_number, contactEmail: typeof custom.email === 'string' ? custom.email : undefined, channel: 'ALL', reason: 'Requested during AI call' },
        });
      }
    }

    if (outcome === 'BOOKED') {
      if (await claimWebhookIdempotency('retell.booking', `${tenantId}:${idempotencyAnchor}`, tenantId)) {
        await db.receptionistAppointmentRequest.create({
          data: {
            tenantId,
            clinicId: query.clinicId,
            campaignId: query.campaignId,
            contactPhone: call.from_number,
            contactName: typeof custom.first_name === 'string' ? custom.first_name : undefined,
            requestedDate: typeof custom.appointment_date === 'string' ? custom.appointment_date : undefined,
            requestedTime: typeof custom.appointment_time === 'string' ? custom.appointment_time : undefined,
            status: 'CONFIRMED',
            collectedData: custom as never,
            source: 'retell',
          },
        });
      }
    }

    return reply.code(200).send({ ok: true });
  });
};
