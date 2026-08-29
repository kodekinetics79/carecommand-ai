import { randomBytes, createHmac, createHash } from 'node:crypto';
import { db } from './db';
import { env } from './../config/env';
import { runWithTenantContext } from './tenantContext';
import { emitBusinessEvent, upsertSignal, createRecommendation } from './intelligence';
import { lockSuppressionFences } from './receptionist/dncFence';
import type { Prisma } from '../generated/prisma/client';

// ===========================================================================
// Patient Intake + Consent engine. Prepares patients before the visit, captures
// consent (reconciled with CommunicationConsent), links insurance/estimate/
// payment context, and raises rule-based gaps for staff. No PHI in logs/events;
// documents are metadata-only unless real object storage exists. Public access
// uses a hashed, expiring, packet-scoped token.
// ===========================================================================

export const SECTION_TYPES = [
  'demographics', 'communication_consent', 'insurance', 'insurance_card', 'photo_id',
  'payment_policy', 'estimate_acknowledgement', 'consent_forms', 'pre_visit_checklist', 'custom',
] as const;
export type SectionType = typeof SECTION_TYPES[number];

// Approved acknowledgement copy is server-owned and versioned. Clients submit
// only the exact identifier returned in publicView; arbitrary text or a missing
// checkbox can never be interpreted as acceptance.
export const INTAKE_ACKNOWLEDGEMENTS = {
  estimate_acknowledgement: {
    id: 'estimate_acknowledgement:v1',
    version: 'v1',
    text: 'I understand the patient responsibility amount presented is an estimate, not a guarantee, and may change after insurer adjudication.',
  },
} as const;

type AcknowledgementSection = keyof typeof INTAKE_ACKNOWLEDGEMENTS;

function approvedAcknowledgement(sectionType: string) {
  return sectionType in INTAKE_ACKNOWLEDGEMENTS
    ? INTAKE_ACKNOWLEDGEMENTS[sectionType as AcknowledgementSection]
    : null;
}

const REQUIRED_FOR_READINESS: SectionType[] = ['demographics', 'communication_consent', 'pre_visit_checklist'];
const TOKEN_TTL_DAYS = 7;

// Object storage is not wired — documents stay metadata-only (truthful).
export const OBJECT_STORAGE_ENABLED = false;

// --- Token + hashing helpers -----------------------------------------------
export function newIntakeToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('hex');
  return { token, hash: hashIntakeToken(token) };
}
export function hashIntakeToken(token: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`intake:${token}`).digest('hex');
}
export function hashValue(value: string | undefined | null): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

async function writeAudit(
  tenantId: string,
  actorUserId: string | null,
  action: string,
  resourceId: string,
  metadata: Prisma.InputJsonObject,
  options: { tx?: Prisma.TransactionClient; critical?: boolean } = {},
) {
  const write = (options.tx ?? db).auditEvent.create({ data: { tenantId, actorUserId: actorUserId ?? undefined, action, resource: 'patientIntake', resourceId, userAgent: 'intake-engine', metadata } });
  if (options.critical) await write;
  else await write.catch(() => {});
}

// --- Context resolution + section planning ---------------------------------
interface PacketTarget { appointmentId?: string | null; appointmentRequestId?: string | null; patientId?: string | null; leadId?: string | null }

async function resolveContext(tenantId: string, target: PacketTarget) {
  let patientId = target.patientId ?? null;
  let appointmentId = target.appointmentId ?? null;
  const appointmentRequestId = target.appointmentRequestId ?? null;
  let leadId = target.leadId ?? null;

  if (appointmentId && !patientId) {
    const appt = await db.appointment.findFirst({ where: { id: appointmentId, tenantId }, select: { patientId: true } });
    patientId = appt?.patientId ?? null;
  }
  if (appointmentRequestId && !patientId) {
    const req = await db.appointmentRequest.findFirst({ where: { id: appointmentRequestId, tenantId }, select: { patientId: true, leadId: true } });
    patientId = req?.patientId ?? patientId;
    leadId = req?.leadId ?? leadId;
    if (!appointmentId) appointmentId = null;
  }
  return { patientId, appointmentId, appointmentRequestId, leadId };
}

