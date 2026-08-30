import 'dotenv/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { createPhoneCall, getPhoneCall, stopPhoneCall } from '../lib/retell';
import { buildRetellConfig, generateSamples, generateSystemPrompt, type PromptConfig } from '../modules/receptionist/promptService';
import { promptFixture } from './fixtures/receptionistPromptConfigs';

const originalRetell = {
  apiKey: env.RETELL_API_KEY,
  fromNumber: env.RETELL_FROM_NUMBER,
  baseUrl: env.RETELL_BASE_URL,
};

const fixture = promptFixture('us-full');
const promptConfig: PromptConfig = {
  ...fixture,
  clinic: { ...fixture.clinic, complianceDisclosure: 'Clinic-specific compliance language.', doNotContactPolicy: 'Record the opt-out and end the call.', humanFallbackNumber: null },
  agent: { ...fixture.agent, greetingOverride: 'I can help you schedule today.' },
  campaign: { ...fixture.campaign, campaignType: 'outbound', offerDescription: 'Schedule an appointment.', offerScript: 'Would you like to schedule?', eligibleLocationIds: ['branch-1'] },
  locations: [{ id: 'branch-1', name: 'Main', address: '1 Main St' }],
  hours: { clinicSummary: fixture.hours!.clinicSummary, perLocation: [{ id: 'branch-1', summary: fixture.hours!.clinicSummary, closures: [] }] },
};

