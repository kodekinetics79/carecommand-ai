import type { Prisma } from '../../generated/prisma/client';
import { parseReceptionistTask, type ReceptionistTaskKind, type ReceptionistTaskMetadata } from './frontDeskTask';

// ===========================================================================
// One projection for every StaffTask read surface (/v1/tasks list, summary,
// staff task detail). Masking (M68):
//   - without `receptionist:call-artifacts:read` a receptionist task collapses
//     to { kind, restricted: true, requiresAcknowledgement } — metadata too —
//     and callLogId / outcomeNote are withheld;
//   - with it, phones are ALWAYS masked in list/summary payloads. The unmasked
//     number only leaves the server through the audited task detail.
//   - the patient block additionally needs `patient:read`.
// ===========================================================================

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return `***-***-${digits.slice(-4).padStart(4, '*')}`;
}

export const taskListInclude = {
  branch: { select: { name: true } },
  assignedTo: { select: { displayName: true } },
  acknowledgedBy: { select: { displayName: true } },
  patient: { select: { id: true, firstName: true, lastName: true } },
  callLog: { select: { id: true, retellCallId: true, direction: true, clinic: { select: { id: true, name: true, timezone: true } } } },
} satisfies Prisma.StaffTaskInclude;

export type TaskRowWithRelations = Prisma.StaffTaskGetPayload<{ include: typeof taskListInclude }>;

export interface ReceptionistTaskView {
  kind: ReceptionistTaskKind;
  restricted: false;
  requiresAcknowledgement: true;
  source: ReceptionistTaskMetadata['source'];
  callId: string | null;
  clinicId: string | null;
  locationId: string | null;
  callerName: string | null;
  callbackPhoneMasked: string | null;
  verifiedPhoneMasked: string | null;
  requestedPhoneMasked: string | null;
  hasRequestedPhone: boolean;
  messages: Array<{ text: string; recordedAt: string }>;
  messageCount: number;
  reasonCategory: string;
  callbackWindow: ReceptionistTaskMetadata['callbackWindow'];
  transferStatus: ReceptionistTaskMetadata['transferStatus'];
  transferUpdatedAt: string | null;
  toolName: string | null;
  denialReason: string | null;
  appointmentRequestId: string | null;
  appointmentId: string | null;
  staffNotes: ReceptionistTaskMetadata['staffNotes'];
}

export interface RestrictedTaskView {
  kind: ReceptionistTaskKind;
  restricted: true;
  requiresAcknowledgement: true;
}

export interface TaskProjectionOptions {
  canReadArtifacts: boolean;
  canReadPatient: boolean;
}

export function receptionistView(meta: ReceptionistTaskMetadata): ReceptionistTaskView {
  return {
    kind: meta.kind,
    restricted: false,
    requiresAcknowledgement: true,
    source: meta.source,
    callId: meta.callId,
    clinicId: meta.clinicId,
    locationId: meta.locationId,
    callerName: meta.callerName,
    callbackPhoneMasked: maskPhone(meta.callbackPhone),
    verifiedPhoneMasked: maskPhone(meta.verifiedPhone),
    requestedPhoneMasked: maskPhone(meta.requestedCallbackPhone),
    hasRequestedPhone: Boolean(meta.requestedCallbackPhone),
    messages: meta.messages.map(entry => ({ text: entry.text, recordedAt: entry.recordedAt })),
    messageCount: meta.messages.length || (meta.message ? 1 : 0),
    reasonCategory: meta.reasonCategory,
    callbackWindow: meta.callbackWindow,
    transferStatus: meta.transferStatus,
    transferUpdatedAt: meta.transferUpdatedAt,
    toolName: meta.toolName,
    denialReason: meta.denialReason,
    appointmentRequestId: meta.appointmentRequestId,
    appointmentId: meta.appointmentId,
    staffNotes: meta.staffNotes,
  };
}

export function projectTaskRow(row: TaskRowWithRelations, options: TaskProjectionOptions) {
  const meta = parseReceptionistTask(row);
  const restricted = Boolean(meta) && !options.canReadArtifacts;
  const receptionist: ReceptionistTaskView | RestrictedTaskView | null = meta
    ? restricted
      ? { kind: meta.kind, restricted: true, requiresAcknowledgement: true }
      : receptionistView(meta)
    : null;
  const patient = options.canReadPatient && row.patient
    ? { id: row.patient.id, firstName: row.patient.firstName, lastName: row.patient.lastName }
    : null;
  const clinic = row.callLog?.clinic ? { id: row.callLog.clinic.id, name: row.callLog.clinic.name, timezone: row.callLog.clinic.timezone } : null;
  const metadata = restricted && meta
    ? { workflow: 'receptionist_safety', kind: meta.kind, requiresAcknowledgement: true, restricted: true }
    : row.metadata;
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    status: row.status,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    branchId: row.branchId,
    branch: row.branch ? { name: row.branch.name } : null,
    assignedToId: row.assignedToId,
    assignedTo: row.assignedTo ? { displayName: row.assignedTo.displayName } : null,
    acknowledgedAt: row.acknowledgedAt,
    acknowledgedById: row.acknowledgedById,
    acknowledgedBy: row.acknowledgedBy ? { displayName: row.acknowledgedBy.displayName } : null,
    completedAt: row.completedAt,
    outcomeCode: row.outcomeCode,
    outcomeNote: restricted ? null : row.outcomeNote,
    callLogId: restricted ? null : row.callLogId,
    patientId: options.canReadPatient ? row.patientId : null,
    patient,
    clinic,
    receptionist,
    metadata,
  };
}

export type TaskListRow = ReturnType<typeof projectTaskRow>;
