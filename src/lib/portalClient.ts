// Patient/Client Portal API client. The short-lived portal bearer is held only
// in memory, separately from the staff session. It is never persisted in web
// storage, so a reload requires a fresh magic-link verification.
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.PROD ? '' : 'http://localhost:3001');
let portalTokenMemory: string | null = null;

export function getPortalToken(): string | null { return portalTokenMemory; }
export function setPortalToken(token: string | null) { portalTokenMemory = token; }

async function pf<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
  const token = getPortalToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.auth !== false && token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) { setPortalToken(null); throw new Error('Your session has ended. Please sign in again.'); }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) { const e = body as { message?: string; error?: string } | null; throw new Error(e?.message ?? e?.error ?? `Request failed (${res.status})`); }
  return body as T;
}

// ---- types (patient-safe) --------------------------------------------------
export interface PortalDashboard {
  displayName: string; clinicName: string; branchName: string | null;
  cards: Record<string, { state: string; amount?: number; currency?: string; count?: number; service?: string; startsAt?: string; detail?: string }>;
  paymentPolicyAvailable: boolean; paymentPolicyAcknowledged: boolean; allowedActions: string[]; deepLinkTargets: Record<string, string>;
}
export interface PortalAppt { id: string; service: string; startsAt: string; endsAt: string; status: string; provider: string | null }
export interface PortalRequest { id: string; service: string | null; requestedDateTime: string | null; status: string; createdAt: string }
export interface PortalBookingProvider { id: string; name: string; specialty: string | null; rating: number; reviewCount: number }
export interface PortalBookingSlot { startsAt: string; endsAt: string }
export interface PortalIntake { id: string; status: string; label: string; readinessScore: number; createdAt: string }
export interface PortalIntakeSection {
  sectionType: string;
  status: string;
  prompt: string;
  acknowledgement: { id: string; version: string; text: string } | null;
}
export interface PortalIntakePacket {
  clinicName: string; status: string; expiresAt: string | null; readinessScore: number;
  appointment: { service: string; startsAt: string } | null;
  objectStorageEnabled: boolean; sections: PortalIntakeSection[];
}
export interface PortalInsurance { id: string; planName: string; memberId: string; groupNumber: string | null; subscriberName: string | null; status: string }
export interface PortalPayment { id: string; amount: number; currency: string; status: string; reason: string; payLink: string | null; payLinkUnavailable: boolean; dueAt: string | null }
export interface PortalEstimate { id: string; estimatedPatientResponsibility: number; recommendedCollectAmount: number; acknowledged: boolean; createdAt: string; disclaimer: string }
export interface PortalPreferences {
  sms: boolean; email: boolean; whatsapp: boolean; marketing: boolean;
  smsAuthorizationStatus: 'opted_out' | 'opted_in' | 'not_recorded';
  emailAuthorizationStatus: 'opted_out' | 'opted_in' | 'not_recorded';
  whatsappAuthorizationStatus: 'opted_out' | 'opted_in' | 'not_recorded';
  marketingAuthorizationStatus: 'opted_out' | 'opted_in' | 'not_recorded';
  voice: boolean; voiceOptedOut: boolean;
  voiceAuthorizationStatus: 'opted_out' | 'opted_in' | 'not_recorded' | string;
}

