import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { env } = await import('../config/env');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { fingerprintJson } = await import('../modules/receptionist/intakeContract');

let app: FastifyInstance;
const tenantIds: string[] = [];

function phoneFor(seed: string, suffix = 0): string {
  const digits = BigInt(`0x${seed.replaceAll('-', '').slice(0, 14)}`) % 9_000_000_000n;
  return `+1${(digits + 1_000_000_000n + BigInt(suffix)).toString().slice(-10)}`;
}

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Workforce ${id.slice(0, 6)}`, slug: `workforce-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main branch', location: 'Virginia', timezone: 'America/New_York' } });
  const owner = await db.user.create({ data: {
    tenantId: id, branchId: branch.id, role: 'OWNER', active: true,
    email: `owner-${id.slice(0, 8)}@workforce.test`, displayName: 'Workforce Owner',
  } });
  const clinic = await db.receptionistClinic.create({ data: {
    tenantId: id, name: 'Bright Synthetic Health', phone: phoneFor(id), timezone: 'America/New_York', country: 'US', defaultLanguage: 'en-US', active: true,
  } });
  const now = new Date();
  const providerResponseEngineId = `llm_${id.replaceAll('-', '')}`;
  const providerBookToolSchema = { name: 'book_appointment', parameters: { type: 'object', properties: {} } };
  const providerBookToolFingerprint = fingerprintJson({
    tool: providerBookToolSchema,
    engine: { type: 'retell-llm', id: providerResponseEngineId, version: 1, graphFingerprint: 'a'.repeat(64) },
  });
  const agent = await db.receptionistAgent.create({ data: {
    tenantId: id,
    clinicId: clinic.id,
    name: 'Workforce receptionist',
    providerAgentId: `agent_${id.replaceAll('-', '')}`,
    providerVersion: 1,
    providerVersionTag: 'prod',
    providerStatus: 'VERIFIED',
    providerPublished: true,
    providerAssignedTags: ['prod'],
    providerFingerprint: 'c'.repeat(64),
    providerConfigRevision: 1,
    providerVerifiedRevision: 1,
    providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
    providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
    providerDataStorageSetting: 'basic_attributes_only',
    providerSignedUrl: true,
    providerResponseEngineType: 'retell-llm',
    providerResponseEngineId,
    providerResponseEngineVersion: 1,
    providerResponseEngineGraphFingerprint: 'a'.repeat(64),
    providerEffectiveDynamicVariables: {},
    providerBookToolSchema,
    providerBookToolFingerprint,
    providerToolCallStrictMode: true,
    providerVerifiedAt: now,
    providerVerificationExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    active: true,
  } });
  await db.receptionistLocation.create({ data: {
    tenantId: id, clinicId: clinic.id, branchId: branch.id,
    name: 'Main clinic', address: '1 Synthetic Way', active: true,
  } });
  return { id, branchId: branch.id, clinicId: clinic.id, ownerId: owner.id, agentId: agent.id };
}

