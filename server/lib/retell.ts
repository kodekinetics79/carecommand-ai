import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env';

// ===========================================================================
// Retell outbound dial trigger. Real Retell API when credentials are present;
// a clearly-marked mock path (RETELL_API_KEY starting with "mock") for local
// testing. Never fabricates a successful call for real configuration.
// ===========================================================================

export interface RetellConfigStatus { configured: boolean; mock: boolean; missing: string[] }

export function retellConfigStatus(): RetellConfigStatus {
  const missing: string[] = [];
  if (!env.RETELL_API_KEY) missing.push('RETELL_API_KEY');
  if (!env.RETELL_FROM_NUMBER) missing.push('RETELL_FROM_NUMBER');
  return { configured: missing.length === 0, mock: (env.RETELL_API_KEY ?? '').startsWith('mock'), missing };
}

export interface CreatePhoneCallInput {
  toNumber: string;
  dynamicVariables: Record<string, string>;
  metadata: Record<string, unknown>;
  webhookUrl?: string;
  agentId: string;
  agentVersion: number;
  /** Fail-safe default: provider stores metadata only, never recordings/transcripts. */
  dataStorageSetting?: 'everything' | 'everything_except_pii' | 'basic_attributes_only';
}
export type CreatePhoneCallResult =
  | { ok: true; callId: string; mock: boolean }
  | { ok: false; error: string; callId?: string; providerStopApplied?: boolean; providerStopError?: string };

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function createPhoneCall(input: CreatePhoneCallInput): Promise<CreatePhoneCallResult> {
  const status = retellConfigStatus();
  if (!status.configured) return { ok: false, error: 'setup_required' };
  if (!input.agentId || !Number.isSafeInteger(input.agentVersion) || input.agentVersion < 0) {
    return { ok: false, error: 'agent_setup_required' };
  }

  // Mock path: returns a synthetic call id without any network call. Only when
  // the key is explicitly a mock key — real keys always hit the real API.
  if (status.mock) {
    return { ok: true, callId: `mock_call_${randomUUID().replace(/-/g, '').slice(0, 16)}`, mock: true };
  }

  try {
    const response = await fetchWithTimeout(`${env.RETELL_BASE_URL}/v2/create-phone-call`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_number: env.RETELL_FROM_NUMBER,
        to_number: input.toNumber,
        override_agent_id: input.agentId,
        override_agent_version: input.agentVersion,
        // Retell's v2 create-phone-call API does not accept webhook_url as a
        // top-level call field. Per-call webhook settings belong in the agent
        // override. This keeps callbacks tenant/campaign scoped without
        // mutating the shared agent or relying on an account-level webhook.
        agent_override: {
          agent: {
            ...(input.webhookUrl
              ? { webhook_url: input.webhookUrl, webhook_events: ['call_started', 'call_ended', 'call_analyzed'] }
              : {}),
            data_storage_setting: input.dataStorageSetting ?? 'basic_attributes_only',
            opt_in_signed_url: true,
          },
        },
        retell_llm_dynamic_variables: input.dynamicVariables,
        metadata: input.metadata,
      }),
    });
    const body = await response.json().catch(() => null) as {
      call_id?: string;
      callId?: string;
      agent_id?: string;
      agent_version?: number;
    } | null;
    if (!response.ok) return { ok: false, error: `retell_error_${response.status}` };
    const callId = body?.call_id ?? body?.callId;
    if (!callId) return { ok: false, error: 'retell_no_call_id' };
    if (body?.agent_id !== input.agentId || body?.agent_version !== input.agentVersion) {
      const stopped = await stopPhoneCall(callId);
      return {
        ok: false,
        error: 'retell_deployment_mismatch',
        callId,
        providerStopApplied: stopped.ok && stopped.applied,
        ...(!stopped.ok ? { providerStopError: stopped.error } : {}),
      };
    }
    return { ok: true, callId, mock: false };
  } catch {
    return { ok: false, error: 'retell_request_failed' };
  }
}

export const RETELL_AGENT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;

