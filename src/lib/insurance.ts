import { apiRequest } from './api';
import { eligibilityRequestHeaders, runEligibilityAction } from './eligibilityIdempotency';

// --- Types -----------------------------------------------------------------

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

export interface EligibilityProviderStatus {
  provider: string;
  configured: boolean;
  mock: boolean;
  setupRequired: boolean;
  missing: string[];
}

export const RISK_META: Record<DenialRiskLevel, { label: string; badge: string }> = {
  NONE: { label: 'No insurance risk', badge: 'badge-emerald' },
  LOW: { label: 'Low denial risk', badge: 'badge-blue' },
  MEDIUM: { label: 'Medium denial risk', badge: 'badge-amber' },
  HIGH: { label: 'High denial risk', badge: 'badge-red' },
};

export const ELIGIBILITY_STATUS_META: Record<string, { label: string; badge: string }> = {
  not_checked: { label: 'Not checked', badge: 'badge-blue' },
  eligible: { label: 'Eligible', badge: 'badge-emerald' },
  ineligible: { label: 'Ineligible', badge: 'badge-red' },
  needs_review: { label: 'Needs review', badge: 'badge-amber' },
};

// Human-readable labels for rule-based denial-risk reasons.
export const REASON_LABEL: Record<string, string> = {
  insurance_missing: 'No insurance on file',
  eligibility_not_checked: 'Eligibility not verified',
  ineligible: 'Coverage inactive/ineligible',
  eligibility_expired: 'Eligibility check expired',
  eligibility_needs_review: 'Payer response needs review',
  prior_auth_required: 'Prior authorization required',
  prior_auth_denied: 'Prior auth denied/expired',
  high_patient_responsibility: 'High patient responsibility',
};

const base = '/v1/insurance';

export const insuranceApi = {
  providerStatus: () => apiRequest<EligibilityProviderStatus>(`${base}/provider-status`),
  getIntake: (appointmentId: string) => apiRequest<DenialRiskAssessment>(`${base}/intake/${appointmentId}`),
  runDenialPrevention: (appointmentId: string) =>
    apiRequest<DenialRiskAssessment & { requiresHumanReview: boolean }>(`${base}/denial-prevention/${appointmentId}`, { method: 'POST' }),
  runEligibilityCheck: (body: { appointmentId?: string; patientId?: string; branchId?: string; payerId?: string; serviceType?: string }, idempotencyKey?: string) => {
    const send = (key: string) => apiRequest<{ status?: string; setupRequired?: boolean; provider?: string; coverageStatus?: string; verificationId?: string }>(`/v1/revenue-protection/eligibility/check`, {
      method: 'POST', headers: eligibilityRequestHeaders(key), body: JSON.stringify(body),
    });
    return idempotencyKey ? send(idempotencyKey) : runEligibilityAction('revenue_protection_v1', body, send);
  },
};