// Decide which sections a packet needs from real data (no fake completeness).
async function planSections(tenantId: string, ctx: { patientId: string | null; appointmentId: string | null }): Promise<SectionType[]> {
  const sections: SectionType[] = ['demographics', 'communication_consent'];
  let needsInsurance = true, needsCard = true;
  if (ctx.patientId) {
    const policy = await db.patientInsurancePolicy.findFirst({ where: { tenantId, patientId: ctx.patientId, active: true }, select: { id: true, verificationStatus: true } });
    needsInsurance = !policy || ['inactive', 'needs_review', 'expired', 'pending'].includes(policy.verificationStatus);
    needsCard = needsInsurance;
  }
  if (needsInsurance) sections.push('insurance');
  if (needsCard) sections.push('insurance_card');
  sections.push('photo_id');

  // Payment policy when a deposit is owed or a payment failed/expired.
  let needsPayment = false;
  if (ctx.appointmentId) {
    const [dep, pr] = await Promise.all([
      db.depositRequirement.findFirst({ where: { tenantId, appointmentId: ctx.appointmentId, status: { in: ['required', 'requested', 'link_sent'] } }, select: { id: true } }),
      db.paymentRequest.findFirst({ where: { tenantId, appointmentId: ctx.appointmentId, status: { in: ['failed', 'expired', 'link_sent'] } }, select: { id: true } }),
    ]);
    needsPayment = Boolean(dep || pr);
  }
  if (needsPayment) sections.push('payment_policy');

  // Estimate acknowledgement when a responsibility estimate exists.
  const estWhere = ctx.appointmentId ? { tenantId, appointmentId: ctx.appointmentId } : ctx.patientId ? { tenantId, patientId: ctx.patientId } : null;
  if (estWhere) {
    const est = await db.patientResponsibilityEstimate.findFirst({ where: estWhere, select: { id: true } });
    if (est) sections.push('estimate_acknowledgement');
  }
  sections.push('pre_visit_checklist');
  return sections;
}

// --- Packet generation (idempotent per appointment / request) --------------
const ACTIVE_STATUSES = ['draft', 'sent', 'in_progress', 'submitted', 'needs_review'];

export async function generateIntakePacket(tenantId: string, target: PacketTarget, opts: { source?: string; actorUserId?: string | null; force?: boolean } = {}) {
  const ctx = await resolveContext(tenantId, target);
  // Idempotent: reuse an active packet for the same appointment/request.
  if (!opts.force && (ctx.appointmentId || ctx.appointmentRequestId)) {
    const existing = await db.patientIntakePacket.findFirst({
      where: { tenantId, status: { in: ACTIVE_STATUSES }, ...(ctx.appointmentId ? { appointmentId: ctx.appointmentId } : { appointmentRequestId: ctx.appointmentRequestId }) },
      include: { sections: true },
    });
    if (existing) return { packet: existing, created: false };
  }

  const sectionTypes = await planSections(tenantId, { patientId: ctx.patientId, appointmentId: ctx.appointmentId });
  const packet = await db.patientIntakePacket.create({
    data: {
      tenantId, patientId: ctx.patientId, leadId: ctx.leadId, appointmentId: ctx.appointmentId, appointmentRequestId: ctx.appointmentRequestId,
      status: 'draft', source: opts.source ?? 'staff', createdByUserId: opts.actorUserId ?? undefined,
      metadata: { sourceAttribution: opts.source ?? 'staff' },
      sections: { create: sectionTypes.map(t => ({ tenantId, sectionType: t, status: 'pending' })) },
    },
    include: { sections: true },
  });
  await writeAudit(tenantId, opts.actorUserId ?? null, 'intake.packet.created', packet.id, { source: packet.source, sections: sectionTypes.length });
  await emitBusinessEvent(tenantId, { eventType: 'intake.packet.created', entityType: 'intakePacket', entityId: packet.id, sourceModule: 'intake', payload: { source: packet.source, appointmentId: ctx.appointmentId } }).catch(() => {});
  return { packet, created: true };
}

// Generate (or rotate) the public token. Returns the RAW token once.
export async function issueIntakeToken(tenantId: string, packetId: string, actorUserId?: string | null): Promise<string> {
  const { token, hash } = newIntakeToken();
  const expires = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000);
  await db.patientIntakePacket.update({ where: { id: packetId }, data: { publicTokenHash: hash, tokenExpiresAt: expires, status: 'sent' } });
  await writeAudit(tenantId, actorUserId ?? null, 'intake.public_token.generated', packetId, { expiresAt: expires.toISOString() });
  await emitBusinessEvent(tenantId, { eventType: 'intake.packet.sent', entityType: 'intakePacket', entityId: packetId, sourceModule: 'intake', payload: {} }).catch(() => {});
  return token;
}

