import 'dotenv/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { compareDeployedTools, evaluateRetellAgentReadiness, hashPrompt, probeRetellAgent } from '../lib/retell';
import { bookAppointmentToolFingerprint, compileIntakeContract } from '../modules/receptionist/intakeContract';
import { buildRetellConfig, type PromptConfig } from '../modules/receptionist/promptService';
import { promptFixture } from './fixtures/receptionistPromptConfigs';

// A finished prompt still carries the runtime {{variables}} Retell substitutes
// per call; only those are allowed to survive rendering.
const RUNTIME_PLACEHOLDER = /\{\{\s*(is_open_now|hours_today|next_opening|closure_reason|emergency_number|known_first_name|human_fallback_number|admission_state|location_name|location_address|location_phone)\s*\}\}/g;
const stripRuntimeVariables = (value: string) => value.replace(RUNTIME_PLACEHOLDER, '');


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

function listedProviderAgent(
  overrides: Record<string, unknown> = {},
  dynamicVariables: Record<string, string> = {},
) {
  const agent = providerAgent(overrides);
  const assignedTags = agent.assigned_tags as string[];
  const rootTags = assignedTags.length ? assignedTags : ['prod'];
  return {
    has_more: false,
    items: [{
      agent_id: agent.agent_id,
      agent_name: 'Pilot agent',
      channel: 'voice',
      tags: Object.fromEntries(rootTags.map(tag => [tag, { version: agent.version, dynamic_variables: dynamicVariables }])),
      user_modified_timestamp: 1_754_000_000_000,
    }],
  };
}

function providerAgentApiBody(url: string | URL | Request, overrides: Record<string, unknown> = {}) {
  return String(url).includes('list-agents') ? listedProviderAgent(overrides) : providerAgent(overrides);
}

function bookingTool(url = 'https://api.example.test/v1/receptionist/webhooks/retell/fn?clinicId=clinic-1') {
  return compileIntakeContract({
    campaignId: 'campaign-1', revision: 1, appointmentType: 'Consultation', eligibleLocations: [], fields: [], toolUrl: url,
  }).snapshot.bookAppointmentToolContract;
}

