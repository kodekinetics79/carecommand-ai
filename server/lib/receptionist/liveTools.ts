import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';
import { sendMessage } from '../commsProvider';
import { recordWorkflowEvent } from '../intelligence';
import { toE164, isValidE164 } from '../campaigns';
import { getOpenSlots, isSlotOpen, parseSlot, speakTime, SLOT_MIN } from './availability';
import { isDoubleBookConflictError } from '../scheduling';

// Real-time tools the AI receptionist invokes DURING a call (Retell custom
// functions). Each returns a JSON result with a `message` the agent can speak.
// Tenant-scoped, audited, idempotent. No PHI is logged.
//
// Caller input is UNTRUSTED: a caller (or an attacker who guessed a clinic id)
// controls every arg. So every free-text field that is persisted or interpolated
// into an SMS is length-capped and stripped of control chars / URLs, phones are
// coerced/validated to E.164, and the confirmation SMS is bound to the VERIFIED
// call number (never an arbitrary args phone). Bookings run inside a slot-scoped
// advisory-locked transaction so two concurrent callers can never take one slot.

export interface ToolContext { tenantId: string; callId: string | null; callerPhone?: string | null }

// Bounded caps for caller-supplied free text.
const MAX_NAME = 80;
const MAX_SERVICE = 120;
const MAX_SHORT = 40;

function str(v: unknown, max = MAX_SHORT): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s.slice(0, max) : null;
}

// Strip control characters + URLs, collapse whitespace, cap length. Applied to
// any caller-supplied text persisted or interpolated into an SMS body (defense
// against SMS-injection and smuggled links via the live agent tools).
function sanitizeText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // Drop control characters (0x00-0x1F and 0x7F) without a control-char regex.
  let stripped = '';
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    stripped += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const cleaned = stripped
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')       // URLs
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

// Coerce a caller-provided phone to E.164; null when it is not a valid number.
function validPhone(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const e164 = toE164(v);
  return isValidE164(e164) ? e164 : null;
}

