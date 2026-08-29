import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { DEFAULT_RPM_TIME_ZONE, resolveRequestedMonth, zonedDateKey } from './rpmPeriod';

export const RPM_EVIDENCE_VERSION = 'rpm-readiness-evidence-v5';
export const RPM_SIGNOFF_ATTESTATION_REVISION = 'rpm-provider-attestation-v1';

/**
 * How the clinician contacted the patient during a review session.
 *
 * CMS adopted CPT's "live, interactive communication" requirement for the
 * management codes in CY2026 and expressly declined to extend it to
 * asynchronous messaging. A bare `communicationFlag` boolean could not tell a
 * qualifying phone call from a text message, so the most tamper-evident time
 * record in the market was recording the wrong fact — provable minutes that
 * still fail an audit.
 *
 * Non-live modalities are recordable ON PURPOSE: staff should log the outreach
 * they actually did without it inflating billable evidence.
 */
export const LIVE_COMMUNICATION_MODALITIES = ['live_phone', 'video', 'live_chat'] as const;
export const NON_LIVE_COMMUNICATION_MODALITIES = ['text_message', 'voicemail', 'secure_message', 'none'] as const;
export const COMMUNICATION_MODALITIES = [...LIVE_COMMUNICATION_MODALITIES, ...NON_LIVE_COMMUNICATION_MODALITIES] as const;
export type CommunicationModality = typeof COMMUNICATION_MODALITIES[number];

export function isLiveInteractiveModality(modality: string | null | undefined): boolean {
  return (LIVE_COMMUNICATION_MODALITIES as readonly string[]).includes(modality ?? '');
}

export interface RpmPeriod {
  /** Inclusive boundary: local midnight on the 1st, as an absolute instant. */
  start: Date;
  /** Exclusive boundary: local midnight on the 1st of the next month. */
  end: Date;
  /** Evidence cutoff within the period — now, or the period end if it closed. */
  asOf: Date;
  /** The zone the month and its days are reckoned in. */
  timeZone: string;
  /** True once the period has ended, so it can be billed rather than watched. */
  closed: boolean;
}

export interface RpmEvidenceSnapshot {
  version: typeof RPM_EVIDENCE_VERSION;
  hash: string;
  consentGranted: boolean;
  enrollmentActive: boolean;
  readingDays: number;
  reviewMinutes: number;
  communicationFlag: boolean;
  /** At least one session recorded a LIVE interactive communication. */
  interactiveCommunication: boolean;
  /** Sessions missing an activity narrative — auditors reject bare durations. */
  sessionsMissingNarrative: number;
  qualifyingReadingCount: number;
  excludedReadingCount: number;
  deviceExceptions: Array<{ reason: string; count: number }>;
}

/**
 * The billing period, reckoned in the clinic's own zone.
 *
 * `periodStart` addresses a month that has already closed — billing happens
 * after a period ends, and every call site used to compute the CURRENT month,
 * so on the 1st a clinic could no longer see, let alone attest, the month it
 * was about to bill. Any instant inside the intended month is accepted and
 * normalised, so a caller cannot address half a month.
 */
export function rpmPeriodBounds(
  now = new Date(),
  timeZone: string = DEFAULT_RPM_TIME_ZONE,
  periodStart?: Date,
): RpmPeriod {
  const { start, end } = resolveRequestedMonth(periodStart, now, timeZone);
  const asOf = new Date(Math.min(now.getTime(), end.getTime() - 1));
  return { start, end, asOf, timeZone, closed: now.getTime() >= end.getTime() };
}

