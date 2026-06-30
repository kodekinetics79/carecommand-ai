import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves the per-tenant SchedulingPolicy is backend-enforced on patient self-book:
// the self-book toggle, and pre-visit requirement gating (intake/eligibility must
// be satisfied before a patient can confirm a booking). Policy management is
// permission-gated.
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
  await db.tenant.create({ data: { id, name: `pol-${id.slice(0, 6)}`, slug: `pol-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@pol.test`, displayName: 'Dr' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care' } });
  await db.providerAvailability.create({ data: { tenantId: id, branchId: branch.id, providerProfileId: provider.id, dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Roe', lifecycleStage: 'NEW' } });
  const account = await db.patientPortalAccount.create({ data: { tenantId: id, patientId: patient.id, status: 'active', email: `pa-${id.slice(0, 8)}@pol.test` } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@pol.test`, displayName: 'Admin' } });
  const analyst = await db.user.create({ data: { tenantId: id, role: 'ANALYST', active: true, email: `an-${id.slice(0, 8)}@pol.test`, displayName: 'Analyst' } });
  return { id, branchId: branch.id, providerId: provider.id, patientId: patient.id, accountId: account.id, adminId: admin.id, analystId: analyst.id };
}

type T = Awaited<ReturnType<typeof makeTenant>>;
const staff = (t: T, userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, tenantId: t.id, type: 'access' })}` });
const portal = (t: T) => ({ authorization: `Bearer ${app.jwt.sign({ portalAccountId: t.accountId, patientId: t.patientId, tenantId: t.id, type: 'portal' })}` });
const setPolicy = (t: T, body: Record<string, unknown>, userId = t.adminId) => app.inject({ method: 'PUT', url: '/v1/scheduling/policy', headers: staff(t, userId), payload: body });
const book = (t: T, time = '09:00') => app.inject({ method: 'POST', url: `/v1/portal/booking/providers/${t.providerId}/book`, headers: portal(t), payload: { startsAt: at(time), durationMin: 30, reason: 'Annual physical' } });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('scheduling policy — pre-visit gating on self-book', () => {
  it('defaults: no policy row → GET returns defaults and self-book works', async () => {
    const t = await makeTenant();
    const pol = await app.inject({ method: 'GET', url: '/v1/scheduling/policy', headers: staff(t, t.adminId) });
    expect(pol.json()).toMatchObject({ selfBookEnabled: true, requireEligibilityForSelfBook: false, requireIntakeForSelfBook: false, maxHorizonDays: 90 });
    expect((await book(t)).statusCode).toBe(201);
  });

  it('requireIntake: blocks (422) until a submitted intake packet exists', async () => {
    const t = await makeTenant();
    expect((await setPolicy(t, { requireIntakeForSelfBook: true })).statusCode).toBe(200);
    const blocked = await book(t);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: 'pre_visit_requirements_unmet', unmet: ['intake'] });

    await db.patientIntakePacket.create({ data: { tenantId: t.id, patientId: t.patientId, status: 'submitted' } });
    expect((await book(t)).statusCode).toBe(201);
  });

  it('requireEligibility: blocks (422) until active coverage is on file', async () => {
    const t = await makeTenant();
    await setPolicy(t, { requireEligibilityForSelfBook: true });
    const blocked = await book(t);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().unmet).toEqual(['eligibility']);

    await db.eligibilityVerification.create({ data: { tenantId: t.id, branchId: t.branchId, patientId: t.patientId, providerMode: 'mock', coverageStatus: 'ACTIVE', coverageActive: true, planName: 'PPO', payerName: 'Aetna', eligibilityMessage: 'active', normalizedResponse: {} } });
    expect((await book(t)).statusCode).toBe(201);
  });

  it('both requirements unmet are reported together', async () => {
    const t = await makeTenant();
    await setPolicy(t, { requireIntakeForSelfBook: true, requireEligibilityForSelfBook: true });
    const blocked = await book(t);
    expect(blocked.statusCode).toBe(422);
    expect(new Set(blocked.json().unmet)).toEqual(new Set(['intake', 'eligibility']));
  });

  it('selfBookEnabled=false disables self-book (403)', async () => {
    const t = await makeTenant();
    await setPolicy(t, { selfBookEnabled: false });
    const res = await book(t);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('self_book_disabled');
  });

  it('policy management is permission-gated: ANALYST cannot update it (403)', async () => {
    const t = await makeTenant();
    const res = await setPolicy(t, { requireIntakeForSelfBook: true }, t.analystId);
    expect(res.statusCode).toBe(403);
    expect(res.json().permission).toBe('schedule:manage');
  });
});
