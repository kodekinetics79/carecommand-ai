import { db } from '../db';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { sendMessage } from '../commsProvider';
import { recordWorkflowEvent } from '../intelligence';
import { toE164, isValidE164 } from '../campaigns';
import { getOpenSlots, isSlotOpen, parseSlot, speakTime, SLOT_MIN } from './availability';
import { findSlotConflict, getSchedulingPolicy, isDoubleBookConflictError, resolveSchedulingService } from '../scheduling';
import { evaluateDepositForAppointment } from '../deposits';
import {
  disclosureEvidenceHash,
  recordRecordingConsent,
  renderRecordingDisclosure,
} from './privacyLifecycle';
import { restrictCallToBasicAttributes } from '../retell';

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
const MAX_MESSAGE = 500;
const MAX_IDENTITY_ATTEMPTS = 3;
const IDENTITY_LOCK_MINUTES = 15;
const CHANGE_CONFIRMATION_TTL_MS = 5 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOICE_MUTABLE_STATUSES = ['CONFIRMED', 'RISKY', 'WAITLIST'] as const;

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

async function auditLive(
  tenantId: string,
  action: string,
  resourceId: string | null,
  metadata: Record<string, unknown>,
  client: typeof db | Prisma.TransactionClient = db,
) {
  await client.auditEvent.create({ data: { tenantId, actorUserId: null, action, resource: 'receptionistLiveAgent', resourceId: resourceId ?? undefined, userAgent: 'retell-webhook', metadata: metadata as Prisma.InputJsonValue } });
}
async function resolveBranch(tenantId: string): Promise<{ id: string; timezone: string } | null> {
  const branches = await db.branch.findMany({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true, timezone: true }, take: 2 });
  return branches.length === 1 ? branches[0] : null;
}

// Live booking requires an unambiguous provider. Ambiguity is routed to staff;
// provider-null appointments would bypass the canonical capacity guard.
async function resolveSoleProvider(tenantId: string, branchId: string): Promise<string | null> {
  const providers = await db.providerProfile.findMany({ where: { tenantId, branchId }, select: { id: true }, take: 2 });
  return providers.length === 1 ? providers[0].id : null;
}

async function patientsByCanonicalPhone(tenantId: string, phone: string): Promise<Array<{ id: string; dateOfBirth: Date | null }>> {
  return db.$queryRaw<Array<{ id: string; dateOfBirth: Date | null }>>`
    SELECT id, "dateOfBirth"
    FROM "Patient"
    WHERE "tenantId" = ${tenantId}::uuid
      AND "deletedAt" IS NULL
      AND "phone" IS NOT NULL
      AND CASE
        WHEN "phone" LIKE '+%' THEN '+' || regexp_replace("phone", '[^0-9]', '', 'g')
        WHEN length(regexp_replace("phone", '[^0-9]', '', 'g')) = 10 THEN '+1' || regexp_replace("phone", '[^0-9]', '', 'g')
        ELSE '+' || regexp_replace("phone", '[^0-9]', '', 'g')
      END = ${phone}
    ORDER BY id
    LIMIT 2
  `;
}
function speakList(times: string[]): string {
  const labels = times.map(speakTime);
  if (labels.length <= 2) return labels.join(' or ');
  return `${labels.slice(0, -1).join(', ')}, or ${labels.slice(-1)}`;
}

