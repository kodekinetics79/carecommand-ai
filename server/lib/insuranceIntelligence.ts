import { db } from './db';
import { env } from './../config/env';
import { providerValue } from './providerCredentials';
import { runWithTenantContext } from './tenantContext';
import { emitBusinessEvent, upsertSignal, createRecommendation } from './intelligence';
import { ensureStaffTask } from './staffTasks';
import type { Prisma } from '../generated/prisma/client';

// ===========================================================================
// Insurance Command Center intelligence + AI denial-prevention foundation.
// RULE-BASED only (no LLM, no clinical/medical-necessity decisions). Reuses the
// existing EligibilityVerification / PriorAuthorization / PatientResponsibility-
// Estimate models. Surfaces pre-visit revenue risk; requiresHumanReview always
// true for insurance/prior-auth actions. No PHI in event payloads.
// ===========================================================================

export const INSURANCE_FEATURE = 'insurance_eligibility';
const ELIGIBILITY_EXPIRY_DAYS = 30;
const HIGH_RESPONSIBILITY_THRESHOLD = 200;

// --- Provider configuration status (truthful; never fakes eligible) --------
export interface EligibilityProviderStatus { provider: string; configured: boolean; mock: boolean; setupRequired: boolean; missing: string[] }

export function eligibilityProviderStatus(): EligibilityProviderStatus {
  const provider = env.INSURANCE_PROVIDER;
  if (provider === 'mock') {
    // Mock returns deterministic results in dev/test only — never in production.
    const allowed = env.NODE_ENV !== 'production';
    return { provider, configured: allowed, mock: true, setupRequired: !allowed, missing: allowed ? [] : ['INSURANCE_PROVIDER'] };
  }
  if (provider === 'stedi') {
    const configured = Boolean(providerValue('insurance', 'apiKey'));
    return { provider, configured, mock: false, setupRequired: !configured, missing: configured ? [] : ['STEDI_API_KEY'] };
  }
  // availity / pverify / optum are placeholders — not really integrated.
  return { provider, configured: false, mock: false, setupRequired: true, missing: ['INSURANCE_PROVIDER'] };
}

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') { const n = Number(value); return Number.isFinite(n) ? n : 0; }
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: () => number }).toNumber === 'function') return (value as { toNumber: () => number }).toNumber();
  return 0;
}

// --- Denial-risk assessment (pure rule-based) ------------------------------
export type DenialRiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface DenialRiskAssessment {
  appointmentId: string | null;
  patientId: string | null;
  eligibilityVerificationId: string | null;
  priorAuthorizationId: string | null;
  patientResponsibilityEstimateId: string | null;
  insuranceProfileId: string | null;
  eligibilityStatus: string;
  priorAuthStatus: string;
  estimatedPatientResponsibility: number | null;
  denialRiskScore: number;
  denialRiskLevel: DenialRiskLevel;
  reasons: string[];
  recommendedActions: string[];
  staffReviewRequired: boolean;
  setupRequired: boolean;
  allowedActions: string[];
  deepLinkTarget: string;
}

/**
 * What the denial-prevention run actually wrote. The "Flag for billing review"
 * control used to report "task and alert created" unconditionally, including on
 * runs where the risk was NONE and nothing was written at all. Callers report
 * these fields instead of assuming.
 */
export interface DenialPreventionReview {
  staffTaskId: string | null;
  staffTaskCreated: boolean;
  alertCreated: boolean;
  reason: 'task_created' | 'task_already_open' | 'task_write_failed' | 'review_not_required' | 'no_risk_detected' | 'no_branch_on_appointment';
}

export type DenialPreventionRun = DenialRiskAssessment & { review: DenialPreventionReview };

const REASON_ACTION: Record<string, string> = {
  insurance_missing: 'Request updated insurance from the patient',
  eligibility_not_checked: 'Verify insurance before the visit',
  ineligible: 'Confirm active coverage with the patient/payer',
  eligibility_expired: 'Re-verify insurance before the visit',
  eligibility_needs_review: 'Review payer eligibility response',
  prior_auth_required: 'Confirm prior authorization before the visit',
  prior_auth_denied: 'Resolve denied/expired prior authorization before the visit',
  high_patient_responsibility: 'Discuss estimated patient responsibility and collect a deposit',
};

function levelFromScore(score: number): DenialRiskLevel {
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'NONE';
}

interface AssessContext { tenantId: string; appointmentId?: string | null; patientId?: string | null }