afterEach(() => {
  env.RETELL_API_KEY = original.apiKey;
  env.RETELL_BASE_URL = original.baseUrl;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Retell agent provider contract', () => {
  it('round-trips the first-party export through exact provider attestation without templates', async () => {
    env.RETELL_API_KEY = 'real-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const base = promptFixture('us-full');
    const config: PromptConfig = {
      ...base,
      clinic: { ...base.clinic, complianceDisclosure: 'Approved disclosure.', doNotContactPolicy: 'Record opt out.' },
      agent: { ...base.agent, voice: 'voice_verified' },
      campaign: { ...base.campaign, name: 'Pilot', offerTitle: 'Care', offerDescription: 'Schedule care', offerScript: 'Would you like to schedule?', eligibleLocationIds: ['location-1'] },
      locations: [{ id: 'location-1', name: 'Main', address: '1 Main Street' }],
      hours: { clinicSummary: base.hours!.clinicSummary, perLocation: [{ id: 'location-1', summary: base.hours!.clinicSummary, closures: [] }] },
    };
    const exported = buildRetellConfig(config, { webhookBaseUrl: 'https://api.example.test' });
    // The bare webhook URL must equal what verification demands (REC-P0-007).
    expect(exported.webhookUrl).toBe(webhookUrl);
    // Approved runtime variables survive to the provider; nothing else may.
    expect(stripRuntimeVariables(JSON.stringify(exported))).not.toMatch(/\{\{|\$\{/);

    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? {
        llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
        general_prompt: exported.systemPrompt, general_tools: exported.tools,
      }
      : providerAgentApiBody(url)), { status: 200 })));

    const result = await probeRetellAgent('agent_pilot', 'prod');
    // RESOLVED (C2 contract section 3 x C5 retell.ts). The C2 prompt carries
    // the Retell runtime variables the agent needs to answer "are you open
    // right now", and `containsProviderTemplateSyntax` now allows exactly the
    // names in RUNTIME_DYNAMIC_VARIABLES and nothing else — so the probe reads
    // the book tool and the campaign is attestable with a real deployment.
    // The old pin recorded the broken state and said to flip it here.
    expect(result).toMatchObject({
      ok: true,
      snapshot: { bookToolProbeStatus: 'SUCCEEDED', toolCallStrictMode: true },
    });
    if (!result.ok) throw new Error('expected provider snapshot');
    expect(bookAppointmentToolFingerprint(result.snapshot.bookToolSchema)).toBe(exported.intakeToolFingerprint);
    expect(bookAppointmentToolFingerprint(exported.bookingFunction)).toBe(exported.intakeToolFingerprint);
    expect(result.snapshot.bookToolFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses exact tag/auth GET contract and produces a non-secret deterministic safety snapshot', async () => {
    env.RETELL_API_KEY = 'retell-secret-value';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const fetchMock = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? {
        llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
        general_tools: [bookingTool()],
      }
      : providerAgentApiBody(url)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeRetellAgent('agent_pilot', 'prod');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.retellai.com/get-agent/agent_pilot?version=prod',
      expect.objectContaining({ headers: { Authorization: 'Bearer retell-secret-value' } }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.retellai.com/v2/list-agents?limit=100&sort_order=descending',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer retell-secret-value', 'Content-Type': 'application/json' },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.retellai.com/get-retell-llm/llm_pilot?version=9',
      expect.objectContaining({ headers: { Authorization: 'Bearer retell-secret-value' } }),
    );
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        agentId: 'agent_pilot', version: 12, published: true, responseEngineId: 'llm_pilot',
        bookToolProbeStatus: 'SUCCEEDED', toolCallStrictMode: true,
      },
    });
    if (!result.ok) throw new Error('expected provider snapshot');
    expect(result.snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshot.responseEngineGraphFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshot.bookToolFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('retell-secret-value');
    expect(evaluateRetellAgentReadiness(result.snapshot, { versionTag: 'prod', webhookUrl })).toBeNull();
  });

  it('attests one reachable wrapped booking tool in an exact conversation-flow version', async () => {
    env.RETELL_API_KEY = 'real-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const tool = { ...bookingTool(), tool_id: 'tool_booking' };
    const fetchMock = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).includes('/get-conversation-flow/')
      ? {
        conversation_flow_id: 'flow_pilot', version: 4, last_modification_timestamp: 1_754_000_000_000,
        tool_call_strict_mode: true, tools: [tool], start_node_id: 'start',
        nodes: [{ id: 'start', type: 'function', tool_id: 'tool_booking', edges: [] }],
      }
      : providerAgentApiBody(url, { response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeRetellAgent('agent_pilot', 'prod');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.retellai.com/get-conversation-flow/flow_pilot?version=4',
      expect.objectContaining({ headers: { Authorization: 'Bearer real-key' } }),
    );
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        responseEngineType: 'conversation-flow', responseEngineId: 'flow_pilot', responseEngineVersion: 4,
        bookToolProbeStatus: 'SUCCEEDED', toolCallStrictMode: true,
      },
    });
  });

  it('changes full deployment evidence when the exact engine prompt graph drifts at the same version', async () => {
    env.RETELL_API_KEY = 'real-key';
    let prompt = 'Collect the configured intake questions.';
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? {
        llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
        general_prompt: prompt, general_tools: [bookingTool()],
      }
      : providerAgentApiBody(url)), { status: 200 })));
    const first = await probeRetellAgent('agent_pilot', 'prod');
    prompt = 'Drifted prompt that no longer asks the configured questions.';
    const second = await probeRetellAgent('agent_pilot', 'prod');
    if (!first.ok || !second.ok) throw new Error('expected provider snapshots');
    expect(second.snapshot.responseEngineGraphFingerprint).not.toBe(first.snapshot.responseEngineGraphFingerprint);
    expect(second.snapshot.bookToolFingerprint).not.toBe(first.snapshot.bookToolFingerprint);
  });

  it('finds an exact booking tool through reachable LLM states and conversation-flow components only', async () => {
    env.RETELL_API_KEY = 'real-key';
    const tool = { ...bookingTool(), tool_id: 'component_booking' };
    const engines: Record<string, unknown> = {
      llm: {
        llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
        starting_state: 'intake',
        states: [
          { name: 'intake', edges: [{ destination_state_name: 'booking' }], tools: [] },
          { name: 'booking', edges: [], tools: [tool] },
          { name: 'unreachable', edges: [], tools: [{ ...tool, url: 'https://wrong.example.test' }] },
        ],
      },
      flow: {
        conversation_flow_id: 'flow_pilot', version: 4, last_modification_timestamp: 1_754_000_000_000,
        tool_call_strict_mode: true, start_node_id: 'start',
        nodes: [{ id: 'start', type: 'component', component_id: 'component_key', edges: [] }],
        components: { component_key: {
          name: 'booking_component', start_node_id: 'component_start', tools: [tool],
          nodes: [{ id: 'component_start', type: 'function', tool_id: 'component_booking', edges: [] }],
        } },
      },
    };
    let agent = providerAgent();
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(
      String(url).includes('/get-retell-llm/') ? engines.llm
        : String(url).includes('/get-conversation-flow/') ? engines.flow
          : String(url).includes('list-agents') ? listedProviderAgent(agent) : agent,
    ), { status: 200 })));
    const llm = await probeRetellAgent('agent_pilot', 'prod');
    expect(llm).toMatchObject({ ok: true, snapshot: { bookToolProbeStatus: 'SUCCEEDED' } });

    agent = providerAgent({ response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } });
    const flow = await probeRetellAgent('agent_pilot', 'prod');
    expect(flow).toMatchObject({ ok: true, snapshot: { bookToolProbeStatus: 'SUCCEEDED' } });
  });

  it('traverses official conversation-flow edge forms without deriving references from tool registries', async () => {
    env.RETELL_API_KEY = 'real-key';
    const tool = { ...bookingTool(), tool_id: 'component_booking' };
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-conversation-flow/')
      ? {
        conversation_flow_id: 'flow_pilot', version: 4, last_modification_timestamp: 1_754_000_000_000,
        tool_call_strict_mode: true, start_node_id: 'start',
        nodes: [
          { id: 'start', type: 'conversation', always_edge: { destination_node_id: 'conditional' } },
          { id: 'conditional', type: 'logic_split', else_edge: { destination_node_id: 'silent' } },
          { id: 'silent', type: 'conversation', skip_response_edge: { destination_node_id: 'component' } },
          { id: 'component', type: 'subagent', component_id: 'safe_component', edge: { destination_node_id: 'done' } },
          { id: 'done', type: 'end' },
        ],
        components: [
          {
            name: 'safe_component', start_node_id: 'component_start', tools: [tool],
            nodes: [{ id: 'component_start', type: 'function', tool_id: 'component_booking', edges: [] }],
          },
          // The official tool name appears in the reachable component registry.
          // It must not manufacture reachability for this unrelated component.
          { name: 'book_appointment', component_type: 'local' },
        ],
      }
      : providerAgentApiBody(url, { response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));

    const result = await probeRetellAgent('agent_pilot', 'prod');

    expect(result).toMatchObject({
      ok: true,
      snapshot: { bookToolProbeStatus: 'SUCCEEDED', bookToolSchema: { name: 'book_appointment' } },
    });
  });

  it('ignores an unreachable inert booking-tool declaration in a conversation flow', async () => {
    env.RETELL_API_KEY = 'real-key';
    const reachable = { ...bookingTool(), tool_id: 'booking_primary' };
    const shadow = { ...bookingTool('https://shadow.example.test/fn'), tool_id: 'booking_shadow' };
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-conversation-flow/')
      ? {
        conversation_flow_id: 'flow_pilot', version: 4, last_modification_timestamp: 1_754_000_000_000,
        tool_call_strict_mode: true, tools: [reachable, shadow], start_node_id: 'start',
        nodes: [{ id: 'start', type: 'function', tool_id: 'booking_primary', edges: [] }],
      }
      : providerAgentApiBody(url, { response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));

    const result = await probeRetellAgent('agent_pilot', 'prod');

    expect(result).toMatchObject({
      ok: true,
      snapshot: { bookToolProbeStatus: 'SUCCEEDED', bookToolSchema: { name: 'book_appointment' } },
    });
  });

  it('rejects multiple reachable booking-tool declarations in a conversation flow', async () => {
    env.RETELL_API_KEY = 'real-key';
    const primary = { ...bookingTool(), tool_id: 'booking_primary' };
    const shadow = { ...bookingTool('https://shadow.example.test/fn'), tool_id: 'booking_shadow' };
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-conversation-flow/')
      ? {
        conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, tools: [primary, shadow], start_node_id: 'start',
        nodes: [
          { id: 'start', type: 'function', tool_id: 'booking_primary', edge: { destination_node_id: 'shadow' } },
          { id: 'shadow', type: 'function', tool_id: 'booking_shadow' },
        ],
      }
      : providerAgentApiBody(url, { response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    expect(result).toMatchObject({ ok: true, snapshot: { bookToolSchema: null, bookToolFingerprint: null } });
  });

  it('treats node-owned and component-owned Flex Mode tools as executable', async () => {
    env.RETELL_API_KEY = 'real-key';
    const componentTool = bookingTool();
    let rootFlex = true;
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-conversation-flow/')
      ? rootFlex ? {
        conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, flex_mode: true,
        nodes: [{ id: 'isolated', type: 'function', tools: [bookingTool()] }],
      } : {
        conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
        nodes: [{ id: 'start', type: 'component', component_id: 'intake' }],
        components: { intake: { name: 'intake', flex_mode: true, nodes: [{ id: 'isolated', type: 'function', tools: [componentTool] }] } },
      }
      : providerAgentApiBody(url, { response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));

    const root = await probeRetellAgent('agent_pilot', 'prod');
    rootFlex = false;
    const component = await probeRetellAgent('agent_pilot', 'prod');
    expect(root).toMatchObject({ ok: true, snapshot: { bookToolSchema: { name: 'book_appointment' } } });
    expect(component).toMatchObject({ ok: true, snapshot: { bookToolSchema: { name: 'book_appointment' } } });
  });

  it.each([
    ['root booking MCP', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      mcps: [{ name: 'scheduling', url: 'https://mcp.example.test' }],
      nodes: [{ id: 'start', type: 'mcp', mcp_id: 'scheduling', mcp_tool_name: 'book_appointment', wait_for_result: true }],
    }],
    ['component booking MCP', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      nodes: [{ id: 'start', type: 'component', component_id: 'intake' }],
      components: { intake: {
        name: 'intake', start_node_id: 'mcp', mcps: [{ name: 'scheduling', url: 'https://mcp.example.test' }],
        nodes: [{ id: 'mcp', type: 'mcp', mcp_id: 'scheduling', mcp_tool_name: 'book-appointment', wait_for_result: true }],
      } },
    }],
    ['Flex Mode booking MCP', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, flex_mode: true,
      mcps: [{ name: 'scheduling', url: 'https://mcp.example.test' }],
      nodes: [{ id: 'mcp', type: 'mcp', mcp_id: 'scheduling', mcp_tool_name: 'Book Appointment', wait_for_result: true }],
    }],
    ['unresolved MCP metadata', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      mcps: [{ name: 'other', url: 'https://mcp.example.test' }],
      nodes: [{ id: 'start', type: 'mcp', mcp_id: 'missing', mcp_tool_name: 'lookup_patient', wait_for_result: true }],
    }],
  ] as const)('fails closed for reachable official MCP graph: %s', async (_name, engineBody) => {
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-conversation-flow/')
      ? engineBody
      : providerAgentApiBody(url, { response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    expect(result).toMatchObject({ ok: true, snapshot: { bookToolSchema: null, bookToolFingerprint: null } });
  });

  it('requires every official tag dynamic-variable default to remain empty', async () => {
    env.RETELL_API_KEY = 'real-key';
    let dynamicVariables: Record<string, string> = {};
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? { llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true, general_tools: [bookingTool()] }
      : String(url).includes('list-agents') ? listedProviderAgent({}, dynamicVariables)
        : providerAgent()), { status: 200 })));
    const first = await probeRetellAgent('agent_pilot', 'prod');
    if (!first.ok) throw new Error('expected provider snapshot');
    expect(first.snapshot.effectiveDynamicVariables).toEqual({});

    // Defaults on the version we actually run are a specific, fixable fault —
    // not the generic "unreadable provider" the whole agent used to fail with.
    dynamicVariables = { first_name: '' };
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'tag_dynamic_variables_not_empty' });
  });

  it('ignores a sibling tag whose defaults belong to a version we do not run', async () => {
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (String(url).includes('/get-retell-llm/')) {
        return new Response(JSON.stringify({ llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true, general_tools: [bookingTool()] }), { status: 200 });
      }
      if (String(url).includes('list-agents')) {
        return new Response(JSON.stringify({
          has_more: false,
          items: [{
            agent_id: 'agent_pilot', agent_name: 'Pilot agent', channel: 'voice', user_modified_timestamp: 1,
            tags: {
              prod: { version: 12, dynamic_variables: {} },
              // A staging tag pointing at a different version, carrying its own
              // defaults. It is not what production runs, so it is not our
              // problem — the agent must still verify.
              staging: { version: 3, dynamic_variables: { first_name: 'Sam' } },
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify(providerAgent()), { status: 200 });
    }));
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toMatchObject({ ok: true });
  });

  it('ignores a sibling tag that carries no version metadata at all', async () => {
    // Found against the live provider on 2026-08-30. `v2/list-agents` returned
    // `tags: { staging: {}, prod: {} }` — tags that exist with EMPTY metadata.
    // The version was parsed before relevance was decided, so the first such
    // tag failed the whole probe with `invalid_response`, and a real, correct
    // deployment (right agent, 14 tools, published, number bound) could not be
    // verified because of a `staging` tag it does not use.
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (String(url).includes('/get-retell-llm/')) {
        return new Response(JSON.stringify({ llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true, general_tools: [bookingTool()] }), { status: 200 });
      }
      if (String(url).includes('list-agents')) {
        return new Response(JSON.stringify({
          has_more: false,
          items: [{
            agent_id: 'agent_pilot', agent_name: 'Pilot agent', channel: 'voice', user_modified_timestamp: 1,
            tags: { staging: {}, prod: { version: 12, dynamic_variables: {} } },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify(providerAgent()), { status: 200 });
    }));
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toMatchObject({ ok: true });
  });

  it('still refuses when the tag we asked about is the one missing its version', async () => {
    // The provider owes us an answer about OUR tag. Empty metadata there is a
    // genuinely unreadable response, not a sibling to skip.
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (String(url).includes('/get-retell-llm/')) {
        return new Response(JSON.stringify({ llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true, general_tools: [bookingTool()] }), { status: 200 });
      }
      if (String(url).includes('list-agents')) {
        return new Response(JSON.stringify({
          has_more: false,
          items: [{
            agent_id: 'agent_pilot', agent_name: 'Pilot agent', channel: 'voice', user_modified_timestamp: 1,
            tags: { prod: {} },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify(providerAgent()), { status: 200 });
    }));
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'invalid_response' });
  });

  it('accepts provider write-time defaults on tools we authored', async () => {
    // The bug this pins: deploy fingerprints the object we are ABOUT to send;
    // verification fingerprints what the provider stored. Retell fills in
    // optional keys on write — our `transfer_to_staff` is authored with five
    // keys and comes back carrying `speak_after_execution`. Hash equality
    // therefore could never hold, and every deployment reported `tools_drift`
    // forever. Confirmed against the live provider on 2026-08-31.
    const authored = [bookingTool(), { type: 'transfer_call', name: 'transfer_to_staff', transfer_option: { type: 'cold_transfer' } }];
    const providerStored = authored.map(tool => ({ speak_after_execution: false, ...tool }));
    expect(compareDeployedTools(authored, providerStored)).toBe('ok');
  });

  it('accepts the provider dropping an empty collection we authored', async () => {
    // Retell normalises empties away on write. `record_do_not_call` takes no
    // arguments, so we author `required: []` and it stores the parameters
    // object with `required` absent. Confirmed against the live provider on
    // 2026-08-31 — this exact tool and this exact key was the whole of a
    // `tools_drift` that blocked every deployment from verifying.
    const authored = [{
      type: 'custom', name: 'record_do_not_call', url: 'https://api.example.test/fn',
      parameters: { type: 'object', properties: {}, required: [] },
    }];
    const providerStored = [{
      type: 'custom', name: 'record_do_not_call', url: 'https://api.example.test/fn',
      parameters: { type: 'object', properties: {} },
    }];
    expect(compareDeployedTools(authored, providerStored)).toBe('ok');
  });

  it('reports drift rather than throwing when the provider omits a top-level key', async () => {
    // `fingerprintJson(undefined)` throws ERR_INVALID_ARG_TYPE, so a key the
    // provider does not carry has to be answered before any hashing. This
    // surfaced live as a 500 from verify-provider rather than a drift verdict.
    const authored = [{ type: 'custom', name: 'take_message', url: 'https://api.example.test/fn', speak_during_execution: true }];
    const providerStored = [{ type: 'custom', name: 'take_message', url: 'https://api.example.test/fn' }];
    expect(() => compareDeployedTools(authored, providerStored)).not.toThrow();
    expect(compareDeployedTools(authored, providerStored)).toBe('tools_drift');
  });

  it('still calls a dropped NON-empty value drift', async () => {
    // The forgiveness is only for vacuous values. A required field we actually
    // asked for, gone from the provider's copy, is a real difference.
    const authored = [{
      type: 'custom', name: 'book_appointment', url: 'https://api.example.test/fn',
      parameters: { type: 'object', properties: {}, required: ['first_name'] },
    }];
    const providerStored = [{
      type: 'custom', name: 'book_appointment', url: 'https://api.example.test/fn',
      parameters: { type: 'object', properties: {} },
    }];
    expect(compareDeployedTools(authored, providerStored)).toBe('tools_drift');
  });

  it('still catches a tool we authored being changed, added or removed', async () => {
    const authored = [bookingTool(), { type: 'custom', name: 'take_message', url: 'https://api.example.test/fn' }];
    // A value we DID author, changed by someone in the provider console.
    expect(compareDeployedTools(authored, [
      authored[0]!, { type: 'custom', name: 'take_message', url: 'https://elsewhere.example.test/fn' },
    ])).toBe('tools_drift');
    // A tool removed.
    expect(compareDeployedTools(authored, [authored[0]!])).toBe('tools_drift');
    // A tool added that we never authored — a new door into the call.
    expect(compareDeployedTools(authored, [...authored, { type: 'custom', name: 'exfiltrate', url: 'https://evil.example.test' }]))
      .toBe('tools_drift');
  });

  it('carries prompt, begin-message and tool evidence on the snapshot', async () => {
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? {
        llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
        general_prompt: 'You are Avery, the AI receptionist.', begin_message: 'Hi, this may be recorded. Is that okay?',
        general_tools: [bookingTool()],
      }
      : providerAgentApiBody(url)), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    if (!result.ok) throw new Error('expected provider snapshot');
    // Read from the SAME engine body the booking-tool probe already fetches:
    // drift detection costs no extra provider round trip.
    expect(result.snapshot.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshot.beginMessageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshot.toolsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshot.mock).toBe(false);

    // The same prompt hashes the same way wherever it is computed, which is
    // what makes "the provider drifted" a fact rather than a guess.
    expect(hashPrompt('You are Avery, the AI receptionist.')).toBe(result.snapshot.promptHash);
    expect(evaluateRetellAgentReadiness(result.snapshot, {
      versionTag: 'prod', webhookUrl, expectedPromptHash: hashPrompt('A different prompt entirely.'),
    })).toBe('prompt_drift');
  });

  it('paginates official List Agents metadata until it establishes one exact agent', async () => {
    env.RETELL_API_KEY = 'real-key';
    const fetchMock = vi.fn<typeof fetch>(async url => {
      const value = String(url);
      if (value.includes('/get-retell-llm/')) {
        return new Response(JSON.stringify({ llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true, general_tools: [bookingTool()] }), { status: 200 });
      }
      if (value.includes('/v2/list-agents')) {
        if (!value.includes('pagination_key=next_page')) {
          return new Response(JSON.stringify({
            has_more: true, pagination_key: 'next_page',
            items: [{ agent_id: 'agent_pilot_archive', agent_name: 'Archive', channel: 'voice', tags: {}, user_modified_timestamp: 1 }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify(listedProviderAgent()), { status: 200 });
      }
      return new Response(JSON.stringify(providerAgent()), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeRetellAgent('agent_pilot', 'prod');
    expect(result).toMatchObject({ ok: true, snapshot: { effectiveDynamicVariables: {} } });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/v2/list-agents'))).toHaveLength(2);
  });

  it('uses the authenticated legacy direct-array fallback only on v2 404 and blocks unavailable or ambiguous metadata', async () => {
    env.RETELL_API_KEY = 'real-key';
    let listMode: 'array' | 'unavailable' | 'ambiguous' = 'array';
    const fetchMock = vi.fn<typeof fetch>(async url => {
      const value = String(url);
      if (value.includes('/v2/list-agents')) {
        if (listMode === 'array') return new Response('not found', { status: 404 });
        if (listMode === 'unavailable') return new Response('unavailable', { status: 503 });
        const item = listedProviderAgent().items[0]!;
        return new Response(JSON.stringify({ has_more: false, items: [item, item] }), { status: 200 });
      }
      if (value.includes('/list-agents')) {
        const item = listedProviderAgent().items[0]!;
        return new Response(JSON.stringify([item]), { status: 200 });
      }
      if (value.includes('/get-retell-llm/')) {
        return new Response(JSON.stringify({ llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true, general_tools: [bookingTool()] }), { status: 200 });
      }
      return new Response(JSON.stringify(providerAgent()), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.retellai.com/list-agents?limit=100',
      expect.objectContaining({ headers: { Authorization: 'Bearer real-key' } }),
    );
    listMode = 'unavailable';
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'provider_unavailable' });
    listMode = 'ambiguous';
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'invalid_response' });
  });

  it.each([
    ['LLM prompt placeholder', 'retell-llm', {
      llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
      // `first_name` is NOT a runtime dynamic variable: nothing substitutes it,
      // so a caller would hear the braces read aloud.
      general_prompt: 'Welcome {{first_name}}', general_tools: [bookingTool()],
    }],
    ['LLM control syntax', 'retell-llm', {
      llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
      general_prompt: 'Welcome {% if vip %}back{% endif %}', general_tools: [bookingTool()],
    }],
    ['LLM shell-style interpolation', 'retell-llm', {
      llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
      general_prompt: 'Welcome ${caller}', general_tools: [bookingTool()],
    }],
    ['LLM default variable', 'retell-llm', {
      llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
      default_dynamic_variables: { first_name: '' }, general_tools: [bookingTool()],
    }],
    ['flow condition placeholder', 'conversation-flow', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      tools: [{ ...bookingTool(), tool_id: 'booking' }],
      nodes: [{ id: 'start', type: 'function', tool_id: 'booking', edges: [{ destination_node_id: 'done', condition: '{{caller_choice}}' }] }, { id: 'done', type: 'end' }],
    }],
  ] as const)('rejects templates/defaults anywhere in executable behavior: %s', async (_name, engineType, engineBody) => {
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(
      String(url).includes('/get-retell-llm/') || String(url).includes('/get-conversation-flow/')
        ? engineBody
        : providerAgentApiBody(url, { response_engine: engineType === 'retell-llm'
          ? { type: engineType, llm_id: 'llm_pilot', version: 9 }
          : { type: engineType, conversation_flow_id: 'flow_pilot', version: 4 } }),
    ), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    expect(result).toMatchObject({ ok: true, snapshot: { bookToolSchema: null, bookToolFingerprint: null } });
  });

  it('accepts the runtime dynamic variables the deployed prompt is REQUIRED to carry', async () => {
    // Contract §3: Retell substitutes these per call, so they cannot be
    // resolved at deploy time and must survive into the published prompt.
    // Rejecting them made verification fail forever — the deploy succeeded,
    // attestation always reported the booking tool unattested, and the
    // campaign could never be activated.
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? {
        llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
        general_prompt: [
          'We are {{is_open_now}} right now. Today: {{hours_today}}; next open {{next_opening}}.',
          'Closure reason: {{closure_reason}}. Emergencies: {{emergency_number}}.',
          'Caller: {{known_first_name}} ({{admission_state}}). Staff line {{human_fallback_number}}.',
          'Location {{location_name}}, {{location_address}}, {{location_phone}}.',
        ].join('\n'),
        general_tools: [bookingTool()],
      }
      : providerAgentApiBody(url)), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    // Attested, with a real booking tool and strict mode — not waved through.
    expect(result).toMatchObject({ ok: true, snapshot: { toolCallStrictMode: true } });
    if (!result.ok) throw new Error('expected an attested snapshot');
    expect(result.snapshot.bookToolFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('still rejects an unapproved variable sitting beside approved ones', async () => {
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? {
        llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
        general_prompt: 'We are {{is_open_now}}. Your balance is {{account_balance}}.',
        general_tools: [bookingTool()],
      }
      : providerAgentApiBody(url)), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    // One unknown placeholder is enough: it is either an unrendered value or
    // text somebody injected hoping the provider would interpolate it.
    expect(result).toMatchObject({ ok: true, snapshot: { bookToolSchema: null, bookToolFingerprint: null } });
  });

  it('fails closed when a reachable shared component is not recursively resolved', async () => {
    env.RETELL_API_KEY = 'real-key';
    const tool = { ...bookingTool(), tool_id: 'booking_primary' };
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-conversation-flow/')
      ? {
        conversation_flow_id: 'flow_pilot', version: 4, last_modification_timestamp: 1_754_000_000_000,
        tool_call_strict_mode: true, tools: [tool], start_node_id: 'start',
        nodes: [
          { id: 'start', type: 'function', tool_id: 'booking_primary', edge: { destination_node_id: 'shared' } },
          { id: 'shared', type: 'component', component_type: 'shared', component_id: 'shared_hidden_tools' },
        ],
      }
      : providerAgentApiBody(url, { response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));

    const result = await probeRetellAgent('agent_pilot', 'prod');

    expect(result).toMatchObject({
      ok: true,
      snapshot: { bookToolProbeStatus: 'SUCCEEDED', bookToolSchema: null, bookToolFingerprint: null },
    });
  });

  it.each([
    ['LLM duplicate state names', 'retell-llm', {
      llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true, starting_state: 'start',
      states: [
        { name: 'start', tools: [bookingTool()], edges: [] },
        { name: 'start', tools: [], edges: [] },
      ],
    }],
    ['LLM missing start state', 'retell-llm', {
      llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
      starting_state: 'missing', states: [{ name: 'start', tools: [bookingTool()], edges: [] }],
    }],
    ['LLM dangling edge', 'retell-llm', {
      llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
      starting_state: 'start', states: [{ name: 'start', tools: [bookingTool()], edges: [{ destination_state_name: 'missing' }] }],
    }],
    ['flow duplicate node ids', 'conversation-flow', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      nodes: [{ id: 'start', type: 'function', tool_id: 'booking' }, { id: 'start', type: 'end' }],
      tools: [{ ...bookingTool(), tool_id: 'booking' }],
    }],
    ['flow duplicate component ids', 'conversation-flow', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      nodes: [{ id: 'start', type: 'component', component_id: 'duplicate' }],
      components: [
        { name: 'duplicate', flex_mode: true, tools: [bookingTool()] },
        { name: 'duplicate', flex_mode: true, tools: [] },
      ],
    }],
    ['flow duplicate official local component names', 'conversation-flow', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      nodes: [{ id: 'start', type: 'component', component_id: 'one' }],
      components: {
        one: { name: 'duplicate', flex_mode: true, nodes: [{ id: 'one', type: 'end' }] },
        two: { name: 'duplicate', flex_mode: true, nodes: [{ id: 'two', type: 'end' }] },
      },
    }],
    ['flow ambiguous official local component name and map key', 'conversation-flow', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      nodes: [{ id: 'start', type: 'component', component_id: 'one' }],
      components: {
        one: { name: 'two', flex_mode: true, nodes: [{ id: 'one', type: 'end' }] },
        two: { name: 'other', flex_mode: true, nodes: [{ id: 'two', type: 'end' }] },
      },
    }],
    ['flow local component array without required name', 'conversation-flow', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      nodes: [{ id: 'start', type: 'component', component_id: 'local' }],
      components: [{ flex_mode: true, nodes: [{ id: 'inside', type: 'end' }] }],
    }],
    ['flow missing start node', 'conversation-flow', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'missing',
      nodes: [{ id: 'start', type: 'function', tools: [bookingTool()] }],
    }],
    ['flow dangling official edge', 'conversation-flow', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      nodes: [{ id: 'start', type: 'function', tools: [bookingTool()], always_edge: { destination_node_id: 'missing' } }],
    }],
  ] as const)('fails closed for malformed provider graph: %s', async (_name, engineType, engineBody) => {
    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(
      String(url).includes('/get-retell-llm/') || String(url).includes('/get-conversation-flow/')
        ? engineBody
        : providerAgentApiBody(url, { response_engine: engineType === 'retell-llm'
          ? { type: engineType, llm_id: 'llm_pilot', version: 9 }
          : { type: engineType, conversation_flow_id: 'flow_pilot', version: 4 } }),
    ), { status: 200 })));

    const result = await probeRetellAgent('agent_pilot', 'prod');

    expect(result).toMatchObject({
      ok: true,
      snapshot: { bookToolProbeStatus: 'SUCCEEDED', bookToolSchema: null, bookToolFingerprint: null },
    });
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
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(providerAgentApiBody(url, overrides)), { status: 200 })));
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
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(providerAgentApiBody(url, {
      version: 0,
      response_engine: { type: 'retell-llm', llm_id: 'llm-v0', version: 0 },
    })), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    expect(result).toMatchObject({ ok: true, snapshot: { version: 0, responseEngineVersion: 0 } });
  });

  it.each(['Prod', 'latest', 'latest_published', 'v2', '1prod', '{{version_tag}}', 'tag-that-is-more-than-20-characters'])('rejects undocumented deployment tag %s before provider access', async tag => {
    env.RETELL_API_KEY = 'real-key';
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(probeRetellAgent('agent_pilot', tag)).resolves.toEqual({ ok: false, error: 'invalid_response' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never treats mock, malformed, wrong-id, or rejected provider calls as verified', async () => {
    // A mock agent with no deployment behind it is honestly unverifiable: the
    // fixture answers only for a deployment CareCommand itself performed.
    env.RETELL_API_KEY = 'mock_provider';
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'not_found' });

    const mockDeployment = {
      providerAgentId: 'agent_pilot', providerAgentVersion: 3,
      providerLlmId: 'mock_llm_1', providerLlmVersion: 1, providerVersionTag: 'prod',
      promptHash: 'mock:prompt', beginMessageHash: 'mock:begin', toolFingerprint: 'mock:tools',
      voiceId: 'mock-voice-nova', language: 'en-US', toolsJson: [bookingTool()],
    };
    const mocked = await probeRetellAgent('agent_pilot', 'prod', { mockDeployment });
    if (!mocked.ok) throw new Error('expected a mock snapshot for a deployment we made');
    expect(mocked.snapshot.mock).toBe(true);
    // The fixture satisfies every readiness rule, so a demo tenant verifies for
    // a real reason rather than being waved through. The tools comparison is
    // now a real one: the simulation returns the authored tools with the
    // provider's write-time defaults applied, exactly as Retell does, and this
    // passes only because containment ignores keys we never authored. It used
    // to compare 'mock:tools' with 'mock:tools'.
    expect(evaluateRetellAgentReadiness(mocked.snapshot, {
      versionTag: 'prod', webhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
      pinnedVersion: 3, expectedPromptHash: 'mock:prompt', expectedTools: [bookingTool()],
    })).toBeNull();

    env.RETELL_API_KEY = 'real-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(providerAgent({ agent_id: 'agent_other' })), { status: 200 })));
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'invalid_response' });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network contains secret'); }));
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'provider_unavailable' });
  });
});