// Persist an appointment request that a human must review (never books). Used
// when the live agent collected something usable but the booking cannot be made
// safely (unparseable date/time, unknown service) — degrade, never crash.
async function routeToReview(
  ctx: ToolContext,
  branchId: string,
  opts: { firstName: string | null; lastName: string | null; phone: string | null; service: string | null; args: Prisma.InputJsonValue; missingFields: string[]; reason: string; speak: string },
) {
  const req = await db.$transaction(async tx => {
    const req = await tx.appointmentRequest.create({
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
    await auditLive(ctx.tenantId, 'receptionist.appointmentRequest.needsReview', req.id, { reason: opts.reason, via: 'live_call' }, tx);
    return req;
  });
  await recordWorkflowEvent(ctx.tenantId, { eventType: 'receptionist.appointmentRequest.created', entityType: 'appointmentRequest', entityId: req.id, sourceModule: 'receptionist', payload: { status: 'MISSING_INFO', live: true } }).catch(() => {});
  return { booked: false, needs_review: true, appointment_request_id: req.id, message: opts.speak };
}

type SafetyWorkflow = 'human_handoff' | 'message' | 'emergency';

const SAFETY_TASK: Record<SafetyWorkflow, { title: string; priority: string; dueMinutes: number }> = {
  human_handoff: { title: 'AI receptionist human handoff requested', priority: 'high', dueMinutes: 15 },
  message: { title: 'AI receptionist callback requested', priority: 'high', dueMinutes: 30 },
  emergency: { title: 'URGENT: AI receptionist emergency mention', priority: 'high', dueMinutes: 0 },
};

// Creates the existing, staff-visible acknowledgment primitive before the
// agent promises follow-up or attempts a transfer. Caller content stays in the
// task only; the audit row contains classifications and identifiers, not names,
// phone numbers, or message text. A stable call id makes Retell retries safe.
async function createSafetyTask(ctx: ToolContext, workflow: SafetyWorkflow, args: Record<string, unknown>) {
  const branch = await resolveBranch(ctx.tenantId);
  const callbackPhone = validPhone(ctx.callerPhone) ?? validPhone(args.callback_phone);
  const callerName = sanitizeText(args.caller_name, MAX_NAME);
  const message = sanitizeText(args.message, MAX_MESSAGE);
  const reasonCategory = sanitizeText(args.reason_category, MAX_SHORT) ?? 'other';
  const config = SAFETY_TASK[workflow];
  const safeCallId = sanitizeText(ctx.callId, 128);
  // Retell normally supplies call_id. For a malformed/replayed callback without
  // one, hash minimum-necessary inputs into a short time bucket: no caller
  // content leaks into the key, while immediate provider retries remain safe.
  const fallbackDigest = createHash('sha256')
    .update(JSON.stringify({ tenantId: ctx.tenantId, workflow, callbackPhone, callerName, message, reasonCategory, bucket: Math.floor(Date.now() / 600_000) }))
    .digest('hex');
  const idemKey = safeCallId ? `${ctx.tenantId}:${safeCallId}:${workflow}` : `${ctx.tenantId}:fallback:${fallbackDigest}`;
  const lockKey = `receptionist-safety:${idemKey}`;

  const result = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
    const prior = await tx.idempotencyKey.findUnique({
      where: { scope_key: { scope: 'receptionist.live-safety', key: idemKey } },
      select: { id: true, resultId: true },
    });
    if (prior?.resultId) {
      const task = await tx.staffTask.findFirst({
        where: { id: prior.resultId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (task) return { taskId: task.id, duplicate: true };
    }
    if (prior) await tx.idempotencyKey.delete({ where: { id: prior.id } });

    const task = await tx.staffTask.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: branch?.id,
        title: config.title,
        priority: config.priority,
        dueAt: new Date(Date.now() + config.dueMinutes * 60_000),
        metadata: {
          workflow: 'receptionist_safety',
          kind: workflow,
          callId: safeCallId,
          callbackPhone,
          callerName,
          message,
          reasonCategory,
          requiresAcknowledgement: true,
          source: 'retell_live_call',
        },
      },
      select: { id: true },
    });
    await tx.idempotencyKey.create({
      data: { tenantId: ctx.tenantId, scope: 'receptionist.live-safety', key: idemKey, resultId: task.id },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: ctx.tenantId,
        actorUserId: null,
        action: `receptionist.safety.${workflow}.created`,
        resource: 'staffTask',
        resourceId: task.id,
        userAgent: 'retell-webhook',
        // Minimum necessary: caller content is deliberately excluded.
        metadata: { workflow, branchId: branch?.id ?? null, hasCallbackPhone: Boolean(callbackPhone), callIdPresent: Boolean(safeCallId) },
      },
    });
    if (workflow === 'emergency') {
      await tx.operationalSignal.create({
        data: {
          tenantId: ctx.tenantId,
          signalType: 'receptionist_emergency_mention',
          entityType: 'staffTask',
          entityId: task.id,
          severity: 'critical',
          score: 100,
          reason: 'Emergency language was reported during an AI receptionist call; staff acknowledgment is required.',
        },
      });
    }
    await tx.businessEvent.create({
      data: {
        tenantId: ctx.tenantId,
        eventType: `receptionist.safety.${workflow}.created`,
        entityType: 'staffTask',
        entityId: task.id,
        sourceModule: 'receptionist',
        payload: { workflow, acknowledgmentRequired: true },
      },
    });
    return { taskId: task.id, duplicate: false };
  });
  return result;
}

/** Records an acknowledgment-required handoff before Retell attempts transfer. */
export async function requestHumanHandoff(ctx: ToolContext, args: Record<string, unknown>) {
  const task = await createSafetyTask(ctx, 'human_handoff', args);
  return {
    handoff_recorded: true,
    transfer_completed: false,
    duplicate: task.duplicate,
    task_id: task.taskId,
    message: 'I created a request in the front desk queue. Staff have not acknowledged it yet. If a transfer option is available, I can try it next; no transfer has occurred yet, and the callback request remains open.',
  };
}

/** Persists a bounded callback message as a staff task with explicit acknowledgment status. */
export async function takeMessage(ctx: ToolContext, args: Record<string, unknown>) {
  const task = await createSafetyTask(ctx, 'message', args);
  return {
    message_recorded: true,
    acknowledgment_pending: true,
    duplicate: task.duplicate,
    task_id: task.taskId,
    message: 'Thank you. I have recorded a callback request for the front desk. A team member still needs to review and acknowledge it.',
  };
}

/** Creates a critical staff signal without delaying immediate emergency advice. */
export async function reportEmergency(ctx: ToolContext, args: Record<string, unknown>) {
  const task = await createSafetyTask(ctx, 'emergency', args);
  return {
    emergency_recorded: true,
    acknowledgment_pending: true,
    duplicate: task.duplicate,
    task_id: task.taskId,
    message: 'If you may be experiencing an emergency, hang up and call 911 now, or go to the nearest emergency room. Do not wait for a callback from this office.',
  };
}

/**
 * Verifies possession of the provider call number plus one approved demographic
 * factor. The result is server-side call state; a model-supplied boolean can
 * never assert identity. Responses are deliberately non-enumerating.
 */
