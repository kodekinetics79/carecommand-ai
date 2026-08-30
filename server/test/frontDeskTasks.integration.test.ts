import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClinicFixture } from './helpers/receptionistFixtures';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// ===========================================================================
// The front desk queue is the only place a caller's unfinished business lives,
// so these suites hold it to the promises the AI makes on the phone:
//   - a second message on the SAME call is added to the same task, never
//     swallowed as a duplicate, and never lost to a task someone already closed;
//   - the caller-stated callback number and the network-verified one stay apart;
//   - a task nobody could assign a branch to is visible to every branch, not to
//     nobody;
//   - a role without receptionist call-artifact access sees that work exists
//     without seeing who called or what they said, and NO surface ever prints
//     an unmasked phone number;
//   - closing a loop requires saying how it closed.
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
const { runWithWebhookTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const tenantIds: string[] = [];

// A clinic phone is globally unique among active trusted inbound destinations,
// and suites run in parallel workers against one database — so the number has to
// be unique across processes, not just within this file.
let phoneCounter = 0;
const uniquePhone = () => `+1${String(process.pid % 100).padStart(2, '0')}${String(Date.now() % 100_000).padStart(5, '0')}${String(phoneCounter++ % 1_000).padStart(3, '0')}`;

const VERIFIED = '+12125550177';
const REQUESTED = '+12125550999';

interface Fixture {
  tenantId: string;
  branchA: string;
  branchB: string;
  clinicId: string;
  callLogId: string;
  retellCallId: string;
  owner: string;
  frontDeskA: string;
  provider: string;
  analyst: string;
}

async function makeFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `fd-${tag}`, slug: `fd-${tag}` } });
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId, name: 'Branch A', location: 'A', timezone: 'UTC' } }),
    db.branch.create({ data: { tenantId, name: 'Branch B', location: 'B', timezone: 'UTC' } }),
  ]);
  const clinic = await createClinicFixture(db, { tenantId, name: `Clinic ${tag}`, phone: uniquePhone(), timezone: 'UTC' });
  // Exactly one active location with a branch → createSafetyTask can resolve it.
  await db.receptionistLocation.create({
    data: { tenantId, clinicId: clinic.id, branchId: branchA.id, name: 'Main', address: '1 Test St', active: true },
  });
  const retellCallId = `call-${randomUUID()}`;
  const callLog = await db.receptionistCallLog.create({
    data: { tenantId, clinicId: clinic.id, retellCallId, callerPhone: VERIFIED, direction: 'inbound' },
  });
  const mkUser = (role: string, branchId: string | null, label: string) => db.user.create({
    data: { tenantId, role: role as never, active: true, branchId, email: `${label}-${tag}@fd.test`, displayName: `${role} ${label}` },
  });
  const [owner, frontDeskA, provider, analyst] = await Promise.all([
    mkUser('OWNER', null, 'owner'),
    mkUser('FRONT_DESK', branchA.id, 'fd-a'),
    mkUser('PROVIDER', null, 'prov'),
    mkUser('ANALYST', null, 'analyst'),
  ]);
  return {
    tenantId, branchA: branchA.id, branchB: branchB.id, clinicId: clinic.id,
    callLogId: callLog.id, retellCallId,
    owner: owner.id, frontDeskA: frontDeskA.id, provider: provider.id, analyst: analyst.id,
  };
}

const auth = (f: Fixture, userId: string, role: string) => ({
  authorization: `Bearer ${app.jwt.sign({ userId, tenantId: f.tenantId, role, type: 'access' })}`,
});

