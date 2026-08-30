import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env';
import {
  fingerprintJson,
  normalizeBookAppointmentToolContract,
} from '../modules/receptionist/intakeContract';
import {
  buildMockAgentSnapshot,
  mockCreateAgent,
  mockCreateLlm,
  mockListVoices,
  mockPublishAgent,
  mockUpdateAgent,
  mockUpdateLlm,
} from './receptionist/retellMock';

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

export type RetellProviderMode = 'live' | 'mock' | 'unconfigured';

export function retellProviderMode(): RetellProviderMode {
  const status = retellConfigStatus();
  if (!status.configured) return 'unconfigured';
  return status.mock ? 'mock' : 'live';
}

// ---------------------------------------------------------------------------
// Shared webhook contract. The bare agent-level webhook URL is what the agent
// deployment carries and what verification compares against; the per-clinic
// tool URL is embedded in the intake-contract fingerprint and must not change.
// ---------------------------------------------------------------------------
export function expectedRetellAgentWebhookUrl(baseUrl = env.PUBLIC_API_URL): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`;
}

export function expectedRetellToolUrl(clinicId: string, baseUrl = env.PUBLIC_API_URL): string {
  return `${baseUrl.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${clinicId}`;
}

export const REQUIRED_RETELL_WEBHOOK_EVENTS = ['call_started', 'call_ended', 'call_analyzed'] as const;

export const RETELL_DATA_STORAGE_SETTING = 'basic_attributes_only';

// ---------------------------------------------------------------------------
// Deployment fingerprints. One hashing rule is shared by the deploy plan, the
// provider probe and readiness so "what we deployed" and "what the provider
// runs" are comparable byte-for-byte. Mock-mode hashes carry a `mock:` prefix
// so a deployment made against the fixture can never be mistaken for live
// evidence (and the database CHECK on the deployment row enforces it).
// ---------------------------------------------------------------------------
export function normalizePromptText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

export function hashPrompt(text: string, options: { mock?: boolean } = {}): string {
  const digest = createHash('sha256').update(normalizePromptText(text)).digest('hex');
  return options.mock ? `mock:${digest}` : digest;
}

export function fingerprintTools(tools: unknown[], options: { mock?: boolean } = {}): string {
  const named = tools
    .map(tool => record(tool))
    .filter((tool): tool is Record<string, unknown> => tool !== null)
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
  const digest = fingerprintJson(named);
  return options.mock ? `mock:${digest}` : digest;
}

// ---------------------------------------------------------------------------
// Provider mutation results. Every write to Retell shares one error contract so
// the deploy service maps statuses without ever surfacing a provider body.
// ---------------------------------------------------------------------------
export type RetellProviderErrorCode =
  | 'setup_required'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'request_failed';

export type RetellProviderResult<T> =
  | { ok: true; value: T; mock: boolean }
  | { ok: false; error: RetellProviderErrorCode; status?: number; mock: boolean };

export function mapRetellProviderStatus(status: number): RetellProviderErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 429) return 'rate_limited';
  return 'provider_unavailable';
}

export function isTransientRetellProviderError(code: string | null | undefined): boolean {
  return code === 'provider_unavailable' || code === 'rate_limited' || code === 'request_failed';
}

async function providerRequest(
  path: string,
  init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; timeoutMs?: number },
): Promise<RetellProviderResult<Record<string, unknown>>> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required', mock: false };
  try {
    const response = await fetchWithTimeout(`${env.RETELL_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${env.RETELL_API_KEY}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }, init.timeoutMs ?? env.RETELL_DEPLOY_TIMEOUT_MS);
    if (!response.ok) return { ok: false, error: mapRetellProviderStatus(response.status), status: response.status, mock: false };
    // Bodies are parsed for ids/versions only and are never logged: they can
    // carry prompt text and provider account details.
    const body = await response.json().catch(() => null) as unknown;
    const parsed = record(body);
    if (!parsed) {
      // Some mutation endpoints answer 200/204 with an empty body.
      if (response.status === 204 || response.status === 200) return { ok: true, value: {}, mock: false };
      return { ok: false, error: 'invalid_response', status: response.status, mock: false };
    }
    return { ok: true, value: parsed, mock: false };
  } catch {
    return { ok: false, error: 'provider_unavailable', mock: false };
  }
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
  /** Provider-enforced upper bound for an attended live-test call. */
  maxCallDurationMs?: number;
}
export type CreatePhoneCallResult =
  | { ok: true; callId: string; mock: boolean }
  | { ok: false; error: string; acceptance: 'rejected' | 'unknown'; callId?: string; providerStopApplied?: boolean; providerStopError?: string };

function providerReachableWebhookUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return null;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return null;
    const private172 = host.match(/^172\.(\d{1,3})\./);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return null;
    return url.toString();
  } catch {
    return null;
  }
}

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
  if (!status.configured) return { ok: false, error: 'setup_required', acceptance: 'rejected' };
  if (!input.agentId || !Number.isSafeInteger(input.agentVersion) || input.agentVersion < 0) {
    return { ok: false, error: 'agent_setup_required', acceptance: 'rejected' };
  }

  // Mock path: returns a synthetic call id without any network call. Only when
  // the key is explicitly a mock key — real keys always hit the real API.
  if (status.mock) {
    return { ok: true, callId: `mock_call_${randomUUID().replace(/-/g, '').slice(0, 16)}`, mock: true };
  }

  try {
    const providerWebhookUrl = providerReachableWebhookUrl(input.webhookUrl);
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
            ...(providerWebhookUrl
              ? { webhook_url: providerWebhookUrl, webhook_events: ['call_started', 'call_ended', 'call_analyzed'] }
              : {}),
            data_storage_setting: input.dataStorageSetting ?? 'basic_attributes_only',
            opt_in_signed_url: true,
            ...(input.maxCallDurationMs ? { max_call_duration_ms: input.maxCallDurationMs } : {}),
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
    if (!response.ok) {
      // Only responses that definitively reject the request before call creation
      // are safe to expose as retryable. Timeouts, conflicts, throttling and
      // server errors can occur after receipt and therefore require provider
      // reconciliation instead of an automatic redial.
      const acceptance = [400, 401, 403, 404, 422].includes(response.status) ? 'rejected' : 'unknown';
      return { ok: false, error: `retell_error_${response.status}`, acceptance };
    }
    const callId = body?.call_id ?? body?.callId;
    if (!callId) return { ok: false, error: 'retell_no_call_id', acceptance: 'unknown' };
    if (body?.agent_id !== input.agentId || body?.agent_version !== input.agentVersion) {
      const stopped = await stopPhoneCall(callId);
      return {
        ok: false,
        error: 'retell_deployment_mismatch',
        acceptance: stopped.ok && stopped.applied ? 'rejected' : 'unknown',
        callId,
        providerStopApplied: stopped.ok && stopped.applied,
        ...(!stopped.ok ? { providerStopError: stopped.error } : {}),
      };
    }
    return { ok: true, callId, mock: false };
  } catch {
    return { ok: false, error: 'retell_request_failed', acceptance: 'unknown' };
  }
}


export type RetellCallStatus = 'registered' | 'not_connected' | 'ongoing' | 'ended' | 'error' | 'unknown';

export interface RetellCallSnapshot {
  callId: string;
  status: RetellCallStatus;
  agentId: string | null;
  agentVersion: number | null;
  direction: string | null;
  startTimestamp: number | null;
  endTimestamp: number | null;
  durationMs: number;
  disconnectionReason: string | null;
  metadata: Record<string, unknown>;
  combinedCostNativeUnits: number | null;
  mock: boolean;
}

export type GetPhoneCallResult =
  | { ok: true; call: RetellCallSnapshot }
  | { ok: false; error: string };

/**
 * Read provider lifecycle metadata without returning transcript, recording,
 * caller number, or free-text analysis. This is the privacy-safe polling
 * fallback for an attended synthetic UAT when a public signed webhook is not
 * yet available.
 */