export async function verifyPatientIdentity(ctx: ToolContext, args: Record<string, unknown>) {
  const callId = sanitizeText(ctx.callId, 128);
  const phone = validPhone(ctx.callerPhone);
  const dobText = str(args.date_of_birth, 10);
  if (!callId || !phone || !dobText || !/^\d{4}-\d{2}-\d{2}$/.test(dobText)) {
    return { verified: false, needs_human: true, message: 'I cannot complete secure verification on this call. I can connect you with the front desk.' };
  }
  const since = new Date(Date.now() - IDENTITY_LOCK_MINUTES * 60_000);
  const failedAttempts = await db.auditEvent.count({
    where: {
      tenantId: ctx.tenantId,
      action: 'receptionist.identity.failed',
      resource: 'receptionistCall',
      resourceId: callId,
      occurredAt: { gte: since },
    },
  });
  if (failedAttempts >= MAX_IDENTITY_ATTEMPTS) {
    await db.auditEvent.create({ data: { tenantId: ctx.tenantId, action: 'receptionist.identity.locked', resource: 'receptionistCall', resourceId: callId, metadata: { lockMinutes: IDENTITY_LOCK_MINUTES } } });
    return { verified: false, locked: true, needs_human: true, message: 'I cannot continue identity verification on this call. Please contact the front desk.' };
  }

  const matches = (await patientsByCanonicalPhone(ctx.tenantId, phone)).filter(patient =>
    patient.dateOfBirth?.toISOString().slice(0, 10) === dobText,
  );
  if (matches.length !== 1) {
    await db.auditEvent.create({ data: { tenantId: ctx.tenantId, action: 'receptionist.identity.failed', resource: 'receptionistCall', resourceId: callId, metadata: { attempt: failedAttempts + 1 } } });
    return { verified: false, remaining_attempts: Math.max(0, MAX_IDENTITY_ATTEMPTS - failedAttempts - 1), message: 'I could not verify those details. Please try again or ask for the front desk.' };
  }

  const key = `${ctx.tenantId}:${callId}`;
  await db.idempotencyKey.upsert({
    where: { scope_key: { scope: 'receptionist.voice-identity', key } },
    update: { resultId: matches[0].id },
    create: { tenantId: ctx.tenantId, scope: 'receptionist.voice-identity', key, resultId: matches[0].id },
  });
  await db.auditEvent.create({ data: { tenantId: ctx.tenantId, action: 'receptionist.identity.verified', resource: 'receptionistCall', resourceId: callId, metadata: { method: 'caller_number_plus_dob' } } });
  return { verified: true, message: 'Thank you. Your identity is verified for this call.' };
}

async function verifiedPatientForCall(ctx: ToolContext): Promise<string | null> {
  const callId = sanitizeText(ctx.callId, 128);
  const phone = validPhone(ctx.callerPhone);
  if (!callId || !phone) return null;
  const proof = await db.idempotencyKey.findUnique({
    where: { scope_key: { scope: 'receptionist.voice-identity', key: `${ctx.tenantId}:${callId}` } },
    select: { resultId: true },
  });
  if (!proof?.resultId) return null;
  const patient = await db.patient.findFirst({
    where: { id: proof.resultId, tenantId: ctx.tenantId, phone: { not: null }, deletedAt: null },
    select: { id: true, phone: true },
  });
  return patient && validPhone(patient.phone) === phone ? patient.id : null;
}

function localAppointmentLabel(startsAt: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(startsAt);
}

/** Return minimum-necessary upcoming appointments only after server-side identity proof. */
export async function listUpcomingAppointments(ctx: ToolContext) {
  const patientId = await verifiedPatientForCall(ctx);
  if (!patientId) return { verified: false, needs_human: true, appointments: [], message: 'Please verify your identity before I access an existing appointment.' };
  const rows = await db.appointment.findMany({
    where: { tenantId: ctx.tenantId, patientId, deletedAt: null, startsAt: { gt: new Date() }, status: { in: [...VOICE_MUTABLE_STATUSES] } },
    orderBy: { startsAt: 'asc' }, take: 5,
    select: { id: true, startsAt: true, service: true, branch: { select: { timezone: true } } },
  });
  await auditLive(ctx.tenantId, 'receptionist.appointments.listed', ctx.callId, { count: rows.length, via: 'verified_live_call' });
  const appointments = rows.map(row => ({ appointment_id: row.id, service: row.service, starts_at: row.startsAt.toISOString(), spoken_time: localAppointmentLabel(row.startsAt, row.branch.timezone) }));
  return { verified: true, appointments, message: appointments.length ? `I found ${appointments.length} upcoming appointment${appointments.length === 1 ? '' : 's'}.` : 'I do not see an upcoming appointment that can be changed automatically.' };
}

type PendingAppointmentChange = {
  action: 'cancel' | 'reschedule';
  patientId: string;
  appointmentId: string;
  appointmentDate?: string;
  appointmentTime?: string;
};

function pendingChangeKey(ctx: ToolContext, token: string) {
  return `${ctx.tenantId}:${ctx.callId ?? 'missing'}:${token}`;
}

