import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';

export const RPM_EVIDENCE_VERSION = 'rpm-readiness-evidence-v2';

export interface RpmPeriod {
  /** Inclusive immutable UTC calendar-month billing boundary. */
  start: Date;
  /** Exclusive immutable UTC calendar-month billing boundary. */
  end: Date;
  /** Current evidence cutoff within the fixed billing period. */
  asOf: Date;
}

export interface RpmEvidenceSnapshot {
  version: typeof RPM_EVIDENCE_VERSION;
  hash: string;
  consentGranted: boolean;
  enrollmentActive: boolean;
  readingDays: number;
  reviewMinutes: number;
  communicationFlag: boolean;
}

export function rpmPeriodBounds(now = new Date()): RpmPeriod {
  const requestedAsOf = new Date(now);
  const start = new Date(Date.UTC(requestedAsOf.getUTCFullYear(), requestedAsOf.getUTCMonth(), 1));
  const end = new Date(Date.UTC(requestedAsOf.getUTCFullYear(), requestedAsOf.getUTCMonth() + 1, 1));
  const asOf = new Date(Math.min(requestedAsOf.getTime(), end.getTime() - 1));
  return { start, end, asOf };
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
        id: true, branchId: true, providerKey: true, deviceId: true, programType: true,
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
      where: { tenantId, patientId, validationStatus: 'valid', capturedAt: { gte: period.start, lte: period.asOf } },
      orderBy: { id: 'asc' },
      select: {
        id: true, deviceId: true, branchId: true, readingType: true, value: true,
        numericValue: true, valueSecondary: true, unit: true, capturedAt: true,
        receivedAt: true, source: true, validationStatus: true, dedupeKey: true, createdAt: true,
      },
    }),
    tx.auditEvent.findMany({
      where: {
        tenantId,
        action: 'connectedcare.rpm.review_evidence_recorded',
        resource: 'rpmReviewSession',
        occurredAt: { gte: period.start, lte: period.asOf },
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
  const readingDays = new Set(readings.map(reading => reading.capturedAt.toISOString().slice(0, 10))).size;
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
      reviewMinutes: Math.floor(elapsedMs / 60_000),
      communicationFlag: metadata.communicationFlag === true,
    }];
  });
  const reviewMinutes = patientReviewEvents.reduce((total, event) => total + event.reviewMinutes, 0);
  const communicationFlag = patientReviewEvents.some(event => event.communicationFlag);
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
    periodSemantics: 'utc-calendar-month',
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
    readings,
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