// --- Readiness -------------------------------------------------------------
export function readinessScore(sections: Array<{ sectionType: string; status: string }>): number {
  const required = sections.filter(s => REQUIRED_FOR_READINESS.includes(s.sectionType as SectionType));
  if (required.length === 0) return 0;
  const done = required.filter(s => s.status === 'completed').length;
  return Math.round((done / required.length) * 100);
}

// --- Patient-safe public view (no internal ids/tenant) ---------------------
export async function publicView(tenantId: string, packet: { id: string; status: string; appointmentId: string | null; tokenExpiresAt: Date | null; readinessScore: number }, sections: Array<{ sectionType: string; status: string; data: unknown }>) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  let appointmentSummary: { service: string; startsAt: string } | null = null;
  if (packet.appointmentId) {
    const appt = await db.appointment.findFirst({ where: { id: packet.appointmentId, tenantId }, select: { service: true, startsAt: true } });
    if (appt) appointmentSummary = { service: appt.service, startsAt: appt.startsAt.toISOString() };
  }
  return {
    clinicName: tenant?.name ?? 'Your clinic',
    status: packet.status,
    expiresAt: packet.tokenExpiresAt?.toISOString() ?? null,
    readinessScore: packet.readinessScore,
    appointment: appointmentSummary,
    objectStorageEnabled: OBJECT_STORAGE_ENABLED,
    sections: sections.map(s => ({
      sectionType: s.sectionType,
      status: s.status,
      prompt: SECTION_PROMPT[s.sectionType] ?? 'Please complete this section.',
      acknowledgement: approvedAcknowledgement(s.sectionType),
    })),
  };
}

const SECTION_PROMPT: Record<string, string> = {
  demographics: 'Confirm your contact details.',
  communication_consent: 'Record any communication channels you do not want the clinic to use. This intake cannot grant outbound contact authority.',
  insurance: 'Add or update your insurance information.',
  insurance_card: 'Provide your insurance card details (metadata only — no image is stored).',
  photo_id: 'Provide your photo ID details (metadata only — no image is stored).',
  payment_policy: 'No action needed here — your clinic will go over their payment policy with you directly.',
  estimate_acknowledgement: 'Review your estimated patient responsibility. This is an estimate, not a guarantee.',
  pre_visit_checklist: 'Confirm the pre-visit checklist.',
  consent_forms: 'Review and accept the consent forms.',
  custom: 'Please complete this section.',
};

// --- Section submission (idempotent per packet + sectionType) --------------
export interface SectionSubmitContext { ipHash?: string | null; uaHash?: string | null; source?: string }
export interface IntakeMutationOptions { tx?: Prisma.TransactionClient; deferNonCriticalEffects?: boolean }
export interface SectionSubmissionOutcome {
  sectionId: string;
  tenantId: string;
  packetId: string;
  sectionType: string;
  packetStarted: boolean;
  insurancePatientId: string | null;
  consentEvents: Array<{ eventType: 'intake.consent.accepted' | 'intake.consent.declined' | 'intake.estimate.acknowledged'; consentType: string; status: string }>;
}

