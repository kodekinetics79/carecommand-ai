// Platform Admin Console client. Uses a PlatformUser JWT (NOT a tenant session,
// NOT the legacy static token). The privileged token is memory-only: reload or
// tab close requires re-authentication and no bearer credential is persisted in
// browser storage.
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.PROD ? '' : 'http://localhost:3001');
let platformToken: string | null = null;

export function getPlatformToken(): string | null { return platformToken; }
export function setPlatformToken(token: string | null) { platformToken = token; }

async function pf<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
  const token = getPlatformToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.auth !== false && token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) { setPlatformToken(null); throw new Error('Platform session expired. Please sign in again.'); }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) { const e = body as { message?: string; error?: string } | null; throw new Error(e?.message ?? e?.error ?? `Request failed (${res.status})`); }
  return body as T;
}

export interface PlatformMe { id: string; email: string | null; name: string; role: string; legacy: boolean; mfaEnabled: boolean; mfaRequired?: boolean }
export interface TenantSummary {
  tenant: {
    id: string; name: string; slug: string; status: string; createdAt: string; lastActivityAt: string;
    /** demo | pilot | production. A demo workspace is refused at the call gates. */
    mode: string; modeDescription: string; liveCallingAllowed: boolean;
  } | null;
  subscription: { planKey: string; planName: string; status: string; trialEndsAt: string | null; addons: string[] } | null;
  activeUsers: number; branches: number; enabledFeatures: number; setupStatus: string; deepLinkTarget: string | null;
  entitlements?: Array<{
    featureKey: string; enabled: boolean; source: string; limitValue: number | null;
    /** Set when a platform override lapses on a date, with why it was granted. */
    overrideExpiresAt?: string | null; overrideReason?: string | null;
  }>;
}

export type PilotEntityType = 'patients' | 'appointments' | 'insurance';