async function loadPendingAppointmentChange(ctx: ToolContext, args: Record<string, unknown>, expectedAction: PendingAppointmentChange['action']) {
  const token = str(args.confirmation_token, 80);
  if (args.confirmed !== true || !token || !ctx.callId) return null;
  const row = await db.idempotencyKey.findUnique({
    where: { scope_key: { scope: 'receptionist.voice-change-confirmation', key: pendingChangeKey(ctx, token) } },
    select: { resultId: true, createdAt: true },
  });
  if (!row?.resultId || row.createdAt.getTime() < Date.now() - CHANGE_CONFIRMATION_TTL_MS) return null;
  try {
    const parsed = JSON.parse(row.resultId) as PendingAppointmentChange;
    return parsed.action === expectedAction ? { token, change: parsed } : null;
  } catch {
    return null;
  }
}

/**
 * Create a short-lived, call-bound pending operation only after the server has
 * revalidated ownership, notice policy, and (for reschedule) current capacity.
 * The mutation tools refuse to act without this nonce plus `confirmed: true`.
 */
export async function prepareAppointmentChange(ctx: ToolContext, args: Record<string, unknown>) {
  const patientId = await verifiedPatientForCall(ctx);
  const appointmentId = str(args.appointment_id, 40);
  const action = str(args.action, 20)?.toLowerCase();
  if (!patientId || !ctx.callId || !appointmentId || !UUID_RE.test(appointmentId) || !['cancel', 'reschedule'].includes(action ?? '')) {
    return { prepared: false, needs_human: true, message: 'I cannot securely prepare that appointment change. I can connect you with the front desk.' };
  }
  const appt = await db.appointment.findFirst({
    where: { id: appointmentId, tenantId: ctx.tenantId, patientId, deletedAt: null, status: { in: [...VOICE_MUTABLE_STATUSES] } },
    include: { branch: { select: { timezone: true } } },
  });
  if (!appt) return { prepared: false, needs_human: true, message: 'That appointment cannot be changed automatically. I can connect you with the front desk.' };
  const policy = await getSchedulingPolicy(ctx.tenantId);
  if (policy.minNoticeHours > 0 && Date.now() > appt.startsAt.getTime() - policy.minNoticeHours * 3_600_000) {
    return { prepared: false, needs_human: true, message: `Changes require at least ${policy.minNoticeHours} hours notice. I can connect you with the front desk.` };
  }

  const change: PendingAppointmentChange = { action: action as PendingAppointmentChange['action'], patientId, appointmentId };
  let spokenChange = 'cancel this appointment';
  if (action === 'reschedule') {
    const appointmentDate = str(args.appointment_date) ?? '';
    const appointmentTime = str(args.appointment_time) ?? '';
    const startsAt = parseSlot(appointmentDate, appointmentTime, appt.branch.timezone);
    if (!startsAt || !appt.providerProfileId) return { prepared: false, needs_human: true, message: 'I cannot validate that new time. I can connect you with the front desk.' };
    const durationMin = Math.max(5, Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / 60_000));
    const conflict = await findSlotConflict({ tenantId: ctx.tenantId, providerProfileId: appt.providerProfileId, startsAt, durationMin, excludeAppointmentId: appointmentId });
    if (conflict) return { prepared: false, message: 'That time is no longer available. Please choose another.' };
    change.appointmentDate = appointmentDate;
    change.appointmentTime = appointmentTime;
    spokenChange = `reschedule it to ${localAppointmentLabel(startsAt, appt.branch.timezone)}`;
  }

  const token = randomUUID();
  await db.$transaction(async tx => {
    await tx.idempotencyKey.deleteMany({ where: { tenantId: ctx.tenantId, scope: 'receptionist.voice-change-confirmation', key: { startsWith: `${ctx.tenantId}:${ctx.callId}:` } } });
    await tx.idempotencyKey.create({ data: { tenantId: ctx.tenantId, scope: 'receptionist.voice-change-confirmation', key: pendingChangeKey(ctx, token), resultId: JSON.stringify(change) } });
  });
  return {
    prepared: true,
    confirmation_token: token,
    expires_in_seconds: CHANGE_CONFIRMATION_TTL_MS / 1_000,
    message: `Please confirm: you want to ${spokenChange}. Is that correct?`,
  };
}

