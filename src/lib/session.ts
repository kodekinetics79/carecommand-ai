const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export const authEventName = 'carecommand-auth-change';

let accessTokenMemory: string | null = null;
const csrfCookieName = 'cc_csrf';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  branchId?: string | null;
  branch?: { id: string; name: string; location: string } | null;
  tenant: { id: string; name: string; slug: string };
  active: boolean;
}

export interface AuthSessionResponse {
  accessToken: string;
  user: SessionUser;
}

export interface AuthMeResponse {
  user: SessionUser;
  access: {
    tenantId: string;
    branchId?: string | null;
    role: string;
  };
}

function dispatchAuthChange() {
  window.dispatchEvent(new Event(authEventName));
}

function readCookie(name: string) {
  return document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

export function getAccessToken() {
  return accessTokenMemory;
}

export function clearSession(notify = true) {
  accessTokenMemory = null;
  if (notify) {
    dispatchAuthChange();
  }
}

function setSessionTokens(session: AuthSessionResponse) {
  accessTokenMemory = session.accessToken;
  dispatchAuthChange();
}

async function authRequest<T>(path: string, body?: unknown) {
  const csrfToken = readCookie(csrfCookieName);
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(payload?.message ?? `Authentication request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type LoginResult =
  | { kind: 'session'; user: SessionUser }
  | { kind: 'mfa_required'; mfaToken: string }
  | { kind: 'mfa_setup_required'; mfaToken: string }
  | { kind: 'password_expired'; message: string };

interface RawLoginResponse {
  accessToken?: string;
  user?: SessionUser;
  status?: string;
  mfaToken?: string;
  message?: string;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await authRequest<RawLoginResponse>('/v1/auth/login', { email, password });
  if (res.accessToken && res.user) {
    setSessionTokens({ accessToken: res.accessToken, user: res.user });
    return { kind: 'session', user: res.user };
  }
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
  if (!res.accessToken || !res.user) throw new Error('MFA verification did not complete sign-in.');
  setSessionTokens({ accessToken: res.accessToken, user: res.user });
  return res.user;
}

export async function requestPasswordReset(email: string) {
  return authRequest<{ message: string; devToken?: string; emailDelivered?: boolean }>('/v1/auth/password-reset/request', { email });
}

export async function confirmPasswordReset(token: string, newPassword: string) {
  return authRequest<{ message: string }>('/v1/auth/password-reset/confirm', { token, newPassword });
}

export async function refreshSession() {
  try {
    const session = await authRequest<AuthSessionResponse>('/v1/auth/refresh');
    setSessionTokens(session);
    return session;
  } catch (error) {
    clearSession(false);
    throw error;
  }
}

export async function logout() {
  try {
    await authRequest('/v1/auth/logout');
  } finally {
    clearSession();
  }
}

export function setAccessTokenOnly(token: string) {
  accessTokenMemory = token;
  dispatchAuthChange();
}
