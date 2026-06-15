/* eslint-disable @typescript-eslint/no-unused-vars -- method params document
   the intended request shape of each not-yet-implemented backend route. */
// ============================================================================
// Platform Control Tower — typed service contracts.
//
// This file is the single source of truth for what the Superadmin Control Tower
// can call. Methods are grouped as:
//   [LIVE]  — wired to an existing backend route (see src/lib/platformAdmin.ts).
//   [TODO]  — typed contract for a route that does NOT exist yet. Calling it
//             throws `NotImplemented` so the UI can render an honest "backend
//             pending" state instead of a dead/fake control.
//
// Backend dependency to remove each TODO is noted inline. No control in the UI
// should silently no-op: it either calls a LIVE method or surfaces NotImplemented.
// ============================================================================

export class NotImplementedError extends Error {
  contract: string;
  constructor(contract: string) {
    super(`Backend route not implemented yet: ${contract}`);
    this.name = 'NotImplementedError';
    this.contract = contract;
  }
}
const todo = (contract: string): never => { throw new NotImplementedError(contract); };

// ---- Shared types ----------------------------------------------------------
export interface UsageLimit {
  key: 'seats' | 'locations' | 'storage_gb' | 'sms' | 'voice_minutes' | 'ai_credits' | 'devices';
  label: string;
  used: number;
  limit: number | null; // null = unlimited
  unit: string;
}
export interface BillingSummary {
  status: 'active' | 'past_due' | 'trialing' | 'canceled' | 'unknown';
  cycle: 'monthly' | 'annual' | null;
  mrr: number | null;
  arr: number | null;
  renewalDate: string | null;
  trialEndsAt: string | null;
  paymentStatus: 'ok' | 'failed' | 'no_method' | 'unknown';
}
export interface AiUsage {
  aiCreditsUsed: number; aiCreditsLimit: number | null;
  receptionistMinutes: number; campaignGenerations: number; reportGenerations: number;
  modelTier: string; overageAllowed: boolean; killSwitch: boolean;
}
export interface SupportSession {
  id: string; tenantId: string; operatorId: string; reason: string;
  startedAt: string; expiresAt: string; active: boolean;
}
export interface SecurityPolicy {
  forceMfa: boolean; passwordExpiryDays: number; sessionTimeoutMinutes: number;
  ipAllowlist: string[]; ssoEnabled: boolean;
}
export interface ProviderHealth { key: string; label: string; status: 'ok' | 'degraded' | 'down' | 'unknown'; detail?: string }

// ---- Service contracts -----------------------------------------------------
export const platformServices = {
  // [TODO] Billing — needs GET /v1/platform/tenants/:id/billing (Stripe/Metronome
  // subscription + invoice summary). Model: TenantBilling (mrr, cycle, renewal).
  getBilling: (_tenantId: string): Promise<BillingSummary> => todo('GET /v1/platform/tenants/:id/billing'),
  setBillingCycle: (_tenantId: string, _cycle: 'monthly' | 'annual'): Promise<void> => todo('PATCH /v1/platform/tenants/:id/billing { cycle }'),
  extendTrial: (_tenantId: string, _days: number): Promise<void> => todo('POST /v1/platform/tenants/:id/billing/extend-trial { days }'),

  // [TODO] Usage limits — needs TenantUsageLimit model + GET/PATCH. Some limits
  // (locations) are derivable today from plan multi_location limitValue.
  getUsageLimits: (_tenantId: string): Promise<UsageLimit[]> => todo('GET /v1/platform/tenants/:id/usage-limits'),
  setUsageLimit: (_tenantId: string, _key: UsageLimit['key'], _limit: number | null): Promise<void> => todo('PATCH /v1/platform/tenants/:id/usage-limits/:key { limit }'),

  // [TODO] AI usage & controls — needs AiUsageMeter model + kill switch flag.
  getAiUsage: (_tenantId: string): Promise<AiUsage> => todo('GET /v1/platform/tenants/:id/ai-usage'),
  setAiKillSwitch: (_tenantId: string, _on: boolean, _reason: string): Promise<void> => todo('POST /v1/platform/tenants/:id/ai-usage/kill-switch { on, reason }'),

  // [TODO] Support access — needs SupportAccessSession model + audited enter/exit.
  enterSupportMode: (_tenantId: string, _reason: string, _minutes: number): Promise<SupportSession> => todo('POST /v1/platform/tenants/:id/support-session { reason, minutes }'),
  exitSupportMode: (_sessionId: string): Promise<void> => todo('DELETE /v1/platform/support-session/:id'),

  // [TODO] Tenant security policy — TenantSecurityPolicy model exists; needs a
  // platform-scoped GET/PATCH wrapper (currently tenant-self-service only).
  getSecurityPolicy: (_tenantId: string): Promise<SecurityPolicy> => todo('GET /v1/platform/tenants/:id/security'),
  setSecurityPolicy: (_tenantId: string, _patch: Partial<SecurityPolicy>, _reason: string): Promise<void> => todo('PATCH /v1/platform/tenants/:id/security { ...patch, reason }'),
  revokeAllSessions: (_tenantId: string, _reason: string): Promise<void> => todo('POST /v1/platform/tenants/:id/security/revoke-sessions { reason }'),

  // [TODO] Provider health — extends /v1/platform/health with downstream
  // providers (email/SMS/payments/insurance webhooks) + failed-job counts.
  getProviderHealth: (): Promise<ProviderHealth[]> => todo('GET /v1/platform/health/providers'),
  retryFailedJobs: (_queue: string): Promise<{ retried: number }> => todo('POST /v1/platform/health/retry-jobs { queue }'),

  // [TODO] Announcements — PlatformAnnouncement model + CRUD + tenant banner feed.
  listAnnouncements: (): Promise<Array<{ id: string; title: string; body: string; createdAt: string }>> => todo('GET /v1/platform/announcements'),

  // [TODO] Archive tenant — soft-delete (Tenant.status = "archived") + retention.
  archiveTenant: (_tenantId: string, _reason: string): Promise<void> => todo('POST /v1/platform/tenants/:id/archive { reason }'),
};

// Derived, no-backend-needed helpers so tenant cards can show richer signal today
// without faking data (clearly computed from real fields).
export function healthScore(input: { status: string; enabledFeatures: number; activeUsers: number; setupStatus: string }): number {
  let score = 100;
  if (input.status !== 'active') score -= 60;
  if (input.setupStatus !== 'configured') score -= 15;
  if (input.activeUsers === 0) score -= 20;
  if (input.enabledFeatures < 3) score -= 10;
  return Math.max(0, Math.min(100, score));
}
