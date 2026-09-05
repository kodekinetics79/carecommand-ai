import { apiRequest, publicApiRequest } from './api';

// --- Types -----------------------------------------------------------------

export interface IntakePacket {
  intakePacketId: string;
  appointmentId: string | null;
  appointmentRequestId: string | null;
  patientId: string | null;
  leadId: string | null;
  status: string;
  source: string;
  readinessScore: number;
  submittedAt: string | null;
  reviewedAt: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  sections: Array<{ sectionType: string; status: string }>;
  allowedActions: string[];
  deepLinkTarget: string;
  setupRequired: boolean;
  created?: boolean;
  publicToken?: string | null;
  publicUrl?: string | null;
  /** Permissioned staff context. Never present on the public token contract. */
  subject: { kind: 'patient' | 'lead' | 'unknown'; name: string | null };
  clinic: { id: string; name: string; timezone: string } | null;
  visit: { service: string | null; startsAt: string | null } | null;
}

export interface IntakePacketDetail extends IntakePacket {
  documents: Array<{ documentType: string; status: string; fileName: string | null }>;
  consentRecords: Array<{ consentType: string; status: string; acceptedAt: string | null }>;
}

export interface PublicIntakeView {
  clinicName: string;
  status: string;
  expiresAt: string | null;
  readinessScore: number;
  appointment: { service: string; startsAt: string } | null;
  objectStorageEnabled: boolean;
  sections: Array<{
    sectionType: string;
    status: string;
    prompt: string;
    acknowledgement: { id: string; version: string; text: string } | null;
  }>;
}

/**
 * The link a receptionist actually hands to a patient.
 *
 * The server can only build an absolute URL when PUBLIC_APP_URL names the
 * deployment, and it answers null otherwise rather than inventing one. The
 * browser has no such gap: the intake page is served by this same app, so its
 * own origin is always the right host. Callers used to fall back to the bare
 * path `/intake/<token>`, which copies out as a string no patient can open.
 */
export function intakeLink(publicUrl: string | null | undefined, publicToken: string | null | undefined): string | null {
  if (publicUrl) return publicUrl;
  if (!publicToken) return null;
  return new URL(`/intake/${publicToken}`, window.location.origin).toString();
}

export const INTAKE_STATUS_META: Record<string, { label: string; badge: string }> = {
  draft: { label: 'Draft', badge: 'badge-blue' },
  // The module has no delivery mechanism, so a packet is never 'Sent'. The
  // label states what is true and what the desk still has to do.
  link_issued: { label: 'Link ready to share', badge: 'badge-violet' },
  sent: { label: 'Sent', badge: 'badge-violet' },
  in_progress: { label: 'In progress', badge: 'badge-amber' },
  submitted: { label: 'Submitted', badge: 'badge-blue' },
  needs_review: { label: 'Needs review', badge: 'badge-amber' },
  approved: { label: 'Approved', badge: 'badge-emerald' },
  expired: { label: 'Expired', badge: 'badge-red' },
  cancelled: { label: 'Canceled', badge: 'badge-red' },
};

export const SECTION_LABEL: Record<string, string> = {
  demographics: 'Demographics', communication_consent: 'Communication consent', insurance: 'Insurance',
  insurance_card: 'Insurance card', photo_id: 'Photo ID', payment_policy: 'Payment policy',
  estimate_acknowledgement: 'Estimate acknowledgement', consent_forms: 'Consent forms',
  pre_visit_checklist: 'Pre-visit checklist', custom: 'Additional',
};

const base = '/v1/intake';

export const intakeApi = {
  createPacket: (body: { appointmentId?: string; appointmentRequestId?: string; patientId?: string; leadId?: string; source?: string; force?: boolean }) =>
    apiRequest<IntakePacket>(`${base}/packets`, { method: 'POST', body: JSON.stringify(body) }),
  listPackets: (status?: string) => apiRequest<IntakePacket[]>(`${base}/packets${status ? `?status=${status}` : ''}`),
  queue: () => apiRequest<IntakePacket[]>(`${base}/queue`),
  getPacket: (id: string) => apiRequest<IntakePacketDetail>(`${base}/packets/${id}`),
  review: (id: string, action: 'approve' | 'needs_review') => apiRequest<IntakePacket>(`${base}/packets/${id}/review`, { method: 'PATCH', body: JSON.stringify({ action }) }),
  resend: (id: string) => apiRequest<{ resent: boolean; publicToken: string; publicUrl: string }>(`${base}/packets/${id}/resend`, { method: 'POST' }),
  forAppointment: (appointmentId: string) => apiRequest<IntakePacket | { exists: false }>(`${base}/appointment/${appointmentId}`),

  // Public (token) — no auth.
  publicGet: (token: string) => publicApiRequest<PublicIntakeView>(`${base}/public/${token}`),
  publicSubmitSection: (token: string, sectionType: string, data: Record<string, unknown>) =>
    publicApiRequest<PublicIntakeView>(`${base}/public/${token}/sections`, { method: 'POST', body: JSON.stringify({ sectionType, data }) }),
  publicSubmit: (token: string) => publicApiRequest<{ submitted: boolean; status: string; alreadySubmitted: boolean; message: string }>(`${base}/public/${token}/submit`, { method: 'POST' }),
};
