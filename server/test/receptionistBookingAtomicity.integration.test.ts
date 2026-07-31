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

vi.mock('../lib/commsProvider', () => ({
  sendMessage: vi.fn(async () => ({ status: 'sent' })),
}));

const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { bookAppointment } = await import('../lib/receptionist/liveTools');
const { compileIntakeContract, intakeFieldKey } = await import('../modules/receptionist/intakeContract');
const { runWithWebhookTenantContext } = await import('../lib/tenantContext');
const { signRetell } = await import('./helpers/retellSignature');
const { env } = await import('../config/env');
const { buildApp } = await import('../app');

const tenantIds: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const futureDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const RETELL_KEY = 'test-receptionist-atomicity-retell-key';
const originalRetellKey = env.RETELL_API_KEY;
let app: FastifyInstance;

type Field = Parameters<typeof compileIntakeContract>[0]['fields'][number];

async function fixture(fields: Field[] = []) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await db.tenant.create({
    data: { id: tenantId, name: `atomic-${tenantId.slice(0, 8)}`, slug: `atomic-${tenantId.slice(0, 8)}` },
  });
  await db.tenantFeatureEntitlement.create({
    data: { tenantId, featureKey: 'ai_receptionist', enabled: true, source: 'atomicity-test' },
  });
  const branch = await db.branch.create({
    data: { tenantId, name: 'Atomic branch', location: 'Test', timezone: 'UTC', active: true },
  });
  const providerUser = await db.user.create({
    data: {
      tenantId, role: 'PROVIDER', active: true,
      email: `provider-${tenantId.slice(0, 8)}@atomic.test`, displayName: 'Dr Atomic',
    },
  });
  const provider = await db.providerProfile.create({
    data: { tenantId, branchId: branch.id, userId: providerUser.id, specialty: 'General' },
  });
  await db.providerAvailability.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      tenantId, branchId: branch.id, providerProfileId: provider.id,
      dayOfWeek, startMinute: 540, endMinute: 1020, slotMinutes: 30,
    })),
  });
  const service = await db.serviceCatalogItem.create({
    data: { tenantId, name: 'Consultation', category: 'general', defaultDurationMinutes: 30, active: true },
  });
  const clinic = await db.receptionistClinic.create({
    data: { tenantId, name: 'Atomic clinic', phone: `+1${tenantId.replaceAll('-', '').slice(0, 10).replace(/[a-f]/g, '7')}` },
  });
  const location = await db.receptionistLocation.create({
    data: { tenantId, clinicId: clinic.id, branchId: branch.id, name: 'Main', address: '1 Test Way', active: true },
  });
  const campaignId = randomUUID();
  const snapshot = compileIntakeContract({
    campaignId, revision: 1, appointmentType: service.name,
    eligibleLocations: [{ id: location.id, name: location.name }], fields,
    toolUrl: `https://example.test/v1/receptionist/webhooks/retell/fn?clinicId=${clinic.id}`,
  }).snapshot;
  const providerAgentId = `agent_${tenantId.replaceAll('-', '')}`;
  const providerAgentVersion = 7;
  await db.receptionistCampaign.create({
    data: {
      id: campaignId, tenantId, clinicId: clinic.id, name: 'Atomic campaign', status: 'ACTIVE',
      offerTitle: 'Appointment', offerDescription: 'Book care', offerScript: 'Would you like to book?',
      appointmentType: service.name, eligibleLocationIds: [location.id], smsConfirmation: false, emailConfirmation: false,
      intakeSchemaRevision: 1, intakeSchemaSnapshot: snapshot as never,
      intakeSchemaFingerprint: (await import('../modules/receptionist/intakeContract')).fingerprintJson(snapshot),
      intakeToolFingerprint: snapshot.bookAppointmentToolFingerprint,
      intakeSchemaAttestedRevision: 1, intakeSchemaAttestedAt: new Date(),
      intakeSchemaProviderAgentId: providerAgentId, intakeSchemaProviderVersion: providerAgentVersion,
      intakeSchemaResponseEngineId: `llm_${tenantId.replaceAll('-', '')}`,
      intakeSchemaResponseEngineVersion: 3,
    },
  });
  const callId = `atomic-call-${randomUUID()}`;
  const call = await db.receptionistCallLog.create({
    data: {
      tenantId, clinicId: clinic.id, campaignId, retellCallId: callId,
      callerPhone: '+15551234567', direction: 'inbound', outcome: 'IN_PROGRESS',
      recordingConsentStatus: 'GRANTED', startedAt: new Date(),
    },
  });
  const trustedBooking = {
    callLogId: call.id, campaignId, clinicId: clinic.id, locationId: location.id,
    branchId: branch.id, branchTimezone: branch.timezone, observedPhone: call.callerPhone,
    providerAgentId, providerAgentVersion, intakeSnapshot: snapshot,
  };
  const ctx = { tenantId, callId, trustedBooking };
  const baseArgs: Record<string, unknown> = {
    first_name: 'Alex', last_name: 'Morgan', appointment_date: futureDate(10), appointment_time: '09:00',
    service: service.name, location_id: location.id,
    intake_contract_fingerprint: snapshot.semanticFingerprint, intake_schema_revision: 1, booking_confirmed: true,
  };
  const invoke = (args: Record<string, unknown>) => runWithWebhookTenantContext(
    tenantId,
    () => bookAppointment(ctx, args),
    'webhook:test-receptionist-atomicity',
  ) as Promise<Record<string, unknown>>;
  return { tenantId, branch, provider, service, clinic, location, campaignId, call, callId, snapshot, ctx, baseArgs, invoke };
}

