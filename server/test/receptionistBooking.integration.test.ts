import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

// Real booking behavior through the live-agent tools (/webhooks/retell/fn), plus
// the concurrency + cross-path double-booking guard, graceful bad-data handling,
// and the FIX 4 outbound opt-out gate.
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
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { env } = await import('../config/env');
const { compileIntakeContract, fingerprintJson } = await import('../modules/receptionist/intakeContract');

let app: FastifyInstance;
const tenantIds: string[] = [];
const RETELL_KEY = 'test-retell-booking-signature-key';
const originalRetellKey = env.RETELL_API_KEY;
const databaseCleanup: Array<() => Promise<void>> = [];
const phoneFor = (id: string) => `+1${(BigInt(`0x${id.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `bk-${id.slice(0, 6)}`, slug: `bk-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'X', timezone: 'UTC', active: true }, select: { id: true } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@bk.test`, displayName: 'Admin' }, select: { id: true } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@bk.test`, displayName: 'Dr' }, select: { id: true } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care' }, select: { id: true } });
  await db.providerAvailability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ tenantId: id, branchId: branch.id, providerProfileId: provider.id, dayOfWeek, startMinute: 540, endMinute: 1020, slotMinutes: 30 })) });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Roe', lifecycleStage: 'ACTIVE' }, select: { id: true } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Clinic', phone: phoneFor(id) }, select: { id: true } });
  const location = await db.receptionistLocation.create({
    data: { tenantId: id, clinicId: clinic.id, branchId: branch.id, name: 'Main location', address: '1 Test Way', active: true },
    select: { id: true, name: true },
  });
  const campaignId = randomUUID();
  const appointmentType = 'Consultation';
  const contract = compileIntakeContract({
    campaignId, revision: 1, appointmentType, eligibleLocations: [location], fields: [],
    toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${clinic.id}`,
  });
  const providerAgentId = `agent_${id.replaceAll('-', '')}`;
  const providerVersion = 1;
  const providerGraphFingerprint = 'a'.repeat(64);
  const providerToolFingerprint = fingerprintJson({
    tool: contract.snapshot.bookAppointmentToolContract,
    engine: { type: 'retell-llm', id: `llm_${id.replaceAll('-', '')}`, version: 1, graphFingerprint: providerGraphFingerprint },
  });
  const providerEffectiveDynamicVariables = {};
  const attestedSnapshot = { ...contract.snapshot, providerEffectiveDynamicVariables };
  const now = new Date();
  const agent = await db.receptionistAgent.create({ data: {
    tenantId: id, clinicId: clinic.id, name: 'Avery', active: true,
    providerAgentId, providerVersionTag: 'prod', providerVersion,
    providerStatus: 'VERIFIED', providerPublished: true, providerAssignedTags: ['prod'], providerFingerprint: 'b'.repeat(64),
    providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
    providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'], providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
    providerResponseEngineType: 'retell-llm', providerResponseEngineId: `llm_${id.replaceAll('-', '')}`, providerResponseEngineVersion: 1,
    providerResponseEngineGraphFingerprint: providerGraphFingerprint,
    providerEffectiveDynamicVariables,
    providerBookToolSchema: contract.snapshot.bookAppointmentToolContract as never,
    providerBookToolFingerprint: providerToolFingerprint, providerToolCallStrictMode: true,
    providerConfigRevision: 1, providerVerifiedRevision: 1, providerVerifiedAt: now,
    providerVerificationExpiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
  }, select: { id: true } });
  await db.receptionistCampaign.create({ data: {
    id: campaignId, tenantId: id, clinicId: clinic.id, agentId: agent.id,
    name: 'Attested booking campaign', status: 'ACTIVE', offerTitle: 'Appointment', offerDescription: 'Schedule care',
    offerScript: 'Would you like to schedule?', appointmentType, eligibleLocationIds: [location.id], intakeSchemaRevision: 1,
    intakeSchemaSnapshot: attestedSnapshot as never, intakeSchemaFingerprint: fingerprintJson(attestedSnapshot),
    intakeToolFingerprint: providerToolFingerprint, intakeSchemaAttestedRevision: 1, intakeSchemaAttestedAt: now,
    intakeSchemaProviderAgentId: providerAgentId, intakeSchemaProviderVersion: providerVersion,
    intakeSchemaResponseEngineId: `llm_${id.replaceAll('-', '')}`, intakeSchemaResponseEngineVersion: 1,
  } });
  return {
    id, branchId: branch.id, adminId: admin.id, providerUserId: provUser.id, providerId: provider.id, patientId: patient.id, clinicId: clinic.id, clinicPhone: phoneFor(id),
    agentId: agent.id, campaignId, providerAgentId, providerVersion, locationId: location.id, locationName: location.name,
    appointmentType, intakeSchemaRevision: 1, intakeSemanticFingerprint: contract.snapshot.semanticFingerprint,
  };
}
type T = Awaited<ReturnType<typeof makeTenant>>;
const adminAuth = (t: T) => ({ authorization: `Bearer ${app.jwt.sign({ userId: t.adminId, tenantId: t.id, role: 'ADMIN', type: 'access' })}` });
const futureDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function fn(
  t: T,
  name: string,
  args: Record<string, unknown>,
  callId = `c-${randomUUID()}`,
  fromNumber?: string,
  trustedOverrides: Record<string, unknown> = {},
) {
  const existing = await db.receptionistCallLog.findFirst({ where: { tenantId: t.id, retellCallId: callId }, select: { id: true, recordingConsentStatus: true } });
  if (!existing) await db.receptionistCallLog.create({
    data: { tenantId: t.id, clinicId: t.clinicId, campaignId: t.campaignId, retellCallId: callId, callerPhone: fromNumber, direction: 'inbound', outcome: 'IN_PROGRESS' },
  });
  // Booking is a protected operation. Exercise the same signed consent tool
  // that a live agent must call after the opening disclosure instead of
  // mutating fixture state around the production gate.
  if (name === 'book_appointment' && existing?.recordingConsentStatus !== 'GRANTED') {
    const consentRaw = JSON.stringify({
      name: 'record_recording_preference',
      args: { recording_decision: 'GRANTED', jurisdiction: 'test' },
      call: { call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerVersion, from_number: fromNumber, direction: 'inbound' },
    });
    const consent = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/webhooks/retell/fn?clinicId=${t.clinicId}`,
      headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(consentRaw, RETELL_KEY) },
      payload: consentRaw,
    });
    expect(consent.statusCode).toBe(200);
    expect((consent.json() as { recorded?: boolean }).recorded).toBe(true);
  }
  const trustedArgs = name === 'book_appointment' ? {
    ...args,
    service: t.appointmentType,
    location_id: t.locationId,
    intake_contract_fingerprint: t.intakeSemanticFingerprint,
    intake_schema_revision: t.intakeSchemaRevision,
    booking_confirmed: true,
    ...trustedOverrides,
  } : args;
  const raw = JSON.stringify({
    name, args: trustedArgs,
    call: { call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerVersion, from_number: fromNumber, direction: 'inbound' },
  });
  const res = await app.inject({
    method: 'POST',
    url: `/v1/receptionist/webhooks/retell/fn?clinicId=${t.clinicId}`,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) },
    payload: raw,
  });
  return res;
}

async function configureIntake(t: T, fields: Parameters<typeof compileIntakeContract>[0]['fields']) {
  const contract = compileIntakeContract({
    campaignId: t.campaignId,
    revision: t.intakeSchemaRevision,
    appointmentType: t.appointmentType,
    eligibleLocations: [{ id: t.locationId, name: t.locationName }],
    fields,
    toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${t.clinicId}`,
  });
  await db.receptionistCampaign.update({
    where: { id: t.campaignId },
    data: {
      intakeSchemaSnapshot: contract.snapshot as never,
      intakeSchemaFingerprint: contract.fingerprint,
      intakeToolFingerprint: contract.snapshot.bookAppointmentToolFingerprint,
    },
  });
  t.intakeSemanticFingerprint = contract.snapshot.semanticFingerprint;
  return contract;
}

