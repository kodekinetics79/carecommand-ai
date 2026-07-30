import 'dotenv/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { evaluateRetellAgentReadiness, probeRetellAgent } from '../lib/retell';

const original = { apiKey: env.RETELL_API_KEY, baseUrl: env.RETELL_BASE_URL };
const webhookUrl = 'https://api.example.test/v1/receptionist/webhooks/retell';

function providerAgent(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: 'agent_pilot',
    version: 12,
    assigned_tags: ['prod'],
    is_published: true,
    voice_id: 'voice_verified',
    language: 'en-US',
    webhook_url: webhookUrl,
    webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
    data_storage_setting: 'basic_attributes_only',
    opt_in_signed_url: true,
    response_engine: { type: 'retell-llm', llm_id: 'llm_pilot', version: 9 },
    last_modification_timestamp: 1_754_000_000_000,
    ...overrides,
  };
}

afterEach(() => {
  env.RETELL_API_KEY = original.apiKey;
  env.RETELL_BASE_URL = original.baseUrl;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Retell agent provider contract', () => {
  it('uses exact tag/auth GET contract and produces a non-secret deterministic safety snapshot', async () => {
    env.RETELL_API_KEY = 'retell-secret-value';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(providerAgent()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeRetellAgent('agent_pilot', 'prod');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.retellai.com/get-agent/agent_pilot?version=prod',
      expect.objectContaining({ headers: { Authorization: 'Bearer retell-secret-value' } }),
    );
    expect(result).toMatchObject({ ok: true, snapshot: { agentId: 'agent_pilot', version: 12, published: true, responseEngineId: 'llm_pilot' } });
    if (!result.ok) throw new Error('expected provider snapshot');
    expect(result.snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('retell-secret-value');
    expect(evaluateRetellAgentReadiness(result.snapshot, { versionTag: 'prod', webhookUrl })).toBeNull();
  });

  it.each([
    [{ assigned_tags: [] }, 'tag_unassigned'],
    [{ is_published: false }, 'unpublished'],
    [{ webhook_url: 'https://wrong.example.test/webhook' }, 'webhook_mismatch'],
    [{ webhook_events: ['call_ended'] }, 'webhook_events_mismatch'],
    [{ data_storage_setting: 'everything' }, 'storage_policy_mismatch'],
    [{ opt_in_signed_url: false }, 'signed_url_disabled'],
  ] as const)('rejects unsafe published-deployment state %#', async (overrides, expected) => {
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(providerAgent(overrides)), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    if (!result.ok) throw new Error('expected parsed provider snapshot');
    expect(evaluateRetellAgentReadiness(result.snapshot, { versionTag: 'prod', webhookUrl })).toBe(expected);
  });

  it.each([
    [400, 'invalid_request'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [422, 'invalid_request'],
    [429, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ] as const)('maps provider HTTP %s to a secret-safe error', async (status, error) => {
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('provider secret detail', { status })));
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error });
  });

  it('accepts Retell agent and response-engine version zero', async () => {
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(providerAgent({
      version: 0,
      response_engine: { type: 'retell-llm', llm_id: 'llm-v0', version: 0 },
    })), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    expect(result).toMatchObject({ ok: true, snapshot: { version: 0, responseEngineVersion: 0 } });
  });

  it.each(['Prod', 'latest', 'v2', '1prod', 'tag-that-is-more-than-20-characters'])('rejects undocumented deployment tag %s before provider access', async tag => {
    env.RETELL_API_KEY = 'real-key';
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(probeRetellAgent('agent_pilot', tag)).resolves.toEqual({ ok: false, error: 'invalid_response' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never treats mock, malformed, wrong-id, or rejected provider calls as verified', async () => {
    env.RETELL_API_KEY = 'mock_provider';
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'mock_not_verifiable' });

    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(providerAgent({ agent_id: 'agent_other' })), { status: 200 })));
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'invalid_response' });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network contains secret'); }));
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'provider_unavailable' });
  });
});
