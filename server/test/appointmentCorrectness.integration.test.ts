import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Front-desk / scheduling correctness fixes:
//  1. GET /v1/appointments returns the REAL patient name (not "Live DB Customer").
//  2. DB-level double-book prevention via the Postgres exclusion constraint:
//     two concurrent same-provider/slot staff books → one 201, one 409.
//  4. Reschedule cannot drop one appointment onto another (same provider) → 409.
//  5. Patient date-of-birth can be captured on create and corrected on edit.
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
const { recomputeEntitlements } = await import('../lib/entitlements');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

function nextMondayISO(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 1);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}
const MONDAY = nextMondayISO();
const at = (hhmm: string) => `${MONDAY}T${hhmm}:00.000Z`;

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `ac-${id.slice(0, 6)}`, slug: `ac-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x', timezone: 'UTC' } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@ac.test`, displayName: 'Dr' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care' } });
  await db.providerAvailability.create({ data: { tenantId: id, branchId: branch.id, providerProfileId: provider.id, dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Ada', lastName: 'Lovelace', lifecycleStage: 'ACTIVE' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@ac.test`, displayName: 'Admin' } });
  return { id, branchId: branch.id, providerId: provider.id, patientId: patient.id, adminId: admin.id };
}

type T = Awaited<ReturnType<typeof makeTenant>>;
const staff = (t: T) => ({ authorization: `Bearer ${app.jwt.sign({ userId: t.adminId, tenantId: t.id, role: 'OWNER', type: 'access' })}` });

const staffBook = (t: T, providerProfileId: string | undefined, start = '09:00', end = '09:30') =>
  app.inject({ method: 'POST', url: '/v1/appointments', headers: staff(t), payload: { branchId: t.branchId, patientId: t.patientId, providerProfileId, service: 'Checkup', startsAt: at(start), endsAt: at(end), channel: 'EMAIL' } });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('appointment correctness — name, double-book, reschedule, DOB', () => {
  it('GET /v1/appointments returns the real patient name (not a placeholder)', async () => {
    const t = await makeTenant();
    expect((await staffBook(t, t.providerId)).statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: `/v1/appointments?patientId=${t.patientId}`, headers: staff(t) });
    expect(list.statusCode).toBe(200);
    const row = list.json().data.find((a: { patientId: string }) => a.patientId === t.patientId);
    expect(row.patientName).toBe('Ada Lovelace');
    expect(row.patientName).not.toBe('Live DB Customer');
    // Detail read carries the name too.
    const detail = await app.inject({ method: 'GET', url: `/v1/appointments/${row.id}`, headers: staff(t) });
    expect(detail.json().patientName).toBe('Ada Lovelace');
  });

  it('DB exclusion constraint stops concurrent double-book: one 201, one 409', async () => {
    const t = await makeTenant();
    const [a, b] = await Promise.all([staffBook(t, t.providerId, '10:00', '10:30'), staffBook(t, t.providerId, '10:00', '10:30')]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toBe('already_booked');
    // Exactly one live appointment persisted for that provider/slot.
    const count = await db.appointment.count({ where: { tenantId: t.id, providerProfileId: t.providerId, startsAt: new Date(at('10:00')) } });
    expect(count).toBe(1);
  });

  it('sequential same-provider/slot staff book is rejected (409)', async () => {
    const t = await makeTenant();
    expect((await staffBook(t, t.providerId, '11:00', '11:30')).statusCode).toBe(201);
    const dup = await staffBook(t, t.providerId, '11:00', '11:30');
    expect(dup.statusCode).toBe(409);
  });

  it('reschedule cannot drop one appointment onto another for the same provider (409)', async () => {
    const t = await makeTenant();
    expect((await staffBook(t, t.providerId, '09:00', '09:30')).statusCode).toBe(201);
    const b = await staffBook(t, t.providerId, '10:00', '10:30');
    expect(b.statusCode).toBe(201);
    const bId = b.json().id;
    // Move B onto A's 09:00 slot → conflict.
    const clash = await app.inject({ method: 'PATCH', url: `/v1/appointments/${bId}/reschedule`, headers: staff(t), payload: { startsAt: at('09:00'), endsAt: at('09:30') } });
    expect(clash.statusCode).toBe(409);
    // A free slot still reschedules fine.
    const ok = await app.inject({ method: 'PATCH', url: `/v1/appointments/${bId}/reschedule`, headers: staff(t), payload: { startsAt: at('11:00'), endsAt: at('11:30') } });
    expect(ok.statusCode).toBe(200);
  });

  it('captures and corrects patient date of birth', async () => {
    const t = await makeTenant();
    const created = await app.inject({ method: 'POST', url: '/v1/patients', headers: staff(t), payload: { branchId: t.branchId, firstName: 'Grace', lastName: 'Hopper', dateOfBirth: '1906-12-09' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().dateOfBirth?.slice(0, 10)).toBe('1906-12-09');
    const pid = created.json().id;
    const edited = await app.inject({ method: 'PATCH', url: `/v1/patients/${pid}`, headers: staff(t), payload: { dateOfBirth: '1906-12-10' } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().dateOfBirth?.slice(0, 10)).toBe('1906-12-10');
    // And it is returned on a read.
    const read = await app.inject({ method: 'GET', url: `/v1/patients/${pid}`, headers: staff(t) });
    expect(read.json().dateOfBirth?.slice(0, 10)).toBe('1906-12-10');
  });
});
