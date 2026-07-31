import type { Prisma } from '../../generated/prisma/client';
import { sendMessage, type SendResult } from '../commsProvider';
import { isSuppressed } from '../campaigns';
import { getTenantContext, runWithJobTenantContext, runWithTenantContext } from '../tenantContext';

export const CONFIRMATION_OUTBOX_SOURCE = 'receptionist.appointment_confirmation';
const RETRYING_LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

type ConfirmationChannel = 'sms' | 'email';
export type ConfirmationDispatch = { sent: boolean; status: string; acceptedNow: boolean };

function providerCode(mode: SendResult['mode']): string {
  if (mode === 'mock_dev') return 'mock';
  if (mode === 'configured_pending_provider') return 'configured_pending';
  if (mode === 'setup_required') return 'unconfigured';
  if (mode === 'suppressed') return 'suppression_gate';
  return 'live_provider';
}

function retryAt(attemptNumber: number): Date {
  const delay = Math.min(MAX_BACKOFF_MS, 60_000 * (2 ** Math.max(0, attemptNumber - 1)));
  return new Date(Date.now() + delay);
}

function appointmentLabel(startsAt: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(startsAt);
}

async function appendAttempt(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; eventId: string; attemptNumber: number; status: string; provider?: string | null; providerMessageId?: string | null; failureCode?: string | null; completed?: boolean },
) {
  await tx.notificationDeliveryAttempt.create({ data: {
    tenantId: input.tenantId,
    notificationEventId: input.eventId,
    attemptNumber: input.attemptNumber,
    phase: input.status === 'started' ? 'INTENT' : 'RESULT',
    status: input.status,
    provider: input.provider ?? undefined,
    providerMessageId: input.providerMessageId ?? undefined,
    failureCode: input.failureCode ?? undefined,
    completedAt: input.completed ? new Date() : undefined,
  } });
}

type ClaimedConfirmation = {
  eventId: string;
  tenantId: string;
  appointmentId: string;
  patientId: string;
  channel: ConfirmationChannel;
  idempotencyKey: string;
  attemptNumber: number;
  maxAttempts: number;
  consentEvidence: string;
  destination: string;
  firstName: string;
  service: string;
  startsAt: Date;
  timezone: string;
};

