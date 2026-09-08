import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.hoisted(() => vi.fn());
vi.mock('../lib/commsProvider', () => ({
  sendAuthorizedAppointmentConfirmation: async (
    channel: 'sms' | 'email',
    destination: string,
    subject: string,
    body: string,
    idempotencyKey: string,
    authorization: { tenantId: string; eventId: string; attemptNumber: number; source?: string },
  ) => {
    // Model the real one-consumer submission claim without any network I/O.
    const { fixtureDb } = await import('./helpers/fixtureDb');
    await fixtureDb.notificationDeliveryAttempt.create({ data: {
      tenantId: authorization.tenantId,
      notificationEventId: authorization.eventId,
      attemptNumber: authorization.attemptNumber,
      phase: 'SUBMISSION_CLAIM',
      status: 'submission_claimed',
      completedAt: new Date(),
    } });
    return sendMessage(channel, destination, subject, body, idempotencyKey, authorization);
  },
}));

const { env } = await import('../config/env');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { __setProviderSnapshotForTests } = await import('../lib/providerCredentials');
const { runWithTenantContext } = await import('../lib/tenantContext');
const {
  APPOINTMENT_REMINDER_OUTBOX_SOURCE,
  advanceCommunicationPlanAfterReschedule,
  appointmentSmsAutomationReadiness,
  cancelAppointmentCommunicationPlan,
  communicationPlanStatus,
  lockAppointmentCommunication,
  replaceAppointmentCommunicationActions,
} = await import('../lib/appointmentCommunicationPlans');
const {
  dispatchDueAppointmentNotifications,
  setConfirmationBoundaryTestHook,
} = await import('../lib/receptionist/confirmationOutbox');

const describeDisposable = process.env.RLS_DISPOSABLE_DB ? describe : describe.skip;
const originalNodeEnv = env.NODE_ENV;
const originalQueuesEnabled = env.QUEUES_ENABLED;

function nonQuietWindow(): { start: string; end: string } {
  const now = new Date();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const hhmm = (value: number) => {
    const normalized = (value + 1440) % 1440;
    return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
  };
  return { start: hhmm(minute + 60), end: hhmm(minute + 61) };
}

async function fixture() {
  const tenantId = randomUUID();
  await db.tenant.create({ data: {
    id: tenantId,
    name: `reminder-${tenantId.slice(0, 8)}`,
    slug: `reminder-${tenantId.slice(0, 8)}`,
  } });
  const quiet = nonQuietWindow();
  await db.schedulingPolicy.create({ data: {
    tenantId,
    communicationQuietHoursStart: quiet.start,
    communicationQuietHoursEnd: quiet.end,
  } });
  const branch = await db.branch.create({ data: {
    tenantId, name: 'Reminder branch', location: 'Synthetic', timezone: 'UTC', active: true,
  } });
  const owner = await db.user.create({ data: {
    tenantId, role: 'OWNER', active: true,
    email: `owner-${tenantId}@example.test`, displayName: 'Synthetic owner',
  } });
  const patient = await db.patient.create({ data: {
    tenantId, branchId: branch.id, firstName: 'Avery', lastName: 'Synthetic',
    phone: '+12125550111', lifecycleStage: 'ACTIVE',
  } });
  const startsAt = new Date(Date.now() + 2 * 60 * 60_000);
  const appointment = await db.appointment.create({ data: {
    tenantId, branchId: branch.id, patientId: patient.id,
    service: 'Wellness visit', startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    status: 'CONFIRMED', channel: 'CALL',
  } });
  return { tenantId, branch, owner, patient, appointment, startsAt };
}

type ReminderFixture = Awaited<ReturnType<typeof fixture>>;

