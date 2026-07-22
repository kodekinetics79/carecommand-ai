import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Covers the onboarding-blocker closures (provider create/edit, patient
// edit/soft-delete, appointment lifecycle transitions) and the HIPAA
// read-compliance closures (read RBAC now blocks, PHI reads are audited, the
// audit log is gated). Every assertion runs in an isolated tenant with unique
// slugs — never a global count — because the dev DB is shared.
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

let app: FastifyInstance;
const createdTenantIds: string[] = [];

type Role = 'ADMIN' | 'PROVIDER' | 'FRONT_DESK' | 'BILLING' | 'AUDITOR';

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `onb-${id.slice(0, 6)}`, slug: `onb-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'HQ' } });
  const users: Record<Role, string> = {} as Record<Role, string>;
  for (const role of ['ADMIN', 'PROVIDER', 'FRONT_DESK', 'BILLING', 'AUDITOR'] as Role[]) {
    const u = await db.user.create({ data: { tenantId: id, role, active: true, email: `${role}-${id.slice(0, 8)}@onb.test`, displayName: role } });
    users[role] = u.id;
  }
  // A tenant user with no provider profile yet — the target for provider onboarding.
  const clinician = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `clin-${id.slice(0, 8)}@onb.test`, displayName: 'Dr New' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Seed', lastName: 'Patient', lifecycleStage: 'NEW' } });
  return { id, branchId: branch.id, users, clinicianUserId: clinician.id, patientId: patient.id };
}

async function makeAppointment(t: { id: string; branchId: string; patientId: string }, status = 'CONFIRMED') {
  const now = Date.now();
  const appt = await db.appointment.create({
    data: {
      tenantId: t.id, branchId: t.branchId, patientId: t.patientId,
      service: 'Checkup', startsAt: new Date(now + 36e5), endsAt: new Date(now + 72e5),
      channel: 'EMAIL', status: status as 'CONFIRMED', value: 100,
    },
  });
  return appt.id;
}

const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, type: 'access' });
const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': '203.0.113.11' });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('providers — create + edit (onboarding blocker)', () => {
  it('ADMIN creates a provider profile (201); FRONT_DESK without schedule:manage is denied (403)', async () => {
    const t = await makeTenant();
    const payload = { userId: t.clinicianUserId, branchId: t.branchId, specialty: 'Cardiology' };

    const denied = await app.inject({ method: 'POST', url: '/v1/providers', headers: auth(tok(t.id, t.users.FRONT_DESK)), payload });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().permission).toBe('schedule:manage');

    const created = await app.inject({ method: 'POST', url: '/v1/providers', headers: auth(tok(t.id, t.users.ADMIN)), payload });
    expect(created.statusCode).toBe(201);
    expect(created.json().specialty).toBe('Cardiology');
    expect(created.json().userId).toBe(t.clinicianUserId);
  });

  it('rejects a duplicate profile for the same user (409) and a cross-tenant user (400)', async () => {
    const t = await makeTenant();
    const other = await makeTenant();
    const first = await app.inject({ method: 'POST', url: '/v1/providers', headers: auth(tok(t.id, t.users.ADMIN)), payload: { userId: t.clinicianUserId, branchId: t.branchId, specialty: 'Derm' } });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({ method: 'POST', url: '/v1/providers', headers: auth(tok(t.id, t.users.ADMIN)), payload: { userId: t.clinicianUserId, branchId: t.branchId, specialty: 'Derm' } });
    expect(dup.statusCode).toBe(409);
    const crossTenant = await app.inject({ method: 'POST', url: '/v1/providers', headers: auth(tok(t.id, t.users.ADMIN)), payload: { userId: other.clinicianUserId, branchId: t.branchId, specialty: 'Derm' } });
    expect(crossTenant.statusCode).toBe(400);
  });

  it('ADMIN edits a provider specialty (200)', async () => {
    const t = await makeTenant();
    const created = await app.inject({ method: 'POST', url: '/v1/providers', headers: auth(tok(t.id, t.users.ADMIN)), payload: { userId: t.clinicianUserId, branchId: t.branchId, specialty: 'Cardiology' } });
    const providerId = created.json().id as string;
    const edited = await app.inject({ method: 'PATCH', url: `/v1/providers/${providerId}`, headers: auth(tok(t.id, t.users.ADMIN)), payload: { specialty: 'Neurology' } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().specialty).toBe('Neurology');
  });
});

describe('patients — edit + soft-delete (onboarding blocker)', () => {
  it('ADMIN corrects a patient name (200); AUDITOR without patient:write is denied (403)', async () => {
    const t = await makeTenant();
    const denied = await app.inject({ method: 'PATCH', url: `/v1/patients/${t.patientId}`, headers: auth(tok(t.id, t.users.AUDITOR)), payload: { firstName: 'Nope' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().permission).toBe('patient:write');

    const ok = await app.inject({ method: 'PATCH', url: `/v1/patients/${t.patientId}`, headers: auth(tok(t.id, t.users.ADMIN)), payload: { firstName: 'Corrected', phone: '+15551234' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().firstName).toBe('Corrected');
    expect(ok.json().phone).toBe('+15551234');
  });

  it('an empty PATCH is rejected (400)', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'PATCH', url: `/v1/patients/${t.patientId}`, headers: auth(tok(t.id, t.users.ADMIN)), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE soft-deletes: sets deletedAt, then GET/:id is 404 and it drops out of the list', async () => {
    const t = await makeTenant();
    const del = await app.inject({ method: 'DELETE', url: `/v1/patients/${t.patientId}`, headers: auth(tok(t.id, t.users.ADMIN)) });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(true);

    const row = await db.patient.findUnique({ where: { id: t.patientId }, select: { deletedAt: true } });
    expect(row?.deletedAt).not.toBeNull();

    const after = await app.inject({ method: 'GET', url: `/v1/patients/${t.patientId}`, headers: auth(tok(t.id, t.users.ADMIN)) });
    expect(after.statusCode).toBe(404);

    const list = await app.inject({ method: 'GET', url: '/v1/patients', headers: auth(tok(t.id, t.users.ADMIN)) });
    const ids = (list.json().data as Array<{ id: string }>).map(p => p.id);
    expect(ids).not.toContain(t.patientId);
  });
});

describe('appointments — lifecycle status transitions', () => {
  it('advances CONFIRMED → ARRIVED → COMPLETED (200 each)', async () => {
    const t = await makeTenant();
    const apptId = await makeAppointment(t);
    const arrived = await app.inject({ method: 'PATCH', url: `/v1/appointments/${apptId}/status`, headers: auth(tok(t.id, t.users.ADMIN)), payload: { status: 'ARRIVED' } });
    expect(arrived.statusCode).toBe(200);
    expect(arrived.json().status).toBe('ARRIVED');
    const completed = await app.inject({ method: 'PATCH', url: `/v1/appointments/${apptId}/status`, headers: auth(tok(t.id, t.users.ADMIN)), payload: { status: 'COMPLETED' } });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe('COMPLETED');
  });

  it('rejects an invalid transition out of a terminal state (409)', async () => {
    const t = await makeTenant();
    const apptId = await makeAppointment(t, 'COMPLETED');
    const res = await app.inject({ method: 'PATCH', url: `/v1/appointments/${apptId}/status`, headers: auth(tok(t.id, t.users.ADMIN)), payload: { status: 'ARRIVED' } });
    expect(res.statusCode).toBe(409);
  });

  it('marks CONFIRMED → NO_SHOW (200); rejects an unknown status (400); denies BILLING without appointment:write (403)', async () => {
    const t = await makeTenant();
    const apptId = await makeAppointment(t);
    const noShow = await app.inject({ method: 'PATCH', url: `/v1/appointments/${apptId}/status`, headers: auth(tok(t.id, t.users.ADMIN)), payload: { status: 'NO_SHOW' } });
    expect(noShow.statusCode).toBe(200);
    expect(noShow.json().status).toBe('NO_SHOW');

    const bad = await app.inject({ method: 'PATCH', url: `/v1/appointments/${await makeAppointment(t)}/status`, headers: auth(tok(t.id, t.users.ADMIN)), payload: { status: 'SCHEDULED' } });
    expect(bad.statusCode).toBe(400);

    const denied = await app.inject({ method: 'PATCH', url: `/v1/appointments/${await makeAppointment(t)}/status`, headers: auth(tok(t.id, t.users.BILLING)), payload: { status: 'ARRIVED' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().permission).toBe('appointment:write');
  });
});

describe('HIPAA read compliance — RBAC enforcement + audit', () => {
  it('patient read now BLOCKS without patient:read (AUDITOR 403) but ADMIN still reads (200)', async () => {
    const t = await makeTenant();
    const denied = await app.inject({ method: 'GET', url: `/v1/patients/${t.patientId}`, headers: auth(tok(t.id, t.users.AUDITOR)) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().permission).toBe('patient:read');
    const ok = await app.inject({ method: 'GET', url: `/v1/patients/${t.patientId}`, headers: auth(tok(t.id, t.users.ADMIN)) });
    expect(ok.statusCode).toBe(200);
  });

  it('appointment list read BLOCKS without appointment:read (BILLING 403) but ADMIN reads (200)', async () => {
    const t = await makeTenant();
    const denied = await app.inject({ method: 'GET', url: '/v1/appointments', headers: auth(tok(t.id, t.users.BILLING)) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().permission).toBe('appointment:read');
    const ok = await app.inject({ method: 'GET', url: '/v1/appointments', headers: auth(tok(t.id, t.users.ADMIN)) });
    expect(ok.statusCode).toBe(200);
  });

  it('a PHI detail read writes an id-only audit row (patient.read)', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'GET', url: `/v1/patients/${t.patientId}`, headers: auth(tok(t.id, t.users.ADMIN)) });
    expect(res.statusCode).toBe(200);
    const events = await db.auditEvent.findMany({ where: { tenantId: t.id, action: 'patient.read', resourceId: t.patientId } });
    expect(events.length).toBeGreaterThanOrEqual(1);
    // No PHI in the audit payload — id/action only.
    expect(JSON.stringify(events[0].metadata ?? {})).not.toContain('Seed');
  });

  it('an appointment detail read is audited (appointment.read)', async () => {
    const t = await makeTenant();
    const apptId = await makeAppointment(t);
    const res = await app.inject({ method: 'GET', url: `/v1/appointments/${apptId}`, headers: auth(tok(t.id, t.users.ADMIN)) });
    expect(res.statusCode).toBe(200);
    const events = await db.auditEvent.findMany({ where: { tenantId: t.id, action: 'appointment.read', resourceId: apptId } });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

describe('compliance — audit log is gated', () => {
  it('GET /audit-log is 403 without audit:read (FRONT_DESK) and 200 for ADMIN', async () => {
    const t = await makeTenant();
    const denied = await app.inject({ method: 'GET', url: '/v1/compliance/audit-log', headers: auth(tok(t.id, t.users.FRONT_DESK)) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().permission).toBe('audit:read');
    const ok = await app.inject({ method: 'GET', url: '/v1/compliance/audit-log', headers: auth(tok(t.id, t.users.ADMIN)) });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json())).toBe(true);
  });
});
