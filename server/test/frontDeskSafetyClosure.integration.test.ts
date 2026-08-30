import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClinicFixture } from './helpers/receptionistFixtures';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// ===========================================================================
// Package D — "The board is true", the closure half.
//
// D1 (P0, patient safety). Booking one appointment used to COMPLETE every live
// receptionist task on the call: the `updateMany` filtered `workflow` and had
// NO `kind` filter. So a caller who mentioned chest pain and also asked for a
// slot had the EMERGENCY cleared off the queue by an unrelated booking click —
// acknowledgedAt still null, the critical OperationalSignal still open, and a
// terminal task cannot be reopened. There was no recovery.
//
// These suites pin the rule that replaces it: a booking closes exactly the work
// the booking did, and nothing a human still owes the caller.
//
// D2 — the same route had no branch guard at all, so a FRONT_DESK user pinned
// to branch B could write an Appointment, and a new Patient, into branch A.
// D12 — a cancelled appointment blocked re-booking the call forever, and a
// returning patient registered at another branch could not be booked as
// themselves at all.
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
const { createSafetyTask } = await import('../lib/receptionist/frontDeskTask');
const { bookingClosesTask, BOOKING_NEVER_CLOSES } = await import('../modules/receptionist/activity');
const { runWithWebhookTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const tenantIds: string[] = [];

function nextMondayISO(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 1);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}
const MONDAY = nextMondayISO();
const at = (hhmm: string) => new Date(`${MONDAY}T${hhmm}:00.000Z`);

let phoneCounter = 0;
const uniquePhone = () => `+1${String(process.pid % 100).padStart(2, '0')}${String(Date.now() % 100_000).padStart(5, '0')}${String(phoneCounter++ % 1_000).padStart(3, '0')}`;

const CALLER = '+12125550188';

interface Fixture {
  tenantId: string;
  branchA: string;
  branchB: string;
  clinicId: string;
  providerA: string;
  providerB: string;
  patientA: string;
  patientB: string;
  callLogId: string;
  retellCallId: string;
  requestId: string;
  owner: string;
  frontDeskA: string;
  frontDeskB: string;
}

