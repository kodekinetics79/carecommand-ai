import type { Prisma } from '../generated/prisma/client';
import { queueAppointmentConfirmations } from './receptionist/confirmationOutbox';
import { findSlotConflict, type SchedulingPolicy, type SchedulingService, type SlotConflict } from './scheduling';

// ===========================================================================
// The ONE atomic staff-side booking: conflict check → appointment.create →
// queue confirmations, inside the caller's transaction. Extracted from
// POST /v1/scheduling/providers/:providerId/book (pure move — the scheduling
// suites prove it) so the receptionist "book from review" path writes an
// appointment exactly the way the scheduler does, never a bespoke insert.
//
// The DB exclusion constraint (`appointment_no_double_book`) remains the final
// guard when two transactions race past the in-transaction check; callers map
// `isDoubleBookConflictError` to 409 exactly as before.
// ===========================================================================

export interface CanonicalBookingInput {
  tenantId: string;
  branchId: string;
  patientId: string;
  providerProfileId: string;
  service: Pick<SchedulingService, 'id' | 'name' | 'durationMin'>;
  startsAt: Date;
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH' | 'CALL' | 'VIDEO';
  policy: Pick<SchedulingPolicy, 'confirmBookingsBySms' | 'confirmBookingsByEmail'>;
  patientContact: { phone: string | null; email: string | null };
  /** Trusted source call for an AI-originated booking; the caller decides when it is safe to stamp. */
  receptionistCallLogId?: string | null;
}

export type CanonicalBookingResult =
  | { conflict: SlotConflict }
  | { appointment: Prisma.AppointmentGetPayload<Record<string, never>>; queued: Awaited<ReturnType<typeof queueAppointmentConfirmations>> };

export async function bookCanonicalAppointment(
  tx: Prisma.TransactionClient,
  input: CanonicalBookingInput,
): Promise<CanonicalBookingResult> {
  const conflict = await findSlotConflict({
    tenantId: input.tenantId, providerProfileId: input.providerProfileId, startsAt: input.startsAt, durationMin: input.service.durationMin,
  }, tx);
  if (conflict) return { conflict };
  const endsAt = new Date(input.startsAt.getTime() + input.service.durationMin * 60_000);
  const appointment = await tx.appointment.create({
    data: {
      tenantId: input.tenantId, branchId: input.branchId, patientId: input.patientId,
      providerProfileId: input.providerProfileId, providerRef: input.providerProfileId,
      service: input.service.name, serviceCatalogItemId: input.service.id ?? null,
      startsAt: input.startsAt, endsAt,
      status: 'CONFIRMED', channel: input.channel,
      ...(input.receptionistCallLogId ? { receptionistCallLogId: input.receptionistCallLogId } : {}),
    },
  });
  // Queue the confirmation with the booking, so a clinic that has opted in
  // cannot end up with an appointment and no message arranged. This only
  // enqueues: consent, quiet hours and the DNC fence are all still decided at
  // the delivery boundary, exactly as for the voice path.
  const queued = await queueAppointmentConfirmations(tx, {
    tenantId: input.tenantId,
    appointmentId: appointment.id,
    patientId: input.patientId,
    smsEnabled: input.policy.confirmBookingsBySms,
    emailEnabled: input.policy.confirmBookingsByEmail,
    phone: input.patientContact.phone,
    email: input.patientContact.email,
  });
  return { appointment, queued };
}
