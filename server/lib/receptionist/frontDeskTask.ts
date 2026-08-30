import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';
import { isValidE164, toE164 } from '../campaigns';
import { parseClinicSlot } from '../scheduling';
import { DEFAULT_FRONT_DESK_POLICY, resolveFrontDeskPolicy, type SlaKind } from './frontDeskPolicy';

// ===========================================================================
// The receptionist StaffTask contract (C4-pre, phase-2 contract §8).
//
// ONE metadata schema for every task the AI receptionist files: the live tools
// (message / handoff / emergency), C3's inbound reception kinds (call_denied,
// ai_declined, tool_failure, identity_locked, booking_review) and the reserved
// missed_call. `createSafetyTask(ctx, kind, args)` is the single writer; the
// front desk queue, the summary, the call detail and the transfer webhook all
// read through `parseReceptionistTask`.
//
// Principle: the AI never closes a loop it did not close. A task is OPEN until a
// human acts — the one exception is a transfer the provider proved connected
// (`markTransferOutcome`), which completes the handoff with outcome
// `transferred` because the loop was closed on the phone.
//
// Caller content stays in the task row only. Audit rows carry classifications
// and identifiers, never names, phones, or message text.
// ===========================================================================

export const RECEPTIONIST_TASK_WORKFLOW = 'receptionist_safety' as const;

export const RECEPTIONIST_TASK_KINDS = [
  'message', 'human_handoff', 'emergency', 'missed_call',
  'call_denied', 'ai_declined', 'tool_failure', 'identity_locked', 'booking_review',
  // D9 - the one task that says "your receptionist is off the air". Filed by the
  // re-verification worker through `fileDeploymentAttentionTask`, never by a
  // caller, so it carries remediation copy instead of a message.
  'deployment_attention',
] as const;
export type ReceptionistTaskKind = typeof RECEPTIONIST_TASK_KINDS[number];

/**
 * D8 - the workflows the front desk board owns. `receptionist_safety` is the one
 * this file writes; the rest are reconciliation tasks other receptionist paths
 * file and the desk must still see. A critical *insurance* or *ops* task is not
 * in this set and must never be announced to the front desk as an emergency.
 */
export const RECEPTIONIST_TASK_WORKFLOWS = [
  RECEPTIONIST_TASK_WORKFLOW,
  'receptionist_outbound_reconciliation',
  'receptionist_outbound_stop_reconciliation',
  'receptionist_provider_intent_recovery',
  'receptionist_provider_poll_reconciliation',
  'receptionist_provider_deployment_review',
  // Pre-D9 rows only; new ones arrive as receptionist_safety/deployment_attention.
  'receptionist_deployment',
] as const;

/**
 * D10 - one priority vocabulary. This file has always filed lowercase; the
 * webhook and outbound reconciliation paths still file 'CRITICAL'/'HIGH', so
 * every read matches both spellings until those rows are backfilled. New writes
 * go through `normalizeTaskPriority`.
 */
export const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);

export function normalizeTaskPriority(value: unknown): TaskPriority | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return (TASK_PRIORITIES as readonly string[]).includes(lower) ? lower as TaskPriority : null;
}

/** Every spelling of one priority still present in the table. */
export function taskPriorityVariants(priority: TaskPriority): string[] {
  return [priority, priority.toUpperCase()];
}

export const TASK_OUTCOME_CODES = [
  'reached', 'left_voicemail', 'no_answer', 'wrong_number', 'booked',
  'resolved_elsewhere', 'duplicate', 'not_needed', 'transferred', 'cancelled_by_caller',
] as const;
export type TaskOutcomeCode = typeof TASK_OUTCOME_CODES[number];

export const TRANSFER_STATUSES = ['not_attempted', 'attempted', 'connected', 'failed', 'unknown'] as const;
export type TransferStatus = typeof TRANSFER_STATUSES[number];

export const TASK_SOURCES = ['retell_live_call', 'webhook_call_ended', 'staff', 'system'] as const;
export type TaskSource = typeof TASK_SOURCES[number];

export const LIVE_TASK_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

const E164 = /^\+[1-9]\d{7,14}$/;
const MAX_NAME = 80;
const MAX_SHORT = 40;
const MAX_MESSAGE = 500;
const MAX_MESSAGES = 20;
const MAX_STAFF_NOTES = 50;
const isoDateTime = z.string().datetime({ offset: true });

export const taskMessageSchema = z.object({
  text: z.string().max(MAX_MESSAGE),
  recordedAt: isoDateTime,
  invocationId: z.string().max(180).nullable().default(null),
});

export const staffNoteSchema = z.object({
  text: z.string().max(MAX_MESSAGE),
  at: isoDateTime,
  byUserId: z.string().uuid(),
});

export const callbackWindowSchema = z.object({
  start: isoDateTime,
  end: isoDateTime,
  timezone: z.string().max(64),
});