export async function computeDenialRisk(ctx: AssessContext): Promise<DenialRiskAssessment> {
  const { tenantId } = ctx;
  // Resolve patient from the appointment when only an appointment is given.
  let patientId = ctx.patientId ?? null;
  const appointmentId = ctx.appointmentId ?? null;
  if (appointmentId && !patientId) {
    const appt = await db.appointment.findFirst({ where: { id: appointmentId, tenantId }, select: { patientId: true } });
    patientId = appt?.patientId ?? null;
  }

  const [policy, verification, priorAuth, estimate] = await Promise.all([
    patientId ? db.patientInsurancePolicy.findFirst({ where: { tenantId, patientId, active: true }, orderBy: { createdAt: 'desc' } }) : null,
    db.eligibilityVerification.findFirst({ where: { tenantId, ...(appointmentId ? { appointmentId } : patientId ? { patientId } : {}) }, orderBy: { checkedAt: 'desc' } }),
    db.priorAuthorization.findFirst({ where: { tenantId, ...(appointmentId ? { appointmentId } : patientId ? { patientId } : {}) }, orderBy: { updatedAt: 'desc' } }),
    db.patientResponsibilityEstimate.findFirst({ where: { tenantId, ...(appointmentId ? { appointmentId } : patientId ? { patientId } : {}) }, orderBy: { createdAt: 'desc' } }),
  ]);

  const reasons: string[] = [];
  let score = 0;
  const add = (reason: string, points: number) => { reasons.push(reason); score += points; };

  if (!policy && !verification) add('insurance_missing', 40);
  if (!verification) {
    if (policy) add('eligibility_not_checked', 25);
  } else {
    const status = verification.coverageStatus.toLowerCase();
    if (!verification.coverageActive || status === 'inactive') add('ineligible', 35);
    else if (status === 'uncertain') add('eligibility_needs_review', 20);
    const ageDays = (Date.now() - verification.checkedAt.getTime()) / 86400000;
    if (ageDays > ELIGIBILITY_EXPIRY_DAYS) add('eligibility_expired', 20);
  }

  const paStatus = (priorAuth?.status ?? 'not_required').toLowerCase();
  if (paStatus === 'required' || paStatus === 'pending') add('prior_auth_required', 25);
  else if (paStatus === 'denied' || paStatus === 'expired') add('prior_auth_denied', 35);

  const estPatient = estimate ? num(estimate.estimatedPatientResponsibility) : null;
  if (estPatient != null && estPatient >= HIGH_RESPONSIBILITY_THRESHOLD) add('high_patient_responsibility', 15);

  const providerStatus = eligibilityProviderStatus();
  const denialRiskScore = Math.min(100, score);
  const denialRiskLevel = levelFromScore(denialRiskScore);
  const staffReviewRequired = denialRiskLevel === 'HIGH' || reasons.includes('eligibility_needs_review') || reasons.includes('prior_auth_denied');
  const recommendedActions = [...new Set(reasons.map(r => REASON_ACTION[r]).filter(Boolean))];

  const allowedActions: string[] = [];
  if (!verification || reasons.includes('eligibility_expired')) allowedActions.push('run_eligibility_check');
  if (reasons.includes('insurance_missing')) allowedActions.push('request_insurance');
  if (paStatus === 'required' || paStatus === 'pending' || paStatus === 'denied') allowedActions.push('review_prior_auth');
  if (denialRiskLevel !== 'NONE') allowedActions.push('flag_for_billing_review');

  return {
    appointmentId, patientId,
    eligibilityVerificationId: verification?.id ?? null,
    priorAuthorizationId: priorAuth?.id ?? null,
    patientResponsibilityEstimateId: estimate?.id ?? null,
    insuranceProfileId: policy?.id ?? null,
    eligibilityStatus: verification ? (verification.coverageActive ? 'eligible' : verification.coverageStatus.toLowerCase() === 'uncertain' ? 'needs_review' : 'ineligible') : 'not_checked',
    priorAuthStatus: paStatus,
    estimatedPatientResponsibility: estPatient,
    denialRiskScore, denialRiskLevel, reasons, recommendedActions, staffReviewRequired,
    setupRequired: providerStatus.setupRequired,
    allowedActions,
    deepLinkTarget: appointmentId ? `appointment/${appointmentId}` : patientId ? `patient/${patientId}` : 'insurance',
  };
}

async function writeAudit(tenantId: string, actorUserId: string | null, action: string, resourceId: string, metadata: Prisma.InputJsonObject) {
  await db.auditEvent.create({ data: { tenantId, actorUserId: actorUserId ?? undefined, action, resource: 'insuranceDenialRisk', resourceId, userAgent: 'insurance-intelligence', metadata } }).catch(() => {});
}