export async function lockRpmEvidence(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
  periodStart: Date,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rpm-evidence:${tenantId}:${patientId}:${periodStart.toISOString()}`})::bigint)`;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function metadataObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function buildRpmEvidenceSnapshot(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
  period: RpmPeriod,
): Promise<RpmEvidenceSnapshot> {
  const [enrollments, consent, consentVersions, readings, reviewEvents] = await Promise.all([
    tx.patientDeviceEnrollment.findMany({
      where: { tenantId, patientId, programType: 'rpm' },
      orderBy: { id: 'asc' },
      select: {
        id: true, patientId: true, branchId: true, providerKey: true, deviceId: true, programType: true,
        status: true, externalRef: true, enrolledAt: true, endedAt: true, updatedAt: true,
      },
    }),
    tx.patientConsent.findFirst({
      where: { tenantId, patientId, consentType: 'rpm' },
      select: { id: true, granted: true, active: true, method: true, grantedAt: true, revokedAt: true, updatedAt: true },
    }),
    tx.auditEvent.findMany({
      where: { tenantId, action: 'connectedcare.consent.version_created', resource: 'patientConsent', resourceId: patientId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { id: true, occurredAt: true, metadata: true },
    }),
    tx.deviceReading.findMany({
      where: { tenantId, patientId, capturedAt: { gte: period.start, lt: period.end }, receivedAt: { lte: period.asOf } },
      orderBy: { id: 'asc' },
      select: {
        id: true, deviceId: true, branchId: true, readingType: true, value: true,
        numericValue: true, valueSecondary: true, unit: true, capturedAt: true,
        receivedAt: true, source: true, validationStatus: true, dedupeKey: true, createdAt: true,
        sourceProviderKey: true, sourceEnrollmentId: true,
      },
    }),
    // Filter by patient IN THE QUERY. Without the metadata predicate this loaded
    // the tenant's entire month of review-evidence audit rows for EVERY patient
    // and filtered in JS — an N+1 nested inside the per-patient fan-out. The
    // same predicate is already used by the /review route's overlap scan.
    tx.auditEvent.findMany({
      where: {
        tenantId,
        action: 'connectedcare.rpm.review_evidence_recorded',
        resource: 'rpmReviewSession',
        occurredAt: { gte: period.start, lte: period.asOf },
        metadata: { path: ['patientId'], equals: patientId },
      },
      orderBy: { id: 'asc' },
      select: { id: true, resourceId: true, occurredAt: true, metadata: true },
    }),
  ]);

  const deviceIds = [...new Set(enrollments.map(enrollment => enrollment.deviceId).filter((id): id is string => Boolean(id)))];
  const devices = deviceIds.length
    ? await tx.device.findMany({
        where: { tenantId, id: { in: deviceIds } },
        orderBy: { id: 'asc' },
        select: {
          id: true, branchId: true, deviceType: true, vendor: true, model: true,
          serialNumber: true, firmwareVersion: true, status: true, active: true, updatedAt: true,
        },
      })
    : [];

  const matchingConsentVersion = consentVersions.find(version => {
    const metadata = metadataObject(version.metadata);
    return metadata?.consentType === 'rpm'
      && metadata.evidenceCapturedAt === consent?.grantedAt?.toISOString();
  });
  const consentMetadata = metadataObject(matchingConsentVersion?.metadata ?? null);
  const consentGranted = Boolean(
    consent?.granted
      && consent.active
      && consentMetadata?.granted === true
      && typeof consentMetadata.evidenceVersion === 'string',
  );
  const enrollmentById = new Map(enrollments.map(enrollment => [enrollment.id, enrollment]));
  const deviceById = new Map(devices.map(device => [device.id, device]));
  const classifiedReadings = readings.map(reading => {
    const enrollment = reading.sourceEnrollmentId ? enrollmentById.get(reading.sourceEnrollmentId) : null;
    const device = reading.deviceId ? deviceById.get(reading.deviceId) : null;
    let exception: string | null = null;
    if (reading.validationStatus !== 'valid') exception = 'validation_not_valid';
    else if (reading.capturedAt > period.asOf) exception = 'future_captured_at';
    else if (reading.source !== 'webhook') exception = 'not_automated_provider_ingest';
    else if (!reading.dedupeKey) exception = 'missing_provider_dedupe_evidence';
    else if (!reading.sourceEnrollmentId || !reading.sourceProviderKey) exception = 'missing_enrollment_provenance';
    else if (!enrollment) exception = 'enrollment_link_not_found';
    else if (enrollment.patientId !== patientId) exception = 'enrollment_patient_mismatch';
    else if (enrollment.programType !== 'rpm') exception = 'enrollment_not_rpm';
    else if (enrollment.providerKey === 'manual' || enrollment.providerKey !== reading.sourceProviderKey) exception = 'provider_link_mismatch';
    else if (!enrollment.branchId || reading.branchId !== enrollment.branchId) exception = 'branch_link_mismatch';
    else if (reading.capturedAt < enrollment.enrolledAt || (enrollment.endedAt && reading.capturedAt >= enrollment.endedAt)) exception = 'outside_enrollment_term';
    else if (!enrollment.deviceId || !reading.deviceId || reading.deviceId !== enrollment.deviceId) exception = 'device_link_mismatch';
    else if (!device || (device.branchId && device.branchId !== enrollment.branchId)) exception = 'device_record_mismatch';
    // `active` was selected into the snapshot but never tested. A deactivated
    // device kept contributing CMS device-days — the one hole in an otherwise
    // exhaustive gate.
    else if (!device.active) exception = 'device_deactivated';
    return { reading, exception, qualifies: exception === null };
  });
  const qualifyingReadings = classifiedReadings.filter(item => item.qualifies).map(item => item.reading);
  const exceptionCounts = new Map<string, number>();
  for (const item of classifiedReadings) {
    if (item.exception) exceptionCounts.set(item.exception, (exceptionCounts.get(item.exception) ?? 0) + 1);
  }
  const deviceExceptions = [...exceptionCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => ({ reason, count }));
  // Bucket by the LOCAL calendar date. UTC bucketing split one local day that
  // straddled UTC midnight into two device-days, so eight local days of
  // transmission could satisfy a sixteen-day CMS threshold.
  const readingDays = new Set(qualifyingReadings.map(reading => zonedDateKey(reading.capturedAt, period.timeZone))).size;
  // Review totals are derived exclusively from append-only audit evidence.
  // Mutable RPMBillingReadiness totals are only a display cache and can never
  // satisfy the provider-signoff gate. Minutes are recalculated from the
  // attested timestamps so even forged/stale aggregate fields are irrelevant.
  const patientReviewEvents = reviewEvents.flatMap(event => {
    const metadata = metadataObject(event.metadata);
    if (metadata?.patientId !== patientId) return [];
    const startedAt = typeof metadata.startedAt === 'string' ? new Date(metadata.startedAt) : null;
    const endedAt = typeof metadata.endedAt === 'string' ? new Date(metadata.endedAt) : null;
    if (!startedAt || !endedAt || !Number.isFinite(startedAt.getTime()) || !Number.isFinite(endedAt.getTime())) return [];
    const elapsedMs = endedAt.getTime() - startedAt.getTime();
    if (startedAt < period.start || endedAt > period.asOf || elapsedMs < 60_000 || elapsedMs > 4 * 60 * 60_000) return [];
    return [{
      auditEventId: event.id,
      reviewEventId: event.resourceId,
      occurredAt: event.occurredAt,
      sourceRef: typeof metadata.sourceRef === 'string' ? metadata.sourceRef : null,
      provenance: typeof metadata.provenance === 'string' ? metadata.provenance : null,
      startedAt,
      endedAt,
      elapsedMs,
      reviewMinutes: Math.floor(elapsedMs / 60_000),
      communicationFlag: metadata.communicationFlag === true,
      communicationModality: typeof metadata.communicationModality === 'string' ? metadata.communicationModality : null,
      activityNarrative: typeof metadata.activityNarrative === 'string' ? metadata.activityNarrative : null,
    }];
  });
  // Sum the elapsed MILLISECONDS and floor once at the end. Flooring each
  // session first discarded up to 59s per session: twelve 1m59s reviews are
  // 23.8 real minutes but recorded 12, failing the 20-minute gate on work that
  // was actually performed. The per-event `reviewMinutes` above stays for
  // display; only this total drives the requirement.
  const reviewMinutes = Math.floor(
    patientReviewEvents.reduce((totalMs, event) => totalMs + event.elapsedMs, 0) / 60_000,
  );
  const communicationFlag = patientReviewEvents.some(event => event.communicationFlag);
  // Only a LIVE modality can support a management code. A session flagged as
  // "communicated" by text message is recorded faithfully and excluded here.
  const interactiveCommunication = patientReviewEvents.some(event => isLiveInteractiveModality(event.communicationModality));
  // "Reviewed RPM data - 25 min" is explicitly not acceptable to auditors; each
  // entry needs date, minutes, AND what was done. Surfaced so the UI can chase
  // the gap while the clinician still remembers the session.
  const sessionsMissingNarrative = patientReviewEvents.filter(event => !event.activityNarrative?.trim()).length;
  const evidenceAsOf = new Date(Math.max(
    period.start.getTime(),
    ...enrollments.map(enrollment => enrollment.updatedAt.getTime()),
    ...(consent ? [consent.updatedAt.getTime()] : []),
    ...(matchingConsentVersion ? [matchingConsentVersion.occurredAt.getTime()] : []),
    ...devices.map(device => device.updatedAt.getTime()),
    ...readings.flatMap(reading => [reading.createdAt.getTime(), reading.receivedAt.getTime(), reading.capturedAt.getTime()]),
    ...patientReviewEvents.flatMap(event => [event.occurredAt.getTime(), event.endedAt.getTime()]),
  ));

  const canonicalSnapshot = canonicalize({
    version: RPM_EVIDENCE_VERSION,
    tenantId,
    patientId,
    periodSemantics: 'local-calendar-month',
    periodTimeZone: period.timeZone,
    periodStart: period.start,
    periodEndExclusive: period.end,
    evidenceAsOf,
    consent: consent ? {
      ...consent,
      evidenceAuditId: matchingConsentVersion?.id ?? null,
      evidenceVersion: typeof consentMetadata?.evidenceVersion === 'string' ? consentMetadata.evidenceVersion : null,
      evidenceCapturedAt: consentMetadata?.evidenceCapturedAt ?? null,
      evidenceGranted: consentMetadata?.granted ?? null,
    } : null,
    enrollments,
    devices,
    readings: classifiedReadings.map(({ reading, exception, qualifies }) => ({ ...reading, qualifies, exception })),
    reviewEvidence: patientReviewEvents,
  });
  const hash = createHash('sha256').update(JSON.stringify(canonicalSnapshot)).digest('hex');

  return {
    version: RPM_EVIDENCE_VERSION,
    hash,
    consentGranted,
    enrollmentActive: enrollments.some(enrollment => enrollment.status === 'active' && Boolean(enrollment.branchId)),
    readingDays,
    reviewMinutes,
    communicationFlag,
    interactiveCommunication,
    sessionsMissingNarrative,
    qualifyingReadingCount: qualifyingReadings.length,
    excludedReadingCount: readings.length - qualifyingReadings.length,
    deviceExceptions,
  };
}

export interface SignoffInvalidationInput {
  tenantId: string;
  patientId: string;
  periodStart: Date;
  reason: string;
  actorUserId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  mutationResourceId?: string | null;
}

export async function invalidateRpmProviderSignoff(
  tx: Prisma.TransactionClient,
  input: SignoffInvalidationInput,
): Promise<boolean> {
  const current = await tx.rPMBillingReadiness.findFirst({
    where: { tenantId: input.tenantId, patientId: input.patientId, periodStart: input.periodStart },
    select: { id: true, providerSignoffAt: true, providerSignoffEvidenceHash: true, providerSignoffEvidenceVersion: true },
  });
  if (!current?.providerSignoffAt) return false;

  await tx.rPMBillingReadiness.update({
    where: { id: current.id },
    data: {
      providerSignoffUserId: null,
      providerSignoffAt: null,
      providerSignoffEvidenceHash: null,
      providerSignoffEvidenceVersion: null,
      providerSignoffAttestationRevision: null,
      status: 'NEEDS_REVIEW',
      missingRequirements: ['Provider signoff'],
    },
  });
  await tx.auditEvent.create({
    data: {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      action: 'connectedcare.rpm.signoff_invalidated',
      resource: 'rpmBillingReadiness',
      resourceId: input.patientId,
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: {
        reason: input.reason,
        mutationResourceId: input.mutationResourceId ?? null,
        priorEvidenceVersion: current.providerSignoffEvidenceVersion,
        priorEvidenceHash: current.providerSignoffEvidenceHash,
      },
    },
  });
  return true;
}

export async function invalidateRpmSignoffsForDevice(
  tx: Prisma.TransactionClient,
  input: Omit<SignoffInvalidationInput, 'patientId'> & { deviceId: string },
): Promise<number> {
  const patientIds = await lockRpmEvidenceForDevice(tx, input.tenantId, input.deviceId, input.periodStart);
  let invalidated = 0;
  for (const patientId of patientIds) {
    if (await invalidateRpmProviderSignoff(tx, { ...input, patientId, mutationResourceId: input.deviceId })) invalidated++;
  }
  return invalidated;
}

export async function lockRpmEvidenceForDevice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  deviceId: string,
  periodKey: Date,
): Promise<string[]> {
  const enrollments = await tx.patientDeviceEnrollment.findMany({
    where: { tenantId, deviceId, programType: 'rpm' },
    orderBy: { patientId: 'asc' },
    select: { patientId: true },
  });
  const patientIds = [...new Set(enrollments.map(enrollment => enrollment.patientId))];
  for (const patientId of patientIds) {
    await lockRpmEvidence(tx, tenantId, patientId, periodKey);
  }
  return patientIds;
}
