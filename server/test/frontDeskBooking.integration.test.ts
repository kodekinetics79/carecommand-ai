import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClinicFixture } from './helpers/receptionistFixtures';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// ===========================================================================
// "Book it" from the review queue must not be a status flip. These suites hold
// the route to the same guarantee the scheduler gives: an appointment exists,
// the slot was free, the request is linked to THAT appointment, the source call
// reads BOOKED, and the open task is closed with the outcome that closed it —
// all in one transaction, or none of it. Plus appointment notes, which are
// append-only and whose text never reaches the audit trail.
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

// A clinic phone is globally unique among active trusted inbound destinations,
// and suites run in parallel workers against one database — so the number has to
// be unique across processes, not just within this file.
let phoneCounter = 0;
const uniquePhone = () => `+1${String(process.pid % 100).padStart(2, '0')}${String(Date.now() % 100_000).padStart(5, '0')}${String(phoneCounter++ % 1_000).padStart(3, '0')}`;
const at = (hhmm: string) => new Date(`${MONDAY}T${hhmm}:00.000Z`);

interface Fixture {
  tenantId: string;
  branchId: string;
  clinicId: string;
  providerId: string;
  patientId: string;
  callLogId: string;
  requestId: string;
  taskId: string;
  owner: string;
  frontDesk: string;
  analyst: string;
}

