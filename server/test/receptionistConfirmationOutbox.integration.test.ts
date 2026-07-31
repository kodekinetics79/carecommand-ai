import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.hoisted(() => vi.fn());
const suppressionGate = vi.hoisted(() => vi.fn());
vi.mock('../lib/commsProvider', () => ({ sendAuthorizedAppointmentConfirmation: sendMessage }));
vi.mock('../lib/receptionist/dncFence', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/receptionist/dncFence')>();
  suppressionGate.mockImplementation(actual.isChannelSuppressedTx);
  return { ...actual, isChannelSuppressedTx: suppressionGate };
});

const { fixtureDb: db } = await import('./helpers/fixtureDb');
const {
  CONFIRMATION_OUTBOX_SOURCE,
  dispatchDueAppointmentConfirmations,
  processAppointmentConfirmations,
  setConfirmationBoundaryTestHook,
} = await import('../lib/receptionist/confirmationOutbox');
const { runWithJobTenantContext } = await import('../lib/tenantContext');

type EventStatus = 'queued' | 'failed' | 'retrying';
type FixtureOptions = {
  appointmentStatus?: 'CONFIRMED' | 'CANCELED';
  consentResult?: 'granted_unchecked' | 'not_recorded_transactional';
  createEvent?: boolean;
  eventStatus?: EventStatus;
  attempts?: number;
  maxAttempts?: number;
  nextAttemptAt?: Date | null;
  updatedAt?: Date;
};

async function fixture(options: FixtureOptions = {}) {
  const tenantId = randomUUID();
  await db.tenant.create({
    data: { id: tenantId, name: `confirmation-${tenantId.slice(0, 8)}`, slug: `confirmation-${tenantId.slice(0, 8)}` },
  });
  const branch = await db.branch.create({
    data: { tenantId, name: 'Confirmation branch', location: 'Test', timezone: 'UTC', active: true },
  });
  const patient = await db.patient.create({
    data: {
      tenantId, branchId: branch.id, firstName: 'Casey', lastName: 'Patient',
      phone: '+15551234567', email: `casey-${tenantId.slice(0, 8)}@example.test`, lifecycleStage: 'ACTIVE',
    },
  });
  const startsAt = new Date(Date.now() + 86_400_000);
  const appointment = await db.appointment.create({
    data: {
      tenantId, branchId: branch.id, patientId: patient.id, service: 'Consultation',
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: options.appointmentStatus ?? 'CONFIRMED', channel: 'CALL',
    },
  });
  let event = options.createEvent === false ? null : await db.notificationEvent.create({
    data: {
      tenantId, appointmentId: appointment.id, patientId: patient.id,
      recipientType: 'patient', channel: 'sms', source: CONFIRMATION_OUTBOX_SOURCE,
      idempotencyKey: `${appointment.id}:sms`, status: 'queued',
      attempts: 0, maxAttempts: options.maxAttempts ?? 5,
      nextAttemptAt: options.nextAttemptAt === undefined ? new Date() : options.nextAttemptAt,
      consentChecked: false, consentResult: options.consentResult ?? 'granted_unchecked',
    },
  });
  if (event && options.eventStatus && options.eventStatus !== 'queued') {
    const attemptNumber = options.attempts ?? 1;
    if (attemptNumber !== 1) throw new Error('fixture only supports constructing the first active/failed attempt');
    await db.notificationDeliveryAttempt.create({ data: {
      tenantId, notificationEventId: event.id, attemptNumber, phase: 'INTENT', status: 'started',
      startedAt: options.updatedAt,
    } });
    event = await db.notificationEvent.update({ where: { id: event.id }, data: {
      status: 'retrying', attempts: attemptNumber, nextAttemptAt: null,
    } });
    if (options.eventStatus === 'failed') {
      await db.notificationDeliveryAttempt.create({ data: {
        tenantId, notificationEventId: event.id, attemptNumber, phase: 'RESULT', status: 'failed',
        provider: 'configured_pending', failureCode: 'provider_not_submitted', completedAt: new Date(),
      } });
      event = await db.notificationEvent.update({ where: { id: event.id }, data: {
        status: 'failed', provider: 'configured_pending', failureReason: 'provider_not_submitted',
        nextAttemptAt: options.nextAttemptAt === undefined ? new Date() : options.nextAttemptAt,
      } });
    }
  }
  return { tenantId, patient, appointment, event };
}