async function claimConfirmation(tenantId: string, eventId: string): Promise<ClaimedConfirmation | ConfirmationDispatch> {
  return runWithTenantContext(tenantId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-confirmation:${tenantId}:${eventId}`})::bigint)`;
    const event = await tx.notificationEvent.findFirst({
      where: { id: eventId, tenantId, source: CONFIRMATION_OUTBOX_SOURCE },
      include: {
        appointment: { select: {
          id: true, status: true, deletedAt: true, service: true, startsAt: true,
          branch: { select: { timezone: true } },
          patient: { select: { id: true, firstName: true, phone: true, email: true, deletedAt: true } },
        } },
      },
    });
    if (!event || (event.channel !== 'sms' && event.channel !== 'email')) return { sent: false, status: 'outbox_unavailable', acceptedNow: false };
    if (event.status === 'accepted' || event.status === 'delivered') return { sent: false, status: 'already_accepted', acceptedNow: false };
    if (['suppressed', 'dead_lettered', 'delivery_unknown'].includes(event.status)) return { sent: false, status: event.status, acceptedNow: false };

    // A worker that finds an expired in-flight claim cannot know whether the
    // provider accepted it before the process stopped. Preserve the ambiguity
    // for manual/provider reconciliation; never auto-resend it.
    if (event.status === 'retrying') {
      if (event.updatedAt.getTime() > Date.now() - RETRYING_LEASE_MS) return { sent: false, status: 'retry_in_progress', acceptedNow: false };
      await appendAttempt(tx, {
        tenantId, eventId, attemptNumber: event.attempts, status: 'delivery_unknown',
        failureCode: 'dispatch_lease_expired', completed: true,
      });
      await tx.notificationEvent.updateMany({
        where: { id: eventId, tenantId },
        data: { status: 'delivery_unknown', failureReason: 'dispatch_lease_expired', nextAttemptAt: null, deadLetteredAt: new Date() },
      });
      return { sent: false, status: 'delivery_unknown', acceptedNow: false };
    }
    if (!['queued', 'failed'].includes(event.status) || (event.nextAttemptAt && event.nextAttemptAt > new Date())) {
      return { sent: false, status: event.status, acceptedNow: false };
    }
    if (event.attempts >= event.maxAttempts) {
      await tx.notificationEvent.updateMany({
        where: { id: eventId, tenantId },
        data: { status: 'dead_lettered', failureReason: 'attempt_limit_reached', nextAttemptAt: null, deadLetteredAt: new Date() },
      });
      return { sent: false, status: 'dead_lettered', acceptedNow: false };
    }
    const appointment = event.appointment;
    if (!appointment || appointment.deletedAt || appointment.status !== 'CONFIRMED' || appointment.patient.deletedAt) {
      const attemptNumber = event.attempts + 1;
      await appendAttempt(tx, {
        tenantId, eventId, attemptNumber, status: 'suppressed', failureCode: 'appointment_not_confirmed', completed: true,
      });
      await tx.notificationEvent.updateMany({
        where: { id: eventId, tenantId },
        data: { status: 'suppressed', attempts: attemptNumber, failureReason: 'appointment_not_confirmed', nextAttemptAt: null },
      });
      return { sent: false, status: 'suppressed', acceptedNow: false };
    }
    const destination = event.channel === 'sms' ? appointment.patient.phone : appointment.patient.email;
    if (!destination) {
      const attemptNumber = event.attempts + 1;
      await appendAttempt(tx, {
        tenantId, eventId, attemptNumber, status: 'dead_lettered', failureCode: 'destination_unavailable', completed: true,
      });
      await tx.notificationEvent.updateMany({
        where: { id: eventId, tenantId },
        data: { status: 'dead_lettered', attempts: attemptNumber, failureReason: 'destination_unavailable', nextAttemptAt: null, deadLetteredAt: new Date() },
      });
      return { sent: false, status: 'destination_unavailable', acceptedNow: false };
    }
    const attemptNumber = event.attempts + 1;
    await appendAttempt(tx, { tenantId, eventId, attemptNumber, status: 'started' });
    const claimed = await tx.notificationEvent.updateMany({
      where: { id: eventId, tenantId, status: { in: ['queued', 'failed'] }, attempts: event.attempts },
      data: { status: 'retrying', attempts: attemptNumber, failureReason: null, nextAttemptAt: null },
    });
    if (claimed.count !== 1) throw new Error('confirmation_claim_lost');
    return {
      eventId, tenantId, appointmentId: appointment.id, patientId: appointment.patient.id,
      channel: event.channel, idempotencyKey: event.idempotencyKey!, attemptNumber,
      maxAttempts: event.maxAttempts, destination, firstName: appointment.patient.firstName,
      consentEvidence: event.consentResult === 'granted_unchecked' ? 'granted' : 'not_suppressed_transactional',
      service: appointment.service, startsAt: appointment.startsAt, timezone: appointment.branch.timezone,
    };
  });
}

function isClaim(value: ClaimedConfirmation | ConfirmationDispatch): value is ClaimedConfirmation {
  return 'eventId' in value;
}

