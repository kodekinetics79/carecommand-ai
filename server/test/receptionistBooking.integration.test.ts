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
  const now = new Date();
  const agent = await db.receptionistAgent.create({ data: {
    tenantId: id, clinicId: clinic.id, name: 'Avery', active: true,
    providerAgentId: `agent_${id.replaceAll('-', '')}`, providerVersionTag: 'prod', providerVersion: 1,
    providerStatus: 'VERIFIED', providerPublished: true, providerAssignedTags: ['prod'], providerFingerprint: 'b'.repeat(64),
    providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
    providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'], providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
    providerResponseEngineType: 'retell-llm', providerResponseEngineId: `llm_${id.replaceAll('-', '')}`,
    providerConfigRevision: 1, providerVerifiedRevision: 1, providerVerifiedAt: now,
    providerVerificationExpiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
  }, select: { id: true } });
  return { id, branchId: branch.id, adminId: admin.id, providerId: provider.id, patientId: patient.id, clinicId: clinic.id, agentId: agent.id };
}
type T = Awaited<ReturnType<typeof makeTenant>>;
const adminAuth = (t: T) => ({ authorization: `Bearer ${app.jwt.sign({ userId: t.adminId, tenantId: t.id, role: 'ADMIN', type: 'access' })}` });
const futureDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function fn(t: Pick<T, 'id' | 'clinicId'>, name: string, args: Record<string, unknown>, callId = `c-${randomUUID()}`, fromNumber?: string) {
  const existing = await db.receptionistCallLog.findFirst({ where: { tenantId: t.id, retellCallId: callId }, select: { id: true } });
  if (!existing) await db.receptionistCallLog.create({
    data: { tenantId: t.id, clinicId: t.clinicId, retellCallId: callId, callerPhone: fromNumber, direction: 'inbound', outcome: 'IN_PROGRESS' },
  });
  // Booking is a protected operation. Exercise the same signed consent tool
  // that a live agent must call after the opening disclosure instead of
  // mutating fixture state around the production gate.
  if (name === 'book_appointment') {
    const consentRaw = JSON.stringify({
      name: 'record_recording_preference',
      args: { recording_decision: 'GRANTED', jurisdiction: 'test' },
      call: { call_id: callId, from_number: fromNumber, direction: 'inbound' },
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
  const raw = JSON.stringify({ name, args, call: { call_id: callId, from_number: fromNumber, direction: 'inbound' } });
  const res = await app.inject({
    method: 'POST',
    url: `/v1/receptionist/webhooks/retell/fn?clinicId=${t.clinicId}`,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) },
    payload: raw,
  });
  return res;
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
  it('uses the branch timezone and canonical catalog duration for offers and booking', async () => {
    const t = await makeTenant();
    await db.branch.update({ where: { id: t.branchId }, data: { timezone: 'America/New_York' } });
    const service = await db.serviceCatalogItem.create({
      data: { tenantId: t.id, name: 'Extended Consultation', category: 'general', defaultDurationMinutes: 45, active: true },
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
    expect(losers[0].message).toMatch(/just taken|another time/i); // graceful, speakable
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
    expect(book.message).toMatch(/just taken|another time/i);
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

  it('fails closed when clinic location is ambiguous', async () => {
    const t = await makeTenant();
    await db.branch.create({ data: { tenantId: t.id, name: 'Second', location: 'Y', timezone: 'America/Chicago', active: true } });
    const result = (await fn(t, 'check_availability', { appointment_date: futureDate(3), service: 'Consultation' })).json() as { available: boolean; needs_review?: boolean; slots: unknown[] };
    expect(result.available).toBe(false);
    expect(result.needs_review).toBe(true);
    expect(result.slots).toHaveLength(0);
  });
});

describe('receptionist outbound dial — opt-out gate (FIX 4)', () => {
  it('never dials an opted-out number: records OPTED_OUT + skips, no call placed', async () => {
    const t = await makeTenant();
    const optedPhone = '+15553330001';
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: optedPhone, channel: 'ALL', reason: 'AI call' } });
    const campaign = await db.receptionistOutboundCampaign.create({ data: { tenantId: t.id, clinicId: t.clinicId, agentId: t.agentId, name: 'Cleanup', script: 'Call the patient.', requiredFields: ['firstName', 'lastName', 'phone'], status: 'RUNNING' }, select: { id: true } });

    const res = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers: adminAuth(t), payload: { phone: optedPhone, firstName: 'Opted', lastName: 'Out' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; reason?: string };
    expect(body.status).toBe('skipped');
    expect(body.reason).toBe('opted_out');

    // Recorded as OPTED_OUT and NEVER dialed (no IN_PROGRESS call log).
    expect(await db.receptionistCallLog.count({ where: { tenantId: t.id, callerPhone: optedPhone, outcome: 'OPTED_OUT' } })).toBe(1);
    expect(await db.receptionistCallLog.count({ where: { tenantId: t.id, outcome: 'IN_PROGRESS' } })).toBe(0);
  });

  it('a non-opted-out number is NOT skipped by the gate (contrast: falls through to provider setup)', async () => {
    const t = await makeTenant();
    const campaign = await db.receptionistOutboundCampaign.create({ data: { tenantId: t.id, clinicId: t.clinicId, agentId: t.agentId, name: 'Cleanup', script: 'Call the patient.', requiredFields: ['firstName', 'lastName', 'phone'], status: 'RUNNING' }, select: { id: true } });
    const res = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers: adminAuth(t), payload: { phone: '+15553330002', firstName: 'Fresh', lastName: 'Lead' } });
    expect(res.statusCode).toBe(200);
    // Retell is unconfigured in test → the gate passed and we reach setup_required
    // (proving the opt-out gate is specific, not a blanket skip).
    expect((res.json() as { status: string }).status).toBe('setup_required');
  });
});