// Defaults make pre-C4 rows (callbackPhone/message only) parse unchanged.
export const receptionistTaskMetadata = z.object({
  workflow: z.literal(RECEPTIONIST_TASK_WORKFLOW),
  kind: z.enum(RECEPTIONIST_TASK_KINDS),
  source: z.enum(TASK_SOURCES).default('retell_live_call'),
  callId: z.string().max(128).nullable().default(null),
  clinicId: z.string().uuid().nullable().default(null),
  locationId: z.string().uuid().nullable().default(null),
  callerName: z.string().max(MAX_NAME).nullable().default(null),
  /** Envelope from_number, validated E.164. */
  verifiedPhone: z.string().regex(E164).nullable().default(null),
  /** Caller-stated number, unverified. */
  requestedCallbackPhone: z.string().regex(E164).nullable().default(null),
  /** = requestedCallbackPhone ?? verifiedPhone (kept for old readers). */
  callbackPhone: z.string().regex(E164).nullable().default(null),
  messages: z.array(taskMessageSchema).max(MAX_MESSAGES).default([]),
  /** Latest message text (kept for old readers). */
  message: z.string().max(MAX_MESSAGE).nullable().default(null),
  reasonCategory: z.string().max(MAX_SHORT).default('other'),
  callbackWindow: callbackWindowSchema.nullable().default(null),
  transferStatus: z.enum(TRANSFER_STATUSES).default('not_attempted'),
  transferUpdatedAt: isoDateTime.nullable().default(null),
  toolName: z.string().max(80).nullable().default(null),
  denialReason: z.string().max(80).nullable().default(null),
  appointmentRequestId: z.string().uuid().nullable().default(null),
  appointmentId: z.string().uuid().nullable().default(null),
  // deployment_attention only (D9): what lapsed, and the words that fix it.
  agentId: z.string().uuid().nullable().default(null),
  code: z.string().max(80).nullable().default(null),
  remediationTitle: z.string().max(240).nullable().default(null),
  remediationAction: z.string().max(1_000).nullable().default(null),
  fixHref: z.string().max(400).nullable().default(null),
  requiresAcknowledgement: z.literal(true).default(true),
  staffNotes: z.array(staffNoteSchema).max(MAX_STAFF_NOTES).default([]),
});
export type ReceptionistTaskMetadata = z.infer<typeof receptionistTaskMetadata>;

export interface ReceptionistTaskParse {
  /** Typed view: the strict parse, or the recovered one when `degraded`. */
  meta: ReceptionistTaskMetadata;
  /**
   * True when the stored blob failed the strict schema. `meta` is then a partial
   * reconstruction and MUST NOT be written back on its own (D3) - doing so
   * deletes the caller's recorded message, the previous person's note, the
   * callback window and the appointment-request link, irreversibly.
   */
  degraded: boolean;
  /** The stored object exactly as the row holds it. */
  raw: Record<string, unknown>;
}

/** Typed view + provenance. Null for any other workflow. */
export function parseReceptionistTaskDetailed(row: { metadata: unknown }): ReceptionistTaskParse | null {
  const raw = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : null;
  if (!raw || raw.workflow !== RECEPTIONIST_TASK_WORKFLOW) return null;
  const parsed = receptionistTaskMetadata.safeParse(raw);
  if (parsed.success) return { meta: parsed.data, degraded: false, raw };
  // A malformed receptionist row must still surface in the queue rather than
  // vanish; degrade to what is recoverable, never throw on a read.
  const kind = RECEPTIONIST_TASK_KINDS.includes(raw.kind as ReceptionistTaskKind) ? raw.kind as ReceptionistTaskKind : 'message';
  const fallback = receptionistTaskMetadata.parse({ workflow: RECEPTIONIST_TASK_WORKFLOW, kind });
  const str = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : null;
  const phone = (value: unknown) => typeof value === 'string' && E164.test(value) ? value : null;
  return {
    meta: {
      ...fallback,
      callId: str(raw.callId, 128),
      callerName: str(raw.callerName, MAX_NAME),
      message: str(raw.message, MAX_MESSAGE),
      callbackPhone: phone(raw.callbackPhone),
      verifiedPhone: phone(raw.verifiedPhone),
      requestedCallbackPhone: phone(raw.requestedCallbackPhone),
      reasonCategory: str(raw.reasonCategory, MAX_SHORT) ?? 'other',
    },
    degraded: true,
    raw,
  };
}

/** Typed view of a receptionist task's metadata; null for any other workflow. */
export function parseReceptionistTask(row: { metadata: unknown }): ReceptionistTaskMetadata | null {
  return parseReceptionistTaskDetailed(row)?.meta ?? null;
}

/**
 * D3 - the ONLY way a receptionist task's metadata is written back. The changed
 * fields are merged onto the stored object, so a blob that failed strict parse
 * keeps every key this schema does not know about. The two identity fields are
 * repaired on the way through so a degraded row becomes readable again.
 */
