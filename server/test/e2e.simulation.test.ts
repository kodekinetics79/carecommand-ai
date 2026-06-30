import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// End-to-end, MULTI-TENANT, CONCURRENT simulation. Drives many modules together
// in one realistic clinic journey — insurance eligibility, provider scheduling,
// patient portal self-booking, connected-care/RPM device ingest, and the HIPAA
// data export — for several tenants at once (Promise.all), then verifies the
// shared audit trail captured the cross-module activity and that tenant
// isolation holds under concurrent load. This is the "all modules together"
// integration proof on top of the per-module unit tests.
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

const staffTok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, type: 'access' });
const portalTok = (a: { tenantId: string; patientId: string; accountId: string }) => app.jwt.sign({ portalAccountId: a.accountId, patientId: a.patientId, tenantId: a.tenantId, type: 'portal' });
const bearer = (t: string, ip: string) => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': ip });

interface Clinic {
  id: string; branchId: string; providerId: string; patientId: string; accountId: string;
  adminId: string; externalRef: string; ip: string;
}

async function provisionClinic(seq: number): Promise<Clinic> {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `sim-${id.slice(0, 6)}`, slug: `sim-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'City' } });
  const provUser = await db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `pv-${id.slice(0, 8)}@sim.test`, displayName: 'Dr Sim' } });
  const provider = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: provUser.id, specialty: 'Primary Care', rating: 4.7, reviewCount: 9 } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Sim', lastName: `Patient${seq}`, lifecycleStage: 'NEW' } });
  const account = await db.patientPortalAccount.create({ data: { tenantId: id, patientId: patient.id, status: 'active', email: `sp-${id.slice(0, 8)}@sim.test` } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@sim.test`, displayName: 'Admin' } });
  return { id, branchId: branch.id, providerId: provider.id, patientId: patient.id, accountId: account.id, adminId: admin.id, externalRef: `EXT-${id.slice(0, 8)}`, ip: `203.0.113.${seq + 10}` };
}

type StepResult = { ok: boolean; detail: string };

async function runJourney(c: Clinic): Promise<Record<string, StepResult>> {
  const steps: Record<string, StepResult> = {};
  const admin = bearer(staffTok(c.id, c.adminId), c.ip);
  const portal = bearer(portalTok({ tenantId: c.id, patientId: c.patientId, accountId: c.accountId }), c.ip);
  const ok = (cond: boolean, detail: string): StepResult => ({ ok: cond, detail });

  // 1) Insurance: configure Stedi sandbox + run an eligibility check.
  await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: admin, payload: { mode: 'sandbox', config: {} } });
  const elig = await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: admin, payload: { patientId: c.patientId, payerName: 'Aetna', memberId: 'AET-110293' } });
  steps.eligibility = ok(elig.statusCode === 201 && elig.json().status === 'ACTIVE', `status=${elig.statusCode}`);

  // 2) Scheduling: provider availability (Mon 09:00–12:00).
  const avail = await app.inject({ method: 'PUT', url: `/v1/scheduling/providers/${c.providerId}/availability`, headers: admin, payload: { windows: [{ dayOfWeek: 1, startMinute: 540, endMinute: 720, slotMinutes: 30 }] } });
  steps.availability = ok(avail.statusCode === 200, `status=${avail.statusCode}`);

  // 3) Portal self-book: patient views slots and books 09:00 for themselves.
  const slots = await app.inject({ method: 'GET', url: `/v1/portal/booking/providers/${c.providerId}/slots?date=${MONDAY}`, headers: portal });
  const hasNine = (slots.json().slots ?? []).some((s: { startsAt: string }) => s.startsAt === at('09:00'));
  const book = await app.inject({ method: 'POST', url: `/v1/portal/booking/providers/${c.providerId}/book`, headers: portal, payload: { startsAt: at('09:00'), durationMin: 30, reason: 'Annual physical' } });
  steps.selfBook = ok(hasNine && book.statusCode === 201, `slots=${(slots.json().slots ?? []).length} book=${book.statusCode}`);

  // 4) Connected care / RPM: enroll + ingest a critical reading via webhook.
  await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: admin, payload: { patientId: c.patientId, providerKey: 'manual', externalRef: c.externalRef } });
  const hook = await app.inject({ method: 'POST', url: `/v1/connected-care/${c.id}/providers/manual/webhook`, payload: { readings: [{ patientExternalRef: c.externalRef, readingType: 'glucose', value: '330', numericValue: 330, unit: 'mg/dL' }] } });
  steps.deviceAlert = ok(hook.statusCode === 200 && hook.json().alertsCreated === 1, `ingested=${hook.json().ingested} alerts=${hook.json().alertsCreated}`);

  // 5) Compliance: HIPAA data-access export compiles the cross-module record.
  const exp = await app.inject({ method: 'GET', url: `/v1/patients/${c.patientId}/data-export`, headers: admin });
  const body = exp.statusCode === 200 ? exp.json() : { counts: {} };
  steps.dataExport = ok(exp.statusCode === 200 && body.counts.appointments >= 1 && body.counts.eligibilityVerifications >= 1, `status=${exp.statusCode}`);

  return steps;
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

const N = 4; // concurrent clinics

describe('e2e simulation — many modules, many tenants, concurrently', () => {
  it(`runs ${N} clinic journeys in parallel and every cross-module step succeeds`, async () => {
    const clinics = await Promise.all(Array.from({ length: N }, (_, i) => provisionClinic(i)));
    const reports = await Promise.all(clinics.map(runJourney));

    // Human-readable simulation report.
    reports.forEach((r, i) => {
      const line = Object.entries(r).map(([k, v]) => `${k}:${v.ok ? 'ok' : `FAIL(${v.detail})`}`).join('  ');
      console.info(`[sim] clinic ${i}: ${line}`);
    });

    for (const r of reports) {
      for (const [step, result] of Object.entries(r)) {
        expect(result.ok, `${step} → ${result.detail}`).toBe(true);
      }
    }
  }, 60_000);

  it('captured cross-module audit activity and kept tenants isolated under concurrency', async () => {
    // Re-provision a small concurrent batch and verify per-tenant invariants.
    const clinics = await Promise.all(Array.from({ length: N }, (_, i) => provisionClinic(100 + i)));
    await Promise.all(clinics.map(runJourney));

    for (const c of clinics) {
      // Each tenant has exactly its own single booked appointment, for its patient.
      const appts = await db.appointment.findMany({ where: { tenantId: c.id }, select: { patientId: true, providerRef: true } });
      expect(appts).toHaveLength(1);
      expect(appts[0].patientId).toBe(c.patientId);
      expect(appts[0].providerRef).toBe(c.providerId);

      // The shared audit trail captured activity from multiple modules for this tenant.
      const actions = new Set((await db.auditEvent.findMany({ where: { tenantId: c.id }, select: { action: true } })).map(a => a.action));
      expect(actions.has('schedule.availability.updated')).toBe(true);
      expect(actions.has('portal.appointment.booked')).toBe(true);
      expect(actions.has('patient.data_exported')).toBe(true);

      // Eligibility history is exactly this tenant's (no cross-tenant bleed).
      const eligCount = await db.eligibilityVerification.count({ where: { tenantId: c.id } });
      expect(eligCount).toBe(1);
    }
  }, 60_000);
});