function fileTask(f: Fixture, kind: Parameters<typeof createSafetyTask>[1], args: Record<string, unknown>, callId?: string, invocationId?: string) {
  return runWithWebhookTenantContext(
    f.tenantId,
    () => createSafetyTask(
      { tenantId: f.tenantId, callId: callId ?? f.retellCallId, callerPhone: VERIFIED, providerInvocationId: invocationId },
      kind,
      args,
    ),
    'webhook:test-front-desk',
  );
}

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  await db.idempotencyKey.deleteMany({ where: { tenantId: { in: tenantIds }, scope: 'receptionist.live-safety' } }).catch(() => undefined);
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('createSafetyTask — one task per live call, and never a lost message', () => {
  it('links the call, clinic and branch, and keeps the requested number apart from the verified one', async () => {
    const f = await makeFixture();
    const result = await fileTask(f, 'message', {
      caller_name: 'Jordan Caller', callback_phone: REQUESTED,
      reason_category: 'callback_requested', message: 'Please call me about my crown.',
    });
    expect(result).toMatchObject({ duplicate: false, appended: false });

    const task = await db.staffTask.findUniqueOrThrow({ where: { id: result.taskId } });
    expect(task).toMatchObject({ branchId: f.branchA, callLogId: f.callLogId, status: 'OPEN', priority: 'high' });
    expect(task.metadata).toMatchObject({
      workflow: 'receptionist_safety', kind: 'message',
      verifiedPhone: VERIFIED, requestedCallbackPhone: REQUESTED, callbackPhone: REQUESTED,
      clinicId: f.clinicId, requiresAcknowledgement: true,
    });
    // The default message SLA is 30 minutes from now.
    const dueInMinutes = (task.dueAt!.getTime() - Date.now()) / 60_000;
    expect(dueInMinutes).toBeGreaterThan(25);
    expect(dueInMinutes).toBeLessThan(35);

    // Caller identity is stamped onto the call row, never invented.
    const call = await db.receptionistCallLog.findUniqueOrThrow({ where: { id: f.callLogId } });
    expect(call.callerName).toBe('Jordan Caller');
  });

  it('appends a second message to the same live task instead of reporting a duplicate', async () => {
    const f = await makeFixture();
    const first = await fileTask(f, 'message', { message: 'First thing.' }, undefined, 'inv-1');
    const second = await fileTask(f, 'message', { message: 'And one more thing.' }, undefined, 'inv-2');

    expect(second.taskId).toBe(first.taskId);
    expect(second).toMatchObject({ duplicate: false, appended: true });
    expect(await db.staffTask.count({ where: { tenantId: f.tenantId } })).toBe(1);

    const task = await db.staffTask.findUniqueOrThrow({ where: { id: first.taskId } });
    const metadata = task.metadata as { messages: Array<{ text: string }>; message: string };
    expect(metadata.messages.map(entry => entry.text)).toEqual(['First thing.', 'And one more thing.']);
    expect(metadata.message).toBe('And one more thing.');
  });

  it('treats a byte-identical provider retry as a duplicate and records nothing new', async () => {
    const f = await makeFixture();
    const first = await fileTask(f, 'message', { message: 'Same words.' }, undefined, 'inv-retry');
    const retry = await fileTask(f, 'message', { message: 'Same words.' }, undefined, 'inv-retry');
    expect(retry).toMatchObject({ taskId: first.taskId, duplicate: true, appended: false });
  });

  it('opens a NEW task when the prior one was already completed, so the message is not swallowed', async () => {
    const f = await makeFixture();
    const first = await fileTask(f, 'message', { message: 'Before anyone picked it up.' }, undefined, 'inv-a');
    await db.staffTask.update({ where: { id: first.taskId }, data: { status: 'COMPLETED', completedAt: new Date(), outcomeCode: 'reached' } });

    const second = await fileTask(f, 'message', { message: 'Calling again, still nobody rang me.' }, undefined, 'inv-b');
    expect(second.taskId).not.toBe(first.taskId);
    expect(second).toMatchObject({ duplicate: false, appended: false });
    expect(await db.staffTask.count({ where: { tenantId: f.tenantId } })).toBe(2);
  });

  it('files an emergency as critical, due immediately, with a critical operational signal', async () => {
    const f = await makeFixture();
    const result = await fileTask(f, 'emergency', { reason_category: 'chest_pain' });
    const task = await db.staffTask.findUniqueOrThrow({ where: { id: result.taskId } });
    expect(task.priority).toBe('critical');
    expect(task.dueAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    const signal = await db.operationalSignal.findFirst({
      where: { tenantId: f.tenantId, entityType: 'staffTask', entityId: result.taskId },
    });
    expect(signal).toMatchObject({ severity: 'critical', status: 'open' });
  });

  it('keeps caller content out of the audit trail', async () => {
    const f = await makeFixture();
    const result = await fileTask(f, 'human_handoff', {
      caller_name: 'Taylor Secret', callback_phone: REQUESTED, message: 'A private billing matter.',
    });
    const event = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: 'receptionist.safety.human_handoff.created', resourceId: result.taskId },
    });
    const serialized = JSON.stringify(event.metadata);
    expect(serialized).not.toContain('Taylor Secret');
    expect(serialized).not.toContain(REQUESTED);
    expect(serialized).not.toContain('private billing');
    expect(event.metadata).toMatchObject({ hasCallbackPhone: true, hasRequestedPhone: true, patientLinked: false });
  });
});

