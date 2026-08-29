import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const { generatePasswordHash } = await import('../lib/security');
const { CONFIRMATION_OUTBOX_SOURCE } = await import('../lib/receptionist/confirmationOutbox');

// The confirmation outbox already had everything that makes sending safe — the
// shared suppression fence, quiet hours, the DNC check, delivery reporting that
// never claims a send it did not make. Nothing put work into it except the AI
// voice path, where channels are gated by the calling campaign. A staff-booked
// appointment has no campaign, so a clinic booking at the front desk got no
// confirmation at all, and therefore no lever on no-shows.

let app: FastifyInstance;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => { app = await buildApp(); }, 90_000);

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  await app?.close();
  await db.$disconnect();
});

async function bookableClinic(policy: { confirmBookingsBySms?: boolean; confirmBookingsByEmail?: boolean } = {}) {
  const tenantId = randomUUID();
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `conf-${tag}`, slug: `conf-${tag}` } });
  cleanup.push(async () => { await db.tenant.delete({ where: { id: tenantId } }).catch(() => {}); });

  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);

  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'Main', timezone: 'UTC' } });
  const password = `Conf-Pw-${tag}!`;
  const owner = await db.user.create({
    data: {
      tenantId, role: 'OWNER', active: true,
      email: `owner-${tag}@conf.test`, displayName: 'Owner',
      passwordHash: await generatePasswordHash(password), passwordChangedAt: new Date(),
    },
  });
  const clinician = await db.user.create({
    data: {
      tenantId, role: 'PROVIDER', active: true,
      email: `dr-${tag}@conf.test`, displayName: 'Dr Reyes',
      passwordHash: await generatePasswordHash(password), passwordChangedAt: new Date(),
    },
  });
  const provider = await db.providerProfile.create({
    data: { tenantId, branchId: branch.id, userId: clinician.id, specialty: 'General' },
  });
  // Bookable every day, all day, so the slot maths is never the thing under test.
  await db.providerAvailability.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map(dayOfWeek => ({
      tenantId, branchId: branch.id, providerProfileId: provider.id, dayOfWeek,
      startMinute: 0, endMinute: 1439, slotMinutes: 30,
    })),
  });
  const patient = await db.patient.create({
    data: {
      tenantId, branchId: branch.id, firstName: 'Pat', lastName: 'Ient',
      phone: '+15551230000', email: `pat-${tag}@example.test`, lifecycleStage: 'ACTIVE',
    },
  });
  await db.schedulingPolicy.create({ data: { tenantId, ...policy } });

  const login = await app.inject({
    method: 'POST', url: '/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: owner.email, password }),
  });
  const body = login.json() as { accessToken?: string; token?: string };
  return {
    tenantId, provider, patient,
    headers: { authorization: `Bearer ${body.accessToken ?? body.token}`, 'content-type': 'application/json' },
  };
}

function nextWeekAt(hourUtc: number) {
  const when = new Date(Date.now() + 7 * 86_400_000);
  when.setUTCHours(hourUtc, 0, 0, 0);
  return when;
}

async function book(app: FastifyInstance, providerId: string, patientId: string, headers: Record<string, string>, startsAt: Date) {
  return app.inject({
    method: 'POST', url: `/v1/scheduling/providers/${providerId}/book`,
    headers,
    payload: JSON.stringify({ patientId, startsAt: startsAt.toISOString(), service: 'Checkup', durationMin: 30 }),
  });
}

function outbox(tenantId: string, appointmentId: string) {
  return db.notificationEvent.findMany({
    where: { tenantId, appointmentId, source: CONFIRMATION_OUTBOX_SOURCE },
    select: { channel: true, status: true, consentChecked: true, idempotencyKey: true },
    orderBy: { channel: 'asc' },
  });
}

describe('staff booking confirmations', () => {
  it('queues nothing when the clinic has not opted in', async () => {
    // The default. Turning messaging on for an existing tenant would send
    // patients messages their clinic never asked to send.
    const { tenantId, provider, patient, headers } = await bookableClinic();
    const res = await book(app, provider.id, patient.id, headers, nextWeekAt(10));
    expect(res.statusCode).toBe(201);

    const appointmentId = (res.json() as { id: string }).id;
    expect(await outbox(tenantId, appointmentId)).toHaveLength(0);
    expect((res.json() as { confirmationsQueued: string[] }).confirmationsQueued).toEqual([]);
  }, 90_000);

  it('queues the channels the clinic turned on', async () => {
    const { tenantId, provider, patient, headers } = await bookableClinic({
      confirmBookingsBySms: true, confirmBookingsByEmail: true,
    });
    const res = await book(app, provider.id, patient.id, headers, nextWeekAt(11));
    expect(res.statusCode).toBe(201);

    const appointmentId = (res.json() as { id: string }).id;
    const events = await outbox(tenantId, appointmentId);
    expect(events.map(e => e.channel)).toEqual(['email', 'sms']);
    for (const event of events) {
      expect(event.status).toBe('queued');
      // Consent is decided at the delivery boundary. Recording it as checked
      // here would assert an authority nothing has evaluated yet.
      expect(event.consentChecked).toBe(false);
      expect(event.idempotencyKey).toBe(`${appointmentId}:${event.channel}`);
    }
  }, 90_000);

  it('queues only the channel the patient can actually receive', async () => {
    const { tenantId, provider, patient, headers } = await bookableClinic({
      confirmBookingsBySms: true, confirmBookingsByEmail: true,
    });
    await db.patient.update({ where: { id: patient.id }, data: { phone: null } });

    const res = await book(app, provider.id, patient.id, headers, nextWeekAt(12));
    expect(res.statusCode).toBe(201);

    const appointmentId = (res.json() as { id: string }).id;
    // No phone means no SMS to queue. Queueing one would guarantee a failure
    // and report an attempt that never had a destination.
    expect((await outbox(tenantId, appointmentId)).map(e => e.channel)).toEqual(['email']);
  }, 90_000);

  it('reports what was queued, not that anything was sent', async () => {
    const { provider, patient, headers } = await bookableClinic({ confirmBookingsByEmail: true });
    const res = await book(app, provider.id, patient.id, headers, nextWeekAt(13));
    expect(res.statusCode).toBe(201);

    const body = res.json() as { confirmationsQueued: string[] };
    expect(body.confirmationsQueued).toEqual(['email']);
    // Nothing has left the building yet, and the delivery boundary may still
    // suppress it. The field name has to say so.
    expect(JSON.stringify(body)).not.toContain('confirmationsSent');
  }, 90_000);
});
