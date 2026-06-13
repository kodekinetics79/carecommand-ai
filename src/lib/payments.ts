import { apiRequest } from './api';

// --- Types -----------------------------------------------------------------

export type AppointmentPaymentStatus =
  | 'not_required' | 'required_unpaid' | 'link_created' | 'paid' | 'failed' | 'expired' | 'waived' | 'refunded';

export interface AppointmentPaymentView {
  appointmentId: string;
  patientId: string | null;
  paymentRequestId: string | null;
  depositRequirementId: string | null;
  required: boolean;
  status: AppointmentPaymentStatus;
  amount: number;
  currency: string;
  paymentUrl: string | null;
  dueAt: string | null;
  expiresAt: string | null;
  allowedActions: string[];
  followUpNeeded: boolean;
  deepLinkTarget: string;
  setupRequired: boolean;
}

export interface ProviderStatus {
  provider: string;
  mode: string;
  configured: boolean;
  mock: boolean;
  setupRequired: boolean;
}

export interface PaymentRequestRow {
  paymentRequestId: string;
  appointmentId: string | null;
  patientId: string | null;
  patientName: string | null;
  service: string | null;
  amount: number;
  currency: string;
  status: string;
  mode: string;
  paymentUrl: string | null;
  dueAt: string | null;
  expiresAt: string | null;
  followUpNeeded: boolean;
  deepLinkTarget: string;
}

export type GenerateLinkResult =
  | { status: 'link_created'; mode?: string; reused?: boolean; checkoutUrl: string; publicToken?: string; payment: AppointmentPaymentView }
  | { status: 'setup_required'; setupRequired: true; provider: string; message: string }
  | { status: 'not_required'; message: string }
  | { status: 'failed'; error: string };

// --- Status display metadata ----------------------------------------------

export const PAYMENT_STATUS_META: Record<AppointmentPaymentStatus, { label: string; badge: string }> = {
  not_required: { label: 'No deposit', badge: 'badge-blue' },
  required_unpaid: { label: 'Deposit due', badge: 'badge-amber' },
  link_created: { label: 'Link sent', badge: 'badge-violet' },
  paid: { label: 'Paid', badge: 'badge-emerald' },
  failed: { label: 'Payment failed', badge: 'badge-red' },
  expired: { label: 'Link expired', badge: 'badge-red' },
  waived: { label: 'Waived', badge: 'badge-blue' },
  refunded: { label: 'Refunded', badge: 'badge-blue' },
};

// --- API helpers -----------------------------------------------------------

const base = '/v1/payments';

export const paymentsApi = {
  providerStatus: () => apiRequest<ProviderStatus>(`${base}/provider-status`),
  getAppointmentPayment: (appointmentId: string) => apiRequest<AppointmentPaymentView>(`${base}/appointments/${appointmentId}/payment`),
  evaluateDeposit: (appointmentId: string) =>
    apiRequest<{ evaluation: unknown; payment: AppointmentPaymentView }>(`${base}/appointments/${appointmentId}/deposit`, { method: 'POST' }),
  generatePaymentLink: (appointmentId: string) =>
    apiRequest<GenerateLinkResult>(`${base}/appointments/${appointmentId}/payment-link`, { method: 'POST' }),
  waiveDeposit: (depositRequirementId: string, reason: string) =>
    apiRequest<{ id: string; status: string; waiverReason: string }>(`${base}/deposit-requirements/${depositRequirementId}/waive`, { method: 'POST', body: JSON.stringify({ reason }) }),
  listPaymentRequests: (status?: string) =>
    apiRequest<PaymentRequestRow[]>(`${base}/payment-requests${status ? `?status=${status}` : ''}`),
};
