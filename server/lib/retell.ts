import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env';
import {
  fingerprintJson,
  normalizeBookAppointmentToolContract,
} from '../modules/receptionist/intakeContract';

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
  responseEngineGraphFingerprint: string | null;
  bookToolProbeStatus: 'SUCCEEDED' | 'UNAVAILABLE' | 'UNSUPPORTED';
  bookToolSchema: Record<string, unknown> | null;
  bookToolFingerprint: string | null;
  toolCallStrictMode: boolean | null;
  effectiveDynamicVariables: Record<string, string>;
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
  return /^[a-z][a-z0-9_-]{0,19}$/.test(value) && !['latest', 'latest_published'].includes(value) && !/^v\d+$/.test(value);
}

function providerDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const numeric = typeof value === 'number' ? (value < 10_000_000_000 ? value * 1_000 : value) : value;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? null : date;
}

const SAFE_NONEMPTY_PROVIDER_VARIABLES = new Set([
  'agent_name', 'campaign_name', 'clinic_name', 'clinic_phone', 'clinic_timezone',
  'clinic_website', 'first_name', 'human_fallback_number', 'offer_title',
]);
const EMPTY_ONLY_PROVIDER_VARIABLES = new Set([
  'appointment_type', 'booking_mode', 'consent_text', 'disclosure',
  'eligible_locations', 'human_handoff', 'required_fields', 'script',
]);

function providerEffectiveDynamicVariables(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  const values = record(value);
  if (!values || Object.keys(values).length > 64) return null;
  const normalized: Record<string, string> = {};
  for (const key of Object.keys(values).sort()) {
    const item = values[key];
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || typeof item !== 'string' || item.length > 500) return null;
    if (!SAFE_NONEMPTY_PROVIDER_VARIABLES.has(key) && !EMPTY_ONLY_PROVIDER_VARIABLES.has(key)) return null;
    if ([...item].some(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) || /\{\{|\}\}|\$\{/.test(item)) return null;
    // Empty tag defaults are intentionally safe: the signed call launch owns
    // those values. Non-empty provider defaults are limited to presentation
    // fields and cannot override booking, identity, consent, or tool routing.
    if (item !== '' && !SAFE_NONEMPTY_PROVIDER_VARIABLES.has(key)) return null;
    normalized[key] = item;
  }
  return normalized;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function reachableRetellLlmTools(body: Record<string, unknown>): unknown[] | null {
  const general = Array.isArray(body.general_tools) ? [...body.general_tools] : [];
  if (!Array.isArray(body.states) || body.states.length === 0) return general;
  const states = new Map<string, Record<string, unknown>>();
  for (const item of body.states) {
    const state = record(item);
    const name = nonEmptyString(state?.name);
    if (state && name) {
      if (states.has(name)) return null;
      states.set(name, state);
    }
  }
  const start = nonEmptyString(body.starting_state);
  if (!start || !states.has(start)) return null;
  const queue = [start];
  const visited = new Set<string>();
  const tools = [...general];
  while (queue.length) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const state = states.get(name);
    if (!state) return null;
    if (Array.isArray(state.tools)) tools.push(...state.tools);
    if (Array.isArray(state.edges)) {
      for (const edgeValue of state.edges) {
        const destination = nonEmptyString(record(edgeValue)?.destination_state_name);
        if (destination && !visited.has(destination)) queue.push(destination);
      }
    }
  }
  return tools;
}

type ConversationFlowTraversal = {
  toolReferences: Set<string>;
  componentReferences: Set<string>;
  embeddedTools: Record<string, unknown>[];
  mcpReferences: Array<{ mcpId: string | null; toolName: string | null }>;
  invalid: boolean;
};

function addReference(value: unknown, output: Set<string>) {
  const direct = nonEmptyString(value);
  if (direct) output.add(direct);
}

