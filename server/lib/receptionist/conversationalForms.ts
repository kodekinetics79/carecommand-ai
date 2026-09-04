import type { Prisma } from '../../generated/prisma/client';
import { db } from '../db';
import { isValidE164, toE164 } from '../campaigns';
import {
  intakeFieldKey,
  MAX_INTAKE_FIELDS,
  type IntakeFieldConfiguration,
  type IntakeFieldType,
} from '../../modules/receptionist/intakeContract';

const CALL_LEASE_MS = 4 * 60 * 60 * 1_000;
const MAX_FORM_JSON_BYTES = 16 * 1024;
const MAX_TEXT = 500;
const FORM_SCOPE = 'receptionist.conversational-form';
const FORM_ATTEMPT_SCOPE = 'receptionist.conversational-form-attempt';

export interface ConversationalFormContext {
  tenantId: string;
  callId: string | null;
  callerPhone?: string | null;
  providerInvocationId?: string;
}

export interface ConversationalFormResult {
  saved: boolean;
  submitted: boolean;
  duplicate?: boolean;
  needs_review?: boolean;
  packet_id?: string;
  missing_fields?: string[];
  invalid_fields?: string[];
  message: string;
}

type FormField = IntakeFieldConfiguration & { id: string };
type StoredAnswer = {
  value: string | boolean;
  source: 'ai_extracted_from_conversation' | 'provider_observed_call_identity';
  confirmed: boolean;
  observedAt: string;
};
type StoredFormData = {
  formVersion: 1;
  campaignId: string;
  callLogId: string;
  answers: Record<string, StoredAnswer>;
};

function safeObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseBoundedObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return safeObject(value);
  if (Buffer.byteLength(value, 'utf8') > MAX_FORM_JSON_BYTES) return null;
  try {
    return safeObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function sanitizeText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null;
  let safe = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    safe += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  const collapsed = safe.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '').replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, max) : null;
}

function canonicalPhone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const phone = toE164(value);
  return isValidE164(phone) ? phone : null;
}

function fieldValue(field: FormField, raw: unknown, observedPhone: string | null): string | boolean | null {
  if (field.fieldType === 'PHONE') return observedPhone;
  if (field.fieldType === 'CONSENT' || field.fieldType === 'CUSTOM_YES_NO') {
    return typeof raw === 'boolean' ? raw : null;
  }
  const text = sanitizeText(raw, field.fieldType === 'REASON_FOR_VISIT' || field.fieldType === 'CUSTOM_TEXT' ? 300 : 160);
  if (!text) return null;
  switch (field.fieldType as IntakeFieldType) {
    case 'EMAIL': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
    case 'PREFERRED_DATE': return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
    case 'PREFERRED_TIME': return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : null;
    case 'PATIENT_STATUS': return ['new', 'existing'].includes(text.toLowerCase()) ? text.toLowerCase() : null;
    case 'CUSTOM_DROPDOWN': {
      const option = (field.options ?? []).find(item => item.toLowerCase() === text.toLowerCase());
      return option ?? null;
    }
    default: return text;
  }
}

function confirmationMap(value: unknown): Record<string, boolean> {
  const parsed = parseBoundedObject(value);
  if (!parsed) return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
}

function existingStoredData(value: unknown): StoredFormData | null {
  const object = safeObject(value);
  if (!object || object.formVersion !== 1 || typeof object.campaignId !== 'string' || typeof object.callLogId !== 'string') return null;
  const answers = safeObject(object.answers);
  if (!answers) return null;
  const normalized: Record<string, StoredAnswer> = {};
  for (const [key, answer] of Object.entries(answers)) {
    const item = safeObject(answer);
    if (!item || !['string', 'boolean'].includes(typeof item.value) || typeof item.confirmed !== 'boolean' || typeof item.observedAt !== 'string') continue;
    const source = item.source === 'provider_observed_call_identity' ? item.source : 'ai_extracted_from_conversation';
    normalized[key] = { value: item.value as string | boolean, confirmed: item.confirmed, observedAt: item.observedAt, source };
  }
  return { formVersion: 1, campaignId: object.campaignId, callLogId: object.callLogId, answers: normalized };
}