/** Core intake mutation. The caller owns commit/rollback of `tx`. */
export async function submitSectionMutation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  packetId: string,
  sectionType: string,
  data: Record<string, unknown>,
  ctx: SectionSubmitContext = {},
  actorUserId?: string | null,
): Promise<SectionSubmissionOutcome> {
  const packet = await tx.patientIntakePacket.findFirst({ where: { id: packetId, tenantId }, select: { id: true, patientId: true, leadId: true, status: true, startedAt: true } });
  if (!packet) throw new Error('packet_not_found');
  const section = await tx.patientIntakeSection.findFirst({ where: { packetId, sectionType } });
  if (!section) throw new Error('section_not_found');
  if (sectionType === 'payment_policy') throw new Error('payment_policy_unavailable');

  const acknowledgement = approvedAcknowledgement(sectionType);
  if (acknowledgement) {
    if (data.accepted !== true) throw new Error('explicit_acceptance_required');
    if (data.acknowledgementId !== acknowledgement.id) throw new Error('acknowledgement_not_approved');
  }

  const packetStarted = packet.status === 'draft' || packet.status === 'sent';
  if (packet.status === 'draft' || packet.status === 'sent') {
    await tx.patientIntakePacket.update({ where: { id: packetId }, data: { status: 'in_progress', startedAt: packet.startedAt ?? new Date() } });
  }

  // Sanitize stored section data — never store raw card/ID numbers or images.
  const safe = sanitizeSectionData(sectionType, data);
  await tx.patientIntakeSection.update({ where: { id: section.id }, data: { data: safe as Prisma.InputJsonValue, status: 'completed', completedAt: new Date() } });
  await writeAudit(tenantId, actorUserId ?? null, 'intake.section.updated', section.id, { sectionType }, { tx, critical: true });

  // Related consent/insurance/document state is part of the same critical
  // transaction. Only downstream workflow events are deferred until commit.
  const consentEvents: SectionSubmissionOutcome['consentEvents'] = [];
  if (sectionType === 'communication_consent') await applyCommunicationConsent(tx, tenantId, packet, data, ctx, actorUserId, consentEvents);
  const insurancePatientId = sectionType === 'insurance' ? await applyInsuranceUpdate(tx, tenantId, packet, data, actorUserId) : null;
  if (sectionType === 'insurance_card' || sectionType === 'photo_id') await recordDocumentMetadata(tx, tenantId, packetId, section.id, sectionType, data);
  if (sectionType === 'estimate_acknowledgement') await recordConsent(tx, tenantId, packet, 'estimate_acknowledgement', data, ctx, actorUserId, consentEvents, 'intake.estimate.acknowledged');
  if (sectionType === 'payment_policy') await recordConsent(tx, tenantId, packet, 'payment_policy', data, ctx, actorUserId, consentEvents);

  return { sectionId: section.id, tenantId, packetId, sectionType, packetStarted, insurancePatientId, consentEvents };
}

export async function emitSectionSubmissionEffects(outcome: SectionSubmissionOutcome): Promise<void> {
  if (outcome.packetStarted) {
    await emitBusinessEvent(outcome.tenantId, { eventType: 'intake.packet.started', entityType: 'intakePacket', entityId: outcome.packetId, sourceModule: 'intake', payload: {} }).catch(() => {});
  }
  await emitBusinessEvent(outcome.tenantId, { eventType: 'intake.section.completed', entityType: 'intakeSection', entityId: outcome.sectionId, sourceModule: 'intake', payload: { sectionType: outcome.sectionType } }).catch(() => {});
  for (const event of outcome.consentEvents) {
    await emitBusinessEvent(outcome.tenantId, { eventType: event.eventType, entityType: 'intakePacket', entityId: outcome.packetId, sourceModule: 'intake', payload: { consentType: event.consentType, status: event.status } }).catch(() => {});
  }
  if (outcome.insurancePatientId) {
    await emitBusinessEvent(outcome.tenantId, { eventType: 'intake.insurance.updated', entityType: 'patient', entityId: outcome.insurancePatientId, sourceModule: 'intake', payload: {} }).catch(() => {});
  }
}

export async function submitSection(tenantId: string, packetId: string, sectionType: string, data: Record<string, unknown>, ctx: SectionSubmitContext = {}, actorUserId?: string | null, options: IntakeMutationOptions = {}) {
  const outcome = options.tx
    ? await submitSectionMutation(options.tx, tenantId, packetId, sectionType, data, ctx, actorUserId)
    : await db.$transaction(tx => submitSectionMutation(tx, tenantId, packetId, sectionType, data, ctx, actorUserId));
  // An outer-transaction caller must emit only after it has committed.
  if (!options.deferNonCriticalEffects && !options.tx) await emitSectionSubmissionEffects(outcome);
  return outcome.sectionId;
}

function sanitizeSectionData(sectionType: string, data: Record<string, unknown>): Record<string, unknown> {
  if (sectionType === 'insurance_card' || sectionType === 'photo_id') {
    // Keep only safe metadata — never the actual card/ID number or an image.
    return { hasFront: Boolean(data.hasFront), hasBack: Boolean(data.hasBack), fileName: typeof data.fileName === 'string' ? data.fileName.slice(0, 120) : null, note: 'metadata_only' };
  }
  if (sectionType === 'insurance') {
    return { planName: str(data.planName), memberId: str(data.memberId), groupNumber: str(data.groupNumber), payerName: str(data.payerName) };
  }
  if (sectionType === 'demographics') {
    return { firstName: str(data.firstName), lastName: str(data.lastName), email: str(data.email), phone: str(data.phone) };
  }
  const acknowledgement = approvedAcknowledgement(sectionType);
  if (acknowledgement) return { accepted: true, acknowledgementId: acknowledgement.id, version: acknowledgement.version };
  return data;
}
function str(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : null; }