function dispatch(tenantId: string) {
  // The worker-facing service establishes its own explicit trusted actor when
  // invoked outside an existing tenant context.
  return dispatchDueAppointmentConfirmations(tenantId);
}

function processConfirmations(
  item: Awaited<ReturnType<typeof fixture>>,
  messagingConsent: boolean | null,
) {
  return runWithJobTenantContext(
    item.tenantId,
    async () => processAppointmentConfirmations({
      tenantId: item.tenantId,
      appointmentId: item.appointment.id,
      messagingConsent,
      smsEnabled: true,
      emailEnabled: false,
      phone: item.patient.phone,
      email: item.patient.email,
    }),
    'worker:test-confirmation-outbox',
  );
}

const describeDisposable = process.env.RLS_DISPOSABLE_DB ? describe : describe.skip;

describeDisposable('receptionist confirmation outbox — durable provider boundary', () => {
  beforeEach(() => {
    sendMessage.mockReset();
    suppressionGate.mockClear();
    setConfirmationBoundaryTestHook(null);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('worker drains a queued event without tool replay, records INTENT + RESULT, and never resends accepted work', async () => {
    const item = await fixture();
    sendMessage.mockResolvedValue({ ok: true, status: 'sent', mode: 'mock_dev', providerMessageId: 'provider-accepted-1' });

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });

    const event = await db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } });
    expect(event).toMatchObject({
      status: 'accepted', attempts: 1, provider: 'mock', providerMessageId: 'provider-accepted-1',
      consentChecked: true, consentResult: 'granted', failureReason: null,
    });
    expect(event.acceptedAt).not.toBeNull();
    expect(event.sentAt).toBeNull();
    await expect(db.$executeRaw`
      UPDATE "NotificationEvent" SET "providerMessageId" = 'tampered' WHERE id = ${event.id}::uuid
    `).rejects.toThrow(/terminal evidence is immutable/i);
    await expect(db.$executeRaw`
      UPDATE "NotificationEvent" SET "acceptedAt" = CURRENT_TIMESTAMP + interval '1 hour' WHERE id = ${event.id}::uuid
    `).rejects.toThrow(/terminal evidence is immutable/i);
    await expect(db.$executeRaw`
      UPDATE "NotificationEvent" SET "consentResult" = 'denied' WHERE id = ${event.id}::uuid
    `).rejects.toThrow(/terminal evidence is immutable/i);
    await expect(db.$executeRaw`
      UPDATE "NotificationEvent" SET "failureReason" = 'provider_not_submitted' WHERE id = ${event.id}::uuid
    `).rejects.toThrow(/terminal evidence is immutable/i);
    const attempts = await db.notificationDeliveryAttempt.findMany({
      where: { tenantId: item.tenantId, notificationEventId: item.event!.id },
      orderBy: { phase: 'asc' },
    });
    expect(attempts.map(attempt => ({ phase: attempt.phase, status: attempt.status }))).toEqual([
      { phase: 'INTENT', status: 'started' },
      { phase: 'PROVIDER_INTENT', status: 'provider_intent_committed' },
      { phase: 'RESULT', status: 'accepted' },
    ]);
    expect(attempts[0]!.completedAt).toBeNull();
    expect(attempts[1]!.completedAt).not.toBeNull();
    expect(attempts[2]!.completedAt).not.toBeNull();

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 0 });
    await expect(processConfirmations(item, true)).resolves.toMatchObject({ sms: { status: 'already_accepted', acceptedNow: false } });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('honors an opt-out recorded after commit and suppresses before the provider boundary', async () => {
    const item = await fixture();
    await db.communicationConsent.create({
      data: { tenantId: item.tenantId, patientId: item.patient.id, channel: 'sms', status: 'opted_out', source: 'patient' },
    });

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });

    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({
      status: 'suppressed', attempts: 1, failureReason: 'suppressed_by_shared_gate',
      consentChecked: true, consentResult: 'denied',
    });
  });

  it('quarantines a thrown or timeout-like provider result as delivery_unknown and never retries it', async () => {
    const item = await fixture();
    sendMessage.mockRejectedValue(new Error('provider timeout after request write'));

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({
      status: 'delivery_unknown', attempts: 1, failureReason: 'provider_acceptance_unknown',
    });
    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 0 });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('treats a suppression precheck failure as known retryable non-submission with zero provider calls', async () => {
    const item = await fixture({ maxAttempts: 2 });
    suppressionGate.mockRejectedValueOnce(new Error('suppression database unavailable'));

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });

    expect(sendMessage).not.toHaveBeenCalled();
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } });
    expect(event).toMatchObject({
      status: 'failed', attempts: 1, failureReason: 'suppression_gate_unavailable',
      provider: 'suppression_gate', consentChecked: false,
    });
    expect(event.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    const result = await db.notificationDeliveryAttempt.findUniqueOrThrow({
      where: { tenantId_notificationEventId_attemptNumber_phase: {
        tenantId: item.tenantId, notificationEventId: item.event!.id, attemptNumber: 1, phase: 'RESULT',
      } },
    });
    expect(result).toMatchObject({ status: 'failed', failureCode: 'suppression_gate_unavailable' });
  });

  it('quarantines an expired retrying lease without another provider call', async () => {
    const item = await fixture({
      eventStatus: 'retrying', attempts: 1, nextAttemptAt: null,
      updatedAt: new Date(Date.now() - 6 * 60_000),
    });
    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });

    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({
      status: 'failed', attempts: 1, failureReason: 'dispatch_lease_expired',
    });
    const result = await db.notificationDeliveryAttempt.findUniqueOrThrow({
      where: { tenantId_notificationEventId_attemptNumber_phase: {
        tenantId: item.tenantId, notificationEventId: item.event!.id, attemptNumber: 1, phase: 'RESULT',
      } },
    });
    expect(result.status).toBe('failed');
  });

  it('quarantines an expired lease after committed provider intent because acceptance is unknowable', async () => {
    const item = await fixture({
      eventStatus: 'retrying', attempts: 1, nextAttemptAt: null,
      updatedAt: new Date(Date.now() - 6 * 60_000),
    });
    await db.notificationDeliveryAttempt.create({ data: {
      tenantId: item.tenantId, notificationEventId: item.event!.id,
      attemptNumber: 1, phase: 'PROVIDER_INTENT', status: 'provider_intent_committed', completedAt: new Date(),
    } });

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({
      status: 'delivery_unknown', attempts: 1, failureReason: 'dispatch_lease_expired',
    });
  });

  it('linearizes confirmation DNC: suppression winning the fence yields zero provider submissions', async () => {
    const item = await fixture();
    let inserted = false;
    setConfirmationBoundaryTestHook(async stage => {
      if (stage !== 'before_suppression_fence' || inserted) return;
      inserted = true;
      await db.receptionistOptOut.create({ data: {
        tenantId: item.tenantId, contactPhone: item.patient.phone, channel: 'VOICE', reason: 'Concurrent patient opt out',
      } });
      // The confirmation is SMS, so add the exact suppressing channel as a
      // second durable row before the provider-intent transaction begins.
      await db.receptionistOptOut.create({ data: {
        tenantId: item.tenantId, contactPhone: item.patient.phone, channel: 'SMS', reason: 'Concurrent patient opt out',
      } });
    });

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({ status: 'suppressed' });
  });

  it('linearizes confirmation DNC: committed intent wins once and no DB transaction spans the provider call', async () => {
    const item = await fixture();
    let inserted = false;
    setConfirmationBoundaryTestHook(async stage => {
      if (stage !== 'provider_intent_committed' || inserted) return;
      inserted = true;
      // This insert takes the same destination fence. Completing here proves
      // the provider-intent transaction released it before the provider call.
      await db.receptionistOptOut.create({ data: {
        tenantId: item.tenantId, contactPhone: item.patient.phone, channel: 'SMS', reason: 'Opt out ordered after intent',
      } });
    });
    sendMessage.mockResolvedValue({ ok: true, status: 'sent', mode: 'mock_dev', providerMessageId: 'intent-won-once' });

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });
    expect(sendMessage).toHaveBeenCalledOnce();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({
      status: 'accepted', providerMessageId: 'intent-won-once',
    });
    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 0 });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('backs off a known non-submission and dead-letters at the bounded attempt limit', async () => {
    const item = await fixture({ maxAttempts: 2 });
    sendMessage.mockResolvedValue({ ok: false, status: 'pending', mode: 'configured_pending_provider' });
    const before = Date.now();

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });
    const failed = await db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } });
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, failureReason: 'provider_not_submitted' });
    expect(failed.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 55_000);
    expect(failed.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 70_000);

    await db.notificationEvent.update({ where: { id: item.event!.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({
      status: 'dead_lettered', attempts: 2, failureReason: 'provider_not_submitted', nextAttemptAt: null,
    });
    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 0 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('suppresses a no-longer-confirmed appointment without crossing the provider boundary', async () => {
    const item = await fixture({ appointmentStatus: 'CANCELED' });

    await expect(dispatch(item.tenantId)).resolves.toEqual({ scanned: 1 });

    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({
      status: 'suppressed', attempts: 1, failureReason: 'appointment_not_confirmed',
    });
  });

  it('enforces append-only delivery evidence against direct UPDATE and DELETE', async () => {
    const item = await fixture();
    const attempt = await db.notificationDeliveryAttempt.create({
      data: {
        tenantId: item.tenantId, notificationEventId: item.event!.id,
        attemptNumber: 1, phase: 'INTENT', status: 'started',
      },
    });

    await expect(db.notificationDeliveryAttempt.update({
      where: { id: attempt.id }, data: { provider: 'tampered' },
    })).rejects.toThrow(/append-only/i);
    await expect(db.notificationDeliveryAttempt.delete({ where: { id: attempt.id } })).rejects.toThrow(/append-only/i);
  });

  it('rejects cross-patient appointment events and freezes confirmation identity, status, and deletion in raw SQL', async () => {
    const item = await fixture({ createEvent: false });
    const otherPatient = await db.patient.create({
      data: {
        tenantId: item.tenantId, branchId: item.patient.branchId,
        firstName: 'Other', lastName: 'Patient', phone: '+15557654321', lifecycleStage: 'ACTIVE',
      },
    });
    const mismatchedId = randomUUID();
    await expect(db.$executeRaw`
      INSERT INTO "NotificationEvent" (
        id, "tenantId", "appointmentId", "patientId", "recipientType", channel,
        status, attempts, "consentChecked", "consentResult", source, "idempotencyKey"
      ) VALUES (
        ${mismatchedId}::uuid, ${item.tenantId}::uuid, ${item.appointment.id}::uuid,
        ${otherPatient.id}::uuid, 'patient', 'sms', 'queued', 0, false,
        'granted_unchecked', ${CONFIRMATION_OUTBOX_SOURCE}, ${`${mismatchedId}:sms`}
      )
    `).rejects.toThrow(/foreign key constraint/i);

    const event = await db.notificationEvent.create({
      data: {
        tenantId: item.tenantId, appointmentId: item.appointment.id, patientId: item.patient.id,
        recipientType: 'patient', channel: 'sms', status: 'queued', attempts: 0,
        consentChecked: false, consentResult: 'granted_unchecked',
        source: CONFIRMATION_OUTBOX_SOURCE, idempotencyKey: `${item.appointment.id}:sms`,
      },
    });
    await expect(db.$executeRaw`
      UPDATE "NotificationEvent" SET channel = 'email' WHERE id = ${event.id}::uuid
    `).rejects.toThrow(/identity is immutable/i);
    await expect(db.$executeRaw`
      UPDATE "NotificationEvent" SET status = 'accepted', "acceptedAt" = CURRENT_TIMESTAMP WHERE id = ${event.id}::uuid
    `).rejects.toThrow(/Illegal receptionist confirmation/i);
    await expect(db.$executeRaw`
      DELETE FROM "NotificationEvent" WHERE id = ${event.id}::uuid
    `).rejects.toThrow(/cannot be deleted/i);

    // The conditional trigger must not alter the legacy generic notification
    // lifecycle used by connected-care monitoring.
    const generic = await db.notificationEvent.create({
      data: { tenantId: item.tenantId, patientId: item.patient.id, recipientType: 'nurse', channel: 'in_app' },
    });
    await expect(db.notificationEvent.update({ where: { id: generic.id }, data: { status: 'sent' } })).resolves.toMatchObject({ status: 'sent' });
    await expect(db.notificationEvent.delete({ where: { id: generic.id } })).resolves.toMatchObject({ id: generic.id });
  });

  it('rejects fabricated initial terminal states and unordered provider/result evidence in raw SQL', async () => {
    const item = await fixture({ createEvent: false });
    const forgedId = randomUUID();
    await expect(db.$executeRaw`
      INSERT INTO "NotificationEvent" (
        id,"tenantId","appointmentId","patientId","recipientType",channel,status,attempts,
        "consentChecked","consentResult",source,"idempotencyKey",provider,"providerMessageId","acceptedAt","nextAttemptAt"
      ) VALUES (
        ${forgedId}::uuid,${item.tenantId}::uuid,${item.appointment.id}::uuid,${item.patient.id}::uuid,
        'patient','sms','accepted',1,true,'granted',${CONFIRMATION_OUTBOX_SOURCE},${`${forgedId}:sms`},
        'forged','forged-id',CURRENT_TIMESTAMP,NULL
      )
    `).rejects.toThrow(/must begin as an unsubmitted queued event/i);

    const queued = await fixture();
    await expect(db.notificationDeliveryAttempt.create({ data: {
      tenantId: queued.tenantId, notificationEventId: queued.event!.id, attemptNumber: 1,
      phase: 'RESULT', status: 'failed', failureCode: 'provider_not_submitted', completedAt: new Date(),
    } })).rejects.toThrow(/ordered INTENT/i);
    await expect(db.notificationDeliveryAttempt.create({ data: {
      tenantId: queued.tenantId, notificationEventId: queued.event!.id, attemptNumber: 1,
      phase: 'PROVIDER_INTENT', status: 'provider_intent_committed', completedAt: new Date(),
    } })).rejects.toThrow(/active ordered lease/i);
  });

  it('requires a matching delivery receipt and preserves accepted evidence during accepted-to-delivered', async () => {
    const item = await fixture();
    sendMessage.mockResolvedValue({ ok: true, status: 'sent', mode: 'mock_dev', providerMessageId: 'delivery-receipt-1' });
    await dispatch(item.tenantId);
    const accepted = await db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } });
    await expect(db.notificationEvent.update({ where: { id: accepted.id }, data: {
      status: 'delivered', deliveredAt: new Date(),
    } })).rejects.toThrow(/matching immutable provider receipt/i);
    await db.notificationDeliveryAttempt.create({ data: {
      tenantId: item.tenantId, notificationEventId: accepted.id, attemptNumber: 1,
      phase: 'RECEIPT', status: 'delivered', provider: accepted.provider,
      providerMessageId: accepted.providerMessageId, completedAt: new Date(),
    } });
    const deliveredAt = new Date();
    await expect(db.notificationEvent.update({ where: { id: accepted.id }, data: {
      status: 'delivered', deliveredAt,
    } })).resolves.toMatchObject({ status: 'delivered', providerMessageId: 'delivery-receipt-1' });
    await expect(db.notificationEvent.update({ where: { id: accepted.id }, data: {
      providerMessageId: 'rewritten',
    } })).rejects.toThrow(/terminal evidence is immutable/i);
  });

  it.each([
    { label: 'explicit true', consent: true, persisted: 'granted_unchecked', final: 'granted' },
    { label: 'absent', consent: null, persisted: 'not_recorded_transactional', final: 'not_suppressed_transactional' },
  ] as const)('allows $label transactional confirmation while preserving consent evidence', async ({ consent, persisted, final }) => {
    const item = await fixture({ consentResult: persisted });
    sendMessage.mockResolvedValue({ ok: true, status: 'sent', mode: 'mock_dev', providerMessageId: `provider-${final}` });

    await expect(processConfirmations(item, consent)).resolves.toMatchObject({ sms: { status: 'accepted', acceptedNow: true } });

    expect(sendMessage).toHaveBeenCalledOnce();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({
      status: 'accepted', consentChecked: true, consentResult: final,
    });
  });

  it('treats explicit false consent as suppressed and has no durable send event or provider call', async () => {
    const item = await fixture({ createEvent: false });

    await expect(processConfirmations(item, false)).resolves.toEqual({
      sms: { sent: false, status: 'suppressed_by_call_consent', acceptedNow: false },
      email: { sent: false, status: 'suppressed_by_call_consent', acceptedNow: false },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.count({
      where: { tenantId: item.tenantId, appointmentId: item.appointment.id, source: CONFIRMATION_OUTBOX_SOURCE },
    })).resolves.toBe(0);
  });

  it.each(['queued', 'failed'] as const)('atomically suppresses a pre-existing %s event on explicit false consent', async eventStatus => {
    const item = await fixture({ eventStatus });

    await expect(processConfirmations(item, false)).resolves.toMatchObject({
      sms: { status: 'suppressed_by_call_consent', acceptedNow: false },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    await expect(db.notificationEvent.findUniqueOrThrow({ where: { id: item.event!.id } })).resolves.toMatchObject({
      status: 'suppressed', attempts: eventStatus === 'failed' ? 1 : 0, failureReason: 'suppressed_by_call_consent',
      consentChecked: true, consentResult: 'denied', nextAttemptAt: null,
    });
  });
});