function collectNodeReferences(node: Record<string, unknown>, traversal: ConversationFlowTraversal) {
  addReference(node.tool_id, traversal.toolReferences);
  if (Array.isArray(node.tool_ids)) node.tool_ids.forEach(value => addReference(value, traversal.toolReferences));
  if (Array.isArray(node.tools)) {
    for (const value of node.tools) {
      const tool = record(value);
      if (tool && nonEmptyString(tool.type) === 'mcp') {
        traversal.mcpReferences.push({ mcpId: nonEmptyString(tool.mcp_id), toolName: nonEmptyString(tool.mcp_tool_name) });
      } else if (tool && nonEmptyString(tool.name)) traversal.embeddedTools.push(tool);
      else if (tool) addReference(tool.tool_id, traversal.toolReferences);
      else addReference(value, traversal.toolReferences);
    }
  }
  const embeddedTool = record(node.tool);
  if (embeddedTool && nonEmptyString(embeddedTool.type) === 'mcp') {
    traversal.mcpReferences.push({ mcpId: nonEmptyString(embeddedTool.mcp_id), toolName: nonEmptyString(embeddedTool.mcp_tool_name) });
  } else if (embeddedTool && nonEmptyString(embeddedTool.name)) {
    traversal.embeddedTools.push(embeddedTool);
  }
  if (nonEmptyString(node.type) === 'mcp') {
    const mcpId = nonEmptyString(node.mcp_id);
    const toolName = nonEmptyString(node.mcp_tool_name);
    traversal.mcpReferences.push({ mcpId, toolName });
    if (!mcpId || !toolName) traversal.invalid = true;
  }
  addReference(node.component_id, traversal.componentReferences);
  addReference(node.conversation_flow_component_id, traversal.componentReferences);
  if (Array.isArray(node.component_ids)) node.component_ids.forEach(value => addReference(value, traversal.componentReferences));
  if (nonEmptyString(node.component_type) === 'shared') traversal.invalid = true;
}

function edgeDestinations(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const destinations: string[] = [];
  for (const item of values) {
    const destination = nonEmptyString(record(item)?.destination_node_id);
    if (destination) destinations.push(destination);
  }
  return destinations;
}

function traverseConversationFlowNodes(nodeValues: unknown, startValue: unknown, allNodes = false): ConversationFlowTraversal | null {
  if (!Array.isArray(nodeValues)) return null;
  const nodes = new Map<string, Record<string, unknown>>();
  for (const item of nodeValues) {
    const node = record(item);
    const id = nonEmptyString(node?.id);
    if (node && id) {
      if (nodes.has(id)) return null;
      nodes.set(id, node);
    }
  }
  const start = nonEmptyString(startValue);
  if (!allNodes && (!start || !nodes.has(start))) return null;
  if (start && !nodes.has(start)) return null;
  const traversal: ConversationFlowTraversal = {
    toolReferences: new Set<string>(), componentReferences: new Set<string>(), embeddedTools: [], mcpReferences: [], invalid: false,
  };
  const queue = allNodes ? [...nodes.keys()] : [start!];
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (!node) return null;
    collectNodeReferences(node, traversal);
    for (const field of ['edges', 'edge', 'always_edge', 'else_edge', 'skip_response_edge'] as const) {
      for (const destination of edgeDestinations(node[field])) {
        if (!nodes.has(destination)) return null;
        if (!visited.has(destination)) queue.push(destination);
      }
    }
  }
  return traversal;
}

function registeredTools(values: unknown): Record<string, unknown>[] {
  return Array.isArray(values) ? values.map(record).filter((value): value is Record<string, unknown> => value !== null) : [];
}

function referencedRegisteredTools(tools: Record<string, unknown>[], references: Set<string>, allReachable: boolean) {
  return tools.filter(tool => {
    const id = nonEmptyString(tool.tool_id);
    const name = nonEmptyString(tool.name);
    return allReachable || (id !== null && references.has(id)) || (name !== null && references.has(name));
  });
}

