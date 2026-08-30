import { db } from '../db';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { toE164, isValidE164 } from '../campaigns';
import { getOpenSlots, parseSlot, speakTime, SLOT_MIN } from './availability';
import { findSlotConflict, getSchedulingPolicy, isDoubleBookConflictError, resolveSchedulingService, unmetPreVisitRequirements } from '../scheduling';
import { evaluateDepositForAppointment } from '../deposits';
import {
  bookAppointmentToolFingerprint,
  fingerprintJson,
  MAX_INTAKE_FIELDS,
  normalizeBookAppointmentToolContract,
  type IntakeContractSnapshot,
} from '../../modules/receptionist/intakeContract';
import {
  disclosureEvidenceHash,
  recordRecordingConsent,
  renderRecordingDisclosure,
} from './privacyLifecycle';
import { restrictCallToBasicAttributes } from '../retell';
import { transferReadiness } from './transferReadiness';
import { CONFIRMATION_OUTBOX_SOURCE, processAppointmentConfirmations } from './confirmationOutbox';
import { lockDncDestinationFence } from './dncFence';
import { createSafetyTask } from './frontDeskTask';
import { resolveCallLocalePack, resolvedLocaleFormat, type ResolvedLocalePack } from './localePacks/resolve';
import { renderPackMessage } from './localePacks/render';
import { EMERGENCY_FALLBACK_NUMBER_FREE } from './localePacks/defaults';
import { loadHoursSource } from './hoursSource';
import { hoursConfigured, resolveEffectiveHours, spokenDate } from './clinicHours';
import type { LocaleFormat, LocalePackMessageKey } from './localePacks/types';

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

export interface TrustedBookingContext {
  callLogId: string;
  campaignId: string;
  clinicId: string;
  locationId: string | null;
  branchId: string | null;
  branchTimezone: string | null;
  observedPhone: string | null;
  providerAgentId: string;
  providerAgentVersion: number;
  intakeSnapshot: IntakeContractSnapshot;
}

export interface ToolContext {
  tenantId: string;
  callId: string | null;
  callerPhone?: string | null;
  trustedBooking?: TrustedBookingContext;
  /** Exact local agent established from the signed inbound deployment. */
  trustedProviderAgentId?: string;
  /** Provider-native stable custom-function invocation identifier. */
  providerInvocationId?: string;
}

// Bounded caps for caller-supplied free text.
const MAX_NAME = 80;
const MAX_SHORT = 40;
const MAX_IDENTITY_ATTEMPTS = 3;
const IDENTITY_LOCK_MINUTES = 15;
const CHANGE_CONFIRMATION_TTL_MS = 5 * 60_000;
const RECEPTIONIST_CALL_LEASE_MS = 4 * 60 * 60_000;
const MAX_CANONICAL_ANSWER_BYTES = 16 * 1024;
const MAX_BOOKING_SCHEMA_PROPERTIES = 57;
const APPOINTMENT_NOTIFICATION_PREFERENCE_POLICY = 'appointment-notification-preference-v1';
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

// Live booking requires an unambiguous provider. Ambiguity is routed to staff;
// provider-null appointments would bypass the canonical capacity guard.
async function resolveSoleProvider(tenantId: string, branchId: string): Promise<string | null> {
  const providers = await db.providerProfile.findMany({ where: { tenantId, branchId, active: true }, select: { id: true }, take: 2 });
  return providers.length === 1 ? providers[0].id : null;
}

async function patientsByCanonicalPhone(
  tenantId: string,
  phone: string,
  client: typeof db | Prisma.TransactionClient = db,
): Promise<Array<{ id: string; dateOfBirth: Date | null }>> {
  return client.$queryRaw<Array<{ id: string; dateOfBirth: Date | null }>>`
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
function speakList(times: string[], locale?: LocaleFormat | null): string {
  const labels = times.map(time => speakTime(time, locale));
  if (labels.length <= 2) return labels.join(' or ');
  return `${labels.slice(0, -1).join(', ')}, or ${labels.slice(-1)}`;
}

/** The call's approved locale pack, or null when none can be resolved. */
async function callPack(ctx: ToolContext): Promise<ResolvedLocalePack | null> {
  return resolveCallLocalePack(db, { tenantId: ctx.tenantId, callId: ctx.callId, trustedProviderAgentId: ctx.trustedProviderAgentId });
}

/**
 * Render one caller-facing line from the call's pack.
 *
 * `fallback` is the pre-C10 en-US wording and is reached only when no pack and
 * no country could be resolved for the call at all. A key merely absent from an
 * older approved pack is filled by resolve.ts from the platform default, so the
 * fallback is a last resort, not the normal path. It exists because the one
 * thing worse than US phrasing on a GB call is a thrown renderer, which reaches
 * the caller as silence.
 */
function speak(
  pack: ResolvedLocalePack | null,
  key: LocalePackMessageKey,
  vars: Record<string, string>,
  fallback: string,
): string {
  if (!pack) return fallback;
  try {
    return renderPackMessage(pack.strings, key, vars);
  } catch {
    return fallback;
  }
}

type ContractValidation =
  | { ok: true; answers: Prisma.InputJsonObject }
  | { ok: false; answers: Prisma.InputJsonObject | null; issues: string[] };

function jsonScalarEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stringFormatValid(format: unknown, value: string): boolean {
  if (format === undefined) return true;
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === 'date') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const probe = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return probe.toISOString().slice(0, 10) === value;
  }
  if (format === 'time') return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value);
  if (format === 'date-time') return !Number.isNaN(new Date(value).getTime());
  return false;
}

const COMPILER_OWNED_BOOKING_PATTERNS = new Set([
  '^\\+[1-9]\\d{7,14}$',
  '^\\d{4}-\\d{2}-\\d{2}$',
  '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
]);

function validateContractProperty(key: string, value: unknown, schemaValue: unknown): string[] {
  if (!schemaValue || typeof schemaValue !== 'object' || Array.isArray(schemaValue)) return [`${key}:invalid_schema`];
  const schema = schemaValue as Record<string, unknown>;
  const issues: string[] = [];
  const allowedKeywords = new Set(['type', 'description', 'minLength', 'maxLength', 'pattern', 'readOnly', 'format', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']);
  if (Object.keys(schema).some(keyword => !allowedKeywords.has(keyword))) issues.push(`${key}:unsupported_schema_keyword`);
  const type = schema.type;
  const typeMatches = type === 'string' ? typeof value === 'string'
    : type === 'boolean' ? typeof value === 'boolean'
      : type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
        : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : type === 'null' ? value === null
            : false;
  if (!typeMatches) return [`${key}:wrong_type`];
  if ('const' in schema && !jsonScalarEqual(value, schema.const)) issues.push(`${key}:const`);
  if (Array.isArray(schema.enum) && !schema.enum.some(item => jsonScalarEqual(item, value))) issues.push(`${key}:enum`);
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) issues.push(`${key}:minLength`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) issues.push(`${key}:maxLength`);
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== 'string' || !COMPILER_OWNED_BOOKING_PATTERNS.has(schema.pattern)) issues.push(`${key}:invalid_pattern`);
      else {
        try { if (!new RegExp(schema.pattern, 'u').test(value)) issues.push(`${key}:pattern`); }
        catch { issues.push(`${key}:invalid_pattern`); }
      }
    }
    if (!stringFormatValid(schema.format, value)) issues.push(`${key}:format`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${key}:minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${key}:maximum`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) issues.push(`${key}:exclusiveMinimum`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) issues.push(`${key}:exclusiveMaximum`);
  }
  return issues;
}

