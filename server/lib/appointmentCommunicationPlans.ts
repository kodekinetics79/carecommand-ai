import type {
  AppointmentCommunicationMode,
  AppointmentCommunicationPlanStatus,
  Prisma,
} from '../generated/prisma/client';

export const DEFAULT_REMINDER_LEAD_MINUTES = 24 * 60;
export const MIN_REMINDER_LEAD_MINUTES = 15;
export const MAX_REMINDER_LEAD_MINUTES = 7 * 24 * 60;

type Tx = Prisma.TransactionClient;

export function communicationPlanStatus(mode: AppointmentCommunicationMode): AppointmentCommunicationPlanStatus {
  if (mode === 'NONE') return 'PAUSED';
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
  await tx.appointmentCommunicationAction.updateMany({
    where: {
      tenantId,
      appointmentId,
      status: { in: ['QUEUED', 'BLOCKED_SETUP'] },
    },
    data: { status: 'CANCELLED' },
  });
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
): Promise<void> {
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
  const actions: Prisma.AppointmentCommunicationActionCreateManyInput[] = [];
  if (input.mode === 'SMS' || input.mode === 'BOTH') {
    // A selected channel is not a delivery promise. Until a durable dispatcher
    // owns this action, persist the explicit setup gate.
    actions.push({ ...base, channel: 'SMS', status: 'BLOCKED_SETUP' });
  }
  if (input.mode === 'VOICE' || input.mode === 'BOTH') {
    // Deliberately not queued. A future dispatcher must replace this explicit
    // setup gate; T1 never pretends an automated call will happen.
    actions.push({ ...base, channel: 'VOICE', status: 'BLOCKED_SETUP' });
  }
  if (actions.length > 0) await tx.appointmentCommunicationAction.createMany({ data: actions });
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
): Promise<void> {
  await cancelPendingActions(tx, input.tenantId, input.appointmentId);
  await createCurrentActions(tx, {
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
  await replaceAppointmentCommunicationActions(tx, {
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    planId: plan.id,
    appointmentVersion: input.appointmentVersion,
    planRevision: revision,
    mode: plan.mode,
    startsAt: input.startsAt,
    reminderLeadMinutes: plan.reminderLeadMinutes,
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
      state: action.status === 'BLOCKED_SETUP' ? 'setup_needed' as const
        : action.status.toLowerCase(),
      dueAt: action.dueAt,
    }));
  const hasSmsSetup = currentActions.some(action => action.channel === 'SMS' && action.state === 'setup_needed');
  const hasVoiceSetup = currentActions.some(action => action.channel === 'VOICE' && action.state === 'setup_needed');
  const summary = hasSmsSetup && hasVoiceSetup ? 'Text and call reminders selected; automation setup needed'
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