afterEach(() => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('receptionist P0 reliability', () => {
  it('sends a per-call webhook through the Retell v2 agent_override contract', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_FROM_NUMBER = '+12125550199';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      call_id: 'call-123', agent_id: 'agent-campaign', agent_version: 7,
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createPhoneCall({
      toNumber: '+12125550101',
      agentId: 'agent-campaign',
      agentVersion: 7,
      webhookUrl: 'https://api.example.test/v1/receptionist/webhooks/retell?clinicId=clinic-1',
      dynamicVariables: { first_name: 'Taylor' },
      metadata: { campaignId: 'campaign-1' },
      maxCallDurationMs: 300_000,
    });

    expect(result).toEqual({ ok: true, callId: 'call-123', mock: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.webhook_url).toBeUndefined();
    expect(body.override_agent_id).toBe('agent-campaign');
    expect(body.override_agent_version).toBe(7);
    expect(body.agent_override).toEqual({
      agent: {
        webhook_url: 'https://api.example.test/v1/receptionist/webhooks/retell?clinicId=clinic-1',
        webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
        data_storage_setting: 'basic_attributes_only',
        opt_in_signed_url: true,
        max_call_duration_ms: 300_000,
      },
    });
  });

  it('omits a loopback webhook so an attended local UAT can use privacy-safe provider polling', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_FROM_NUMBER = '+12125550199';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      call_id: 'call-local-poll', agent_id: 'agent-campaign', agent_version: 7,
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await createPhoneCall({
      toNumber: '+12125550101', agentId: 'agent-campaign', agentVersion: 7,
      webhookUrl: 'http://127.0.0.1:43201/v1/receptionist/webhooks/retell',
      dynamicVariables: {}, metadata: {},
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const agent = JSON.parse(String(init.body)).agent_override.agent;
    expect(agent.webhook_url).toBeUndefined();
    expect(agent.webhook_events).toBeUndefined();
    expect(agent.data_storage_setting).toBe('basic_attributes_only');
  });

  it('still sends the mandatory metadata-only storage override when no per-call webhook is requested', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_FROM_NUMBER = '+12125550199';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      call_id: 'call-456', agent_id: 'agent-campaign', agent_version: 7,
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await createPhoneCall({ toNumber: '+12125550101', agentId: 'agent-campaign', agentVersion: 7, dynamicVariables: {}, metadata: {} });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body)).agent_override).toEqual({
      agent: { data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true },
    });
  });

  it.each([
    [{ agent_id: 'agent-other', agent_version: 7 }, 204, true, undefined],
    [{ agent_id: 'agent-campaign', agent_version: 8 }, 503, false, 'retell_error_503'],
  ] as const)('stops and rejects a started call whose provider deployment does not match %#', async (deployment, stopStatus, stopApplied, stopError) => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_FROM_NUMBER = '+12125550199';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'POST' && String(_url).includes('/v2/create-phone-call')) {
        return new Response(JSON.stringify({ call_id: 'call-mismatch', ...deployment }), { status: 201 });
      }
      return new Response(null, { status: stopStatus });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await createPhoneCall({
      toNumber: '+12125550101', agentId: 'agent-campaign', agentVersion: 7, dynamicVariables: {}, metadata: {},
    });

    expect(result).toEqual({
      ok: false,
      error: 'retell_deployment_mismatch',
      acceptance: stopApplied ? 'rejected' : 'unknown',
      callId: 'call-mismatch',
      providerStopApplied: stopApplied,
      ...(stopError ? { providerStopError: stopError } : {}),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      'https://api.retellai.com/v2/stop-call/call-mismatch',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('accepts Retell deployment version zero and validates the exact response binding', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_FROM_NUMBER = '+12125550199';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      call_id: 'call-v0', agent_id: 'agent-v0', agent_version: 0,
    }), { status: 201 })));

    await expect(createPhoneCall({
      toNumber: '+12125550101', agentId: 'agent-v0', agentVersion: 0, dynamicVariables: {}, metadata: {},
    })).resolves.toEqual({ ok: true, callId: 'call-v0', mock: false });
  });

  it.each([
    [400, 'rejected'], [401, 'rejected'], [403, 'rejected'], [404, 'rejected'], [422, 'rejected'],
    [408, 'unknown'], [409, 'unknown'], [425, 'unknown'], [429, 'unknown'], [500, 'unknown'], [503, 'unknown'],
  ] as const)('classifies provider HTTP %s acceptance conservatively as %s', async (statusCode, acceptance) => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_FROM_NUMBER = '+12125550199';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'normalized-away' }), { status: statusCode })));

    await expect(createPhoneCall({
      toNumber: '+12125550101', agentId: 'agent-campaign', agentVersion: 7, dynamicVariables: {}, metadata: {},
    })).resolves.toEqual({ ok: false, error: `retell_error_${statusCode}`, acceptance });
  });

  it('polls a provider call without returning transcript, recording, phone, or analysis content', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_FROM_NUMBER = '+12125550199';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      call_id: 'call-poll-1',
      call_status: 'not_connected',
      agent_id: 'agent-campaign',
      agent_version: 7,
      direction: 'outbound',
      start_timestamp: 1_723_000_000_000,
      end_timestamp: 1_723_000_005_000,
      duration_ms: 5_000,
      disconnection_reason: 'dial_busy',
      metadata: { tenantId: 'tenant-1', callLogId: 'log-1' },
      call_cost: { combined_cost: 42 },
      transcript: 'must not leave the adapter',
      recording_url: 'https://secret.example/recording.wav',
      call_analysis: { call_summary: 'must not leave the adapter', user_sentiment: 'negative' },
    }), { status: 200 })));

    const result = await getPhoneCall('call-poll-1');

    expect(result).toEqual({
      ok: true,
      call: {
        callId: 'call-poll-1',
        status: 'not_connected',
        agentId: 'agent-campaign',
        agentVersion: 7,
        direction: 'outbound',
        startTimestamp: 1_723_000_000_000,
        endTimestamp: 1_723_000_005_000,
        durationMs: 5_000,
        disconnectionReason: 'dial_busy',
        metadata: { tenantId: 'tenant-1', callLogId: 'log-1' },
        combinedCostNativeUnits: 42,
        mock: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('transcript');
    expect(JSON.stringify(result)).not.toContain('recording');
    expect(JSON.stringify(result)).not.toContain('call_summary');
  });

  it('fails closed when Get Call returns a different provider call id', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_FROM_NUMBER = '+12125550199';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      call_id: 'call-other', call_status: 'ongoing',
    }), { status: 200 })));

    await expect(getPhoneCall('call-expected')).resolves.toEqual({ ok: false, error: 'retell_call_id_mismatch' });
  });

  it('uses Retell stop-call for an active cancellation and never claims a mock stop was applied', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_FROM_NUMBER = '+12125550199';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(stopPhoneCall('call/unsafe id')).resolves.toEqual({ ok: true, applied: true, mock: false });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.retellai.com/v2/stop-call/call%2Funsafe%20id',
      expect.objectContaining({ method: 'POST' }),
    );

    env.RETELL_API_KEY = 'mock_local';
    await expect(stopPhoneCall('mock-call')).resolves.toEqual({ ok: true, applied: false, mock: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses a fully rendered standalone consent turn before any greeting override', () => {
    const built = buildRetellConfig(promptConfig, { webhookBaseUrl: 'https://api.example.test/' });
    const expected = "Hi, I'm Avery, an AI assistant for Example Clinic. This call may be recorded or monitored for quality and documentation.";

    expect(built.beginMessage).toBe(`${expected} Clinic-specific compliance language. Is that okay?`);
    expect(built.beginMessage.endsWith('Is that okay?')).toBe(true);
    expect(built.beginMessage).not.toContain('I can help you schedule today.');
    expect(generateSamples(promptConfig).greeting).toBe(built.beginMessage);
    expect(built.systemPrompt).toContain('After consent is granted, you may say: "I can help you schedule today."');
    expect(built.systemPrompt).toMatch(/STOP SPEAKING after that question and wait/i);
  });

  it('retains the mandatory disclosure even if clinic disclosure and greeting are blank', () => {
    const config: PromptConfig = {
      ...promptConfig,
      clinic: { ...promptConfig.clinic, complianceDisclosure: '   ' },
      agent: { ...promptConfig.agent, greetingOverride: '   ' },
    };
    const expected = "Hi, I'm Avery, an AI assistant for Example Clinic. This call may be recorded or monitored for quality and documentation.";

    expect(buildRetellConfig(config, { webhookBaseUrl: 'https://api.example.test' }).beginMessage).toBe(`${expected} Is that okay?`);
    const prompt = generateSystemPrompt(config);
    expect(prompt).toContain(expected);
    expect(prompt).toContain('before any greeting override');
    expect(prompt).toContain('Do not shorten, paraphrase, skip, or replace it.');
    expect(prompt).toMatch(/Emergency instructions override disclosure completion/i);
  });
});