async function savePlan(item: ReminderFixture, mode: 'SMS' | 'VOICE' | 'BOTH' = 'SMS') {
  return runWithTenantContext(item.tenantId, async tx => {
    await lockAppointmentCommunication(tx, item.tenantId, item.appointment.id);
    const plan = await tx.appointmentCommunicationPlan.create({ data: {
      tenantId: item.tenantId,
      appointmentId: item.appointment.id,
      updatedByUserId: item.owner.id,
      mode,
      status: communicationPlanStatus(mode),
      reminderLeadMinutes: 180,
      revision: 1,
      appointmentVersion: item.appointment.version,
    } });
    const smsQueued = await replaceAppointmentCommunicationActions(tx, {
      tenantId: item.tenantId,
      appointmentId: item.appointment.id,
      planId: plan.id,
      appointmentVersion: item.appointment.version,
      planRevision: 1,
      mode,
      startsAt: item.startsAt,
      reminderLeadMinutes: 180,
    });
    return tx.appointmentCommunicationPlan.update({
      where: { id: plan.id },
      data: { status: communicationPlanStatus(mode, smsQueued) },
      include: { actions: { include: { notificationEvent: true } } },
    });
  }, { id: item.owner.id, role: 'OWNER' });
}

function enableMockOnly() {
  env.NODE_ENV = 'test';
  env.QUEUES_ENABLED = true;
  __setProviderSnapshotForTests({ sms: {
    accountSid: 'mock_appointment_reminders',
    authToken: 'mock-token',
    fromNumber: '+15550000000',
  } });
}