export function mergeReceptionistTaskMetadata(
  parse: ReceptionistTaskParse,
  patch: Partial<ReceptionistTaskMetadata>,
): Prisma.InputJsonObject {
  return {
    ...parse.raw,
    workflow: RECEPTIONIST_TASK_WORKFLOW,
    kind: parse.meta.kind,
    ...patch,
  } as unknown as Prisma.InputJsonObject;
}

/**
 * D4 - a write onto a task this module did NOT file (insurance reconciliation,
 * an opportunity hand-off, an intake follow-up). Their metadata carries the
 * origin markers `ensureStaffTask` and the reconciliation paths look tasks up
 * by; overwriting it with a synthetic receptionist blob makes those lookups miss
 * and files duplicates later. Only the given keys are added.
 */
export function mergeForeignTaskMetadata(
  metadata: unknown,
  patch: Record<string, unknown>,
): Prisma.InputJsonObject {
  const raw = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return { ...raw, ...patch } as unknown as Prisma.InputJsonObject;
}

/** Staff notes already stored on any task, receptionist or not. */
export function readStaffNotes(metadata: unknown): Array<z.infer<typeof staffNoteSchema>> {
  const raw = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).staffNotes
    : null;
  const parsed = z.array(staffNoteSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

/**
 * D5 - ONE advisory-lock key per task id, in ONE namespace. Before this, the
 * live tools locked `hashtext('receptionist-safety:...')` while the staff routes
 * locked `hashtextextended('staff-task:...', 0)` - two disjoint namespaces over
 * the same JSON column - and `markTransferOutcome` took no lock at all, so a
 * caller's second message and a staff note interleaved and one was lost.
 */
export function staffTaskLockKey(tenantId: string, taskId: string): string {
  return `staff-task:${tenantId}:${taskId}`;
}

export async function lockStaffTask(
  tx: Prisma.TransactionClient,
  tenantId: string,
  taskId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${staffTaskLockKey(tenantId, taskId)}::text, 0))::text AS locked`;
}

// ---------------------------------------------------------------------------
// Input sanitisation (mirrors liveTools: caller input is untrusted).
// ---------------------------------------------------------------------------
export function sanitizeTaskText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  let stripped = '';
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    stripped += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const cleaned = stripped
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

export function validTaskPhone(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const e164 = toE164(v);
  return isValidE164(e164) ? e164 : null;
}

// ---------------------------------------------------------------------------
// Context + args
// ---------------------------------------------------------------------------

/** C3's `ToolContext.selection` shape (contract §8); every member optional here so pre-C3 callers compile. */
export interface ToolSelection {
  branchId?: string | null;
  locationId?: string | null;
  clinicId?: string | null;
  callLogId?: string | null;
  direction?: 'inbound' | 'outbound' | null;
  verifiedPatientId?: string | null;
  branchTimezone?: string | null;
}

/** Structural subset of liveTools' ToolContext — the live tools pass their ctx straight through. */
export interface SafetyTaskContext {
  tenantId: string;
  callId: string | null;
  callerPhone?: string | null;
  providerInvocationId?: string;
  trustedBooking?: {
    callLogId: string;
    clinicId: string;
    locationId: string | null;
    branchId: string | null;
    branchTimezone: string | null;
  };
  selection?: ToolSelection;
  /**
   * Overrides the default `tenant:callId:kind` idempotency key. Only the
   * deployment-attention path uses it, because it is filed by a worker with no
   * call: its key is `(agent, code)` so a probe failing every hour produces one
   * thing to act on, not a queue of identical rows (D9).
   */
  idempotencyKey?: string;
}

/** Raw tool args (snake_case, Retell) — every field optional and untrusted. */
export interface SafetyTaskArgs {
  caller_name?: unknown;
  callback_phone?: unknown;
  message?: unknown;
  reason_category?: unknown;
  /** `{ start, end }` as 'YYYY-MM-DDTHH:mm' in branch tz, or ISO with offset. */
  callback_window?: unknown;
  tool_name?: unknown;
  denial_reason?: unknown;
  appointment_request_id?: unknown;
  appointment_id?: unknown;
  source?: unknown;
  /** deployment_attention only (D9). */
  agent_id?: unknown;
  code?: unknown;
  remediation_title?: unknown;
  remediation_action?: unknown;
  fix_href?: unknown;
  priority?: unknown;
  [key: string]: unknown;
}

export interface SafetyTaskResult {
  taskId: string;
  /** A live task for this call+kind already existed and nothing new was recorded. */
  duplicate: boolean;
  /** A new message was appended to the existing live task. */
  appended: boolean;
}

/**
 * The staff-facing note on a possible-duplicate booking review.
 *
 * It lives here, beside TASK_TITLES, rather than at the call site in
 * liveTools: nobody speaks this sentence, the front desk reads it off a task.
 * frontDeskTask owns the StaffTask contract and its copy, which is exactly why
 * the C10 caller-facing pack lint does not scan this module — and why putting
 * a staff note in a `message:` literal inside liveTools is the wrong home for
 * it, not merely a lint failure.
 */
export function possibleDuplicatePatientNote(possibleDuplicateOfPatientId: string): string {
  return `This caller's number already matches patient ${possibleDuplicateOfPatientId}, and identity was not verified on the call. `
    + 'The booking was made under a new patient record; please confirm whether the records should be merged.';
}

