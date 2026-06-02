const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const tokenStorageKey = 'carecommand.api-token';

let cachedToken = localStorage.getItem(tokenStorageKey);

async function getToken() {
  if (cachedToken) return cachedToken;
  if (import.meta.env.PROD) throw new Error('Production authentication is not configured');

  const response = await fetch(`${apiBaseUrl}/v1/auth/dev-token`, { method: 'POST' });
  if (!response.ok) throw new Error('Unable to bootstrap local API authentication');
  const payload = await response.json() as { token: string };
  cachedToken = payload.token;
  localStorage.setItem(tokenStorageKey, payload.token);
  return payload.token;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      // Only declare a JSON body when one is actually sent — Fastify rejects an
      // empty body when Content-Type is application/json (FST_ERR_CTP_EMPTY_JSON_BODY).
      ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });

  if (response.status === 401) {
    cachedToken = null;
    localStorage.removeItem(tokenStorageKey);
  }
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  // 204 No Content (e.g. DELETE) and other empty bodies have nothing to parse.
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function apiHealth() {
  const response = await fetch(`${apiBaseUrl}/health/ready`);
  return response.ok;
}