/** Cancel only the verified patient's own mutable appointment. */
export async function cancelAppointment(ctx: ToolContext, args: Record<string, unknown>) {
  const patientId = await verifiedPatientForCall(ctx);
  const appointmentId = str(args.appointment_id, 40);
  if (!patientId || !appointmentId || !UUID_RE.test(appointmentId)) return { cancelled: false, needs_human: true, message: 'I cannot securely identify that appointment. I can connect you with the front desk.' };
  const current = await db.appointment.findFirst({ where: { id: appointmentId, tenantId: ctx.tenantId, patientId, deletedAt: null }, select: { id: true, startsAt: true, status: true } });
  if (!current) return { cancelled: false, needs_human: true, message: 'I cannot securely identify that appointment. I can connect you with the front desk.' };
  if (current.status === 'CANCELED') return { cancelled: true, duplicate: true, appointment_id: current.id, message: 'That appointment is already cancelled.' };
  const pending = await loadPendingAppointmentChange(ctx, args, 'cancel');
  if (!pending || pending.change.patientId !== patientId || pending.change.appointmentId !== appointmentId) {
    return { cancelled: false, confirmation_required: true, message: 'I need to prepare this exact cancellation and receive your explicit confirmation before I can make the change.' };
  }
  if (!VOICE_MUTABLE_STATUSES.includes(current.status as (typeof VOICE_MUTABLE_STATUSES)[number])) return { cancelled: false, needs_human: true, message: 'That appointment can no longer be changed automatically. I can connect you with the front desk.' };
  const policy = await getSchedulingPolicy(ctx.tenantId);
  if (policy.minNoticeHours > 0 && Date.now() > current.startsAt.getTime() - policy.minNoticeHours * 3_600_000) {
    return { cancelled: false, needs_human: true, message: `Cancellations require at least ${policy.minNoticeHours} hours notice. I can connect you with the front desk.` };
  }
  const reason = sanitizeText(args.reason, 240);
  const outcome = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-cancel:${ctx.tenantId}:${appointmentId}`})::bigint)`;
    const changed = await tx.appointment.updateMany({ where: { id: appointmentId, tenantId: ctx.tenantId, patientId, status: { in: [...VOICE_MUTABLE_STATUSES] }, deletedAt: null }, data: { status: 'CANCELED' } });
    if (changed.count !== 1) return null;
    const requirements = await tx.depositRequirement.findMany({ where: { tenantId: ctx.tenantId, appointmentId, status: { notIn: ['cancelled', 'waived'] } }, select: { id: true, status: true } });
    const needsManualRefund = requirements.some(row => row.status === 'collected');
    for (const requirement of requirements.filter(row => row.status !== 'collected')) {
      await tx.depositRequirement.update({ where: { id: requirement.id }, data: { status: 'cancelled' } });
      await tx.auditEvent.create({ data: { tenantId: ctx.tenantId, actorUserId: null, action: 'deposit.cancelled', resource: 'depositRequirement', resourceId: requirement.id, userAgent: 'retell-webhook', metadata: { appointmentId, source: 'verified_live_call' } } });
    }
    await tx.auditEvent.create({ data: { tenantId: ctx.tenantId, actorUserId: null, action: 'receptionist.appointment.cancelled', resource: 'appointment', resourceId: appointmentId, userAgent: 'retell-webhook', metadata: { reason, needsManualRefund, via: 'verified_live_call' } } });
    await tx.businessEvent.create({ data: { tenantId: ctx.tenantId, eventType: 'appointment.cancelled', entityType: 'appointment', entityId: appointmentId, sourceModule: 'receptionist', payload: { needsManualRefund } } });
    await tx.idempotencyKey.delete({ where: { scope_key: { scope: 'receptionist.voice-change-confirmation', key: pendingChangeKey(ctx, pending.token) } } });
    return { needsManualRefund };
  });
  if (!outcome) return { cancelled: false, needs_human: true, message: 'That appointment changed while we were speaking. I can connect you with the front desk.' };
  return { cancelled: true, appointment_id: appointmentId, needs_manual_refund: outcome.needsManualRefund, message: outcome.needsManualRefund ? 'The appointment is cancelled. A payment was previously collected, so staff must review any refund; I have not promised or issued one.' : 'Your appointment is cancelled.' };
}

