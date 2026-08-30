import 'dotenv/config';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { createRetellAgent, createRetellLlm, llmRequestBody, updateRetellLlm } from '../lib/retell';
import {
  RETELL_GENERAL_TOOL_TYPES,
  retellAgentRequestIssues,
  retellLlmRequestIssues,
} from '../lib/receptionist/retellMock';
import { buildRetellConfig } from '../modules/receptionist/promptService';
import { promptFixture } from './fixtures/receptionistPromptConfigs';

// ===========================================================================
// The mock provider has to be able to say no.
//
// A live attended deploy against a real Retell account failed at ensure_llm
// with HTTP 400 invalid_request, because eleven of our thirteen tools declared
// `type: 'function'` — a value that is not in Retell's `general_tools[].type`
// discriminator at all. Not one test caught it, and the reason is the whole
// point of this suite: `mockCreateLlm()` returned success unconditionally
// without ever looking at the payload, so every test of the deploy path was a
// test against a provider that could not reject anything.
//
// So the rule this suite pins is: whatever the real API refuses, the mock
// refuses, with the same mapped error — and a `type: 'function'` tool is the
// named regression guard for the entire class.
// ===========================================================================

const original = { apiKey: env.RETELL_API_KEY, fromNumber: env.RETELL_FROM_NUMBER };
const config = buildRetellConfig(promptFixture('us-full'), { webhookBaseUrl: 'https://api.example.test' });

function useMockProvider() {
  env.RETELL_API_KEY = 'mock_unit_key';
  env.RETELL_FROM_NUMBER = '+15550100000';
}

function llmSpec(tools: Array<Record<string, unknown>>) {
  return { generalPrompt: config.systemPrompt, beginMessage: config.beginMessage, tools };
}

/** One well-formed custom tool, so a case can mutate exactly one field. */
function customTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'custom',
    name: 'take_message',
    description: 'Create a staff callback task.',
    url: 'https://api.example.test/v1/receptionist/webhooks/retell/fn?clinicId=clinic-1',
    speak_during_execution: true,
    speak_after_execution: true,
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    ...overrides,
  };
}

afterEach(() => {
  env.RETELL_API_KEY = original.apiKey;
  env.RETELL_FROM_NUMBER = original.fromNumber;
});

describe('the mock provider validates the tool type discriminator', () => {
  it('rejects the `type: function` tool that the live account rejected', async () => {
    useMockProvider();
    const rejected = await createRetellLlm(llmSpec([customTool({ type: 'function' })]));

    // Identical to what the live client produces for Retell's 400, so the
    // deploy service maps it to provider_invalid_request either way.
    expect(rejected).toEqual({ ok: false, error: 'invalid_request', status: 400, mock: true });
  });

  it('names the offending index and the allowed values, the way Retell does', () => {
    const issues = retellLlmRequestIssues(llmRequestBody(llmSpec([
      customTool(),
      customTool({ name: 'report_emergency', type: 'function' }),
    ])));
    expect(issues).toEqual([
      'general_tools/1/type must be equal to one of the allowed values: end_call, press_digit, custom, transfer_call, bridge_transfer, cancel_transfer, mcp',
    ]);
  });

  it('accepts every type Retell allows and refuses everything else', () => {
    for (const type of RETELL_GENERAL_TOOL_TYPES) {
      // Only the discriminator is under test here; a tool of an allowed type
      // may still fail its own branch, which the cases below cover.
      const issues = retellLlmRequestIssues(llmRequestBody(llmSpec([customTool({ type })])));
      expect(issues.some(issue => issue.includes('/type must be equal to one of the allowed values'))).toBe(false);
    }
    for (const type of ['function', 'Custom', 'webhook', '', null, undefined]) {
      const issues = retellLlmRequestIssues(llmRequestBody(llmSpec([customTool({ type })])));
      expect(issues).toContain(
        `general_tools/0/type must be equal to one of the allowed values: ${RETELL_GENERAL_TOOL_TYPES.join(', ')}`,
      );
    }
  });

  it('rejects a bad type on update as well as on create, so a redeploy cannot slip past', async () => {
    useMockProvider();
    const rejected = await updateRetellLlm('mock_llm_existing', llmSpec([customTool({ type: 'function' })]), 3);
    expect(rejected).toEqual({ ok: false, error: 'invalid_request', status: 400, mock: true });

    const accepted = await updateRetellLlm('mock_llm_existing', llmSpec(config.tools), 3);
    expect(accepted).toEqual({ ok: true, value: { llmId: 'mock_llm_existing', version: 4 }, mock: true });
  });
});

