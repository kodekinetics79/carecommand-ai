import { clearSession, getAccessToken, refreshSession, setAccessTokenOnly } from './session';

// Error thrown for a non-OK API response. Carries the HTTP status and, when the
// server sent a JSON body, its `message`/`error` so callers can branch on a 409
// (transition/booking conflict) and surface the server's own explanation.
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(status: number, message: string, code?: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
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
    // Keep the hardened ApiError (status/code/details let callers branch on a
    // 409) but default the user-visible text to plain language instead of a
    // raw HTTP code. A server-supplied `message` still wins, except on the
    // access denials handled below.
    let message = humanApiMessage(response.status);
    let code: string | undefined;
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    // errors.ts sends the code as `error`; a route that answers with its own
    // structured body (the verify-provider route's `{ code, message, agent }`)
    // sends it as `code`. Accept both so callers can branch either way.
    if (typeof body?.error === 'string') code = body.error;
    else if (typeof body?.code === 'string') code = body.code;
    // An access denial is a fact about this account, not a fault to report. The
    // API answers with the permission key it enforced ("…required permission
    // (billing:read)…") or Fastify's bare "Forbidden"; neither is language for a
    // clinic user. Keep the plain line and let callers branch on `code` /
    // `details`, which are untouched — as is the server check itself.
    // Entitlement denials (`feature_locked`) keep their own message: that one
    // names a real upgrade the tenant can actually buy.
    // Narrow deliberately. errors.ts sends `handledError.code ?? 'INTERNAL_SERVER_ERROR'`,
    // so only an RBAC denial carries 'insufficient_permission' (permissions.ts:216)
    // and only an entitlement denial carries 'feature_locked'. Every OTHER 403 —
    // a suspended workspace, a branch-scope refusal, a consent review — arrives
    // with a real explanation and code INTERNAL_SERVER_ERROR. Suppressing those
    // told staff to "ask a clinic owner or administrator" about a suspension no
    // one in the workspace can reverse. Only the true RBAC case is replaced.
    const accessDenied = response.status === 403 && code === 'insufficient_permission';
    if (!accessDenied && typeof body?.message === 'string') message = body.message;
    throw new ApiError(response.status, message, code, body ?? undefined);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

// Plain-language fallbacks so a failed request never renders as
// "API request failed: 500" in the product. A server-supplied message wins.
// Exported so the shared screen-state contract (lib/resourceState.ts) can put
// the same sentences on a panel that failed to load.
export function humanApiMessage(status: number): string {
  if (status === 400) return 'That request could not be processed. Please check the details and try again.';
  if (status === 403) return 'You do not have access to this. Ask a clinic owner or administrator if you need it.';
  if (status === 404) return 'That item could not be found. It may have been moved or deleted.';
  if (status === 409) return 'Someone else changed this while you were working. Refresh and try again.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
  return 'That request could not be completed. Please try again.';
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