export async function getPhoneCall(callId: string): Promise<GetPhoneCallResult> {
  const status = retellConfigStatus();
  if (!status.configured) return { ok: false, error: 'setup_required' };
  if (!callId.trim()) return { ok: false, error: 'call_id_required' };
  if (status.mock) {
    return {
      ok: true,
      call: {
        callId,
        status: 'ended',
        agentId: null,
        agentVersion: null,
        direction: 'outbound',
        startTimestamp: null,
        endTimestamp: null,
        durationMs: 0,
        disconnectionReason: 'mock',
        metadata: {},
        combinedCostNativeUnits: 0,
        mock: true,
      },
    };
  }
  try {
    const response = await fetchWithTimeout(`${env.RETELL_BASE_URL}/v2/get-call/${encodeURIComponent(callId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` },
    });
    if (!response.ok) return { ok: false, error: `retell_error_${response.status}` };
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return { ok: false, error: 'retell_invalid_response' };
    const providerCallId = typeof body.call_id === 'string' ? body.call_id : '';
    if (!providerCallId || providerCallId !== callId) return { ok: false, error: 'retell_call_id_mismatch' };
    const rawStatus = typeof body.call_status === 'string' ? body.call_status.toLowerCase() : 'unknown';
    const knownStatuses: RetellCallStatus[] = ['registered', 'not_connected', 'ongoing', 'ended', 'error'];
    const normalizedStatus: RetellCallStatus = knownStatuses.includes(rawStatus as RetellCallStatus)
      ? rawStatus as RetellCallStatus
      : 'unknown';
    const callCost = body.call_cost && typeof body.call_cost === 'object' && !Array.isArray(body.call_cost)
      ? body.call_cost as Record<string, unknown>
      : {};
    return {
      ok: true,
      call: {
        callId: providerCallId,
        status: normalizedStatus,
        agentId: typeof body.agent_id === 'string' ? body.agent_id : null,
        agentVersion: typeof body.agent_version === 'number' && Number.isSafeInteger(body.agent_version) ? body.agent_version : null,
        direction: typeof body.direction === 'string' ? body.direction : null,
        startTimestamp: typeof body.start_timestamp === 'number' ? body.start_timestamp : null,
        endTimestamp: typeof body.end_timestamp === 'number' ? body.end_timestamp : null,
        durationMs: typeof body.duration_ms === 'number' && body.duration_ms >= 0 ? Math.round(body.duration_ms) : 0,
        disconnectionReason: typeof body.disconnection_reason === 'string' ? body.disconnection_reason.slice(0, 160) : null,
        metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? body.metadata as Record<string, unknown>
          : {},
        combinedCostNativeUnits: typeof callCost.combined_cost === 'number' ? callCost.combined_cost : null,
        mock: false,
      },
    };
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
  /** Hash of the response engine's general prompt (retell-llm only); null when the engine body was unavailable or is a conversation flow. */
  promptHash: string | null;
  beginMessageHash: string | null;
  /** Order-independent fingerprint of the engine's reachable tools (retell-llm only). */
  toolsFingerprint: string | null;
  mock: boolean;
}

export type RetellAgentProbeError =
  | 'setup_required'
  | 'unauthorized'
  | 'not_found'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'tag_dynamic_variables_not_empty';

export type RetellAgentProbeResult =
  | { ok: true; snapshot: RetellAgentSnapshot }
  | { ok: false; error: RetellAgentProbeError };

/**
 * Deployment evidence the mock provider answers from. It is resolved by the
 * caller inside its own tenant context (the provider client never touches the
 * database) and is ignored entirely when a real key is configured.
 */
export interface MockDeploymentSnapshot {
  providerAgentId: string;
  providerAgentVersion: number;
  providerLlmId: string;
  providerLlmVersion: number;
  providerVersionTag: string;
  promptHash: string;
  beginMessageHash: string;
  toolFingerprint: string;
  voiceId: string;
  language: string;
  toolsJson: unknown;
}

export interface RetellAgentProbeOptions {
  /** Pin the probe to an exact published version instead of a tag (deployments made by CareCommand). */
  pinnedVersion?: number | null;
  /** Mock-mode evidence; see MockDeploymentSnapshot. */
  mockDeployment?: MockDeploymentSnapshot | null;
  timeoutMs?: number;
}

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

function emptyProviderDynamicVariables(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  const values = record(value);
  return values && Object.keys(values).length === 0 ? {} : null;
}