function boundedCanonicalObject(value: Record<string, unknown>): Prisma.InputJsonObject | null {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const canonical = Object.fromEntries(entries) as Prisma.InputJsonObject;
  try {
    return Buffer.byteLength(JSON.stringify(canonical), 'utf8') <= MAX_CANONICAL_ANSWER_BYTES ? canonical : null;
  } catch {
    return null;
  }
}

function validateAttestedBookingArgs(snapshot: IntakeContractSnapshot, args: Record<string, unknown>): ContractValidation {
  const issues: string[] = [];
  if (!Array.isArray(snapshot.fields) || snapshot.fields.length > MAX_INTAKE_FIELDS) issues.push('contract:configured_field_limit');
  const normalizedTool = normalizeBookAppointmentToolContract(snapshot.bookAppointmentToolContract);
  if (!normalizedTool || bookAppointmentToolFingerprint(normalizedTool) !== snapshot.bookAppointmentToolFingerprint) {
    issues.push('contract:fingerprint');
  }
  const parameters = normalizedTool?.parameters as Record<string, unknown> | undefined;
  const properties = parameters?.properties && typeof parameters.properties === 'object' && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : null;
  if (!properties || parameters?.type !== 'object' || parameters.additionalProperties !== false) issues.push('contract:root_schema');
  if (parameters && Object.keys(parameters).some(keyword => !['type', 'additionalProperties', 'properties', 'required'].includes(keyword))) issues.push('contract:unsupported_root_keyword');
  if (properties && Object.keys(properties).length > MAX_BOOKING_SCHEMA_PROPERTIES) issues.push('contract:property_limit');
  const required = Array.isArray(parameters?.required) && parameters.required.every(item => typeof item === 'string')
    ? parameters.required as string[]
    : null;
  if (!required) issues.push('contract:required_schema');

  const recognizedValid: Record<string, unknown> = {};
  if (properties && required) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(args)) if (!allowed.has(key)) issues.push(`${key}:unknown`);
    for (const key of required) if (!(key in args)) issues.push(`${key}:missing`);
    for (const [key, value] of Object.entries(args)) {
      if (allowed.has(key)) {
        const propertyIssues = validateContractProperty(key, value, properties[key]);
        issues.push(...propertyIssues);
        if (!propertyIssues.length && (value === null || ['string', 'number', 'boolean'].includes(typeof value))) recognizedValid[key] = value;
      }
    }
    if (!required.includes('booking_confirmed') || args.booking_confirmed !== true) issues.push('booking_confirmed:required');
    for (const field of snapshot.fields ?? []) {
      if (field.fieldType !== 'PHONE' && !allowed.has(field.key)) issues.push(`${field.key}:missing_schema`);
      if (field.confirmationRequired) {
        const confirmationKey = `${field.key}_confirmed`;
        if (!allowed.has(confirmationKey) || !required.includes(confirmationKey) || args[confirmationKey] !== true) {
          issues.push(`${confirmationKey}:required`);
        }
      }
    }
  }
  const answers = boundedCanonicalObject(recognizedValid);
  if (!answers) issues.push('answers:maximum_bytes');
  return issues.length ? { ok: false, answers, issues: [...new Set(issues)].sort() } : { ok: true, answers: answers! };
}

// The receptionist StaffTask contract lives in frontDeskTask.ts (C4-pre): one
// metadata schema, one writer. The three live tools below only shape the spoken
// result; `createSafetyTask` resolves branch/call/patient, appends a second
// message on the same live call, and files the audit/business events.
export { createSafetyTask } from './frontDeskTask';

/**
 * Records an acknowledgment-required handoff before Retell attempts transfer.
 *
 * C12: this is the "I want a human" turn, and one of the two moments a
 * receptionist is judged on. Everything durable — that a task exists, that no
 * human has acknowledged it, that no transfer has happened — stays in the
 * structured fields below, where the front desk and the audit trail read it.
 * The caller hears one sentence, from the pack, and never our queue mechanics.
 */
export async function requestHumanHandoff(ctx: ToolContext, args: Record<string, unknown>) {
  const task = await createSafetyTask(ctx, 'human_handoff', args);
  const [pack, transfer] = await Promise.all([callPack(ctx), callTransferReadiness(ctx)]);
  return {
    handoff_recorded: true,
    // Structured evidence. `message` never restates any of it.
    staff_acknowledged: false,
    transfer_attempted: false,
    transfer_completed: false,
    transfer_available: transfer.ready,
    queue: 'front_desk',
    duplicate: task.duplicate,
    appended: task.appended,
    task_id: task.taskId,
    message: transfer.ready
      ? speak(pack, 'handoff.spoken', {}, "Of course. I've passed this to the front desk with your number, so it won't be lost. Let me see if someone is free to pick up now.")
      : speak(pack, 'handoff.no_transfer', {}, "Of course. I've passed this to the front desk with your number, so it won't be lost, and someone will get back to you. Is there anything you'd like me to add for them?"),
  };
}

/**
 * Can this call actually be handed to a person? The same predicate the prompt
 * and buildRetellConfig use, so the spoken line can never promise a transfer
 * the configuration cannot perform.
 */
async function callTransferReadiness(ctx: ToolContext): Promise<{ ready: boolean }> {
  if (!ctx.callId) return { ready: false };
  const call = await db.receptionistCallLog.findFirst({
    where: { tenantId: ctx.tenantId, retellCallId: ctx.callId },
    select: { clinic: { select: { humanFallbackNumber: true, phone: true, locations: { select: { phone: true } } } } },
  });
  if (!call?.clinic) return { ready: false };
  return { ready: transferReadiness(call.clinic, { inboundLineNumbers: call.clinic.locations.map(location => location.phone) }).ready };
}

/** Persists a bounded callback message as a staff task with explicit acknowledgment status. */
export async function takeMessage(ctx: ToolContext, args: Record<string, unknown>) {
  const task = await createSafetyTask(ctx, 'message', args);
  const pack = await callPack(ctx);
  return {
    // True only when a task was created or a message appended on this call.
    message_recorded: !task.duplicate,
    acknowledgment_pending: true,
    duplicate: task.duplicate,
    appended: task.appended,
    task_id: task.taskId,
    message: task.appended
      ? speak(pack, 'tool.message.appended', {}, "Thank you. I've added that to the same note for the front desk. Someone will pick it up and get back to you; I can't promise exactly when.")
      : speak(pack, 'tool.message.recorded', {}, "Thank you. That's written down for the front desk with your number. Someone will pick it up and get back to you; I can't promise exactly when."),
  };
}

