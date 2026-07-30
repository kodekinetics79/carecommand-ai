import { clearSession, getAccessToken, refreshSession, setAccessTokenOnly } from './session';

// Error thrown for a non-OK API response. Carries the HTTP status and, when the
// server sent a JSON body, its `message`/`error` so callers can branch on a 409
// (transition/booking conflict) and surface the server's own explanation.
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const apiBaseUrl = import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:3001');
const authMode = import.meta.env.VITE_AUTH_MODE ?? 'login-required';

async function bootstrapDevToken() {
  const response = await fetch(`${apiBaseUrl}/v1/auth/dev-token`, { method: 'POST' });
  if (!response.ok) throw new Error('Unable to bootstrap local API authentication');
  const payload = await response.json() as { token: string };
  setAccessTokenOnly(payload.token);
  return payload.token;
}

async function resolveAccessToken() {
  const accessToken = getAccessToken();
  if (accessToken) return accessToken;

  if (authMode === 'dev-token' && import.meta.env.DEV) {
    return bootstrapDevToken();
  }

  const session = await refreshSession();
  return session.accessToken;
}

async function rawApiRequest<T>(path: string, init?: RequestInit, retryOnRefresh = true): Promise<T> {
  const token = await resolveAccessToken();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });

  if (response.status === 401 && retryOnRefresh) {
    try {
      await refreshSession();
      return rawApiRequest<T>(path, init, false);
    } catch {
      // refreshSession is client-wide single-flight and clears the token once
      // when that shared refresh fails. Do not let each waiting caller race to
      // repeat session cleanup independently.
      throw new Error('Session expired. Please sign in again.');
    }
  }

  if (response.status === 401) {
    clearSession(false);
  }

  if (!response.ok) {
    let message = `API request failed: ${response.status}`;
    let code: string | undefined;
    const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
    if (body?.message) message = body.message;
    if (typeof body?.error === 'string') code = body.error;
    throw new ApiError(response.status, message, code);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return rawApiRequest<T>(path, init);
}

export async function apiHealth() {
  const response = await fetch(`${apiBaseUrl}/health/ready`);
  return response.ok;
}

export async function downloadCsv(path: string, filename: string) {
  const token = await resolveAccessToken();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
