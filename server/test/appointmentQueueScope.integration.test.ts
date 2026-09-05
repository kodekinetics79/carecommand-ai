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

// The insurance verification queue is what a receptionist works on check-in day.
// It selected every appointment the tenant had ever recorded, oldest first, with
// no status or date filter — so it opened onto months-old cancellations and
// no-shows sitting beside a live "Request eligibility response" button, at the
// busiest moment of the day. Nothing can be verified for a visit that was
// cancelled, missed, or already completed.

let app: FastifyInstance;
const cleanup: Array<() => Promise<void>> = [];
const DAY = 86_400_000;

beforeAll(async () => { app = await buildApp(); }, 90_000);

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  await app?.close();
  await db.$disconnect();
});

async function clinic() {
  const tenantId = randomUUID();
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `queue-${tag}`, slug: `queue-${tag}` } });
  cleanup.push(async () => { await db.tenant.delete({ where: { id: tenantId } }).catch(() => {}); });

  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);

  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'Main', timezone: 'UTC' } });
  const password = `Queue-Pw-${tag}!`;
  const user = await db.user.create({
    data: {
      tenantId, role: 'OWNER', active: true,
      email: `owner-${tag}@queue.test`, displayName: 'Owner',
      passwordHash: await generatePasswordHash(password), passwordChangedAt: new Date(),
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: user.email, password }),
  });
  const body = login.json() as { accessToken?: string; token?: string };
  return {
    tenantId, branch,
    headers: { authorization: `Bearer ${body.accessToken ?? body.token}` },
  };
}

async function appointment(tenantId: string, branchId: string, name: string, status: string, startsAt: Date) {
  const patient = await db.patient.create({
    data: { tenantId, branchId, firstName: name, lastName: 'Q', lifecycleStage: 'ACTIVE' },
  });
  return db.appointment.create({
    data: {
      tenantId, branchId, patientId: patient.id,
      service: 'Checkup', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: status as never, channel: 'EMAIL',
    },
  });
}

async function queue(headers: Record<string, string>, params = '') {
  const res = await app.inject({ method: 'GET', url: `/v1/revenue-protection/appointment-queue${params}`, headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { appointments: Array<{ appointmentId?: string; id?: string; clinicTimezone?: string }> }).appointments;
}

describe('insurance verification queue scope', () => {
  it('leaves out visits that can no longer be verified', async () => {
    const { tenantId, branch, headers } = await clinic();
    const soon = new Date(Date.now() + 2 * 3_600_000);

    const confirmed = await appointment(tenantId, branch.id, 'Confirmed', 'CONFIRMED', soon);
    const arrived = await appointment(tenantId, branch.id, 'Arrived', 'ARRIVED', soon);
    await appointment(tenantId, branch.id, 'Canceled', 'CANCELED', soon);
    await appointment(tenantId, branch.id, 'Missed', 'NO_SHOW', soon);
    await appointment(tenantId, branch.id, 'Done', 'COMPLETED', soon);

    const rows = await queue(headers);
    const ids = rows.map(r => r.appointmentId ?? r.id);
    expect(ids).toContain(confirmed.id);
    expect(ids).toContain(arrived.id);
    // Offering "Request eligibility response" on any of these is work that
    // cannot help anyone.
    expect(ids).toHaveLength(2);
  }, 90_000);

  it('leaves out a stale appointment from months ago', async () => {
    const { tenantId, branch, headers } = await clinic();
    const fresh = await appointment(tenantId, branch.id, 'Today', 'CONFIRMED', new Date(Date.now() + 3_600_000));
    await appointment(tenantId, branch.id, 'Ancient', 'CONFIRMED', new Date(Date.now() - 120 * DAY));

    const ids = (await queue(headers)).map(r => r.appointmentId ?? r.id);
    expect(ids).toEqual([fresh.id]);
  }, 90_000);

  it('honours an explicit clinic-day window', async () => {
    const { tenantId, branch, headers } = await clinic();
    const dayStart = new Date(Date.now() + 3 * DAY);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + DAY);

    const inDay = await appointment(tenantId, branch.id, 'InDay', 'CONFIRMED', new Date(dayStart.getTime() + 10 * 3_600_000));
    await appointment(tenantId, branch.id, 'NextDay', 'CONFIRMED', new Date(dayEnd.getTime() + 3_600_000));

    const params = `?from=${encodeURIComponent(dayStart.toISOString())}&to=${encodeURIComponent(dayEnd.toISOString())}`;
    const ids = (await queue(headers, params)).map(r => r.appointmentId ?? r.id);
    // The caller owns the timezone; the route must respect the window it sends
    // rather than substituting a guess.
    expect(ids).toEqual([inDay.id]);
  }, 90_000);

  it('returns the clinic timezone with every appointment so the browser does not guess', async () => {
    const { tenantId, branch, headers } = await clinic();
    await db.branch.update({ where: { id: branch.id }, data: { timezone: 'America/Los_Angeles' } });
    await appointment(tenantId, branch.id, 'Timezone', 'CONFIRMED', new Date(Date.now() + 3_600_000));

    const rows = await queue(headers);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clinicTimezone).toBe('America/Los_Angeles');
  }, 90_000);
});
