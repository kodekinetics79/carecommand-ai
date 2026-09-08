import type {
  AppointmentCommunicationMode,
  AppointmentCommunicationPlanStatus,
  Prisma,
} from '../generated/prisma/client';
import { env } from '../config/env';
import { channelStatus, isValidE164, toE164 } from './campaigns';

export const APPOINTMENT_REMINDER_OUTBOX_SOURCE = 'appointment.reminder';
export const APPOINTMENT_SMS_PROVIDER_ALLOWLIST = ['twilio'] as const;

export const DEFAULT_REMINDER_LEAD_MINUTES = 24 * 60;
export const MIN_REMINDER_LEAD_MINUTES = 15;
export const MAX_REMINDER_LEAD_MINUTES = 7 * 24 * 60;

type Tx = Prisma.TransactionClient;

export function appointmentSmsAutomationReadiness(): { ready: boolean; reason: string | null } {
  // This tranche proves the durable workflow without enabling sensitive real
  // patient egress. Production and every real provider remain fail-closed.
  if (env.NODE_ENV === 'production') return { ready: false, reason: 'production_activation_required' };
  if (!env.QUEUES_ENABLED) return { ready: false, reason: 'automation_queue_unavailable' };
  const sms = channelStatus('sms');
  if (!(APPOINTMENT_SMS_PROVIDER_ALLOWLIST as readonly string[]).includes(sms.provider)) {
    return { ready: false, reason: 'messaging_provider_not_allowed' };
  }
  if (!sms.configured || sms.setupRequired) return { ready: false, reason: 'messaging_provider_setup_required' };
  if (!sms.mock) return { ready: false, reason: 'real_provider_activation_required' };
  return { ready: true, reason: null };
}

export function communicationPlanStatus(
  mode: AppointmentCommunicationMode,
  smsQueued = false,
): AppointmentCommunicationPlanStatus {
  if (mode === 'NONE') return 'PAUSED';
  if (mode === 'SMS' && smsQueued) return 'ACTIVE';
  return 'BLOCKED_SETUP';
}

export function reminderDueAt(startsAt: Date, reminderLeadMinutes: number): Date {
  return new Date(startsAt.getTime() - reminderLeadMinutes * 60_000);
}