/** Creates a critical staff signal without delaying immediate emergency advice. */
export async function reportEmergency(ctx: ToolContext, args: Record<string, unknown>) {
  const task = await createSafetyTask(ctx, 'emergency', args);
  // The emergency number is jurisdictional: it comes from the call's approved
  // locale pack. With no pack (and no country to fall back on) the agent says
  // the number-free sentence rather than naming the wrong country's number.
  const pack = await callPack(ctx);
  const message = pack
    ? renderPackMessage(pack.strings, 'tool.emergency.message', { emergency_number: pack.strings.emergencyNumber })
    : EMERGENCY_FALLBACK_NUMBER_FREE;
  return {
    emergency_recorded: true,
    protocol_status: 'pending_provider_evidence',
    acknowledgment_pending: true,
    duplicate: task.duplicate,
    appended: task.appended,
    task_id: task.taskId,
    message,
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
  const invocationId = sanitizeText(ctx.providerInvocationId, 180);
  if (!invocationId) {
    const handoff = await createSafetyTask(ctx, 'human_handoff', { reason_category: 'identity_replay_boundary' });
    return { verified: false, needs_human: true, manual_review: true, task_id: handoff.taskId, duplicate: handoff.duplicate,
      message: 'I cannot complete secure verification on this call. I can connect you with the front desk.' };
  }
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'identity:' + ctx.tenantId + ':' + callId})::bigint)`;
    const receiptKey = `${ctx.tenantId}:${callId}:${invocationId}`;
    const prior = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope: 'receptionist.voice-identity-attempt', key: receiptKey } } });
    if (prior?.resultId) return JSON.parse(prior.resultId) as Record<string, unknown>;
    const since = new Date(Date.now() - IDENTITY_LOCK_MINUTES * 60_000);
    const failedAttempts = await tx.auditEvent.count({ where: { tenantId: ctx.tenantId, action: 'receptionist.identity.failed', resource: 'receptionistCall', resourceId: callId, occurredAt: { gte: since } } });
    let result: Record<string, unknown>;
    if (failedAttempts >= MAX_IDENTITY_ATTEMPTS) {
      const locked = await tx.auditEvent.count({ where: { tenantId: ctx.tenantId, action: 'receptionist.identity.locked', resourceId: callId, occurredAt: { gte: since } } });
      if (!locked) await tx.auditEvent.create({ data: { tenantId: ctx.tenantId, action: 'receptionist.identity.locked', resource: 'receptionistCall', resourceId: callId, metadata: { lockMinutes: IDENTITY_LOCK_MINUTES } } });
      result = { verified: false, locked: true, needs_human: true, message: 'I cannot continue identity verification on this call. Please contact the front desk.' };
    } else {
      const matches = (await patientsByCanonicalPhone(ctx.tenantId, phone, tx)).filter(patient => patient.dateOfBirth?.toISOString().slice(0, 10) === dobText);
      if (matches.length !== 1) {
        await tx.auditEvent.create({ data: { tenantId: ctx.tenantId, action: 'receptionist.identity.failed', resource: 'receptionistCall', resourceId: callId, metadata: { attempt: failedAttempts + 1 } } });
        result = { verified: false, remaining_attempts: Math.max(0, MAX_IDENTITY_ATTEMPTS - failedAttempts - 1), message: 'I could not verify those details. Please try again or ask for the front desk.' };
      } else {
        await tx.idempotencyKey.upsert({ where: { scope_key: { scope: 'receptionist.voice-identity', key: `${ctx.tenantId}:${callId}` } }, update: { resultId: matches[0].id }, create: { tenantId: ctx.tenantId, scope: 'receptionist.voice-identity', key: `${ctx.tenantId}:${callId}`, resultId: matches[0].id } });
        await tx.auditEvent.create({ data: { tenantId: ctx.tenantId, action: 'receptionist.identity.verified', resource: 'receptionistCall', resourceId: callId, metadata: { method: 'caller_number_plus_dob' } } });
        result = { verified: true, message: 'Thank you. Your identity is verified for this call.' };
      }
    }
    await tx.idempotencyKey.create({ data: { tenantId: ctx.tenantId, scope: 'receptionist.voice-identity-attempt', key: receiptKey, resultId: JSON.stringify(result) } });
    return result;
  });
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

function localAppointmentLabel(startsAt: Date, timezone: string, locale?: LocaleFormat | null): string {
  return new Intl.DateTimeFormat(locale?.language ?? 'en-US', {
    timeZone: timezone,
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
    ...(locale ? { hour12: locale.timeStyle === '12h' } : {}),
  }).format(startsAt);
}

/** The call's LocaleFormat, or null when no pack can be resolved. */
async function callLocaleFormat(ctx: ToolContext): Promise<LocaleFormat | null> {
  const pack = await callPack(ctx);
  return pack ? resolvedLocaleFormat(pack, pack.language) : null;
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
  const locale = await callLocaleFormat(ctx);
  const appointments = rows.map(row => ({ appointment_id: row.id, service: row.service, starts_at: row.startsAt.toISOString(), spoken_time: localAppointmentLabel(row.startsAt, row.branch.timezone, locale) }));
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
    spokenChange = `reschedule it to ${localAppointmentLabel(startsAt, appt.branch.timezone, await callLocaleFormat(ctx))}`;
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
    message: `Your appointment is rescheduled to ${localAppointmentLabel(startsAt, appt.branch.timezone, await callLocaleFormat(ctx))}.${depositEvaluation === null ? ' Staff will review the deposit requirement separately.' : ''}`,
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
    await lockDncDestinationFence(tx, ctx.tenantId, [phone]);
    const prior = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope: 'receptionist.voice-optout', key } }, select: { resultId: true } });
    if (prior?.resultId) return { id: prior.resultId, duplicate: true };
    const row = await tx.receptionistOptOut.create({
      data: { tenantId: ctx.tenantId, contactPhone: phone, channel: 'ALL', reason: 'Requested during AI call' },
      select: { id: true },
    });
    await tx.idempotencyKey.create({ data: { tenantId: ctx.tenantId, scope: 'receptionist.voice-optout', key, resultId: row.id } });
    await tx.auditEvent.create({ data: { tenantId: ctx.tenantId, action: 'receptionist.optout.recorded', resource: 'receptionistOptOut', resourceId: row.id, metadata: { channel: 'ALL', source: 'retell_live_call' } } });
    await tx.businessEvent.create({ data: {
      tenantId: ctx.tenantId, eventType: 'receptionist.dnc.activated', entityType: 'receptionistOptOut',
      entityId: row.id, sourceModule: 'receptionist', payload: { channel: 'ALL', source: 'retell_live_call' },
    } });
    return { id: row.id, duplicate: false };
  });
  return { recorded: true, duplicate: result.duplicate, opt_out_id: result.id, message: 'I recorded your request. We will not make further outreach calls to this number.' };
}

/** check_availability(appointment_date) → real open slots for the branch. */
export async function checkAvailability(ctx: ToolContext, args: Record<string, unknown>) {
  const trusted = ctx.trustedBooking;
  const date = str(args.appointment_date) ?? '';
  if (!trusted?.locationId || !trusted.branchId || !trusted.branchTimezone) {
    return { available: false, needs_review: true, slots: [], message: "I need a team member to confirm which attested clinic location you want before I offer a time." };
  }
  const authority = await db.receptionistLocation.findFirst({
    where: {
      id: trusted.locationId, tenantId: ctx.tenantId, clinicId: trusted.clinicId,
      branchId: trusted.branchId, active: true, branch: { active: true, timezone: trusted.branchTimezone },
      clinic: { campaigns: { some: { id: trusted.campaignId, status: 'ACTIVE' } } },
    },
    select: { id: true },
  });
  if (!authority || !trusted.intakeSnapshot.eligibleLocationIds.includes(trusted.locationId)) {
    return { available: false, needs_review: true, slots: [], message: "I cannot verify this location against the active booking campaign." };
  }
  const providerProfileId = await resolveSoleProvider(ctx.tenantId, trusted.branchId);
  const requestedService = trusted.intakeSnapshot.appointmentType;
  const service = await resolveSchedulingService({ tenantId: ctx.tenantId, service: requestedService, fallbackDurationMin: SLOT_MIN });
  if (!providerProfileId || !service) {
    await auditLive(ctx.tenantId, 'receptionist.availability.needsReview', trusted.branchId, { reason: !providerProfileId ? 'provider_ambiguous' : 'service_ambiguous' });
    return {
      available: false, needs_review: true, slots: [],
      // Which of the two is ambiguous is staff evidence, and it is already in
      // the audit row above. The caller hears why they cannot be given a time
      // and what happens instead.
      review_reason: !providerProfileId ? 'provider_ambiguous' : 'service_ambiguous',
      message: speak(await callPack(ctx), 'tool.availability.needs_review', {}, "I can't confirm the right clinician for that on this call. I can take a message so the front desk can call you back with times."),
    };
  }
  const policy = await getSchedulingPolicy(ctx.tenantId);
  if (!policy.selfBookEnabled) return { available: false, needs_review: true, slots: [], message: 'This clinic requires staff review before offering self-booking times.' };

  // The clinic's own hours and closures decide whether that date is offerable
  // at all. Provider availability alone would happily offer a slot on a day
  // the practice is shut.
  const bundle = await loadHoursSource(db, { tenantId: ctx.tenantId, clinicId: trusted.clinicId });
  const locationSource = bundle?.locations.find(location => location.id === trusted.locationId)?.source ?? bundle?.source ?? null;
  const pack = await callPack(ctx);
  const locale = pack ? resolvedLocaleFormat(pack, pack.language) : null;
  // One spoken form of the date for every branch below. The ISO string is the
  // machine's word for a day, never the caller's.
  const spokenDay = locale && /^\d{4}-\d{2}-\d{2}$/.test(date) ? spokenDate(date, locale) : date;
  if (locationSource && hoursConfigured(locationSource) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const day = resolveEffectiveHours(locationSource, date);
    if (!day.open) {
      const clinicName = bundle?.clinic.name ?? 'the practice';
      const message = pack
        ? day.closure
          ? renderPackMessage(pack.strings, 'tool.availability.closed_reason', { clinic_name: clinicName, date: spokenDay, closure_reason: day.closure.reason })
          : renderPackMessage(pack.strings, 'tool.availability.closed', { clinic_name: clinicName, date: spokenDay })
        : `${clinicName} is closed on ${spokenDay}. Would a different day work?`;
      await auditLive(ctx.tenantId, 'receptionist.availability.closed', trusted.branchId, { date, closureId: day.closure?.id ?? null });
      return { available: false, reason: 'clinic_closed', slots: [], message };
    }
  }

  const slots = (await getOpenSlots(ctx.tenantId, trusted.branchId, date, service.durationMin, 6, providerProfileId))
    .filter(slot => {
      const startsAt = parseSlot(date, slot.time, trusted.branchTimezone!);
      return startsAt && startsAt.getTime() >= Date.now() + policy.minNoticeHours * 3_600_000
        && startsAt.getTime() <= Date.now() + policy.maxHorizonDays * 86_400_000;
    });
  await auditLive(ctx.tenantId, 'receptionist.availability.checked', trusted.branchId, { date, count: slots.length, campaignId: trusted.campaignId });
  if (slots.length === 0) {
    return {
      available: false, slots: [],
      message: speak(pack, 'tool.availability.none', { date: spokenDay }, `I don't have any openings on ${spokenDay}. Would a different day work?`),
    };
  }
  const times = speakList(slots.map(slot => slot.time), locale);
  return {
    available: true,
    slots: slots.map(slot => ({ time: slot.time, label: speakTime(slot.time, locale) })),
    message: speak(pack, 'tool.availability.offer', { date: spokenDay, times }, `On ${spokenDay} I have ${times}. Which works best for you?`),
  };
}

