import type { Prisma } from '../generated/prisma/client';

// ===========================================================================
// Append-only appointment notes (C4). The single writer for staff (PATCH
// /v1/appointments/:id/notes), the voice agent (C3's append_appointment_note
// tool) and the system. No update/delete exists by design — the runtime role
// holds SELECT/INSERT only on AppointmentNote.
// ===========================================================================

export const APPOINTMENT_NOTE_MAX = 1000;
export const APPOINTMENT_NOTE_ACTORS = ['staff', 'voice_agent', 'system'] as const;
export type AppointmentNoteActor = typeof APPOINTMENT_NOTE_ACTORS[number];

export const appointmentNoteSelect = {
  id: true, text: true, actorType: true, actorUserId: true, callLogId: true, createdAt: true,
  actorUser: { select: { displayName: true } },
} satisfies Prisma.AppointmentNoteSelect;

export interface AppendAppointmentNoteInput {
  tenantId: string;
  appointmentId: string;
  text: string;
  actorType: AppointmentNoteActor;
  actorUserId?: string | null;
  callLogId?: string | null;
}

/** Appends one note; the appointment must belong to the tenant (404-style null otherwise). */
export async function appendAppointmentNote(tx: Prisma.TransactionClient, input: AppendAppointmentNoteInput) {
  const text = input.text.replace(/\s+/g, ' ').trim().slice(0, APPOINTMENT_NOTE_MAX);
  if (!text) throw new Error('appointment_note_empty');
  const appointment = await tx.appointment.findFirst({
    where: { id: input.appointmentId, tenantId: input.tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!appointment) return null;
  const note = await tx.appointmentNote.create({
    data: {
      tenantId: input.tenantId,
      appointmentId: appointment.id,
      text,
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      callLogId: input.callLogId ?? null,
    },
    select: appointmentNoteSelect,
  });
  const noteCount = await tx.appointmentNote.count({ where: { tenantId: input.tenantId, appointmentId: appointment.id } });
  return { note, noteCount };
}

export function listAppointmentNotes(tx: Prisma.TransactionClient, tenantId: string, appointmentId: string) {
  return tx.appointmentNote.findMany({
    where: { tenantId, appointmentId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: appointmentNoteSelect,
  });
}