function containsProviderTemplateSyntax(value: unknown): boolean {
  if (typeof value === 'string') return /\{\{[^{}]+\}\}|\$\{[^{}]+\}/.test(value);
  if (Array.isArray(value)) return value.some(containsProviderTemplateSyntax);
  const valueRecord = record(value);
  return valueRecord ? Object.values(valueRecord).some(containsProviderTemplateSyntax) : false;
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
      // Retell local components are array entries whose required `name` is the
      // identity referenced by a component node's `component_id`.
      const id = nonEmptyString(component?.name);
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
    } else {
      if (!name || componentNames.has(name)) return null;
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

type BookToolProbe = {
  status: 'SUCCEEDED' | 'UNAVAILABLE' | 'UNSUPPORTED';
  schema: Record<string, unknown> | null;
  fingerprint: string | null;
  strictMode: boolean | null;
  graphFingerprint: string | null;
  promptHash: string | null;
  beginMessageHash: string | null;
  toolsFingerprint: string | null;
};

function bookToolProbeFailure(status: 'UNAVAILABLE' | 'UNSUPPORTED'): BookToolProbe {
  return { status, schema: null, fingerprint: null, strictMode: null, graphFingerprint: null, promptHash: null, beginMessageHash: null, toolsFingerprint: null };
}

async function probeRetellBookTool(
  responseEngineType: string,
  responseEngineId: string,
  responseEngineVersion: number | null,
  timeoutMs?: number,
): Promise<BookToolProbe> {
  if (!['retell-llm', 'conversation-flow'].includes(responseEngineType) || responseEngineVersion === null) {
    return bookToolProbeFailure('UNSUPPORTED');
  }
  try {
    const endpoint = responseEngineType === 'retell-llm' ? 'get-retell-llm' : 'get-conversation-flow';
    const response = await fetchWithTimeout(
      `${env.RETELL_BASE_URL}/${endpoint}/${encodeURIComponent(responseEngineId)}?version=${responseEngineVersion}`,
      { headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` } },
      timeoutMs,
    );
    if (!response.ok) return bookToolProbeFailure('UNAVAILABLE');
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const resolvedId = responseEngineType === 'retell-llm'
      ? nonEmptyString(body?.llm_id)
      : nonEmptyString(body?.conversation_flow_id);
    if (!body || resolvedId !== responseEngineId || nonNegativeInteger(body.version) !== responseEngineVersion) {
      return bookToolProbeFailure('UNAVAILABLE');
    }
    const graphFingerprint = fingerprintJson(body);
    // Prompt/tool evidence comes from the same body the booking tool is read
    // from, so drift detection costs no extra provider call. Conversation
    // flows have no single prompt; they stay BYO-only and report nulls.
    const isLlm = responseEngineType === 'retell-llm';
    const promptHash = isLlm ? hashPrompt(typeof body.general_prompt === 'string' ? body.general_prompt : '') : null;
    const beginMessageHash = isLlm ? hashPrompt(typeof body.begin_message === 'string' ? body.begin_message : '') : null;
    const reachableTools = isLlm ? reachableRetellLlmTools(body) : null;
    const toolsFingerprint = isLlm && reachableTools ? fingerprintTools(reachableTools) : null;
    const evidence = { graphFingerprint, promptHash, beginMessageHash, toolsFingerprint };
    if (containsProviderTemplateSyntax(body) || !emptyProviderDynamicVariables(body.default_dynamic_variables)) {
      return { status: 'SUCCEEDED', schema: null, fingerprint: null, strictMode: null, ...evidence };
    }
    const discovery = isLlm
      ? { tools: reachableTools }
      : reachableConversationFlowTools(body);
    if (!discovery || !discovery.tools) return { status: 'SUCCEEDED', schema: null, fingerprint: null, strictMode: null, ...evidence };
    const tools = discovery.tools;
    const bookingTools = tools.filter(tool => tool && typeof tool === 'object' && nonEmptyString((tool as Record<string, unknown>).name) === 'book_appointment') as Array<Record<string, unknown>>;
    const contract = bookingTools.length === 1 ? normalizeBookAppointmentToolContract(bookingTools[0]) : null;
    const strictMode = body.tool_call_strict_mode === true;
    // Retell LLM has its own publication flag. Conversation Flow does not;
    // production publication is enforced on the exact agent tag/version.
    const published = responseEngineType === 'conversation-flow' || body.is_published === true;
    if (!published || !contract) {
      return { status: 'SUCCEEDED', schema: null, fingerprint: null, strictMode: null, ...evidence };
    }
    return {
      status: 'SUCCEEDED',
      schema: contract as unknown as Record<string, unknown>,
      fingerprint: fingerprintJson({
        tool: contract,
        engine: { type: responseEngineType, id: responseEngineId, version: responseEngineVersion, graphFingerprint },
      }),
      strictMode,
      ...evidence,
    };
  } catch {
    return bookToolProbeFailure('UNAVAILABLE');
  }
}

async function probeRetellEmptyTagDefaults(
  agentId: string,
  versionTag: string,
  expectedVersion: number,
  assignedTags: string[],
  options: { pinned: boolean; timeoutMs?: number },
): Promise<{ ok: true; dynamicVariables: Record<string, string> } | { ok: false; error: RetellAgentProbeError }> {
  let paginationKey: string | null = null;
  let legacyEndpoint = false;
  const seenPaginationKeys = new Set<string>();
  const exactItems: Record<string, unknown>[] = [];
  for (let page = 0; page < 25; page += 1) {
    const buildUrl = (legacy: boolean) => {
      const url = new URL(`${env.RETELL_BASE_URL}/${legacy ? 'list-agents' : 'v2/list-agents'}`);
      url.searchParams.set('limit', '100');
      if (!legacy) url.searchParams.set('sort_order', 'descending');
      if (paginationKey) url.searchParams.set('pagination_key', paginationKey);
      return url;
    };
    const requestList = (legacy: boolean) => fetchWithTimeout(buildUrl(legacy).toString(), legacy
      ? { headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` } }
      : {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RETELL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter_criteria: {
            channel: { type: 'string', op: 'eq', value: 'voice' },
            query: agentId,
          },
        }),
      }, options.timeoutMs);
    let response: Response;
    try {
      response = await requestList(legacyEndpoint);
      if (!legacyEndpoint && response.status === 404) {
        legacyEndpoint = true;
        paginationKey = null;
        seenPaginationKeys.clear();
        response = await requestList(true);
      }
    } catch {
      return { ok: false, error: 'provider_unavailable' };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, error: 'unauthorized' };
    if (response.status === 400 || response.status === 422) return { ok: false, error: 'invalid_request' };
    if (!response.ok) return { ok: false, error: 'provider_unavailable' };
    const body = await response.json().catch(() => null) as unknown;
    const bodyRecord = record(body);
    const items = Array.isArray(body) ? body : bodyRecord?.items;
    if (!Array.isArray(items)) return { ok: false, error: 'invalid_response' };
    for (const itemValue of items) {
      const item = record(itemValue);
      const listedAgentId = nonEmptyString(item?.agent_id);
      if (!item || !listedAgentId) return { ok: false, error: 'invalid_response' };
      if (listedAgentId === agentId) exactItems.push(item);
    }
    if (Array.isArray(body)) break;
    if (bodyRecord?.has_more !== true) break;
    const nextKey = nonEmptyString(bodyRecord.pagination_key);
    if (!nextKey || seenPaginationKeys.has(nextKey)) return { ok: false, error: 'invalid_response' };
    seenPaginationKeys.add(nextKey);
    paginationKey = nextKey;
    if (page === 24) return { ok: false, error: 'invalid_response' };
  }
  if (exactItems.length !== 1) return { ok: false, error: exactItems.length ? 'invalid_response' : 'not_found' };
  const tags = record(exactItems[0]!.tags);
  if (!tags) return { ok: false, error: 'invalid_response' };
  // Only the requested tag and any alias tag that points at the same version
  // are executable for this deployment; sibling tags (a `staging` with
  // defaults, say) are ignored. Malformed tag metadata is still a hard
  // invalid_response; non-empty defaults on the requested version are a
  // specific, fixable error.
  for (const [tagName, metadataValue] of Object.entries(tags)) {
    const metadata = record(metadataValue);
    if (!nonEmptyString(tagName) || !metadata) return { ok: false, error: 'invalid_response' };
    const version = nonNegativeInteger(metadata.version);
    if (version === null) return { ok: false, error: 'invalid_response' };
    const relevant = tagName === versionTag || version === expectedVersion;
    if (!relevant) continue;
    if (metadata.dynamic_variables !== undefined && metadata.dynamic_variables !== null && record(metadata.dynamic_variables) === null) {
      return { ok: false, error: 'invalid_response' };
    }
    if (!emptyProviderDynamicVariables(metadata.dynamic_variables)) return { ok: false, error: 'tag_dynamic_variables_not_empty' };
  }
  for (const assignedTag of assignedTags) {
    const metadata = record(tags[assignedTag]);
    if (!metadata || nonNegativeInteger(metadata.version) !== expectedVersion) return { ok: false, error: 'invalid_response' };
  }
  // A CareCommand deployment is pinned by numeric version (Retell exposes no
  // public tag-assignment write), so the tag is not required to exist.
  if (!options.pinned && nonNegativeInteger(record(tags[versionTag])?.version) !== expectedVersion) return { ok: false, error: 'invalid_response' };
  return { ok: true, dynamicVariables: {} };
}