function mcpIds(values: unknown): Set<string> | null {
  const ids = new Set<string>();
  const entries = Array.isArray(values)
    ? values.map(value => ({ id: nonEmptyString(record(value)?.mcp_id) ?? nonEmptyString(record(value)?.name), value }))
    : record(values) ? Object.entries(values as Record<string, unknown>).map(([id, value]) => ({ id: nonEmptyString(id), value })) : [];
  for (const entry of entries) {
    if (!entry.id || !record(entry.value) || ids.has(entry.id)) return null;
    ids.add(entry.id);
  }
  return ids;
}

function validateMcpReferences(traversal: ConversationFlowTraversal, values: unknown): boolean {
  if (traversal.invalid) return false;
  if (!traversal.mcpReferences.length) return true;
  const registeredIds = mcpIds(values);
  if (!registeredIds) return false;
  return traversal.mcpReferences.every(reference => Boolean(
    reference.mcpId
    && reference.toolName
    && registeredIds.has(reference.mcpId)
    && reference.toolName.toLowerCase().replace(/[^a-z0-9]/g, '') !== 'bookappointment',
  ));
}

function reachableConversationFlowTools(body: Record<string, unknown>): { tools: unknown[] } | null {
  const components = new Map<string, Record<string, unknown>>();
  const componentNames = new Map<string, string>();
  const componentInput = body.components;
  const componentEntries: Array<[string, Record<string, unknown>]> = [];
  if (Array.isArray(componentInput)) {
    for (const value of componentInput) {
      const component = record(value);
      // Retell's local-component response is an object map. Array-shaped data
      // is accepted only when every entry carries the provider's stable shared
      // component identifier; guessed `id`/`component_id` aliases are unsafe.
      const id = nonEmptyString(component?.conversation_flow_component_id);
      if (!component || !id) return null;
      componentEntries.push([id, component]);
    }
  } else if (componentInput !== undefined && componentInput !== null) {
    const componentMap = record(componentInput);
    if (!componentMap) return null;
    for (const [rawId, value] of Object.entries(componentMap)) {
      const id = nonEmptyString(rawId);
      const component = record(value);
      if (!id || !component) return null;
      componentEntries.push([id, component]);
    }
  }
  for (const [id, component] of componentEntries) {
    if (components.has(id)) return null;
    components.set(id, component);
    const name = nonEmptyString(component.name);
    if (record(componentInput)) {
      if (!name || componentNames.has(name)) return null;
      componentNames.set(name, id);
    } else if (name) {
      if (componentNames.has(name)) return null;
      componentNames.set(name, id);
    }
  }
  for (const [name, id] of componentNames) {
    if (components.has(name) && name !== id) return null;
  }

  const resolveComponent = (reference: string): string | null => {
    const byId = components.has(reference) ? reference : null;
    const byName = componentNames.get(reference) ?? null;
    return byId && byName && byId !== byName ? null : byId ?? byName;
  };
  const reachableTools: Record<string, unknown>[] = [];
  const componentQueue: string[] = [];
  const rootTraversal = traverseConversationFlowNodes(body.nodes, body.start_node_id, body.flex_mode === true);
  if (!rootTraversal || !validateMcpReferences(rootTraversal, body.mcps)) return null;
  reachableTools.push(...rootTraversal.embeddedTools);
  reachableTools.push(...referencedRegisteredTools(registeredTools(body.tools), rootTraversal.toolReferences, body.flex_mode === true));
  componentQueue.push(...rootTraversal.componentReferences);

  const traversedComponents = new Set<string>();
  while (componentQueue.length) {
    const reference = componentQueue.shift()!;
    const componentId = resolveComponent(reference);
    if (!componentId) return null;
    if (traversedComponents.has(componentId)) continue;
    traversedComponents.add(componentId);
    const component = components.get(componentId);
    if (!component) return null;
    const traversal = traverseConversationFlowNodes(component.nodes, component.start_node_id, component.flex_mode === true);
    if (!traversal || !validateMcpReferences(traversal, component.mcps)) return null;
    reachableTools.push(...traversal.embeddedTools);
    reachableTools.push(...referencedRegisteredTools(registeredTools(component.tools), traversal.toolReferences, component.flex_mode === true));
    componentQueue.push(...traversal.componentReferences);
  }

  return { tools: reachableTools };
}