/** Reschedule only the verified patient's own appointment into a canonical open slot. */
export async function rescheduleAppointment(ctx: ToolContext, args: Record<string, unknown>) {
  const patientId = await verifiedPatientForCall(ctx);
  const appointmentId = str(args.appointment_id, 40);
  if (!patientId || !appointmentId || !UUID_RE.test(appointmentId)) return { rescheduled: false, needs_human: true, message: 'I cannot securely identify that appointment. I can connect you with the front desk.' };
  const appt = await db.appointment.findFirst({ where: { id: appointmentId, tenantId: ctx.tenantId, patientId, deletedAt: null }, include: { branch: { select: { timezone: true } } } });
  if (!appt || !VOICE_MUTABLE_STATUSES.includes(appt.status as (typeof VOICE_MUTABLE_STATUSES)[number])) return { rescheduled: false, needs_human: true, message: 'That appointment cannot be changed automatically. I can connect you with the front desk.' };
  const date = str(args.appointment_date) ?? '';
  const time = str(args.appointment_time) ?? '';
  const pending = await loadPendingAppointmentChange(ctx, args, 'reschedule');
  if (!pending || pending.change.patientId !== patientId || pending.change.appointmentId !== appointmentId || pending.change.appointmentDate !== date || pending.change.appointmentTime !== time) {
    return { rescheduled: false, confirmation_required: true, message: 'I need to prepare this exact new time and receive your explicit confirmation before I can make the change.' };
  }
  const startsAt = parseSlot(date, time, appt.branch.timezone);
  if (!startsAt) return { rescheduled: false, message: 'I did not get a valid date and time. Please choose one of the times returned by availability.' };
  const policy = await getSchedulingPolicy(ctx.tenantId);
  const now = Date.now();
  if (!policy.selfBookEnabled || (policy.minNoticeHours > 0 && now > appt.startsAt.getTime() - policy.minNoticeHours * 3_600_000)) return { rescheduled: false, needs_human: true, message: 'This change requires the front desk.' };
  if (startsAt.getTime() < now + policy.minNoticeHours * 3_600_000 || startsAt.getTime() > now + policy.maxHorizonDays * 86_400_000) return { rescheduled: false, message: 'That time is outside the clinic scheduling window. Please choose another.' };
  const service = await resolveSchedulingService({ tenantId: ctx.tenantId, serviceCatalogItemId: appt.serviceCatalogItemId, service: appt.service, fallbackDurationMin: Math.max(5, Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / 60_000)) });
  if (!service || !appt.providerProfileId) return { rescheduled: false, needs_human: true, message: 'A staff member needs to confirm the service or provider for this change.' };
  const endsAt = new Date(startsAt.getTime() + service.durationMin * 60_000);
  try {
    const moved = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-reschedule:${ctx.tenantId}:${appointmentId}`})::bigint)`;
      const conflict = await findSlotConflict({ tenantId: ctx.tenantId, providerProfileId: appt.providerProfileId!, startsAt, durationMin: service.durationMin, excludeAppointmentId: appointmentId }, tx);
      if (conflict) return { conflict } as const;
      const changed = await tx.appointment.updateMany({ where: { id: appointmentId, tenantId: ctx.tenantId, patientId, status: appt.status, deletedAt: null }, data: { startsAt, endsAt, service: service.name, serviceCatalogItemId: service.id } });
      if (changed.count !== 1) return { conflict: 'already_booked' as const };
      await tx.auditEvent.create({ data: { tenantId: ctx.tenantId, actorUserId: null, action: 'receptionist.appointment.rescheduled', resource: 'appointment', resourceId: appointmentId, userAgent: 'retell-webhook', metadata: { startsAt: startsAt.toISOString(), via: 'verified_live_call' } } });
      await tx.businessEvent.create({ data: { tenantId: ctx.tenantId, eventType: 'appointment.rescheduled', entityType: 'appointment', entityId: appointmentId, sourceModule: 'receptionist', payload: { startsAt: startsAt.toISOString() } } });
      await tx.idempotencyKey.delete({ where: { scope_key: { scope: 'receptionist.voice-change-confirmation', key: pendingChangeKey(ctx, pending.token) } } });
      return { conflict: null } as const;
    });
    if (moved.conflict) return { rescheduled: false, conflict: moved.conflict, message: 'That time is no longer available. Please choose another.' };
  } catch (error) {
    if (isDoubleBookConflictError(error)) return { rescheduled: false, conflict: 'already_booked', message: 'That time was just taken. Please choose another.' };
    throw error;
  }
  const depositEvaluation = await evaluateDepositForAppointment(ctx.tenantId, appointmentId, { actorUserId: null }).catch(() => null);
  return {
    rescheduled: true,
    appointment_id: appointmentId,
    starts_at: startsAt.toISOString(),
    deposit_review_pending: depositEvaluation === null,
    message: `Your appointment is rescheduled to ${localAppointmentLabel(startsAt, appt.branch.timezone)}.${depositEvaluation === null ? ' Staff will review the deposit requirement separately.' : ''}`,
  };
}

/** Persist an immediate voice/ALL suppression before the agent ends the call. */
export async function recordDoNotCall(ctx: ToolContext, args: Record<string, unknown>) {
  void args;
  const phone = validPhone(ctx.callerPhone);
  const callId = sanitizeText(ctx.callId, 128);
  if (!phone || !callId) {
    return { recorded: false, needs_human: true, message: 'I cannot safely save that preference automatically. I will end outreach on this call and route it to the front desk.' };
  }
  const key = `${ctx.tenantId}:${callId}`;
  const result = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-dnc:${key}`})::bigint)`;
    const prior = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope: 'receptionist.voice-optout', key } }, select: { resultId: true } });
    if (prior?.resultId) return { id: prior.resultId, duplicate: true };
    const row = await tx.receptionistOptOut.create({
      data: { tenantId: ctx.tenantId, contactPhone: phone, channel: 'ALL', reason: 'Requested during AI call' },
      select: { id: true },
    });
    await tx.idempotencyKey.create({ data: { tenantId: ctx.tenantId, scope: 'receptionist.voice-optout', key, resultId: row.id } });
    await tx.auditEvent.create({ data: { tenantId: ctx.tenantId, action: 'receptionist.optout.recorded', resource: 'receptionistOptOut', resourceId: row.id, metadata: { channel: 'ALL', source: 'retell_live_call' } } });
    return { id: row.id, duplicate: false };
  });
  return { recorded: true, duplicate: result.duplicate, opt_out_id: result.id, message: 'I recorded your request. We will not make further outreach calls to this number.' };
}

