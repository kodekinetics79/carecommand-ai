const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'https://carecommand.kodekinetics.com').replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  token?: string;
  csrfToken?: string;
  clinicId?: string | null;
  body?: unknown;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.csrfToken ? { 'X-CSRF-Token': options.csrfToken } : {}),
      ...(options.clinicId ? { 'X-CareCommand-Clinic-Id': options.clinicId } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (typeof payload?.message === 'string') message = payload.message;
    if (typeof payload?.error === 'string') code = payload.error;
    else if (typeof payload?.code === 'string') code = payload.code;
    throw new ApiError(response.status, message, code);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type StaffUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'PROVIDER' | 'FRONT_DESK' | 'BILLING' | string;
  branchId: string | null;
  branch?: { id: string; name: string; location?: string | null } | null;
  clinicAccesses?: Array<{ id: string; name: string; location?: string | null; isPrimary: boolean }>;
  tenant: { id: string; name: string; slug: string };
  active: boolean;
  mfaEnabled: boolean;
};

export type StaffLoginResponse =
  | { accessToken: string; csrfToken: string; user: StaffUser; status?: 'ok' }
  | { status: 'mfa_required' | 'mfa_setup_required'; mfaToken: string };

export async function staffLogin(input: { email: string; password: string; tenantSlug?: string }) {
  return request<StaffLoginResponse>('/v1/auth/login', { method: 'POST', body: input });
}

export async function staffMfaSetup(mfaToken: string) {
  return request<{ secret: string; otpauthUri: string; enabled: false }>('/v1/auth/mfa/setup', {
    method: 'POST', token: mfaToken,
  });
}

export async function staffMfaVerify(mfaToken: string, code: string) {
  return request<{ status: 'ok'; accessToken?: string; csrfToken?: string; user?: StaffUser; enabled?: true }>('/v1/auth/mfa/verify', {
    method: 'POST', token: mfaToken, body: { code },
  });
}

export async function staffRefresh(csrfToken: string) {
  return request<{ accessToken: string; csrfToken: string; user: StaffUser }>('/v1/auth/refresh', {
    method: 'POST', csrfToken,
  });
}

export async function staffMe(token: string) {
  return request<{ user: StaffUser; permissions: string[] }>('/v1/auth/me', { token });
}

export async function staffLogout(token: string, csrfToken?: string) {
  return request<void>('/v1/auth/logout', { method: 'POST', token, csrfToken });
}

export type StaffDashboard = {
  generatedAt: string;
  networkRevenue: number;
  revenueRecovered: number;
  activeCustomers: number;
  todaysAppointments: number;
  noShowRisk: number;
  callsRecovered: number;
  missedCalls: number;
  activeOpportunities: number;
  pendingApprovals: number;
};

export async function staffDashboard(token: string, clinicId?: string | null) {
  return request<StaffDashboard>('/v1/dashboard/summary', { token, clinicId });
}

export type StaffAppointment = {
  id: string;
  patientName: string;
  providerName: string | null;
  service: string;
  startsAt: string;
  endsAt: string;
  status: string;
  channel: string;
};

export async function staffAppointments(token: string, clinicId?: string | null, date = new Date()) {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const query = new URLSearchParams({ from: start.toISOString(), to: end.toISOString(), limit: '50' });
  return request<{ data: StaffAppointment[]; nextCursor?: string | null }>(`/v1/appointments?${query.toString()}`, { token, clinicId });
}

export async function patientRequestLink(input: { clinicSlug: string; email?: string; phone?: string }) {
  return request<{ status: 'ok'; message: string }>('/v1/portal/auth/request-link', { method: 'POST', body: input });
}

export async function patientSignup(input: { clinicSlug: string; email?: string; phone?: string }) {
  return request<{ status: 'ok'; message: string }>('/v1/portal/auth/signup', { method: 'POST', body: input });
}

export async function patientVerify(token: string) {
  return request<{ token: string; displayName: string; expiresInMinutes: number }>('/v1/portal/auth/verify', {
    method: 'POST', body: { token },
  });
}

export async function patientMe(token: string) {
  return request<{ displayName: string; email?: string | null; clinicName: string }>('/v1/portal/auth/me', { token });
}

export type PatientDashboard = {
  displayName: string;
  clinicName: string;
  branchName: string | null;
  clinicTimezone: string;
  cards: {
    nextAppointment: { state: string; service?: string; startsAt?: string };
    intake: { state: string };
    insurance: { state: string; detail?: string };
    payment: { state: string; amount?: number; currency?: string };
    estimate: { state: string };
    appointmentRequests: { state: string; count?: number };
  };
  allowedActions: string[];
};

export async function patientDashboard(token: string) {
  return request<PatientDashboard>('/v1/portal/dashboard', { token });
}

export type PatientAppointment = {
  id: string;
  service: string;
  startsAt: string;
  endsAt: string;
  status: string;
  providerName?: string | null;
  branchName?: string | null;
  clinicTimezone?: string;
};

export async function patientAppointments(token: string) {
  return request<{ upcoming: PatientAppointment[]; past: PatientAppointment[] }>('/v1/portal/appointments', { token });
}

export async function patientRequestAppointment(token: string, input: { service: string; requestedDateTime?: string; notes?: string }) {
  return request<{ id: string; status: string; deduped: boolean }>('/v1/portal/appointment-requests', {
    method: 'POST', token, body: input,
  });
}

export async function patientLogout(token: string) {
  return request<void>('/v1/portal/auth/logout', { method: 'POST', token });
}

export function apiUrl() { return API_URL; }