// Run denial prevention for an appointment: assess + (when material) create a
// StaffTask, RevenueProtectionAlert, BusinessEvent, OperationalSignal, and a
// rule-based AIRecommendation. Idempotent via the per-entity signal upsert.
export async function runDenialPreventionForAppointment(tenantId: string, appointmentId: string, opts: { actorUserId?: string | null; branchId?: string } = {}): Promise<DenialPreventionRun> {
  const assessment = await computeDenialRisk({ tenantId, appointmentId });
  // Nothing is created for a NONE risk. Say so, rather than letting the caller
  // report a task and an alert that were never written.
  if (assessment.denialRiskLevel === 'NONE') {
    return { ...assessment, review: { staffTaskId: null, staffTaskCreated: false, alertCreated: false, reason: 'no_risk_detected' } };
  }

  const branchId = opts.branchId ?? (await db.appointment.findFirst({ where: { id: appointmentId, tenantId }, select: { branchId: true } }))?.branchId;

  // Append-only fact + derived signal (idempotent on appointment).
  const event = await emitBusinessEvent(tenantId, { eventType: 'insurance.intake.gap_detected', entityType: 'appointment', entityId: appointmentId, sourceModule: 'insurance', payload: { denialRiskLevel: assessment.denialRiskLevel, score: assessment.denialRiskScore, reasons: assessment.reasons } }).catch(() => null);
  await emitBusinessEvent(tenantId, { eventType: 'insurance.denialRisk.created', entityType: 'appointment', entityId: appointmentId, sourceModule: 'insurance', payload: { score: assessment.denialRiskScore } }).catch(() => null);

  const severity = assessment.denialRiskLevel === 'HIGH' ? 'high' : assessment.denialRiskLevel === 'MEDIUM' ? 'medium' : 'low';
  const signal = await upsertSignal(tenantId, { signalType: 'denial_risk', entityType: 'appointment', entityId: appointmentId, severity, score: assessment.denialRiskScore, reason: `Pre-visit denial risk: ${assessment.reasons.join(', ')}`, sourceEventId: event?.id ?? null }).catch(() => null);
  if (signal) {
    await createRecommendation(tenantId, {
      signalId: signal.id, title: 'Resolve denial risk before appointment', recommendationType: 'resolve_denial_risk',
      reason: assessment.recommendedActions.join('; ') || 'Resolve insurance gaps before the visit.',
      expectedImpact: 'Prevent claim denial / pre-visit revenue leakage', confidence: 60, allowedActionType: 'flag_for_billing_review',
      sourceData: { appointmentId, reasons: assessment.reasons },
    }).catch(() => null);
  }

  // Only escalate to a task/alert when staff action is warranted.
  const review: DenialPreventionReview = { staffTaskId: null, staffTaskCreated: false, alertCreated: false, reason: 'review_not_required' };
  if (assessment.staffReviewRequired || assessment.denialRiskLevel === 'HIGH') {
    if (branchId) {
      // Idempotent per appointment: re-running the check on the same appointment
      // reuses the open review task instead of stacking duplicates on the queue.
      const handoff = await runWithTenantContext(tenantId, tx => ensureStaffTask(tx, {
        tenantId, branchId,
        title: 'Resolve insurance denial risk before visit',
        priority: assessment.denialRiskLevel === 'HIGH' ? 'high' : 'normal',
        origin: { workflow: 'insurance_denial_prevention', entityType: 'appointment', entityId: appointmentId },
        context: { reasons: assessment.reasons, denialRiskLevel: assessment.denialRiskLevel },
      })).catch(() => null);
      review.staffTaskId = handoff?.task.id ?? null;
      review.staffTaskCreated = handoff?.created ?? false;
      review.reason = handoff ? (handoff.created ? 'task_created' : 'task_already_open') : 'task_write_failed';

      const alerted = await runWithTenantContext(tenantId, async tx => {
        const open = await tx.revenueProtectionAlert.findFirst({
          where: { tenantId, appointmentId, sourceType: 'insurance_denial_risk', status: 'open' },
          select: { id: true },
        });
        if (open) return false;
        await tx.revenueProtectionAlert.create({
          data: {
            tenantId, branchId, appointmentId, patientId: assessment.patientId ?? undefined,
            sourceType: 'insurance_denial_risk', severity, title: 'Pre-visit insurance denial risk',
            description: `Denial risk ${assessment.denialRiskLevel}: ${assessment.reasons.join(', ')}.`,
            estimatedValue: assessment.estimatedPatientResponsibility ?? 0, status: 'open',
            recommendedAction: assessment.recommendedActions[0] ?? 'Verify insurance before the visit.',
            actionLink: `appointment/${appointmentId}`,
          },
        });
        return true;
      }).catch(() => false);
      review.alertCreated = alerted;
    } else {
      // No branch means the task would be filed where no branch queue can see it.
      review.reason = 'no_branch_on_appointment';
    }
    await writeAudit(tenantId, opts.actorUserId ?? null, 'insurance.denialRisk.created', appointmentId, { denialRiskLevel: assessment.denialRiskLevel, reasons: assessment.reasons, staffTaskId: review.staffTaskId, staffTaskCreated: review.staffTaskCreated });
  }

  return { ...assessment, review };
}

export { ELIGIBILITY_EXPIRY_DAYS };