async function finalizeClaim(
  claim: ClaimedConfirmation,
  result: SendResult | null,
  preProviderFailureCode?: 'suppression_gate_unavailable',
): Promise<ConfirmationDispatch> {
  return runWithTenantContext(claim.tenantId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-confirmation:${claim.tenantId}:${claim.eventId}`})::bigint)`;
    const current = await tx.notificationEvent.findFirst({ where: { id: claim.eventId, tenantId: claim.tenantId }, select: { status: true, attempts: true } });
    if (!current || current.status !== 'retrying' || current.attempts !== claim.attemptNumber) {
      return { sent: false, status: current?.status ?? 'outbox_unavailable', acceptedNow: false };
    }
    const provider = result ? providerCode(result.mode) : 'live_provider';
    if (preProviderFailureCode) {
      const exhausted = claim.attemptNumber >= claim.maxAttempts;
      await appendAttempt(tx, {
        tenantId: claim.tenantId, eventId: claim.eventId, attemptNumber: claim.attemptNumber,
        status: exhausted ? 'dead_lettered' : 'failed', provider: 'suppression_gate',
        failureCode: preProviderFailureCode, completed: true,
      });
      await tx.notificationEvent.updateMany({ where: { id: claim.eventId, tenantId: claim.tenantId }, data: {
        status: exhausted ? 'dead_lettered' : 'failed', provider: 'suppression_gate',
        failureReason: preProviderFailureCode,
        nextAttemptAt: exhausted ? null : retryAt(claim.attemptNumber),
        deadLetteredAt: exhausted ? new Date() : null,
      } });
      return { sent: false, status: exhausted ? 'dead_lettered' : preProviderFailureCode, acceptedNow: false };
    }
    if (result?.status === 'sent') {
      await appendAttempt(tx, {
        tenantId: claim.tenantId, eventId: claim.eventId, attemptNumber: claim.attemptNumber,
        status: 'accepted', provider, providerMessageId: result.providerMessageId, completed: true,
      });
      await tx.notificationEvent.updateMany({ where: { id: claim.eventId, tenantId: claim.tenantId }, data: {
        status: 'accepted', provider, providerMessageId: result.providerMessageId ?? null,
        acceptedAt: new Date(), failureReason: null, nextAttemptAt: null,
        consentChecked: true, consentResult: claim.consentEvidence,
      } });
      return { sent: false, status: 'accepted', acceptedNow: true };
    }
    if (result?.status === 'suppressed') {
      await appendAttempt(tx, {
        tenantId: claim.tenantId, eventId: claim.eventId, attemptNumber: claim.attemptNumber,
        status: 'suppressed', provider, failureCode: 'suppressed_by_shared_gate', completed: true,
      });
      await tx.notificationEvent.updateMany({ where: { id: claim.eventId, tenantId: claim.tenantId }, data: {
        status: 'suppressed', provider, failureReason: 'suppressed_by_shared_gate', consentResult: 'denied', nextAttemptAt: null,
        consentChecked: true,
      } });
      return { sent: false, status: 'suppressed', acceptedNow: false };
    }
    // A thrown call or a live-provider failure can be acceptance-ambiguous.
    // Quarantine it rather than risking a duplicate message.
    if (!result || result.mode === 'live') {
      await appendAttempt(tx, {
        tenantId: claim.tenantId, eventId: claim.eventId, attemptNumber: claim.attemptNumber,
        status: 'delivery_unknown', provider, failureCode: 'provider_acceptance_unknown', completed: true,
      });
      await tx.notificationEvent.updateMany({ where: { id: claim.eventId, tenantId: claim.tenantId }, data: {
        status: 'delivery_unknown', provider, failureReason: 'provider_acceptance_unknown', nextAttemptAt: null, deadLetteredAt: new Date(),
        consentChecked: true, consentResult: claim.consentEvidence,
      } });
      return { sent: false, status: 'delivery_unknown', acceptedNow: false };
    }
    const exhausted = claim.attemptNumber >= claim.maxAttempts;
    const failureCode = result.status === 'setup_required' ? 'provider_setup_required' : 'provider_not_submitted';
    await appendAttempt(tx, {
      tenantId: claim.tenantId, eventId: claim.eventId, attemptNumber: claim.attemptNumber,
      status: exhausted ? 'dead_lettered' : 'failed', provider, failureCode, completed: true,
    });
    await tx.notificationEvent.updateMany({ where: { id: claim.eventId, tenantId: claim.tenantId }, data: {
      status: exhausted ? 'dead_lettered' : 'failed', provider, failureReason: failureCode,
      nextAttemptAt: exhausted ? null : retryAt(claim.attemptNumber), deadLetteredAt: exhausted ? new Date() : null,
      consentChecked: true, consentResult: claim.consentEvidence,
    } });
    return { sent: false, status: exhausted ? 'dead_lettered' : result.status, acceptedNow: false };
  });
}

