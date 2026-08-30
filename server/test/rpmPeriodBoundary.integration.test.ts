import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

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
const { rpmPeriodBounds } = await import('../lib/connectedCare/rpmEvidence');
const { resolveRpmTimeZone } = await import('../lib/connectedCare/rpmReadinessService');
const { runWithTenantContext } = await import('../lib/tenantContext');

const LA = 'America/Los_Angeles';

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeTenant(timezone: string) {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `pb-${id.slice(0, 6)}`, slug: `pb-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x', timezone } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `a-${id.slice(0, 8)}@t.test`, displayName: 'Admin' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Boundary', lastName: 'Patient', lifecycleStage: 'NEW' } });
  const device = await db.device.create({ data: { tenantId: id, branchId: branch.id, name: 'Cuff', deviceType: 'vitals_monitor', active: true } });
  return { id, branchId: branch.id, adminId: admin.id, patientId: patient.id, deviceId: device.id };
}

const auth = (tenantId: string, userId: string) => ({
  authorization: `Bearer ${app.jwt.sign({ tenantId, userId, role: 'OWNER', type: 'access' })}`,
});

async function enrolAndConsent(t: Awaited<ReturnType<typeof makeTenant>>) {
  const headers = auth(t.id, t.adminId);
  const enrolled = await app.inject({
    method: 'POST', url: '/v1/connected-care/enrollments', headers,
    payload: { patientId: t.patientId, providerKey: 'withings', deviceId: t.deviceId },
  });
  expect(enrolled.statusCode).toBe(201);
  const consented = await app.inject({
    method: 'POST', url: '/v1/connected-care/consent', headers,
    payload: { patientId: t.patientId, consentType: 'rpm', granted: true, method: 'written' },
  });
  expect(consented.statusCode).toBe(201);
}

beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app.close();
});

describe('RPM billing period — reckoned where the care happens', () => {
  it('reads the period zone from the patient\'s branch', async () => {
    const t = await makeTenant(LA);
    const zone = await runWithTenantContext(t.id, () => resolveRpmTimeZone(t.id, t.patientId), { id: t.adminId, role: 'ADMIN' });
    expect(zone).toBe(LA);
  });

  it('falls back to UTC rather than throwing on an unresolvable zone', async () => {
    const t = await makeTenant('UTC');
    await db.branch.update({ where: { id: t.branchId }, data: { timezone: 'Mars/Olympus_Mons' } });
    // A bad stored identifier must not blow up an evidence rebuild mid-flight.
    const zone = await runWithTenantContext(t.id, () => resolveRpmTimeZone(t.id, t.patientId), { id: t.adminId, role: 'ADMIN' });
    expect(zone).toBe('UTC');
  });

  // THE DEFECT THIS CLOSES. At 16:30 on the last day of the local month a
  // Los Angeles clinic is already into the next UTC month. Under UTC periods the
  // clinician was told their session fell outside the current period and could
  // not record the work at all — the last working evening of every month was
  // simply unbillable.
  it('accepts a review session on the last local evening of the month', async () => {
    const t = await makeTenant(LA);
    await enrolAndConsent(t);

    // 2026-08-31 16:30 in Los Angeles is 2026-09-01 23:30 UTC.
    const localEvening = new Date('2026-09-01T00:30:00.000Z');
    expect(localEvening.getUTCMonth() + 1).toBe(9); // UTC has already rolled over
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(localEvening);

    const res = await app.inject({
      method: 'PATCH', url: `/v1/connected-care/rpm-readiness/${t.patientId}/review`,
      headers: auth(t.id, t.adminId),
      payload: {
        reviewEventId: randomUUID(),
        sourceRef: `ehr-${randomUUID()}`,
        provenance: 'EHR_TIMER',
        startedAt: new Date(localEvening.getTime() - 25 * 60_000),
        endedAt: new Date(localEvening.getTime() - 5 * 60_000),
        activityNarrative: 'Reviewed the evening BP trend and called the patient.',
        communicationModality: 'live_phone',
      },
    });
    expect(res.statusCode).toBe(200);

    // And it lands in AUGUST — the local month the clinician was working in.
    const period = rpmPeriodBounds(localEvening, LA);
    const recorded = await db.auditEvent.findFirst({
      where: { tenantId: t.id, action: 'connectedcare.rpm.review_evidence_recorded' },
    });
    expect(recorded).not.toBeNull();
    expect(recorded!.occurredAt >= period.start && recorded!.occurredAt < period.end).toBe(true);
  });

  it('addresses a month that has already closed, which is when billing happens', async () => {
    const t = await makeTenant('UTC');
    await enrolAndConsent(t);

    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/connected-care/rpm-readiness?periodStart=${lastMonth.toISOString()}`,
      headers: auth(t.id, t.adminId),
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { items: Array<{ periodStart: string; periodEnd: string; periodClosed: boolean; periodTimeZone: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    const row = body.items[0];
    // The closed month is returned, marked closed, and named — not silently
    // swapped for the current one, which is what every call site used to do.
    expect(new Date(row.periodStart).getUTCMonth()).toBe(lastMonth.getUTCMonth());
    expect(row.periodClosed).toBe(true);
    expect(row.periodTimeZone).toBe('UTC');
  });

  it('normalises any instant inside a month, so half a month cannot be addressed', async () => {
    const t = await makeTenant('UTC');
    await enrolAndConsent(t);
    const headers = auth(t.id, t.adminId);
    const now = new Date();
    const midMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 17, 9, 41, 23));
    const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

    const read = async (at: Date) => {
      const res = await app.inject({ method: 'GET', url: `/v1/connected-care/rpm-readiness?periodStart=${at.toISOString()}`, headers });
      return (res.json() as { items: Array<{ periodStart: string }> }).items[0].periodStart;
    };
    expect(await read(midMonth)).toBe(await read(firstOfMonth));
  });

  it('defaults to the current period when none is asked for', async () => {
    const t = await makeTenant('UTC');
    await enrolAndConsent(t);
    const res = await app.inject({ method: 'GET', url: '/v1/connected-care/rpm-readiness', headers: auth(t.id, t.adminId) });
    const row = (res.json() as { items: Array<{ periodStart: string; periodClosed: boolean }> }).items[0];
    expect(new Date(row.periodStart).getUTCMonth()).toBe(new Date().getUTCMonth());
    expect(row.periodClosed).toBe(false);
  });

  // THE INFLATION DEFECT. Two readings on ONE local day that straddle UTC
  // midnight used to bucket as two device-days, so a patient could clear a
  // sixteen-day CMS threshold on eight days of actual transmission.
  it('counts two readings on a single local day as one device-day', async () => {
    const t = await makeTenant(LA);
    await enrolAndConsent(t);
    const enrolment = await db.patientDeviceEnrollment.findFirstOrThrow({ where: { tenantId: t.id, patientId: t.patientId } });

    // Both of these are 2026-08-14 in Los Angeles; they are two dates in UTC.
    const morning = new Date('2026-08-14T15:00:00.000Z'); // 08:00 local
    const evening = new Date('2026-08-15T01:00:00.000Z'); // 18:00 local
    expect(morning.toISOString().slice(0, 10)).not.toBe(evening.toISOString().slice(0, 10));

    for (const capturedAt of [morning, evening]) {
      await db.deviceReading.create({
        data: {
          tenantId: t.id, patientId: t.patientId, deviceId: t.deviceId, branchId: t.branchId,
          readingType: 'blood_pressure', value: '128/82', numericValue: 128, valueSecondary: 82, unit: 'mmHg',
          capturedAt, receivedAt: capturedAt, source: 'webhook', validationStatus: 'valid',
          dedupeKey: `pb-${randomUUID()}`, sourceProviderKey: 'withings', sourceEnrollmentId: enrolment.id,
        },
      });
    }
    await db.patientDeviceEnrollment.update({ where: { id: enrolment.id }, data: { enrolledAt: new Date('2026-08-01T07:00:00.000Z') } });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/connected-care/rpm-readiness?periodStart=2026-08-15T00:00:00.000Z',
      headers: auth(t.id, t.adminId),
    });
    const row = (res.json() as { items: Array<{ readingDays: number; qualifyingReadingCount: number }> }).items[0];
    expect(row.qualifyingReadingCount).toBe(2);
    // Two qualifying readings, one local day of transmission, one device-day.
    expect(row.readingDays).toBe(1);
  });
});
