import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signRetell } from './helpers/retellSignature';

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
const { compileIntakeContract, fingerprintJson } = await import('../modules/receptionist/intakeContract');

let app: FastifyInstance;
const tenantIds: string[] = [];
const RETELL_KEY = 'signed-outbound-booking-test-key';
const originalRetell = {
  apiKey: env.RETELL_API_KEY,
  fromNumber: env.RETELL_FROM_NUMBER,
  baseUrl: env.RETELL_BASE_URL,
};

function phoneFor(id: string): string {
  const digits = BigInt(`0x${id.replaceAll('-', '').slice(0, 14)}`) % 9_000_000_000n;
  return `+1${(digits + 1_000_000_000n).toString().slice(-10)}`;
}

function quietWindowOutsideNow(): { quietHoursStart: string; quietHoursEnd: string } {
  const now = new Date();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const format = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return { quietHoursStart: format((minute + 60) % 1440), quietHoursEnd: format((minute + 61) % 1440) };
}

function auth(tenantId: string, userId: string) {
  return { authorization: `Bearer ${app.jwt.sign({ userId, tenantId, role: 'ADMIN', type: 'access' })}` };
}

function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  env.RETELL_API_KEY = RETELL_KEY;
  env.RETELL_FROM_NUMBER = '+15550000001';
  env.RETELL_BASE_URL = 'https://retell.signed-booking.test';
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  vi.unstubAllGlobals();
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('outbound receptionist to signed canonical booking', () => {
  it('binds the launched outbound call to its attested Studio tool and creates one canonical appointment', async () => {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await db.tenant.create({ data: { id: tenantId, name: `Signed ${tenantId.slice(0, 6)}`, slug: `signed-${tenantId.slice(0, 8)}` } });
    await db.tenantFeatureEntitlement.create({ data: { tenantId, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
    const branch = await db.branch.create({ data: { tenantId, name: 'Canonical Front Desk', location: '1 Pilot Way', timezone: 'UTC', active: true } });
    const admin = await db.user.create({ data: {
      tenantId, branchId: branch.id, role: 'ADMIN', active: true,
      email: `admin-${tenantId.slice(0, 8)}@signed.test`, displayName: 'Pilot Admin',
    } });
    const providerUser = await db.user.create({ data: {
      tenantId, branchId: branch.id, role: 'PROVIDER', active: true,
      email: `provider-${tenantId.slice(0, 8)}@signed.test`, displayName: 'Dr. Exact',
    } });
    const provider = await db.providerProfile.create({ data: {
      tenantId, branchId: branch.id, userId: providerUser.id, specialty: 'Primary Care',
    } });
    await db.providerAvailability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      tenantId, branchId: branch.id, providerProfileId: provider.id, dayOfWeek,
      startMinute: 540, endMinute: 1020, slotMinutes: 30,
    })) });
    const patientPhone = phoneFor(tenantId);
    const patient = await db.patient.create({ data: {
      tenantId, branchId: branch.id, firstName: 'Outbound', lastName: 'Patient',
      phone: patientPhone, dateOfBirth: new Date('1990-01-02T00:00:00.000Z'), lifecycleStage: 'ACTIVE', tags: [],
    } });
    const clinicPhone = `+1${(BigInt(`0x${tenantId.replaceAll('-', '').slice(0, 14)}`) % 9_000_000_000n + 1_000_000_000n).toString().slice(-10)}`;
    const clinic = await db.receptionistClinic.create({ data: {
      tenantId, name: 'Pilot Clinic', phone: clinicPhone, timezone: 'UTC', country: 'US', defaultLanguage: 'en-US',
    } });
    const location = await db.receptionistLocation.create({ data: {
      tenantId, clinicId: clinic.id, branchId: branch.id, name: 'Canonical Front Desk',
      address: '1 Pilot Way', active: true,
    } });

    const studioCampaignId = randomUUID();
    const appointmentType = 'Consultation';
    const contract = compileIntakeContract({
      campaignId: studioCampaignId,
      revision: 1,
      appointmentType,
      eligibleLocations: [{ id: location.id, name: location.name }],
      fields: [],
      toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${clinic.id}&campaignId=${studioCampaignId}`,
    });
    const providerAgentId = `agent_${tenantId.replaceAll('-', '')}`;
    const responseEngineId = `llm_${tenantId.replaceAll('-', '')}`;
    const responseGraphFingerprint = 'a'.repeat(64);
    const providerToolFingerprint = fingerprintJson({
      tool: contract.snapshot.bookAppointmentToolContract,
      engine: { type: 'retell-llm', id: responseEngineId, version: 1, graphFingerprint: responseGraphFingerprint },
    });
    const attestedSnapshot = { ...contract.snapshot, providerEffectiveDynamicVariables: {} };
    const attestedAt = new Date();
    const agent = await db.receptionistAgent.create({ data: {
      tenantId, clinicId: clinic.id, name: 'Avery', active: true,
      providerAgentId, providerVersionTag: 'prod', providerVersion: 1,
      providerStatus: 'VERIFIED', providerPublished: true, providerAssignedTags: ['prod'], providerFingerprint: 'b'.repeat(64),
      providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
      providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
      providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
      providerResponseEngineType: 'retell-llm', providerResponseEngineId: responseEngineId,
      providerResponseEngineVersion: 1, providerResponseEngineGraphFingerprint: responseGraphFingerprint,
      providerEffectiveDynamicVariables: {}, providerBookToolSchema: contract.snapshot.bookAppointmentToolContract as never,
      providerBookToolFingerprint: providerToolFingerprint, providerToolCallStrictMode: true,
      providerConfigRevision: 1, providerVerifiedRevision: 1, providerVerifiedAt: attestedAt,
      providerVerificationExpiresAt: new Date(attestedAt.getTime() + 60 * 60 * 1_000),
    } });
    await db.receptionistCampaign.create({ data: {
      id: studioCampaignId, tenantId, clinicId: clinic.id, agentId: agent.id,
      name: 'Signed outbound booking authority', status: 'ACTIVE',
      offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Offer an appointment.',
      appointmentType, eligibleLocationIds: [location.id], intakeSchemaRevision: 1,
      intakeSchemaSnapshot: attestedSnapshot as never, intakeSchemaFingerprint: fingerprintJson(attestedSnapshot),
      intakeToolFingerprint: providerToolFingerprint, intakeSchemaAttestedRevision: 1, intakeSchemaAttestedAt: attestedAt,
      intakeSchemaProviderAgentId: providerAgentId, intakeSchemaProviderVersion: 1,
      intakeSchemaResponseEngineId: responseEngineId, intakeSchemaResponseEngineVersion: 1,
    } });

    const quiet = quietWindowOutsideNow();
    const outboundCreated = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: auth(tenantId, admin.id),
      payload: {
        clinicId: clinic.id, agentId: agent.id, receptionistCampaignId: studioCampaignId,
        name: 'Direct booking pilot', script: 'Offer an appointment.',
        purpose: 'CARE_COORDINATION', legalBasis: 'TREATMENT_OPERATIONS', policyVersion: 'SIGNED-PILOT-1',
        bookingMode: 'DIRECT_BOOKING_IF_SLOT_AVAILABLE', defaultBranchId: branch.id,
        defaultService: appointmentType, requiredFields: ['firstName', 'lastName', 'phone'], ...quiet,
      },
    });
    expect(outboundCreated.statusCode).toBe(201);
    const outboundCampaignId = (outboundCreated.json() as { id: string }).id;
    const approved = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${outboundCampaignId}/approve`, headers: auth(tenantId, admin.id),
      payload: { approvalConfirmed: true, status: 'RUNNING' },
    });
    expect(approved.statusCode).toBe(200);
    const targetAdded = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${outboundCampaignId}/targets`, headers: auth(tenantId, admin.id),
      payload: { targets: [{ patientId: patient.id, phone: patientPhone, firstName: patient.firstName, lastName: patient.lastName }] },
    });
    expect(targetAdded.statusCode).toBe(201);
    const target = await db.receptionistCallTarget.findFirstOrThrow({ where: { tenantId, campaignId: outboundCampaignId, patientId: patient.id } });

    const providerCallId = `retell_signed_${randomUUID()}`;
    const providerFetch = vi.fn<typeof fetch>(async url => String(url).includes('/v2/create-phone-call')
      ? new Response(JSON.stringify({ call_id: providerCallId, agent_id: providerAgentId, agent_version: 1 }), {
        status: 201, headers: { 'content-type': 'application/json' },
      })
      : new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', providerFetch);
    const launched = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${outboundCampaignId}/call`, headers: auth(tenantId, admin.id),
      payload: { targetId: target.id, phone: patientPhone },
    });
    expect(launched.statusCode).toBe(201);
    expect(launched.json()).toMatchObject({ status: 'launched', callId: providerCallId, trackingDegraded: false });
    expect(providerFetch).toHaveBeenCalledTimes(1);

    const signedCall = {
      call_id: providerCallId, agent_id: providerAgentId, agent_version: 1,
      from_number: env.RETELL_FROM_NUMBER, to_number: patientPhone, direction: 'outbound',
    };
    const invokeSignedTool = (name: string, args: Record<string, unknown>) => {
      const raw = JSON.stringify({ name, args, call: signedCall });
      return app.inject({
        method: 'POST',
        url: `/v1/receptionist/webhooks/retell/fn?clinicId=${clinic.id}&campaignId=${studioCampaignId}`,
        headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) },
        payload: raw,
      });
    };
    const recordingConsent = await invokeSignedTool('record_recording_preference', {
      recording_decision: 'GRANTED', jurisdiction: 'NY',
    });
    expect(recordingConsent.statusCode).toBe(200);
    expect(recordingConsent.json()).toMatchObject({ recorded: true });

    const identity = await invokeSignedTool('verify_patient_identity', { date_of_birth: '1990-01-02' });
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toMatchObject({ verified: true });
    const identityReplay = await invokeSignedTool('verify_patient_identity', { date_of_birth: '1990-01-02' });
    expect(identityReplay.statusCode).toBe(200);
    expect(identityReplay.json()).toEqual(identity.json());
    expect(await db.auditEvent.count({ where: { tenantId, action: 'receptionist.identity.verified', resourceId: providerCallId } })).toBe(1);

    const booked = await invokeSignedTool('book_appointment', {
      first_name: patient.firstName,
      last_name: patient.lastName,
      appointment_date: futureDate(5),
      appointment_time: '10:00',
      service: appointmentType,
      location_id: location.id,
      intake_contract_fingerprint: contract.snapshot.semanticFingerprint,
      intake_schema_revision: 1,
      booking_confirmed: true,
    });
    expect(booked.statusCode).toBe(200);
    expect(booked.json().booked, JSON.stringify(booked.json())).toBe(true);
    expect(booked.json()).toMatchObject({
      booked: true,
      location_name: branch.name,
      location_address: branch.location,
      provider_name: providerUser.displayName,
      timezone: branch.timezone,
      service: appointmentType,
    });
    expect(booked.json().message).toContain(branch.name);
    expect(booked.json().message).toContain(providerUser.displayName);

    const callLogId = (launched.json() as { callLogId: string }).callLogId;
    const appointment = await db.appointment.findFirstOrThrow({ where: { tenantId, receptionistCallLogId: callLogId } });
    expect(appointment).toMatchObject({
      id: booked.json().appointment_id,
      patientId: patient.id,
      providerProfileId: provider.id,
      branchId: branch.id,
      service: appointmentType,
    });
    expect(await db.appointmentRequest.findFirstOrThrow({ where: { tenantId, callLogId } })).toMatchObject({
      status: 'BOOKED', bookedAppointmentId: appointment.id,
    });
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } })).toMatchObject({
      retellCallId: providerCallId,
      outboundCampaignId,
      campaignId: studioCampaignId,
      targetId: target.id,
      outcome: 'BOOKED',
    });
    expect(await db.receptionistOutboundProviderIntent.findFirstOrThrow({ where: { tenantId, callLogId } })).toMatchObject({
      outboundCampaignId,
      targetId: target.id,
      purpose: 'CARE_COORDINATION',
      policyVersion: 'SIGNED-PILOT-1',
    });
  }, 60_000);
});
