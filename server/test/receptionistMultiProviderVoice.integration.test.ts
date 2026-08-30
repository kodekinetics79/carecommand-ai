import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

// ===========================================================================
// The booking path on a practice that looks like a real one: more than one
// clinician, more than one bookable service.
//
// Before C1 the live tools refused to offer OR book anything unless the branch
// had exactly one active provider, so every multi-clinician practice heard
// "I need a team member to confirm the provider or service" on every call.
// Before C9 one campaign meant one service, and the duration the agent spoke
// was not the duration the scheduler reserved.
//
// Every test here fails on the pre-C-voice tree.
// ===========================================================================

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

const RETELL_KEY = 'test-retell-multi-provider-key';
const originalRetellKey = env.RETELL_API_KEY;
const tenantIds: string[] = [];
let app: FastifyInstance;

const phoneFor = (seed: string) => `+1${(BigInt(`0x${seed.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

const APPOINTMENT_TYPE = 'Cleaning';
const LONG_SERVICE = 'Crown fitting';
const UNBOOKABLE_SERVICE = 'Teeth whitening';

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `mp-${id.slice(0, 6)}`, slug: `mp-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: '1 High Street', timezone: 'UTC', active: true }, select: { id: true, name: true } });

  // TWO clinicians. This is the ordinary case, and it used to be fatal.
  const providers: Array<{ id: string; displayName: string }> = [];
  for (const [index, displayName] of ['Dr. Anita Patel', 'Dr. Michael Chen'].entries()) {
    const user = await db.user.create({
      data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv${index}-${id.slice(0, 8)}@mp.test`, displayName },
      select: { id: true },
    });
    const profile = await db.providerProfile.create({
      data: { tenantId: id, branchId: branch.id, userId: user.id, specialty: 'Dentistry', active: true },
      select: { id: true },
    });
    await db.providerAvailability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        tenantId: id, branchId: branch.id, providerProfileId: profile.id,
        dayOfWeek, startMinute: 540, endMinute: 1020, slotMinutes: 30,
      })),
    });
    providers.push({ id: profile.id, displayName });
  }

  // A catalogue with more than one voice-bookable service, and one the clinic
  // deliberately does not let the phone book.
  await db.serviceCatalogItem.createMany({
    data: [
      { tenantId: id, name: APPOINTMENT_TYPE, category: 'general', defaultDurationMinutes: 30, bookableByVoice: true, active: true },
      // Spoken as 60 minutes; the scheduler used to reserve the 30-minute
      // default and double-book the chair.
      { tenantId: id, name: LONG_SERVICE, category: 'general', defaultDurationMinutes: 30, voiceDurationMinutes: 60, bookableByVoice: true, active: true },
      { tenantId: id, name: UNBOOKABLE_SERVICE, category: 'general', defaultDurationMinutes: 30, bookableByVoice: false, active: true },
    ],
  });

  const clinic = await db.receptionistClinic.create({
    data: {
      tenantId: id, name: 'Brightsmile', phone: phoneFor(id), active: true,
      country: 'US', timezone: 'UTC', defaultLanguage: 'en-US',
      humanFallbackNumber: '+14155550100',
    },
    select: { id: true },
  });
  const location = await db.receptionistLocation.create({
    data: { tenantId: id, clinicId: clinic.id, branchId: branch.id, name: 'Main location', address: '1 High Street', active: true },
    select: { id: true, name: true },
  });

  const campaignId = randomUUID();
  const providerAgentId = `agent_${id.replaceAll('-', '')}`;
  const providerVersion = 1;
  const contract = compileIntakeContract({
    campaignId, revision: 1, appointmentType: APPOINTMENT_TYPE,
    eligibleLocations: [location],
    // A caller may name the clinician they want to see.
    fields: [{
      id: randomUUID(), fieldType: 'PREFERRED_PROVIDER', label: 'Preferred clinician',
      aiQuestion: 'Is there a clinician you would like to see?', required: false,
      confirmationRequired: false, sortOrder: 1,
    }],
    toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${clinic.id}`,
    bookableServices: [APPOINTMENT_TYPE, LONG_SERVICE],
  });
  const providerGraphFingerprint = 'a'.repeat(64);
  const providerToolFingerprint = fingerprintJson({
    tool: contract.snapshot.bookAppointmentToolContract,
    engine: { type: 'retell-llm', id: `llm_${id.replaceAll('-', '')}`, version: 1, graphFingerprint: providerGraphFingerprint },
  });
  const attestedSnapshot = { ...contract.snapshot, providerEffectiveDynamicVariables: {} };
  const now = new Date();
  const agent = await db.receptionistAgent.create({
    data: {
      tenantId: id, clinicId: clinic.id, name: 'Avery', active: true,
      providerAgentId, providerVersionTag: 'prod', providerVersion,
      providerStatus: 'VERIFIED', providerPublished: true, providerAssignedTags: ['prod'],
      providerFingerprint: 'b'.repeat(64),
      providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
      providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
      providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
      providerResponseEngineType: 'retell-llm', providerResponseEngineId: `llm_${id.replaceAll('-', '')}`,
      providerResponseEngineVersion: 1, providerResponseEngineGraphFingerprint: providerGraphFingerprint,
      providerEffectiveDynamicVariables: {},
      providerBookToolSchema: contract.snapshot.bookAppointmentToolContract as never,
      providerBookToolFingerprint: providerToolFingerprint, providerToolCallStrictMode: true,
      providerConfigRevision: 1, providerVerifiedRevision: 1, providerVerifiedAt: now,
      providerVerificationExpiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
    },
    select: { id: true },
  });
  await db.receptionistCampaign.create({
    data: {
      id: campaignId, tenantId: id, clinicId: clinic.id, agentId: agent.id,
      name: 'Inbound reception', status: 'ACTIVE', offerTitle: 'Appointment', offerDescription: 'Schedule care',
      offerScript: 'Would you like to schedule?', appointmentType: APPOINTMENT_TYPE,
      eligibleLocationIds: [location.id], intakeSchemaRevision: 1,
      intakeSchemaSnapshot: attestedSnapshot as never, intakeSchemaFingerprint: fingerprintJson(attestedSnapshot),
      intakeToolFingerprint: providerToolFingerprint, intakeSchemaAttestedRevision: 1, intakeSchemaAttestedAt: now,
      intakeSchemaProviderAgentId: providerAgentId, intakeSchemaProviderVersion: providerVersion,
      intakeSchemaResponseEngineId: `llm_${id.replaceAll('-', '')}`, intakeSchemaResponseEngineVersion: 1,
    },
  });
  return {
    id, branchId: branch.id, clinicId: clinic.id, campaignId, locationId: location.id,
    providerAgentId, providerVersion, providers,
    semanticFingerprint: contract.snapshot.semanticFingerprint,
    bookToolProperties: (contract.snapshot.bookAppointmentToolContract.parameters as { properties: Record<string, { enum?: string[] }> }).properties,
  };
}
type T = Awaited<ReturnType<typeof makeTenant>>;

const futureDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function fn(t: T, name: string, args: Record<string, unknown>, callId: string, fromNumber: string) {
  const existing = await db.receptionistCallLog.findFirst({
    where: { tenantId: t.id, retellCallId: callId }, select: { id: true, recordingConsentStatus: true },
  });
  if (!existing) {
    await db.receptionistCallLog.create({
      data: {
        tenantId: t.id, clinicId: t.clinicId, campaignId: t.campaignId, retellCallId: callId,
        callerPhone: fromNumber, direction: 'inbound', outcome: 'IN_PROGRESS',
      },
    });
  }
  const needsConsent = name === 'book_appointment' || name === 'verify_patient_identity';
  if (needsConsent && existing?.recordingConsentStatus !== 'GRANTED') {
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
  }
  const raw = JSON.stringify({
    name, args,
    call: { call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerVersion, from_number: fromNumber, direction: 'inbound' },
  });
  return app.inject({
    method: 'POST',
    url: `/v1/receptionist/webhooks/retell/fn?clinicId=${t.clinicId}`,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) },
    payload: raw,
  });
}

function bookArgs(t: T, extra: Record<string, unknown>) {
  return {
    first_name: 'Casey', last_name: 'Nguyen',
    location_id: t.locationId,
    service: APPOINTMENT_TYPE,
    intake_contract_fingerprint: t.semanticFingerprint,
    intake_schema_revision: 1,
    booking_confirmed: true,
    ...extra,
  };
}

beforeAll(async () => {
  env.RETELL_API_KEY = RETELL_KEY;
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  env.RETELL_API_KEY = originalRetellKey;
  await app?.close();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
});

describe('C1 — a practice with more than one clinician can be booked', () => {
  it('offers the union of both clinicians’ open times', async () => {
    const t = await makeTenant();
    const date = futureDate(3);
    const response = await fn(t, 'check_availability', { appointment_date: date, service: APPOINTMENT_TYPE }, `ca-${randomUUID()}`, '+12125550101');
    expect(response.statusCode).toBe(200);
    const body = response.json() as { available: boolean; slots: Array<{ time: string }>; duration_minutes?: number };
    expect(body.available).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.duration_minutes).toBe(30);

    // The audit records that the sweep really did cross both calendars.
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: t.id, action: 'receptionist.availability.checked' },
      orderBy: { occurredAt: 'desc' },
    });
    expect((audit.metadata as { providerCount?: number }).providerCount).toBe(2);
  });

  // The proof the whole package exists for: a booking COMPLETES on a
  // two-clinician branch. This returned needs_review on the pre-C1 tree.
  it('completes a booking, and books the clinician who is actually free', async () => {
    const t = await makeTenant();
    const date = futureDate(4);
    const startsAt = new Date(`${date}T09:00:00.000Z`);

    // Fill the first clinician's 09:00 so only the second one is free.
    const patient = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchId, firstName: 'Existing', lastName: 'Booking', lifecycleStage: 'ACTIVE' },
      select: { id: true },
    });
    await db.appointment.create({
      data: {
        tenantId: t.id, branchId: t.branchId, patientId: patient.id,
        providerProfileId: t.providers[0].id, providerRef: t.providers[0].id,
        service: APPOINTMENT_TYPE, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        status: 'CONFIRMED', channel: 'CALL',
      },
    });

    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '09:00' }),
      `bk-${randomUUID()}`, '+12125550102',
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { booked?: boolean; needs_review?: boolean; provider_name?: string; message?: string };
    expect(body.needs_review).toBeUndefined();
    expect(body.booked).toBe(true);
    expect(body.provider_name).toBe(t.providers[1].displayName);

    const booked = await db.appointment.findFirstOrThrow({
      where: { tenantId: t.id, startsAt, providerProfileId: t.providers[1].id },
      select: { providerProfileId: true, service: true },
    });
    expect(booked.providerProfileId).toBe(t.providers[1].id);
  });

  it('books the clinician the caller asked for by name', async () => {
    const t = await makeTenant();
    const date = futureDate(5);
    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '10:00', preferred_provider: 'Dr Chen' }),
      `bk-pref-${randomUUID()}`, '+12125550103',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ booked: true, provider_name: t.providers[1].displayName });
  });

  it('asks rather than substituting a stranger when the named clinician cannot be matched', async () => {
    const t = await makeTenant();
    const date = futureDate(5);
    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '10:00', preferred_provider: 'Dr Nobody' }),
      `bk-unknown-${randomUUID()}`, '+12125550104',
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { booked?: boolean; needs_review?: boolean };
    expect(body.booked).toBe(false);
    expect(body.needs_review).toBe(true);
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('routes to staff when the whole branch has no bookable clinician', async () => {
    const t = await makeTenant();
    await db.providerProfile.updateMany({ where: { tenantId: t.id, branchId: t.branchId }, data: { active: false } });
    const date = futureDate(6);
    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '11:00' }),
      `bk-none-${randomUUID()}`, '+12125550105',
    );
    expect(response.json()).toMatchObject({ needs_review: true });
  });
});

describe('C9 — one campaign, the clinic’s whole voice-bookable menu', () => {
  it('deploys an enum over every bookable service and excludes the ones the clinic withheld', async () => {
    const t = await makeTenant();
    expect(t.bookToolProperties.service.enum).toEqual([APPOINTMENT_TYPE, LONG_SERVICE]);
    expect(t.bookToolProperties.service.enum).not.toContain(UNBOOKABLE_SERVICE);
  });

  it('books a service the campaign does not advertise', async () => {
    const t = await makeTenant();
    const date = futureDate(7);
    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '13:00', service: LONG_SERVICE }),
      `bk-crown-${randomUUID()}`, '+12125550106',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ booked: true, service: LONG_SERVICE });
  });

  it('reserves the duration it speaks, not the desk default', async () => {
    const t = await makeTenant();
    const date = futureDate(8);
    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '14:00', service: LONG_SERVICE }),
      `bk-dur-${randomUUID()}`, '+12125550107',
    );
    expect(response.statusCode).toBe(200);
    const appointment = await db.appointment.findFirstOrThrow({
      where: { tenantId: t.id, service: LONG_SERVICE },
      select: { startsAt: true, endsAt: true },
    });
    // 60 spoken minutes, 60 booked minutes. It used to reserve 30.
    expect((appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000).toBe(60);
  });

  it('sizes the offered slots by the chosen service', async () => {
    const t = await makeTenant();
    const date = futureDate(9);
    const long = (await fn(t, 'check_availability', { appointment_date: date, service: LONG_SERVICE }, `ca-long-${randomUUID()}`, '+12125550108')).json() as { duration_minutes?: number; service?: string };
    expect(long.service).toBe(LONG_SERVICE);
    expect(long.duration_minutes).toBe(60);
  });

  it('refuses a service that is not on the deployed menu', async () => {
    const t = await makeTenant();
    const date = futureDate(10);
    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '15:00', service: UNBOOKABLE_SERVICE }),
      `bk-off-menu-${randomUUID()}`, '+12125550109',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ booked: false, needs_human: true });
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
  });
});

describe('C5 — a returning caller is not a dead end', () => {
  it('books an unverified caller whose number is already known, and flags the possible duplicate', async () => {
    const t = await makeTenant();
    const callerPhone = '+12125550190';
    const existing = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchId, firstName: 'Casey', lastName: 'Nguyen', phone: callerPhone, lifecycleStage: 'ACTIVE' },
      select: { id: true },
    });
    const date = futureDate(11);
    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '09:30' }),
      `bk-known-${randomUUID()}`, callerPhone,
    );
    expect(response.statusCode).toBe(200);
    // This returned needs_review — "I need identity verification or front desk
    // assistance" — for every returning patient on the pre-C5 tree.
    expect(response.json()).toMatchObject({ booked: true });

    const request = await db.appointmentRequest.findFirstOrThrow({
      where: { tenantId: t.id, status: 'BOOKED' },
      select: { patientId: true, rawCollectedFields: true, outcomeReason: true },
    });
    expect(request.patientId).not.toBe(existing.id);
    expect((request.rawCollectedFields as Record<string, unknown>).possible_duplicate_of_patient_id).toBe(existing.id);
    expect(request.outcomeReason).toContain('existing record');

    const tasks = await db.staffTask.findMany({ where: { tenantId: t.id }, select: { metadata: true } });
    const review = tasks.find(task => (task.metadata as { kind?: string }).kind === 'booking_review');
    expect(review).toBeDefined();
    expect((review!.metadata as { message?: string }).message).toContain(existing.id);
  });

  it('links the record instead of duplicating it once identity is verified', async () => {
    const t = await makeTenant();
    const callerPhone = '+12125550191';
    const dateOfBirth = new Date('1988-04-11T00:00:00.000Z');
    const existing = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchId, firstName: 'Casey', lastName: 'Nguyen', phone: callerPhone, dateOfBirth, lifecycleStage: 'ACTIVE' },
      select: { id: true },
    });
    const callId = `bk-verified-${randomUUID()}`;
    const verify = await fn(t, 'verify_patient_identity', { date_of_birth: '1988-04-11' }, callId, callerPhone);
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ verified: true });

    const date = futureDate(12);
    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '09:30' }),
      callId, callerPhone,
    );
    expect(response.json()).toMatchObject({ booked: true });
    const request = await db.appointmentRequest.findFirstOrThrow({
      where: { tenantId: t.id, status: 'BOOKED' },
      select: { patientId: true, rawCollectedFields: true },
    });
    expect(request.patientId).toBe(existing.id);
    expect((request.rawCollectedFields as Record<string, unknown>).possible_duplicate_of_patient_id).toBeUndefined();
    const tasks = await db.staffTask.findMany({ where: { tenantId: t.id }, select: { metadata: true } });
    expect(tasks.some(task => (task.metadata as { kind?: string }).kind === 'booking_review')).toBe(false);
  });

  it('keeps two family members on one number out of the automated path', async () => {
    const t = await makeTenant();
    const callerPhone = '+12125550192';
    for (const firstName of ['Casey', 'Jordan']) {
      await db.patient.create({
        data: { tenantId: t.id, branchId: t.branchId, firstName, lastName: 'Nguyen', phone: callerPhone, lifecycleStage: 'ACTIVE' },
      });
    }
    const date = futureDate(13);
    const response = await fn(
      t, 'book_appointment',
      bookArgs(t, { appointment_date: date, appointment_time: '10:30' }),
      `bk-family-${randomUUID()}`, callerPhone,
    );
    // Booking still completes — the caller is not hung out to dry — but no
    // duplicate is asserted, because we cannot say which of them called.
    expect(response.json()).toMatchObject({ booked: true });
    const request = await db.appointmentRequest.findFirstOrThrow({
      where: { tenantId: t.id, status: 'BOOKED' },
      select: { rawCollectedFields: true },
    });
    expect((request.rawCollectedFields as Record<string, unknown>).possible_duplicate_of_patient_id).toBeUndefined();
  });
});