describe('GET /v1/tasks — visibility, masking, filters', () => {
  it('shows a branch-scoped user their own branch AND the tasks no branch could be resolved for', async () => {
    const f = await makeFixture();
    const mine = await db.staffTask.create({ data: { tenantId: f.tenantId, branchId: f.branchA, title: 'Branch A work', priority: 'high' } });
    const unscoped = await db.staffTask.create({ data: { tenantId: f.tenantId, branchId: null, title: 'Nobody owns this yet', priority: 'high' } });
    const other = await db.staffTask.create({ data: { tenantId: f.tenantId, branchId: f.branchB, title: 'Branch B work', priority: 'high' } });

    const res = await app.inject({ method: 'GET', url: '/v1/tasks?limit=100', headers: auth(f, f.frontDeskA, 'FRONT_DESK') });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((row: { id: string }) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(unscoped.id);
    expect(ids).not.toContain(other.id);
  });

  it('masks caller detail for PROVIDER and ANALYST and never prints a phone number to anyone', async () => {
    const f = await makeFixture();
    const filed = await fileTask(f, 'message', {
      caller_name: 'Jordan Caller', callback_phone: REQUESTED, message: 'Ring me back please.',
    });
    await db.staffTask.update({ where: { id: filed.taskId }, data: { outcomeNote: 'internal note' } });

    for (const [userId, role] of [[f.provider, 'PROVIDER'], [f.analyst, 'ANALYST']] as const) {
      const res = await app.inject({ method: 'GET', url: '/v1/tasks?limit=100', headers: auth(f, userId, role) });
      expect(res.statusCode, role).toBe(200);
      const row = res.json().data.find((item: { id: string }) => item.id === filed.taskId);
      expect(row.receptionist, role).toEqual({ kind: 'message', restricted: true, requiresAcknowledgement: true });
      expect(row.metadata, role).toEqual({ workflow: 'receptionist_safety', kind: 'message', requiresAcknowledgement: true, restricted: true });
      expect(row.callLogId, role).toBeNull();
      expect(row.outcomeNote, role).toBeNull();
      const serialized = JSON.stringify(res.json());
      expect(serialized, role).not.toContain('Jordan Caller');
      expect(serialized, role).not.toContain(REQUESTED);
      expect(serialized, role).not.toContain(VERIFIED);
    }

    // Front desk may read the caller, but the list still only ever masks numbers.
    const allowed = await app.inject({ method: 'GET', url: '/v1/tasks?limit=100', headers: auth(f, f.frontDeskA, 'FRONT_DESK') });
    const row = allowed.json().data.find((item: { id: string }) => item.id === filed.taskId);
    expect(row.receptionist).toMatchObject({
      restricted: false, callerName: 'Jordan Caller',
      callbackPhoneMasked: '***-***-0999', verifiedPhoneMasked: '***-***-0177', hasRequestedPhone: true,
    });
    expect(JSON.stringify(allowed.json())).not.toContain(REQUESTED);
    expect(JSON.stringify(allowed.json())).not.toContain(VERIFIED);
  });

  it('reveals the real number only on the audited task detail', async () => {
    const f = await makeFixture();
    const filed = await fileTask(f, 'message', { callback_phone: REQUESTED, message: 'Ring me.' });

    const denied = await app.inject({ method: 'GET', url: `/v1/staff/tasks/${filed.taskId}`, headers: auth(f, f.analyst, 'ANALYST') });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().contact).toBeUndefined();
    expect(JSON.stringify(denied.json())).not.toContain(REQUESTED);

    const allowed = await app.inject({ method: 'GET', url: `/v1/staff/tasks/${filed.taskId}`, headers: auth(f, f.frontDeskA, 'FRONT_DESK') });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().contact).toMatchObject({ callbackPhone: REQUESTED, verifiedPhone: VERIFIED });
    expect(await db.auditEvent.count({
      where: { tenantId: f.tenantId, action: 'task.contact.revealed', resourceId: filed.taskId },
    })).toBe(1);
  });

  it('filters by kind and status and pages with a cursor', async () => {
    const f = await makeFixture();
    await fileTask(f, 'message', { message: 'One.' }, `call-${randomUUID()}`);
    await fileTask(f, 'emergency', { reason_category: 'chest_pain' }, `call-${randomUUID()}`);
    await fileTask(f, 'human_handoff', { reason_category: 'human_requested' }, `call-${randomUUID()}`);

    const emergencies = await app.inject({ method: 'GET', url: '/v1/tasks?kind=emergency', headers: auth(f, f.owner, 'OWNER') });
    expect(emergencies.json().data).toHaveLength(1);
    expect(emergencies.json().data[0].receptionist.kind).toBe('emergency');

    const firstPage = await app.inject({ method: 'GET', url: '/v1/tasks?limit=2', headers: auth(f, f.owner, 'OWNER') });
    expect(firstPage.json().data).toHaveLength(2);
    expect(firstPage.json().nextCursor).toBeTruthy();
    const secondPage = await app.inject({
      method: 'GET', url: `/v1/tasks?limit=2&cursor=${firstPage.json().nextCursor}`, headers: auth(f, f.owner, 'OWNER'),
    });
    const firstIds = firstPage.json().data.map((row: { id: string }) => row.id);
    const secondIds = secondPage.json().data.map((row: { id: string }) => row.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it('summarises open work by kind, overdue and unacknowledged critical', async () => {
    const f = await makeFixture();
    const message = await fileTask(f, 'message', { message: 'One.' }, `call-${randomUUID()}`);
    await fileTask(f, 'emergency', { reason_category: 'chest_pain' }, `call-${randomUUID()}`);
    await db.staffTask.update({ where: { id: message.taskId }, data: { dueAt: new Date(Date.now() - 60_000) } });

    const res = await app.inject({ method: 'GET', url: '/v1/tasks/summary', headers: auth(f, f.owner, 'OWNER') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openByKind).toMatchObject({ message: 1, emergency: 1, human_handoff: 0 });
    expect(body.openNeedsAction).toBe(2);
    expect(body.overdue).toBeGreaterThanOrEqual(1);
    expect(body.unacknowledgedCritical).toHaveLength(1);
    expect(body.unacknowledgedCritical[0].title).toMatch(/emergency/i);
    // Titles only: a summary any staff:read holder can see carries no caller.
    expect(JSON.stringify(body)).not.toContain(VERIFIED);
  });
});

describe('closing the loop', () => {
  it('acknowledges once, idempotently, and resolves the emergency signal', async () => {
    const f = await makeFixture();
    const filed = await fileTask(f, 'emergency', { reason_category: 'chest_pain' });
    const url = `/v1/staff/tasks/${filed.taskId}/acknowledge`;

    const first = await app.inject({ method: 'PATCH', url, headers: auth(f, f.frontDeskA, 'FRONT_DESK') });
    expect(first.statusCode).toBe(200);
    expect(first.json().acknowledgedBy.displayName).toBe('FRONT_DESK fd-a');
    const acknowledgedAt = first.json().acknowledgedAt;

    const again = await app.inject({ method: 'PATCH', url, headers: auth(f, f.owner, 'OWNER') });
    expect(again.statusCode).toBe(200);
    expect(again.json().acknowledgedAt).toBe(acknowledgedAt);

    expect((await db.operationalSignal.findFirstOrThrow({
      where: { tenantId: f.tenantId, entityId: filed.taskId },
    })).status).toBe('acknowledged');
    expect(await db.auditEvent.count({ where: { tenantId: f.tenantId, action: 'task.acknowledged', resourceId: filed.taskId } })).toBe(1);
  });

  it('refuses to close a receptionist task without an outcome, and records the outcome when given', async () => {
    const f = await makeFixture();
    const filed = await fileTask(f, 'message', { message: 'Ring me.' });
    const url = `/v1/staff/tasks/${filed.taskId}/status`;

    const bare = await app.inject({ method: 'PATCH', url, headers: auth(f, f.frontDeskA, 'FRONT_DESK'), payload: { status: 'COMPLETED' } });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().message).toMatch(/outcome code is required/i);

    const cancelled = await app.inject({
      method: 'PATCH', url, headers: auth(f, f.frontDeskA, 'FRONT_DESK'),
      payload: { status: 'CANCELED', outcomeCode: 'wrong_number', outcomeNote: 'Number belongs to a shop.' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'CANCELED', outcomeCode: 'wrong_number' });
    expect(cancelled.json().completedAt).toBeTruthy();

    const event = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: 'task.status.updated', resourceId: filed.taskId },
    });
    expect(event.metadata).toMatchObject({ toStatus: 'CANCELED', outcomeCode: 'wrong_number', hasNote: true });
    // The note is caller-adjacent content; only its existence belongs in audit.
    expect(JSON.stringify(event.metadata)).not.toContain('belongs to a shop');
  });

  it('requires a real appointment before a task may claim it was booked', async () => {
    const f = await makeFixture();
    const filed = await fileTask(f, 'message', { message: 'Book me in.' });
    const url = `/v1/staff/tasks/${filed.taskId}/status`;

    const missing = await app.inject({
      method: 'PATCH', url, headers: auth(f, f.frontDeskA, 'FRONT_DESK'),
      payload: { status: 'COMPLETED', outcomeCode: 'booked' },
    });
    expect(missing.statusCode).toBe(400);

    const invented = await app.inject({
      method: 'PATCH', url, headers: auth(f, f.frontDeskA, 'FRONT_DESK'),
      payload: { status: 'COMPLETED', outcomeCode: 'booked', appointmentId: randomUUID() },
    });
    expect(invented.statusCode).toBe(400);
    expect((await db.staffTask.findUniqueOrThrow({ where: { id: filed.taskId } })).status).toBe('OPEN');
  });

  it('appends staff notes without putting their text in the audit trail', async () => {
    const f = await makeFixture();
    const filed = await fileTask(f, 'message', { message: 'Ring me.' });
    const res = await app.inject({
      method: 'POST', url: `/v1/staff/tasks/${filed.taskId}/notes`,
      headers: auth(f, f.frontDeskA, 'FRONT_DESK'), payload: { text: 'Left a voicemail at 2pm.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().receptionist.staffNotes).toHaveLength(1);
    expect(res.json().receptionist.staffNotes[0]).toMatchObject({ text: 'Left a voicemail at 2pm.', byUserId: f.frontDeskA });

    const event = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, action: 'task.note.appended', resourceId: filed.taskId },
    });
    expect(event.metadata).toMatchObject({ hasNote: true, noteCount: 1 });
    expect(JSON.stringify(event.metadata)).not.toContain('voicemail at 2pm');
  });
});