export async function lockAppointmentCommunication(
  tx: Tx,
  tenantId: string,
  appointmentId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`appointment-communication:${tenantId}:${appointmentId}`})::bigint)
  `;
}

async function cancelPendingActions(tx: Tx, tenantId: string, appointmentId: string): Promise<void> {
  const actions = await tx.appointmentCommunicationAction.findMany({
    where: { tenantId, appointmentId, status: { in: ['QUEUED', 'BLOCKED_SETUP', 'FAILED'] } },
    select: {
      id: true,
      notificationEvent: {
        select: {
          id: true,
          status: true,
          deliveryAttempts: { where: { phase: 'PROVIDER_INTENT' }, select: { id: true } },
        },
      },
    },
  });
  for (const action of actions) {
    // Provider intent is the linearization point. If it already committed, the
    // mock submission may be in flight and final reconciliation retains truth.
    if (action.notificationEvent?.deliveryAttempts.length) continue;
    if (action.notificationEvent && ['queued', 'failed', 'retrying'].includes(action.notificationEvent.status)) {
      await tx.notificationEvent.update({
        where: { id: action.notificationEvent.id },
        data: {
          status: 'suppressed',
          failureReason: 'appointment_communication_changed',
          nextAttemptAt: null,
          consentChecked: true,
          consentResult: 'not_required',
        },
      });
    }
    await tx.appointmentCommunicationAction.update({ where: { id: action.id }, data: { status: 'CANCELLED' } });
  }
}

async function createCurrentActions(
  tx: Tx,
  input: {
    tenantId: string;
    appointmentId: string;
    planId: string;
    appointmentVersion: number;
    planRevision: number;
    mode: AppointmentCommunicationMode;
    dueAt: Date;
  },
): Promise<boolean> {
  const base = {
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    planId: input.planId,
    appointmentVersion: input.appointmentVersion,
    planRevision: input.planRevision,
    kind: 'REMINDER' as const,
    sequence: 1,
    dueAt: input.dueAt,
  };
  const appointment = await tx.appointment.findFirst({
    where: { id: input.appointmentId, tenantId: input.tenantId },
    select: { patientId: true, status: true, startsAt: true, patient: { select: { phone: true } } },
  });
  if (!appointment) throw new Error('appointment_communication_appointment_missing');
  let smsQueued = false;
  if (input.mode === 'SMS' || input.mode === 'BOTH') {
    const readiness = appointmentSmsAutomationReadiness();
    const phoneReady = isValidE164(toE164(appointment.patient.phone ?? ''));
    const appointmentReady = ['CONFIRMED', 'RISKY'].includes(appointment.status)
      && appointment.startsAt.getTime() > Date.now();
    const action = await tx.appointmentCommunicationAction.create({
      data: { ...base, channel: 'SMS', status: readiness.ready && phoneReady && appointmentReady ? 'QUEUED' : 'BLOCKED_SETUP' },
    });
    if (readiness.ready && phoneReady && appointmentReady) {
      await tx.notificationEvent.create({ data: {
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        appointmentCommunicationActionId: action.id,
        patientId: appointment.patientId,
        recipientType: 'patient',
        channel: 'sms',
        status: 'queued',
        attempts: 0,
        consentChecked: false,
        consentResult: 'not_recorded_transactional',
        source: APPOINTMENT_REMINDER_OUTBOX_SOURCE,
        idempotencyKey: `${input.appointmentId}:v${input.appointmentVersion}:r${input.planRevision}:reminder:sms:1`,
        nextAttemptAt: input.dueAt,
      } });
      smsQueued = true;
    }
  }
  if (input.mode === 'VOICE' || input.mode === 'BOTH') {
    // Deliberately not queued. A future dispatcher must replace this explicit
    // setup gate; T1 never pretends an automated call will happen.
    await tx.appointmentCommunicationAction.create({ data: { ...base, channel: 'VOICE', status: 'BLOCKED_SETUP' } });
  }
  return smsQueued;
}

export async function replaceAppointmentCommunicationActions(
  tx: Tx,
  input: {
    tenantId: string;
    appointmentId: string;
    planId: string;
    appointmentVersion: number;
    planRevision: number;
    mode: AppointmentCommunicationMode;
    startsAt: Date;
    reminderLeadMinutes: number;
  },
): Promise<boolean> {
  await cancelPendingActions(tx, input.tenantId, input.appointmentId);
  return createCurrentActions(tx, {
    ...input,
    dueAt: reminderDueAt(input.startsAt, input.reminderLeadMinutes),
  });
}

/**
 * Rebase a saved plan onto a newly scheduled time. Must run in the exact same
 * transaction as the Appointment version increment and confirmation reset.
 */
export async function advanceCommunicationPlanAfterReschedule(
  tx: Tx,
  input: { tenantId: string; appointmentId: string; appointmentVersion: number; startsAt: Date },
): Promise<void> {
  const plan = await tx.appointmentCommunicationPlan.findUnique({
    where: { tenantId_appointmentId: { tenantId: input.tenantId, appointmentId: input.appointmentId } },
  });
  if (!plan) return;

  const revision = plan.revision + 1;
  await tx.appointmentCommunicationPlan.update({
    where: { id: plan.id },
    data: {
      revision,
      appointmentVersion: input.appointmentVersion,
      status: communicationPlanStatus(plan.mode),
    },
  });
  const smsQueued = await replaceAppointmentCommunicationActions(tx, {
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    planId: plan.id,
    appointmentVersion: input.appointmentVersion,
    planRevision: revision,
    mode: plan.mode,
    startsAt: input.startsAt,
    reminderLeadMinutes: plan.reminderLeadMinutes,
  });
  await tx.appointmentCommunicationPlan.update({
    where: { id: plan.id },
    data: { status: communicationPlanStatus(plan.mode, smsQueued) },
  });
}

/** Stop every not-yet-delivered reminder when the appointment is cancelled. */
export async function cancelAppointmentCommunicationPlan(
  tx: Tx,
  input: { tenantId: string; appointmentId: string; appointmentVersion: number },
): Promise<void> {
  const plan = await tx.appointmentCommunicationPlan.findUnique({
    where: { tenantId_appointmentId: { tenantId: input.tenantId, appointmentId: input.appointmentId } },
  });
  if (!plan) return;
  await cancelPendingActions(tx, input.tenantId, input.appointmentId);
  await tx.appointmentCommunicationPlan.update({
    where: { id: plan.id },
    data: {
      status: 'CANCELLED',
      revision: { increment: 1 },
      appointmentVersion: input.appointmentVersion,
    },
  });
}

type PlanWithActions = Prisma.AppointmentCommunicationPlanGetPayload<{
  include: { actions: true };
}>;

/** Operational API shape: clinic concepts only; no provider wiring details. */
export function presentAppointmentCommunicationPlan(plan: PlanWithActions | null, appointmentVersion: number) {
  if (!plan) {
    return {
      mode: 'NONE' as const,
      status: 'PAUSED' as const,
      reminderLeadMinutes: DEFAULT_REMINDER_LEAD_MINUTES,
      revision: null,
      appointmentVersion,
      messages: [],
      summary: 'No reminders selected',
    };
  }
  const currentActions = plan.actions
    .filter(action => action.planRevision === plan.revision && action.appointmentVersion === appointmentVersion)
    .sort((a, b) => a.channel.localeCompare(b.channel))
    .map(action => ({
      channel: action.channel,
      state: action.status === 'QUEUED' ? 'scheduled' as const
        : action.status === 'PROVIDER_ACCEPTED' ? 'provider_accepted' as const
        : action.status === 'DELIVERY_UNKNOWN' ? 'delivery_unknown' as const
        : action.status === 'BLOCKED_SETUP' ? 'setup_needed' as const
        : action.status.toLowerCase(),
      dueAt: action.dueAt,
    }));
  const hasSmsSetup = currentActions.some(action => action.channel === 'SMS' && action.state === 'setup_needed');
  const hasSmsScheduled = currentActions.some(action => action.channel === 'SMS' && action.state === 'scheduled');
  const hasSmsAccepted = currentActions.some(action => action.channel === 'SMS' && action.state === 'provider_accepted');
  const hasSmsUnknown = currentActions.some(action => action.channel === 'SMS' && action.state === 'delivery_unknown');
  const hasVoiceSetup = currentActions.some(action => action.channel === 'VOICE' && action.state === 'setup_needed');
  const summary = hasSmsAccepted && hasVoiceSetup ? 'Text reminder accepted by messaging provider; call automation setup needed'
    : hasSmsScheduled && hasVoiceSetup ? 'Text reminder scheduled; call automation setup needed'
    : hasSmsUnknown && hasVoiceSetup ? 'Text reminder status needs review; call automation setup needed'
    : hasSmsSetup && hasVoiceSetup ? 'Text and call reminders selected; automation setup needed'
    : hasSmsAccepted ? 'Text reminder accepted by messaging provider'
    : hasSmsScheduled ? 'Text reminder scheduled'
    : hasSmsUnknown ? 'Text reminder status needs review'
    : hasSmsSetup ? 'Text reminder selected; automation setup needed'
    : hasVoiceSetup ? 'Call reminder selected; automation setup needed'
    : 'No reminders selected';
  return {
    mode: plan.mode,
    status: plan.status,
    reminderLeadMinutes: plan.reminderLeadMinutes,
    revision: plan.revision,
    appointmentVersion,
    messages: currentActions,
    summary,
  };
}
