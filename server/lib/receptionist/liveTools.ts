import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';
import { sendMessage } from '../commsProvider';
import { recordWorkflowEvent } from '../intelligence';
import { getOpenSlots, isSlotOpen, parseSlot, speakTime, SLOT_MIN } from './availability';

// Real-time tools the AI receptionist invokes DURING a call (Retell custom
// functions). Each returns a JSON result with a `message` the agent can speak.
// Tenant-scoped, audited, idempotent. No PHI is logged.

export interface ToolContext { tenantId: string; callId: string | null; callerPhone?: string | null }

function str(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s : null;
}
async function auditLive(tenantId: string, action: string, resourceId: string | null, metadata: Record<string, unknown>) {
  await db.auditEvent.create({ data: { tenantId, actorUserId: null, action, resource: 'receptionistLiveAgent', resourceId: resourceId ?? undefined, userAgent: 'retell-webhook', metadata: metadata as Prisma.InputJsonValue } }).catch(() => {});
}
async function resolveBranch(tenantId: string): Promise<{ id: string } | null> {
  return db.branch.findFirst({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
}
function speakList(times: string[]): string {
  const labels = times.map(speakTime);
  if (labels.length <= 2) return labels.join(' or ');
  return `${labels.slice(0, -1).join(', ')}, or ${labels.slice(-1)}`;
}

/** check_availability(appointment_date) → real open slots for the branch. */
export async function checkAvailability(ctx: ToolContext, args: Record<string, unknown>) {
  const branch = await resolveBranch(ctx.tenantId);
  const date = str(args.appointment_date) ?? '';
  if (!branch) return { available: false, slots: [], message: "I'm sorry, I can't reach the schedule right now. Let me take your details and have someone call you back." };
  const slots = await getOpenSlots(ctx.tenantId, branch.id, date, SLOT_MIN, 6);
  await auditLive(ctx.tenantId, 'receptionist.availability.checked', branch.id, { date, count: slots.length });
  if (slots.length === 0) return { available: false, slots: [], message: `I don't see any openings on ${date}. Would a different day work?` };
  return {
    available: true,
    slots: slots.map(s => ({ time: s.time, label: speakTime(s.time) })),
    message: `On ${date} I have ${speakList(slots.map(s => s.time))}. Which works best for you?`,
  };
}

/** book_appointment(...) → verify slot, find/create patient, book, text confirmation. */
export async function bookAppointment(ctx: ToolContext, args: Record<string, unknown>) {
  const branch = await resolveBranch(ctx.tenantId);
  if (!branch) return { booked: false, message: "I'm sorry, I can't book right now — let me have a team member follow up." };
  const date = str(args.appointment_date) ?? '';
  const time = str(args.appointment_time) ?? '';
  const startsAt = parseSlot(date, time);
  const firstName = str(args.first_name);
  const lastName = str(args.last_name);
  const phone = str(args.phone) ?? ctx.callerPhone ?? null;
  const service = str(args.service) ?? 'Consultation';

  if (!startsAt) return { booked: false, message: "I didn't quite catch the date and time — could you say that again?" };
  if (!firstName || !lastName) return { booked: false, message: 'I just need your first and last name to confirm the booking.' };

  // Idempotency — the same call booking the same slot only books once.
  const idemKey = `${ctx.callId ?? 'nocall'}:${branch.id}:${startsAt.toISOString()}`;
  try {
    await db.idempotencyKey.create({ data: { tenantId: ctx.tenantId, scope: 'receptionist.live-booking', key: idemKey } });
  } catch {
    return { booked: true, duplicate: true, message: `You're already set for ${speakTime(time)} on ${date}.` };
  }

  if (!(await isSlotOpen(ctx.tenantId, branch.id, startsAt))) {
    return { booked: false, message: `I'm sorry — ${speakTime(time)} was just taken. Would you like another time?` };
  }

  let patient = phone
    ? await db.patient.findFirst({ where: { tenantId: ctx.tenantId, deletedAt: null, phone }, select: { id: true } })
    : null;
  if (!patient) {
    patient = await db.patient.create({ data: { tenantId: ctx.tenantId, branchId: branch.id, firstName, lastName, phone, lifecycleStage: 'NEW' }, select: { id: true } });
  }

  const endsAt = new Date(startsAt.getTime() + SLOT_MIN * 60_000);
  const appt = await db.appointment.create({
    data: { tenantId: ctx.tenantId, branchId: branch.id, patientId: patient.id, service, startsAt, endsAt, status: 'CONFIRMED', channel: 'CALL' },
    select: { id: true },
  });
  const reqRow = await db.appointmentRequest.create({
    data: {
      tenantId: ctx.tenantId, branchId: branch.id, patientId: patient.id, requestedService: service,
      collectedName: `${firstName} ${lastName}`, collectedPhone: phone, status: 'BOOKED', source: 'ai_receptionist',
      rawCollectedFields: args as Prisma.InputJsonValue, missingFields: [], bookedAppointmentId: appt.id,
      outcomeReason: 'Booked live by AI receptionist', requestedDateTime: startsAt,
    },
    select: { id: true },
  });
  await auditLive(ctx.tenantId, 'receptionist.appointment.booked', appt.id, { branchId: branch.id, appointmentRequestId: reqRow.id, via: 'live_call' });
  await recordWorkflowEvent(ctx.tenantId, { eventType: 'receptionist.appointmentRequest.created', entityType: 'appointmentRequest', entityId: reqRow.id, sourceModule: 'receptionist', payload: { status: 'BOOKED', live: true } }).catch(() => {});

  // Best-effort SMS confirmation (no-op if Twilio isn't configured).
  let smsSent = false;
  if (phone) {
    const res = await sendMessage('sms', phone, 'Appointment confirmed', `Hi ${firstName}, your ${service} is confirmed for ${date} at ${speakTime(time)}. Reply STOP to opt out.`, `appt-confirm-${appt.id}`).catch(() => null);
    smsSent = !!res?.ok;
  }
  return {
    booked: true, appointment_id: appt.id, sms_sent: smsSent,
    message: `Perfect, ${firstName} — you're booked for ${speakTime(time)} on ${date}.${smsSent ? " I've just texted you a confirmation." : ''}`,
  };
}

export async function handleAgentTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  if (name === 'check_availability') return checkAvailability(ctx, args);
  if (name === 'book_appointment') return bookAppointment(ctx, args);
  return { error: 'unknown_function', message: "I'm not able to help with that just yet." };
}
