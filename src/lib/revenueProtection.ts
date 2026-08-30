import { apiRequest } from './api';
import { formatCurrency } from '../utils/formatters';
import { eligibilityRequestHeaders, runEligibilityAction } from './eligibilityIdempotency';

export type RevenueProtectionMode = 'mock' | 'sandbox' | 'live';

export interface RevenueProtectionSummary {
  paymentsDueToday: number;
  copaysExpected: number;
  depositsCollected: number;
  unpaidBalances: number;
  failedPayments: number;
  revenueProtected: number;
  revenueAtRisk: number;
}

/**
 * One capability, one sentence, no supplier named.
 *
 * `test_data` is deliberately its own state and never folded into
 * `available`: a screen that reads "working" while the money is simulated is
 * the failure the mock-mode label exists to prevent.
 */
export type CapabilityState = 'available' | 'test_data' | 'not_set_up';

export interface TenantCapability {
  key: 'eligibility_checks' | 'card_payments';
  label: string;
  state: CapabilityState;
  detail: string;
  usable: boolean;
}

export interface RevenueProtectionCapabilities {
  eligibility: TenantCapability;
  cardPayments: TenantCapability;
  payerCount: number;
  recentRuns: number;
  latestRun?: { provider: string; providerMode: RevenueProtectionMode; operation: string; status: string; createdAt: string } | null;
}

