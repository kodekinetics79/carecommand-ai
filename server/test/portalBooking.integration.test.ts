import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves patient self-scheduling on the PORTAL identity plane: a patient books a
// real open slot for THEMSELVES (patientId from the portal session, never the
// body), conflict-safe, scoped to their own clinic — distinct from staff routes.
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
const { issuePortalSession } = await import('../lib/portalAuth');

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
  await db.tenant.create({ data: { id, name: `pb-${id.slice(0, 6)}`, slug: `pb-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db); // enables patient_crm (portal feature gate)
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@pb.test`, displayName: 'Dr Who' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care', rating: 4.8, reviewCount: 12 } });
  // Mon 09:00–12:00, 30-min slots
  await db.providerAvailability.create({ data: { tenantId: id, branchId: branch.id, providerProfileId: provider.id, dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Roe', lifecycleStage: 'ACTIVE' } });
  const account = await db.patientPortalAccount.create({ data: { tenantId: id, patientId: patient.id, status: 'active', email: `pat-${id.slice(0, 8)}@pb.test` } });
  const portalToken = await issuePortalSession(app, account, db);
  return { id, branchId: branch.id, providerId: provider.id, patientId: patient.id, accountId: account.id, portalToken };
}

const portalTok = (t: { id: string; patientId: string; accountId: string }) =>
  'portalToken' in t ? String(t.portalToken) : '';
const phdr = (t: { id: string; patientId: string; accountId: string; portalToken: string }) => ({ authorization: `Bearer ${portalTok(t)}` });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('portal self-scheduling — patient books real availability for themselves', () => {
  it('lists bookable providers with patient-safe fields only', async () => {
    const t = await makeTenant();
    const res = await app.inject({ method: 'GET', url: '/v1/portal/booking/providers', headers: phdr(t) });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: t.providerId, name: 'Dr Who', specialty: 'Primary Care', rating: 4.8, reviewCount: 12 });
    // no internal metrics leaked
    expect(res.body).not.toContain('utilization');
    expect(res.body).not.toContain('revenue');
  });

  it('returns open slots and books a slot for the session patient (conflict-safe)', async () => {
    const t = await makeTenant();
    const slots = await app.inject({ method: 'GET', url: `/v1/portal/booking/providers/${t.providerId}/slots?date=${MONDAY}`, headers: phdr(t) });
    expect(slots.statusCode).toBe(200);
    expect(slots.json().slots.map((s: { startsAt: string }) => s.startsAt)).toContain(at('09:00'));

    const book = await app.inject({ method: 'POST', url: `/v1/portal/booking/providers/${t.providerId}/book`, headers: phdr(t), payload: { startsAt: at('09:00'), durationMin: 30, reason: 'Annual physical' } });
    expect(book.statusCode).toBe(201);
    // appointment is tied to the session patient, not anything client-supplied
    const appt = await db.appointment.findFirst({ where: { tenantId: t.id, providerRef: t.providerId } });
    expect(appt?.patientId).toBe(t.patientId);
    expect(appt?.status).toBe('CONFIRMED');

    // double-book the same slot → 409
    const dbl = await app.inject({ method: 'POST', url: `/v1/portal/booking/providers/${t.providerId}/book`, headers: phdr(t), payload: { startsAt: at('09:00'), durationMin: 30, reason: 'again' } });
    expect(dbl.statusCode).toBe(409);
    expect(dbl.json().reason).toBe('already_booked');

    // a disclosure/booking is audited as a patient action (actorUserId null)
    const audited = await db.auditEvent.findFirst({ where: { tenantId: t.id, action: 'portal.appointment.booked', actorUserId: null } });
    expect(audited).not.toBeNull();
  });

  it('rejects booking a provider outside the patient\'s clinic/tenant (404)', async () => {
    const [a, b] = [await makeTenant(), await makeTenant()];
    const res = await app.inject({ method: 'POST', url: `/v1/portal/booking/providers/${b.providerId}/book`, headers: phdr(a), payload: { startsAt: at('09:00'), durationMin: 30, reason: 'Visit' } });
    expect(res.statusCode).toBe(404);
  });

  it('requires a portal session (401) and rejects a staff token', async () => {
    const t = await makeTenant();
    expect((await app.inject({ method: 'GET', url: '/v1/portal/booking/providers' })).statusCode).toBe(401);
    // a staff-style access token must not work on the portal plane
    const staff = app.jwt.sign({ userId: randomUUID(), tenantId: t.id, role: 'OWNER', type: 'access' });
    const res = await app.inject({ method: 'GET', url: '/v1/portal/booking/providers', headers: { authorization: `Bearer ${staff}` } });
    expect(res.statusCode).toBe(401);
  });
});
