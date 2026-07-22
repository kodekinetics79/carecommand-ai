import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

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
const { db } = await import('../lib/db');
const { recomputeEntitlements } = await import('../lib/entitlements');

let app: FastifyInstance;
const tenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `bk-${id.slice(0, 6)}`, slug: `bk-${id.slice(0, 8)}` } });
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'X', active: true }, select: { id: true } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@bk.test`, displayName: 'Admin' }, select: { id: true } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@bk.test`, displayName: 'Dr' }, select: { id: true } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care' }, select: { id: true } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Roe', lifecycleStage: 'ACTIVE' }, select: { id: true } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Clinic', phone: '+15550000000' }, select: { id: true } });
  return { id, branchId: branch.id, adminId: admin.id, providerId: provider.id, patientId: patient.id, clinicId: clinic.id };
}
type T = Awaited<ReturnType<typeof makeTenant>>;
const adminAuth = (t: T) => ({ authorization: `Bearer ${app.jwt.sign({ userId: t.adminId, tenantId: t.id, role: 'ADMIN', type: 'access' })}` });
const futureDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function fn(clinicId: string, name: string, args: Record<string, unknown>, callId = `c-${randomUUID()}`, fromNumber?: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/receptionist/webhooks/retell/fn?clinicId=${clinicId}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, args, call: { call_id: callId, from_number: fromNumber } }),
  });
  return res;
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('receptionist /fn booking — real availability + booking', () => {
  it('check_availability returns real open slots and book_appointment creates a real appointment', async () => {
    const t = await makeTenant();
    const date = futureDate(3);
    const avail = (await fn(t.clinicId, 'check_availability', { appointment_date: date })).json() as { available: boolean; slots: Array<{ time: string; label: string }> };
    expect(avail.available).toBe(true);
    expect(avail.slots.length).toBeGreaterThan(0);
    expect(avail.slots[0]).toHaveProperty('label');

    const slot = avail.slots[0].time;
    const book = (await fn(t.clinicId, 'book_appointment', { first_name: 'Jane', last_name: 'Doe', appointment_date: date, appointment_time: slot, service: 'Cleaning' }, `c-${randomUUID()}`, '+15551230000')).json() as { booked: boolean; appointment_id?: string };
    expect(book.booked).toBe(true);
    expect(book.appointment_id).toBeTruthy();
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(1);

    const avail2 = (await fn(t.clinicId, 'check_availability', { appointment_date: date })).json() as { slots: Array<{ time: string }> };
    expect(avail2.slots.some(s => s.time === slot)).toBe(false);
  });

  it('two concurrent bookings for the SAME slot → exactly one succeeds (advisory-lock guard)', async () => {
    const t = await makeTenant();
    const date = futureDate(4);
    const avail = (await fn(t.clinicId, 'check_availability', { appointment_date: date })).json() as { slots: Array<{ time: string }> };
    const slot = avail.slots[0].time;

    const [r1, r2] = await Promise.all([
      fn(t.clinicId, 'book_appointment', { first_name: 'A', last_name: 'One', appointment_date: date, appointment_time: slot }, `call-one-${randomUUID()}`, '+15551110001'),
      fn(t.clinicId, 'book_appointment', { first_name: 'B', last_name: 'Two', appointment_date: date, appointment_time: slot }, `call-two-${randomUUID()}`, '+15551110002'),
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
    const avail = (await fn(t.clinicId, 'check_availability', { appointment_date: date })).json() as { slots: Array<{ time: string }> };
    expect(avail.slots.some(s => s.time === '10:00')).toBe(false);

    // ...and refuses to book it, gracefully.
    const book = (await fn(t.clinicId, 'book_appointment', { first_name: 'Late', last_name: 'Caller', appointment_date: date, appointment_time: '10:00' }, `c-${randomUUID()}`, '+15551119999')).json() as { booked: boolean; message: string };
    expect(book.booked).toBe(false);
    expect(book.message).toMatch(/just taken|another time/i);
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(1); // only the scheduling-API one
  });

  it('malformed date/time degrades to an appointment-request-needing-review (never crashes, never books nonsense)', async () => {
    const t = await makeTenant();
    const res = await fn(t.clinicId, 'book_appointment', { first_name: 'Bad', last_name: 'Data', appointment_date: 'sometime next week', appointment_time: 'noon', service: 'Cleaning' }, `c-${randomUUID()}`, '+15551112222');
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
});

describe('receptionist outbound dial — opt-out gate (FIX 4)', () => {
  it('never dials an opted-out number: records OPTED_OUT + skips, no call placed', async () => {
    const t = await makeTenant();
    const optedPhone = '+15553330001';
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: optedPhone, channel: 'ALL', reason: 'AI call' } });
    const campaign = await db.receptionistOutboundCampaign.create({ data: { tenantId: t.id, clinicId: t.clinicId, name: 'Cleanup', script: 'Call the patient.', requiredFields: ['firstName', 'lastName', 'phone'] }, select: { id: true } });

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
    const campaign = await db.receptionistOutboundCampaign.create({ data: { tenantId: t.id, clinicId: t.clinicId, name: 'Cleanup', script: 'Call the patient.', requiredFields: ['firstName', 'lastName', 'phone'] }, select: { id: true } });
    const res = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers: adminAuth(t), payload: { phone: '+15553330002', firstName: 'Fresh', lastName: 'Lead' } });
    expect(res.statusCode).toBe(200);
    // Retell is unconfigured in test → the gate passed and we reach setup_required
    // (proving the opt-out gate is specific, not a blanket skip).
    expect((res.json() as { status: string }).status).toBe('setup_required');
  });
});
