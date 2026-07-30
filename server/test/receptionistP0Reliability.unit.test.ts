import 'dotenv/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { createPhoneCall, stopPhoneCall } from '../lib/retell';
import { buildRetellConfig, generateSamples, generateSystemPrompt, type PromptConfig } from '../modules/receptionist/promptService';

const originalRetell = {
  apiKey: env.RETELL_API_KEY,
  agentId: env.RETELL_AGENT_ID,
  fromNumber: env.RETELL_FROM_NUMBER,
  baseUrl: env.RETELL_BASE_URL,
};

const promptConfig: PromptConfig = {
  clinic: {
    id: 'clinic-1',
    name: 'Example Clinic',
    phone: '+12125550100',
    timezone: 'America/New_York',
    defaultLanguage: 'en-US',
    complianceDisclosure: 'Clinic-specific compliance language.',
    doNotContactPolicy: 'Record the opt-out and end the call.',
  },
  agent: {
    name: 'Avery',
    voice: 'voice-1',
    tone: 'warm',
    language: 'en-US',
    greetingOverride: 'I can help you schedule today.',
  },
  campaign: {
    id: 'campaign-1',
    name: 'Scheduling',
    campaignType: 'outbound',
    offerTitle: 'Appointment',
    offerDescription: 'Schedule an appointment.',
    offerScript: 'Would you like to schedule?',
    appointmentType: 'Consultation',
    eligibleLocationIds: ['branch-1'],
    smsConfirmation: true,
    emailConfirmation: false,
  },
  locations: [{ id: 'branch-1', name: 'Main', address: '1 Main St' }],
  intakeFields: [],
};

afterEach(() => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_AGENT_ID = originalRetell.agentId;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('receptionist P0 reliability', () => {
  it('sends a per-call webhook through the Retell v2 agent_override contract', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_AGENT_ID = 'agent-default';
    env.RETELL_FROM_NUMBER = '+12125550199';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ call_id: 'call-123' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createPhoneCall({
      toNumber: '+12125550101',
      agentId: 'agent-campaign',
      webhookUrl: 'https://api.example.test/v1/receptionist/webhooks/retell?clinicId=clinic-1',
      dynamicVariables: { first_name: 'Taylor' },
      metadata: { campaignId: 'campaign-1' },
    });

    expect(result).toEqual({ ok: true, callId: 'call-123', mock: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.webhook_url).toBeUndefined();
    expect(body.agent_override).toEqual({
      agent: {
        webhook_url: 'https://api.example.test/v1/receptionist/webhooks/retell?clinicId=clinic-1',
        webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
        data_storage_setting: 'basic_attributes_only',
        opt_in_signed_url: true,
      },
    });
  });

  it('still sends the mandatory metadata-only storage override when no per-call webhook is requested', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_AGENT_ID = 'agent-default';
    env.RETELL_FROM_NUMBER = '+12125550199';
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ call_id: 'call-456' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await createPhoneCall({ toNumber: '+12125550101', dynamicVariables: {}, metadata: {} });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body)).agent_override).toEqual({
      agent: { data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true },
    });
  });

  it('uses Retell stop-call for an active cancellation and never claims a mock stop was applied', async () => {
    env.RETELL_API_KEY = 'real-retell-key';
    env.RETELL_AGENT_ID = 'agent-default';
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

  it('always begins with product-controlled AI and recording disclosure before a greeting override', () => {
    const built = buildRetellConfig(promptConfig, { webhookBaseUrl: 'https://api.example.test/' });
    const expected = "Hi, I'm Avery, an AI assistant for Example Clinic. This call may be recorded or monitored for quality and documentation.";

    expect(built.beginMessage.startsWith(expected)).toBe(true);
    expect(built.beginMessage.indexOf('Clinic-specific compliance language.')).toBeGreaterThan(expected.length - 1);
    expect(built.beginMessage.indexOf('I can help you schedule today.')).toBeGreaterThan(built.beginMessage.indexOf('Clinic-specific compliance language.'));
    expect(generateSamples(promptConfig).greeting.startsWith(expected)).toBe(true);
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
    expect(prompt).toContain('must be spoken before any greeting override');
    expect(prompt).toContain('Do not shorten, paraphrase, skip, or replace it.');
  });
});