/** check_availability(appointment_date) → real open slots for the branch. */
export async function checkAvailability(ctx: ToolContext, args: Record<string, unknown>) {
  const branch = await resolveBranch(ctx.tenantId);
  const date = str(args.appointment_date) ?? '';
  if (!branch) return { available: false, needs_review: true, slots: [], message: "I need a team member to confirm which clinic location you want before I offer a time." };
  const providerProfileId = await resolveSoleProvider(ctx.tenantId, branch.id);
  const requestedService = sanitizeText(args.service, MAX_SERVICE) ?? 'Consultation';
  const service = await resolveSchedulingService({ tenantId: ctx.tenantId, service: requestedService, fallbackDurationMin: SLOT_MIN });
  if (!providerProfileId || !service) {
    await auditLive(ctx.tenantId, 'receptionist.availability.needsReview', branch.id, { reason: !providerProfileId ? 'provider_ambiguous' : 'service_ambiguous' });
    return { available: false, needs_review: true, slots: [], message: "I need a team member to confirm the provider or service before I offer a time." };
  }
  const slots = await getOpenSlots(ctx.tenantId, branch.id, date, service.durationMin, 6, providerProfileId);
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
  const startsAt = parseSlot(date, time, branch.timezone);
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

  // Linking an appointment to an existing chart is a protected patient-specific
  // action. Require server-side verification for this exact provider call;
  // proxy/minor and ambiguous-record cases always go to a human workflow.
  const existingPatients = phone ? await patientsByCanonicalPhone(ctx.tenantId, phone) : [];
  let verifiedExistingPatientId: string | null = null;
  if (existingPatients.length > 0) {
    const callId = sanitizeText(ctx.callId, 128);
    const proof = callId
      ? await db.idempotencyKey.findUnique({ where: { scope_key: { scope: 'receptionist.voice-identity', key: `${ctx.tenantId}:${callId}` } }, select: { resultId: true } })
      : null;
    if (!proof?.resultId || !existingPatients.some(patient => patient.id === proof.resultId)) {
      return routeToReview(ctx, branch.id, {
        firstName, lastName, phone, service, args: cleanArgs, missingFields: ['identityVerification'],
        reason: existingPatients.length > 1 ? 'Patient identity is ambiguous' : 'Existing patient identity was not verified for this call',
        speak: 'Before I make a change linked to an existing patient record, I need to verify identity or have the front desk help.',
      });
    }
    verifiedExistingPatientId = proof.resultId;
  }

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

  const providerProfileId = await resolveSoleProvider(ctx.tenantId, branch.id);
  const schedulingService = await resolveSchedulingService({ tenantId: ctx.tenantId, service, fallbackDurationMin: SLOT_MIN });
  if (!providerProfileId || !schedulingService) {
    return routeToReview(ctx, branch.id, {
      firstName, lastName, phone, service, args: cleanArgs, missingFields: [!providerProfileId ? 'preferredProvider' : 'preferredService'],
      reason: !providerProfileId ? 'Provider selection is ambiguous' : `Requested service is not in the clinic catalog: ${service}`,
      speak: `Let me have someone confirm the provider and availability for ${service} and call you right back.`,
    });
  }

  // Same-call idempotency — the same call booking the same slot only books once.
  // The claim is written in the SAME transaction as the canonical Appointment
  // and stores its id. A replay may only report success after re-reading that
  // Appointment; a stale/failed claim can never produce a false confirmation.
  const idemKey = `${ctx.callId ?? 'nocall'}:${branch.id}:${startsAt.toISOString()}`;

  // Slot-check + create inside ONE transaction, serialized by a slot-scoped
  // advisory lock so two concurrent callers can never both take the same slot.
  // The in-transaction isSlotOpen reads the shared Appointment table (branch +
  // BLOCKING status), so an appointment booked by ANY path (scheduling, portal,
  // staff) blocks the live agent from the same slot too.
  // Unambiguous single-provider branch → link the provider so this booking joins
  // the cross-path exclusion-constraint guard (defense in depth over the
  // branch-level advisory lock below).
  const lockKey = `receptionist-book:${ctx.tenantId}:${branch.id}:${startsAt.toISOString()}`;
  let booked: { apptId: string; patientId: string; reqId: string; duplicate?: boolean } | null;
  try {
    booked = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

      const priorClaim = await tx.idempotencyKey.findUnique({
        where: { scope_key: { scope: 'receptionist.live-booking', key: idemKey } },
        select: { id: true, resultId: true },
      });
      if (priorClaim?.resultId) {
        const priorAppointment = await tx.appointment.findFirst({
          where: {
            id: priorClaim.resultId,
            tenantId: ctx.tenantId,
            branchId: branch.id,
            deletedAt: null,
            status: { in: ['CONFIRMED', 'RISKY', 'ARRIVED', 'COMPLETED', 'WAITLIST'] },
          },
          select: { id: true, patientId: true },
        });
        if (priorAppointment) {
          const priorRequest = await tx.appointmentRequest.findFirst({
            where: { tenantId: ctx.tenantId, bookedAppointmentId: priorAppointment.id },
            select: { id: true },
          });
          return {
            apptId: priorAppointment.id,
            patientId: priorAppointment.patientId,
            reqId: priorRequest?.id ?? '',
            duplicate: true,
          };
        }
      }
      // Clean up a legacy or rolled-forward claim that has no live canonical
      // Appointment. This is safe under the slot lock and lets a real retry run.
      if (priorClaim) await tx.idempotencyKey.delete({ where: { id: priorClaim.id } });

      if (!(await isSlotOpen(ctx.tenantId, branch.id, startsAt, schedulingService.durationMin, tx, providerProfileId))) return null;

      let patient = verifiedExistingPatientId
        ? await tx.patient.findFirst({ where: { id: verifiedExistingPatientId, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } })
        : null;
      if (!patient) {
        patient = await tx.patient.create({ data: { tenantId: ctx.tenantId, branchId: branch.id, firstName, lastName, phone, lifecycleStage: 'NEW' }, select: { id: true } });
      }
      const endsAt = new Date(startsAt.getTime() + schedulingService.durationMin * 60_000);
      const appt = await tx.appointment.create({
        data: { tenantId: ctx.tenantId, branchId: branch.id, patientId: patient.id, providerProfileId, providerRef: providerProfileId, service: schedulingService.name, serviceCatalogItemId: schedulingService.id, startsAt, endsAt, status: 'CONFIRMED', channel: 'CALL' },
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
      await tx.idempotencyKey.create({
        data: { tenantId: ctx.tenantId, scope: 'receptionist.live-booking', key: idemKey, resultId: appt.id },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: null,
          action: 'receptionist.appointment.booked',
          resource: 'appointment',
          resourceId: appt.id,
          userAgent: 'retell-webhook',
          metadata: { branchId: branch.id, appointmentRequestId: reqRow.id, via: 'live_call' },
        },
      });
      await tx.businessEvent.create({
        data: {
          tenantId: ctx.tenantId,
          eventType: 'receptionist.appointmentRequest.created',
          entityType: 'appointmentRequest',
          entityId: reqRow.id,
          sourceModule: 'receptionist',
          payload: { status: 'BOOKED', live: true },
        },
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

  if (booked.duplicate) {
    return {
      booked: true,
      duplicate: true,
      appointment_id: booked.apptId,
      message: `You're already set for ${speakTime(time)} on ${date}.`,
    };
  }

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
  if (name === 'record_recording_preference') {
    const decision = str(args.recording_decision)?.toUpperCase();
    if (!ctx.callId || !['GRANTED', 'REFUSED', 'WITHDRAWN'].includes(decision ?? '')) {
      return { recorded: false, message: 'I could not record that preference. I will keep this call metadata-only and connect you with staff.' };
    }
    const call = await db.receptionistCallLog.findFirst({
      where: { tenantId: ctx.tenantId, retellCallId: ctx.callId },
      select: {
        id: true,
        recordingConsentStatus: true,
        clinic: { select: { id: true, name: true, complianceDisclosure: true } },
        campaign: { select: { agent: { select: { name: true } } } },
      },
    });
    if (!call?.clinic) return { recorded: false, message: 'I could not bind that preference to the exact clinic disclosure. I will keep this call metadata-only and connect you with staff.' };
    if (decision === 'GRANTED' && ['REFUSED', 'WITHDRAWN'].includes(call.recordingConsentStatus)) {
      return {
        recorded: false,
        decision: call.recordingConsentStatus,
        metadata_only: true,
        message: 'Your earlier refusal or withdrawal remains in effect for this call. I will keep it metadata-only and can connect you with staff.',
      };
    }
    const configuredAgents = call.campaign?.agent
      ? [call.campaign.agent]
      : await db.receptionistAgent.findMany({ where: { tenantId: ctx.tenantId, clinicId: call.clinic.id, active: true }, select: { name: true }, take: 2 });
    if (configuredAgents.length !== 1) {
      return { recorded: false, message: 'I could not bind that preference to one configured receptionist disclosure. I will keep this call metadata-only and connect you with staff.' };
    }
    const disclosureText = renderRecordingDisclosure({
      agentName: configuredAgents[0].name,
      clinicName: call.clinic.name,
      clinicDisclosure: call.clinic.complianceDisclosure,
    });
    let restriction = null;
    if (decision !== 'GRANTED') restriction = await restrictCallToBasicAttributes(ctx.callId);
    await recordRecordingConsent({
      tenantId: ctx.tenantId,
      callLogId: call.id,
      decision: decision as 'GRANTED' | 'REFUSED' | 'WITHDRAWN',
      disclosureTextHash: disclosureEvidenceHash(disclosureText),
      jurisdiction: str(args.jurisdiction, 80),
      source: 'retell_signed_consent_tool',
      auditMetadata: {
        decision,
        clinicId: call.clinic.id,
        providerRestrictionApplied: restriction?.applied ?? false,
        providerRestrictionOk: restriction?.ok ?? true,
      },
    });
    return {
      recorded: true,
      decision,
      metadata_only: true,
      message: decision === 'GRANTED'
        ? 'Thank you. Your preference is recorded. This pilot remains metadata-only unless the approved retention workflow applies.'
        : 'Your preference is recorded. I will not retain call recording or transcript artifacts. I can connect you with staff instead.',
    };
  }
  if (name === 'verify_patient_identity') return verifyPatientIdentity(ctx, args);
  if (name === 'list_upcoming_appointments') return listUpcomingAppointments(ctx);
  if (name === 'prepare_appointment_change') return prepareAppointmentChange(ctx, args);
  if (name === 'cancel_appointment') return cancelAppointment(ctx, args);
  if (name === 'reschedule_appointment') return rescheduleAppointment(ctx, args);
  if (name === 'record_do_not_call') return recordDoNotCall(ctx, args);
  if (name === 'check_availability') return checkAvailability(ctx, args);
  if (name === 'book_appointment') return bookAppointment(ctx, args);
  if (name === 'request_human_handoff') return requestHumanHandoff(ctx, args);
  if (name === 'take_message') return takeMessage(ctx, args);
  if (name === 'report_emergency') return reportEmergency(ctx, args);
  return { error: 'unknown_function', message: "I'm not able to help with that just yet." };
}