type BookingTransactionResult =
  | { kind: 'booked'; tenantId: string; appointmentId: string; requestId: string; patientId: string; firstName: string; email: string | null; phone: string | null; service: string; startsAt: Date; timezone: string; locationName: string; locationAddress: string | null; providerName: string | null; smsEnabled: boolean; emailEnabled: boolean; messagingConsent: boolean | null; duplicate: boolean }
  | { kind: 'review'; requestId: string; duplicate: boolean; message: string }
  | { kind: 'rejected'; message: string };

/** book_appointment(...) → exact attestation validation + one call-scoped outcome. */
export async function bookAppointment(ctx: ToolContext, args: Record<string, unknown>) {
  const trusted = ctx.trustedBooking;
  if (!trusted || !ctx.callId || trusted.callLogId.length === 0) {
    return { booked: false, needs_human: true, message: 'I cannot bind this request to the exact active call and booking configuration. Please contact the front desk.' };
  }
  const validation = validateAttestedBookingArgs(trusted.intakeSnapshot, args);
  // Typed review columns are derived only from schema-recognized, valid scalar
  // answers. Raw provider arguments are never allowed to bypass the attested
  // contract merely because the overall request is being routed to review.
  const recognizedAnswers = validation.answers ?? {};
  const firstName = sanitizeText(recognizedAnswers.first_name, MAX_NAME);
  const lastName = sanitizeText(recognizedAnswers.last_name, MAX_NAME);
  const email = typeof recognizedAnswers.email === 'string' ? recognizedAnswers.email.trim() : null;
  const messagingConsent = typeof recognizedAnswers.messaging_consent === 'boolean'
    ? recognizedAnswers.messaging_consent
    : null;
  const service = trusted.intakeSnapshot.appointmentType;
  const phone = validPhone(trusted.observedPhone);
  const persistedAnswers = validation.answers
    ? boundedCanonicalObject({ ...validation.answers, observed_phone: phone })
    : null;
  const answerIssues = persistedAnswers ? [] : ['answers:maximum_bytes_with_provenance'];
  const rawAnswers: Prisma.InputJsonValue = persistedAnswers
    ?? { observed_phone: phone, unpersisted: true, reason: 'invalid_or_oversized_contract_answers' };
  const date = typeof recognizedAnswers.appointment_date === 'string' ? recognizedAnswers.appointment_date : '';
  const time = typeof recognizedAnswers.appointment_time === 'string' ? recognizedAnswers.appointment_time : '';
  const startsAt = trusted.branchTimezone ? parseSlot(date, time, trusted.branchTimezone) : null;
  const idempotencyKey = `${ctx.tenantId}:${trusted.callLogId}`;

  const execute = async (forcedReviewReason?: string): Promise<BookingTransactionResult> => db.$transaction(async tx => {
    // Lock ordering is an invariant: the source call always precedes any slot.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-call-lifecycle:${ctx.tenantId}:${ctx.callId}`})::bigint)`;
    const call = await tx.receptionistCallLog.findFirst({
      where: { id: trusted.callLogId, tenantId: ctx.tenantId },
      select: {
        id: true, retellCallId: true, campaignId: true, clinicId: true, callerPhone: true,
        outcome: true, recordingConsentStatus: true, startedAt: true, createdAt: true, endedAt: true,
      },
    });
    const campaign = await tx.receptionistCampaign.findFirst({
      where: { id: trusted.campaignId, tenantId: ctx.tenantId, clinicId: trusted.clinicId, status: 'ACTIVE' },
      select: {
        id: true, clinicId: true, appointmentType: true, smsConfirmation: true, emailConfirmation: true,
        intakeSchemaRevision: true, intakeSchemaSnapshot: true, intakeSchemaFingerprint: true,
        intakeSchemaAttestedRevision: true, intakeSchemaProviderAgentId: true, intakeSchemaProviderVersion: true,
      },
    });
    const dbSnapshot = campaign?.intakeSchemaSnapshot && typeof campaign.intakeSchemaSnapshot === 'object' && !Array.isArray(campaign.intakeSchemaSnapshot)
      ? campaign.intakeSchemaSnapshot as unknown as IntakeContractSnapshot
      : null;
    const observedPhone = validPhone(call?.callerPhone);
    const activeSince = call?.startedAt ?? call?.createdAt;
    const authorityValid = Boolean(
      call && campaign && dbSnapshot
      && call.retellCallId === ctx.callId
      && call.campaignId === trusted.campaignId
      && call.clinicId === trusted.clinicId
      && call.recordingConsentStatus === 'GRANTED'
      && !call.endedAt
      && activeSince && activeSince.getTime() >= Date.now() - RECEPTIONIST_CALL_LEASE_MS
      && observedPhone === phone
      && campaign.appointmentType === trusted.intakeSnapshot.appointmentType
      && campaign.intakeSchemaAttestedRevision === campaign.intakeSchemaRevision
      && campaign.intakeSchemaFingerprint === fingerprintJson(dbSnapshot)
      && fingerprintJson(dbSnapshot) === fingerprintJson(trusted.intakeSnapshot)
      && campaign.intakeSchemaProviderAgentId === trusted.providerAgentId
      && campaign.intakeSchemaProviderVersion === trusted.providerAgentVersion,
    );
    if (!authorityValid || !call || !campaign || !dbSnapshot) {
      return { kind: 'rejected', message: 'I cannot revalidate the active call and booking configuration. Please contact the front desk.' };
    }

    const existingRequest = await tx.appointmentRequest.findFirst({
      where: { tenantId: ctx.tenantId, callLogId: trusted.callLogId },
    });
    const existingAppointment = await tx.appointment.findFirst({
      where: { tenantId: ctx.tenantId, receptionistCallLogId: trusted.callLogId, deletedAt: null },
      select: {
        id: true, patientId: true, service: true, startsAt: true,
        branch: { select: { timezone: true, name: true, location: true } },
        providerProfile: { select: { user: { select: { displayName: true } } } },
        patient: { select: { firstName: true, email: true, phone: true } },
      },
    });
    if (existingAppointment) {
      if (!existingRequest?.bookedAppointmentId || existingRequest.bookedAppointmentId !== existingAppointment.id || existingRequest.status !== 'BOOKED') {
        return { kind: 'rejected', message: 'The existing booking evidence is inconsistent. A staff member must review it.' };
      }
      return {
        kind: 'booked', tenantId: ctx.tenantId, appointmentId: existingAppointment.id, requestId: existingRequest.id,
        patientId: existingAppointment.patientId, firstName: existingAppointment.patient.firstName,
        email: existingAppointment.patient.email, phone: validPhone(existingAppointment.patient.phone),
        service: existingAppointment.service, startsAt: existingAppointment.startsAt,
        timezone: existingAppointment.branch.timezone, locationName: existingAppointment.branch.name,
        locationAddress: existingAppointment.branch.location.trim() || null,
        providerName: existingAppointment.providerProfile?.user.displayName.trim() || null,
        smsEnabled: campaign.smsConfirmation,
        emailEnabled: campaign.emailConfirmation,
        messagingConsent: typeof (existingRequest.rawCollectedFields as Record<string, unknown> | null)?.messaging_consent === 'boolean'
          ? (existingRequest.rawCollectedFields as Record<string, unknown>).messaging_consent as boolean
          : null,
        duplicate: true,
      };
    }
    // Migration-era bookings may have the request FK but lack the newly added
    // source-call column on Appointment. Treat that FK as canonical evidence:
    // repair only the unambiguous, provider-backed row and replay it. Never
    // create a second appointment for the same call.
    if (existingRequest?.status === 'BOOKED' && existingRequest.bookedAppointmentId) {
      const linkedAppointment = await tx.appointment.findFirst({
        where: { id: existingRequest.bookedAppointmentId, tenantId: ctx.tenantId, deletedAt: null },
        select: {
          id: true, patientId: true, providerProfileId: true, receptionistCallLogId: true,
          service: true, startsAt: true, branch: { select: { timezone: true, name: true, location: true } },
          providerProfile: { select: { user: { select: { displayName: true } } } },
          patient: { select: { firstName: true, email: true, phone: true } },
        },
      });
      if (!linkedAppointment || !linkedAppointment.providerProfileId
        || (linkedAppointment.receptionistCallLogId && linkedAppointment.receptionistCallLogId !== trusted.callLogId)) {
        return { kind: 'rejected', message: 'The existing booking evidence is inconsistent. A staff member must review it.' };
      }
      if (!linkedAppointment.receptionistCallLogId) {
        await tx.appointment.update({
          where: { id: linkedAppointment.id },
          data: { receptionistCallLogId: trusted.callLogId },
        });
      }
      return {
        kind: 'booked', tenantId: ctx.tenantId, appointmentId: linkedAppointment.id, requestId: existingRequest.id,
        patientId: linkedAppointment.patientId, firstName: linkedAppointment.patient.firstName,
        email: linkedAppointment.patient.email, phone: validPhone(linkedAppointment.patient.phone),
        service: linkedAppointment.service, startsAt: linkedAppointment.startsAt,
        timezone: linkedAppointment.branch.timezone, locationName: linkedAppointment.branch.name,
        locationAddress: linkedAppointment.branch.location.trim() || null,
        providerName: linkedAppointment.providerProfile?.user.displayName.trim() || null,
        smsEnabled: campaign.smsConfirmation,
        emailEnabled: campaign.emailConfirmation,
        messagingConsent: typeof (existingRequest.rawCollectedFields as Record<string, unknown> | null)?.messaging_consent === 'boolean'
          ? (existingRequest.rawCollectedFields as Record<string, unknown>).messaging_consent as boolean
          : null,
        duplicate: true,
      };
    }
    if (existingRequest && !['PENDING_REVIEW', 'MISSING_INFO'].includes(existingRequest.status)) {
      return { kind: 'rejected', message: 'This appointment request already has a terminal staff decision. A staff member must review it.' };
    }
    if (call.outcome === 'BOOKED') return { kind: 'rejected', message: 'The call is marked booked without canonical appointment evidence. A staff member must review it.' };
    if (call.outcome !== 'IN_PROGRESS') {
      return { kind: 'rejected', message: 'This call already has a different terminal outcome. A staff member must review it.' };
    }

    // Bind review requests to a patient only when this exact provider call has
    // durable identity-verification evidence. Phone/name similarity is useful
    // intake data, but never authority to link an unrelated appointment later.
    const existingPatients = phone ? await patientsByCanonicalPhone(ctx.tenantId, phone, tx) : [];
    let verifiedExistingPatientId: string | null = null;
    if (existingPatients.length) {
      const proof = await tx.idempotencyKey.findUnique({
        where: { scope_key: { scope: 'receptionist.voice-identity', key: `${ctx.tenantId}:${ctx.callId}` } },
        select: { resultId: true },
      });
      if (proof?.resultId && existingPatients.some(patient => patient.id === proof.resultId)) {
        verifiedExistingPatientId = proof.resultId;
      }
    }

    let locationValid = false;
    if (trusted.locationId && trusted.branchId && trusted.branchTimezone) {
      const eligible = trusted.intakeSnapshot.eligibleLocationIds;
      const location = await tx.receptionistLocation.findFirst({
        where: {
          id: trusted.locationId, tenantId: ctx.tenantId, clinicId: trusted.clinicId,
          branchId: trusted.branchId, active: true, branch: { active: true, timezone: trusted.branchTimezone },
        },
        select: { id: true },
      });
      locationValid = Boolean(location && (!eligible.length || eligible.includes(trusted.locationId)));
    }

    const review = async (reason: string, missingFields: string[], message: string): Promise<BookingTransactionResult> => {
      const sameReview = existingRequest
        && existingRequest.status !== 'BOOKED'
        && existingRequest.outcomeReason === reason
        && fingerprintJson(existingRequest.rawCollectedFields) === fingerprintJson(rawAnswers);
      if (sameReview) return { kind: 'review', requestId: existingRequest.id, duplicate: true, message };
      if (existingRequest?.status === 'REJECTED') return { kind: 'review', requestId: existingRequest.id, duplicate: true, message: 'The front desk has already reviewed this request. Please contact them for assistance.' };
      const request = existingRequest
        ? await tx.appointmentRequest.update({
          where: { id: existingRequest.id },
          data: {
            branchId: trusted.branchId, campaignId: trusted.campaignId, requestedService: service,
            ...(verifiedExistingPatientId ? { patientId: verifiedExistingPatientId } : {}),
            collectedName: firstName && lastName ? `${firstName} ${lastName}` : null,
            collectedPhone: phone, collectedEmail: email, rawCollectedFields: rawAnswers,
            requestedDateTime: startsAt, status: 'MISSING_INFO', missingFields, outcomeReason: reason,
          },
          select: { id: true },
        })
        : await tx.appointmentRequest.create({
          data: {
            tenantId: ctx.tenantId, branchId: trusted.branchId, campaignId: trusted.campaignId,
            patientId: verifiedExistingPatientId,
            callLogId: trusted.callLogId, requestedService: service,
            collectedName: firstName && lastName ? `${firstName} ${lastName}` : null,
            collectedPhone: phone, collectedEmail: email, rawCollectedFields: rawAnswers,
            requestedDateTime: startsAt, source: 'ai_receptionist', status: 'MISSING_INFO',
            missingFields, outcomeReason: reason,
          },
          select: { id: true },
        });
      await tx.idempotencyKey.upsert({
        where: { scope_key: { scope: 'receptionist.live-booking', key: idempotencyKey } },
        update: { tenantId: ctx.tenantId, resultId: request.id },
        create: { tenantId: ctx.tenantId, scope: 'receptionist.live-booking', key: idempotencyKey, resultId: request.id },
      });
      await auditLive(ctx.tenantId, existingRequest ? 'receptionist.appointmentRequest.corrected' : 'receptionist.appointmentRequest.needsReview', request.id, {
        reason, via: 'live_call', callLogId: trusted.callLogId,
      }, tx);
      await tx.businessEvent.create({ data: {
        tenantId: ctx.tenantId, eventType: existingRequest ? 'receptionist.appointmentRequest.corrected' : 'receptionist.appointmentRequest.created',
        entityType: 'appointmentRequest', entityId: request.id, sourceModule: 'receptionist',
        payload: { status: 'MISSING_INFO', live: true, callLogId: trusted.callLogId },
      } });
      return { kind: 'review', requestId: request.id, duplicate: false, message };
    };

    if (forcedReviewReason) return review(forcedReviewReason, ['preferredDateTime'], `I'm sorry — that time was just taken. I recorded the same request for staff review.`);
    if (!validation.ok || answerIssues.length) {
      const issues = [...(!validation.ok ? validation.issues : []), ...answerIssues];
      return review(`Attested booking arguments failed validation: ${issues.join(', ')}`, issues, 'I need a team member to review the information before booking.');
    }
    if (!locationValid) return review('Campaign location did not resolve to one active mapped branch', ['preferredLocation'], 'I need a team member to confirm the clinic location before booking.');
    if (!startsAt || !firstName || !lastName) return review('Required booking identity or date/time could not be parsed', ['preferredDateTime'], 'I need a team member to confirm the date, time, and patient name before booking.');

    const policy = await getSchedulingPolicy(ctx.tenantId, tx);
    const now = new Date();
    const earliest = new Date(now.getTime() + policy.minNoticeHours * 3_600_000);
    const latest = new Date(now.getTime() + policy.maxHorizonDays * 86_400_000);
    if (!policy.selfBookEnabled || startsAt < earliest || startsAt > latest) {
      return review('Canonical self-booking policy does not permit the requested time', ['schedulingPolicy'], 'A team member needs to review this appointment request.');
    }
    const providers = await tx.providerProfile.findMany({
      where: { tenantId: ctx.tenantId, branchId: trusted.branchId!, active: true, user: { active: true } },
      select: {
        id: true,
        user: { select: { displayName: true } },
        branch: { select: { name: true, location: true } },
      }, take: 2,
    });
    const schedulingService = await resolveSchedulingService({ tenantId: ctx.tenantId, service, fallbackDurationMin: SLOT_MIN }, tx);
    if (providers.length !== 1 || !schedulingService) {
      return review(providers.length !== 1 ? 'Provider selection is ambiguous' : 'Configured service is not canonical', [providers.length !== 1 ? 'preferredProvider' : 'preferredService'], 'A team member needs to confirm the provider or service before booking.');
    }
    const providerProfileId = providers[0].id;
    if (existingPatients.length && !verifiedExistingPatientId) {
      return review(existingPatients.length > 1 ? 'Patient identity is ambiguous' : 'Existing patient identity was not verified for this call', ['identityVerification'], 'I need identity verification or front desk assistance before linking this booking.');
    }
    if ((policy.requireEligibilityForSelfBook || policy.requireIntakeForSelfBook) && !verifiedExistingPatientId) {
      return review('Canonical pre-visit policy requires an existing verified patient', ['preVisitRequirements'], 'A team member must review eligibility or intake requirements before booking.');
    }
    if (verifiedExistingPatientId) {
      const unmet = await unmetPreVisitRequirements(ctx.tenantId, verifiedExistingPatientId, policy, tx);
      if (unmet.length) return review(`Canonical pre-visit requirements are incomplete: ${unmet.join(', ')}`, unmet, 'A team member must review eligibility or intake requirements before booking.');
    }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-book-slot:${ctx.tenantId}:${providerProfileId}:${startsAt.toISOString()}`})::bigint)`;
    const slotConflict = await findSlotConflict({ tenantId: ctx.tenantId, providerProfileId, startsAt, durationMin: schedulingService.durationMin }, tx);
    if (slotConflict) return review(`Canonical scheduler rejected the slot: ${slotConflict}`, ['preferredDateTime'], `I'm sorry — that time is unavailable. I recorded the same request for staff review.`);

    let patient = verifiedExistingPatientId
      ? await tx.patient.findFirst({ where: { id: verifiedExistingPatientId, tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } })
      : null;
    if (!patient) {
      patient = await tx.patient.create({
        data: { tenantId: ctx.tenantId, branchId: trusted.branchId!, firstName, lastName, phone, email, lifecycleStage: 'NEW' },
        select: { id: true },
      });
    }
    const endsAt = new Date(startsAt.getTime() + schedulingService.durationMin * 60_000);
    const appointment = await tx.appointment.create({
      data: {
        tenantId: ctx.tenantId, branchId: trusted.branchId!, patientId: patient.id,
        providerProfileId, providerRef: providerProfileId, service: schedulingService.name,
        serviceCatalogItemId: schedulingService.id, receptionistCallLogId: trusted.callLogId,
        startsAt, endsAt, status: 'CONFIRMED', channel: 'CALL',
      },
      select: { id: true },
    });
    const request = existingRequest
      ? await tx.appointmentRequest.update({
        where: { id: existingRequest.id },
        data: {
          branchId: trusted.branchId, patientId: patient.id, campaignId: trusted.campaignId,
          requestedService: service, requestedDateTime: startsAt,
          collectedName: `${firstName} ${lastName}`, collectedPhone: phone, collectedEmail: email,
          rawCollectedFields: rawAnswers, status: 'BOOKED', missingFields: [],
          bookedAppointmentId: appointment.id, outcomeReason: 'Booked live by AI receptionist',
        },
        select: { id: true },
      })
      : await tx.appointmentRequest.create({
        data: {
          tenantId: ctx.tenantId, branchId: trusted.branchId, patientId: patient.id,
          campaignId: trusted.campaignId, callLogId: trusted.callLogId,
          requestedService: service, requestedDateTime: startsAt,
          collectedName: `${firstName} ${lastName}`, collectedPhone: phone, collectedEmail: email,
          rawCollectedFields: rawAnswers, source: 'ai_receptionist', status: 'BOOKED',
          missingFields: [], bookedAppointmentId: appointment.id, outcomeReason: 'Booked live by AI receptionist',
        },
        select: { id: true },
      });
    // The booking question is deliberately a conservative notification
    // preference, not channel consent. Never mint SMS/email/marketing authority
    // from one bundled voice answer. A refusal suppresses confirmations; true or
    // absent values can proceed only under the clinic's separately governed
    // transactional-treatment policy and the final shared suppression fence.
    if (messagingConsent !== false) {
      const channels = [
        campaign.smsConfirmation && phone ? 'sms' : null,
        campaign.emailConfirmation && email ? 'email' : null,
      ].filter((channel): channel is 'sms' | 'email' => channel !== null);
      if (channels.length) await tx.notificationEvent.createMany({
        data: channels.map(channel => ({
          tenantId: ctx.tenantId,
          appointmentId: appointment.id,
          patientId: patient.id,
          recipientType: 'patient',
          channel,
          status: 'queued',
          attempts: 0,
          consentChecked: false,
          // This answer is not channel consent. Preserve the preference in the
          // booking business event, while the delivery boundary records only
          // the separately governed transactional basis.
          consentResult: 'not_recorded_transactional',
          source: CONFIRMATION_OUTBOX_SOURCE,
          idempotencyKey: `${appointment.id}:${channel}`,
        })),
        skipDuplicates: true,
      });
    }
    await tx.idempotencyKey.upsert({
      where: { scope_key: { scope: 'receptionist.live-booking', key: idempotencyKey } },
      update: { tenantId: ctx.tenantId, resultId: request.id },
      create: { tenantId: ctx.tenantId, scope: 'receptionist.live-booking', key: idempotencyKey, resultId: request.id },
    });
    await auditLive(ctx.tenantId, 'receptionist.appointment.booked', appointment.id, {
      branchId: trusted.branchId, appointmentRequestId: request.id, callLogId: trusted.callLogId,
      via: 'live_call', messagingConsent,
      notificationPreferencePolicy: APPOINTMENT_NOTIFICATION_PREFERENCE_POLICY,
      notificationPreferenceAuthorizesMarketing: false,
    }, tx);
    await tx.businessEvent.create({ data: {
      tenantId: ctx.tenantId, eventType: 'receptionist.appointment.booked', entityType: 'appointment',
      entityId: appointment.id, sourceModule: 'receptionist',
      payload: {
        appointmentRequestId: request.id,
        callLogId: trusted.callLogId,
        live: true,
        messagingConsent,
        notificationPreferencePolicy: APPOINTMENT_NOTIFICATION_PREFERENCE_POLICY,
        notificationPreferenceAuthorizesMarketing: false,
      },
    } });
    await tx.receptionistCallLog.update({ where: { id: trusted.callLogId }, data: { outcome: 'BOOKED' } });
    return {
      kind: 'booked', tenantId: ctx.tenantId, appointmentId: appointment.id, requestId: request.id, patientId: patient.id,
      firstName, email, phone, service: schedulingService.name, startsAt, timezone: trusted.branchTimezone!,
      locationName: providers[0].branch.name,
      locationAddress: providers[0].branch.location.trim() || null,
      providerName: providers[0].user.displayName.trim() || null,
      smsEnabled: campaign.smsConfirmation, emailEnabled: campaign.emailConfirmation, messagingConsent, duplicate: false,
    };
  });

  let result: BookingTransactionResult;
  try {
    result = await execute();
  } catch (error) {
    if (!isDoubleBookConflictError(error)) throw error;
    result = await execute('The canonical appointment constraint reported that the selected slot was taken concurrently');
  }
  if (result.kind === 'rejected') return { booked: false, needs_human: true, message: result.message };
  if (result.kind === 'review') return { booked: false, needs_review: true, duplicate: result.duplicate, appointment_request_id: result.requestId, message: result.message };

  const bookingPack = await callPack(ctx);
  const bookingLocale = bookingPack ? resolvedLocaleFormat(bookingPack, bookingPack.language) : null;
  const localLabel = localAppointmentLabel(result.startsAt, result.timezone, bookingLocale);
  const timezoneLabel = new Intl.DateTimeFormat(bookingLocale?.language ?? 'en-US', {
    timeZone: result.timezone,
    timeZoneName: 'long',
  }).formatToParts(result.startsAt).find(part => part.type === 'timeZoneName')?.value ?? result.timezone;
  const spokenLocation = [result.locationName, result.locationAddress].filter(Boolean).join(', ');
  const spokenProvider = result.providerName ? `, with ${result.providerName}` : '';
  const spokenBooking = `${result.service} on ${localLabel} ${timezoneLabel} at ${spokenLocation}${spokenProvider}`;
  // Both the first response and canonical replays drain the same durable
  // outbox. Already accepted rows no-op; queued/failed (or stale retrying)
  // rows are claimable, so a process failure after booking commit is repaired
  // without creating another appointment or another accepted send.
  const confirmations = await processAppointmentConfirmations({
    tenantId: result.tenantId,
    appointmentId: result.appointmentId,
    messagingConsent: result.messagingConsent,
    smsEnabled: result.smsEnabled,
    emailEnabled: result.emailEnabled,
    phone: result.phone,
    email: result.email,
  });
  const acceptedNow = confirmations.sms.acceptedNow || confirmations.email.acceptedNow;
  return {
    booked: true, duplicate: result.duplicate || undefined, appointment_id: result.appointmentId,
    starts_at: result.startsAt.toISOString(), timezone: result.timezone,
    spoken_time: `${localLabel} ${timezoneLabel}`,
    location_name: result.locationName, location_address: result.locationAddress,
    provider_name: result.providerName, service: result.service,
    sms_sent: false, sms_accepted: confirmations.sms.acceptedNow, sms_status: confirmations.sms.status,
    email_sent: false, email_accepted: confirmations.email.acceptedNow, email_status: confirmations.email.status,
    message: (() => {
      // Acceptance by the messaging provider is not delivery, and the pack line
      // says so in the caller's own words. The exact per-channel status stays in
      // sms_status / email_status above for staff and for the audit trail.
      const confirmation = acceptedNow
        ? ` ${speak(bookingPack, 'tool.booking.confirmation_accepted', {}, "I've sent your confirmation; I can't confirm it has arrived yet.")}`
        : '';
      return result.duplicate
        ? speak(bookingPack, 'tool.booking.already', { booking: spokenBooking, confirmation }, `You're already booked for ${spokenBooking}.${confirmation}`)
        : speak(bookingPack, 'tool.booking.confirmed', { first_name: result.firstName, booking: spokenBooking, confirmation }, `Perfect, ${result.firstName}. You're booked for ${spokenBooking}.${confirmation}`);
    })(),
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
    const configuredAgents = ctx.trustedProviderAgentId
      ? await db.receptionistAgent.findMany({
        where: { id: ctx.trustedProviderAgentId, tenantId: ctx.tenantId, clinicId: call.clinic.id, active: true },
        select: { name: true },
        take: 2,
      })
      : call.campaign?.agent
        ? [call.campaign.agent]
        : await db.receptionistAgent.findMany({ where: { tenantId: ctx.tenantId, clinicId: call.clinic.id, active: true }, select: { name: true }, take: 2 });
    if (configuredAgents.length !== 1) {
      return { recorded: false, message: 'I could not bind that preference to one configured receptionist disclosure. I will keep this call metadata-only and connect you with staff.' };
    }
    // C10 — the consent artefact must record the words that were SPOKEN.
    // `renderRecordingDisclosure` is the en-US baseline; an en-GB caller heard
    // their pack's "quality and training purposes" and, before this, we hashed
    // wording they had never been read. Hash the pack-rendered disclosure, and
    // fall back to the baseline only when no pack (and no country) resolves at
    // all — which is also the only case where the baseline is what was said.
    const consentPack = await callPack(ctx);
    const baselineDisclosure = renderRecordingDisclosure({
      agentName: configuredAgents[0].name,
      clinicName: call.clinic.name,
      clinicDisclosure: call.clinic.complianceDisclosure,
    });
    const supplemental = call.clinic.complianceDisclosure?.trim();
    const disclosureText = speak(consentPack, 'disclosure.recording', {
      agent_name: configuredAgents[0].name,
      clinic_name: call.clinic.name,
      // The supplemental sentence carries its own leading space, exactly as
      // mandatoryOpeningDisclosure composes it for the deployed prompt.
      clinic_disclosure: supplemental ? ` ${supplemental}` : '',
    }, baselineDisclosure);
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
        // Which pack the hashed wording came from, so the artefact can be
        // reproduced years later without guessing the locale.
        disclosureLocalePackId: consentPack?.id ?? null,
        disclosureLocale: consentPack ? `${consentPack.language}/${consentPack.country}` : null,
        disclosureSource: consentPack ? consentPack.source : 'baseline_template',
      },
    });
    return {
      recorded: true,
      decision,
      // Retention posture is staff/compliance evidence, and it stays here. It
      // was previously read aloud to a patient as the second thing they heard.
      metadata_only: true,
      // C3 — a refusal restricts the recording, never the service. This field
      // is what the front desk and the prompt both key off.
      service_continues: true,
      message: decision === 'GRANTED'
        ? speak(consentPack, 'consent.granted.ack', {}, 'Thank you. So, how can I help you today?')
        : speak(consentPack, 'consent.refused.recorded', {}, "That's recorded. This call won't be recorded or transcribed, and I can still help you here."),
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
