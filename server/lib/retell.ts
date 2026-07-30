import { randomUUID } from 'node:crypto';
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
  if (!env.RETELL_AGENT_ID) missing.push('RETELL_AGENT_ID');
  if (!env.RETELL_FROM_NUMBER) missing.push('RETELL_FROM_NUMBER');
  return { configured: missing.length === 0, mock: (env.RETELL_API_KEY ?? '').startsWith('mock'), missing };
}

export interface CreatePhoneCallInput {
  toNumber: string;
  dynamicVariables: Record<string, string>;
  metadata: Record<string, unknown>;
  webhookUrl?: string;
  agentId?: string;
  /** Fail-safe default: provider stores metadata only, never recordings/transcripts. */
  dataStorageSetting?: 'everything' | 'everything_except_pii' | 'basic_attributes_only';
}
export type CreatePhoneCallResult =
  | { ok: true; callId: string; mock: boolean }
  | { ok: false; error: string };

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
        override_agent_id: input.agentId ?? env.RETELL_AGENT_ID,
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
    const body = await response.json().catch(() => null) as { call_id?: string; callId?: string; message?: string } | null;
    if (!response.ok) return { ok: false, error: body?.message ?? `retell_error_${response.status}` };
    const callId = body?.call_id ?? body?.callId;
    if (!callId) return { ok: false, error: 'retell_no_call_id' };
    return { ok: true, callId, mock: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'retell_request_failed' };
  }
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
      const body = await response.json().catch(() => null) as { message?: string } | null;
      return { ok: false, applied: false, mock: false, error: body?.message ?? `retell_error_${response.status}` };
    }
    return { ok: true, applied: true, mock: false };
  } catch (error) {
    return { ok: false, applied: false, mock: false, error: error instanceof Error ? error.message : 'retell_request_failed' };
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
      const body = await response.json().catch(() => null) as { message?: string } | null;
      return { ok: false, applied: false, mock: false, error: body?.message ?? `retell_error_${response.status}` };
    }
    return { ok: true, applied: true, mock: false };
  } catch (error) {
    return { ok: false, applied: false, mock: false, error: error instanceof Error ? error.message : 'retell_request_failed' };
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
      const body = await response.json().catch(() => null) as { message?: string } | null;
      return { ok: false, applied: false, mock: false, error: body?.message ?? `retell_error_${response.status}` };
    }
    return { ok: true, applied: true, mock: false };
  } catch (error) {
    return { ok: false, applied: false, mock: false, error: error instanceof Error ? error.message : 'retell_request_failed' };
  }
}