async function createRunnableOutboundTarget(t: T, phone: string) {
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const nowMinutes = (Number(nowParts.find(part => part.type === 'hour')?.value) % 24) * 60
    + Number(nowParts.find(part => part.type === 'minute')?.value);
  const formatMinutes = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  await db.patient.update({ where: { id: t.patientId }, data: { phone } });
  const created = await app.inject({
    method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: adminAuth(t),
    payload: {
      clinicId: t.clinicId, agentId: t.agentId, name: 'Compliance gate', script: 'Call the patient.',
      requiredFields: ['firstName', 'lastName', 'phone'], bookingMode: 'APPOINTMENT_REQUEST_ONLY',
      purpose: 'CARE_COORDINATION', legalBasis: 'TREATMENT_OPERATIONS', policyVersion: 'OUTBOUND-TEST-1',
      quietHoursStart: formatMinutes((nowMinutes + 60) % 1440),
      quietHoursEnd: formatMinutes((nowMinutes + 61) % 1440),
    },
  });
  expect(created.statusCode).toBe(201);
  const campaignId = (created.json() as { id: string }).id;
  const approved = await app.inject({
    method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/approve`, headers: adminAuth(t),
    payload: { approvalConfirmed: true, status: 'RUNNING' },
  });
  expect(approved.statusCode).toBe(200);
  const added = await app.inject({
    method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`, headers: adminAuth(t),
    payload: { targets: [{ patientId: t.patientId, phone, firstName: 'Pat', lastName: 'Roe' }] },
  });
  expect(added.statusCode).toBe(201);
  const target = await db.receptionistCallTarget.findFirstOrThrow({ where: { tenantId: t.id, campaignId, phone } });
  return { campaignId, targetId: target.id };
}