describe('the mock provider validates a custom tool the way Retell does', () => {
  it('requires a name, an absolute URL and an object parameter schema', () => {
    const issues = (tool: Record<string, unknown>) => retellLlmRequestIssues(llmRequestBody(llmSpec([tool])));

    expect(issues(customTool({ name: undefined }))).toContain('general_tools/0/name must match ^[A-Za-z0-9_-]{1,64}$');
    expect(issues(customTool({ name: 'take message' }))).toContain('general_tools/0/name must match ^[A-Za-z0-9_-]{1,64}$');
    expect(issues(customTool({ url: undefined }))).toContain('general_tools/0/url must be an absolute http(s) URL');
    expect(issues(customTool({ url: '/v1/receptionist/webhooks/retell/fn' }))).toContain('general_tools/0/url must be an absolute http(s) URL');
    expect(issues(customTool({ parameters: { type: 'string' } })))
      .toContain('general_tools/0/parameters/type must be equal to one of the allowed values: object');
    expect(issues(customTool({ parameters: { type: 'object' } })))
      .toContain('general_tools/0/parameters/properties must be an object');
    expect(issues(customTool({ parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['note'] } })))
      .toContain('general_tools/0/parameters/required references unknown property note');
    expect(issues(customTool({ method: 'SEND' })))
      .toContain('general_tools/0/method must be equal to one of the allowed values: GET, POST, PUT, PATCH, DELETE');
    expect(issues(customTool({ speak_during_execution: 'yes' })))
      .toContain('general_tools/0/speak_during_execution must be a boolean');
  });

  it('rejects two tools that share a name, which Retell cannot dispatch', () => {
    const issues = retellLlmRequestIssues(llmRequestBody(llmSpec([customTool(), customTool()])));
    expect(issues).toContain('general_tools/1/name duplicates an earlier tool name');
  });

  it('checks the transfer branch on its own terms, not the custom one', () => {
    const transfer = (overrides: Record<string, unknown> = {}) => retellLlmRequestIssues(llmRequestBody(llmSpec([{
      type: 'transfer_call',
      name: 'transfer_to_staff',
      description: 'Attempt transfer to the clinic front desk.',
      transfer_destination: { type: 'predefined', number: '+12125550200', ignore_e164_validation: false },
      transfer_option: { type: 'cold_transfer', show_transferee_as_caller: false },
      ...overrides,
    }])));

    expect(transfer()).toEqual([]);
    // A transfer tool needs no url, unlike a custom one.
    expect(transfer({ url: undefined })).toEqual([]);
    expect(transfer({ transfer_destination: { type: 'predefined', number: 'front desk' } }))
      .toContain('general_tools/0/transfer_destination/number must be an E.164 number');
    expect(transfer({ transfer_destination: undefined }))
      .toContain('general_tools/0/transfer_destination must be an object');
    expect(transfer({ transfer_option: { type: 'teleport' } }))
      .toContain('general_tools/0/transfer_option/type must be equal to one of the allowed values: cold_transfer, warm_transfer');
  });

  it('checks the envelope around the tools too', () => {
    expect(retellLlmRequestIssues({ general_tools: [] })).toContain('general_prompt must be a non-empty string');
    expect(retellLlmRequestIssues({ general_prompt: 'Hello', general_tools: {} })).toContain('general_tools must be an array');
    expect(retellLlmRequestIssues({ general_prompt: 'Hello', tool_call_strict_mode: 'true' }))
      .toContain('tool_call_strict_mode must be a boolean');
    expect(retellLlmRequestIssues('not a body')).toEqual(['request body must be an object']);
  });
});

