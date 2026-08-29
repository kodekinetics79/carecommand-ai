import { db } from './db';
import type { Prisma } from '../generated/prisma/client';

// ===========================================================================
// Minimal intelligence foundation. Emits BusinessEvents for real workflows and
// derives RULE-BASED OperationalSignals + AIRecommendations. No LLM calls, no
// clinical decisions — recommendations are operational next-actions for staff,
// always requiresHumanReview. Payloads carry ids/amounts/status only (no PHI).
// All writes are best-effort: intelligence must never break the main flow.
// ===========================================================================

export type WorkflowEventType =
  | 'appointment.created' | 'appointment.cancelled' | 'appointment.rescheduled' | 'appointment.no_show'
  | 'appointment_request.created' | 'receptionist.appointmentRequest.created'
  | 'deposit.required' | 'deposit.missing' | 'deposit.paid'
  | 'payment.request.created' | 'payment.link.created' | 'payment.succeeded' | 'payment.failed' | 'payment.expired'
  | 'revenue.leakage_detected'
  // Insurance Command Center events (derivation handled in insuranceIntelligence).
  | 'insurance.profile.created' | 'insurance.profile.updated'
  | 'insurance.eligibility.requested' | 'insurance.eligibility.completed' | 'insurance.eligibility.failed' | 'insurance.eligibility.needs_review'
  | 'insurance.prior_auth.required' | 'insurance.prior_auth.updated'
  | 'insurance.intake.gap_detected' | 'insurance.patient_responsibility.estimated' | 'insurance.denialRisk.created'
  // CRM campaign / reactivation events.
  | 'campaign.created' | 'campaign.approved' | 'campaign.scheduled' | 'campaign.launched'
  | 'campaign.delivery.accepted' | 'campaign.delivery.failed' | 'campaign.delivery.suppressed' | 'campaign.completed'
  | 'patient.reactivation.recommended' | 'no_show.recovery.recommended' | 'unpaid_deposit.followup.recommended'
  | 'failed_payment.followup.recommended' | 'insurance_update.followup.recommended' | 'review_request.recommended' | 'empty_slot.fill.recommended'
  // Patient Intake + Consent engine events.
  | 'intake.packet.created' | 'intake.packet.link_issued' | 'intake.packet.started' | 'intake.section.completed'
  | 'intake.packet.submitted' | 'intake.packet.reviewed' | 'intake.consent.accepted' | 'intake.consent.declined'
  | 'intake.insurance.updated' | 'intake.estimate.acknowledged' | 'intake.gap_detected';

interface EventInput {
  eventType: WorkflowEventType;
  entityType: string;
  entityId?: string | null;
  sourceModule: string;
  payload?: Prisma.InputJsonObject;
}

export async function emitBusinessEvent(tenantId: string, input: EventInput) {
  return db.businessEvent.create({
    data: { tenantId, eventType: input.eventType, entityType: input.entityType, entityId: input.entityId ?? undefined, sourceModule: input.sourceModule, payload: input.payload },
  });
}

export interface SignalInput {
  signalType: string; entityType: string; entityId: string; severity: 'low' | 'medium' | 'high';
  score: number; reason: string; sourceEventId?: string | null;
}

// Upsert by (tenantId, signalType, entityType, entityId); refreshes an open
// signal but never reopens one a human acknowledged/resolved/dismissed.
export async function upsertSignal(tenantId: string, s: SignalInput) {
  const existing = await db.operationalSignal.findFirst({ where: { tenantId, signalType: s.signalType, entityType: s.entityType, entityId: s.entityId } });
  if (existing) {
    if (existing.status === 'open') {
      return db.operationalSignal.update({ where: { id: existing.id }, data: { severity: s.severity, score: s.score, reason: s.reason } });
    }
    return existing;
  }
  return db.operationalSignal.create({
    data: { tenantId, signalType: s.signalType, entityType: s.entityType, entityId: s.entityId, severity: s.severity, score: s.score, reason: s.reason, status: 'open', sourceEventId: s.sourceEventId ?? undefined },
  });
}

export interface RecInput {
  signalId?: string | null; title: string; recommendationType: string; reason: string;
  expectedImpact?: string; confidence: number; allowedActionType: string; sourceData?: Prisma.InputJsonObject;
}

// Avoid duplicate pending recommendations of the same type for the same signal.
export async function createRecommendation(tenantId: string, r: RecInput) {
  if (r.signalId) {
    const dup = await db.aIRecommendation.findFirst({ where: { tenantId, signalId: r.signalId, recommendationType: r.recommendationType, status: 'pending' } });
    if (dup) return dup;
  }
  return db.aIRecommendation.create({
    data: {
      tenantId, signalId: r.signalId ?? undefined, title: r.title, recommendationType: r.recommendationType,
      reason: r.reason, expectedImpact: r.expectedImpact, confidence: r.confidence, requiresHumanReview: true,
      status: 'pending', allowedActionType: r.allowedActionType, createdBy: 'system', sourceData: r.sourceData,
    },
  });
}