export const portalClient = {
  requestLink: (clinicSlug: string, email: string) => pf<{ status: string; message: string; devToken?: string; devNote?: string }>('/v1/portal/auth/request-link', { method: 'POST', auth: false, body: JSON.stringify({ clinicSlug, email }) }),
  signup: (clinicSlug: string, email: string) => pf<{ status: string; message: string; devToken?: string; devNote?: string }>('/v1/portal/auth/signup', { method: 'POST', auth: false, body: JSON.stringify({ clinicSlug, email }) }),
  verify: (token: string) => pf<{ token: string; displayName: string }>('/v1/portal/auth/verify', { method: 'POST', auth: false, body: JSON.stringify({ token }) }),
  me: () => pf<{ displayName: string; email: string | null; clinicName: string }>('/v1/portal/auth/me'),
  logout: async () => {
    try { return await pf<{ loggedOut: boolean }>('/v1/portal/auth/logout', { method: 'POST' }); }
    finally { setPortalToken(null); }
  },

  dashboard: () => pf<PortalDashboard>('/v1/portal/dashboard'),
  appointments: () => pf<{ upcoming: PortalAppt[]; past: PortalAppt[] }>('/v1/portal/appointments'),
  cancelAppointment: (id: string, reason?: string) => pf<{ id: string; status: string; deduped?: boolean; deposit?: { needsManualRefund: boolean } }>(`/v1/portal/appointments/${id}/cancel`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) }),
  rescheduleAppointment: (id: string, body: { startsAt: string; durationMin?: number }) => pf<PortalAppt>(`/v1/portal/appointments/${id}/reschedule`, { method: 'POST', body: JSON.stringify(body) }),
  bookingProviders: () => pf<PortalBookingProvider[]>('/v1/portal/booking/providers'),
  bookingSlots: (providerId: string, date: string) => pf<{ providerId: string; date: string; slots: PortalBookingSlot[] }>(`/v1/portal/booking/providers/${providerId}/slots?date=${encodeURIComponent(date)}`),
  bookSlot: (providerId: string, body: { startsAt: string; durationMin?: number; reason: string; channel?: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH' | 'CALL' | 'VIDEO' }) =>
    pf<PortalAppt>(`/v1/portal/booking/providers/${providerId}/book`, { method: 'POST', body: JSON.stringify(body) }),
  requests: () => pf<PortalRequest[]>('/v1/portal/appointment-requests'),
  createRequest: (body: { service: string; requestedDateTime?: string; notes?: string }) => pf<{ id: string; status: string; deduped: boolean }>('/v1/portal/appointment-requests', { method: 'POST', body: JSON.stringify(body) }),
  intake: () => pf<PortalIntake[]>('/v1/portal/intake'),
  intakePacket: (packetId: string) => pf<PortalIntakePacket>(`/v1/portal/intake/${packetId}`),
  submitIntakeSection: (packetId: string, sectionType: string, data: Record<string, unknown>) => pf<string>(`/v1/portal/intake/${packetId}/sections`, { method: 'POST', body: JSON.stringify({ sectionType, data }) }),
  submitIntakePacket: (packetId: string) => pf<{ alreadySubmitted?: boolean }>(`/v1/portal/intake/${packetId}/submit`, { method: 'POST' }),
  insurance: () => pf<PortalInsurance[]>('/v1/portal/insurance'),
  saveInsurance: (body: { planName: string; memberId: string; groupNumber?: string; subscriberName?: string }) => pf<{ id: string; status: string }>('/v1/portal/insurance', { method: 'POST', body: JSON.stringify(body) }),
  payments: () => pf<PortalPayment[]>('/v1/portal/payments'),
  estimates: () => pf<PortalEstimate[]>('/v1/portal/estimates'),
  acknowledgeEstimate: (id: string) => pf<{ acknowledged: boolean }>(`/v1/portal/estimates/${id}/acknowledge`, { method: 'POST' }),
  profile: () => pf<{ firstName: string; lastName: string; email: string; phone: string }>('/v1/portal/profile'),
  saveProfile: (body: { email?: string; phone?: string }) => pf<{ ok: boolean }>('/v1/portal/profile', { method: 'PATCH', body: JSON.stringify(body) }),
  preferences: () => pf<PortalPreferences>('/v1/portal/preferences'),
  savePreferences: (body: Partial<PortalPreferences>) => pf<{ ok: boolean }>('/v1/portal/preferences', { method: 'PATCH', body: JSON.stringify(body) }),
  consents: () => pf<Array<{ purpose: string; granted: boolean; at: string }>>('/v1/portal/consents'),
};

// Patient-safe state → label + tone (no color-only).
export const STATE_META: Record<string, { label: string; badge: string }> = {
  action_required: { label: 'Action required', badge: 'badge-amber' },
  pending_review: { label: 'Pending review', badge: 'badge-blue' },
  scheduled: { label: 'Scheduled', badge: 'badge-blue' },
  completed: { label: 'Up to date', badge: 'badge-emerald' },
  needs_update: { label: 'Needs update', badge: 'badge-amber' },
  payment_required: { label: 'Payment due', badge: 'badge-red' },
  unavailable: { label: 'Not available', badge: 'badge-blue' },
  on_file: { label: 'Policy on file', badge: 'badge-blue' },
  verified_recently: { label: 'Eligibility checked recently', badge: 'badge-emerald' },
  unable_to_verify: { label: 'Clinic review needed', badge: 'badge-amber' },
  expired: { label: 'Expired', badge: 'badge-red' },
};