export interface RetellAgentSnapshot {
  agentId: string;
  version: number;
  assignedTags: string[];
  published: boolean;
  voiceId: string;
  language: string;
  webhookUrl: string | null;
  webhookEvents: string[];
  dataStorageSetting: string | null;
  signedUrl: boolean;
  responseEngineType: string;
  responseEngineId: string;
  responseEngineVersion: number | null;
  lastModifiedAt: Date | null;
  fingerprint: string;
}

export type RetellAgentProbeResult =
  | { ok: true; snapshot: RetellAgentSnapshot }
  | { ok: false; error: 'setup_required' | 'mock_not_verifiable' | 'unauthorized' | 'not_found' | 'invalid_request' | 'provider_unavailable' | 'invalid_response' };

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function isValidRetellVersionTag(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,19}$/.test(value) && value !== 'latest' && !/^v\d+$/.test(value);
}

function providerDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const numeric = typeof value === 'number' ? (value < 10_000_000_000 ? value * 1_000 : value) : value;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Read-only Retell deployment probe. It never returns raw provider text and it
 * never falls back from the requested tag to an unverified "latest" version.
 */
export async function probeRetellAgent(agentId: string, versionTag: string): Promise<RetellAgentProbeResult> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required' };
  if (env.RETELL_API_KEY.startsWith('mock')) return { ok: false, error: 'mock_not_verifiable' };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId) || !isValidRetellVersionTag(versionTag)) {
    return { ok: false, error: 'invalid_response' };
  }
  try {
    const response = await fetchWithTimeout(
      `${env.RETELL_BASE_URL}/get-agent/${encodeURIComponent(agentId)}?version=${encodeURIComponent(versionTag)}`,
      { headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` } },
    );
    if (response.status === 401 || response.status === 403) return { ok: false, error: 'unauthorized' };
    if (response.status === 404) return { ok: false, error: 'not_found' };
    if (response.status === 400 || response.status === 422) return { ok: false, error: 'invalid_request' };
    if (!response.ok) return { ok: false, error: 'provider_unavailable' };
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_response' };

    const resolvedAgentId = nonEmptyString(body.agent_id);
    const version = nonNegativeInteger(body.version);
    const voiceId = nonEmptyString(body.voice_id);
    const language = nonEmptyString(body.language);
    const responseEngine = body.response_engine && typeof body.response_engine === 'object'
      ? body.response_engine as Record<string, unknown>
      : null;
    const responseEngineType = nonEmptyString(responseEngine?.type);
    const responseEngineId = nonEmptyString(responseEngine?.llm_id)
      ?? nonEmptyString(responseEngine?.conversation_flow_id)
      ?? nonEmptyString(responseEngine?.response_engine_id);
    if (resolvedAgentId !== agentId || version === null || typeof body.is_published !== 'boolean' || !voiceId || !language || !responseEngineType || !responseEngineId) {
      return { ok: false, error: 'invalid_response' };
    }
    const assignedTags = Array.isArray(body.assigned_tags) ? body.assigned_tags.filter((item): item is string => typeof item === 'string') : [];
    const webhookEvents = Array.isArray(body.webhook_events) ? body.webhook_events.filter((item): item is string => typeof item === 'string') : [];
    const safety = {
      agentId: resolvedAgentId,
      version,
      assignedTags: [...assignedTags].sort(),
      published: body.is_published,
      voiceId,
      language,
      webhookUrl: nonEmptyString(body.webhook_url),
      webhookEvents: [...webhookEvents].sort(),
      dataStorageSetting: nonEmptyString(body.data_storage_setting),
      signedUrl: body.opt_in_signed_url === true,
      responseEngineType,
      responseEngineId,
      responseEngineVersion: nonNegativeInteger(responseEngine?.version),
      lastModifiedAt: providerDate(body.last_modification_timestamp),
    };
    return {
      ok: true,
      snapshot: {
        ...safety,
        fingerprint: createHash('sha256').update(JSON.stringify({
          ...safety,
          lastModifiedAt: safety.lastModifiedAt?.toISOString() ?? null,
        })).digest('hex'),
      },
    };
  } catch {
    return { ok: false, error: 'provider_unavailable' };
  }
}

export type RetellAgentReadinessFailure =
  | 'tag_unassigned'
  | 'unpublished'
  | 'webhook_mismatch'
  | 'webhook_events_mismatch'
  | 'storage_policy_mismatch'
  | 'signed_url_disabled';

export function evaluateRetellAgentReadiness(
  snapshot: RetellAgentSnapshot,
  requirements: { versionTag: string; webhookUrl: string },
): RetellAgentReadinessFailure | null {
  if (!snapshot.assignedTags.includes(requirements.versionTag)) return 'tag_unassigned';
  if (!snapshot.published) return 'unpublished';
  if (snapshot.webhookUrl !== requirements.webhookUrl) return 'webhook_mismatch';
  const events = new Set(snapshot.webhookEvents);
  if (!['call_started', 'call_ended', 'call_analyzed'].every(event => events.has(event))) return 'webhook_events_mismatch';
  if (snapshot.dataStorageSetting !== 'basic_attributes_only') return 'storage_policy_mismatch';
  if (!snapshot.signedUrl) return 'signed_url_disabled';
  return null;
}

export type RetellMutationResult =
  | { ok: true; applied: true; mock: false }
  | { ok: true; applied: false; mock: true }
  | { ok: false; applied: false; mock: boolean; error: string };

/** Stop an ongoing provider call. Mock mode never claims that a call stopped. */
export async function stopPhoneCall(callId: string): Promise<RetellMutationResult> {
  const status = retellConfigStatus();
  if (!status.configured) return { ok: false, applied: false, mock: false, error: 'setup_required' };
  if (status.mock) return { ok: true, applied: false, mock: true };
  try {
    const response = await fetchWithTimeout(`${env.RETELL_BASE_URL}/v2/stop-call/${encodeURIComponent(callId)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` },
    });
    if (!response.ok) {
      return { ok: false, applied: false, mock: false, error: `retell_error_${response.status}` };
    }
    return { ok: true, applied: true, mock: false };
  } catch {
    return { ok: false, applied: false, mock: false, error: 'retell_request_failed' };
  }
}

/**
 * Restrict an already-started call to metadata-only storage. Retell permits a
 * call to move only toward a more restrictive setting, so this is safe for a
 * refusal/withdrawal. It deliberately has no inverse "enable recording" path:
 * an in-call GRANTED event is evidence only and cannot upgrade provider storage.
 */
export async function restrictCallToBasicAttributes(callId: string): Promise<RetellMutationResult> {
  const status = retellConfigStatus();
  if (!status.configured) return { ok: false, applied: false, mock: false, error: 'setup_required' };
  if (status.mock) return { ok: true, applied: false, mock: true };
  try {
    const response = await fetchWithTimeout(`${env.RETELL_BASE_URL}/v2/update-call/${encodeURIComponent(callId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true }),
    });
    if (!response.ok) {
      return { ok: false, applied: false, mock: false, error: `retell_error_${response.status}` };
    }
    return { ok: true, applied: true, mock: false };
  } catch {
    return { ok: false, applied: false, mock: false, error: 'retell_request_failed' };
  }
}

/** Delete a call and its associated provider data. Mock mode never claims deletion. */
export async function deleteCallData(callId: string): Promise<RetellMutationResult> {
  const status = retellConfigStatus();
  if (!status.configured) return { ok: false, applied: false, mock: false, error: 'setup_required' };
  if (status.mock) return { ok: true, applied: false, mock: true };
  try {
    const response = await fetchWithTimeout(`${env.RETELL_BASE_URL}/v2/delete-call/${encodeURIComponent(callId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` },
    });
    if (!response.ok) {
      return { ok: false, applied: false, mock: false, error: `retell_error_${response.status}` };
    }
    return { ok: true, applied: true, mock: false };
  } catch {
    return { ok: false, applied: false, mock: false, error: 'retell_request_failed' };
  }
}