/**
 * The reason a handoff exists when the line simply could not understand the
 * caller. It is deliberately a distinct category from `human_requested`: the
 * front desk needs to know this person did NOT ask for a human — the product
 * failed them and gave up — because that is a different conversation to open
 * with, and because it is the row the "What it missed" ledger counts.
 */
export const COMPREHENSION_BAILOUT_REASON = 'comprehension_failure';

/**
 * The staff-facing note on that handoff. Nobody speaks this; the front desk
 * reads it off a card, which is why it lives here beside TASK_TITLES rather
 * than in a locale pack.
 */
export const COMPREHENSION_BAILOUT_STAFF_NOTE =
  'The receptionist could not understand this caller after two consecutive turns and stopped trying, as designed. '
  + 'They did not ask for a person — we handed them to one. Please call them back and do not ask them to repeat what happened.';

/** Why a handoff exists when the caller is marked Human only. */
export const HUMAN_ONLY_REASON = 'human_only';

/** The staff-facing note on that handoff. Nobody speaks this. */
export const HUMAN_ONLY_STAFF_NOTE =
  'This caller is marked Human only, so the receptionist did not handle the call and will not book, cancel or look anything up on it. '
  + 'Please pick this up as a person.';

const TASK_TITLES: Record<ReceptionistTaskKind, string> = {
  human_handoff: 'AI receptionist human handoff requested',
  message: 'AI receptionist callback requested',
  emergency: 'URGENT: AI receptionist emergency mention',
  missed_call: 'Missed call needs a callback',
  call_denied: 'AI receptionist could not take a call',
  ai_declined: 'Caller declined the AI receptionist',
  tool_failure: 'AI receptionist tool failed during a call',
  identity_locked: 'Caller identity verification locked',
  booking_review: 'AI receptionist booking needs review',
  deployment_attention: 'AI receptionist deployment needs attention',
};

/**
 * The deployment task is not caller work and is not tenant-configurable: like
 * `emergency` it is filed at a fixed urgency, because a clinic must not be able
 * to quietly downgrade the alert that says the line has stopped answering.
 */
