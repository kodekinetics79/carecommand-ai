import { env } from '../../config/env';
import { isValidE164, toE164 } from '../campaigns';

export const LIVE_CALL_UAT_DISCLOSURE = 'This is a CareCommand AI Receptionist authorized software test using synthetic information only. It is not related to real medical care, a real balance, or a real patient.';

export function liveCallUatDisclosure(existingDisclosure: string | null | undefined): string {
  const existing = existingDisclosure?.trim();
  return existing ? `${LIVE_CALL_UAT_DISCLOSURE} ${existing}` : LIVE_CALL_UAT_DISCLOSURE;
}

export interface LiveCallUatStatus {
  enabled: boolean;
  active: boolean;
  executionId: string | null;
  allowedDestinationMasked: string | null;
  expiresAt: string | null;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  maxCalls: number;
  maxCallMinutes: number;
  maxTotalMinutes: number;
  maxProviderCostUsd: number;
  estimatedCostPerMinuteUsd: number;
  projectedMaximumCostUsd: number;
  blockingReason: string | null;
}

export interface LiveCallUsage {
  attemptsUsed: number;
  connectedSeconds: number;
  activeCalls: number;
}

export type LiveCallAuthorization =
  | { allowed: true; destination: string; status: LiveCallUatStatus }
  | { allowed: false; reason: string; status: LiveCallUatStatus };

export type LiveCallAdmission =
  | { allowed: true; projectedCostUsd: number; status: LiveCallUatStatus }
  | { allowed: false; reason: string; status: LiveCallUatStatus };

function allowedDestinations(): string[] {
  const raw = [
    ...env.LIVE_TEST_RECIPIENT_ALLOWLIST.split(','),
    env.AUTHORIZED_TEST_PHONE_E164 ?? '',
  ];
  return [...new Set(raw.map(value => toE164(value.trim())).filter(isValidE164))];
}

function localMinutes(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}

function hhmmMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function isWithinLiveCallWindow(now: Date, timezone: string, start: string, end: string): boolean {
  const current = localMinutes(now, timezone);
  if (current === null) return false;
  const startMinutes = hhmmMinutes(start);
  const endMinutes = hhmmMinutes(end);
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? current >= startMinutes && current < endMinutes
    : current >= startMinutes || current < endMinutes;
}

export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***-***-${digits.slice(-4)}`;
}

export function maskProviderId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function liveCallUatStatus(now = new Date(), tenantId?: string): LiveCallUatStatus {
  const destinations = allowedDestinations();
  const expiresAtMs = env.LIVE_TEST_EXPIRES_AT ? Date.parse(env.LIVE_TEST_EXPIRES_AT) : Number.NaN;
  const projectedMaximumCostUsd = Number((
    env.LIVE_TEST_MAX_CALLS
    * env.LIVE_TEST_MAX_CALL_MINUTES
    * env.LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD
  ).toFixed(2));

  let blockingReason: string | null = null;
  if (!env.LIVE_TEST_CALLS_AUTHORIZED) blockingReason = 'live_test_not_authorized';
  else if (!env.LIVE_TEST_EXECUTION_ID) blockingReason = 'live_test_execution_id_missing';
  else if (!env.LIVE_TEST_TENANT_ID) blockingReason = 'live_test_tenant_missing';
  else if (tenantId && tenantId !== env.LIVE_TEST_TENANT_ID) blockingReason = 'live_test_tenant_not_authorized';
  else if (destinations.length !== 1) blockingReason = 'live_test_recipient_invalid';
  else if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) blockingReason = 'live_test_authorization_expired';
  else if (!isWithinLiveCallWindow(now, env.LIVE_TEST_TIMEZONE, env.LIVE_TEST_WINDOW_START, env.LIVE_TEST_WINDOW_END)) blockingReason = 'live_test_outside_window';
  else if (env.LIVE_TEST_MAX_CALLS < 1 || env.LIVE_TEST_MAX_TOTAL_MINUTES < env.LIVE_TEST_MAX_CALL_MINUTES) blockingReason = 'live_test_limits_invalid';
  else if (env.LIVE_TEST_MAX_PROVIDER_COST_USD <= 0 || projectedMaximumCostUsd > env.LIVE_TEST_MAX_PROVIDER_COST_USD) blockingReason = 'live_test_cost_cap_invalid';

  return {
    enabled: env.LIVE_TEST_CALLS_AUTHORIZED,
    active: env.LIVE_TEST_CALLS_AUTHORIZED && blockingReason === null,
    executionId: env.LIVE_TEST_EXECUTION_ID ?? null,
    allowedDestinationMasked: maskPhone(destinations[0]),
    expiresAt: env.LIVE_TEST_EXPIRES_AT ?? null,
    timezone: env.LIVE_TEST_TIMEZONE,
    windowStart: env.LIVE_TEST_WINDOW_START,
    windowEnd: env.LIVE_TEST_WINDOW_END,
    maxCalls: env.LIVE_TEST_MAX_CALLS,
    maxCallMinutes: env.LIVE_TEST_MAX_CALL_MINUTES,
    maxTotalMinutes: env.LIVE_TEST_MAX_TOTAL_MINUTES,
    maxProviderCostUsd: env.LIVE_TEST_MAX_PROVIDER_COST_USD,
    estimatedCostPerMinuteUsd: env.LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD,
    projectedMaximumCostUsd,
    blockingReason,
  };
}

export function liveCallUatDestination(tenantId?: string): string | null {
  return liveCallUatStatus(new Date(), tenantId).active ? allowedDestinations()[0] ?? null : null;
}

export function authorizeLiveCallDestination(destination: string, now = new Date(), tenantId?: string): LiveCallAuthorization {
  const status = liveCallUatStatus(now, tenantId);
  if (!status.active) return { allowed: false, reason: status.blockingReason ?? 'live_test_not_active', status };
  const canonical = toE164(destination);
  const allowed = allowedDestinations()[0];
  if (!isValidE164(canonical) || canonical !== allowed) {
    return { allowed: false, reason: 'live_test_destination_not_allowlisted', status };
  }
  return { allowed: true, destination: canonical, status };
}

export function evaluateLiveCallAdmission(usage: LiveCallUsage, now = new Date(), tenantId?: string): LiveCallAdmission {
  const status = liveCallUatStatus(now, tenantId);
  if (!status.active) return { allowed: false, reason: status.blockingReason ?? 'live_test_not_active', status };
  if (usage.activeCalls > 0) return { allowed: false, reason: 'live_test_single_active_call', status };
  if (usage.attemptsUsed >= status.maxCalls) return { allowed: false, reason: 'live_test_call_cap_reached', status };
  const usedMinutes = Math.ceil(usage.connectedSeconds / 60);
  if (usedMinutes + status.maxCallMinutes > status.maxTotalMinutes) {
    return { allowed: false, reason: 'live_test_minute_cap_reached', status };
  }
  const projectedCostUsd = Number(((usage.attemptsUsed + 1) * status.maxCallMinutes * status.estimatedCostPerMinuteUsd).toFixed(2));
  if (projectedCostUsd > status.maxProviderCostUsd) {
    return { allowed: false, reason: 'live_test_cost_cap_reached', status };
  }
  return { allowed: true, projectedCostUsd, status };
}

export function liveCallUatScope(executionId = env.LIVE_TEST_EXECUTION_ID): string | null {
  return executionId ? `receptionist.live-uat:${executionId}` : null;
}
