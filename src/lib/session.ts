const apiBaseUrl = import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:3001');

export const authEventName = 'carecommand-auth-change';
export const clinicSelectionEventName = 'carecommand-clinic-change';

let accessTokenMemory: string | null = null;
let csrfTokenMemory: string | null = null;
let refreshInFlight: Promise<AuthSessionResponse> | null = null;
let selectedClinicMemory: string | null = null;
const csrfCookieName = 'cc_csrf';
const clinicSelectionStorageKey = 'carecommand-active-clinic';
interface StoredClinicSelection { tenantId?: string; clinicId?: string }

/**
 * An auth endpoint answered, and refused.
 *
 * The status matters to exactly one caller: whoever asked for a session and did
 * not get one. `refreshSession()` rejecting with 401 means there is no session
 * left to rebuild — the user signed out, or the refresh token expired or was
 * revoked — and the app must return to /login. A refresh that failed because
 * the network dropped is not an answer at all and must leave the session alone.
 * A bare `Error` cannot tell those apart, and the app used to treat both as the
 * second: after signing out, the workspace stayed on screen.
 */
export class AuthRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthRequestError';
    this.status = status;
  }
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  branchId?: string | null;
  branch?: { id: string; name: string; location: string } | null;
  clinicAccesses?: Array<{ id: string; name: string; location: string; isPrimary: boolean }>;
  tenant: { id: string; name: string; slug: string };
  active: boolean;
  /** Server-resolved grants, including tenant RoleDefinition overrides. */
  effectivePermissions?: string[];
}

export interface AuthSessionResponse {
  accessToken: string;
  csrfToken: string;
  user: SessionUser;
}

export interface AuthMeResponse {
  user: SessionUser;
  access: {
    tenantId: string;
    branchId?: string | null;
    branchIds?: string[];
    role: string;
    permissions: string[];
  };
}

export type AuthChangeState = 'available' | 'cleared';

function dispatchAuthChange(state: AuthChangeState) {
  window.dispatchEvent(new CustomEvent<{ state: AuthChangeState }>(authEventName, { detail: { state } }));
}

function readCookie(name: string) {
  return document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

export function getAccessToken() {
  return accessTokenMemory;
}

export function clearSession(notify = true) {
  accessTokenMemory = null;
  csrfTokenMemory = null;
  selectedClinicMemory = null;
  if (typeof window !== 'undefined') window.localStorage?.removeItem(clinicSelectionStorageKey);
  if (notify) {
    dispatchAuthChange('cleared');
  }
}

function restoreClinicSelection(user: SessionUser) {
  let stored: StoredClinicSelection | null;
  try {
    stored = JSON.parse(window.localStorage.getItem(clinicSelectionStorageKey) ?? 'null') as StoredClinicSelection | null;
  } catch {
    stored = null;
  }
  const operationalRole = ['MANAGER', 'PROVIDER', 'FRONT_DESK', 'BILLING'].includes(user.role);
  // OWNER and ADMIN sessions are tenant-wide unless the user deliberately
  // narrows a visible request. Never resurrect an invisible clinic header from
  // a prior account/session: that made network pages silently omit clinics
  // while still labelling themselves network-wide.
  if (!operationalRole) {
    selectedClinicMemory = null;
    window.localStorage?.removeItem(clinicSelectionStorageKey);
    return;
  }
  const assignedIds = user.clinicAccesses?.map(clinic => clinic.id) ?? [];
  const storedAllowed = stored?.tenantId === user.tenant.id
    && typeof stored.clinicId === 'string'
    && assignedIds.includes(stored.clinicId);
  selectedClinicMemory = storedAllowed ? stored!.clinicId! : user.branchId ?? assignedIds[0] ?? null;
  if (selectedClinicMemory) {
    window.localStorage.setItem(clinicSelectionStorageKey, JSON.stringify({ tenantId: user.tenant.id, clinicId: selectedClinicMemory }));
  }
}

function setSessionTokens(session: AuthSessionResponse) {
  accessTokenMemory = session.accessToken;
  csrfTokenMemory = session.csrfToken;
  restoreClinicSelection(session.user);
  dispatchAuthChange('available');
}

export function getSelectedClinicId() {
  return selectedClinicMemory;
}

export function selectClinic(tenantId: string, clinicId: string) {
  selectedClinicMemory = clinicId;
  window.localStorage.setItem(clinicSelectionStorageKey, JSON.stringify({ tenantId, clinicId }));
  // The access token intentionally lives only in memory. A hard reload would
  // throw it away and bounce the user to sign-in, so clinic changes remount
  // protected page content inside the current authenticated tab instead.
  window.dispatchEvent(new CustomEvent(clinicSelectionEventName, { detail: { tenantId, clinicId } }));
}

async function bootstrapCsrfToken(): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/v1/auth/csrf`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Unable to initialize secure session: ${response.status}`);
  const payload = await response.json() as { csrfToken?: string };
  if (!payload.csrfToken) throw new Error('Unable to initialize secure session.');
  csrfTokenMemory = payload.csrfToken;
  return payload.csrfToken;
}

