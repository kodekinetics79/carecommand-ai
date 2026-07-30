import { db } from '../db';
import { computeRpmReadiness } from './rpmReadiness';
import {
  buildRpmEvidenceSnapshot,
  invalidateRpmProviderSignoff,
  lockRpmEvidence,
  rpmPeriodBounds,
} from './rpmEvidence';

export async function computeAndStoreRpmReadiness(tenantId: string, patientId: string, now = new Date()) {
  const period = rpmPeriodBounds(now);
  return db.$transaction(async tx => {
    await lockRpmEvidence(tx, tenantId, patientId, period.start);
    const [evidence, existing] = await Promise.all([
      buildRpmEvidenceSnapshot(tx, tenantId, patientId, period),
      tx.rPMBillingReadiness.findFirst({ where: { tenantId, patientId, periodStart: period.start } }),
    ]);
    const providerSignoff = Boolean(
      existing?.providerSignoffAt
        && existing.providerSignoffEvidenceVersion === evidence.version
        && existing.providerSignoffEvidenceHash === evidence.hash,
    );
    if (existing?.providerSignoffAt && !providerSignoff) {
      await invalidateRpmProviderSignoff(tx, {
        tenantId,
        patientId,
        periodStart: period.start,
        reason: 'evidence_snapshot_mismatch_detected',
      });
    }
    const result = computeRpmReadiness({
      consentGranted: evidence.consentGranted,
      enrollmentActive: evidence.enrollmentActive,
      readingDays: evidence.readingDays,
      reviewMinutes: evidence.reviewMinutes,
      communicationFlag: evidence.communicationFlag,
      providerSignoff,
    });
    const row = await tx.rPMBillingReadiness.upsert({
      where: { tenantId_patientId_periodStart: { tenantId, patientId, periodStart: period.start } },
      create: {
        tenantId, patientId, periodStart: period.start, periodEnd: period.end,
        readingDays: evidence.readingDays, reviewMinutes: evidence.reviewMinutes,
        communicationFlag: evidence.communicationFlag, status: result.status,
        missingRequirements: result.missing,
      },
      update: {
        readingDays: evidence.readingDays, reviewMinutes: evidence.reviewMinutes,
        communicationFlag: evidence.communicationFlag, periodEnd: period.end,
        status: result.status, missingRequirements: result.missing,
      },
    });
    return { row, result, readingDays: evidence.readingDays, period, evidence };
  });
}

/**
 * READY is never counted directly from cached/history rows. Every consumer
 * recomputes the current UTC billing period, which also invalidates a stale
 * evidence-bound signoff before returning the aggregate.
 */
export async function countCurrentReadyRpmPatients(
  tenantId: string,
  patientIds?: string[] | null,
  now = new Date(),
): Promise<number> {
  if (patientIds && patientIds.length === 0) return 0;
  const enrollments = await db.patientDeviceEnrollment.findMany({
    where: {
      tenantId,
      status: 'active',
      programType: 'rpm',
      ...(patientIds ? { patientId: { in: patientIds } } : {}),
    },
    select: { patientId: true },
  });
  const uniquePatientIds = [...new Set(enrollments.map(enrollment => enrollment.patientId))];
  const readiness = await Promise.all(uniquePatientIds.map(patientId => computeAndStoreRpmReadiness(tenantId, patientId, now)));
  return readiness.filter(item => item.result.status === 'READY').length;
}