async function resolveVerifiedPatient(tenantId: string, callId: string): Promise<string | null> {
  const proof = await db.idempotencyKey.findUnique({
    where: { scope_key: { scope: 'receptionist.voice-identity', key: `${tenantId}:${callId}` } },
    select: { resultId: true },
  });
  if (!proof?.resultId) return null;
  const patient = await db.patient.findFirst({ where: { id: proof.resultId, tenantId, deletedAt: null }, select: { id: true } });
  return patient?.id ?? null;
}

function formAttemptKey(ctx: ConversationalFormContext, callLogId: string) {
  return `${ctx.tenantId}:${callLogId}:${ctx.providerInvocationId}`;
}

function formKey(tenantId: string, callLogId: string, campaignId: string) {
  return `${tenantId}:${callLogId}:${campaignId}`;
}

/**
 * Persist one AI-completed conversational form against the exact active call.
 *
 * The model never chooses a patient, campaign, appointment, lead, or form
 * template. All of those are derived from the signed provider call and the
 * campaign already bound to that call. That keeps survey/intake/form capture on
 * the same tenant/call boundary as booking and identity verification.
 */
export async function submitConversationalForm(
  ctx: ConversationalFormContext,
  args: Record<string, unknown>,
): Promise<ConversationalFormResult> {
  if (!ctx.callId || !ctx.providerInvocationId) {
    return { saved: false, submitted: false, needs_review: true, message: 'I cannot bind this form to the exact active call. I can connect you with the front desk.' };
  }
  const answersInput = parseBoundedObject(args.answers_json ?? args.answers);
  const confirmations = confirmationMap(args.confirmations_json ?? args.confirmations);
  if (!answersInput) {
    return { saved: false, submitted: false, invalid_fields: ['form_payload'], message: 'I need to collect those answers again before I can save the form.' };
  }
  const finalize = args.finalize === true;

  const call = await db.receptionistCallLog.findFirst({
    where: { tenantId: ctx.tenantId, retellCallId: ctx.callId },
    select: {
      id: true, campaignId: true, targetId: true, patientId: true, clinicId: true,
      recordingConsentStatus: true, startedAt: true, createdAt: true, endedAt: true,
    },
  });
  const activeSince = call?.startedAt ?? call?.createdAt;
  if (!call || !call.campaignId || call.recordingConsentStatus !== 'GRANTED' || call.endedAt
    || !activeSince || activeSince.getTime() < Date.now() - CALL_LEASE_MS) {
    return { saved: false, submitted: false, needs_review: true, message: 'I cannot revalidate the active call and form configuration. I can connect you with the front desk.' };
  }

  const [campaign, configuredFields, target, request, verifiedPatientId] = await Promise.all([
    db.receptionistCampaign.findFirst({
      where: { id: call.campaignId, tenantId: ctx.tenantId, clinicId: call.clinicId ?? undefined, status: 'ACTIVE' },
      select: { id: true, name: true },
    }),
    db.receptionistIntakeField.findMany({
      where: { tenantId: ctx.tenantId, campaignId: call.campaignId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: MAX_INTAKE_FIELDS + 1,
    }),
    call.targetId ? db.receptionistCallTarget.findFirst({
      where: { id: call.targetId, tenantId: ctx.tenantId },
      select: { patientId: true, leadId: true, appointmentId: true },
    }) : Promise.resolve(null),
    db.appointmentRequest.findFirst({
      where: { tenantId: ctx.tenantId, callLogId: call.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, patientId: true, leadId: true, bookedAppointmentId: true },
    }),
    resolveVerifiedPatient(ctx.tenantId, ctx.callId),
  ]);
  if (!campaign || configuredFields.length === 0 || configuredFields.length > MAX_INTAKE_FIELDS) {
    return { saved: false, submitted: false, needs_review: true, message: 'This call does not have one valid conversational form configured. I can connect you with the front desk.' };
  }

  const fields: FormField[] = configuredFields.map(field => ({
    id: field.id,
    fieldType: field.fieldType as IntakeFieldType,
    label: field.label,
    aiQuestion: field.aiQuestion,
    validationRule: field.validationRule,
    options: Array.isArray(field.options) ? field.options.filter((value): value is string => typeof value === 'string') : [],
    required: field.required,
    confirmationRequired: field.confirmationRequired,
    sortOrder: field.sortOrder,
  }));

  const patientId = verifiedPatientId ?? call.patientId ?? target?.patientId ?? request?.patientId ?? null;
  const leadId = target?.leadId ?? request?.leadId ?? null;
  const appointmentId = target?.appointmentId ?? request?.bookedAppointmentId ?? null;
  const appointmentRequestId = request?.id ?? null;
  if (!patientId && !leadId && !appointmentId && !appointmentRequestId) {
    return { saved: false, submitted: false, needs_review: true, message: 'I need a patient or appointment record before I can attach this form. I can connect you with the front desk.' };
  }

  const observedPhone = canonicalPhone(ctx.callerPhone ?? null);
  const attemptKey = formAttemptKey(ctx, call.id);
  const result = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conversational-form:${ctx.tenantId}:${call.id}`}::text, 0))::text AS locked`;
    const priorAttempt = await tx.idempotencyKey.findUnique({
      where: { scope_key: { scope: FORM_ATTEMPT_SCOPE, key: attemptKey } },
      select: { resultId: true },
    });
    if (priorAttempt?.resultId) {
      try { return JSON.parse(priorAttempt.resultId) as ConversationalFormResult; }
      catch { /* fall through and repair the attempt receipt */ }
    }

    const key = formKey(ctx.tenantId, call.id, campaign.id);
    const priorPacketKey = await tx.idempotencyKey.findUnique({
      where: { scope_key: { scope: FORM_SCOPE, key } },
      select: { resultId: true },
    });
    let packet = priorPacketKey?.resultId
      ? await tx.patientIntakePacket.findFirst({ where: { id: priorPacketKey.resultId, tenantId: ctx.tenantId }, select: { id: true, status: true } })
      : null;
    if (packet?.status === 'submitted') {
      const replay: ConversationalFormResult = { saved: true, submitted: true, duplicate: true, packet_id: packet.id, message: 'That form is already completed and saved.' };
      await tx.idempotencyKey.upsert({
        where: { scope_key: { scope: FORM_ATTEMPT_SCOPE, key: attemptKey } },
        update: { tenantId: ctx.tenantId, resultId: JSON.stringify(replay) },
        create: { tenantId: ctx.tenantId, scope: FORM_ATTEMPT_SCOPE, key: attemptKey, resultId: JSON.stringify(replay) },
      });
      return replay;
    }

    if (!packet) {
      packet = await tx.patientIntakePacket.create({
        data: {
          tenantId: ctx.tenantId,
          patientId,
          leadId,
          appointmentId,
          appointmentRequestId,
          status: 'in_progress',
          source: 'ai_receptionist',
          startedAt: new Date(),
          metadata: {
            kind: 'conversational_form',
            campaignId: campaign.id,
            campaignName: campaign.name,
            callLogId: call.id,
            source: 'signed_voice_tool',
          },
        },
        select: { id: true, status: true },
      });
      await tx.patientIntakeSection.create({
        data: {
          tenantId: ctx.tenantId,
          packetId: packet.id,
          sectionType: 'custom',
          status: 'pending',
          data: { formVersion: 1, campaignId: campaign.id, callLogId: call.id, answers: {} },
        },
      });
      await tx.idempotencyKey.upsert({
        where: { scope_key: { scope: FORM_SCOPE, key } },
        update: { tenantId: ctx.tenantId, resultId: packet.id },
        create: { tenantId: ctx.tenantId, scope: FORM_SCOPE, key, resultId: packet.id },
      });
    }

    const section = await tx.patientIntakeSection.findFirst({
      where: { tenantId: ctx.tenantId, packetId: packet.id, sectionType: 'custom' },
      select: { id: true, data: true },
    });
    if (!section) throw new Error('conversational_form_section_missing');
    const stored = existingStoredData(section.data) ?? { formVersion: 1 as const, campaignId: campaign.id, callLogId: call.id, answers: {} };
    const merged: Record<string, StoredAnswer> = { ...stored.answers };
    const invalid: string[] = [];
    const now = new Date().toISOString();
    const allowedKeys = new Set(fields.map(field => intakeFieldKey(field)));
    for (const key of Object.keys(answersInput)) if (!allowedKeys.has(key)) invalid.push(key);

    for (const field of fields) {
      const keyName = intakeFieldKey(field);
      const raw = answersInput[keyName];
      if (raw === undefined && field.fieldType !== 'PHONE') continue;
      const value = fieldValue(field, raw, observedPhone);
      if (value === null) {
        if (raw !== undefined || field.fieldType === 'PHONE') invalid.push(keyName);
        continue;
      }
      merged[keyName] = {
        value,
        source: field.fieldType === 'PHONE' ? 'provider_observed_call_identity' : 'ai_extracted_from_conversation',
        confirmed: field.confirmationRequired ? confirmations[keyName] === true : true,
        observedAt: now,
      };
    }

    const missing = fields
      .filter(field => field.required)
      .filter(field => {
        const answer = merged[intakeFieldKey(field)];
        return !answer || (field.confirmationRequired && !answer.confirmed);
      })
      .map(field => field.label);
    const uniqueInvalid = [...new Set(invalid)].sort();
    const submitted = finalize && missing.length === 0 && uniqueInvalid.length === 0;
    const packetStatus = submitted ? 'submitted' : finalize ? 'needs_review' : 'in_progress';
    const safeData: StoredFormData = { formVersion: 1, campaignId: campaign.id, callLogId: call.id, answers: merged };
    await tx.patientIntakeSection.update({
      where: { id: section.id },
      data: { data: safeData as unknown as Prisma.InputJsonValue, status: submitted ? 'completed' : 'pending', completedAt: submitted ? new Date() : null },
    });
    await tx.patientIntakePacket.update({
      where: { id: packet.id },
      data: {
        status: packetStatus,
        readinessScore: submitted ? 100 : Math.round(((fields.length - missing.length) / Math.max(1, fields.length)) * 100),
        submittedAt: submitted ? new Date() : null,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: ctx.tenantId,
        actorUserId: null,
        action: submitted ? 'receptionist.form.submitted' : 'receptionist.form.progressed',
        resource: 'patientIntake',
        resourceId: packet.id,
        userAgent: 'retell-webhook',
        metadata: {
          callLogId: call.id,
          campaignId: campaign.id,
          answerCount: Object.keys(merged).length,
          missingCount: missing.length,
          invalidCount: uniqueInvalid.length,
          finalized: finalize,
        },
      },
    });
    await tx.businessEvent.create({
      data: {
        tenantId: ctx.tenantId,
        eventType: submitted ? 'receptionist.form.submitted' : finalize ? 'receptionist.form.needs_review' : 'receptionist.form.progressed',
        entityType: 'patientIntakePacket',
        entityId: packet.id,
        sourceModule: 'receptionist',
        payload: { campaignId: campaign.id, callLogId: call.id, submitted, missingCount: missing.length, invalidCount: uniqueInvalid.length },
      },
    });

    const response: ConversationalFormResult = submitted
      ? { saved: true, submitted: true, packet_id: packet.id, message: 'Thank you. I completed and saved that form.' }
      : {
          saved: true,
          submitted: false,
          needs_review: finalize || undefined,
          packet_id: packet.id,
          missing_fields: missing,
          invalid_fields: uniqueInvalid,
          message: finalize
            ? 'I saved what we completed and flagged the remaining items for staff review.'
            : missing.length
              ? `I saved that. I still need ${missing.join(', ')}.`
              : uniqueInvalid.length
                ? 'I saved the valid answers, but I need to confirm a few fields again.'
                : 'I saved those answers. We can continue with the remaining questions.',
        };
    await tx.idempotencyKey.upsert({
      where: { scope_key: { scope: FORM_ATTEMPT_SCOPE, key: attemptKey } },
      update: { tenantId: ctx.tenantId, resultId: JSON.stringify(response) },
      create: { tenantId: ctx.tenantId, scope: FORM_ATTEMPT_SCOPE, key: attemptKey, resultId: JSON.stringify(response) },
    });
    return response;
  });

  return result;
}