async function makeFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `fdsc-${tag}`, slug: `fdsc-${tag}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId, name: 'Branch A', location: 'A', timezone: 'UTC' } }),
    db.branch.create({ data: { tenantId, name: 'Branch B', location: 'B', timezone: 'UTC' } }),
  ]);
  const clinic = await createClinicFixture(db, { tenantId, name: `Clinic ${tag}`, phone: uniquePhone(), timezone: 'UTC' });
  // Exactly one active mapped location, so createSafetyTask resolves branch A.
  await db.receptionistLocation.create({
    data: { tenantId, clinicId: clinic.id, branchId: branchA.id, name: 'Main', address: '1 Test St', active: true },
  });
  const mkUser = (role: string, branchId: string | null, label: string) => db.user.create({
    data: { tenantId, role: role as never, active: true, branchId, email: `${label}-${tag}@fdsc.test`, displayName: `${role} ${label}` },
  });
  const [owner, frontDeskA, frontDeskB, provUserA, provUserB] = await Promise.all([
    mkUser('OWNER', null, 'owner'),
    mkUser('FRONT_DESK', branchA.id, 'fd-a'),
    mkUser('FRONT_DESK', branchB.id, 'fd-b'),
    mkUser('PROVIDER', branchA.id, 'pv-a'),
    mkUser('PROVIDER', branchB.id, 'pv-b'),
  ]);
  const [providerA, providerB] = await Promise.all([
    db.providerProfile.create({ data: { tenantId, branchId: branchA.id, userId: provUserA.id, specialty: 'Primary Care', active: true } }),
    db.providerProfile.create({ data: { tenantId, branchId: branchB.id, userId: provUserB.id, specialty: 'Primary Care', active: true } }),
  ]);
  const [patientA, patientB] = await Promise.all([
    db.patient.create({ data: { tenantId, branchId: branchA.id, firstName: 'Pat', lastName: 'Aye', lifecycleStage: 'ACTIVE' } }),
    db.patient.create({ data: { tenantId, branchId: branchB.id, firstName: 'Bee', lastName: 'Bee', lifecycleStage: 'ACTIVE' } }),
  ]);
  const retellCallId = `call-${randomUUID()}`;
  const callLog = await db.receptionistCallLog.create({
    data: { tenantId, clinicId: clinic.id, retellCallId, callerPhone: CALLER, direction: 'inbound', outcome: 'IN_PROGRESS' },
  });
  const requestRow = await db.appointmentRequest.create({
    data: {
      tenantId, callLogId: callLog.id, requestedService: 'Checkup', requestedDateTime: at('09:00'),
      collectedName: 'Pat Aye', collectedPhone: '+12125550143', status: 'PENDING_REVIEW',
      source: 'ai_receptionist', missingFields: [],
    },
  });
  return {
    tenantId, branchA: branchA.id, branchB: branchB.id, clinicId: clinic.id,
    providerA: providerA.id, providerB: providerB.id, patientA: patientA.id, patientB: patientB.id,
    callLogId: callLog.id, retellCallId, requestId: requestRow.id,
    owner: owner.id, frontDeskA: frontDeskA.id, frontDeskB: frontDeskB.id,
  };
}

const auth = (f: Fixture, userId: string, role: string) => ({
  authorization: `Bearer ${app.jwt.sign({ userId, tenantId: f.tenantId, role, type: 'access' })}`,
});

function fileTask(f: Fixture, kind: Parameters<typeof createSafetyTask>[1], args: Record<string, unknown> = {}) {
  return runWithWebhookTenantContext(
    f.tenantId,
    () => createSafetyTask({ tenantId: f.tenantId, callId: f.retellCallId, callerPhone: CALLER }, kind, args),
    'webhook:test-front-desk-closure',
  );
}

async function openAvailability(f: Fixture, providerId: string) {
  const res = await app.inject({
    method: 'PUT', url: `/v1/scheduling/providers/${providerId}/availability`,
    headers: auth(f, f.owner, 'OWNER'),
    payload: { windows: [{ dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 }] },
  });
  expect(res.statusCode).toBe(200);
}

const bookPayload = (f: Fixture, overrides: Record<string, unknown> = {}) => ({
  patientId: f.patientA,
  providerProfileId: f.providerA,
  startsAt: at('09:00').toISOString(),
  service: 'Checkup',
  acknowledgeRequestDifferences: true as const,
  ...overrides,
});

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  await db.idempotencyKey.deleteMany({ where: { tenantId: { in: tenantIds }, scope: 'receptionist.live-safety' } }).catch(() => undefined);
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('D1 — the rule itself', () => {
  const requestId = randomUUID();
  const otherRequestId = randomUUID();

  it('never closes a kind a human still owes the caller, however the task is linked', () => {
    for (const kind of BOOKING_NEVER_CLOSES) {
      expect(bookingClosesTask({ kind, appointmentRequestId: requestId }, requestId)).toBe(false);
      expect(bookingClosesTask({ kind, appointmentRequestId: null }, requestId)).toBe(false);
    }
  });

  it('closes the review this booking performed, and a message only when it is this request’s', () => {
    expect(bookingClosesTask({ kind: 'booking_review', appointmentRequestId: null }, requestId)).toBe(true);
    expect(bookingClosesTask({ kind: 'message', appointmentRequestId: requestId }, requestId)).toBe(true);
    expect(bookingClosesTask({ kind: 'missed_call', appointmentRequestId: requestId }, requestId)).toBe(true);
    expect(bookingClosesTask({ kind: 'message', appointmentRequestId: otherRequestId }, requestId)).toBe(false);
    expect(bookingClosesTask({ kind: 'message', appointmentRequestId: null }, requestId)).toBe(false);
  });
});

describe('D1 — booking a slot never closes the emergency from the same call', () => {
  it('leaves the unacknowledged emergency open, unacknowledged, with its critical signal still open', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerA);

    // One call: the caller mentioned chest pain AND asked for a slot.
    const emergency = await fileTask(f, 'emergency', { reason_category: 'chest_pain' });
    const review = await fileTask(f, 'booking_review', { reason_category: 'possible_duplicate' });

    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.frontDeskA, 'FRONT_DESK'), payload: bookPayload(f),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'BOOKED', tasksClosed: 1, tasksLeftOpen: 1 });

    // The emergency is exactly as the caller left it.
    const emergencyRow = await db.staffTask.findUniqueOrThrow({ where: { id: emergency.taskId } });
    expect(emergencyRow.status).toBe('OPEN');
    expect(emergencyRow.acknowledgedAt).toBeNull();
    expect(emergencyRow.outcomeCode).toBeNull();
    expect(emergencyRow.completedAt).toBeNull();

    // And so is the signal that raises it on the board.
    const signal = await db.operationalSignal.findFirstOrThrow({
      where: { tenantId: f.tenantId, entityType: 'staffTask', entityId: emergency.taskId },
    });
    expect(signal).toMatchObject({ severity: 'critical', status: 'open' });

    // The booking review the booking actually performed IS closed — and
    // acknowledged, because a person did it.
    const reviewRow = await db.staffTask.findUniqueOrThrow({ where: { id: review.taskId } });
    expect(reviewRow).toMatchObject({ status: 'COMPLETED', outcomeCode: 'booked' });
    expect(reviewRow.acknowledgedAt).not.toBeNull();
    expect(reviewRow.acknowledgedById).toBe(f.frontDeskA);
  });

  it('leaves a human handoff and a locked identity open too', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerA);
    const handoff = await fileTask(f, 'human_handoff', { reason_category: 'wants_a_person' });
    const locked = await fileTask(f, 'identity_locked', { reason_category: 'dob_mismatch' });

    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.owner, 'OWNER'), payload: bookPayload(f),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ tasksClosed: 0, tasksLeftOpen: 2 });
    for (const id of [handoff.taskId, locked.taskId]) {
      expect((await db.staffTask.findUniqueOrThrow({ where: { id } })).status).toBe('OPEN');
    }
  });

  it('closes a message task only when it points at the request being booked', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerA);
    // Unrelated business the caller also left on the call.
    const unrelated = await fileTask(f, 'message', { message: 'Also, please post my referral letter.' });
    // The request's own callback task.
    const linked = await db.staffTask.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchA, callLogId: f.callLogId,
        title: 'AI receptionist callback requested', priority: 'high',
        metadata: {
          workflow: 'receptionist_safety', kind: 'message', requiresAcknowledgement: true,
          appointmentRequestId: f.requestId,
        },
      },
    });

    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.owner, 'OWNER'), payload: bookPayload(f),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ tasksClosed: 1, tasksLeftOpen: 1 });
    expect((await db.staffTask.findUniqueOrThrow({ where: { id: linked.id } })).status).toBe('COMPLETED');
    expect((await db.staffTask.findUniqueOrThrow({ where: { id: unrelated.taskId } })).status).toBe('OPEN');
  });

  it('resolves the open signal behind a task the booking did close', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerA);
    const review = await fileTask(f, 'booking_review', {});
    await db.operationalSignal.create({ data: {
      tenantId: f.tenantId, signalType: 'receptionist_booking_review', entityType: 'staffTask', entityId: review.taskId,
      severity: 'medium', score: 40, reason: 'A booking made on a call needs a person to confirm it.',
    } });

    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.owner, 'OWNER'), payload: bookPayload(f),
    });
    expect(res.statusCode).toBe(201);
    const signal = await db.operationalSignal.findFirstOrThrow({
      where: { tenantId: f.tenantId, entityType: 'staffTask', entityId: review.taskId },
    });
    expect(signal.status).toBe('resolved');
  });
});

describe('D2 — the booking route enforces the branch the caller may write to', () => {
  it('refuses a branch-restricted user booking another branch’s provider, and creates no patient', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerA);
    const before = await db.patient.count({ where: { tenantId: f.tenantId } });

    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.frontDeskB, 'FRONT_DESK'),
      payload: {
        createPatient: { firstName: 'New', lastName: 'Caller', phone: '+12125550101' },
        providerProfileId: f.providerA,
        startsAt: at('09:00').toISOString(),
        service: 'Checkup',
        acknowledgeRequestDifferences: true as const,
      },
    });
    expect(res.statusCode).toBe(403);
    // RLS is tenant-level only: nothing but this guard stops the write.
    expect(await db.patient.count({ where: { tenantId: f.tenantId } })).toBe(before);
    expect(await db.appointment.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect((await db.appointmentRequest.findUniqueOrThrow({ where: { id: f.requestId } })).status).toBe('PENDING_REVIEW');
  });

  it('lets a tenant-wide user book either branch', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerB);
    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.owner, 'OWNER'),
      payload: bookPayload(f, { providerProfileId: f.providerB, patientId: f.patientB }),
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('D12 — a cancelled visit and a cross-branch patient are both recoverable', () => {
  it('re-books a call whose only appointment was cancelled, instead of a permanent 409', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerA);
    const dead = await db.appointment.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchA, patientId: f.patientA, providerProfileId: f.providerA,
        service: 'Checkup', startsAt: at('08:00'), endsAt: at('08:30'), status: 'CANCELED',
        channel: 'CALL', receptionistCallLogId: f.callLogId,
      },
    });

    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.owner, 'OWNER'), payload: bookPayload(f),
    });
    expect(res.statusCode).toBe(201);
    // The dead row gave the call link up so the live one could take it; the
    // release is on the audit event, not silently lost.
    expect((await db.appointment.findUniqueOrThrow({ where: { id: dead.id } })).receptionistCallLogId).toBeNull();
    const event = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: 'receptionist.appointmentRequest.bookedFromReview', resourceId: f.requestId },
    });
    expect((event.metadata as { releasedAppointmentId: string }).releasedAppointmentId).toBe(dead.id);
  });

  it('still refuses when the call already produced a LIVE appointment', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerA);
    await db.appointment.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchA, patientId: f.patientA, providerProfileId: f.providerA,
        service: 'Checkup', startsAt: at('08:00'), endsAt: at('08:30'), status: 'CONFIRMED',
        channel: 'CALL', receptionistCallLogId: f.callLogId,
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.owner, 'OWNER'), payload: bookPayload(f),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'call_already_booked' });
  });

  it('books an existing patient registered at another branch, and says so', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerA);
    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.owner, 'OWNER'), payload: bookPayload(f, { patientId: f.patientB }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ crossBranchPatient: true });
    // One patient record, not a fork of their clinical history.
    expect(await db.patient.count({ where: { tenantId: f.tenantId } })).toBe(2);
    const appointment = await db.appointment.findFirstOrThrow({ where: { tenantId: f.tenantId } });
    expect(appointment.patientId).toBe(f.patientB);
  });

  it('a branch-restricted user still cannot reach a patient outside their branch', async () => {
    const f = await makeFixture();
    await openAvailability(f, f.providerA);
    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.frontDeskA, 'FRONT_DESK'), payload: bookPayload(f, { patientId: f.patientB }),
    });
    expect(res.statusCode).toBe(400);
  });
});