async function installFault(tenantId: string, table: string, operation: 'INSERT' | 'UPDATE', predicate: string) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `atomic_fault_${suffix}`;
  const triggerName = `${functionName}_trg`;
  await db.$executeRawUnsafe(`
    CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW."tenantId" = '${tenantId}'::uuid AND (${predicate}) THEN
        RAISE EXCEPTION 'atomicity failure injection for ${table}';
      END IF;
      RETURN NEW;
    END $fn$
  `);
  await db.$executeRawUnsafe(
    `CREATE TRIGGER "${triggerName}" BEFORE ${operation} ON public."${table}" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`,
  );
  const remove = async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."${table}"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
  };
  cleanups.push(remove);
  return async () => {
    await remove();
    cleanups.splice(cleanups.indexOf(remove), 1);
  };
}

beforeAll(async () => {
  env.RETELL_API_KEY = RETELL_KEY;
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  env.RETELL_API_KEY = originalRetellKey;
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('canonical receptionist booking atomicity — independent integration oracle', () => {
  it('serializes concurrent different-slot attempts, persists exact scalar answers, and replays one canonical result', async () => {
    const dropdown: Field = {
      id: randomUUID(), fieldType: 'CUSTOM_DROPDOWN', label: 'Visit preference', aiQuestion: 'Morning or afternoon?',
      options: ['Morning', 'Afternoon'], required: true, confirmationRequired: false, sortOrder: 0,
    };
    const yesNo: Field = {
      id: randomUUID(), fieldType: 'CUSTOM_YES_NO', label: 'Interpreter', aiQuestion: 'Do you need an interpreter?',
      required: true, confirmationRequired: false, sortOrder: 1,
    };
    const consent: Field = {
      id: randomUUID(), fieldType: 'CONSENT', label: 'Messaging consent', aiQuestion: 'May the clinic message you?',
      required: true, confirmationRequired: false, sortOrder: 2,
    };
    const confirmedText: Field = {
      id: randomUUID(), fieldType: 'CUSTOM_TEXT', label: 'Access note', aiQuestion: 'Any access note?',
      required: true, confirmationRequired: true, sortOrder: 3,
    };
    const f = await fixture([dropdown, yesNo, consent, confirmedText]);
    const dropdownKey = intakeFieldKey(dropdown);
    const yesNoKey = intakeFieldKey(yesNo);
    const textKey = intakeFieldKey(confirmedText);
    const exactAnswers = {
      [dropdownKey]: 'Morning', [yesNoKey]: false, messaging_consent: false,
      [textKey]: 'Wheelchair entrance', [`${textKey}_confirmed`]: true,
    };
    const [left, right] = await Promise.all([
      f.invoke({ ...f.baseArgs, ...exactAnswers, appointment_time: '09:00' }),
      f.invoke({ ...f.baseArgs, ...exactAnswers, appointment_time: '09:30' }),
    ]);
    expect(left).toMatchObject({ booked: true });
    expect(right).toMatchObject({ booked: true });
    expect(new Set([left.appointment_id, right.appointment_id]).size).toBe(1);
    expect([left, right].filter(result => result.duplicate === true)).toHaveLength(1);

    const appointment = await db.appointment.findFirstOrThrow({ where: { tenantId: f.tenantId, receptionistCallLogId: f.call.id } });
    const request = await db.appointmentRequest.findFirstOrThrow({ where: { tenantId: f.tenantId, callLogId: f.call.id } });
    expect(request).toMatchObject({ status: 'BOOKED', bookedAppointmentId: appointment.id, patientId: appointment.patientId });
    expect(request.rawCollectedFields).toMatchObject({ ...exactAnswers, booking_confirmed: true, observed_phone: '+15551234567' });
    expect(await db.patient.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await db.appointment.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await db.appointmentRequest.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await db.idempotencyKey.count({ where: { tenantId: f.tenantId, scope: 'receptionist.live-booking' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: f.tenantId, action: 'receptionist.appointment.booked' } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: f.tenantId, eventType: 'receptionist.appointment.booked' } })).toBe(1);

    const replay = await f.invoke({ ...f.baseArgs, ...exactAnswers, appointment_time: '17:00' });
    expect(replay).toMatchObject({ booked: true, duplicate: true, appointment_id: appointment.id });
    expect(await db.appointment.count({ where: { tenantId: f.tenantId } })).toBe(1);
  });

  it.each([
    ['unknown nested input', (args: Record<string, unknown>) => ({ ...args, untrusted: { deeply: { nested: 'discard me' } } })],
    ['booking confirmation false', (args: Record<string, unknown>) => ({ ...args, booking_confirmed: false })],
    ['required field missing', (args: Record<string, unknown>) => { const copy = { ...args }; delete copy.last_name; return copy; }],
    ['oversized scalar', (args: Record<string, unknown>) => ({ ...args, first_name: 'x'.repeat(17_000) })],
  ])('fails closed and idempotently into one bounded review for %s', async (_label, mutate) => {
    const f = await fixture();
    const invalid = mutate(f.baseArgs);
    const first = await f.invoke(invalid);
    const replay = await f.invoke(invalid);
    expect(first).toMatchObject({ booked: false, needs_review: true });
    expect(replay).toMatchObject({ booked: false, needs_review: true, duplicate: true, appointment_request_id: first.appointment_request_id });
    expect(await db.appointment.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect(await db.patient.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect(await db.appointmentRequest.count({ where: { tenantId: f.tenantId } })).toBe(1);
    const request = await db.appointmentRequest.findFirstOrThrow({ where: { tenantId: f.tenantId } });
    expect(request.status).toBe('MISSING_INFO');
    expect(Buffer.byteLength(JSON.stringify(request.rawCollectedFields), 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.stringify(request.rawCollectedFields)).not.toContain('discard me');
    expect(await db.auditEvent.count({ where: { tenantId: f.tenantId, action: 'receptionist.appointmentRequest.needsReview' } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: f.tenantId, eventType: 'receptionist.appointmentRequest.created' } })).toBe(1);
  });

  it('corrects one review into BOOKED and prevents provider lifecycle analysis from rewriting the terminal outcome', async () => {
    const f = await fixture();
    const invalid = await f.invoke({ ...f.baseArgs, booking_confirmed: false });
    expect(invalid).toMatchObject({ booked: false, needs_review: true });
    const requestBefore = await db.appointmentRequest.findFirstOrThrow({ where: { tenantId: f.tenantId } });
    const corrected = await f.invoke(f.baseArgs);
    expect(corrected).toMatchObject({ booked: true });
    const requestAfter = await db.appointmentRequest.findFirstOrThrow({ where: { tenantId: f.tenantId } });
    expect(requestAfter).toMatchObject({ id: requestBefore.id, status: 'BOOKED', bookedAppointmentId: corrected.appointment_id });
    expect(await db.appointmentRequest.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: f.call.id } })).toMatchObject({ outcome: 'BOOKED' });

    const providerAnalysis = JSON.stringify({
      event: 'call_analyzed',
      call: {
        call_id: f.callId, from_number: '+15551234567', direction: 'inbound', duration_ms: 65_000,
        call_analysis: {
          call_summary: 'Conflicting provider lifecycle result after the canonical tool booking.',
          user_sentiment: 'Neutral', custom_analysis_data: { outcome: 'NOT_INTERESTED' },
        },
      },
    });
    const analyzed = await app.inject({
      method: 'POST', url: `/v1/receptionist/webhooks/retell?clinicId=${f.clinic.id}`,
      headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(providerAnalysis, RETELL_KEY) },
      payload: providerAnalysis,
    });
    expect(analyzed.statusCode).toBe(200);
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: f.call.id } })).toMatchObject({
      outcome: 'BOOKED', durationSeconds: 65,
    });
    expect(await db.appointment.count({ where: { tenantId: f.tenantId, receptionistCallLogId: f.call.id } })).toBe(1);
    await expect(db.receptionistCallLog.update({ where: { id: f.call.id }, data: { outcome: 'ESCALATED' } })).rejects.toThrow(/terminal outcome is immutable/i);
    expect((await db.receptionistCallLog.findUniqueOrThrow({ where: { id: f.call.id } })).outcome).toBe('BOOKED');
  });

  it('enforces one Appointment and AppointmentRequest per call and immutable terminal outcomes in PostgreSQL', async () => {
    const f = await fixture();
    const booked = await f.invoke(f.baseArgs);
    expect(booked).toMatchObject({ booked: true });
    const appointment = await db.appointment.findUniqueOrThrow({ where: { id: booked.appointment_id as string } });
    await expect(db.appointment.create({
      data: {
        tenantId: f.tenantId, branchId: f.branch.id, patientId: appointment.patientId,
        providerProfileId: f.provider.id, providerRef: f.provider.id, service: f.service.name,
        serviceCatalogItemId: f.service.id, receptionistCallLogId: f.call.id,
        startsAt: new Date(appointment.startsAt.getTime() + 3_600_000), endsAt: new Date(appointment.endsAt.getTime() + 3_600_000),
        status: 'CONFIRMED', channel: 'CALL',
      },
    })).rejects.toThrow();
    await expect(db.appointmentRequest.create({
      data: { tenantId: f.tenantId, branchId: f.branch.id, callLogId: f.call.id, source: 'test', missingFields: [] },
    })).rejects.toThrow();
    await expect(db.receptionistCallLog.update({ where: { id: f.call.id }, data: { outcome: 'FAILED' } })).rejects.toThrow(/terminal outcome is immutable/i);
    expect(await db.appointment.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await db.appointmentRequest.count({ where: { tenantId: f.tenantId } })).toBe(1);
  });

  it.each([
    ['Patient', 'INSERT', 'TRUE'],
    ['Appointment', 'INSERT', 'TRUE'],
    ['AppointmentRequest', 'INSERT', 'TRUE'],
    ['IdempotencyKey', 'INSERT', `NEW.scope = 'receptionist.live-booking'`],
    ['ReceptionistCallLog', 'UPDATE', `NEW.outcome = 'BOOKED'`],
    ['AuditEvent', 'INSERT', `NEW.action = 'receptionist.appointment.booked'`],
    ['BusinessEvent', 'INSERT', `NEW."eventType" = 'receptionist.appointment.booked'`],
  ] as const)('fully rolls back a %s failure and permits a clean retry', async (table, operation, predicate) => {
    const f = await fixture();
    const baselinePatients = await db.patient.count({ where: { tenantId: f.tenantId } });
    const removeFault = await installFault(f.tenantId, table, operation, predicate);
    await expect(f.invoke(f.baseArgs)).rejects.toThrow(/atomicity failure injection/i);
    expect((await db.receptionistCallLog.findUniqueOrThrow({ where: { id: f.call.id } })).outcome).toBe('IN_PROGRESS');
    expect(await db.patient.count({ where: { tenantId: f.tenantId } })).toBe(baselinePatients);
    expect(await db.appointment.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect(await db.appointmentRequest.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect(await db.idempotencyKey.count({ where: { tenantId: f.tenantId, scope: 'receptionist.live-booking' } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: f.tenantId, action: 'receptionist.appointment.booked' } })).toBe(0);
    expect(await db.businessEvent.count({ where: { tenantId: f.tenantId, eventType: 'receptionist.appointment.booked' } })).toBe(0);
    await removeFault();
    const retry = await f.invoke(f.baseArgs);
    expect(retry).toMatchObject({ booked: true });
    expect(await db.appointment.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await db.appointmentRequest.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await db.idempotencyKey.count({ where: { tenantId: f.tenantId, scope: 'receptionist.live-booking' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: f.tenantId, action: 'receptionist.appointment.booked' } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: f.tenantId, eventType: 'receptionist.appointment.booked' } })).toBe(1);
  });
});