async function authRequest<T>(path: string, body?: unknown, acceptedErrorStatuses: number[] = [], csrfRequired = false) {
  // document.cookie works for same-origin deployments. In split SPA/API
  // deployments the browser intentionally hides the API-domain cookie from
  // JavaScript, so use the API-returned value held only in module memory.
  let csrfToken = csrfTokenMemory ?? readCookie(csrfCookieName);
  if (csrfRequired && !csrfToken) csrfToken = await bootstrapCsrfToken();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    throw new AuthRequestError(response.status, payload?.message ?? `Authentication request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type LoginResult =
  | { kind: 'session'; user: SessionUser }
  | { kind: 'tenant_required'; message: string }
  | { kind: 'mfa_required'; mfaToken: string }
  | { kind: 'mfa_setup_required'; mfaToken: string }
  | { kind: 'password_expired'; message: string };

interface RawLoginResponse {
  accessToken?: string;
  csrfToken?: string;
  user?: SessionUser;
  status?: string;
  mfaToken?: string;
  message?: string;
}

export async function login(email: string, password: string, tenantSlug?: string): Promise<LoginResult> {
  const res = await authRequest<RawLoginResponse>(
    '/v1/auth/login',
    { email, password, ...(tenantSlug ? { tenantSlug } : {}) },
    [409],
  );
  if (res.accessToken && res.csrfToken && res.user) {
    setSessionTokens({ accessToken: res.accessToken, csrfToken: res.csrfToken, user: res.user });
    return { kind: 'session', user: res.user };
  }
  if (res.status === 'tenant_required') return { kind: 'tenant_required', message: res.message ?? 'Enter your clinic workspace identifier.' };
  if (res.status === 'mfa_required' && res.mfaToken) return { kind: 'mfa_required', mfaToken: res.mfaToken };
  if (res.status === 'mfa_setup_required' && res.mfaToken) return { kind: 'mfa_setup_required', mfaToken: res.mfaToken };
  if (res.status === 'password_expired') return { kind: 'password_expired', message: res.message ?? 'Your password has expired.' };
  throw new Error('Unexpected login response.');
}

// Bearer-auth POST for the short-lived MFA login tokens (setup/challenge).
async function authRequestBearer<T>(path: string, bearer: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...(body != null ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${bearer}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(payload?.message ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function mfaSetupWithToken(mfaToken: string) {
  return authRequestBearer<{ secret: string; otpauthUri: string; enabled: boolean }>('/v1/auth/mfa/setup', mfaToken, {});
}

export async function mfaVerifyWithToken(mfaToken: string, code: string): Promise<SessionUser> {
  const res = await authRequestBearer<RawLoginResponse>('/v1/auth/mfa/verify', mfaToken, { code });
  if (!res.accessToken || !res.csrfToken || !res.user) throw new Error('MFA verification did not complete sign-in.');
  setSessionTokens({ accessToken: res.accessToken, csrfToken: res.csrfToken, user: res.user });
  return res.user;
}

export async function requestPasswordReset(email: string, tenantSlug?: string) {
  return authRequest<{ message: string; devToken?: string }>('/v1/auth/password-reset/request', { email, ...(tenantSlug ? { tenantSlug } : {}) });
}

export async function confirmPasswordReset(token: string, newPassword: string) {
  return authRequest<{ message: string }>('/v1/auth/password-reset/confirm', { token, newPassword });
}

export async function refreshSession() {
  // A page reload mounts several session/API consumers at once. Refresh tokens
  // rotate on every use, so concurrent refresh calls would race: the first wins
  // and every later request presents an already-revoked cookie. Share one
  // module-wide operation so all callers observe the same success or failure.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const session = await authRequest<AuthSessionResponse>('/v1/auth/refresh', undefined, [], true);
      setSessionTokens(session);
      return session;
    } catch (error) {
      clearSession(false);
      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function logout() {
  try {
    await authRequest('/v1/auth/logout', undefined, [], true);
  } finally {
    clearSession();
  }
}

export function setAccessTokenOnly(token: string) {
  accessTokenMemory = token;
  dispatchAuthChange('available');
}