async function dispatchEvent(tenantId: string, eventId: string): Promise<ConfirmationDispatch> {
  const claim = await claimConfirmation(tenantId, eventId);
  if (!isClaim(claim)) return claim;
  const label = appointmentLabel(claim.startsAt, claim.timezone);
  const body = `Hi ${claim.firstName}, your ${claim.service} is confirmed for ${label}.`;
  let suppressed: boolean;
  try {
    suppressed = await isSuppressed(tenantId, { patientId: claim.patientId, destination: claim.destination }, claim.channel);
  } catch {
    // Consent/suppression could not be evaluated, so no provider submission was
    // attempted. This is retryable known non-submission, never acceptance
    // ambiguity. Raw database/provider text is intentionally not persisted.
    return finalizeClaim(claim, null, 'suppression_gate_unavailable');
  }
  let result: SendResult | null = null;
  try {
    result = suppressed
      ? { ok: false, status: 'suppressed', mode: 'suppressed', failureReason: 'suppressed_or_opted_out' }
      : await sendMessage(
        claim.channel,
        claim.destination,
        'Appointment confirmed',
        claim.channel === 'sms' ? `${body} Reply STOP to opt out.` : body,
        claim.idempotencyKey,
        { tenantId, patientId: claim.patientId },
      );
  } catch {
    // Normalized as provider_acceptance_unknown by finalizeClaim. Raw provider
    // text/destinations are intentionally excluded from durable evidence.
  }
  return finalizeClaim(claim, result);
}

export async function processAppointmentConfirmations(
  input: { tenantId: string; appointmentId: string; messagingConsent: boolean | null; smsEnabled: boolean; emailEnabled: boolean; phone: string | null; email: string | null },
): Promise<Record<ConfirmationChannel, ConfirmationDispatch>> {
  const fallback = (channel: ConfirmationChannel): ConfirmationDispatch => {
    if (input.messagingConsent === false) return { sent: false, status: 'suppressed_by_call_consent', acceptedNow: false };
    if (!(channel === 'sms' ? input.smsEnabled : input.emailEnabled)) return { sent: false, status: 'disabled', acceptedNow: false };
    if (!(channel === 'sms' ? input.phone : input.email)) return { sent: false, status: 'destination_unavailable', acceptedNow: false };
    return { sent: false, status: 'outbox_unavailable', acceptedNow: false };
  };
  const outcomes = { sms: fallback('sms'), email: fallback('email') };
  if (input.messagingConsent === false) {
    // Fail closed even if a stale/legacy event exists. Booking normally creates
    // no event after explicit refusal, but this atomic transition prevents a
    // queued or failed row from crossing the provider boundary.
    await runWithTenantContext(input.tenantId, tx => tx.notificationEvent.updateMany({
      where: {
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        source: CONFIRMATION_OUTBOX_SOURCE,
        status: { in: ['queued', 'failed'] },
      },
      data: {
        status: 'suppressed', failureReason: 'suppressed_by_call_consent',
        consentChecked: true, consentResult: 'denied', nextAttemptAt: null,
      },
    }));
    return outcomes;
  }
  const events = await runWithTenantContext(input.tenantId, tx => tx.notificationEvent.findMany({
    where: { tenantId: input.tenantId, appointmentId: input.appointmentId, source: CONFIRMATION_OUTBOX_SOURCE },
    select: { id: true, channel: true },
  }));
  for (const event of events) {
    if (event.channel === 'sms' || event.channel === 'email') outcomes[event.channel] = await dispatchEvent(input.tenantId, event.id);
  }
  return outcomes;
}

export async function dispatchDueAppointmentConfirmations(tenantId: string, limit = 100): Promise<{ scanned: number }> {
  const work = async () => {
    const due = await runWithTenantContext(tenantId, tx => tx.notificationEvent.findMany({
      where: {
        tenantId,
        source: CONFIRMATION_OUTBOX_SOURCE,
        OR: [
          { status: { in: ['queued', 'failed'] }, nextAttemptAt: { lte: new Date() } },
          { status: 'retrying', updatedAt: { lte: new Date(Date.now() - RETRYING_LEASE_MS) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(limit, 500)),
      select: { id: true },
    }));
    for (const event of due) await dispatchEvent(tenantId, event.id);
    return { scanned: due.length };
  };
  if (getTenantContext()) return work();
  return runWithJobTenantContext(tenantId, async () => work(), 'worker:receptionist-confirmation');
}