describe('the mock provider validates the agent payload', () => {
  it('rejects an agent that names no response engine and accepts the one we send', async () => {
    useMockProvider();
    const rejected = await createRetellAgent({
      agentName: 'Avery', llmId: '', llmVersion: 0, voiceId: 'mock-voice-nova', language: 'en-US',
      webhookUrl: 'https://api.example.test/v1/receptionist/webhooks/retell', postCallAnalysisData: config.callOutcomeFields,
    });
    expect(rejected).toEqual({ ok: false, error: 'invalid_request', status: 400, mock: true });

    const accepted = await createRetellAgent({
      agentName: 'Avery', llmId: 'mock_llm_1', llmVersion: 0, voiceId: 'mock-voice-nova', language: 'en-US',
      webhookUrl: 'https://api.example.test/v1/receptionist/webhooks/retell', postCallAnalysisData: config.callOutcomeFields,
    });
    expect(accepted.ok).toBe(true);
  });

  it('holds the post-call analysis fields to the shapes Retell accepts', () => {
    const base = {
      agent_name: 'Avery',
      response_engine: { type: 'retell-llm', llm_id: 'mock_llm_1', version: 0 },
      voice_id: 'mock-voice-nova',
      language: 'en-US',
      webhook_url: 'https://api.example.test/v1/receptionist/webhooks/retell',
      webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
      data_storage_setting: 'basic_attributes_only',
      opt_in_signed_url: true,
      post_call_analysis_data: config.callOutcomeFields,
    };
    expect(retellAgentRequestIssues(base)).toEqual([]);
    expect(retellAgentRequestIssues({ ...base, webhook_events: ['call_started', 'call_recorded'] }))
      .toContain('webhook_events must be equal to one of the allowed values: call_started, call_ended, call_analyzed');
    expect(retellAgentRequestIssues({ ...base, data_storage_setting: 'everything_but_pii' }))
      .toContain('data_storage_setting must be equal to one of the allowed values: everything, everything_except_pii, basic_attributes_only');
    expect(retellAgentRequestIssues({ ...base, post_call_analysis_data: [{ name: 'outcome', type: 'enum' }] }))
      .toContain('post_call_analysis_data/0/choices must be a non-empty array of strings for an enum field');
    expect(retellAgentRequestIssues({ ...base, post_call_analysis_data: [{ name: 'outcome', type: 'text' }] }))
      .toContain('post_call_analysis_data/0/type must be equal to one of the allowed values: string, enum, boolean, number');
  });
});

describe('the tools we actually ship', () => {
  it('declares every live tool with a type Retell allows', () => {
    // 12 webhook-backed custom tools plus Retell's provider-native transfer.
    expect(config.tools).toHaveLength(13);
    const byType = config.tools.reduce<Record<string, string[]>>((acc, tool) => {
      const type = String(tool.type);
      (acc[type] ??= []).push(String(tool.name));
      return acc;
    }, {});
    expect(Object.keys(byType).sort()).toEqual(['custom', 'transfer_call']);
    expect(byType.transfer_call).toEqual(['transfer_to_staff']);
    expect(byType.custom).toHaveLength(12);
    expect(byType.custom).toContain('book_appointment');
    expect(byType.custom).toContain('check_availability');
  });

  it('sends an LLM payload the mock — and therefore Retell — accepts', () => {
    expect(retellLlmRequestIssues(llmRequestBody(llmSpec(config.tools)))).toEqual([]);
  });

  it('would have caught the live failure: one tool back on `function` fails the whole payload', () => {
    const regressed = config.tools.map(tool => (tool.name === 'check_availability' ? { ...tool, type: 'function' } : tool));
    const issues = retellLlmRequestIssues(llmRequestBody(llmSpec(regressed)));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^general_tools\/\d+\/type must be equal to one of the allowed values:/);
  });
});
