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

export async function login(email: string, password: string) {
  const session = await authRequest<AuthSessionResponse>('/v1/auth/login', { email, password });
  setSessionTokens(session);
  return session;
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
