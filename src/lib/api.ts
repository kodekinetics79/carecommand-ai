import { clearSession, getAccessToken, refreshSession, setAccessTokenOnly } from './session';

const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
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

  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
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
