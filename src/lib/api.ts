import { clearSession, getAccessToken, refreshSession, setAccessTokenOnly } from './session';

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
      clearSession(false);
      throw new Error('Session expired. Please sign in again.');
    }
  }

  if (response.status === 401) {
    clearSession(false);
  }

  if (!response.ok) throw new Error(humanApiMessage(response.status));
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

// Plain-language fallbacks so a failed request never renders as
// "API request failed: 500" in the product. A server-supplied message wins.
function humanApiMessage(status: number): string {
  if (status === 400) return 'That request could not be processed. Please check the details and try again.';
  if (status === 403) return 'You do not have permission to do that.';
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
