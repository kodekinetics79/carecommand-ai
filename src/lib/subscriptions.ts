import { apiRequest } from './api';

export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED' | 'none';

export const STATUS_LABEL: Record<string, string> = {
  TRIAL: 'Trial', ACTIVE: 'Active', PAST_DUE: 'Past due', SUSPENDED: 'Suspended', CANCELLED: 'Cancelled', none: 'No plan',
};
export const STATUS_BADGE: Record<string, string> = {
  TRIAL: 'badge badge-blue', ACTIVE: 'badge badge-emerald', PAST_DUE: 'badge badge-amber',
  SUSPENDED: 'badge badge-red', CANCELLED: 'badge badge-red', none: 'badge badge-blue',
};

export interface PlanFeature { featureKey: string; label: string; included: boolean; limitValue: number | null; note: string | null }
export interface Plan { key: string; name: string; description: string; tier: number; monthlyPrice: number | null; features: PlanFeature[] }

export interface CurrentSubscription {
  status: SubscriptionStatus;
  plan: { key: string; name: string; tier: number; description: string } | null;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  startedAt?: string;
  addons: Array<{ key: string; name: string; featureKey: string | null; active: boolean; quantity: number }>;
  note?: string;
}

export interface Entitlement { featureKey: string; label: string; enabled: boolean; source: string; limitValue: number | null }

export interface AdminOverview {
  scope: string;
  note: string;
  current: { status: string; planKey: string } | null;
  plans: Array<{ key: string; name: string; tier: number; description: string; featureKeys: string[] }>;
  addons: Array<{ key: string; name: string; description: string; featureKey: string | null; active: boolean }>;
  entitlements: Entitlement[];
}

export interface SubscriptionRequest {
  id: string;
  requestType: string;
  status: string;
  requestedPlanKey: string | null;
  requestedAddonKeys: string[];
  notes: string | null;
  reviewerNote: string | null;
  createdAt: string;
}

const base = '/v1/subscriptions';

export const subscriptionApi = {
  plans: () => apiRequest<Plan[]>(`${base}/plans`),
  current: () => apiRequest<CurrentSubscription>(`${base}/current`),
  features: () => apiRequest<Entitlement[]>(`${base}/features`),
  feature: (key: string) => apiRequest<Entitlement>(`${base}/feature/${key}`),
  adminOverview: () => apiRequest<AdminOverview>(`${base}/admin/overview`),
  // Tenant admins can no longer change plans directly — they create a request.
  createRequest: (body: { planKey?: string; addonKeys?: string[]; requestType?: string; notes?: string }) =>
    apiRequest<{ status: string; requestId: string; requestType: string }>(`${base}/requests`, { method: 'POST', body: JSON.stringify(body) }),
  requests: () => apiRequest<SubscriptionRequest[]>(`${base}/requests`),
};

// Maps a feature entitlement to a UI availability label.
export function availabilityLabel(ent: Entitlement): { label: string; cls: string } {
  if (!ent.enabled) return { label: 'Locked', cls: 'badge badge-red' };
  if (ent.limitValue != null) return { label: `Usage limited (${ent.limitValue})`, cls: 'badge badge-amber' };
  if (ent.source === 'addon') return { label: 'Add-on', cls: 'badge badge-violet' };
  return { label: 'Included', cls: 'badge badge-emerald' };
}