// --- Consent reconciliation ------------------------------------------------
const CHANNEL_CONSENT_TYPE: Record<string, string> = { sms: 'communication_sms', email: 'communication_email', voice: 'communication_voice' };

async function applyCommunicationConsent(tx: Prisma.TransactionClient, tenantId: string, packet: { id: string; patientId: string | null; leadId: string | null }, data: Record<string, unknown>, ctx: SectionSubmitContext, actorUserId: string | null | undefined, consentEvents: SectionSubmissionOutcome['consentEvents']) {
  // The generic intake disclosure is not a purpose/channel-specific grant.
  // It can preserve a patient's restrictive choice, but never create or
  // restore outbound authority from a checked box.
  const optOutChannels = (['sms', 'email', 'voice'] as const).filter(channel => data[channel] === false);
  if (optOutChannels.length === 0) return;

  // Suppression fences before the CommunicationConsent writes, in the caller's
  // transaction — the same locks campaigns POST /consent takes and the same
  // ones claimCampaignProviderIntent() / claimCampaignProviderSubmission() hold
  // while they re-read suppression. CommunicationConsent is IDENTITY-keyed:
  // isSuppressedTx counts it by (tenantId, patientId, leadId, channel), so the
  // identity fence for whichever of the two this packet is bound to is exactly
  // the key a dispatcher aimed at that identity also holds. A packet always
  // has at most one of them, so at most one identity key is taken.
  //
  // RESIDUAL, deliberately not papered over: a packet generated from an
  // AppointmentRequest that has neither a Patient nor a Lead writes a
  // (patientId=null, leadId=null) row, which no identity fence can name. The
  // only dispatcher that can read such a row is a candidate that is itself
  // identity-less, and that dispatcher holds only a destination fence — a key
  // this record does not carry. Fencing it would require an identity on the
  // packet (a schema change, outside this increment); inventing a key here
  // would look correct without serializing anything.
  await lockSuppressionFences(tx, { tenantId, patientId: packet.patientId, leadId: packet.leadId });

  for (const channel of optOutChannels) {
    const optedIn = false;
    const status = 'opted_out';
    const existing = await tx.communicationConsent.findFirst({ where: { tenantId, patientId: packet.patientId ?? null, leadId: packet.leadId ?? null, channel } });
    if (existing) await tx.communicationConsent.update({ where: { id: existing.id }, data: { status, source: 'intake', capturedAt: new Date(), revokedAt: optedIn ? null : new Date() } });
    else await tx.communicationConsent.create({ data: { tenantId, patientId: packet.patientId, leadId: packet.leadId, channel, status, source: 'intake', revokedAt: optedIn ? null : new Date() } });
    await recordConsent(tx, tenantId, packet, CHANNEL_CONSENT_TYPE[channel], { accepted: optedIn }, ctx, actorUserId, consentEvents, 'intake.consent.declined');
  }
}

// Insert a versioned consent record (idempotent per packet + consentType +
// status flip — never erases history; a new decision is a new accepted/revoked row).
async function recordConsent(tx: Prisma.TransactionClient, tenantId: string, packet: { id: string; patientId: string | null; leadId: string | null }, consentType: string, data: Record<string, unknown>, ctx: SectionSubmitContext, actorUserId: string | null | undefined, consentEvents: SectionSubmissionOutcome['consentEvents'], eventType?: 'intake.consent.accepted' | 'intake.consent.declined' | 'intake.estimate.acknowledged') {
  const accepted = data.accepted === true;
  const status = accepted ? 'accepted' : 'declined';
  const acknowledgement = approvedAcknowledgement(consentType);
  const latest = await tx.patientConsentRecord.findFirst({ where: { tenantId, packetId: packet.id, consentType }, orderBy: { createdAt: 'desc' } });
  if (latest && latest.status === status) return; // idempotent — same decision, no dup
  await tx.patientConsentRecord.create({
    data: {
      tenantId, packetId: packet.id, patientId: packet.patientId, leadId: packet.leadId, consentType, status,
      version: acknowledgement?.version ?? 'v1',
      source: ctx.source ?? 'intake', consentTextSnapshot: acknowledgement?.text ?? (typeof data.consentText === 'string' ? data.consentText.slice(0, 500) : null),
      acceptedAt: accepted ? new Date() : null, revokedAt: accepted ? null : new Date(), ipAddressHash: ctx.ipHash ?? null, userAgentHash: ctx.uaHash ?? null,
    },
  });
  await writeAudit(tenantId, actorUserId ?? null, accepted ? 'intake.consent.accepted' : 'intake.consent.revoked', packet.id, {
    consentType, status,
    ...(acknowledgement ? { acknowledgementId: acknowledgement.id, version: acknowledgement.version } : {}),
  }, { tx, critical: true });
  if (eventType) consentEvents.push({ eventType, consentType, status });
}