export interface AppointmentVerificationQueueRow {
  id: string;
  branchId: string;
  branchName: string;
  patientId: string;
  patientName: string;
  appointmentTime: string;
  serviceType: string;
  payerName: string;
  memberId: string;
  groupNumber?: string | null;
  eligibilityStatus: string;
  copay: number;
  deductibleRemaining: number;
  priorAuthStatus: string;
  verificationId?: string | null;
  priorAuthId?: string | null;
  coverageActive: boolean;
  coverageStatus: string;
  checkedAt?: string | null;
  providerMode: string;
  payerReference?: string | null;
  recommendedAction: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface InsurancePayer {
  id: string;
  name: string;
  tradingPartnerServiceId?: string | null;
  sourceProvider: string;
  active: boolean;
  sortOrder: number;
}

export interface PatientInsurancePolicy {
  id: string;
  branchId: string;
  branchName: string;
  patientId: string;
  patientName: string;
  payerId?: string | null;
  payerName: string;
  planName: string;
  memberId: string;
  groupNumber?: string | null;
  relationship?: string | null;
  subscriberName?: string | null;
  payerReference?: string | null;
  verificationStatus: string;
  active: boolean;
  verifiedAt?: string | null;
}

export interface EligibilityVerification {
  verificationId?: string;
  id: string;
  branchId: string;
  branchName: string;
  patientId: string;
  patientName: string;
  appointmentId?: string | null;
  payerId?: string | null;
  payerName: string;
  policyId?: string | null;
  memberId?: string | null;
  providerMode: string;
  coverageStatus: string;
  planName: string;
  copay: number;
  deductibleRemaining: number;
  coinsurance: number;
  coverageActive: boolean;
  eligibilityMessage: string;
  payerReference?: string | null;
  checkedAt: string;
  priorAuthRequired?: boolean;
  recommendedAction?: string;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  revenueAtRisk?: number;
}

export interface PatientResponsibilityEstimate {
  id: string;
  branchId: string;
  branchName: string;
  patientId: string;
  patientName: string;
  appointmentId?: string | null;
  appointmentService?: string | null;
  eligibilityVerificationId?: string | null;
  estimatedInsurancePortion: number;
  estimatedPatientResponsibility: number;
  recommendedCollectAmount: number;
  reason: string;
  createdAt: string;
}

export interface PriorAuthorization {
  id: string;
  branchId: string;
  branchName: string;
  patientId?: string | null;
  patientName: string;
  appointmentId?: string | null;
  payerId?: string | null;
  payerName: string;
  serviceName: string;
  authNumber?: string | null;
  status: string;
  dueAt?: string | null;
  notes?: string | null;
  lastUpdatedAt?: string | null;
}

export interface PaymentRequest {
  id: string;
  branchId: string;
  branchName: string;
  patientId?: string | null;
  patientName: string;
  appointmentId?: string | null;
  appointmentService?: string | null;
  amount: number;
  currency: string;
  status: string;
  reason: string;
  mode: RevenueProtectionMode;
  paymentUrl?: string | null;
  providerReference?: string | null;
  dueAt?: string | null;
}

export interface PaymentTransaction {
  id: string;
  branchId: string;
  branchName: string;
  patientId?: string | null;
  patientName: string;
  appointmentId?: string | null;
  amount: number;
  currency: string;
  status: string;
  mode: RevenueProtectionMode;
  providerReference?: string | null;
  receivedAt?: string | null;
}

export interface DepositRule {
  id: string;
  branchId?: string | null;
  branchName?: string | null;
  name: string;
  ruleType: string;
  description: string;
  active: boolean;
  depositRequired: boolean;
  amountType: string;
  amountValue: number;
  refundable: boolean;
  cancellationWindowHours: number;
  appliesToNewPatients: boolean;
  appliesToHighNoShowRisk: boolean;
  appliesToPremiumServices: boolean;
  appliesToSameDayAppointments: boolean;
  appliesToExemptPatients: boolean;
  sortOrder: number;
}

export interface DepositRequirement {
  id: string;
  branchId: string;
  branchName: string;
  patientId?: string | null;
  patientName: string;
  appointmentId?: string | null;
  appointmentService?: string | null;
  depositRuleId?: string | null;
  paymentRequestId?: string | null;
  depositRuleName?: string | null;
  status: string;
  requiredAmount: number;
  collectedAmount: number;
  waiverReason?: string | null;
  reason: string;
  mode: RevenueProtectionMode;
  dueAt?: string | null;
  collectedAt?: string | null;
}

export interface RevenueProtectionAlert {
  id: string;
  branchId: string;
  branchName: string;
  patientId?: string | null;
  patientName: string;
  appointmentId?: string | null;
  appointmentService?: string | null;
  sourceType: string;
  severity: string;
  title: string;
  description: string;
  evidence?: unknown;
  estimatedValue: number;
  status: string;
  recommendedAction: string;
  actionLink?: string | null;
}

export interface IntegrationRunLog {
  id: string;
  branchId?: string | null;
  branchName?: string | null;
  provider: string;
  providerMode: RevenueProtectionMode;
  operation: string;
  status: string;
  requestSummary?: unknown;
  responseSummary?: unknown;
  errorMessage?: string | null;
  createdAt: string;
}

export interface RevenueProtectionOverview {
  summary: RevenueProtectionSummary;
  insurancePayers: InsurancePayer[];
  patientInsurancePolicies: PatientInsurancePolicy[];
  eligibilityVerifications: EligibilityVerification[];
  patientResponsibilityEstimates: PatientResponsibilityEstimate[];
  priorAuthorizations: PriorAuthorization[];
  paymentRequests: PaymentRequest[];
  paymentTransactions: PaymentTransaction[];
  depositRules: DepositRule[];
  depositRequirements: DepositRequirement[];
  revenueProtectionAlerts: RevenueProtectionAlert[];
  integrationRunLogs: IntegrationRunLog[];
}

export async function fetchRevenueProtectionOverview(branchId?: string) {
  return apiRequest<RevenueProtectionOverview>(branchId ? `/v1/revenue-protection/overview?branchId=${branchId}` : '/v1/revenue-protection/overview');
}

export async function fetchRevenueProtectionCapabilities() {
  return apiRequest<RevenueProtectionCapabilities>('/v1/revenue-protection/integration-status');
}

export async function checkEligibility(input: { patientId?: string; appointmentId?: string; branchId?: string; payerId?: string; serviceType?: string }, idempotencyKey?: string) {
  const send = (key: string) => apiRequest<EligibilityVerification>('/v1/revenue-protection/eligibility/check', { method: 'POST', headers: eligibilityRequestHeaders(key), body: JSON.stringify(input) });
  return idempotencyKey ? send(idempotencyKey) : runEligibilityAction('revenue_protection_v1', input, send);
}

export async function markEligibilityVerified(id: string) {
  return apiRequest<{ id: string; coverageStatus: string; coverageActive: boolean; checkedAt: string }>(`/v1/revenue-protection/eligibility/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ coverageStatus: 'verified' }),
  });
}

export async function updatePriorAuthStatus(id: string, status: string, notes?: string) {
  return apiRequest<{ id: string; status: string; notes?: string | null; lastUpdatedAt?: string | null }>(`/v1/revenue-protection/prior-auth/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, notes }),
  });
}