async function auditLive(tenantId: string, action: string, resourceId: string | null, metadata: Record<string, unknown>) {
  await db.auditEvent.create({ data: { tenantId, actorUserId: null, action, resource: 'receptionistLiveAgent', resourceId: resourceId ?? undefined, userAgent: 'retell-webhook', metadata: metadata as Prisma.InputJsonValue } }).catch(() => {});
}
async function resolveBranch(tenantId: string): Promise<{ id: string } | null> {
  return db.branch.findFirst({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
}

// Link the booking to a provider ONLY when it is unambiguous — a branch with a
// single provider. That makes the live-call booking participate in the canonical
// cross-path double-book guard (the Appointment.providerProfileId exclusion
// constraint). When 0 or >1 providers exist the choice isn't determinable from a
// phone call, so we leave it null (branch-level advisory lock still applies).
async function resolveSoleProvider(tenantId: string, branchId: string): Promise<string | null> {
  const providers = await db.providerProfile.findMany({ where: { tenantId, branchId }, select: { id: true }, take: 2 });
  return providers.length === 1 ? providers[0].id : null;
}
function speakList(times: string[]): string {
  const labels = times.map(speakTime);
  if (labels.length <= 2) return labels.join(' or ');
  return `${labels.slice(0, -1).join(', ')}, or ${labels.slice(-1)}`;
}

// Whether a service is bookable for this tenant. When a service catalog exists,
// an unrecognized service is routed to staff review instead of booked; when no
// catalog is configured the free-text service is accepted (backward-compatible).
async function serviceKnown(tenantId: string, service: string): Promise<boolean> {
  const catalog = await db.serviceCatalogItem.findMany({ where: { tenantId, active: true }, select: { name: true } });
  if (catalog.length === 0) return true;
  const target = service.trim().toLowerCase();
  return catalog.some(s => s.name.trim().toLowerCase() === target);
}

// Persist an appointment request that a human must review (never books). Used
// when the live agent collected something usable but the booking cannot be made
// safely (unparseable date/time, unknown service) — degrade, never crash.
async function routeToReview(
  ctx: ToolContext,
  branchId: string,
  opts: { firstName: string | null; lastName: string | null; phone: string | null; service: string | null; args: Prisma.InputJsonValue; missingFields: string[]; reason: string; speak: string },
) {
  const req = await db.appointmentRequest.create({
    data: {
      tenantId: ctx.tenantId, branchId,
      requestedService: opts.service ?? null,
      collectedName: [opts.firstName, opts.lastName].filter(Boolean).join(' ') || null,
      collectedPhone: opts.phone ?? null,
      rawCollectedFields: opts.args, source: 'ai_receptionist', status: 'MISSING_INFO',
      missingFields: opts.missingFields, outcomeReason: opts.reason,
    },
    select: { id: true },
  });
  await auditLive(ctx.tenantId, 'receptionist.appointmentRequest.needsReview', req.id, { reason: opts.reason, via: 'live_call' });
  await recordWorkflowEvent(ctx.tenantId, { eventType: 'receptionist.appointmentRequest.created', entityType: 'appointmentRequest', entityId: req.id, sourceModule: 'receptionist', payload: { status: 'MISSING_INFO', live: true } }).catch(() => {});
  return { booked: false, needs_review: true, appointment_request_id: req.id, message: opts.speak };
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
  const firstName = sanitizeText(args.first_name, MAX_NAME);
  const lastName = sanitizeText(args.last_name, MAX_NAME);
  const service = sanitizeText(args.service, MAX_SERVICE) ?? 'Consultation';
  // Bind everything to the VERIFIED call number when we have it; only fall back
  // to a caller-provided phone. An arbitrary args.phone can never override the
  // real caller — this is what stops attacker-directed confirmation SMS.
  const phone = validPhone(ctx.callerPhone) ?? validPhone(args.phone);

  // A bounded, sanitized snapshot of what we collected (persisted, never raw).
  const cleanArgs: Prisma.InputJsonValue = {
    appointment_date: date, appointment_time: time,
    first_name: firstName, last_name: lastName, service, phone,
  };

  if (!startsAt) {
    // Malformed date/time → never crash, never book nonsense. Route to review
    // when we have something to follow up on (a name or a phone).
    if (phone || (firstName && lastName)) {
      return routeToReview(ctx, branch.id, {
        firstName, lastName, phone, service, args: cleanArgs, missingFields: ['preferredDateTime'],
        reason: 'Could not parse a valid date/time from the live call',
        speak: "I didn't quite catch the date and time — let me have a team member follow up to lock that in.",
      });
    }
    return { booked: false, message: "I didn't quite catch the date and time — could you say that again?" };
  }
  if (!firstName || !lastName) return { booked: false, message: 'I just need your first and last name to confirm the booking.' };

  // Unknown service (only when a catalog is configured) → staff review, not a
  // nonsense booking.
  if (!(await serviceKnown(ctx.tenantId, service))) {
    return routeToReview(ctx, branch.id, {
      firstName, lastName, phone, service, args: cleanArgs, missingFields: ['preferredService'],
      reason: `Requested service is not in the clinic catalog: ${service}`,
      speak: `Let me have someone confirm availability for ${service} and call you right back.`,
    });
  }

  // Same-call idempotency — the same call booking the same slot only books once.
  const idemKey = `${ctx.callId ?? 'nocall'}:${branch.id}:${startsAt.toISOString()}`;
  try {
    await db.idempotencyKey.create({ data: { tenantId: ctx.tenantId, scope: 'receptionist.live-booking', key: idemKey } });
  } catch {
    return { booked: true, duplicate: true, message: `You're already set for ${speakTime(time)} on ${date}.` };
  }

  // Slot-check + create inside ONE transaction, serialized by a slot-scoped
  // advisory lock so two concurrent callers can never both take the same slot.
  // The in-transaction isSlotOpen reads the shared Appointment table (branch +
  // BLOCKING status), so an appointment booked by ANY path (scheduling, portal,
  // staff) blocks the live agent from the same slot too.
  // Unambiguous single-provider branch → link the provider so this booking joins
  // the cross-path exclusion-constraint guard (defense in depth over the
  // branch-level advisory lock below).
  const providerProfileId = await resolveSoleProvider(ctx.tenantId, branch.id);
  const lockKey = `receptionist-book:${ctx.tenantId}:${branch.id}:${startsAt.toISOString()}`;
  let booked: { apptId: string; patientId: string; reqId: string } | null;
  try {
    booked = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
    if (!(await isSlotOpen(ctx.tenantId, branch.id, startsAt, SLOT_MIN, tx))) return null;

    let patient = phone
      ? await tx.patient.findFirst({ where: { tenantId: ctx.tenantId, deletedAt: null, phone }, select: { id: true } })
      : null;
    if (!patient) {
      patient = await tx.patient.create({ data: { tenantId: ctx.tenantId, branchId: branch.id, firstName, lastName, phone, lifecycleStage: 'NEW' }, select: { id: true } });
    }
    const endsAt = new Date(startsAt.getTime() + SLOT_MIN * 60_000);
    const appt = await tx.appointment.create({
      data: { tenantId: ctx.tenantId, branchId: branch.id, patientId: patient.id, providerProfileId, providerRef: providerProfileId, service, startsAt, endsAt, status: 'CONFIRMED', channel: 'CALL' },
      select: { id: true },
    });
    const reqRow = await tx.appointmentRequest.create({
      data: {
        tenantId: ctx.tenantId, branchId: branch.id, patientId: patient.id, requestedService: service,
        collectedName: `${firstName} ${lastName}`, collectedPhone: phone, status: 'BOOKED', source: 'ai_receptionist',
        rawCollectedFields: cleanArgs, missingFields: [], bookedAppointmentId: appt.id,
        outcomeReason: 'Booked live by AI receptionist', requestedDateTime: startsAt,
      },
      select: { id: true },
    });
    return { apptId: appt.id, patientId: patient.id, reqId: reqRow.id };
    });
  } catch (error) {
    // A concurrent booking on another path took this provider's slot and the DB
    // exclusion constraint fired — treat as "just taken", never crash the call.
    if (isDoubleBookConflictError(error)) return { booked: false, message: `I'm sorry — ${speakTime(time)} was just taken. Would you like another time?` };
    throw error;
  }

  if (!booked) return { booked: false, message: `I'm sorry — ${speakTime(time)} was just taken. Would you like another time?` };

  await auditLive(ctx.tenantId, 'receptionist.appointment.booked', booked.apptId, { branchId: branch.id, appointmentRequestId: booked.reqId, via: 'live_call' });
  await recordWorkflowEvent(ctx.tenantId, { eventType: 'receptionist.appointmentRequest.created', entityType: 'appointmentRequest', entityId: booked.reqId, sourceModule: 'receptionist', payload: { status: 'BOOKED', live: true } }).catch(() => {});

  // Best-effort SMS confirmation to the VERIFIED caller (no-op if Twilio isn't
  // configured, suppressed if the number opted out — the gate lives in
  // sendMessage). firstName/service are already sanitized above.
  let smsSent = false;
  if (phone) {
    const res = await sendMessage('sms', phone, 'Appointment confirmed', `Hi ${firstName}, your ${service} is confirmed for ${date} at ${speakTime(time)}. Reply STOP to opt out.`, `appt-confirm-${booked.apptId}`, { tenantId: ctx.tenantId, patientId: booked.patientId }).catch(() => null);
    smsSent = !!res?.ok;
  }
  return {
    booked: true, appointment_id: booked.apptId, sms_sent: smsSent,
    message: `Perfect, ${firstName} — you're booked for ${speakTime(time)} on ${date}.${smsSent ? " I've just texted you a confirmation." : ''}`,
  };
}

export async function handleAgentTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  if (name === 'check_availability') return checkAvailability(ctx, args);
  if (name === 'book_appointment') return bookAppointment(ctx, args);
  return { error: 'unknown_function', message: "I'm not able to help with that just yet." };
}