// Rule-based derivation for known event types. Returns silently for events that
// don't warrant a signal/recommendation.
async function deriveFromEvent(tenantId: string, input: EventInput, eventId: string) {
  const id = input.entityId ?? undefined;
  if (!id) return;
  switch (input.eventType) {
    case 'payment.failed': {
      const signal = await upsertSignal(tenantId, { signalType: 'payment_failed', entityType: 'paymentRequest', entityId: id, severity: 'high', score: 80, reason: 'A patient deposit payment failed.', sourceEventId: eventId });
      await createRecommendation(tenantId, { signalId: signal.id, title: 'Review failed payment', recommendationType: 'review_failed_payment', reason: 'Payment failed; contact the patient and resend a link.', expectedImpact: 'Recover at-risk deposit', confidence: 70, allowedActionType: 'resend_payment_link', sourceData: { paymentRequestId: id } });
      break;
    }
    case 'payment.expired': {
      const signal = await upsertSignal(tenantId, { signalType: 'payment_expired', entityType: 'paymentRequest', entityId: id, severity: 'medium', score: 60, reason: 'A deposit payment link expired unpaid.', sourceEventId: eventId });
      await createRecommendation(tenantId, { signalId: signal.id, title: 'Resend payment link', recommendationType: 'resend_payment_link', reason: 'The deposit link expired before payment.', expectedImpact: 'Recover unpaid deposit', confidence: 65, allowedActionType: 'resend_payment_link', sourceData: { paymentRequestId: id } });
      break;
    }
    case 'deposit.missing': {
      const signal = await upsertSignal(tenantId, { signalType: 'deposit_unpaid', entityType: 'depositRequirement', entityId: id, severity: 'medium', score: 50, reason: 'A required deposit is unpaid.', sourceEventId: eventId });
      await createRecommendation(tenantId, { signalId: signal.id, title: 'Follow up on unpaid deposit', recommendationType: 'follow_up_unpaid_deposit', reason: 'A required deposit has not been paid.', expectedImpact: 'Reduce no-show / revenue leakage', confidence: 60, allowedActionType: 'send_payment_link', sourceData: { depositRequirementId: id } });
      break;
    }
    case 'appointment_request.created':
    case 'receptionist.appointmentRequest.created': {
      const signal = await upsertSignal(tenantId, { signalType: 'appointment_request_pending', entityType: 'appointmentRequest', entityId: id, severity: 'medium', score: 40, reason: 'An appointment request is awaiting staff review.', sourceEventId: eventId });
      await createRecommendation(tenantId, { signalId: signal.id, title: 'Review appointment request', recommendationType: 'review_appointment_request', reason: 'A new appointment request needs review/booking.', expectedImpact: 'Convert request to booked appointment', confidence: 60, allowedActionType: 'review_appointment_request', sourceData: { appointmentRequestId: id } });
      break;
    }
    case 'appointment.no_show': {
      const signal = await upsertSignal(tenantId, { signalType: 'appointment_no_show', entityType: 'appointment', entityId: id, severity: 'medium', score: 55, reason: 'A patient did not show for their appointment.', sourceEventId: eventId });
      await createRecommendation(tenantId, { signalId: signal.id, title: 'Call no-show patient', recommendationType: 'call_no_show', reason: 'Patient missed their appointment; reach out to rebook.', expectedImpact: 'Recover missed visit revenue', confidence: 55, allowedActionType: 'contact_patient', sourceData: { appointmentId: id } });
      break;
    }
    case 'revenue.leakage_detected': {
      await upsertSignal(tenantId, { signalType: 'revenue_leakage', entityType: 'revenueLeak', entityId: id, severity: 'high', score: 70, reason: 'Potential revenue leakage detected.', sourceEventId: eventId });
      break;
    }
    default:
      // appointment.created/cancelled/rescheduled, deposit.required/paid,
      // payment.request.created/link.created/succeeded: events only, no signal.
      break;
  }
}

// Single entry point used by workflow code. Best-effort; swallows errors so the
// main transaction is never affected by intelligence bookkeeping.
export async function recordWorkflowEvent(tenantId: string, input: EventInput): Promise<void> {
  try {
    const event = await emitBusinessEvent(tenantId, input);
    await deriveFromEvent(tenantId, input, event.id);
  } catch {
    // intentionally swallowed — intelligence must not break the workflow
  }
}
