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
const { env } = await import('../config/env');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { recomputeEntitlements } = await import('../lib/entitlements');
const { __setProviderSnapshotForTests } = await import('../lib/providerCredentials');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `reminders-${id.slice(0, 6)}`, slug: `reminders-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const subscriptionPlan = await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: subscriptionPlan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main clinic', location: 'Synthetic', timezone: 'UTC' } });
  const owner = await db.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id}@example.test`, displayName: 'Clinic owner' } });
  const analyst = await db.user.create({ data: { tenantId: id, role: 'ANALYST', active: true, email: `analyst-${id}@example.test`, displayName: 'Analyst' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Synthetic', lastName: 'Patient', phone: '+12125550111' } });
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  const appointment = await db.appointment.create({ data: {
    tenantId: id,
    branchId: branch.id,
    patientId: patient.id,
    service: 'Wellness visit',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    channel: 'EMAIL',
  } });
  return { id, branchId: branch.id, ownerId: owner.id, analystId: analyst.id, appointment, startsAt };
}

type TenantFixture = Awaited<ReturnType<typeof makeTenant>>;
const auth = (tenant: TenantFixture, role: 'OWNER' | 'ANALYST' = 'OWNER') => ({
  authorization: `Bearer ${app.jwt.sign({
    userId: role === 'OWNER' ? tenant.ownerId : tenant.analystId,
    tenantId: tenant.id,
    role,
    type: 'access',
  })}`,
});

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('per-appointment communication plans', () => {
  it('leaves existing appointments opted out until a plan is deliberately saved', async () => {
    const tenant = await makeTenant();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/appointments/${tenant.appointment.id}/communication-plan`,
      headers: auth(tenant),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      mode: 'NONE',
      status: 'PAUSED',
      reminderLeadMinutes: 1440,
      revision: null,
      appointmentVersion: 1,
      messages: [],
      summary: 'No reminders selected',
    });
    expect(await db.appointmentCommunicationPlan.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('records SMS and BOTH deterministically without pretending either dispatcher is live', async () => {
    const tenant = await makeTenant();
    const create = await app.inject({
      method: 'PUT',
      url: `/v1/appointments/${tenant.appointment.id}/communication-plan`,
      headers: auth(tenant),
      payload: { mode: 'SMS', reminderLeadMinutes: 1440, appointmentVersion: 1, revision: null },
    });
    expect(create.statusCode, create.body).toBe(200);
    expect(create.json()).toMatchObject({
      mode: 'SMS', status: 'BLOCKED_SETUP', revision: 1, appointmentVersion: 1,
      summary: 'Text reminder selected; automation setup needed',
      messages: [{ channel: 'SMS', state: 'setup_needed' }],
    });
    expect(new Date(create.json().messages[0].dueAt)).toEqual(new Date(tenant.startsAt.getTime() - 1440 * 60_000));

    const update = await app.inject({
      method: 'PUT',
      url: `/v1/appointments/${tenant.appointment.id}/communication-plan`,
      headers: auth(tenant),
      payload: { mode: 'BOTH', reminderLeadMinutes: 120, appointmentVersion: 1, revision: 1 },
    });
    expect(update.statusCode, update.body).toBe(200);
    expect(update.json()).toMatchObject({
      mode: 'BOTH', status: 'BLOCKED_SETUP', revision: 2, appointmentVersion: 1,
      summary: 'Text and call reminders selected; automation setup needed',
      messages: [
        { channel: 'SMS', state: 'setup_needed' },
        { channel: 'VOICE', state: 'setup_needed' },
      ],
    });
    const actions = await db.appointmentCommunicationAction.findMany({
      where: { tenantId: tenant.id, appointmentId: tenant.appointment.id },
      orderBy: [{ planRevision: 'asc' }, { channel: 'asc' }],
    });
    expect(actions.map(action => [action.planRevision, action.channel, action.status])).toEqual([
      [1, 'SMS', 'CANCELLED'],
      [2, 'SMS', 'BLOCKED_SETUP'],
      [2, 'VOICE', 'BLOCKED_SETUP'],
    ]);
    expect(await db.auditEvent.count({ where: {
      tenantId: tenant.id,
      action: 'appointment.communication_plan.updated',
      resourceId: tenant.appointment.id,
    } })).toBe(2);
  });

  it('rejects stale tabs, concurrent overwrites, unauthorized writers, and cross-tenant ids', async () => {
    const tenant = await makeTenant();
    const other = await makeTenant();
    const payload = { mode: 'SMS', reminderLeadMinutes: 1440, appointmentVersion: 1, revision: null };

    const forbidden = await app.inject({ method: 'PUT', url: `/v1/appointments/${tenant.appointment.id}/communication-plan`, headers: auth(tenant, 'ANALYST'), payload });
    expect(forbidden.statusCode).toBe(403);
    const foreign = await app.inject({ method: 'GET', url: `/v1/appointments/${other.appointment.id}/communication-plan`, headers: auth(tenant) });
    expect(foreign.statusCode).toBe(404);

    const [first, second] = await Promise.all([
      app.inject({ method: 'PUT', url: `/v1/appointments/${tenant.appointment.id}/communication-plan`, headers: auth(tenant), payload }),
      app.inject({ method: 'PUT', url: `/v1/appointments/${tenant.appointment.id}/communication-plan`, headers: auth(tenant), payload }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);

    const staleRevision = await app.inject({ method: 'PUT', url: `/v1/appointments/${tenant.appointment.id}/communication-plan`, headers: auth(tenant), payload });
    expect(staleRevision.statusCode).toBe(409);
    const staleAppointment = await app.inject({
      method: 'PUT', url: `/v1/appointments/${tenant.appointment.id}/communication-plan`, headers: auth(tenant),
      payload: { ...payload, appointmentVersion: 99, revision: 1 },
    });
    expect(staleAppointment.statusCode).toBe(409);
  });

  it('rejects reminders for a waitlisted appointment', async () => {
    const tenant = await makeTenant();
    await db.appointment.update({ where: { id: tenant.appointment.id }, data: { status: 'WAITLIST' } });
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/appointments/${tenant.appointment.id}/communication-plan`,
      headers: auth(tenant),
      payload: { mode: 'SMS', reminderLeadMinutes: 1440, appointmentVersion: 1, revision: null },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(await db.appointmentCommunicationPlan.count({ where: {
      tenantId: tenant.id, appointmentId: tenant.appointment.id,
    } })).toBe(0);
  });

  it('rebases the plan and invalidates confirmation atomically when staff reschedules', async () => {
    const tenant = await makeTenant();
    await db.appointment.update({ where: { id: tenant.appointment.id }, data: {
      patientConfirmedAt: new Date(),
      patientConfirmationSource: 'staff',
      patientConfirmedAppointmentVersion: 1,
    } });
    const saved = await app.inject({
      method: 'PUT', url: `/v1/appointments/${tenant.appointment.id}/communication-plan`, headers: auth(tenant),
      payload: { mode: 'BOTH', reminderLeadMinutes: 60, appointmentVersion: 1, revision: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const nextStart = new Date(tenant.startsAt.getTime() + 86_400_000);
    const moved = await app.inject({
      method: 'PATCH', url: `/v1/appointments/${tenant.appointment.id}/reschedule`, headers: auth(tenant),
      payload: { startsAt: nextStart, endsAt: new Date(nextStart.getTime() + 30 * 60_000) },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({
      version: 2,
      patientConfirmedAt: null,
      patientConfirmationSource: null,
      patientConfirmedCallLogId: null,
      patientConfirmedAppointmentVersion: null,
    });

    const plan = await db.appointmentCommunicationPlan.findUniqueOrThrow({
      where: { tenantId_appointmentId: { tenantId: tenant.id, appointmentId: tenant.appointment.id } },
    });
    expect(plan).toMatchObject({ revision: 2, appointmentVersion: 2, mode: 'BOTH', status: 'BLOCKED_SETUP' });
    const actions = await db.appointmentCommunicationAction.findMany({
      where: { tenantId: tenant.id, appointmentId: tenant.appointment.id },
      orderBy: [{ planRevision: 'asc' }, { channel: 'asc' }],
    });
    expect(actions.map(action => [action.planRevision, action.appointmentVersion, action.channel, action.status])).toEqual([
      [1, 1, 'SMS', 'CANCELLED'],
      [1, 1, 'VOICE', 'CANCELLED'],
      [2, 2, 'SMS', 'BLOCKED_SETUP'],
      [2, 2, 'VOICE', 'BLOCKED_SETUP'],
    ]);
    expect(actions.filter(action => action.planRevision === 2).every(action => action.dueAt.getTime() === nextStart.getTime() - 60 * 60_000)).toBe(true);
  });

  it('enforces tenant-scoped relationships, forced RLS, and the dispatcher setup fence in PostgreSQL', async () => {
    const tenant = await makeTenant();
    const other = await makeTenant();
    await expect(db.appointmentCommunicationPlan.create({ data: {
      tenantId: tenant.id,
      appointmentId: other.appointment.id,
      mode: 'NONE',
      status: 'PAUSED',
      reminderLeadMinutes: 1440,
      revision: 1,
      appointmentVersion: 1,
      updatedByUserId: tenant.ownerId,
    } })).rejects.toBeDefined();

    const saved = await app.inject({
      method: 'PUT', url: `/v1/appointments/${tenant.appointment.id}/communication-plan`, headers: auth(tenant),
      payload: { mode: 'SMS', reminderLeadMinutes: 1440, appointmentVersion: 1, revision: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const plan = await db.appointmentCommunicationPlan.findUniqueOrThrow({
      where: { tenantId_appointmentId: { tenantId: tenant.id, appointmentId: tenant.appointment.id } },
    });
    await expect(db.appointmentCommunicationAction.create({ data: {
      tenantId: tenant.id,
      appointmentId: tenant.appointment.id,
      planId: plan.id,
      appointmentVersion: 1,
      planRevision: 2,
      kind: 'REMINDER',
      channel: 'VOICE',
      sequence: 1,
      status: 'QUEUED',
      dueAt: new Date(),
    } })).rejects.toBeDefined();

    const rls = await db.$queryRaw<Array<{ tableName: string; enabled: boolean; forced: boolean }>>`
      SELECT c.relname AS "tableName", c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('AppointmentCommunicationPlan', 'AppointmentCommunicationAction')
      ORDER BY c.relname
    `;
    expect(rls).toEqual([
      { tableName: 'AppointmentCommunicationAction', enabled: true, forced: true },
      { tableName: 'AppointmentCommunicationPlan', enabled: true, forced: true },
    ]);
  });

  it('stops pending reminders in the same transaction when an appointment is cancelled', async () => {
    const tenant = await makeTenant();
    const saved = await app.inject({
      method: 'PUT', url: `/v1/appointments/${tenant.appointment.id}/communication-plan`, headers: auth(tenant),
      payload: { mode: 'BOTH', reminderLeadMinutes: 1440, appointmentVersion: 1, revision: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const cancelled = await app.inject({
      method: 'PATCH', url: `/v1/appointments/${tenant.appointment.id}/cancel`, headers: auth(tenant), payload: {},
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const plan = await db.appointmentCommunicationPlan.findUniqueOrThrow({
      where: { tenantId_appointmentId: { tenantId: tenant.id, appointmentId: tenant.appointment.id } },
    });
    expect(plan).toMatchObject({ status: 'CANCELLED', revision: 2, appointmentVersion: 1 });
    expect(await db.appointmentCommunicationAction.count({ where: {
      tenantId: tenant.id,
      appointmentId: tenant.appointment.id,
      status: { in: ['QUEUED', 'BLOCKED_SETUP'] },
    } })).toBe(0);
  });

  it.each(['ARRIVED', 'NO_SHOW', 'COMPLETED'] as const)(
    'atomically stops pending reminders when an appointment becomes %s',
    async status => {
      const originalNodeEnv = env.NODE_ENV;
      const originalQueuesEnabled = env.QUEUES_ENABLED;
      env.NODE_ENV = 'test';
      env.QUEUES_ENABLED = true;
      __setProviderSnapshotForTests({ sms: {
        accountSid: 'mock_status_transition_reminders',
        authToken: 'mock-token',
        fromNumber: '+15550000000',
      } });
      try {
        const tenant = await makeTenant();
        const saved = await app.inject({
          method: 'PUT', url: `/v1/appointments/${tenant.appointment.id}/communication-plan`, headers: auth(tenant),
          payload: { mode: 'SMS', reminderLeadMinutes: 1440, appointmentVersion: 1, revision: null },
        });
        expect(saved.statusCode, saved.body).toBe(200);
        expect(saved.json()).toMatchObject({ status: 'ACTIVE', messages: [{ state: 'scheduled' }] });
        const pendingEvent = await db.notificationEvent.findFirstOrThrow({ where: {
          tenantId: tenant.id,
          appointmentId: tenant.appointment.id,
          source: 'appointment.reminder',
        } });

        const transitioned = await app.inject({
          method: 'PATCH', url: `/v1/appointments/${tenant.appointment.id}/status`, headers: auth(tenant),
          payload: { status },
        });
        expect(transitioned.statusCode, transitioned.body).toBe(200);
        expect(transitioned.json().status).toBe(status);

        const plan = await db.appointmentCommunicationPlan.findUniqueOrThrow({
          where: { tenantId_appointmentId: { tenantId: tenant.id, appointmentId: tenant.appointment.id } },
        });
        expect(plan).toMatchObject({ status: 'CANCELLED', revision: 2, appointmentVersion: 1 });
        await expect(db.appointmentCommunicationAction.findFirstOrThrow({ where: {
          tenantId: tenant.id, appointmentId: tenant.appointment.id,
        } })).resolves.toMatchObject({ status: 'CANCELLED' });
        await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: pendingEvent.id } })).resolves.toMatchObject({
          status: 'suppressed',
          failureReason: 'appointment_communication_changed',
        });
        expect(await db.notificationDeliveryAttempt.count({ where: {
          tenantId: tenant.id, notificationEventId: pendingEvent.id, phase: 'PROVIDER_INTENT',
        } })).toBe(0);
      } finally {
        env.NODE_ENV = originalNodeEnv;
        env.QUEUES_ENABLED = originalQueuesEnabled;
        __setProviderSnapshotForTests({});
      }
    },
  );
});
