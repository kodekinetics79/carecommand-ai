import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves backend-owned scheduling: open slots are computed from provider
// availability (minus time-off and existing appointments), booking is
// conflict-safe (no double-book), and management/booking are permission- and
// tenant-scoped.
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
const createdTenantIds: string[] = [];

function nextMondayISO(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 1);
  d.setUTCDate(d.getUTCDate() + 7); // a week out, safely in the future
  return d.toISOString().slice(0, 10);
}
const MONDAY = nextMondayISO();
const at = (hhmm: string) => `${MONDAY}T${hhmm}:00.000Z`;

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `sch-${id.slice(0, 6)}`, slug: `sch-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x', timezone: 'UTC' } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@sch.test`, displayName: 'Dr' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Roe', lifecycleStage: 'ACTIVE' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@sch.test`, displayName: 'Admin' } });
  const analyst = await db.user.create({ data: { tenantId: id, role: 'ANALYST', active: true, email: `an-${id.slice(0, 8)}@sch.test`, displayName: 'Analyst' } });
  return { id, branchId: branch.id, providerId: provider.id, patientId: patient.id, adminId: admin.id, analystId: analyst.id };
}

const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
const hdr = (t: { id: string }, userId: string) => ({ authorization: `Bearer ${tok(t.id, userId)}` });

// Mon 09:00–12:00, 30-min slots
const MON_9_12 = { windows: [{ dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 }] };

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

const slotsUrl = (pid: string) => `/v1/scheduling/providers/${pid}/slots?date=${MONDAY}`;
const startTimes = (json: { slots: Array<{ startsAt: string }> }) => json.slots.map(s => s.startsAt);

describe('scheduling — availability, slots, conflict-safe booking', () => {
  it('computes open slots from availability, excludes booked + time-off', async () => {
    const t = await makeTenant();
    const set = await app.inject({ method: 'PUT', url: `/v1/scheduling/providers/${t.providerId}/availability`, headers: hdr(t, t.adminId), payload: MON_9_12 });
    expect(set.statusCode).toBe(200);

    const slots1 = await app.inject({ method: 'GET', url: slotsUrl(t.providerId), headers: hdr(t, t.adminId) });
    expect(slots1.statusCode).toBe(200);
    expect(startTimes(slots1.json())).toEqual([at('09:00'), at('09:30'), at('10:00'), at('10:30'), at('11:00'), at('11:30')]);

    // Book 09:00 → excluded next time.
    const booked = await app.inject({ method: 'POST', url: `/v1/scheduling/providers/${t.providerId}/book`, headers: hdr(t, t.adminId), payload: { patientId: t.patientId, startsAt: at('09:00'), durationMin: 30, service: 'Checkup' } });
    expect(booked.statusCode).toBe(201);
    expect(booked.json().providerRef).toBe(t.providerId);

    const slots2 = await app.inject({ method: 'GET', url: slotsUrl(t.providerId), headers: hdr(t, t.adminId) });
    expect(startTimes(slots2.json())).not.toContain(at('09:00'));
    expect(startTimes(slots2.json())).toHaveLength(5);

    // Time off 10:00–11:00 removes those two slots.
    const off = await app.inject({ method: 'POST', url: `/v1/scheduling/providers/${t.providerId}/time-off`, headers: hdr(t, t.adminId), payload: { startsAt: at('10:00'), endsAt: at('11:00'), reason: 'lunch block' } });
    expect(off.statusCode).toBe(201);
    const slots3 = startTimes((await app.inject({ method: 'GET', url: slotsUrl(t.providerId), headers: hdr(t, t.adminId) })).json());
    expect(slots3).not.toContain(at('10:00'));
    expect(slots3).not.toContain(at('10:30'));
    expect(slots3).toEqual([at('09:30'), at('11:00'), at('11:30')]);
  });

  it('rejects a double-book (409 already_booked) and a slot outside availability (409 outside_availability)', async () => {
    const t = await makeTenant();
    await app.inject({ method: 'PUT', url: `/v1/scheduling/providers/${t.providerId}/availability`, headers: hdr(t, t.adminId), payload: MON_9_12 });
    const first = await app.inject({ method: 'POST', url: `/v1/scheduling/providers/${t.providerId}/book`, headers: hdr(t, t.adminId), payload: { patientId: t.patientId, startsAt: at('09:00'), durationMin: 30, service: 'A' } });
    expect(first.statusCode).toBe(201);
    const dbl = await app.inject({ method: 'POST', url: `/v1/scheduling/providers/${t.providerId}/book`, headers: hdr(t, t.adminId), payload: { patientId: t.patientId, startsAt: at('09:00'), durationMin: 30, service: 'B' } });
    expect(dbl.statusCode).toBe(409);
    expect(dbl.json().reason).toBe('already_booked');
    const outside = await app.inject({ method: 'POST', url: `/v1/scheduling/providers/${t.providerId}/book`, headers: hdr(t, t.adminId), payload: { patientId: t.patientId, startsAt: at('13:00'), durationMin: 30, service: 'C' } });
    expect(outside.statusCode).toBe(409);
    expect(outside.json().reason).toBe('outside_availability');
  });

  it('enforces permissions: ANALYST cannot manage availability (403) or book (403)', async () => {
    const t = await makeTenant();
    const manage = await app.inject({ method: 'PUT', url: `/v1/scheduling/providers/${t.providerId}/availability`, headers: hdr(t, t.analystId), payload: MON_9_12 });
    expect(manage.statusCode).toBe(403);
    expect(manage.json().permission).toBe('schedule:manage');
    const book = await app.inject({ method: 'POST', url: `/v1/scheduling/providers/${t.providerId}/book`, headers: hdr(t, t.analystId), payload: { patientId: t.patientId, startsAt: at('09:00'), durationMin: 30, service: 'X' } });
    expect(book.statusCode).toBe(403);
    expect(book.json().permission).toBe('appointment:write');
  });

  it('is tenant-isolated: cannot manage or book another tenant\'s provider (404)', async () => {
    const [a, b] = [await makeTenant(), await makeTenant()];
    const manage = await app.inject({ method: 'PUT', url: `/v1/scheduling/providers/${b.providerId}/availability`, headers: hdr(a, a.adminId), payload: MON_9_12 });
    expect(manage.statusCode).toBe(404);
    const book = await app.inject({ method: 'POST', url: `/v1/scheduling/providers/${b.providerId}/book`, headers: hdr(a, a.adminId), payload: { patientId: b.patientId, startsAt: at('09:00'), durationMin: 30, service: 'X' } });
    expect(book.statusCode).toBe(404);
  });

  it('requires auth (401)', async () => {
    const t = await makeTenant();
    expect((await app.inject({ method: 'GET', url: slotsUrl(t.providerId) })).statusCode).toBe(401);
  });
});
