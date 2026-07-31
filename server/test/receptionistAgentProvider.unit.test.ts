import 'dotenv/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { evaluateRetellAgentReadiness, probeRetellAgent } from '../lib/retell';
import { compileIntakeContract } from '../modules/receptionist/intakeContract';

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
  it('uses exact tag/auth GET contract and produces a non-secret deterministic safety snapshot', async () => {
    env.RETELL_API_KEY = 'retell-secret-value';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const fetchMock = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? {
        llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true,
        general_tools: [bookingTool()],
      }
      : providerAgent()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeRetellAgent('agent_pilot', 'prod');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.retellai.com/get-agent/agent_pilot?version=prod',
      expect.objectContaining({ headers: { Authorization: 'Bearer retell-secret-value' } }),
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
      : providerAgent({ response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 }));
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
      : providerAgent()), { status: 200 })));
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
          : agent,
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
            conversation_flow_component_id: 'safe_component', start_node_id: 'component_start', tools: [tool],
            nodes: [{ id: 'component_start', type: 'function', tool_id: 'component_booking', edges: [] }],
          },
          // The official tool name appears in the reachable component registry.
          // It must not manufacture reachability for this unrelated component.
          { conversation_flow_component_id: 'book_appointment', component_type: 'local' },
        ],
      }
      : providerAgent({ response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));

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
      : providerAgent({ response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));

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
      : providerAgent({ response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));
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
      : providerAgent({ response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));

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
      : providerAgent({ response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));
    const result = await probeRetellAgent('agent_pilot', 'prod');
    expect(result).toMatchObject({ ok: true, snapshot: { bookToolSchema: null, bookToolFingerprint: null } });
  });

  it('binds safe effective tag variables into the provider fingerprint and rejects behavior/template overrides', async () => {
    env.RETELL_API_KEY = 'real-key';
    let dynamicVariables: Record<string, string> = { clinic_name: 'Care Clinic', appointment_type: '' };
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? { llm_id: 'llm_pilot', version: 9, is_published: true, tool_call_strict_mode: true, general_tools: [bookingTool()] }
      : providerAgent({ dynamic_variables: dynamicVariables })), { status: 200 })));
    const first = await probeRetellAgent('agent_pilot', 'prod');
    dynamicVariables = { clinic_name: 'Care Clinic East', appointment_type: '' };
    const changed = await probeRetellAgent('agent_pilot', 'prod');
    if (!first.ok || !changed.ok) throw new Error('expected provider snapshots');
    expect(first.snapshot.effectiveDynamicVariables).toEqual({ appointment_type: '', clinic_name: 'Care Clinic' });
    expect(changed.snapshot.fingerprint).not.toBe(first.snapshot.fingerprint);

    dynamicVariables = { appointment_type: 'Unsafe override' };
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'invalid_response' });
    dynamicVariables = { clinic_name: '{{caller_override}}' };
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'invalid_response' });
    dynamicVariables = { undocumented_future_override: '' };
    await expect(probeRetellAgent('agent_pilot', 'prod')).resolves.toEqual({ ok: false, error: 'invalid_response' });
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
      : providerAgent({ response_engine: { type: 'conversation-flow', conversation_flow_id: 'flow_pilot', version: 4 } })), { status: 200 })));

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
        { conversation_flow_component_id: 'duplicate', flex_mode: true, tools: [bookingTool()] },
        { conversation_flow_component_id: 'duplicate', flex_mode: true, tools: [] },
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
    ['flow local component array without deterministic id', 'conversation-flow', {
      conversation_flow_id: 'flow_pilot', version: 4, tool_call_strict_mode: true, start_node_id: 'start',
      nodes: [{ id: 'start', type: 'component', component_id: 'local' }],
      components: [{ name: 'local', flex_mode: true, nodes: [{ id: 'inside', type: 'end' }] }],
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
        : providerAgent({ response_engine: engineType === 'retell-llm'
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

  it.each(['Prod', 'latest', 'latest_published', 'v2', '1prod', '{{version_tag}}', 'tag-that-is-more-than-20-characters'])('rejects undocumented deployment tag %s before provider access', async tag => {
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