beforeAll(async () => {
  env.RETELL_API_KEY = RETELL_KEY;
  app = await buildApp();
}, 60_000);
afterAll(async () => {
  env.RETELL_API_KEY = originalRetellKey;
  for (const cleanup of databaseCleanup.reverse()) await cleanup().catch(() => {});
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('receptionist /fn booking — real availability + booking', () => {
  it('binds a tool-first call from exact signed deployment and rejects selector/deployment drift', async () => {
    const t = await makeTenant();
    const inject = (callId: string, name: string, args: Record<string, unknown>, call: Record<string, unknown>, campaignId = t.campaignId) => {
      const raw = JSON.stringify({ name, args, call });
      return app.inject({
        method: 'POST', url: `/v1/receptionist/webhooks/retell/fn?clinicId=${t.clinicId}&campaignId=${campaignId}`,
        headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) }, payload: raw,
      });
    };
    const callId = `tool-first-contract-${randomUUID()}`;
    const signedCall = {
      call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerVersion,
      from_number: '+15551235555', to_number: t.clinicPhone, direction: 'inbound',
    };
    expect((await inject(callId, 'record_recording_preference', { recording_decision: 'GRANTED' }, signedCall)).json()).toMatchObject({ recorded: true });
    const exact = await inject(callId, 'book_appointment', {
      first_name: 'Binding', last_name: 'Probe', appointment_date: 'not-a-date', appointment_time: 'noon',
      service: t.appointmentType, intake_contract_fingerprint: t.intakeSemanticFingerprint, intake_schema_revision: 1,
    }, signedCall);
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({ booked: false });
    expect(await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } })).toMatchObject({
      clinicId: t.clinicId, campaignId: t.campaignId,
    });

    const selectorDrift = await inject(callId, 'book_appointment', {
      service: t.appointmentType, intake_contract_fingerprint: t.intakeSemanticFingerprint, intake_schema_revision: 1,
    }, signedCall, randomUUID());
    expect(selectorDrift.json()).toMatchObject({ booked: false, needs_human: true });

    const callerMutation = await inject(callId, 'book_appointment', {
      service: t.appointmentType, intake_contract_fingerprint: t.intakeSemanticFingerprint, intake_schema_revision: 1,
    }, { ...signedCall, from_number: '+15559990000' });
    expect(callerMutation.json()).toMatchObject({ booked: false, needs_human: true });

    const wrongCallId = `wrong-deployment-${randomUUID()}`;
    const wrongCall = { ...signedCall, call_id: wrongCallId, agent_id: 'agent_wrong' };
    expect((await inject(wrongCallId, 'record_recording_preference', { recording_decision: 'GRANTED' }, wrongCall)).statusCode).toBe(200);
    const wrongDeployment = await inject(wrongCallId, 'book_appointment', {
      service: t.appointmentType, intake_contract_fingerprint: t.intakeSemanticFingerprint, intake_schema_revision: 1,
    }, wrongCall);
    expect(wrongDeployment.json()).toMatchObject({ booked: false, needs_human: true });
    expect((await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: wrongCallId } })).campaignId).toBeNull();
  });

  it('hands off when required PHONE identity is missing from the signed persisted call context', async () => {
    const t = await makeTenant();
    const requiredPhoneContract = compileIntakeContract({
      campaignId: t.campaignId, revision: 1, appointmentType: t.appointmentType,
      eligibleLocations: [{ id: t.locationId, name: t.locationName }],
      fields: [{
        id: randomUUID(), fieldType: 'PHONE', label: 'Callback phone', aiQuestion: 'May we use this calling number?',
        options: [], required: true, confirmationRequired: false, sortOrder: 0,
      }],
      toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${t.clinicId}`,
    });
    await db.receptionistCampaign.update({
      where: { id: t.campaignId },
      data: {
        intakeSchemaSnapshot: requiredPhoneContract.snapshot as never,
        intakeSchemaFingerprint: requiredPhoneContract.fingerprint,
      },
    });
    t.intakeSemanticFingerprint = requiredPhoneContract.snapshot.semanticFingerprint;

    const response = await fn(t, 'book_appointment', {
      first_name: 'No', last_name: 'Number', appointment_date: futureDate(3), appointment_time: '09:00',
    }, `required-phone-${randomUUID()}`);

    expect(response.json()).toMatchObject({ booked: false, needs_human: true });
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('uses the branch timezone and canonical catalog duration for offers and booking', async () => {
    const t = await makeTenant();
    await db.branch.update({ where: { id: t.branchId }, data: { timezone: 'America/New_York' } });
    const service = await db.serviceCatalogItem.create({
      data: { tenantId: t.id, name: t.appointmentType, category: 'general', defaultDurationMinutes: 45, active: true },
    });
    const future = new Date(Date.now() + 7 * 86_400_000);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(future);
    const avail = (await fn(t, 'check_availability', { appointment_date: date, service: service.name })).json() as { available: boolean; slots: Array<{ time: string }> };
    expect(avail.available).toBe(true);
    expect(avail.slots[0]?.time).toBe('09:00');

    const booked = (await fn(t, 'book_appointment', {
      first_name: 'Time', last_name: 'Zone', appointment_date: date,
      appointment_time: '09:00', service: service.name,
    }, `tz-${randomUUID()}`, '+15551234444')).json() as { booked: boolean; appointment_id: string };
    expect(booked.booked).toBe(true);
    const appointment = await db.appointment.findUniqueOrThrow({ where: { id: booked.appointment_id } });
    expect(appointment.startsAt.toISOString()).not.toContain('T09:00:00.000Z');
    expect((appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000).toBe(45);
    expect(appointment.serviceCatalogItemId).toBe(service.id);
  });

  it('check_availability returns real open slots and book_appointment creates a real appointment', async () => {
    const t = await makeTenant();
    const date = futureDate(3);
    const avail = (await fn(t, 'check_availability', { appointment_date: date })).json() as { available: boolean; slots: Array<{ time: string; label: string }> };
    expect(avail.available).toBe(true);
    expect(avail.slots.length).toBeGreaterThan(0);
    expect(avail.slots[0]).toHaveProperty('label');

    const slot = avail.slots[0].time;
    const book = (await fn(t, 'book_appointment', { first_name: 'Jane', last_name: 'Doe', appointment_date: date, appointment_time: slot, service: 'Cleaning' }, `c-${randomUUID()}`, '+15551230000')).json() as { booked: boolean; appointment_id?: string };
    expect(book.booked).toBe(true);
    expect(book.appointment_id).toBeTruthy();
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(1);

    const avail2 = (await fn(t, 'check_availability', { appointment_date: date })).json() as { slots: Array<{ time: string }> };
    expect(avail2.slots.some(s => s.time === slot)).toBe(false);
  });

  it('keeps canonical BOOKED immutable across reordered conflicting signed lifecycle events and charges usage once', async () => {
    const t = await makeTenant();
    const callId = `canonical-lifecycle-${randomUUID()}`;
    const caller = '+15551230123';
    const date = futureDate(6);
    const booked = (await fn(t, 'book_appointment', {
      first_name: 'Canonical', last_name: 'Booking', appointment_date: date, appointment_time: '09:00',
    }, callId, caller)).json() as { booked: boolean; appointment_id?: string };
    expect(booked.booked).toBe(true);

    const lifecycle = (event: 'call_ended' | 'call_analyzed', outcome: 'FAILED' | 'NOT_INTERESTED') => {
      const raw = JSON.stringify({
        event,
        call: {
          call_id: callId, direction: 'inbound', from_number: caller, to_number: t.clinicPhone, duration_ms: 61_000,
          call_analysis: { custom_analysis_data: { outcome } },
        },
      });
      return app.inject({
        method: 'POST', url: `/v1/receptionist/webhooks/retell?clinicId=${t.clinicId}`,
        headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) }, payload: raw,
      });
    };

    expect((await lifecycle('call_ended', 'FAILED')).statusCode).toBe(200);
    expect((await lifecycle('call_analyzed', 'NOT_INTERESTED')).statusCode).toBe(200);

    expect(await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } })).toMatchObject({
      outcome: 'BOOKED', durationSeconds: 61,
    });
    expect(await db.appointment.count({ where: { tenantId: t.id, receptionistCallLogId: { not: null } } })).toBe(1);
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id, callLogId: { not: null } } })).toBe(1);
    expect(await db.tenantAiUsage.findUniqueOrThrow({ where: { tenantId: t.id } })).toMatchObject({ receptionistMinutes: 2 });
    expect(await db.tenantUsageLimit.findUniqueOrThrow({ where: { tenantId_key: { tenantId: t.id, key: 'voice_minutes' } } })).toMatchObject({ used: 2 });
  });

  it('two concurrent bookings for the SAME slot → exactly one succeeds (advisory-lock guard)', async () => {
    const t = await makeTenant();
    const date = futureDate(4);
    const avail = (await fn(t, 'check_availability', { appointment_date: date })).json() as { slots: Array<{ time: string }> };
    const slot = avail.slots[0].time;

    const [r1, r2] = await Promise.all([
      fn(t, 'book_appointment', { first_name: 'A', last_name: 'One', appointment_date: date, appointment_time: slot }, `call-one-${randomUUID()}`, '+15551110001'),
      fn(t, 'book_appointment', { first_name: 'B', last_name: 'Two', appointment_date: date, appointment_time: slot }, `call-two-${randomUUID()}`, '+15551110002'),
    ]);
    const results = [r1.json(), r2.json()] as Array<{ booked: boolean; message: string }>;
    const winners = results.filter(r => r.booked === true);
    const losers = results.filter(r => r.booked === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].message).toMatch(/taken|unavailable|another time/i); // graceful, speakable
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(1);
  });

  it('an appointment booked via the scheduling API blocks the AI from the same slot (canonical guard)', async () => {
    const t = await makeTenant();
    const date = futureDate(5);
    const startsAt = `${date}T10:00:00.000Z`;
    const endsAt = `${date}T10:30:00.000Z`;

    // Booked via the canonical scheduling/staff API (with the provider FK).
    const staff = await app.inject({
      method: 'POST', url: '/v1/appointments', headers: adminAuth(t),
      payload: { branchId: t.branchId, patientId: t.patientId, providerProfileId: t.providerId, service: 'Checkup', startsAt, endsAt, channel: 'EMAIL' },
    });
    expect(staff.statusCode).toBe(201);

    // The AI no longer offers 10:00...
    const avail = (await fn(t, 'check_availability', { appointment_date: date })).json() as { slots: Array<{ time: string }> };
    expect(avail.slots.some(s => s.time === '10:00')).toBe(false);

    // ...and refuses to book it, gracefully.
    const book = (await fn(t, 'book_appointment', { first_name: 'Late', last_name: 'Caller', appointment_date: date, appointment_time: '10:00' }, `c-${randomUUID()}`, '+15551119999')).json() as { booked: boolean; message: string };
    expect(book.booked).toBe(false);
    expect(book.message).toMatch(/taken|unavailable|another time/i);
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(1); // only the scheduling-API one
  });

  it('malformed date/time degrades to an appointment-request-needing-review (never crashes, never books nonsense)', async () => {
    const t = await makeTenant();
    const res = await fn(t, 'book_appointment', { first_name: 'Bad', last_name: 'Data', appointment_date: 'sometime next week', appointment_time: 'noon', service: 'Cleaning' }, `c-${randomUUID()}`, '+15551112222');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { booked: boolean; needs_review?: boolean; appointment_request_id?: string };
    expect(body.booked).toBe(false);
    expect(body.needs_review).toBe(true);
    expect(body.appointment_request_id).toBeTruthy();

    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0); // nothing booked
    const review = await db.appointmentRequest.findMany({ where: { tenantId: t.id } });
    expect(review).toHaveLength(1);
    expect(review[0].status).toBe('MISSING_INFO');
    expect(review[0].collectedPhone).toBe('+15551112222'); // bound to the verified caller
  });

  it('requires an explicit REJECTED review action, idempotently emits one event, and never reopens to BOOKED', async () => {
    const t = await makeTenant();
    const callId = `staff-review-${randomUUID()}`;
    const reviewResponse = await fn(t, 'book_appointment', {
      first_name: 'Staff', last_name: 'Review', appointment_date: 'invalid', appointment_time: 'later',
    }, callId, '+15551113333');
    const requestId = (reviewResponse.json() as { appointment_request_id: string }).appointment_request_id;
    const reviewUsers = await Promise.all((['FRONT_DESK', 'BILLING', 'AUDITOR'] as const).map(role => db.user.create({ data: {
      tenantId: t.id, role, active: true,
      email: `reject-${role.toLowerCase()}-${t.id.slice(0, 8)}@bk.test`, displayName: role,
    } })));
    const reviewAuth = (index: number) => ({ authorization: `Bearer ${app.jwt.sign({
      userId: reviewUsers[index].id, tenantId: t.id, role: reviewUsers[index].role, type: 'access',
    })}` });
    const providerAuth = { authorization: `Bearer ${app.jwt.sign({
      userId: t.providerUserId, tenantId: t.id, role: 'PROVIDER', type: 'access',
    })}` };
    for (const headers of [providerAuth, reviewAuth(1), reviewAuth(2)]) {
      const denied = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/booking-requests/${requestId}`, headers,
        payload: { status: 'REJECTED', outcomeReason: 'Caller requested cancellation' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ permission: 'receptionist:booking-review' });
    }
    const reasonOnly = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/booking-requests/${requestId}`, headers: adminAuth(t),
      payload: { outcomeReason: 'Caller requested cancellation' },
    });
    expect(reasonOnly.statusCode).toBe(400);

    const reject = () => app.inject({
      method: 'PATCH', url: `/v1/receptionist/booking-requests/${requestId}`, headers: reviewAuth(0),
      payload: { status: 'REJECTED', outcomeReason: 'Caller requested cancellation' },
    });
    const [first, replay] = await Promise.all([reject(), reject()]);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'receptionist.appointmentRequest.reviewTransitioned', resourceId: requestId } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: t.id, eventType: 'receptionist.appointmentRequest.reviewTransitioned', entityId: requestId } })).toBe(1);

    const conflict = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/booking-requests/${requestId}`, headers: adminAuth(t),
      payload: { status: 'REJECTED', outcomeReason: 'Different terminal reason' },
    });
    expect(conflict.statusCode).toBe(409);

    const retryBooking = await fn(t, 'book_appointment', {
      first_name: 'Staff', last_name: 'Review', appointment_date: futureDate(8), appointment_time: '09:00',
    }, callId, '+15551113333');
    expect(retryBooking.json()).toMatchObject({ booked: false, needs_human: true });
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
    expect((await db.appointmentRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('REJECTED');
    const startsAt = new Date(`${futureDate(9)}T14:00:00.000Z`);
    const appointment = await db.appointment.create({ data: {
      tenantId: t.id, branchId: t.branchId, patientId: t.patientId,
      providerProfileId: t.providerId, providerRef: t.providerId, service: t.appointmentType,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status: 'CONFIRMED', channel: 'EMAIL',
    } });
    const terminalReconcile = await app.inject({
      method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers: adminAuth(t),
      payload: { appointmentId: appointment.id, outcomeReason: 'Attempted after terminal rejection.', acknowledgeRequestDifferences: true },
    });
    expect(terminalReconcile.statusCode).toBe(409);
  });

  it.each(['appointment_source_call', 'verified_call_identity'] as const)(
    'accepts the narrow %s durable identity proof for an otherwise unbound review request',
    async proof => {
      const t = await makeTenant();
      const callId = `${proof}-${randomUUID()}`;
      const review = await fn(t, 'book_appointment', {
        first_name: 'Identity', last_name: 'Proof', appointment_date: 'invalid', appointment_time: 'later',
      }, callId, '+15551116666');
      const requestId = (review.json() as { appointment_request_id: string }).appointment_request_id;
      const request = await db.appointmentRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(request.patientId).toBeNull();
      expect(request.callLogId).toBeTruthy();
      const startsAt = new Date(`${futureDate(12)}T15:00:00.000Z`);
      const appointment = await db.appointment.create({ data: {
        tenantId: t.id, branchId: t.branchId, patientId: t.patientId,
        providerProfileId: t.providerId, providerRef: t.providerId, service: t.appointmentType,
        startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status: 'CONFIRMED', channel: 'EMAIL',
        ...(proof === 'appointment_source_call' ? { receptionistCallLogId: request.callLogId } : {}),
      } });
      if (proof === 'verified_call_identity') {
        await db.idempotencyKey.create({ data: {
          tenantId: t.id, scope: 'receptionist.voice-identity', key: `${t.id}:${callId}`, resultId: t.patientId,
        } });
      }
      const response = await app.inject({
        method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers: adminAuth(t),
        payload: {
          appointmentId: appointment.id,
          outcomeReason: `Front desk used ${proof} evidence after reviewing the caller request.`,
          acknowledgeRequestDifferences: true,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'BOOKED', appointmentId: appointment.id });
      const audit = await db.auditEvent.findFirstOrThrow({
        where: { tenantId: t.id, action: 'receptionist.appointmentRequest.reconciledToCanonicalAppointment', resourceId: requestId },
      });
      expect(audit.metadata).toMatchObject({ identityProof: proof });
    },
  );

  it('reconciles a review only to one exact canonical provider-backed appointment with atomic audit evidence', async () => {
    const t = await makeTenant();
    const other = await makeTenant();
    const callId = `staff-schedule-${randomUUID()}`;
    const review = await fn(t, 'book_appointment', {
      first_name: 'Schedule', last_name: 'Review', appointment_date: 'invalid', appointment_time: 'later',
    }, callId, '+15551114444');
    const requestId = (review.json() as { appointment_request_id: string }).appointment_request_id;
    const startsAt = new Date(`${futureDate(7)}T14:00:00.000Z`);
    const appointment = await db.appointment.create({ data: {
      tenantId: t.id, branchId: t.branchId, patientId: t.patientId,
      providerProfileId: t.providerId, providerRef: t.providerId, service: t.appointmentType,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status: 'CONFIRMED', channel: 'EMAIL',
    } });
    const foreignAppointment = await db.appointment.create({ data: {
      tenantId: other.id, branchId: other.branchId, patientId: other.patientId,
      providerProfileId: other.providerId, providerRef: other.providerId, service: other.appointmentType,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status: 'CONFIRMED', channel: 'EMAIL',
    } });
    const otherPatient = await db.patient.create({ data: {
      tenantId: t.id, branchId: t.branchId, firstName: 'Different', lastName: 'Patient', lifecycleStage: 'ACTIVE',
    } });
    const patientMismatch = await db.appointment.create({ data: {
      tenantId: t.id, branchId: t.branchId, patientId: otherPatient.id,
      providerProfileId: t.providerId, providerRef: t.providerId, service: t.appointmentType,
      startsAt: new Date(startsAt.getTime() + 60 * 60_000), endsAt: new Date(startsAt.getTime() + 90 * 60_000), status: 'CONFIRMED', channel: 'EMAIL',
    } });
    const unboundUnrelated = await app.inject({
      method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers: adminAuth(t),
      payload: {
        appointmentId: patientMismatch.id,
        outcomeReason: 'Attempted same-tenant same-branch unrelated patient reconciliation.',
        acknowledgeRequestDifferences: true,
      },
    });
    expect(unboundUnrelated.statusCode).toBe(409);
    expect(unboundUnrelated.json().message).toMatch(/durable patient identity proof/i);
    const requestedDateTime = new Date(startsAt.getTime() - 24 * 60 * 60_000);
    await db.appointmentRequest.update({
      where: { id: requestId },
      data: { patientId: t.patientId, requestedService: 'Requested intake service', requestedDateTime },
    });
    const secondBranch = await db.branch.create({ data: { tenantId: t.id, name: 'Other branch', location: 'Y', timezone: 'UTC', active: true } });
    const secondProviderUser = await db.user.create({ data: {
      tenantId: t.id, role: 'PROVIDER', active: true, email: `other-provider-${t.id.slice(0, 8)}@bk.test`, displayName: 'Dr Other',
    } });
    const secondProvider = await db.providerProfile.create({ data: { tenantId: t.id, branchId: secondBranch.id, userId: secondProviderUser.id, specialty: 'Primary Care' } });
    const secondPatient = await db.patient.create({ data: { tenantId: t.id, branchId: secondBranch.id, firstName: 'Other', lastName: 'Branch', lifecycleStage: 'ACTIVE' } });
    const branchMismatch = await db.appointment.create({ data: {
      tenantId: t.id, branchId: secondBranch.id, patientId: secondPatient.id,
      providerProfileId: secondProvider.id, providerRef: secondProvider.id, service: t.appointmentType,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status: 'CONFIRMED', channel: 'EMAIL',
    } });
    const otherSourceCall = await db.receptionistCallLog.create({ data: {
      tenantId: t.id, clinicId: t.clinicId, campaignId: t.campaignId,
      retellCallId: `different-source-${randomUUID()}`, direction: 'inbound', outcome: 'IN_PROGRESS',
    } });
    const sourceMismatch = await db.appointment.create({ data: {
      tenantId: t.id, branchId: t.branchId, patientId: t.patientId,
      providerProfileId: t.providerId, providerRef: t.providerId, receptionistCallLogId: otherSourceCall.id,
      service: t.appointmentType, startsAt: new Date(startsAt.getTime() + 120 * 60_000),
      endsAt: new Date(startsAt.getTime() + 150 * 60_000), status: 'CONFIRMED', channel: 'EMAIL',
    } });
    const payload = {
      appointmentId: appointment.id, outcomeReason: 'Scheduled by front desk after reviewing the caller request.',
      acknowledgeRequestDifferences: true,
    };
    const foreign = await app.inject({
      method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers: adminAuth(t),
      payload: { ...payload, appointmentId: foreignAppointment.id },
    });
    expect(foreign.statusCode).toBe(400);
    for (const candidateId of [patientMismatch.id, branchMismatch.id, sourceMismatch.id]) {
      const mismatch = await app.inject({
        method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers: adminAuth(t),
        payload: { ...payload, appointmentId: candidateId },
      });
      expect(mismatch.statusCode).toBe(409);
    }

    const roleUsers = await Promise.all((['FRONT_DESK', 'BILLING', 'AUDITOR'] as const).map(role => db.user.create({ data: {
      tenantId: t.id, role, active: true,
      email: `${role.toLowerCase()}-${t.id.slice(0, 8)}@bk.test`, displayName: role,
    } })));
    const roleAuth = (index: number) => ({ authorization: `Bearer ${app.jwt.sign({
      userId: roleUsers[index].id, tenantId: t.id, role: roleUsers[index].role, type: 'access',
    })}` });
    // Provider and unrelated operational/compliance roles do not inherit the
    // narrow front-desk booking-review grant.
    const providerAuth = { authorization: `Bearer ${app.jwt.sign({ userId: t.providerUserId, tenantId: t.id, role: 'PROVIDER', type: 'access' })}` };
    for (const headers of [providerAuth, roleAuth(1), roleAuth(2)]) {
      const denied = await app.inject({ method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers, payload });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ permission: 'receptionist:booking-review' });
    }
    const first = await app.inject({
      method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers: roleAuth(0), payload,
    });
    const replay = await app.inject({
      method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers: adminAuth(t), payload,
    });
    expect([first.statusCode, replay.statusCode]).toEqual([200, 200]);
    expect(first.json()).toMatchObject({
      status: 'BOOKED', appointmentId: appointment.id, duplicate: false,
      appointment: {
        service: t.appointmentType,
        startsAt: startsAt.toISOString(),
        timezone: 'UTC', locationName: 'Main', locationAddress: 'X', providerName: 'Dr',
      },
    });
    expect(first.json().appointment.service).not.toBe('Requested intake service');
    expect(first.json().appointment.startsAt).not.toBe(requestedDateTime.toISOString());
    expect(replay.json()).toMatchObject({ status: 'BOOKED', appointmentId: appointment.id, duplicate: true });
    const listed = await app.inject({ method: 'GET', url: '/v1/receptionist/booking-requests', headers: roleAuth(0) });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(expect.objectContaining({
      id: requestId,
      bookedAppointment: expect.objectContaining({
        id: appointment.id, service: t.appointmentType, startsAt: startsAt.toISOString(),
        branch: expect.objectContaining({ timezone: 'UTC', name: 'Main', location: 'X' }),
      }),
    }));
    expect(await db.appointmentRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({
      status: 'BOOKED', bookedAppointmentId: appointment.id, patientId: t.patientId, branchId: t.branchId,
    });
    expect(await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).toMatchObject({
      receptionistCallLogId: expect.any(String), providerProfileId: t.providerId,
    });
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'receptionist.appointmentRequest.reconciledToCanonicalAppointment', resourceId: requestId } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: t.id, eventType: 'receptionist.appointmentRequest.reconciled', entityId: requestId } })).toBe(1);
    const differentReplay = await app.inject({
      method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers: adminAuth(t),
      payload: { ...payload, appointmentId: patientMismatch.id },
    });
    expect(differentReplay.statusCode).toBe(409);
  });

  it.each([
    ['AuditEvent', `NEW.action = 'receptionist.appointmentRequest.reconciledToCanonicalAppointment'`],
    ['BusinessEvent', `NEW."eventType" = 'receptionist.appointmentRequest.reconciled'`],
  ])('rolls the entire request reconciliation back when mandatory %s evidence fails', async (table, evidencePredicate) => {
    const t = await makeTenant();
    const callId = `reconcile-rollback-${randomUUID()}`;
    const review = await fn(t, 'book_appointment', {
      first_name: 'Rollback', last_name: 'Review', appointment_date: 'invalid', appointment_time: 'later',
    }, callId, '+15551115555');
    const requestId = (review.json() as { appointment_request_id: string }).appointment_request_id;
    const requestBefore = await db.appointmentRequest.findUniqueOrThrow({ where: { id: requestId } });
    await db.appointmentRequest.update({ where: { id: requestId }, data: { patientId: t.patientId } });
    const startsAt = new Date(`${futureDate(11)}T15:00:00.000Z`);
    const appointment = await db.appointment.create({ data: {
      tenantId: t.id, branchId: t.branchId, patientId: t.patientId,
      providerProfileId: t.providerId, providerRef: t.providerId, service: t.appointmentType,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status: 'CONFIRMED', channel: 'EMAIL',
    } });
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_reconcile_evidence_${suffix}`;
    const triggerName = `${functionName}_trg`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${t.id}'::uuid AND ${evidencePredicate} THEN
          RAISE EXCEPTION 'injected reconciliation evidence failure';
        END IF;
        RETURN NEW;
      END $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."${table}" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."${table}"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    databaseCleanup.push(removeFault);
    const reconcile = () => app.inject({
      method: 'POST', url: `/v1/receptionist/booking-requests/${requestId}/reconcile`, headers: adminAuth(t),
      payload: {
        appointmentId: appointment.id, outcomeReason: 'Front desk completed canonical scheduling review.',
        acknowledgeRequestDifferences: true,
      },
    });
    const failed = await reconcile();
    expect(failed.statusCode).toBe(500);
    expect(await db.appointmentRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({
      status: requestBefore.status, bookedAppointmentId: null,
    });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).receptionistCallLogId).toBeNull();
    expect((await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } })).outcome).toBe('IN_PROGRESS');
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'receptionist.appointmentRequest.reconciledToCanonicalAppointment', resourceId: requestId } })).toBe(0);
    expect(await db.businessEvent.count({ where: { tenantId: t.id, eventType: 'receptionist.appointmentRequest.reconciled', entityId: requestId } })).toBe(0);
    await removeFault(); databaseCleanup.pop();
    expect((await reconcile()).statusCode).toBe(200);
  });

  it('rolls back a needs-review request when the mandatory live-agent audit fails, then retries cleanly', async () => {
    const t = await makeTenant();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_receptionist_review_audit_${suffix}`;
    const triggerName = `test_receptionist_review_audit_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${t.id}'::uuid AND NEW.action = 'receptionist.appointmentRequest.needsReview' THEN
          RAISE EXCEPTION 'injected mandatory receptionist review audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."AuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    databaseCleanup.push(removeFault);

    const args = { first_name: 'Audit', last_name: 'Review', appointment_date: 'not-a-date', appointment_time: 'later', service: 'Consultation' };
    const callId = `review-audit-${randomUUID()}`;
    const failed = await fn(t, 'book_appointment', args, callId, '+15551119999');
    expect(failed.statusCode).toBe(500);
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'receptionist.appointmentRequest.needsReview' } })).toBe(0);

    await removeFault();
    databaseCleanup.pop();
    const retry = await fn(t, 'book_appointment', args, callId, '+15551119999');
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ needs_review: true });
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'receptionist.appointmentRequest.needsReview' } })).toBe(1);
  });

  it('rolls back recording-consent evidence when its mandatory live-agent audit fails', async () => {
    const t = await makeTenant();
    const callId = `recording-audit-${randomUUID()}`;
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_receptionist_consent_audit_${suffix}`;
    const triggerName = `test_receptionist_consent_audit_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${t.id}'::uuid AND NEW.action = 'receptionist.recording_preference.recorded' THEN
          RAISE EXCEPTION 'injected mandatory receptionist consent audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."AuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    databaseCleanup.push(removeFault);

    const failed = await fn(t, 'record_recording_preference', { recording_decision: 'GRANTED', jurisdiction: 'test' }, callId, '+15551117777');
    expect(failed.statusCode).toBe(500);
    const call = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    expect(call.recordingConsentStatus).toBe('UNDETERMINED');
    expect(await db.receptionistRecordingConsentEvent.count({ where: { tenantId: t.id, callLogId: call.id } })).toBe(0);

    await removeFault();
    databaseCleanup.pop();
    const retry = await fn(t, 'record_recording_preference', { recording_decision: 'GRANTED', jurisdiction: 'test' }, callId, '+15551117777');
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ recorded: true, decision: 'GRANTED' });
    expect(await db.receptionistRecordingConsentEvent.count({ where: { tenantId: t.id, callLogId: call.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'receptionist.recording_preference.recorded', resourceId: call.id } })).toBe(1);
  });

  it('does not invent capacity when provider selection is ambiguous', async () => {
    const t = await makeTenant();
    const user = await db.user.create({ data: { tenantId: t.id, role: 'PROVIDER', active: true, email: `pv2-${t.id.slice(0, 8)}@bk.test`, displayName: 'Dr Two' } });
    await db.providerProfile.create({ data: { tenantId: t.id, branchId: t.branchId, userId: user.id, specialty: 'Primary Care' } });
    const date = futureDate(3);
    const result = (await fn(t, 'check_availability', { appointment_date: date, service: 'Consultation' })).json() as { available: boolean; needs_review?: boolean; slots: unknown[] };
    expect(result.available).toBe(false);
    expect(result.needs_review).toBe(true);
    expect(result.slots).toHaveLength(0);
  });

  it('rolls back the appointment, request, and idempotency claim when mandatory booking audit persistence fails', async () => {
    const t = await makeTenant();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_receptionist_booking_audit_${suffix}`;
    const triggerName = `test_receptionist_booking_audit_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${t.id}'::uuid AND NEW.action = 'receptionist.appointment.booked' THEN
          RAISE EXCEPTION 'injected mandatory receptionist audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    databaseCleanup.push(async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."AuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    });

    const date = futureDate(6);
    const result = await fn(t, 'book_appointment', {
      first_name: 'Audit', last_name: 'Rollback', appointment_date: date, appointment_time: '09:00', service: 'Consultation',
    }, `audit-rollback-${randomUUID()}`, '+15551118888');
    expect(result.statusCode).toBe(500);
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.idempotencyKey.count({ where: { tenantId: t.id, scope: 'receptionist.live-booking' } })).toBe(0);
  });

  it('validates the exact attested parameter schema and persists only recognized bounded values on review', async () => {
    const cases = [
      { label: 'unknown', args: { rogue_payload: { nested: 'never persist me' } }, overrides: {}, issue: 'rogue_payload:unknown' },
      { label: 'confirmation', args: {}, overrides: { booking_confirmed: false }, issue: 'booking_confirmed:const' },
      { label: 'pattern', args: { appointment_date: 'tomorrow' }, overrides: {}, issue: 'appointment_date:pattern' },
      { label: 'minimum length', args: { first_name: '' }, overrides: {}, issue: 'first_name:minLength' },
      { label: 'enum', args: {}, overrides: { location_id: randomUUID() }, issue: 'location_id:enum' },
    ];
    for (const testCase of cases) {
      const t = await makeTenant();
      const response = await fn(t, 'book_appointment', {
        first_name: 'Schema', last_name: 'Review', appointment_date: futureDate(8), appointment_time: '09:00',
        ...testCase.args,
      }, `schema-${testCase.label}-${randomUUID()}`, '+15551239876', testCase.overrides);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ booked: false, needs_review: true });
      const request = await db.appointmentRequest.findFirstOrThrow({
        where: { tenantId: t.id, callLog: { retellCallId: { startsWith: `schema-${testCase.label}-` } } },
      });
      expect(request.missingFields).toContain(testCase.issue);
      expect(request.rawCollectedFields).toMatchObject({ observed_phone: '+15551239876' });
      expect(JSON.stringify(request.rawCollectedFields)).not.toContain('never persist me');
      expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
    }
  });

  it('persists every configured answer and confirmation without trusting args.phone', async () => {
    const t = await makeTenant();
    const textId = randomUUID();
    const dropdownId = randomUUID();
    const yesNoId = randomUUID();
    const contract = await configureIntake(t, [
      { id: randomUUID(), fieldType: 'EMAIL', label: 'Email', aiQuestion: 'What email should we use?', required: true, confirmationRequired: false, sortOrder: 0 },
      { id: textId, fieldType: 'CUSTOM_TEXT', label: 'Visit note', aiQuestion: 'What should staff know?', required: true, confirmationRequired: true, sortOrder: 1 },
      { id: dropdownId, fieldType: 'CUSTOM_DROPDOWN', label: 'Preference', aiQuestion: 'Choose a preference.', options: ['Morning', 'Afternoon'], required: true, confirmationRequired: false, sortOrder: 2 },
      { id: yesNoId, fieldType: 'CUSTOM_YES_NO', label: 'Interpreter', aiQuestion: 'Do you need an interpreter?', required: true, confirmationRequired: false, sortOrder: 3 },
    ]);
    const key = (id: string) => `custom_${id.replaceAll('-', '')}`;
    const date = futureDate(9);
    const response = await fn(t, 'book_appointment', {
      first_name: 'Complete', last_name: 'Answers', phone: '+15550000000', email: 'complete@example.test',
      appointment_date: date, appointment_time: '09:00',
      [key(textId)]: 'Needs wheelchair access', [`${key(textId)}_confirmed`]: true,
      [key(dropdownId)]: 'Morning', [key(yesNoId)]: true,
    }, `answers-${randomUUID()}`, '+15551231234');
    expect(response.json()).toMatchObject({ booked: true });
    const request = await db.appointmentRequest.findFirstOrThrow({ where: { tenantId: t.id, status: 'BOOKED' } });
    expect(request.rawCollectedFields).toMatchObject({
      first_name: 'Complete', last_name: 'Answers', email: 'complete@example.test',
      [key(textId)]: 'Needs wheelchair access', [`${key(textId)}_confirmed`]: true,
      [key(dropdownId)]: 'Morning', [key(yesNoId)]: true,
      booking_confirmed: true, observed_phone: '+15551231234',
      intake_contract_fingerprint: contract.snapshot.semanticFingerprint,
    });
    expect((request.rawCollectedFields as Record<string, unknown>).phone).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(request.rawCollectedFields), 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('serializes one call across concurrent attempts for different slots', async () => {
    const t = await makeTenant();
    const date = futureDate(10);
    const available = (await fn(t, 'check_availability', { appointment_date: date })).json() as { slots: Array<{ time: string }> };
    expect(available.slots.length).toBeGreaterThanOrEqual(2);
    const callId = `one-call-two-slots-${randomUUID()}`;
    await fn(t, 'record_recording_preference', { recording_decision: 'GRANTED' }, callId, '+15551237777');
    const [first, second] = await Promise.all([
      fn(t, 'book_appointment', { first_name: 'One', last_name: 'Call', appointment_date: date, appointment_time: available.slots[0].time }, callId, '+15551237777'),
      fn(t, 'book_appointment', { first_name: 'One', last_name: 'Call', appointment_date: date, appointment_time: available.slots[1].time }, callId, '+15551237777'),
    ]);
    const results = [first.json(), second.json()] as Array<{ booked: boolean; duplicate?: boolean; appointment_id?: string }>;
    expect(results.every(result => result.booked)).toBe(true);
    expect(results.filter(result => result.duplicate)).toHaveLength(1);
    expect(new Set(results.map(result => result.appointment_id)).size).toBe(1);
    const call = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    expect(call.outcome).toBe('BOOKED');
    expect(await db.appointment.count({ where: { tenantId: t.id, receptionistCallLogId: call.id } })).toBe(1);
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id, callLogId: call.id } })).toBe(1);
  });

  it.each([
    ['Patient', 'TRUE'],
    ['Appointment', 'TRUE'],
    ['AppointmentRequest', 'TRUE'],
    ['IdempotencyKey', `NEW.scope = 'receptionist.live-booking'`],
    ['AuditEvent', `NEW.action = 'receptionist.appointment.booked'`],
    ['BusinessEvent', `NEW."eventType" = 'receptionist.appointment.booked'`],
  ] as const)('rolls back every canonical booking write when %s persistence fails', async (table, predicate) => {
    const t = await makeTenant();
    const baselinePatients = await db.patient.count({ where: { tenantId: t.id } });
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_booking_${table.toLowerCase()}_${suffix}`;
    const triggerName = `${functionName}_trg`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${t.id}'::uuid AND (${predicate}) THEN
          RAISE EXCEPTION 'injected ${table} failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."${table}" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."${table}"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    databaseCleanup.push(removeFault);
    const callId = `fault-${table}-${randomUUID()}`;
    const response = await fn(t, 'book_appointment', {
      first_name: 'Atomic', last_name: 'Rollback', appointment_date: futureDate(11), appointment_time: '09:00',
    }, callId, '+15551236666');
    expect(response.statusCode).toBe(500);
    const call = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    expect(call.outcome).toBe('IN_PROGRESS');
    expect(await db.patient.count({ where: { tenantId: t.id } })).toBe(baselinePatients);
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.idempotencyKey.count({ where: { tenantId: t.id, scope: 'receptionist.live-booking' } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'receptionist.appointment.booked' } })).toBe(0);
    expect(await db.businessEvent.count({ where: { tenantId: t.id, eventType: 'receptionist.appointment.booked' } })).toBe(0);
    await removeFault();
    databaseCleanup.pop();
  });

  it('rolls back all booking writes when the terminal CallLog update fails', async () => {
    const t = await makeTenant();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_booking_calllog_${suffix}`;
    const triggerName = `${functionName}_trg`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${t.id}'::uuid AND NEW.outcome = 'BOOKED' THEN RAISE EXCEPTION 'injected CallLog failure'; END IF;
        RETURN NEW;
      END $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON public."ReceptionistCallLog" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."ReceptionistCallLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    databaseCleanup.push(removeFault);
    const response = await fn(t, 'book_appointment', {
      first_name: 'Call', last_name: 'Rollback', appointment_date: futureDate(12), appointment_time: '09:00',
    }, `calllog-fault-${randomUUID()}`, '+15551235555');
    expect(response.statusCode).toBe(500);
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.idempotencyKey.count({ where: { tenantId: t.id, scope: 'receptionist.live-booking' } })).toBe(0);
    await removeFault();
    databaseCleanup.pop();
  });

  it('rolls back needs-review request, idempotency, audit, and BusinessEvent together', async () => {
    const t = await makeTenant();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_review_business_${suffix}`;
    const triggerName = `${functionName}_trg`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${t.id}'::uuid AND NEW."eventType" = 'receptionist.appointmentRequest.created' THEN RAISE EXCEPTION 'injected review BusinessEvent failure'; END IF;
        RETURN NEW;
      END $fn$
    `);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."BusinessEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."BusinessEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    databaseCleanup.push(removeFault);
    const response = await fn(t, 'book_appointment', {
      first_name: 'Review', last_name: 'Rollback', appointment_date: 'invalid', appointment_time: '09:00',
    }, `review-business-${randomUUID()}`, '+15551234445');
    expect(response.statusCode).toBe(500);
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.idempotencyKey.count({ where: { tenantId: t.id, scope: 'receptionist.live-booking' } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'receptionist.appointmentRequest.needsReview' } })).toBe(0);
    await removeFault();
    databaseCleanup.pop();
  });

  it('ignores an unrelated tenant branch and remains bound to the attested clinic location', async () => {
    const t = await makeTenant();
    await db.branch.create({ data: { tenantId: t.id, name: 'Second', location: 'Y', timezone: 'America/Chicago', active: true } });
    const result = (await fn(t, 'check_availability', { appointment_date: futureDate(3), service: 'Consultation' })).json() as { available: boolean; needs_review?: boolean; slots: unknown[] };
    expect(result.available).toBe(true);
    expect(result.slots.length).toBeGreaterThan(0);
  });
});

describe('receptionist outbound dial — opt-out gate (FIX 4)', () => {
  it('never dials an opted-out number: records OPTED_OUT + skips, no call placed', async () => {
    const t = await makeTenant();
    const optedPhone = '+15553330001';
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: optedPhone, channel: 'ALL', reason: 'AI call' } });
    const campaign = await createRunnableOutboundTarget(t, optedPhone);

    const res = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.campaignId}/call`, headers: adminAuth(t), payload: { phone: optedPhone, firstName: 'Pat', lastName: 'Roe', targetId: campaign.targetId } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; reason?: string };
    expect(body.status).toBe('skipped');
    expect(body.reason).toBe('opted_out');

    // Suppressed before provider submission; never creates an in-progress call.
    expect(await db.receptionistCallLog.count({ where: { tenantId: t.id, outcome: 'IN_PROGRESS' } })).toBe(0);
  });

  it('a non-opted-out number is NOT skipped by the gate (contrast: falls through to provider setup)', async () => {
    const t = await makeTenant();
    const campaign = await createRunnableOutboundTarget(t, '+15553330002');
    const res = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.campaignId}/call`, headers: adminAuth(t), payload: { phone: '+15553330002', firstName: 'Pat', lastName: 'Roe', targetId: campaign.targetId } });
    expect(res.statusCode).toBe(200);
    // Retell is unconfigured in test → the gate passed and we reach setup_required
    // (proving the opt-out gate is specific, not a blanket skip).
    expect((res.json() as { status: string }).status).toBe('setup_required');
  });
});