export interface PilotImportPreset {
  id: string;
  tenantId: string;
  entityType: PilotEntityType;
  name: string;
  isDefault: boolean;
  mapping: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface PilotStatusShare {
  id: string;
  tenantId: string;
  label: string | null;
  expiresAt: string;
  lastViewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  publicUrlAvailable: false;
  url: null;
}

export interface PilotStatusShareCreated {
  id: string;
  tenantId: string;
  label: string | null;
  expiresAt: string;
  token: string;
  url: string;
  clinicName: string;
  clinicSlug: string;
}

export interface PilotChecklistItem {
  key: string;
  label: string;
  done: boolean;
  detail: string;
}

export interface PilotChecklistView {
  tenant: { id: string; name: string; slug: string; createdAt: string; updatedAt: string } | null;
  readinessScore: number;
  readyCount: number;
  itemCount: number;
  items: PilotChecklistItem[];
  counts: { branches: number; users: number; patients: number; appointments: number; policies: number; audits: number; imports: number };
  latestImport: { action: string; createdAt: string; metadata: unknown } | null;
}

export interface PilotImportField {
  key: string;
  label: string;
  required: boolean;
  example: string | null;
  mappedHeader: string | null;
}

export interface PilotImportPreviewRow {
  index: number;
  status: 'ok' | 'warning' | 'error';
  issues: string[];
  sample: Record<string, unknown>;
}

export interface PilotImportPreview {
  entityType: PilotEntityType;
  headers: string[];
  fields: PilotImportField[];
  mapping: Record<string, string>;
  preset?: { id: string; name: string; isDefault: boolean } | null;
  summary: { total: number; valid: number; warnings: number; invalid: number };
  rows: PilotImportPreviewRow[];
  canCommit: boolean;
}

export interface PilotImportCommit {
  entityType: PilotEntityType;
  preset?: { id: string; name: string; isDefault: boolean } | null;
  summary: { created: number; updated: number; skipped: number; warnings: number; total: number; validRows: number; invalidRows: number };
  preview: PilotImportPreviewRow[];
}

export interface SystemHealth { api: string; database: string; redis: string; dbLatencyMs: number | null; responseMs: number; checkedAt: string }

// Mirrors server/modules/subscriptions/catalog.ts FEATURE_LABELS (premium feature catalog).
export const FEATURE_LABELS: Record<string, string> = {
  appointments: 'Appointments & Scheduling',
  patient_crm: 'Patient CRM',
  basic_reports: 'Basic Reports',
  payments_deposits: 'Payments & Deposits',
  revenue_protection: 'Revenue Protection',
  campaign_automation: 'Campaign Automation',
  ai_receptionist: 'AI Receptionist',
  device_integration: 'Device Integration Center',
  insurance_eligibility: 'Insurance Eligibility',
  advanced_reports: 'Advanced Reports',
  multi_location: 'Multi-Location',
  compliance_readiness: 'Compliance Readiness Center',
  staff_kpis: 'Staff KPIs',
  api_access: 'API Access',
  custom_integrations: 'Custom Integrations',
};

// Company record an operator maintains for a client. Every field is nullable:
// null means "not recorded" and must render as such, never as an empty value
// the reader could mistake for a known blank.
export interface TenantCompany {
  legalName: string | null; companyNumber: string | null;
  addressLine1: string | null; addressLine2: string | null;
  city: string | null; region: string | null; postalCode: string | null; country: string | null;
  mainPhone: string | null; website: string | null;
  primaryContactName: string | null; primaryContactEmail: string | null; primaryContactPhone: string | null;
  billingContactName: string | null; billingContactEmail: string | null;
  /** Relationship facts. Dates come back as ISO strings. */
  contractStartedAt: string | null; accountManager: string | null; baaSignedAt: string | null;
  accountNotes: string | null;
}

// The platform plane cannot read a tenant's staff list by design; it sees the
// account owner, aggregate role counts, and branches. There is no roster here.
export interface TenantAccountRecord {
  tenantId: string; name: string; slug: string; status: string; createdAt: string;
  company: TenantCompany;
  accountOwner: {
    id: string; displayName: string; email: string; role: string;
    active: boolean; mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string;
  } | null;
  roleBreakdown: Array<{ role: string; active: number; inactive: number }>;
  branches: Array<{ id: string; name: string; location: string; timezone: string; active: boolean; createdAt: string }>;
}

// Staff roster, readable only under an open support session (break-glass).
// The server returns 403 support_session_required when none is open, so an
// empty list never stands in for "not permitted".
export interface TenantRoster {
  tenantId: string;
  supportSession: { id: string; reason: string; expiresAt: string; operatorEmail: string | null };
  users: Array<{
    id: string; displayName: string; email: string; role: string; branchName: string | null;
    active: boolean; mfaEnabled: boolean; lockedUntil: string | null; lastLoginAt: string | null; createdAt: string;
  }>;
}

export const TENANT_STATUS_BADGE: Record<string, string> = { active: 'badge-emerald', suspended: 'badge-red', cancelled: 'badge-red' };
export const SUB_STATUS_BADGE: Record<string, string> = { ACTIVE: 'badge-emerald', TRIAL: 'badge-violet', PAST_DUE: 'badge-amber', SUSPENDED: 'badge-red', CANCELLED: 'badge-red' };

export const platformAdmin = {
  login: (email: string, password: string) => pf<{ token?: string; mfaRequired?: boolean; mfaSetupRequired?: boolean; mfaToken?: string; user?: PlatformMe }>(`/v1/platform/auth/login`, { method: 'POST', auth: false, body: JSON.stringify({ email, password }) }),
  mfaSetup: (mfaToken: string) => pf<{ secret: string; otpauthUri: string; enabled: false }>(`/v1/platform/auth/mfa/setup`, { method: 'POST', auth: false, headers: { Authorization: `Bearer ${mfaToken}` }, body: '{}' }),
  mfaVerify: (code: string, mfaToken: string) => pf<{ token: string; user: PlatformMe }>(`/v1/platform/auth/mfa/verify`, { method: 'POST', auth: false, headers: { Authorization: `Bearer ${mfaToken}` }, body: JSON.stringify({ code }) }),
  me: () => pf<PlatformMe>(`/v1/platform/auth/me`),
  logout: () => pf<{ loggedOut: boolean }>(`/v1/platform/auth/logout`, { method: 'POST' }),

  overview: () => pf<{ tenants: number; activeTenants: number; suspendedTenants: number; pendingRequests: number; platformUsers: number }>(`/v1/platform/overview`),
  health: () => pf<SystemHealth>(`/v1/platform/health`),
  tenants: () => pf<TenantSummary[]>(`/v1/platform/tenants`),
  tenant: (id: string) => pf<TenantSummary>(`/v1/platform/tenants/${id}`),
  createTenant: (body: { name: string; slug: string; planKey?: string; ownerName: string; ownerEmail: string; ownerPassword: string; defaultBranchName?: string; timezone?: string }) =>
    pf<TenantSummary>(`/v1/platform/tenants`, { method: 'POST', body: JSON.stringify(body) }),
  company: (id: string) => pf<TenantAccountRecord>(`/v1/platform/tenants/${id}/company`),
  updateCompany: (id: string, body: Partial<TenantCompany> & { reason: string }) =>
    pf<{ tenantId: string; company: TenantCompany; changed: string[] }>(`/v1/platform/tenants/${id}/company`, { method: 'PATCH', body: JSON.stringify(body) }),
  roster: (id: string) => pf<TenantRoster>(`/v1/platform/tenants/${id}/users`),
  setTenantMode: (id: string, mode: string, reason: string) =>
    pf<{ tenantId: string; mode: string; liveCallingAllowed: boolean }>(`/v1/platform/tenants/${id}/mode`, {
      method: 'PATCH', body: JSON.stringify({ mode, reason }),
    }),
  suspend: (id: string) => pf<{ status: string }>(`/v1/platform/tenants/${id}/suspend`, { method: 'POST' }),
  reactivate: (id: string) => pf<{ status: string }>(`/v1/platform/tenants/${id}/reactivate`, { method: 'POST' }),
  changePlan: (id: string, planKey: string) => pf<TenantSummary>(`/v1/platform/tenants/${id}/subscription/change-plan`, { method: 'POST', body: JSON.stringify({ planKey }) }),
  addAddon: (id: string, addonKey: string) => pf<TenantSummary>(`/v1/platform/tenants/${id}/addons`, { method: 'POST', body: JSON.stringify({ addonKey }) }),
  removeAddon: (id: string, addonKey: string) => pf<TenantSummary>(`/v1/platform/tenants/${id}/addons/${addonKey}`, { method: 'DELETE' }),
  overrideEntitlement: (id: string, featureKey: string, enabled: boolean, options?: { expiresAt?: string | null; reason?: string }) =>
    pf<unknown>(`/v1/platform/tenants/${id}/entitlements/${featureKey}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled, expiresAt: options?.expiresAt ?? undefined, reason: options?.reason }),
    }),
  plans: () => pf<Array<{ key: string; name: string; monthlyPrice: number; features: string[] }>>(`/v1/platform/subscriptions/plans`),
  setPlanPrice: (planKey: string, monthlyPrice: number | null, reason: string) =>
    pf<{ key: string; monthlyPrice: number; tenantsRepriced: number }>(`/v1/platform/subscriptions/plans/${planKey}`, {
      method: 'PATCH', body: JSON.stringify({ monthlyPrice, reason }),
    }),
  addons: () => pf<Array<{ key: string; name: string; featureKey: string | null }>>(`/v1/platform/subscriptions/addons`),
  requests: (status?: string) => pf<Array<{ id: string; tenantName: string; requestType: string; status: string; requestedPlanKey: string | null; createdAt: string }>>(`/v1/platform/subscription-requests${status ? `?status=${status}` : ''}`),
  approveRequest: (id: string) => pf<{ status: string }>(`/v1/platform/subscription-requests/${id}/approve`, { method: 'POST' }),
  rejectRequest: (id: string) => pf<{ status: string }>(`/v1/platform/subscription-requests/${id}/reject`, { method: 'POST' }),
  users: () => pf<Array<{ id: string; email: string; name: string; role: string; status: string; mfaEnabled: boolean; lastLoginAt: string | null }>>(`/v1/platform/users`),
  createUser: (body: { email: string; name: string; password: string; role: string }) => pf<unknown>(`/v1/platform/users`, { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: string, body: { status?: string; role?: string }) => pf<unknown>(`/v1/platform/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  // tenantId is pushed to the server: filtering the global newest-N client-side
  // made a busy platform render a tenant's real history as "no events yet".
  audit: (limit = 100, tenantId?: string) => pf<Array<{ id: string; action: string; targetType: string; targetId: string | null; tenantId: string | null; metadata: unknown; createdAt: string }>>(`/v1/platform/audit?limit=${limit}${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}`),

  // ── Control Tower (Phase 2) ──────────────────────────────────────────
  getBilling: (id: string) => pf<TenantBilling>(`/v1/platform/tenants/${id}/billing`),
  updateBilling: (id: string, body: { cycle?: 'monthly' | 'annual'; paymentStatus?: 'ok' | 'failed' | 'no_method'; gracePeriodDays?: number; reason: string }) =>
    pf<TenantBilling>(`/v1/platform/tenants/${id}/billing`, { method: 'PATCH', body: JSON.stringify(body) }),
  extendTrial: (id: string, days: number, reason: string) => pf<{ trialEndsAt: string }>(`/v1/platform/tenants/${id}/billing/extend-trial`, { method: 'POST', body: JSON.stringify({ days, reason }) }),

  getUsageLimits: (id: string) => pf<{ periodKey: string; rows: UsageLimitRow[] }>(`/v1/platform/tenants/${id}/usage-limits`),
  setUsageLimit: (id: string, key: string, limit: number | null) => pf<{ key: string; used: number; limit: number | null }>(`/v1/platform/tenants/${id}/usage-limits/${key}`, { method: 'PATCH', body: JSON.stringify({ limit }) }),

  getAiUsage: (id: string) => pf<AiUsageView>(`/v1/platform/tenants/${id}/ai-usage`),
  updateAiUsage: (id: string, body: { aiCreditsLimit?: number | null; modelTier?: string; overageAllowed?: boolean }) => pf<unknown>(`/v1/platform/tenants/${id}/ai-usage`, { method: 'PATCH', body: JSON.stringify(body) }),
  aiKillSwitch: (id: string, on: boolean, reason: string) => pf<{ killSwitch: boolean }>(`/v1/platform/tenants/${id}/ai-usage/kill-switch`, { method: 'POST', body: JSON.stringify({ on, reason }) }),

  getSecurity: (id: string) => pf<SecurityView>(`/v1/platform/tenants/${id}/security`),
  updateSecurity: (id: string, body: { forceMfa?: boolean; passwordExpiryDays?: number | null; sessionTimeoutMinutes?: number; failedLoginLockout?: boolean; ipAllowlist?: string[]; reason: string }) =>
    pf<{ ok: boolean }>(`/v1/platform/tenants/${id}/security`, { method: 'PATCH', body: JSON.stringify(body) }),
  revokeSessions: (id: string, reason: string) => pf<{ revokedAt: string }>(`/v1/platform/tenants/${id}/security/revoke-sessions`, { method: 'POST', body: JSON.stringify({ reason }) }),

  startSupport: (id: string, reason: string, minutes: number) => pf<{ id: string; expiresAt: string }>(`/v1/platform/tenants/${id}/support-session`, { method: 'POST', body: JSON.stringify({ reason, minutes }) }),
  supportSessions: () => pf<Array<{ id: string; tenantId: string; operatorEmail: string | null; reason: string; startedAt: string; expiresAt: string }>>(`/v1/platform/support-sessions`),
  endSupport: (sessionId: string) => pf<{ ended: boolean }>(`/v1/platform/support-session/${sessionId}`, { method: 'DELETE' }),

  archiveTenant: (id: string, reason: string) => pf<{ status: string }>(`/v1/platform/tenants/${id}/archive`, { method: 'POST', body: JSON.stringify({ reason }) }),

  providerHealth: () => pf<{ providers: Array<{ key: string; label: string; status: string; detail: string }>; failedJobs: number }>(`/v1/platform/health/providers`),
  retryJobs: (queue = 'autopilot') => pf<{ queue: string; retried: number }>(`/v1/platform/health/retry-jobs`, { method: 'POST', body: JSON.stringify({ queue }) }),

  announcements: () => pf<Array<{ id: string; title: string; body: string; severity: string; audience: string; active: boolean; createdByName: string | null; createdAt: string }>>(`/v1/platform/announcements`),
  createAnnouncement: (body: { title: string; body: string; severity?: string; audience?: string }) => pf<unknown>(`/v1/platform/announcements`, { method: 'POST', body: JSON.stringify(body) }),
  toggleAnnouncement: (id: string, active: boolean) => pf<unknown>(`/v1/platform/announcements/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),

  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    pf<{ changed: boolean; otherSessionsRevoked: boolean; token: string; user: PlatformMe }>(`/v1/platform/auth/password`, {
      method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
    }),
  disableOwnMfa: (password: string, code: string) =>
    pf<{ mfaEnabled: boolean }>(`/v1/platform/auth/mfa/disable`, { method: 'POST', body: JSON.stringify({ password, code }) }),
  getSettings: () => pf<PlatformSettings>(`/v1/platform/settings`),
  settingPresets: () => pf<{ presets: PlatformSettingPreset[] }>(`/v1/platform/settings/presets`),
  updateSettings: (body: Partial<Omit<PlatformSettings, 'updatedAt'>>) => pf<PlatformSettings>(`/v1/platform/settings`, { method: 'PATCH', body: JSON.stringify(body) }),

  getPilotChecklist: (tenantId: string) => pf<PilotChecklistView>(`/v1/platform/tenants/${tenantId}/pilot-checklist`),
  getPilotImportPresets: (tenantId: string, entityType?: PilotEntityType) =>
    pf<PilotImportPreset[]>(`/v1/platform/tenants/${tenantId}/pilot-import/presets${entityType ? `?entityType=${encodeURIComponent(entityType)}` : ''}`),
  savePilotImportPreset: (tenantId: string, body: { entityType: PilotEntityType; name: string; mapping: Record<string, string>; isDefault?: boolean }, operationKey = crypto.randomUUID()) =>
    pf<PilotImportPreset>(`/v1/platform/tenants/${tenantId}/pilot-import/presets`, { method: 'POST', headers: { 'Idempotency-Key': operationKey }, body: JSON.stringify(body) }),
  deletePilotImportPreset: (tenantId: string, presetId: string, operationKey = crypto.randomUUID()) =>
    pf<void>(`/v1/platform/tenants/${tenantId}/pilot-import/presets/${presetId}`, { method: 'DELETE', headers: { 'Idempotency-Key': operationKey } }),
  downloadPilotTemplate: async (tenantId: string, entityType: PilotEntityType) => {
    const token = getPlatformToken();
    const res = await fetch(`${API}/v1/platform/tenants/${tenantId}/pilot-import/${entityType}/template.csv`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Template download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pilot-${entityType}-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
  previewPilotImport: (tenantId: string, entityType: PilotEntityType, body: { csvText: string; mapping: Record<string, string> }) =>
    pf<PilotImportPreview>(`/v1/platform/tenants/${tenantId}/pilot-import/${entityType}/preview`, { method: 'POST', body: JSON.stringify(body) }),
  commitPilotImport: (tenantId: string, entityType: PilotEntityType, body: { csvText: string; mapping: Record<string, string> }, operationKey = crypto.randomUUID()) =>
    pf<PilotImportCommit>(`/v1/platform/tenants/${tenantId}/pilot-import/${entityType}/commit`, { method: 'POST', headers: { 'Idempotency-Key': operationKey }, body: JSON.stringify(body) }),
  getPilotStatusShare: (token: string) => pf<{ link: { label: string | null; expiresAt: string; active: boolean }; clinic: { id: string; name: string; slug: string }; checklist: PilotChecklistView }>(`/v1/pilot/share/${token}`, { auth: false }),
  createPilotStatusShare: (tenantId: string, body: { label?: string; expiresInDays?: number }, operationKey = crypto.randomUUID()) =>
    pf<PilotStatusShareCreated>(`/v1/platform/tenants/${tenantId}/pilot-status-links`, { method: 'POST', headers: { 'Idempotency-Key': operationKey }, body: JSON.stringify(body) }),
  listPilotStatusShares: (tenantId: string) => pf<PilotStatusShare[]>(`/v1/platform/tenants/${tenantId}/pilot-status-links`),

  integrations: () => pf<IntegrationView[]>(`/v1/platform/integrations`),
  saveIntegration: (key: string, fields: Record<string, string>) => pf<IntegrationView>(`/v1/platform/integrations/${key}`, { method: 'PUT', body: JSON.stringify({ fields }) }),
  disconnectIntegration: (key: string) => pf<IntegrationView | { deleted: boolean }>(`/v1/platform/integrations/${key}`, { method: 'DELETE' }),
  testIntegration: (key: string) => pf<{ key: string; status: string; detail: string; testedAt: string }>(`/v1/platform/integrations/${key}/test`, { method: 'POST' }),
  addService: (label: string, fields: Array<{ label: string; secret: boolean; required: boolean; value?: string }>) => pf<IntegrationView>(`/v1/platform/integrations`, { method: 'POST', body: JSON.stringify({ label, fields }) }),
  addIntegrationField: (key: string, body: { label: string; secret: boolean; required: boolean }) => pf<IntegrationView>(`/v1/platform/integrations/${key}/fields`, { method: 'PATCH', body: JSON.stringify(body) }),
};

/** `used` is THIS billing period. `metered` is false where nothing counts the key yet. */
export interface UsageLimitRow { key: string; used: number; limit: number | null; metered: boolean; lifetimeUsed: number }

export interface PlatformSettings {
  platformName: string; supportEmail: string | null;
  defaultTrialDays: number; defaultPlanKey: string;
  defaultTimezone: string; defaultCountry: string; defaultBranchName: string; defaultVoiceMinutes: number;
  requireMfaFloor: boolean; sessionTimeoutMaxMinutes: number;
  /** Whether YOUR OWN operators must use MFA on the Control Tower. */
  requireOperatorMfa: boolean;
  presetKey: string; updatedAt: string;
}
export interface PlatformSettingPreset {
  key: string; label: string; description: string;
  values: Partial<Omit<PlatformSettings, 'updatedAt' | 'presetKey' | 'platformName' | 'supportEmail' | 'defaultBranchName'>>;
}
export interface IntegrationView {
  key: string; label: string; status: string; source: 'db' | 'env' | null; isCustom?: boolean;
  fields: Array<{ key: string; label: string; secret: boolean; isSet: boolean; masked: string | null }>;
  required: string[]; lastTestAt: string | null; lastTestStatus: string | null; lastTestDetail: string | null;
}

export interface TenantBilling { status: string; cycle: 'monthly' | 'annual'; currency: string; mrr: number; arr: number; renewalDate: string | null; paymentStatus: string; gracePeriodDays: number; provider: string | null }
export interface AiUsageView { aiCreditsUsed: number; aiCreditsLimit: number | null; receptionistMinutes: number; campaignGenerations: number; reportGenerations: number; modelTier: string; overageAllowed: boolean; killSwitch: boolean }
export interface SecurityView { forceMfa: boolean; passwordExpiryDays: number | null; sessionTimeoutMinutes: number; ipAllowlist: string[]; failedLoginLockout: boolean; sessionsRevokedAt: string | null }

// Authenticated CSV download (pf parses JSON, so audit export needs a raw fetch).
export async function downloadAuditCsv(params: { tenantId?: string; action?: string } = {}) {
  const token = getPlatformToken();
  const qs = new URLSearchParams();
  if (params.tenantId) qs.set('tenantId', params.tenantId);
  if (params.action) qs.set('action', params.action);
  const res = await fetch(`${API}/v1/platform/audit/export.csv?${qs.toString()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'platform-audit.csv'; a.click();
  URL.revokeObjectURL(url);
}