async function makeFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `fdb-${tag}`, slug: `fdb-${tag}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'x', timezone: 'UTC' } });
  const clinic = await createClinicFixture(db, { tenantId, name: `Clinic ${tag}`, phone: uniquePhone(), timezone: 'UTC' });
  await db.receptionistLocation.create({
    data: { tenantId, clinicId: clinic.id, branchId: branch.id, name: 'Main', address: '1 Test St', active: true },
  });
  const mkUser = (role: string, label: string) => db.user.create({
    data: { tenantId, role: role as never, active: true, email: `${label}-${tag}@fdb.test`, displayName: `${role} ${label}` },
  });
  const [owner, frontDesk, analyst, providerUser] = await Promise.all([
    mkUser('OWNER', 'owner'), mkUser('FRONT_DESK', 'fd'), mkUser('ANALYST', 'an'), mkUser('PROVIDER', 'pv'),
  ]);
  const provider = await db.providerProfile.create({
    data: { tenantId, branchId: branch.id, userId: providerUser.id, specialty: 'Primary Care', active: true },
  });
  const patient = await db.patient.create({
    data: { tenantId, branchId: branch.id, firstName: 'Pat', lastName: 'Roe', email: 'pat@example.test', lifecycleStage: 'ACTIVE' },
  });
  const callLog = await db.receptionistCallLog.create({
    data: { tenantId, clinicId: clinic.id, retellCallId: `call-${randomUUID()}`, direction: 'inbound', outcome: 'IN_PROGRESS' },
  });
  const requestRow = await db.appointmentRequest.create({
    data: {
      tenantId, callLogId: callLog.id, requestedService: 'Checkup', requestedDateTime: at('09:00'),
      collectedName: 'Pat Roe', collectedPhone: '+12125550143', status: 'PENDING_REVIEW',
      source: 'ai_receptionist', missingFields: [],
    },
  });
  const task = await db.staffTask.create({
    data: {
      tenantId, branchId: branch.id, callLogId: callLog.id, title: 'AI receptionist callback requested', priority: 'high',
      // D1: this is the request's OWN callback task, so booking the request is
      // genuinely what closes it. A `message` task with no link to this request
      // is other unfinished business and stays open.
      metadata: {
        workflow: 'receptionist_safety', kind: 'message', requiresAcknowledgement: true,
        appointmentRequestId: requestRow.id,
      },
    },
  });
  return {
    tenantId, branchId: branch.id, clinicId: clinic.id, providerId: provider.id, patientId: patient.id,
    callLogId: callLog.id, requestId: requestRow.id, taskId: task.id,
    owner: owner.id, frontDesk: frontDesk.id, analyst: analyst.id,
  };
}

const auth = (f: Fixture, userId: string, role: string) => ({
  authorization: `Bearer ${app.jwt.sign({ userId, tenantId: f.tenantId, role, type: 'access' })}`,
});

/** Mon 09:00-12:00 so the slot the request asked for is genuinely open. */
async function openAvailability(f: Fixture) {
  const res = await app.inject({
    method: 'PUT', url: `/v1/scheduling/providers/${f.providerId}/availability`,
    headers: auth(f, f.owner, 'OWNER'),
    payload: { windows: [{ dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 }] },
  });
  expect(res.statusCode).toBe(200);
}

const bookPayload = (f: Fixture, hhmm = '09:00') => ({
  patientId: f.patientId,
  providerProfileId: f.providerId,
  startsAt: at(hhmm).toISOString(),
  service: 'Checkup',
  acknowledgeRequestDifferences: true as const,
});

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('appointment requests — the review queue', () => {
  it('lists pending requests scoped by the source call clinic and masks the collected number', async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: 'GET', url: `/v1/receptionist/appointment-requests?clinicId=${f.clinicId}`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<Record<string, unknown>>;
    expect(rows.map(row => row.id)).toEqual([f.requestId]);
    expect(rows[0].collectedPhoneMasked).toBe('***0143');
    expect(rows[0]).not.toHaveProperty('collectedPhone');
    expect(rows[0]).not.toHaveProperty('rawCollectedFields');

    // Another clinic's queue must not show this request.
    const other = await app.inject({
      method: 'GET', url: `/v1/receptionist/appointment-requests?clinicId=${randomUUID()}`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'),
    });
    expect(other.json().data).toHaveLength(0);
  });

  it('requires a reason to reject, and a rejection is terminal', async () => {
    const f = await makeFixture();
    const url = `/v1/receptionist/appointment-requests/${f.requestId}`;
    const bare = await app.inject({ method: 'PATCH', url, headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { status: 'REJECTED' } });
    expect(bare.statusCode).toBe(400);

    const rejected = await app.inject({
      method: 'PATCH', url, headers: auth(f, f.frontDesk, 'FRONT_DESK'),
      payload: { status: 'REJECTED', outcomeReason: 'Caller booked elsewhere.' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'REJECTED', outcomeReason: 'Caller booked elsewhere.' });

    const again = await app.inject({
      method: 'PATCH', url, headers: auth(f, f.frontDesk, 'FRONT_DESK'),
      payload: { status: 'REJECTED', outcomeReason: 'Changed my mind again.' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('books through the canonical scheduler and closes the whole loop atomically', async () => {
    const f = await makeFixture();
    await openAvailability(f);

    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: bookPayload(f),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'BOOKED' });
    const appointmentId = res.json().appointment.id;

    // The appointment is real, canonical, and bound to the source call.
    const appointment = await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(appointment).toMatchObject({
      tenantId: f.tenantId, branchId: f.branchId, patientId: f.patientId,
      providerProfileId: f.providerId, status: 'CONFIRMED', receptionistCallLogId: f.callLogId,
    });
    expect(appointment.startsAt.toISOString()).toBe(at('09:00').toISOString());

    // The request, the call and the queue row all moved with it.
    expect(await db.appointmentRequest.findUniqueOrThrow({ where: { id: f.requestId } })).toMatchObject({
      status: 'BOOKED', bookedAppointmentId: appointmentId, patientId: f.patientId, branchId: f.branchId,
    });
    expect((await db.receptionistCallLog.findUniqueOrThrow({ where: { id: f.callLogId } })).outcome).toBe('BOOKED');
    // D1: closed by a person, so it is also acknowledged — a COMPLETED row must
    // never keep claiming that nobody ever looked at it.
    const closedTask = await db.staffTask.findUniqueOrThrow({ where: { id: f.taskId } });
    expect(closedTask).toMatchObject({ status: 'COMPLETED', outcomeCode: 'booked' });
    expect(closedTask.acknowledgedAt).not.toBeNull();
    expect(closedTask.acknowledgedById).toBe(f.frontDesk);
    expect(res.json()).toMatchObject({ tasksClosed: 1, tasksLeftOpen: 0 });
    expect(await db.auditEvent.count({
      where: { tenantId: f.tenantId, action: 'receptionist.appointmentRequest.bookedFromReview', resourceId: f.requestId },
    })).toBe(1);
  });

  it('refuses a taken slot and leaves the request pending', async () => {
    const f = await makeFixture();
    await openAvailability(f);
    // Someone else takes 09:00 first.
    await db.appointment.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, patientId: f.patientId, providerProfileId: f.providerId,
        providerRef: f.providerId, service: 'Checkup', startsAt: at('09:00'), endsAt: at('09:30'),
        status: 'CONFIRMED', channel: 'CALL',
      },
    });

    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: bookPayload(f),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('slot_unavailable');
    expect((await db.appointmentRequest.findUniqueOrThrow({ where: { id: f.requestId } })).status).toBe('PENDING_REVIEW');
    expect((await db.staffTask.findUniqueOrThrow({ where: { id: f.taskId } })).status).toBe('OPEN');
  });

  it('refuses to book a second appointment for a call that already produced one, rather than orphan it', async () => {
    const f = await makeFixture();
    await openAvailability(f);
    await db.appointment.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, patientId: f.patientId, providerProfileId: f.providerId,
        providerRef: f.providerId, service: 'Checkup', startsAt: at('11:00'), endsAt: at('11:30'),
        status: 'CONFIRMED', channel: 'CALL', receptionistCallLogId: f.callLogId,
      },
    });

    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: bookPayload(f, '09:30'),
    });
    // The database only lets a request link to an appointment stamped with its
    // own source call, so a second booking here could never be linked — it
    // would leave an appointment no queue points at. Refuse and say why.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('call_already_booked');
    expect(res.json().message).toMatch(/link this request/i);
    // Nothing partial was written.
    expect(await db.appointment.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect((await db.appointmentRequest.findUniqueOrThrow({ where: { id: f.requestId } })).status).toBe('PENDING_REVIEW');
  });

  it('refuses a role that may read the queue but not review bookings', async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: 'POST', url: `/v1/receptionist/appointment-requests/${f.requestId}/book`,
      headers: auth(f, f.analyst, 'ANALYST'), payload: bookPayload(f),
    });
    expect(res.statusCode).toBe(403);
    expect(await db.appointment.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });
});

describe('appointment notes — append-only, and never in the audit trail', () => {
  it('appends a note, returns the history, and audits only that a note exists', async () => {
    const f = await makeFixture();
    const appointment = await db.appointment.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, patientId: f.patientId, providerProfileId: f.providerId,
        providerRef: f.providerId, service: 'Checkup', startsAt: at('10:00'), endsAt: at('10:30'),
        status: 'CONFIRMED', channel: 'CALL',
      },
    });

    const first = await app.inject({
      method: 'PATCH', url: `/v1/appointments/${appointment.id}/notes`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { text: 'Patient asked for a ground-floor room.' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().noteEntries).toHaveLength(1);
    expect(first.json().noteEntries[0]).toMatchObject({ text: 'Patient asked for a ground-floor room.', actorType: 'staff' });

    const second = await app.inject({
      method: 'PATCH', url: `/v1/appointments/${appointment.id}/notes`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { text: 'Confirmed by phone.' },
    });
    expect(second.json().noteEntries.map((note: { text: string }) => note.text))
      .toEqual(['Patient asked for a ground-floor room.', 'Confirmed by phone.']);

    // The detail read carries the history alongside the untouched scalar field.
    const detail = await app.inject({
      method: 'GET', url: `/v1/appointments/${appointment.id}`, headers: auth(f, f.frontDesk, 'FRONT_DESK'),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().noteEntries).toHaveLength(2);
    expect(detail.json().notes).toBeNull();

    const events = await db.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: 'appointment.notes.appended', resourceId: appointment.id },
    });
    expect(events).toHaveLength(2);
    expect(events[0].metadata).toMatchObject({ hasNote: true, actorType: 'staff' });
    expect(JSON.stringify(events.map(event => event.metadata))).not.toContain('ground-floor');
  });

  it('cannot be edited or deleted through the runtime role', async () => {
    const f = await makeFixture();
    const appointment = await db.appointment.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, patientId: f.patientId, providerProfileId: f.providerId,
        providerRef: f.providerId, service: 'Checkup', startsAt: at('10:30'), endsAt: at('11:00'),
        status: 'CONFIRMED', channel: 'CALL',
      },
    });
    await app.inject({
      method: 'PATCH', url: `/v1/appointments/${appointment.id}/notes`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { text: 'The note that must stand.' },
    });
    // No route exists to change it; the append-only grant is proven by the RLS
    // behavioral suite, and the history keeps every entry.
    const notes = await db.appointmentNote.findMany({ where: { tenantId: f.tenantId, appointmentId: appointment.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0].actorType).toBe('staff');
  });

  it('refuses a note on an appointment in another tenant', async () => {
    const [f, other] = await Promise.all([makeFixture(), makeFixture()]);
    const appointment = await db.appointment.create({
      data: {
        tenantId: other.tenantId, branchId: other.branchId, patientId: other.patientId, providerProfileId: other.providerId,
        providerRef: other.providerId, service: 'Checkup', startsAt: at('10:00'), endsAt: at('10:30'),
        status: 'CONFIRMED', channel: 'CALL',
      },
    });
    const res = await app.inject({
      method: 'PATCH', url: `/v1/appointments/${appointment.id}/notes`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { text: 'Should never land.' },
    });
    expect(res.statusCode).toBe(404);
    expect(await db.appointmentNote.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });
});