describeDisposable('appointment reminder SMS — mock-only durable framework', () => {
  beforeEach(() => {
    sendMessage.mockReset();
    sendMessage.mockResolvedValue({
      ok: true, status: 'sent', mode: 'mock_dev', providerMessageId: `mock-${randomUUID()}`,
    });
    setConfirmationBoundaryTestHook(null);
    enableMockOnly();
  });

  afterEach(() => {
    setConfirmationBoundaryTestHook(null);
    env.NODE_ENV = originalNodeEnv;
    env.QUEUES_ENABLED = originalQueuesEnabled;
    __setProviderSnapshotForTests({});
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it.each([
    {
      label: 'production even with mock credentials',
      configure: () => { enableMockOnly(); env.NODE_ENV = 'production'; },
      reason: 'production_activation_required',
    },
    {
      label: 'a real provider in non-production',
      configure: () => {
        env.NODE_ENV = 'test'; env.QUEUES_ENABLED = true;
        __setProviderSnapshotForTests({ sms: { accountSid: 'AC-real', authToken: 'real-token', fromNumber: '+15550000000' } });
      },
      reason: 'real_provider_activation_required',
    },
    {
      label: 'a disabled queue',
      configure: () => { enableMockOnly(); env.QUEUES_ENABLED = false; },
      reason: 'automation_queue_unavailable',
    },
  ])('fails closed for $label and creates no send event', async ({ configure, reason }) => {
    configure();
    expect(appointmentSmsAutomationReadiness()).toEqual({ ready: false, reason });
    const item = await fixture();
    const plan = await savePlan(item);
    expect(plan.status).toBe('BLOCKED_SETUP');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ channel: 'SMS', status: 'BLOCKED_SETUP' });
    expect(plan.actions[0]!.notificationEvent).toBeNull();
  });

  it('blocks a selected SMS reminder when the patient has no current phone', async () => {
    const item = await fixture();
    await db.patient.update({ where: { id: item.patient.id }, data: { phone: null } });
    const plan = await savePlan(item);
    expect(plan.status).toBe('BLOCKED_SETUP');
    expect(plan.actions[0]).toMatchObject({ status: 'BLOCKED_SETUP', notificationEvent: null });
  });

  it('creates one version-linked mock SMS event atomically and keeps voice blocked', async () => {
    const item = await fixture();
    const plan = await savePlan(item, 'BOTH');
    expect(plan.status).toBe('BLOCKED_SETUP');
    const sms = plan.actions.find(action => action.channel === 'SMS')!;
    const voice = plan.actions.find(action => action.channel === 'VOICE')!;
    expect(sms.status).toBe('QUEUED');
    expect(voice).toMatchObject({ status: 'BLOCKED_SETUP', notificationEvent: null });
    expect(sms.notificationEvent).toMatchObject({
      source: APPOINTMENT_REMINDER_OUTBOX_SOURCE,
      status: 'queued',
      appointmentId: item.appointment.id,
      appointmentCommunicationActionId: sms.id,
      patientId: item.patient.id,
      idempotencyKey: `${item.appointment.id}:v1:r1:reminder:sms:1`,
    });
    expect(sms.notificationEvent!.nextAttemptAt).toEqual(sms.dueAt);
    expect(sms.notificationEvent!.sentAt).toBeNull();
    expect(sms.notificationEvent!.deliveredAt).toBeNull();
  });

  it('preserves one confirmation per channel while allowing reminder revisions', async () => {
    const item = await fixture();
    const plan = await savePlan(item);
    expect(plan.actions[0]!.notificationEvent).not.toBeNull();
    const confirmation = {
      tenantId: item.tenantId,
      appointmentId: item.appointment.id,
      patientId: item.patient.id,
      recipientType: 'patient',
      channel: 'sms',
      status: 'queued',
      attempts: 0,
      consentChecked: false,
      consentResult: 'not_recorded_transactional',
      source: 'receptionist.appointment_confirmation',
    } as const;
    await expect(db.notificationEvent.create({ data: {
      ...confirmation, idempotencyKey: `${item.appointment.id}:sms`,
    } })).resolves.toMatchObject({ source: 'receptionist.appointment_confirmation' });
    await expect(db.notificationEvent.create({ data: {
      ...confirmation, idempotencyKey: `${item.appointment.id}:sms:duplicate`,
    } })).rejects.toBeDefined();
  });

  it('rechecks queue/provider readiness immediately before intent and blocks if it was lost', async () => {
    const item = await fixture();
    const plan = await savePlan(item);
    env.QUEUES_ENABLED = false;

    await dispatchDueAppointmentNotifications(item.tenantId);
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: plan.actions[0]!.notificationEvent!.id } }))
      .resolves.toMatchObject({ status: 'failed', failureReason: 'automation_queue_unavailable' });
    await expect(db.appointmentCommunicationAction.findUniqueOrThrow({ where: { id: plan.actions[0]!.id } }))
      .resolves.toMatchObject({ status: 'BLOCKED_SETUP' });
    await expect(db.appointmentCommunicationPlan.findUniqueOrThrow({ where: { id: plan.id } }))
      .resolves.toMatchObject({ status: 'BLOCKED_SETUP' });
  });

  it('records provider acceptance, not delivery, and duplicate execution is a no-op', async () => {
    const item = await fixture();
    const plan = await savePlan(item);
    const action = plan.actions[0]!;
    const eventId = action.notificationEvent!.id;

    await expect(dispatchDueAppointmentNotifications(item.tenantId)).resolves.toEqual({ scanned: 1 });
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event).toMatchObject({ status: 'accepted', attempts: 1, provider: 'mock' });
    expect(event.acceptedAt).not.toBeNull();
    expect(event.sentAt).toBeNull();
    expect(event.deliveredAt).toBeNull();
    await expect(db.appointmentCommunicationAction.findUniqueOrThrow({ where: { id: action.id } }))
      .resolves.toMatchObject({ status: 'PROVIDER_ACCEPTED' });
    expect(sendMessage).toHaveBeenCalledWith(
      'sms', item.patient.phone, 'Appointment reminder',
      expect.stringMatching(/^Hi Avery, reminder: your Wellness visit is scheduled for .+Reply STOP to opt out\.$/),
      event.idempotencyKey,
      expect.objectContaining({ source: APPOINTMENT_REMINDER_OUTBOX_SOURCE }),
    );

    await expect(dispatchDueAppointmentNotifications(item.tenantId)).resolves.toEqual({ scanned: 0 });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('quarantines an ambiguous mock submission as delivery_unknown and never retries', async () => {
    const item = await fixture();
    const plan = await savePlan(item);
    const action = plan.actions[0]!;
    sendMessage.mockRejectedValueOnce(new Error('simulated timeout after submission claim'));

    await expect(dispatchDueAppointmentNotifications(item.tenantId)).resolves.toEqual({ scanned: 1 });
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: action.notificationEvent!.id } }))
      .resolves.toMatchObject({ status: 'delivery_unknown', failureReason: 'provider_acceptance_unknown' });
    await expect(db.appointmentCommunicationAction.findUniqueOrThrow({ where: { id: action.id } }))
      .resolves.toMatchObject({ status: 'DELIVERY_UNKNOWN' });
    await expect(dispatchDueAppointmentNotifications(item.tenantId)).resolves.toEqual({ scanned: 0 });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('rechecks the current phone immediately before provider intent', async () => {
    const item = await fixture();
    const plan = await savePlan(item);
    let changed = false;
    setConfirmationBoundaryTestHook(async stage => {
      if (stage !== 'before_suppression_fence' || changed) return;
      changed = true;
      await db.patient.update({ where: { id: item.patient.id }, data: { phone: '+12125550112' } });
    });

    await dispatchDueAppointmentNotifications(item.tenantId);
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: plan.actions[0]!.notificationEvent!.id } }))
      .resolves.toMatchObject({ status: 'dead_lettered', failureReason: 'destination_changed_or_unavailable' });
    await expect(db.appointmentCommunicationAction.findUniqueOrThrow({ where: { id: plan.actions[0]!.id } }))
      .resolves.toMatchObject({ status: 'BLOCKED_SETUP' });
    await expect(db.appointmentCommunicationPlan.findUniqueOrThrow({ where: { id: plan.id } }))
      .resolves.toMatchObject({ status: 'BLOCKED_SETUP' });
  });

  it('suppresses a newly waitlisted appointment at the final provider-intent gate', async () => {
    const item = await fixture();
    const plan = await savePlan(item);
    let waitlisted = false;
    setConfirmationBoundaryTestHook(async stage => {
      if (stage !== 'before_suppression_fence' || waitlisted) return;
      waitlisted = true;
      await db.appointment.update({ where: { id: item.appointment.id }, data: { status: 'WAITLIST' } });
    });

    await dispatchDueAppointmentNotifications(item.tenantId);
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: plan.actions[0]!.notificationEvent!.id } }))
      .resolves.toMatchObject({ status: 'suppressed', failureReason: 'appointment_reminder_stale' });
    await expect(db.appointmentCommunicationAction.findUniqueOrThrow({ where: { id: plan.actions[0]!.id } }))
      .resolves.toMatchObject({ status: 'CANCELLED' });
    expect(await db.notificationDeliveryAttempt.count({ where: {
      notificationEventId: plan.actions[0]!.notificationEvent!.id, phase: 'PROVIDER_INTENT',
    } })).toBe(0);
  });

  it('honors both pre-existing and concurrent DNC at the provider boundary', async () => {
    const prior = await fixture();
    const priorPlan = await savePlan(prior);
    await db.communicationConsent.create({ data: {
      tenantId: prior.tenantId, patientId: prior.patient.id,
      channel: 'sms', status: 'opted_out', source: 'patient',
    } });
    await dispatchDueAppointmentNotifications(prior.tenantId);
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.appointmentCommunicationAction.findUniqueOrThrow({ where: { id: priorPlan.actions[0]!.id } }))
      .resolves.toMatchObject({ status: 'SUPPRESSED' });

    const concurrent = await fixture();
    const concurrentPlan = await savePlan(concurrent);
    let inserted = false;
    setConfirmationBoundaryTestHook(async stage => {
      if (stage !== 'before_suppression_fence' || inserted) return;
      inserted = true;
      await db.receptionistOptOut.create({ data: {
        tenantId: concurrent.tenantId,
        contactPhone: concurrent.patient.phone,
        channel: 'SMS',
        reason: 'Concurrent synthetic opt out',
      } });
    });
    await dispatchDueAppointmentNotifications(concurrent.tenantId);
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.appointmentCommunicationAction.findUniqueOrThrow({ where: { id: concurrentPlan.actions[0]!.id } }))
      .resolves.toMatchObject({ status: 'SUPPRESSED' });
  });

  it('defers during clinic-local quiet hours without consuming an attempt', async () => {
    const item = await fixture();
    const plan = await savePlan(item);
    const now = new Date();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    const hhmm = (value: number) => {
      const normalized = (value + 1440) % 1440;
      return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
    };
    await db.schedulingPolicy.update({ where: { tenantId: item.tenantId }, data: {
      communicationQuietHoursStart: hhmm(minute - 1),
      communicationQuietHoursEnd: hhmm(minute + 2),
    } });

    await dispatchDueAppointmentNotifications(item.tenantId);
    expect(sendMessage).not.toHaveBeenCalled();
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { id: plan.actions[0]!.notificationEvent!.id } });
    expect(event).toMatchObject({ status: 'queued', attempts: 0 });
    expect(event.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(await db.notificationDeliveryAttempt.count({ where: { notificationEventId: event.id } })).toBe(0);
  });

  it.each(['reschedule', 'cancel'] as const)('linearizes a concurrent %s before provider intent', async operation => {
    const item = await fixture();
    const plan = await savePlan(item);
    const staleAction = plan.actions[0]!;
    let changed = false;
    setConfirmationBoundaryTestHook(async stage => {
      if (stage !== 'before_suppression_fence' || changed) return;
      changed = true;
      await runWithTenantContext(item.tenantId, async tx => {
        await lockAppointmentCommunication(tx, item.tenantId, item.appointment.id);
        if (operation === 'reschedule') {
          const startsAt = new Date(item.startsAt.getTime() + 24 * 60 * 60_000);
          const updated = await tx.appointment.update({ where: { id: item.appointment.id }, data: {
            startsAt,
            endsAt: new Date(startsAt.getTime() + 30 * 60_000),
            version: { increment: 1 },
            patientConfirmedAt: null,
            patientConfirmationSource: null,
            patientConfirmedCallLogId: null,
            patientConfirmedAppointmentVersion: null,
          } });
          await advanceCommunicationPlanAfterReschedule(tx, {
            tenantId: item.tenantId, appointmentId: item.appointment.id,
            appointmentVersion: updated.version, startsAt,
          });
        } else {
          const updated = await tx.appointment.update({ where: { id: item.appointment.id }, data: {
            status: 'CANCELED', version: { increment: 1 },
          } });
          await cancelAppointmentCommunicationPlan(tx, {
            tenantId: item.tenantId, appointmentId: item.appointment.id,
            appointmentVersion: updated.version,
          });
        }
      }, { id: item.owner.id, role: 'OWNER' });
    });

    await dispatchDueAppointmentNotifications(item.tenantId);
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: staleAction.notificationEvent!.id } }))
      .resolves.toMatchObject({ status: 'suppressed' });
    await expect(db.appointmentCommunicationAction.findUniqueOrThrow({ where: { id: staleAction.id } }))
      .resolves.toMatchObject({ status: 'CANCELLED' });
    expect(await db.notificationDeliveryAttempt.count({ where: {
      notificationEventId: staleAction.notificationEvent!.id, phase: 'PROVIDER_INTENT',
    } })).toBe(0);
    if (operation === 'reschedule') {
      expect(await db.notificationEvent.count({ where: {
        tenantId: item.tenantId, appointmentId: item.appointment.id,
        source: APPOINTMENT_REMINDER_OUTBOX_SOURCE,
      } })).toBe(2);
    }
  });

  it('rejects a cross-tenant reminder action link', async () => {
    const owner = await fixture();
    const foreign = await fixture();
    const plan = await savePlan(owner);
    const foreignEventId = randomUUID();
    await expect(db.$executeRaw`
      INSERT INTO "NotificationEvent" (
        id,"tenantId","appointmentId","appointmentCommunicationActionId","patientId",
        "recipientType",channel,status,attempts,"consentChecked","consentResult",source,"idempotencyKey"
      ) VALUES (
        ${foreignEventId}::uuid,${foreign.tenantId}::uuid,${foreign.appointment.id}::uuid,
        ${plan.actions[0]!.id}::uuid,${foreign.patient.id}::uuid,'patient','sms','queued',0,false,
        'not_recorded_transactional',${APPOINTMENT_REMINDER_OUTBOX_SOURCE},${`${foreignEventId}:cross-tenant`}
      )
    `).rejects.toThrow(/foreign key constraint/i);
  });
});