// --- Insurance update (links to existing PatientInsurancePolicy) -----------
async function applyInsuranceUpdate(tx: Prisma.TransactionClient, tenantId: string, packet: { patientId: string | null }, data: Record<string, unknown>, actorUserId?: string | null): Promise<string | null> {
  if (!packet.patientId) return null;
  const planName = str(data.planName); const memberId = str(data.memberId);
  if (!planName || !memberId) return null;
  const patient = await tx.patient.findFirst({ where: { id: packet.patientId, tenantId }, select: { branchId: true } });
  if (!patient) return null;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${packet.patientId!}))`;
  const active = await tx.patientInsurancePolicy.findMany({
    where: { tenantId, patientId: packet.patientId!, active: true },
    orderBy: { coverageOrder: 'asc' },
  });
  const same = active.find(policy => policy.memberId === memberId);
  if (same) {
    await tx.patientInsurancePolicy.update({ where: { id: same.id }, data: { planName, groupNumber: str(data.groupNumber) ?? same.groupNumber, verificationStatus: 'needs_review', verifiedAt: null } });
  } else {
    // Intake must not silently replace primary coverage. A newly supplied card
    // becomes the next coordination order and remains pending human review.
    const nextOrder = Math.max(0, ...active.map(policy => policy.coverageOrder)) + 1;
    await tx.patientInsurancePolicy.create({ data: { tenantId, branchId: patient.branchId, patientId: packet.patientId!, planName, memberId, groupNumber: str(data.groupNumber), coverageOrder: nextOrder, verificationStatus: 'needs_review' } });
  }
  await writeAudit(tenantId, actorUserId ?? null, 'intake.insurance.updated', packet.patientId, { source: 'patient_intake' }, { tx, critical: true });
  return packet.patientId;
}

// --- Document metadata (metadata-only; never fakes binary upload) ----------
async function recordDocumentMetadata(tx: Prisma.TransactionClient, tenantId: string, packetId: string, sectionId: string, sectionType: string, data: Record<string, unknown>) {
  const docType = sectionType === 'photo_id' ? 'photo_id' : 'insurance_card_front';
  const existing = await tx.patientIntakeDocument.findFirst({ where: { tenantId, packetId, sectionId, documentType: docType } });
  const payload = { fileName: str(data.fileName), mimeType: str(data.mimeType), fileSize: typeof data.fileSize === 'number' ? data.fileSize : null, status: OBJECT_STORAGE_ENABLED ? 'uploaded' : 'metadata_only' as string };
  if (existing) await tx.patientIntakeDocument.update({ where: { id: existing.id }, data: payload });
  else await tx.patientIntakeDocument.create({ data: { tenantId, packetId, sectionId, documentType: docType, ...payload } });
}

// --- Submit (idempotent) ---------------------------------------------------
export type PacketSubmissionOutcome = Awaited<ReturnType<typeof submitPacketMutation>>;

/** Core packet submission. The caller owns commit/rollback of `tx`. */
export async function submitPacketMutation(tx: Prisma.TransactionClient, tenantId: string, packetId: string, actorUserId?: string | null) {
  const packet = await tx.patientIntakePacket.findFirst({ where: { id: packetId, tenantId }, include: { sections: true } });
  if (!packet) throw new Error('packet_not_found');
  if (['submitted', 'needs_review', 'approved'].includes(packet.status)) {
    return { packet, alreadySubmitted: true }; // idempotent
  }
  const score = readinessScore(packet.sections);
  const hasGaps = packet.sections.some(s => REQUIRED_FOR_READINESS.includes(s.sectionType as SectionType) && s.status !== 'completed')
    || packet.sections.some(s => s.status === 'needs_review');
  const status = hasGaps ? 'needs_review' : 'submitted';
  const changed = await tx.patientIntakePacket.updateMany({ where: { id: packetId, tenantId, status: packet.status }, data: { status, submittedAt: new Date(), readinessScore: score } });
  if (changed.count !== 1) {
    const current = await tx.patientIntakePacket.findFirstOrThrow({ where: { id: packetId, tenantId }, include: { sections: true } });
    return { packet: current, alreadySubmitted: true };
  }
  const updated = await tx.patientIntakePacket.findFirstOrThrow({ where: { id: packetId, tenantId }, include: { sections: true } });
  await writeAudit(tenantId, actorUserId ?? null, 'intake.packet.submitted', packetId, { status, readinessScore: score }, { tx, critical: true });
  return { packet: updated, alreadySubmitted: false };
}

export async function emitPacketSubmissionEffects(tenantId: string, outcome: PacketSubmissionOutcome): Promise<void> {
  if (outcome.alreadySubmitted) return;
  await emitBusinessEvent(tenantId, { eventType: 'intake.packet.submitted', entityType: 'intakePacket', entityId: outcome.packet.id, sourceModule: 'intake', payload: { status: outcome.packet.status, readinessScore: outcome.packet.readinessScore } }).catch(() => {});
  await runIntakeIntelligence(tenantId, outcome.packet);
}

export async function submitPacket(tenantId: string, packetId: string, actorUserId?: string | null, options: IntakeMutationOptions = {}) {
  const outcome = options.tx
    ? await submitPacketMutation(options.tx, tenantId, packetId, actorUserId)
    : await db.$transaction(tx => submitPacketMutation(tx, tenantId, packetId, actorUserId));
  if (!options.deferNonCriticalEffects && !options.tx) await emitPacketSubmissionEffects(tenantId, outcome);
  return outcome;
}

// --- Rule-based intelligence (gaps → signals/recs/tasks/alerts) ------------
export async function runIntakeIntelligence(tenantId: string, packet: { id: string; appointmentId: string | null; patientId: string | null; status: string; sections: Array<{ sectionType: string; status: string }> }) {
  const has = (t: string, st: string) => packet.sections.some(s => s.sectionType === t && s.status === st);
  const gaps: Array<{ signalType: string; reason: string; recType: string; title: string }> = [];

  if (has('insurance', 'pending') || has('insurance', 'needs_review')) gaps.push({ signalType: 'intake_missing', reason: 'Insurance section incomplete', recType: 'request_intake_completion', title: 'Request patient to complete intake' });
  if (has('insurance_card', 'pending')) gaps.push({ signalType: 'insurance_card_missing', reason: 'Insurance card not provided', recType: 'review_insurance_card', title: 'Review submitted insurance card' });
  if (has('communication_consent', 'pending')) gaps.push({ signalType: 'consent_missing', reason: 'Communication consent not captured', recType: 'follow_up_missing_consent', title: 'Follow up on missing consent' });
  if (has('estimate_acknowledgement', 'pending')) gaps.push({ signalType: 'estimate_ack_missing', reason: 'Estimate acknowledgement missing', recType: 'request_estimate_ack', title: 'Ask patient to acknowledge estimate' });
  if (has('payment_policy', 'pending')) gaps.push({ signalType: 'payment_policy_not_acknowledged', reason: 'Payment policy not acknowledged', recType: 'request_payment_policy_ack', title: 'Resolve pre-visit intake gap' });
  if (packet.status === 'needs_review') gaps.push({ signalType: 'intake_needs_review', reason: 'Submitted intake needs staff review', recType: 'resolve_previsit_gap', title: 'Resolve pre-visit intake gap' });

  // High patient responsibility → pre-visit risk.
  if (packet.appointmentId || packet.patientId) {
    const est = await db.patientResponsibilityEstimate.findFirst({ where: { tenantId, ...(packet.appointmentId ? { appointmentId: packet.appointmentId } : { patientId: packet.patientId! }) }, orderBy: { createdAt: 'desc' }, select: { estimatedPatientResponsibility: true } });
    if (est && Number(est.estimatedPatientResponsibility) >= 200) gaps.push({ signalType: 'previsit_risk', reason: 'High estimated patient responsibility before visit', recType: 'review_high_responsibility', title: 'Review high responsibility estimate before visit' });
  }

  if (gaps.length === 0) return;
  await emitBusinessEvent(tenantId, { eventType: 'intake.gap_detected', entityType: 'intakePacket', entityId: packet.id, sourceModule: 'intake', payload: { gaps: gaps.map(g => g.signalType) } }).catch(() => {});

  for (const g of gaps) {
    const signal = await upsertSignal(tenantId, { signalType: g.signalType, entityType: 'intakePacket', entityId: packet.id, severity: g.signalType === 'previsit_risk' || g.signalType === 'intake_needs_review' ? 'high' : 'medium', score: 50, reason: g.reason }).catch(() => null);
    if (signal) await createRecommendation(tenantId, { signalId: signal.id, title: g.title, recommendationType: g.recType, reason: g.reason, expectedImpact: 'Reduce no-show / denial / front-desk load', confidence: 55, allowedActionType: 'resolve_intake_gap', sourceData: { packetId: packet.id } }).catch(() => null);
  }

  // A staff task + revenue alert for the highest-priority gap (deduped per packet).
  const branchId = packet.appointmentId ? (await db.appointment.findFirst({ where: { id: packet.appointmentId, tenantId }, select: { branchId: true } }))?.branchId : (packet.patientId ? (await db.patient.findFirst({ where: { id: packet.patientId, tenantId }, select: { branchId: true } }))?.branchId : null);
  if (branchId) {
    const taskMarker = `[intake:${packet.id}]`;
    const dupTask = await db.staffTask.findFirst({ where: { tenantId, status: 'OPEN', metadata: { path: ['intakePacketId'], equals: packet.id } } });
    if (!dupTask) await db.staffTask.create({ data: { tenantId, branchId, title: 'Resolve pre-visit intake gaps', priority: 'high', status: 'OPEN', metadata: { source: 'intake', intakePacketId: packet.id, marker: taskMarker } } }).catch(() => {});
    if (packet.appointmentId) {
      const dupAlert = await runWithTenantContext(tenantId, tx => tx.revenueProtectionAlert.findFirst({ where: { tenantId, sourceType: 'intake_gap', appointmentId: packet.appointmentId }, select: { id: true } }));
      if (!dupAlert) await runWithTenantContext(tenantId, tx => tx.revenueProtectionAlert.create({ data: { tenantId, branchId, appointmentId: packet.appointmentId, patientId: packet.patientId ?? undefined, sourceType: 'intake_gap', severity: 'medium', title: 'Pre-visit intake incomplete', description: 'Intake has unresolved gaps before the visit.', estimatedValue: 0, status: 'open', recommendedAction: 'Resolve intake gaps before the appointment.', actionLink: `appointment/${packet.appointmentId}` } })).catch(() => {});
    }
  }
}

// --- Review ----------------------------------------------------------------
export async function reviewPacket(tenantId: string, packetId: string, action: 'approve' | 'needs_review', actorUserId: string) {
  const status = action === 'approve' ? 'approved' : 'needs_review';
  const row = await db.patientIntakePacket.update({ where: { id: packetId }, data: { status, reviewedAt: new Date(), reviewedByUserId: actorUserId } });
  await writeAudit(tenantId, actorUserId, 'intake.packet.reviewed', packetId, { action });
  await emitBusinessEvent(tenantId, { eventType: 'intake.packet.reviewed', entityType: 'intakePacket', entityId: packetId, sourceModule: 'intake', payload: { action } }).catch(() => {});
  return row;
}

// --- Mobile-ready staff view -----------------------------------------------
export function packetView(packet: { id: string; status: string; source: string; appointmentId: string | null; appointmentRequestId: string | null; patientId: string | null; leadId: string | null; readinessScore: number; submittedAt: Date | null; reviewedAt: Date | null; tokenExpiresAt: Date | null; createdAt: Date; sections?: Array<{ sectionType: string; status: string }> }) {
  const allowed: string[] = [];
  if (['submitted', 'needs_review'].includes(packet.status)) allowed.push('approve', 'mark_needs_review');
  if (['draft', 'sent', 'in_progress', 'needs_review'].includes(packet.status)) allowed.push('resend');
  return {
    intakePacketId: packet.id,
    appointmentId: packet.appointmentId,
    appointmentRequestId: packet.appointmentRequestId,
    patientId: packet.patientId,
    leadId: packet.leadId,
    status: packet.status,
    source: packet.source,
    readinessScore: packet.readinessScore,
    submittedAt: packet.submittedAt?.toISOString() ?? null,
    reviewedAt: packet.reviewedAt?.toISOString() ?? null,
    tokenExpiresAt: packet.tokenExpiresAt?.toISOString() ?? null,
    createdAt: packet.createdAt.toISOString(),
    sections: packet.sections?.map(s => ({ sectionType: s.sectionType, status: s.status })) ?? [],
    allowedActions: allowed,
    deepLinkTarget: packet.appointmentId ? `appointment/${packet.appointmentId}` : packet.patientId ? `patient/${packet.patientId}` : `intake/${packet.id}`,
    setupRequired: !OBJECT_STORAGE_ENABLED, // document upload requires object storage
  };
}
