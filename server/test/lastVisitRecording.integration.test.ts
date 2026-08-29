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
const { buildAudience } = await import('../lib/campaigns');
const { runInTenantContext } = await import('../lib/tenantContext');

// Completing a visit is the only moment the product learns a patient was seen,
// and nothing ever wrote it down: Patient.lastVisitAt was NULL for everyone.
// Three audiences read it to decide who has lapsed, and all of them fall through
// to `createdAt < cutoff` when it is NULL — so a patient seen yesterday looked
// exactly like one never seen, and a pilot's first reactivation campaign would
// phone people who had just been in the chair.

let app: FastifyInstance;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => { app = await buildApp(); }, 90_000);

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  await app?.close();
  await db.$disconnect();
});

const DAY = 86_400_000;

async function clinic() {
  const tenantId = randomUUID();
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `visit-${tag}`, slug: `visit-${tag}` } });
  cleanup.push(async () => { await db.tenant.delete({ where: { id: tenantId } }).catch(() => {}); });

  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);

  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'Main', timezone: 'UTC' } });
  const password = `Visit-Pw-${tag}!`;
  const user = await db.user.create({
    data: {
      tenantId, role: 'OWNER', active: true,
      email: `owner-${tag}@visit.test`, displayName: 'Owner',
      passwordHash: await generatePasswordHash(password), passwordChangedAt: new Date(),
    },
  });

  const login = await app.inject({
    method: 'POST', url: '/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: user.email, password }),
  });
  const token = (login.json() as { accessToken?: string; token?: string }).accessToken
    ?? (login.json() as { token: string }).token;

  return { tenantId, branch, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
}

async function seenPatient(tenantId: string, branchId: string, startsAt: Date, firstName: string, status: 'ARRIVED' | 'CONFIRMED' = 'ARRIVED') {
  const patient = await db.patient.create({
    data: {
      tenantId, branchId, firstName, lastName: 'Visitor',
      phone: `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      lifecycleStage: 'ACTIVE',
      // Registered long ago, so the reactivation cutoff catches them on
      // createdAt unless a real visit is recorded.
      createdAt: new Date(Date.now() - 400 * DAY),
    },
  });
  const appointment = await db.appointment.create({
    data: {
      tenantId, branchId, patientId: patient.id,
      service: 'Checkup', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status, channel: 'EMAIL',
    },
  });
  return { patient, appointment };
}

describe('last visit recording', () => {
  it('records the visit when an appointment is completed', async () => {
    const { tenantId, branch, headers } = await clinic();
    const startsAt = new Date(Date.now() - 2 * DAY);
    const { patient, appointment } = await seenPatient(tenantId, branch.id, startsAt, 'Recent');

    expect((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).lastVisitAt).toBeNull();

    const res = await app.inject({
      method: 'PATCH', url: `/v1/appointments/${appointment.id}/status`,
      headers, payload: JSON.stringify({ status: 'COMPLETED' }),
    });
    expect(res.statusCode).toBe(200);

    const after = await db.patient.findUniqueOrThrow({ where: { id: patient.id } });
    // Stamped with the appointment's own start, not "now": completing
    // yesterday's list this morning must record yesterday.
    expect(after.lastVisitAt?.toISOString()).toBe(startsAt.toISOString());
  }, 90_000);

  it('never moves a recorded visit backwards', async () => {
    const { tenantId, branch, headers } = await clinic();
    const recent = new Date(Date.now() - 1 * DAY);
    const { patient } = await seenPatient(tenantId, branch.id, recent, 'Forward');
    await db.patient.update({ where: { id: patient.id }, data: { lastVisitAt: recent } });

    // A much older appointment completed late must not erase the recent visit.
    const stale = await db.appointment.create({
      data: {
        tenantId, branchId: branch.id, patientId: patient.id,
        service: 'Old checkup', startsAt: new Date(Date.now() - 300 * DAY),
        endsAt: new Date(Date.now() - 300 * DAY + 30 * 60_000),
        status: 'ARRIVED', channel: 'EMAIL',
      },
    });
    const res = await app.inject({
      method: 'PATCH', url: `/v1/appointments/${stale.id}/status`,
      headers, payload: JSON.stringify({ status: 'COMPLETED' }),
    });
    expect(res.statusCode).toBe(200);

    const after = await db.patient.findUniqueOrThrow({ where: { id: patient.id } });
    expect(after.lastVisitAt?.toISOString()).toBe(recent.toISOString());
  }, 90_000);

  it('leaves a recently seen patient out of the reactivation audience', async () => {
    // The consequence, end to end. Both patients registered 400 days ago, so
    // both match on createdAt; only the completed visit distinguishes them.
    const { tenantId, branch, headers } = await clinic();
    const { patient: seen, appointment } = await seenPatient(tenantId, branch.id, new Date(Date.now() - 2 * DAY), 'JustSeen');
    const { patient: lapsed } = await seenPatient(tenantId, branch.id, new Date(Date.now() - 300 * DAY), 'LongGone');

    // buildAudience reads under RLS, so it needs a trusted context.
    const audience = () => runInTenantContext(
      { tenantId, actorId: 'worker:last-visit-test', actorRole: 'WORKER', source: 'worker' },
      () => buildAudience(tenantId, 'inactive_patients', {}),
    );
    const before = await audience();
    expect(before.map(c => c.patientId).sort()).toEqual([seen.id, lapsed.id].sort());

    const res = await app.inject({
      method: 'PATCH', url: `/v1/appointments/${appointment.id}/status`,
      headers, payload: JSON.stringify({ status: 'COMPLETED' }),
    });
    expect(res.statusCode).toBe(200);

    const after = await audience();
    const targeted = after.map(c => c.patientId);
    expect(targeted).not.toContain(seen.id);
    expect(targeted).toContain(lapsed.id);
  }, 90_000);

  it('does not record a visit for a no-show', async () => {
    const { tenantId, branch, headers } = await clinic();
    const { patient, appointment } = await seenPatient(tenantId, branch.id, new Date(Date.now() - 2 * DAY), 'NoShow', 'CONFIRMED');

    const res = await app.inject({
      method: 'PATCH', url: `/v1/appointments/${appointment.id}/status`,
      headers, payload: JSON.stringify({ status: 'NO_SHOW' }),
    });
    expect(res.statusCode).toBe(200);

    // They were not seen. Recording a visit here would hide exactly the patient
    // a recovery campaign exists to reach.
    expect((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).lastVisitAt).toBeNull();
  }, 90_000);
});
