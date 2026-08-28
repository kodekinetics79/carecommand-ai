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