const DEPLOYMENT_ATTENTION_DUE_MINUTES = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function optionalUuid(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

async function patientsByCanonicalPhone(
  client: typeof db | Prisma.TransactionClient,
  tenantId: string,
  phone: string,
): Promise<Array<{ id: string }>> {
  return client.$queryRaw<Array<{ id: string }>>`
    SELECT id
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

function parseWindowBoundary(value: unknown, timezone: string): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value.trim());
  if (local) return parseClinicSlot(local[1], local[2], timezone);
  const absolute = new Date(value);
  return Number.isNaN(absolute.getTime()) ? null : absolute;
}

/** `{start,end}` in branch tz → stored ISO window, or null when unparseable/inverted. */
export function parseCallbackWindow(raw: unknown, timezone: string): z.infer<typeof callbackWindowSchema> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { start, end } = raw as { start?: unknown; end?: unknown };
  const startAt = parseWindowBoundary(start, timezone);
  const endAt = parseWindowBoundary(end, timezone);
  if (!startAt || !endAt || endAt.getTime() <= startAt.getTime()) return null;
  return { start: startAt.toISOString(), end: endAt.toISOString(), timezone };
}

// ---------------------------------------------------------------------------
// createSafetyTask
// ---------------------------------------------------------------------------

/**
 * File (or extend) the staff-visible acknowledgment primitive for one call.
 *
 * Branch resolution order: selection.branchId → trustedBooking.branchId → the
 * call's clinic has exactly one active location with a branch → the tenant's
 * single active branch → null (tenant-wide; still visible to every branch).
 *
 * Idempotency is live-status scoped: key `tenant:callId:kind` reuses an
 * OPEN/IN_PROGRESS task and APPENDS a new message on the same call; once the
 * prior task is COMPLETED/CANCELED a new one is created so a later message can
 * never be swallowed by a closed task.
 */
export async function createSafetyTask(
  ctx: SafetyTaskContext,
  kind: ReceptionistTaskKind,
  args: SafetyTaskArgs,
): Promise<SafetyTaskResult> {
  const tenantId = ctx.tenantId;
  const safeCallId = sanitizeTaskText(ctx.callId, 128);
  const verifiedPhone = validTaskPhone(ctx.callerPhone);
  const requestedCallbackPhone = validTaskPhone(args.callback_phone);
  const callerName = sanitizeTaskText(args.caller_name, MAX_NAME);
  const message = sanitizeTaskText(args.message, MAX_MESSAGE);
  const reasonCategory = sanitizeTaskText(args.reason_category, MAX_SHORT) ?? 'other';
  const toolName = sanitizeTaskText(args.tool_name, 80);
  const denialReason = sanitizeTaskText(args.denial_reason, 80);
  const source: TaskSource = TASK_SOURCES.includes(args.source as TaskSource) ? args.source as TaskSource : 'retell_live_call';
  const deployment = kind === 'deployment_attention'
    ? {
      agentId: optionalUuid(args.agent_id),
      code: sanitizeTaskText(args.code, 80),
      remediationTitle: sanitizeTaskText(args.remediation_title, 240),
      remediationAction: sanitizeTaskText(args.remediation_action, 1_000),
      fixHref: sanitizeTaskText(args.fix_href, 400),
    }
    : { agentId: null, code: null, remediationTitle: null, remediationAction: null, fixHref: null };
  const invocationId = sanitizeTaskText(ctx.providerInvocationId, 180);
  const selection = ctx.selection ?? {};

  // --- Resolve the call, clinic, branch and patient (reads; no lock yet) ---
  let callLogId = selection.callLogId ?? ctx.trustedBooking?.callLogId ?? null;
  let clinicId = selection.clinicId ?? ctx.trustedBooking?.clinicId ?? null;
  let locationId = selection.locationId ?? ctx.trustedBooking?.locationId ?? null;
  let callLogPatientId: string | null = null;
  if (!callLogId && safeCallId) {
    const log = await db.receptionistCallLog.findFirst({
      where: { tenantId, retellCallId: safeCallId },
      select: { id: true, clinicId: true, patientId: true },
    });
    callLogId = log?.id ?? null;
    clinicId = clinicId ?? log?.clinicId ?? null;
    callLogPatientId = log?.patientId ?? null;
  } else if (callLogId) {
    const log = await db.receptionistCallLog.findFirst({ where: { id: callLogId, tenantId }, select: { clinicId: true, patientId: true } });
    clinicId = clinicId ?? log?.clinicId ?? null;
    callLogPatientId = log?.patientId ?? null;
  }

  let branch: { id: string; timezone: string } | null = null;
  const explicitBranchId = selection.branchId ?? ctx.trustedBooking?.branchId ?? null;
  if (explicitBranchId) {
    branch = await db.branch.findFirst({ where: { id: explicitBranchId, tenantId }, select: { id: true, timezone: true } });
  }
  if (!branch && clinicId) {
    const locations = await db.receptionistLocation.findMany({
      where: { tenantId, clinicId, active: true, branchId: { not: null } },
      select: { id: true, branch: { select: { id: true, timezone: true } } },
      take: 2,
    });
    if (locations.length === 1 && locations[0].branch) {
      branch = locations[0].branch;
      locationId = locationId ?? locations[0].id;
    }
  }
  if (!branch) {
    const branches = await db.branch.findMany({ where: { tenantId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true, timezone: true }, take: 2 });
    branch = branches.length === 1 ? branches[0] : null;
  }

  let patientId: string | null = selection.verifiedPatientId ?? null;
  let patientSource: 'verified_identity' | 'patient_phone_match' | null = patientId ? 'verified_identity' : null;
  if (!patientId && safeCallId) {
    const verified = await db.idempotencyKey.findUnique({
      where: { scope_key: { scope: 'receptionist.voice-identity', key: `${tenantId}:${safeCallId}` } },
      select: { resultId: true },
    });
    if (verified?.resultId && UUID_RE.test(verified.resultId)) { patientId = verified.resultId; patientSource = 'verified_identity'; }
  }
  if (!patientId && callLogPatientId) patientId = callLogPatientId;
  if (!patientId && verifiedPhone) {
    // Never link on a requested (unverified) number; only on the envelope number, and only when unambiguous.
    const matches = await patientsByCanonicalPhone(db, tenantId, verifiedPhone);
    if (matches.length === 1) { patientId = matches[0].id; patientSource = 'patient_phone_match'; }
  }

  const clinicTimezone = clinicId
    ? (await db.receptionistClinic.findFirst({ where: { id: clinicId, tenantId }, select: { timezone: true } }))?.timezone ?? null
    : null;
  const timezone = selection.branchTimezone ?? ctx.trustedBooking?.branchTimezone ?? branch?.timezone ?? clinicTimezone ?? 'UTC';
  const callbackWindow = parseCallbackWindow(args.callback_window, timezone);

  const policy = await resolveFrontDeskPolicy(tenantId, clinicId);
  const sla = kind === 'emergency'
    ? { dueMinutes: 0, priority: 'critical' as const }
    : kind === 'deployment_attention'
      // The worker downgrades to 'medium' while a transient probe failure is
      // still far from the expiry; anything else is the line going quiet.
      ? { dueMinutes: DEPLOYMENT_ATTENTION_DUE_MINUTES, priority: normalizeTaskPriority(args.priority) ?? 'critical' as const }
      : policy.sla[kind as SlaKind] ?? DEFAULT_FRONT_DESK_POLICY.sla[kind as SlaKind];
  const now = new Date();
  // Pilot cut: the window is stored as given; dueAt = start (no clipping to opening hours).
  const dueAt = kind === 'emergency'
    ? now
    : callbackWindow ? new Date(callbackWindow.start) : new Date(now.getTime() + sla.dueMinutes * 60_000);

  // Retell normally supplies call_id. Without one, hash minimum-necessary inputs
  // into a short time bucket so provider retries stay safe and no content leaks.
  const fallbackDigest = createHash('sha256')
    .update(JSON.stringify({ tenantId, kind, verifiedPhone, requestedCallbackPhone, callerName, message, reasonCategory, bucket: Math.floor(Date.now() / 600_000) }))
    .digest('hex');
  const idemKey = ctx.idempotencyKey
    ?? (safeCallId ? `${tenantId}:${safeCallId}:${kind}` : `${tenantId}:fallback:${fallbackDigest}`);
  // D5: hashtextextended everywhere. `hashtext` and `hashtextextended` are
  // different functions over the same string, so the two namespaces never
  // collided and never serialised each other.
  const lockKey = `receptionist-safety:${idemKey}`;

  const auditBase = {
    workflow: kind, kind, branchId: branch?.id ?? null, clinicId,
    callLogIdPresent: Boolean(callLogId), callIdPresent: Boolean(safeCallId),
    patientLinked: Boolean(patientId), hasCallbackPhone: Boolean(requestedCallbackPhone ?? verifiedPhone),
    hasRequestedPhone: Boolean(requestedCallbackPhone), hasWindow: Boolean(callbackWindow), source,
  };

  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))`;
    const prior = await tx.idempotencyKey.findUnique({
      where: { scope_key: { scope: 'receptionist.live-safety', key: idemKey } },
      select: { id: true, resultId: true },
    });
    if (prior?.resultId) {
      // D5: take the per-task lock BEFORE reading the row we are about to
      // read-modify-write, so a staff note landing at the same instant cannot
      // be overwritten by the message we are appending (and vice versa).
      await lockStaffTask(tx, tenantId, prior.resultId);
      const existing = await tx.staffTask.findFirst({
        where: { id: prior.resultId, tenantId },
        select: { id: true, status: true, metadata: true },
      });
      if (existing && (LIVE_TASK_STATUSES as readonly string[]).includes(existing.status)) {
        const parse = parseReceptionistTaskDetailed(existing)
          ?? { meta: receptionistTaskMetadata.parse({ workflow: RECEPTIONIST_TASK_WORKFLOW, kind }), degraded: false, raw: {} };
        const current = parse.meta;
        const alreadyRecorded = Boolean(invocationId) && current.messages.some(entry => entry.invocationId === invocationId);
        const lastText = current.messages.at(-1)?.text ?? current.message;
        const appendMessage = Boolean(message) && !alreadyRecorded && lastText !== message;
        const newRequestedPhone = requestedCallbackPhone && !current.requestedCallbackPhone ? requestedCallbackPhone : null;
        const newCallerName = callerName && !current.callerName ? callerName : null;
        if (!appendMessage && !newRequestedPhone && !newCallerName) {
          return { taskId: existing.id, duplicate: true, appended: false };
        }
        const messages = appendMessage
          ? [...current.messages, { text: message!, recordedAt: now.toISOString(), invocationId }].slice(-MAX_MESSAGES)
          : current.messages;
        // D3: merged onto the stored blob, never written as the degraded view.
        const next = mergeReceptionistTaskMetadata(parse, {
          messages,
          message: appendMessage ? message : current.message,
          requestedCallbackPhone: newRequestedPhone ?? current.requestedCallbackPhone,
          callbackPhone: newRequestedPhone ?? current.callbackPhone ?? verifiedPhone,
          callerName: newCallerName ?? current.callerName,
        });
        await tx.staffTask.update({ where: { id: existing.id }, data: { metadata: next } });
        await tx.auditEvent.create({ data: {
          tenantId, actorUserId: null, action: `receptionist.safety.${kind}.appended`, resource: 'staffTask', resourceId: existing.id,
          userAgent: 'retell-webhook',
          metadata: { ...auditBase, appended: appendMessage, messageCount: messages.length, requestedPhoneAdded: Boolean(newRequestedPhone) },
        } });
        if (newCallerName && callLogId) {
          await stampCallerIdentity(tx, { tenantId, callLogId, callerName: newCallerName, source: 'take_message' });
        }
        return { taskId: existing.id, duplicate: false, appended: appendMessage };
      }
    }
    // Stale key (terminal or vanished task): a new message must never be swallowed.
    if (prior) await tx.idempotencyKey.delete({ where: { id: prior.id } });

    const metadata: ReceptionistTaskMetadata = {
      workflow: RECEPTIONIST_TASK_WORKFLOW,
      kind,
      source,
      callId: safeCallId,
      clinicId,
      locationId,
      callerName,
      verifiedPhone,
      requestedCallbackPhone,
      callbackPhone: requestedCallbackPhone ?? verifiedPhone,
      messages: message ? [{ text: message, recordedAt: now.toISOString(), invocationId }] : [],
      message,
      reasonCategory,
      callbackWindow,
      transferStatus: 'not_attempted',
      transferUpdatedAt: null,
      toolName,
      denialReason,
      appointmentRequestId: optionalUuid(args.appointment_request_id),
      appointmentId: optionalUuid(args.appointment_id),
      ...deployment,
      requiresAcknowledgement: true,
      staffNotes: [],
    };
    const task = await tx.staffTask.create({
      data: {
        tenantId,
        branchId: branch?.id,
        title: deployment.remediationTitle ?? TASK_TITLES[kind],
        priority: sla.priority,
        dueAt,
        patientId,
        callLogId,
        metadata: metadata as unknown as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    await tx.idempotencyKey.create({ data: { tenantId, scope: 'receptionist.live-safety', key: idemKey, resultId: task.id } });
    await tx.auditEvent.create({ data: {
      tenantId, actorUserId: null, action: `receptionist.safety.${kind}.created`, resource: 'staffTask', resourceId: task.id,
      userAgent: 'retell-webhook',
      metadata: { ...auditBase, appended: false, priority: sla.priority },
    } });
    if (kind === 'emergency') {
      await tx.operationalSignal.create({ data: {
        tenantId, signalType: 'receptionist_emergency_mention', entityType: 'staffTask', entityId: task.id,
        severity: 'critical', score: 100,
        reason: 'Emergency language was reported during an AI receptionist call; staff acknowledgment is required.',
      } });
    }
    await tx.businessEvent.create({ data: {
      tenantId, eventType: `receptionist.safety.${kind}.created`, entityType: 'staffTask', entityId: task.id,
      sourceModule: 'receptionist', payload: { workflow: kind, kind, acknowledgmentRequired: true, priority: sla.priority },
    } });
    if (callLogId && (callerName || (patientId && patientSource))) {
      await stampCallerIdentity(tx, {
        tenantId, callLogId,
        callerName: callerName ?? undefined,
        patientId: patientSource ? patientId : undefined,
        source: patientSource ?? 'take_message',
      });
    }
    return { taskId: task.id, duplicate: false, appended: false };
  });
}

// ---------------------------------------------------------------------------
// markTransferOutcome — the single provider-proved closure.
// ---------------------------------------------------------------------------

export type TransferOutcome = Exclude<TransferStatus, 'not_attempted'>;

/**
 * Called from `call_ended` (C3 webhooks.ts) with the outcome mapped from Retell's
 * `disconnection_reason`: `call_transfer` → connected, otherwise unknown. Updates
 * every live human_handoff task for the call; `connected` completes it with
 * outcome `transferred` because the provider proved the loop was closed.
 */
export async function markTransferOutcome(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; callLogId: string; outcome: TransferOutcome; retellCallId?: string | null },
): Promise<{ updated: number; completed: number }> {
  const candidates = await tx.staffTask.findMany({
    where: {
      tenantId: input.tenantId,
      status: { in: [...LIVE_TASK_STATUSES] },
      AND: [
        { metadata: { path: ['workflow'], equals: RECEPTIONIST_TASK_WORKFLOW } },
        { metadata: { path: ['kind'], equals: 'human_handoff' } },
        { OR: [
          { callLogId: input.callLogId },
          ...(input.retellCallId ? [{ metadata: { path: ['callId'], equals: input.retellCallId } }] : []),
        ] },
      ],
    },
    // Deterministic order: two concurrent call_ended webhooks for the same call
    // must take the per-task locks in the same sequence or they deadlock.
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  const now = new Date();
  let completed = 0;
  const tasks: Array<{ id: string }> = [];
  for (const candidate of candidates) {
    // D5: this path used to take no lock at all, so a transfer outcome landing
    // beside a staff note dropped one of them. Lock, then re-read: the row may
    // have changed between the scan above and the lock below.
    await lockStaffTask(tx, input.tenantId, candidate.id);
    const task = await tx.staffTask.findFirst({
      where: { id: candidate.id, tenantId: input.tenantId, status: { in: [...LIVE_TASK_STATUSES] } },
      select: { id: true, metadata: true },
    });
    if (!task) continue;
    const parse = parseReceptionistTaskDetailed(task);
    if (!parse) continue;
    tasks.push({ id: task.id });
    // D3: merged onto the stored blob, so a degraded row keeps its messages.
    const next = mergeReceptionistTaskMetadata(parse, { transferStatus: input.outcome, transferUpdatedAt: now.toISOString() });
    const closes = input.outcome === 'connected';
    if (closes) completed += 1;
    await tx.staffTask.update({
      where: { id: task.id },
      data: {
        metadata: next,
        ...(closes ? { status: 'COMPLETED', completedAt: now, outcomeCode: 'transferred' } : {}),
      },
    });
    await tx.auditEvent.create({ data: {
      tenantId: input.tenantId, actorUserId: null, action: 'receptionist.safety.human_handoff.transferOutcome',
      resource: 'staffTask', resourceId: task.id, userAgent: 'retell-webhook',
      metadata: { transferStatus: input.outcome, completed: closes, callLogId: input.callLogId },
    } });
  }
  return { updated: tasks.length, completed };
}

// ---------------------------------------------------------------------------
// D9 — deployment attention: the task that says the line stopped answering.
// ---------------------------------------------------------------------------

export interface DeploymentAttentionInput {
  tenantId: string;
  /** The receptionist agent whose verification lapsed or drifted. */
  agentId: string;
  clinicId: string;
  /** The readiness/verification failure code the remediation catalogue keys on. */
  code: string;
  /** Remediation copy from `remediationFor(code, ctx)` - the words staff act on. */
  title: string;
  action: string;
  fixHref: string | null;
  /**
   * 'critical' (default) when the line is off the air; 'medium' while a
   * transient probe failure is still far from the expiry.
   */
  priority?: TaskPriority;
}

/**
 * File the deployment-attention task through the ONE contract the board reads.
 *
 * Before this, `agentReverification` wrote its own StaffTask with
 * `workflow: 'receptionist_deployment'` - which `parseReceptionistTask` rejects
 * - and `priority: 'HIGH'` while the critical banner looks for lowercase
 * 'critical'. Badge, banner, header count and every lane therefore excluded the
 * one task that says the receptionist is not answering.
 *
 * Idempotency is (agent, code) exactly as before, and live-status scoped like
 * every other safety task: one open row per failing agent per code, and a NEW
 * row once someone has closed the last one, so a still-broken agent cannot be
 * silenced by yesterday's acknowledgment.
 *
 * Package A owns `agentReverification.ts`; this is the entry point it calls in
 * place of its private `raiseAttention`.
 */
export async function fileDeploymentAttentionTask(input: DeploymentAttentionInput): Promise<SafetyTaskResult> {
  return createSafetyTask(
    {
      tenantId: input.tenantId,
      callId: null,
      idempotencyKey: `${input.tenantId}:agent:${input.agentId}:${input.code}`,
      selection: { clinicId: input.clinicId },
    },
    'deployment_attention',
    {
      source: 'system',
      reason_category: 'deployment',
      agent_id: input.agentId,
      code: input.code,
      remediation_title: input.title,
      remediation_action: input.action,
      fix_href: input.fixHref,
      priority: input.priority ?? 'critical',
    },
  );
}

// ---------------------------------------------------------------------------
// stampCallerIdentity — caller identity on the call row (M19)
// ---------------------------------------------------------------------------

export type CallerIdentitySource = 'patient_phone_match' | 'verified_identity' | 'take_message' | 'staff';

/**
 * Rules: `patientId` is written only from a verified identity or a single
 * canonical phone match (never from a caller-stated number); a phone match
 * never overwrites an existing link, a verified identity may. `callerName`
 * from take_message only fills a null (never overwrites a verified name);
 * verified/staff names win. Never downgrades.
 */
export async function stampCallerIdentity(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    callLogId?: string | null;
    retellCallId?: string | null;
    patientId?: string | null;
    callerName?: string | null;
    source: CallerIdentitySource;
  },
): Promise<{ stamped: boolean }> {
  const where = input.callLogId
    ? { id: input.callLogId, tenantId: input.tenantId }
    : input.retellCallId ? { retellCallId: input.retellCallId, tenantId: input.tenantId } : null;
  if (!where) return { stamped: false };
  const current = await tx.receptionistCallLog.findFirst({ where, select: { id: true, patientId: true, callerName: true } });
  if (!current) return { stamped: false };

  const data: Prisma.ReceptionistCallLogUpdateInput = {};
  const strongIdentity = input.source === 'verified_identity' || input.source === 'staff';
  if (input.patientId && (input.source === 'verified_identity' || input.source === 'patient_phone_match')) {
    if (!current.patientId || (strongIdentity && current.patientId !== input.patientId)) {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: input.tenantId, deletedAt: null }, select: { id: true, firstName: true, lastName: true } });
      if (patient) {
        data.patient = { connect: { tenantId_id: { tenantId: input.tenantId, id: patient.id } } };
        if (!current.callerName || strongIdentity) {
          const fullName = `${patient.firstName} ${patient.lastName}`.trim();
          if (fullName) data.callerName = fullName;
        }
      }
    }
  }
  const callerName = sanitizeTaskText(input.callerName, MAX_NAME);
  if (callerName && data.callerName === undefined) {
    if (strongIdentity || !current.callerName) data.callerName = callerName;
  }
  if (Object.keys(data).length === 0) return { stamped: false };
  await tx.receptionistCallLog.update({ where: { id: current.id }, data });
  return { stamped: true };
}