async function probeRetellBookTool(responseEngineType: string, responseEngineId: string, responseEngineVersion: number | null) {
  if (!['retell-llm', 'conversation-flow'].includes(responseEngineType) || responseEngineVersion === null) {
    return { status: 'UNSUPPORTED' as const, schema: null, fingerprint: null, strictMode: null, graphFingerprint: null };
  }
  try {
    const endpoint = responseEngineType === 'retell-llm' ? 'get-retell-llm' : 'get-conversation-flow';
    const response = await fetchWithTimeout(
      `${env.RETELL_BASE_URL}/${endpoint}/${encodeURIComponent(responseEngineId)}?version=${responseEngineVersion}`,
      { headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` } },
    );
    if (!response.ok) return { status: 'UNAVAILABLE' as const, schema: null, fingerprint: null, strictMode: null, graphFingerprint: null };
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const resolvedId = responseEngineType === 'retell-llm'
      ? nonEmptyString(body?.llm_id)
      : nonEmptyString(body?.conversation_flow_id);
    if (!body || resolvedId !== responseEngineId || nonNegativeInteger(body.version) !== responseEngineVersion) {
      return { status: 'UNAVAILABLE' as const, schema: null, fingerprint: null, strictMode: null, graphFingerprint: null };
    }
    const graphFingerprint = fingerprintJson(body);
    const discovery = responseEngineType === 'retell-llm'
      ? { tools: reachableRetellLlmTools(body) }
      : reachableConversationFlowTools(body);
    if (!discovery || !discovery.tools) return { status: 'SUCCEEDED' as const, schema: null, fingerprint: null, strictMode: null, graphFingerprint };
    const tools = discovery.tools;
    const bookingTools = tools.filter(tool => tool && typeof tool === 'object' && nonEmptyString((tool as Record<string, unknown>).name) === 'book_appointment') as Array<Record<string, unknown>>;
    const contract = bookingTools.length === 1 ? normalizeBookAppointmentToolContract(bookingTools[0]) : null;
    const strictMode = body.tool_call_strict_mode === true;
    // Retell LLM has its own publication flag. Conversation Flow does not;
    // production publication is enforced on the exact agent tag/version.
    const published = responseEngineType === 'conversation-flow' || body.is_published === true;
    if (!published || !contract) {
      return { status: 'SUCCEEDED' as const, schema: null, fingerprint: null, strictMode: null, graphFingerprint };
    }
    return {
      status: 'SUCCEEDED' as const,
      schema: contract,
      fingerprint: fingerprintJson({
        tool: contract,
        engine: { type: responseEngineType, id: responseEngineId, version: responseEngineVersion, graphFingerprint },
      }),
      strictMode,
      graphFingerprint,
    };
  } catch {
    return { status: 'UNAVAILABLE' as const, schema: null, fingerprint: null, strictMode: null, graphFingerprint: null };
  }
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
    const effectiveDynamicVariables = providerEffectiveDynamicVariables(body.dynamic_variables);
    if (!effectiveDynamicVariables) return { ok: false, error: 'invalid_response' };
    const responseEngineVersion = nonNegativeInteger(responseEngine?.version);
    const bookTool = await probeRetellBookTool(responseEngineType, responseEngineId, responseEngineVersion);
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
      responseEngineVersion,
      effectiveDynamicVariables,
      lastModifiedAt: providerDate(body.last_modification_timestamp),
    };
    return {
      ok: true,
      snapshot: {
        ...safety,
        bookToolProbeStatus: bookTool.status,
        responseEngineGraphFingerprint: bookTool.graphFingerprint,
        bookToolSchema: bookTool.schema as unknown as Record<string, unknown> | null,
        bookToolFingerprint: bookTool.fingerprint,
        toolCallStrictMode: bookTool.strictMode,
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
