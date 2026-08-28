import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves the double-booking fix: an appointment booked through the LEGACY staff
// route (/v1/appointments, with providerProfileId) now blocks a conflicting
// PORTAL self-book for the same provider + time — the two paths reconcile via the
// canonical Appointment.providerProfileId FK. Also guards the FK against
// cross-tenant provider references (IDOR).
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
  await db.tenant.create({ data: { id, name: `xp-${id.slice(0, 6)}`, slug: `xp-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@xp.test`, displayName: 'Dr' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care' } });
  await db.providerAvailability.create({ data: { tenantId: id, branchId: branch.id, providerProfileId: provider.id, dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Roe', lifecycleStage: 'ACTIVE' } });
  const account = await db.patientPortalAccount.create({ data: { tenantId: id, patientId: patient.id, status: 'active', email: `pa-${id.slice(0, 8)}@xp.test` } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@xp.test`, displayName: 'Admin' } });
  const portalToken = await issuePortalSession(app, account, db);
  return { id, branchId: branch.id, providerId: provider.id, patientId: patient.id, accountId: account.id, adminId: admin.id, portalToken };
}

type T = Awaited<ReturnType<typeof makeTenant>>;
const staff = (t: T) => ({ authorization: `Bearer ${app.jwt.sign({ userId: t.adminId, tenantId: t.id, role: 'OWNER', type: 'access' })}` });
const portal = (t: T) => ({ authorization: `Bearer ${t.portalToken}` });

const staffBook = (t: T, providerProfileId: string | undefined, start = '09:00', end = '09:30') =>
  app.inject({ method: 'POST', url: '/v1/appointments', headers: staff(t), payload: { branchId: t.branchId, patientId: t.patientId, providerProfileId, service: 'Checkup', startsAt: at(start), endsAt: at(end), channel: 'EMAIL' } });
const portalBook = (t: T, start = '09:00') =>
  app.inject({ method: 'POST', url: `/v1/portal/booking/providers/${t.providerId}/book`, headers: portal(t), payload: { startsAt: at(start), durationMin: 30, reason: 'Annual physical' } });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('cross-path booking — staff + portal reconcile via providerProfileId', () => {
  it('a staff appointment blocks a conflicting portal self-book (409) and hides the slot', async () => {
    const t = await makeTenant();
    // Staff books 09:00–09:30 for the provider via the legacy route.
    expect((await staffBook(t, t.providerId)).statusCode).toBe(201);

    // The portal now excludes that slot...
    const slots = (await app.inject({ method: 'GET', url: `/v1/portal/booking/providers/${t.providerId}/slots?date=${MONDAY}`, headers: portal(t) })).json();
    expect(slots.slots.map((s: { startsAt: string }) => s.startsAt)).not.toContain(at('09:00'));

    // ...and rejects a direct self-book of the same slot.
    const blocked = await portalBook(t, '09:00');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().reason).toBe('already_booked');

    // A different open slot still books fine.
    expect((await portalBook(t, '09:30')).statusCode).toBe(201);
  });

  it('a staff appointment WITHOUT a provider link does not block self-book (unchanged legacy behavior)', async () => {
    const t = await makeTenant();
    // No providerProfileId → not part of provider conflict detection.
    expect((await staffBook(t, undefined)).statusCode).toBe(201);
    expect((await portalBook(t, '09:00')).statusCode).toBe(201);
  });

  it('rejects a cross-tenant provider reference on the staff route (400, IDOR guard)', async () => {
    const [a, b] = [await makeTenant(), await makeTenant()];
    const res = await staffBook(a, b.providerId); // tenant A booking with tenant B's provider
    expect(res.statusCode).toBe(400);
  });
});
