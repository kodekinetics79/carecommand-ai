// Patient/Client Portal API client. Uses a SEPARATE token (cc_portal_token) from
// the staff session — a portal token can never be used for staff APIs.
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';
const TOKEN_KEY = 'cc_portal_token';

export function getPortalToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function setPortalToken(t: string | null) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

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
  paymentPolicyAcknowledged: boolean; allowedActions: string[]; deepLinkTargets: Record<string, string>;
}
export interface PortalAppt { id: string; service: string; startsAt: string; endsAt: string; status: string; provider: string | null }
export interface PortalRequest { id: string; service: string | null; requestedDateTime: string | null; status: string; createdAt: string }
export interface PortalIntake { id: string; status: string; label: string; readinessScore: number; createdAt: string }
export interface PortalInsurance { id: string; planName: string; memberId: string; groupNumber: string | null; subscriberName: string | null; status: string }
export interface PortalPayment { id: string; amount: number; currency: string; status: string; reason: string; payLink: string | null; dueAt: string | null }
export interface PortalEstimate { id: string; estimatedPatientResponsibility: number; recommendedCollectAmount: number; acknowledged: boolean; createdAt: string; disclaimer: string }
export interface PortalPreferences { sms: boolean; email: boolean; whatsapp: boolean; voice: boolean; marketing: boolean }

export const portalClient = {
  requestLink: (clinicSlug: string, email: string) => pf<{ status: string; message: string; devToken?: string; devNote?: string }>('/v1/portal/auth/request-link', { method: 'POST', auth: false, body: JSON.stringify({ clinicSlug, email }) }),
  signup: (clinicSlug: string, email: string) => pf<{ status: string; message: string; devToken?: string; devNote?: string }>('/v1/portal/auth/signup', { method: 'POST', auth: false, body: JSON.stringify({ clinicSlug, email }) }),
  verify: (token: string) => pf<{ token: string; displayName: string }>('/v1/portal/auth/verify', { method: 'POST', auth: false, body: JSON.stringify({ token }) }),
  me: () => pf<{ displayName: string; email: string | null; clinicName: string }>('/v1/portal/auth/me'),
  logout: () => pf<{ loggedOut: boolean }>('/v1/portal/auth/logout', { method: 'POST' }),

  dashboard: () => pf<PortalDashboard>('/v1/portal/dashboard'),
  appointments: () => pf<{ upcoming: PortalAppt[]; past: PortalAppt[] }>('/v1/portal/appointments'),
  requests: () => pf<PortalRequest[]>('/v1/portal/appointment-requests'),
  createRequest: (body: { service: string; requestedDateTime?: string; notes?: string }) => pf<{ id: string; status: string; deduped: boolean }>('/v1/portal/appointment-requests', { method: 'POST', body: JSON.stringify(body) }),
  intake: () => pf<PortalIntake[]>('/v1/portal/intake'),
  insurance: () => pf<PortalInsurance[]>('/v1/portal/insurance'),
  saveInsurance: (body: { planName: string; memberId: string; groupNumber?: string; subscriberName?: string }) => pf<{ id: string; status: string }>('/v1/portal/insurance', { method: 'POST', body: JSON.stringify(body) }),
  payments: () => pf<PortalPayment[]>('/v1/portal/payments'),
  estimates: () => pf<PortalEstimate[]>('/v1/portal/estimates'),
  acknowledgeEstimate: (id: string) => pf<{ acknowledged: boolean }>(`/v1/portal/estimates/${id}/acknowledge`, { method: 'POST' }),
  acknowledgePaymentPolicy: () => pf<{ acknowledged: boolean }>('/v1/portal/payment-policy/acknowledge', { method: 'POST' }),
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
  completed: { label: 'Up to date', badge: 'badge-emerald' },
  needs_update: { label: 'Needs update', badge: 'badge-amber' },
  payment_required: { label: 'Payment due', badge: 'badge-red' },
  unavailable: { label: 'Not available', badge: 'badge-blue' },
  on_file: { label: 'On file', badge: 'badge-emerald' },
  verified_recently: { label: 'Verified recently', badge: 'badge-emerald' },
  unable_to_verify: { label: 'Clinic review needed', badge: 'badge-amber' },
  expired: { label: 'Expired', badge: 'badge-red' },
};