export async function createPaymentRequest(input: { patientId?: string; appointmentId?: string; branchId?: string; amount: number; reason: string; depositRuleId?: string; dueAt?: string; createDepositRequirement?: boolean }) {
  return apiRequest<PaymentRequest>('/v1/revenue-protection/payment/request', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createPaymentLink(input: { patientId?: string; appointmentId?: string; branchId?: string; amount: number; reason: string; depositRuleId?: string; dueAt?: string; createDepositRequirement?: boolean }) {
  return apiRequest<PaymentRequest>('/v1/revenue-protection/payment-link', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updatePaymentStatus(id: string, status: string, providerReference?: string) {
  return apiRequest<{ id: string; status: string; providerReference?: string | null }>(`/v1/revenue-protection/payment/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, providerReference }),
  });
}

export async function updateDepositRule(id: string, input: Partial<DepositRule> & { branchId?: string | null }) {
  return apiRequest<DepositRule>(`/v1/revenue-protection/deposit-rules/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function createDepositRule(input: {
  branchId?: string | null;
  name: string;
  ruleType: string;
  description: string;
  active?: boolean;
  depositRequired?: boolean;
  amountType?: string;
  amountValue?: number;
  refundable?: boolean;
  cancellationWindowHours?: number;
  appliesToNewPatients?: boolean;
  appliesToHighNoShowRisk?: boolean;
  appliesToPremiumServices?: boolean;
  appliesToSameDayAppointments?: boolean;
  appliesToExemptPatients?: boolean;
  sortOrder?: number;
}) {
  return apiRequest<DepositRule>('/v1/revenue-protection/deposit-rules', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateDepositRequirementStatus(id: string, input: { status: string; reason?: string; collectedAmount?: number; waiverReason?: string }) {
  return apiRequest<{ id: string; status: string; requiredAmount: number; collectedAmount: number; waiverReason?: string | null; collectedAt?: string | null }>(`/v1/revenue-protection/deposit-requirements/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function updateAlertStatus(id: string, input: { status: string; createRecoveryTask?: boolean; taskTitle?: string; taskPriority?: string }) {
  return apiRequest<{ id: string; status: string; taskId?: string | null }>(`/v1/revenue-protection/leaks/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function fetchAppointmentVerificationQueue(
  branchId?: string,
  window?: { from: Date; to: Date },
) {
  const params = new URLSearchParams();
  if (branchId) params.set('branchId', branchId);
  // The clinic day the desk is working. Sent as instants because only the
  // client knows the clinic's timezone; without it the server falls back to
  // "today onward" with a day of slack rather than guessing a zone.
  if (window) {
    params.set('from', window.from.toISOString());
    params.set('to', window.to.toISOString());
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return apiRequest<{ appointments: AppointmentVerificationQueueRow[] }>(`/v1/revenue-protection/appointment-queue${suffix}`);
}

export async function fetchEligibilityHistory(patientId: string, branchId?: string) {
  const params = new URLSearchParams({ patientId });
  if (branchId) params.set('branchId', branchId);
  return apiRequest<{ eligibilityVerifications: EligibilityVerification[] }>(`/v1/revenue-protection/eligibility?${params.toString()}`);
}

export function formatProtectionAmount(amount: number) {
  return formatCurrency(amount);
}
