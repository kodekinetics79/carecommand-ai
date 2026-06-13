// Platform operator console client. Auth is a static platform token presented
// as X-Platform-Token — deliberately NOT a tenant session. The token is held in
// memory by the page only (never persisted). Backend enforces access.
const apiBaseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

async function platformFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: { ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}), 'X-Platform-Token': token, ...init?.headers },
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { message?: string } | null;
    throw new Error(payload?.message ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface PlatformTenant {
  tenant: { id: string; name: string; slug: string; createdAt: string } | null;
  subscription: { planKey: string; planName: string; status: string; trialEndsAt: string | null; addons: string[] } | null;
  activeUsers: number;
  branches: number;
  enabledFeatures: number;
}

export interface PlatformRequest {
  id: string; tenantId: string; tenantName: string; slug: string; requestType: string;
  status: string; requestedPlanKey: string | null; requestedAddonKeys: string[]; notes: string | null; reviewerNote: string | null; createdAt: string;
}

export const platformConsole = {
  tenants: (token: string) => platformFetch<PlatformTenant[]>('/v1/platform/tenants', token),
  requests: (token: string, status = 'PENDING') => platformFetch<PlatformRequest[]>(`/v1/platform/subscription-requests?status=${status}`, token),
  reviewRequest: (token: string, id: string, decision: 'approve' | 'reject', reviewerNote?: string) =>
    platformFetch<{ id: string; status: string }>(`/v1/platform/subscription-requests/${id}`, token, { method: 'PATCH', body: JSON.stringify({ decision, reviewerNote }) }),
  setTenantStatus: (token: string, tenantId: string, action: 'suspend' | 'reactivate') =>
    platformFetch<{ tenantId: string; status: string }>(`/v1/platform/tenants/${tenantId}/status`, token, { method: 'PATCH', body: JSON.stringify({ action }) }),
};