/**
 * Read-only Retell deployment probe. It never returns raw provider text and it
 * never falls back from the requested tag to an unverified "latest" version.
 */
export async function probeRetellAgent(agentId: string, versionTag: string, options: RetellAgentProbeOptions = {}): Promise<RetellAgentProbeResult> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required' };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId) || !isValidRetellVersionTag(versionTag)) {
    return { ok: false, error: 'invalid_response' };
  }
  if (env.RETELL_API_KEY.startsWith('mock')) {
    // The fixture answers only from a deployment CareCommand itself made; a
    // manually linked agent under a mock key is honestly unverifiable.
    const deployment = options.mockDeployment;
    if (!deployment || deployment.providerAgentId !== agentId) return { ok: false, error: 'not_found' };
    return { ok: true, snapshot: buildMockAgentSnapshot({ agentId, versionTag, deployment, webhookUrl: expectedRetellAgentWebhookUrl() }) };
  }
  const pinnedVersion = typeof options.pinnedVersion === 'number' && Number.isSafeInteger(options.pinnedVersion) && options.pinnedVersion >= 0
    ? options.pinnedVersion
    : null;
  try {
    const response = await fetchWithTimeout(
      `${env.RETELL_BASE_URL}/get-agent/${encodeURIComponent(agentId)}?version=${pinnedVersion === null ? encodeURIComponent(versionTag) : pinnedVersion}`,
      { headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` } },
      options.timeoutMs,
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
    if (pinnedVersion !== null && version !== pinnedVersion) return { ok: false, error: 'invalid_response' };
    const tagDefaults = await probeRetellEmptyTagDefaults(agentId, versionTag, version, assignedTags, { pinned: pinnedVersion !== null, timeoutMs: options.timeoutMs });
    if (!tagDefaults.ok) return tagDefaults;
    const effectiveDynamicVariables = tagDefaults.dynamicVariables;
    const responseEngineVersion = nonNegativeInteger(responseEngine?.version);
    const bookTool = await probeRetellBookTool(responseEngineType, responseEngineId, responseEngineVersion, options.timeoutMs);
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
        promptHash: bookTool.promptHash,
        beginMessageHash: bookTool.beginMessageHash,
        toolsFingerprint: bookTool.toolsFingerprint,
        mock: false,
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
  | 'version_mismatch'
  | 'unpublished'
  | 'webhook_mismatch'
  | 'webhook_events_mismatch'
  | 'storage_policy_mismatch'
  | 'signed_url_disabled'
  | 'prompt_drift'
  | 'tools_drift';

export interface RetellAgentReadinessRequirements {
  versionTag: string;
  webhookUrl: string;
  /** Exact version CareCommand published; replaces the tag requirement when set. */
  pinnedVersion?: number | null;
  expectedPromptHash?: string | null;
  expectedToolsFingerprint?: string | null;
}

export function evaluateRetellAgentReadiness(
  snapshot: RetellAgentSnapshot,
  requirements: RetellAgentReadinessRequirements,
): RetellAgentReadinessFailure | null {
  const pinned = typeof requirements.pinnedVersion === 'number';
  if (pinned) {
    if (snapshot.version !== requirements.pinnedVersion) return 'version_mismatch';
  } else if (!snapshot.assignedTags.includes(requirements.versionTag)) return 'tag_unassigned';
  if (!snapshot.published) return 'unpublished';
  if (snapshot.webhookUrl !== requirements.webhookUrl) return 'webhook_mismatch';
  const events = new Set(snapshot.webhookEvents);
  if (!REQUIRED_RETELL_WEBHOOK_EVENTS.every(event => events.has(event))) return 'webhook_events_mismatch';
  if (snapshot.dataStorageSetting !== RETELL_DATA_STORAGE_SETTING) return 'storage_policy_mismatch';
  if (!snapshot.signedUrl) return 'signed_url_disabled';
  // Drift is only judged when the engine body was readable; an unavailable
  // engine is reported by the intake-evidence path instead of as drift.
  if (requirements.expectedPromptHash && snapshot.promptHash !== null && snapshot.promptHash !== requirements.expectedPromptHash) return 'prompt_drift';
  if (requirements.expectedToolsFingerprint && snapshot.toolsFingerprint !== null && snapshot.toolsFingerprint !== requirements.expectedToolsFingerprint) return 'tools_drift';
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

// ===========================================================================
// Deployment client. Every function below is a thin, body-free mapping over
// the public Retell API; the mock key routes to the fixture in
// receptionist/retellMock.ts and a real key never touches it.
//
// Provider facts pinned here (docs.retellai.com, 2026-08-29):
//   - create/update-retell-llm return { llm_id, version, is_published }.
//   - create-agent returns { agent_id, version, is_published }; every
//     update-agent PATCH creates a NEW draft version, so response_engine.version
//     must be set to the LLM version being deployed in the same call.
//   - Publishing is POST /publish-agent-version/{agent_id} { version }. The
//     response body is undocumented; the published version is the one we asked
//     for and verification reads it back with get-agent?version=<n>.
//   - There is no public write endpoint for version tags; deployments pin by
//     numeric version and the tag stays a BYO-only evidence path.
// ===========================================================================

export interface RetellLlmSpec {
  model?: string;
  generalPrompt: string;
  beginMessage: string;
  tools: Array<Record<string, unknown>>;
}

export interface RetellAgentSpec {
  agentName: string;
  llmId: string;
  llmVersion: number;
  voiceId: string;
  language: string;
  webhookUrl: string;
  postCallAnalysisData: Array<Record<string, unknown>>;
  maxCallDurationMs?: number;
}

function llmRequestBody(spec: RetellLlmSpec) {
  return {
    ...(spec.model ? { model: spec.model } : {}),
    general_prompt: spec.generalPrompt,
    begin_message: spec.beginMessage,
    general_tools: spec.tools,
    tool_call_strict_mode: true,
    default_dynamic_variables: {},
  };
}

function agentRequestBody(spec: RetellAgentSpec) {
  return {
    agent_name: spec.agentName,
    response_engine: { type: 'retell-llm', llm_id: spec.llmId, version: spec.llmVersion },
    voice_id: spec.voiceId,
    language: spec.language,
    webhook_url: spec.webhookUrl,
    webhook_events: [...REQUIRED_RETELL_WEBHOOK_EVENTS],
    data_storage_setting: RETELL_DATA_STORAGE_SETTING,
    opt_in_signed_url: true,
    post_call_analysis_data: spec.postCallAnalysisData,
    ...(spec.maxCallDurationMs ? { max_call_duration_ms: spec.maxCallDurationMs } : {}),
  };
}

function parseLlmResponse(value: Record<string, unknown>, expectedId?: string): RetellProviderResult<{ llmId: string; version: number }> {
  const llmId = nonEmptyString(value.llm_id);
  const version = nonNegativeInteger(value.version);
  if (!llmId || version === null || (expectedId && llmId !== expectedId)) return { ok: false, error: 'invalid_response', mock: false };
  return { ok: true, value: { llmId, version }, mock: false };
}

function parseAgentResponse(value: Record<string, unknown>, expectedId?: string): RetellProviderResult<{ agentId: string; version: number }> {
  const agentId = nonEmptyString(value.agent_id);
  const version = nonNegativeInteger(value.version);
  if (!agentId || version === null || (expectedId && agentId !== expectedId)) return { ok: false, error: 'invalid_response', mock: false };
  return { ok: true, value: { agentId, version }, mock: false };
}

export async function createRetellLlm(spec: RetellLlmSpec): Promise<RetellProviderResult<{ llmId: string; version: number }>> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required', mock: false };
  if (retellConfigStatus().mock) return mockCreateLlm();
  const result = await providerRequest('/create-retell-llm', { method: 'POST', body: llmRequestBody(spec) });
  return result.ok ? parseLlmResponse(result.value) : result;
}

export async function updateRetellLlm(llmId: string, spec: RetellLlmSpec, previousVersion = 0): Promise<RetellProviderResult<{ llmId: string; version: number }>> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required', mock: false };
  if (retellConfigStatus().mock) return mockUpdateLlm(llmId, previousVersion);
  const result = await providerRequest(`/update-retell-llm/${encodeURIComponent(llmId)}`, { method: 'PATCH', body: llmRequestBody(spec) });
  return result.ok ? parseLlmResponse(result.value, llmId) : result;
}

export async function createRetellAgent(spec: RetellAgentSpec): Promise<RetellProviderResult<{ agentId: string; version: number }>> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required', mock: false };
  if (retellConfigStatus().mock) return mockCreateAgent();
  const result = await providerRequest('/create-agent', { method: 'POST', body: agentRequestBody(spec) });
  return result.ok ? parseAgentResponse(result.value) : result;
}

export async function updateRetellAgent(agentId: string, spec: RetellAgentSpec, previousVersion = 0): Promise<RetellProviderResult<{ agentId: string; version: number }>> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required', mock: false };
  if (retellConfigStatus().mock) return mockUpdateAgent(agentId, previousVersion);
  const result = await providerRequest(`/update-agent/${encodeURIComponent(agentId)}`, { method: 'PATCH', body: agentRequestBody(spec) });
  return result.ok ? parseAgentResponse(result.value, agentId) : result;
}

/**
 * Publish one exact draft version. The response is deliberately not trusted
 * for the version number: the caller verifies `get-agent?version=<n>` next.
 */
export async function publishRetellAgent(agentId: string, version: number): Promise<RetellProviderResult<{ version: number }>> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required', mock: false };
  const status = retellConfigStatus();
  if (!Number.isSafeInteger(version) || version < 0) return { ok: false, error: 'invalid_request', mock: status.mock };
  if (status.mock) return mockPublishAgent(agentId, version);
  const result = await providerRequest(`/publish-agent-version/${encodeURIComponent(agentId)}`, { method: 'POST', body: { version } });
  return result.ok ? { ok: true, value: { version }, mock: false } : result;
}

export interface PhoneNumberBinding { phoneNumber: string; inboundAgentId: string | null; inboundAgentVersion: number | null }

function parsePhoneNumberBinding(phoneNumber: string, body: Record<string, unknown>): PhoneNumberBinding {
  const agents = Array.isArray(body.inbound_agents)
    ? body.inbound_agents.map(record).filter((item): item is Record<string, unknown> => item !== null)
    : [];
  const first = agents[0];
  return {
    phoneNumber: nonEmptyString(body.phone_number) ?? phoneNumber,
    inboundAgentId: nonEmptyString(first?.agent_id) ?? nonEmptyString(body.inbound_agent_id),
    inboundAgentVersion: nonNegativeInteger(first?.agent_version) ?? nonNegativeInteger(body.inbound_agent_version),
  };
}

/** Point the inbound side of a Retell-owned number at one exact published agent version. */
export async function updatePhoneNumberInboundAgent(
  phoneNumber: string,
  binding: { agentId: string; agentVersion: number; inboundWebhookUrl?: string },
): Promise<RetellProviderResult<PhoneNumberBinding>> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required', mock: false };
  const status = retellConfigStatus();
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) return { ok: false, error: 'invalid_request', mock: status.mock };
  if (status.mock) return { ok: true, value: { phoneNumber, inboundAgentId: binding.agentId, inboundAgentVersion: binding.agentVersion }, mock: true };
  const result = await providerRequest(`/update-phone-number/${encodeURIComponent(phoneNumber)}`, {
    method: 'PATCH',
    body: {
      inbound_agents: [{ agent_id: binding.agentId, agent_version: binding.agentVersion, weight: 1 }],
      ...(binding.inboundWebhookUrl ? { inbound_webhook_url: binding.inboundWebhookUrl } : {}),
    },
  });
  if (!result.ok) return result;
  return { ok: true, value: parsePhoneNumberBinding(phoneNumber, result.value), mock: false };
}

export async function getPhoneNumberBinding(phoneNumber: string): Promise<RetellProviderResult<PhoneNumberBinding>> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required', mock: false };
  if (retellConfigStatus().mock) return { ok: true, value: { phoneNumber, inboundAgentId: null, inboundAgentVersion: null }, mock: true };
  const result = await providerRequest(`/get-phone-number/${encodeURIComponent(phoneNumber)}`, { method: 'GET' });
  if (!result.ok) return result;
  return { ok: true, value: parsePhoneNumberBinding(phoneNumber, result.value), mock: false };
}

export interface RetellVoice {
  voiceId: string;
  name: string;
  provider: string;
  gender: string | null;
  accent: string | null;
  age: string | null;
  previewUrl: string | null;
}

export async function listRetellVoices(): Promise<RetellProviderResult<RetellVoice[]>> {
  if (!env.RETELL_API_KEY) return { ok: false, error: 'setup_required', mock: false };
  if (retellConfigStatus().mock) return { ok: true, value: mockListVoices(), mock: true };
  try {
    const response = await fetchWithTimeout(`${env.RETELL_BASE_URL}/list-voices`, {
      headers: { Authorization: `Bearer ${env.RETELL_API_KEY}` },
    }, env.RETELL_DEPLOY_TIMEOUT_MS);
    if (!response.ok) return { ok: false, error: mapRetellProviderStatus(response.status), status: response.status, mock: false };
    const body = await response.json().catch(() => null) as unknown;
    if (!Array.isArray(body)) return { ok: false, error: 'invalid_response', mock: false };
    const voices: RetellVoice[] = [];
    for (const item of body) {
      const voice = record(item);
      const voiceId = nonEmptyString(voice?.voice_id);
      if (!voice || !voiceId) continue;
      voices.push({
        voiceId,
        name: nonEmptyString(voice.voice_name) ?? voiceId,
        provider: nonEmptyString(voice.provider) ?? 'unknown',
        gender: nonEmptyString(voice.gender),
        accent: nonEmptyString(voice.accent),
        age: nonEmptyString(voice.age),
        previewUrl: nonEmptyString(voice.preview_audio_url),
      });
    }
    return { ok: true, value: voices, mock: false };
  } catch {
    return { ok: false, error: 'provider_unavailable', mock: false };
  }
}
