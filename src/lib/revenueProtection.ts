import { apiRequest } from './api';
import { appointments, branches, patients, radarAlerts } from '../data/seedData';
import { formatCurrency } from '../utils/formatters';

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

export interface RevenueProtectionIntegrationStatus {
  insurance: {
    provider: string;
    providerName: string;
    mode: RevenueProtectionMode;
    label: string;
    configured: boolean;
  };
  payment: {
    provider: string;
    providerName: string;
    mode: RevenueProtectionMode;
    label: string;
    configured: boolean;
  };
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

function branchNameFor(id?: string | null) {
  return branches.find(branch => branch.id === id)?.name ?? 'All clinics';
}

function mockOverview(branchId?: string): RevenueProtectionOverview {
  const selectedBranch = branchId ? branches.find(branch => branch.id === branchId) : null;
  const selectedBranchName = selectedBranch?.name ?? 'All clinics';
  const topAppointments = appointments.slice(0, 3);
  const topPatients = patients.slice(0, 3);
  const alerts = radarAlerts.slice(0, 3).map((alert, index) => ({
    id: alert.id,
    branchId: alert.branchId ?? branches[index % branches.length]?.id ?? branches[0].id,
    branchName: branchNameFor(alert.branchId),
    patientId: topPatients[index]?.id ?? null,
    patientName: topPatients[index]?.name ?? '—',
    appointmentId: topAppointments[index]?.id ?? null,
    appointmentService: topAppointments[index]?.service ?? null,
    sourceType: alert.category,
    severity: alert.severity,
    title: alert.title,
    description: alert.description,
    evidence: { suggestedAction: alert.action },
    estimatedValue: alert.estimatedValue ?? 0,
    status: alert.dismissed ? 'resolved' : 'open',
    recommendedAction: alert.action,
    actionLink: '/revenue-protection',
  }));

  return {
    summary: {
      paymentsDueToday: 4,
      copaysExpected: 860,
      depositsCollected: 620,
      unpaidBalances: 1840,
      failedPayments: 1,
      revenueProtected: 2480,
      revenueAtRisk: alerts.reduce((sum, alert) => sum + alert.estimatedValue, 0),
    },
    insurancePayers: [
      { id: 'mock-payer-1', name: 'Mock Payer', tradingPartnerServiceId: 'MOCK', sourceProvider: 'mock', active: true, sortOrder: 0 },
    ],
    patientInsurancePolicies: topPatients.map((patient, index) => ({
      id: `policy-${index}`,
      branchId: patient.branchId,
      branchName: branchNameFor(patient.branchId),
      patientId: patient.id,
      patientName: patient.name,
      payerId: null,
      payerName: 'Mock Payer',
      planName: 'Mock Gold',
      memberId: `TEST-${index + 1}`,
      groupNumber: 'GRP-DEMO',
      relationship: 'self',
      subscriberName: patient.name,
      payerReference: `MOCK-${index + 1}`,
      verificationStatus: 'pending',
      active: true,
      verifiedAt: null,
    })),
    eligibilityVerifications: topAppointments.map((appointment, index) => ({
      id: `elig-${index}`,
      branchId: appointment.branchId,
      branchName: branchNameFor(appointment.branchId),
      patientId: topPatients[index]?.id ?? patients[0].id,
      patientName: topPatients[index]?.name ?? patients[0].name,
      appointmentId: appointment.id,
      payerId: null,
      payerName: 'Mock Payer',
      policyId: null,
      providerMode: 'mock',
      coverageStatus: index === 2 ? 'inactive' : 'active',
      planName: 'Mock Gold',
      copay: 35 + index * 10,
      deductibleRemaining: 650 + index * 250,
      coinsurance: 0.2,
      coverageActive: index !== 2,
      eligibilityMessage: index === 2 ? 'Coverage inactive; verify before treatment.' : 'Coverage active and ready.',
      payerReference: `MOCK-${index + 1}`,
      checkedAt: new Date().toISOString(),
    })),
    patientResponsibilityEstimates: topAppointments.map((appointment, index) => ({
      id: `estimate-${index}`,
      branchId: appointment.branchId,
      branchName: branchNameFor(appointment.branchId),
      patientId: topPatients[index]?.id ?? patients[0].id,
      patientName: topPatients[index]?.name ?? patients[0].name,
      appointmentId: appointment.id,
      appointmentService: appointment.service,
      eligibilityVerificationId: `elig-${index}`,
      estimatedInsurancePortion: 100 + index * 30,
      estimatedPatientResponsibility: 150 + index * 55,
      recommendedCollectAmount: 90 + index * 40,
      reason: 'Mock estimate for local fallback',
      createdAt: new Date().toISOString(),
    })),
    priorAuthorizations: topAppointments.map((appointment, index) => ({
      id: `pa-${index}`,
      branchId: appointment.branchId,
      branchName: branchNameFor(appointment.branchId),
      patientId: topPatients[index]?.id ?? patients[0].id,
      patientName: topPatients[index]?.name ?? patients[0].name,
      appointmentId: appointment.id,
      payerId: null,
      payerName: 'Mock Payer',
      serviceName: appointment.service,
      authNumber: `AUTH-MOCK-${index + 1}`,
      status: index === 1 ? 'submitted' : 'pending',
      dueAt: new Date().toISOString(),
      notes: 'Mock prior authorisation row',
      lastUpdatedAt: new Date().toISOString(),
    })),
    paymentRequests: topAppointments.map((appointment, index) => ({
      id: `pay-${index}`,
      branchId: appointment.branchId,
      branchName: branchNameFor(appointment.branchId),
      patientId: topPatients[index]?.id ?? patients[0].id,
      patientName: topPatients[index]?.name ?? patients[0].name,
      appointmentId: appointment.id,
      appointmentService: appointment.service,
      amount: 90 + index * 35,
      currency: 'USD',
      status: index === 0 ? 'link_sent' : 'pending',
      reason: 'Mock deposit request',
      mode: 'mock',
      paymentUrl: `http://localhost:12000/revenue-protection?payment=mock-${index + 1}`,
      providerReference: `mock-${index + 1}`,
      dueAt: new Date().toISOString(),
    })),
    paymentTransactions: topAppointments.slice(0, 2).map((appointment, index) => ({
      id: `txn-${index}`,
      branchId: appointment.branchId,
      branchName: branchNameFor(appointment.branchId),
      patientId: topPatients[index]?.id ?? patients[0].id,
      patientName: topPatients[index]?.name ?? patients[0].name,
      appointmentId: appointment.id,
      amount: 80 + index * 25,
      currency: 'USD',
      status: index === 0 ? 'succeeded' : 'failed',
      mode: 'mock',
      providerReference: `txn-mock-${index + 1}`,
      receivedAt: new Date().toISOString(),
    })),
    depositRules: [
      {
        id: 'rule-1',
        branchId: null,
        branchName: null,
        name: 'New patient deposit',
        ruleType: 'new-patient',
        description: 'Collect a deposit for new patients before arrival.',
        active: true,
        depositRequired: true,
        amountType: 'fixed',
        amountValue: 50,
        refundable: false,
        cancellationWindowHours: 24,
        appliesToNewPatients: true,
        appliesToHighNoShowRisk: false,
        appliesToPremiumServices: false,
        appliesToSameDayAppointments: false,
        appliesToExemptPatients: false,
        sortOrder: 0,
      },
      {
        id: 'rule-2',
        branchId: selectedBranch?.id ?? null,
        branchName: selectedBranchName,
        name: 'High no-show hold',
        ruleType: 'risk-based',
        description: 'Apply a higher deposit for higher-risk appointments.',
        active: true,
        depositRequired: true,
        amountType: 'percentage',
        amountValue: 25,
        refundable: true,
        cancellationWindowHours: 12,
        appliesToNewPatients: false,
        appliesToHighNoShowRisk: true,
        appliesToPremiumServices: false,
        appliesToSameDayAppointments: true,
        appliesToExemptPatients: false,
        sortOrder: 1,
      },
    ],
    depositRequirements: topAppointments.map((appointment, index) => ({
      id: `dep-${index}`,
      branchId: appointment.branchId,
      branchName: branchNameFor(appointment.branchId),
      patientId: topPatients[index]?.id ?? patients[0].id,
      patientName: topPatients[index]?.name ?? patients[0].name,
      appointmentId: appointment.id,
      appointmentService: appointment.service,
      depositRuleId: `rule-${index + 1}`,
      paymentRequestId: index === 2 ? `payment-${index}` : null,
      depositRuleName: index === 0 ? 'New patient deposit' : 'High no-show hold',
      status: index === 1 ? 'waived' : index === 2 ? 'collected' : 'requested',
      requiredAmount: 90 + index * 30,
      collectedAmount: index === 2 ? 110 : 0,
      waiverReason: index === 1 ? 'Mock manager waiver' : null,
      reason: 'Mock deposit workflow',
      mode: 'mock',
      dueAt: new Date().toISOString(),
      collectedAt: index === 2 ? new Date().toISOString() : null,
    })),
    revenueProtectionAlerts: alerts,
    integrationRunLogs: [
      {
        id: 'run-1',
        branchId: selectedBranch?.id ?? null,
        branchName: selectedBranchName,
        provider: 'mock',
        providerMode: 'mock',
        operation: 'eligibility.check',
        status: 'success',
        requestSummary: { note: 'local fallback' },
        responseSummary: { coverageStatus: 'active' },
        errorMessage: null,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

function mockIntegrationStatus(): RevenueProtectionIntegrationStatus {
  return {
    insurance: {
      provider: 'mock',
      providerName: 'Mock Eligibility',
      mode: 'mock',
      label: 'Mock Mode',
      configured: false,
    },
    payment: {
      provider: 'mock',
      providerName: 'Mock Payments',
      mode: 'mock',
      label: 'Mock Mode',
      configured: false,
    },
    payerCount: 1,
    recentRuns: 1,
    latestRun: {
      provider: 'mock',
      providerMode: 'mock',
      operation: 'eligibility.check',
      status: 'success',
      createdAt: new Date().toISOString(),
    },
  };
}

export async function fetchRevenueProtectionOverview(branchId?: string) {
  try {
    return await apiRequest<RevenueProtectionOverview>(branchId ? `/v1/revenue-protection/overview?branchId=${branchId}` : '/v1/revenue-protection/overview');
  } catch {
    return mockOverview(branchId);
  }
}

export async function fetchRevenueProtectionIntegrationStatus() {
  try {
    return await apiRequest<RevenueProtectionIntegrationStatus>('/v1/revenue-protection/integration-status');
  } catch {
    return mockIntegrationStatus();
  }
}

export async function checkEligibility(input: { patientId?: string; appointmentId?: string; branchId?: string; payerId?: string; serviceType?: string }) {
  return apiRequest<EligibilityVerification>('/v1/revenue-protection/eligibility/check', {
    method: 'POST',
    body: JSON.stringify(input),
  });
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

export async function fetchAppointmentVerificationQueue(branchId?: string) {
  const suffix = branchId ? `?branchId=${branchId}` : '';
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