function auth(tenant: Awaited<ReturnType<typeof makeTenant>>) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: tenant.ownerId, tenantId: tenant.id, role: 'OWNER', type: 'access' })}` };
}

async function patientWithAppointment(
  tenant: Awaited<ReturnType<typeof makeTenant>>,
  suffix: number,
  startsAt: Date,
  options: { phone?: string; patientConfirmedAt?: Date | null; status?: 'CONFIRMED' | 'RISKY' | 'WAITLIST' } = {},
) {
  const patient = await db.patient.create({ data: {
    tenantId: tenant.id, branchId: tenant.branchId,
    firstName: `Patient${suffix}`, lastName: 'Workforce',
    phone: options.phone ?? phoneFor(tenant.id, suffix), tags: [],
  } });
  const appointment = await db.appointment.create({ data: {
    tenantId: tenant.id, branchId: tenant.branchId, patientId: patient.id,
    service: 'Synthetic consultation', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
    status: options.status ?? 'CONFIRMED', channel: 'CALL', patientConfirmedAt: options.patientConfirmedAt ?? null,
    patientConfirmationSource: options.patientConfirmedAt ? 'staff' : null,
  } });
  return { patient, appointment };
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('AI front-office workforce', () => {
  it('reports real workload without claiming unfinished autonomy is ready', async () => {
    const tenant = await makeTenant();
    await patientWithAppointment(tenant, 1, new Date(Date.now() + 4 * 60 * 60 * 1000));
    await patientWithAppointment(tenant, 2, new Date(Date.now() + 5 * 60 * 60 * 1000), { patientConfirmedAt: new Date() });

    const response = await app.inject({ method: 'GET', url: '/v1/receptionist/workforce/overview', headers: auth(tenant) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.workload.appointmentsNeedingConfirmationNext24h).toBe(1);
    expect(body.workload.appointmentsPatientConfirmedNext24h).toBe(1);
    expect(body.capabilities.inboundAiReceptionist).toEqual(expect.objectContaining({ state: 'ready', readyAgents: 1 }));
    expect(body.capabilities.autonomousOutboundDialer).toEqual(expect.objectContaining({ state: 'building' }));
    expect(body.capabilities.universalConversationalForms).toEqual(expect.objectContaining({ state: 'building' }));
  });

  it('prepares exact patient-to-appointment targets but neither approves nor dials them', async () => {
    const tenant = await makeTenant();
    const earliest = await patientWithAppointment(tenant, 10, new Date(Date.now() + 6 * 60 * 60 * 1000));
    // Family/shared destination: earliest appointment wins this prepared run so
    // the workforce cannot place two calls to one phone in the same campaign.
    await patientWithAppointment(tenant, 11, new Date(Date.now() + 7 * 60 * 60 * 1000), { phone: earliest.patient.phone ?? undefined });
    await patientWithAppointment(tenant, 12, new Date(Date.now() + 8 * 60 * 60 * 1000));
    await patientWithAppointment(tenant, 13, new Date(Date.now() + 10 * 24 * 60 * 60 * 1000));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/receptionist/workforce/appointment-confirmations/prepare',
      headers: auth(tenant),
      payload: { clinicId: tenant.clinicId, horizonHours: 48, maxTargets: 250 },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { campaignId: string; targetsPrepared: number; callsPlaced: number; approvalRequired: boolean; duplicateDestinationSkipped: number };
    expect(body.callsPlaced).toBe(0);
    expect(body.approvalRequired).toBe(true);
    expect(body.targetsPrepared).toBe(2);
    expect(body.duplicateDestinationSkipped).toBe(1);

    const campaign = await db.receptionistOutboundCampaign.findUniqueOrThrow({ where: { id: body.campaignId } });
    expect(campaign.status).toBe('DRAFT');
    expect(campaign.authorityApprovedAt).toBeNull();
    expect(campaign.purpose).toBe('APPOINTMENT_REMINDER');
    expect(campaign.agentId).toBe(tenant.agentId);

    const targets = await db.receptionistCallTarget.findMany({ where: { tenantId: tenant.id, campaignId: body.campaignId }, orderBy: { createdAt: 'asc' } });
    expect(targets).toHaveLength(2);
    expect(targets.every(target => target.patientId && target.appointmentId && target.status === 'PENDING')).toBe(true);
    expect(targets.some(target => target.patientId === earliest.patient.id && target.appointmentId === earliest.appointment.id)).toBe(true);

    expect(await db.receptionistCallLog.count({ where: { tenantId: tenant.id, outboundCampaignId: body.campaignId } })).toBe(0);
    expect(await db.receptionistOutboundProviderIntent.count({ where: { tenantId: tenant.id, outboundCampaignId: body.campaignId } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, resource: 'receptionistOutboundCampaign', resourceId: body.campaignId, action: 'receptionist.workforce.appointmentConfirmationsPrepared' } })).toBe(1);
  });

  it('refuses preparation when the clinic has no ready receptionist', async () => {
    const tenant = await makeTenant();
    await db.receptionistAgent.update({ where: { id: tenant.agentId }, data: { providerStatus: 'UNVERIFIED' } });
    const response = await app.inject({
      method: 'POST', url: '/v1/receptionist/workforce/appointment-confirmations/prepare', headers: auth(tenant),
      payload: { clinicId: tenant.clinicId },
    });
    expect(response.statusCode).toBe(409);
  });
});
