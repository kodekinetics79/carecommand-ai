import { useCallback } from 'react';
import { ApiError, apiRequest } from './api';
import { useResource } from '../hooks/useResource';
import { receivedData, resourceFailure, type ResourceFailure } from './resourceState';
import type { Agent, Campaign, RetellConfig, RetellStatus } from './receptionist';

/**
 * C5 — deployment & activation client.
 *
 * Every API call the deploy / readiness / activation surfaces make lives in
 * this one file, typed against the contracts frozen in the C5 design as
 * amended by the engineering review:
 *
 *   GET  /v1/receptionist/retell-status?clinicId=&campaignId=   → RetellStatusResponse
 *   POST /v1/receptionist/campaigns/:id/deploy                   → DeployResponse
 *        (200 { deployment: PUBLISHED, verification: { status: 'pending' } };
 *         the client then calls verify-provider and polls deployments/latest)
 *   GET  /v1/receptionist/campaigns/:id/deployments/latest       → Deployment | null
 *   GET  /v1/receptionist/campaigns/:id/deployment-diff          → DeploymentDiff (chips only, no line diff)
 *   GET  /v1/receptionist/campaigns/:id/readiness                → ReadinessResponse
 *   POST /v1/receptionist/campaigns/:id/activate|pause|archive   → Campaign | 409 { code, message, reasons?, campaigns? }
 *   GET  /v1/receptionist/campaigns/:id/preview                  → PreviewResponse
 *   GET  /v1/receptionist/confirmation-channels                  → ConfirmationChannels
 *   POST /v1/receptionist/agents/:id/adopt-provider-values       → Agent
 *   GET  /v1/receptionist/campaigns/:id/retell-config            → RetellConfigExport
 *   GET  /v1/receptionist/catalog                                → catalog (voices/languages/tones/campaignTypes/providerMode)
 *
 * The catalog read is a stop-gap: C2 owns `src/lib/receptionistCatalog.ts`.
 * When that file lands, `useReceptionistCatalog` below should be replaced by
 * C2's hook and `normalizeCatalog` deleted; the `CatalogView` shape consumed by
 * the editors is deliberately small so the swap is one import.
 *
 * Nothing in this file hardcodes remediation copy: blocker / readiness / 409
 * titles, actions and fix links are rendered from the server's own words.
 */

const base = '/v1/receptionist';

// --- Provider status ---------------------------------------------------------

export type ProviderMode = 'live' | 'mock' | 'unconfigured';
export type BlockerSeverity = 'blocking' | 'warning';
export type BlockerScope = 'server' | 'agent' | 'campaign' | 'clinic' | 'provider';

export interface Blocker {
  code: string;
  severity: BlockerSeverity;
  title: string;
  action: string;
  fixHref: string | null;
  scope: BlockerScope;
}

export interface VerificationView {
  status: 'UNVERIFIED' | 'VERIFIED' | 'INVALID' | null;
  expiresAt: string | null;
  expiresInMs: number | null;
  autoRenew: { enabled: boolean; lastSystemAttemptAt: string | null };
}

/** The attended live-UAT block. Only present when DEPLOYMENT_PROFILE === 'demo'. */
export type AttendedUat = RetellStatus['liveTest'];

export interface RetellStatusResponse {
  providerConfigured: boolean;
  providerMode: ProviderMode;
  agentReady: boolean;
  agentScope: { clinicId: string | null; campaignId: string | null; agentId: string | null; agentName: string | null };
  verification: VerificationView;
  blockers: Blocker[];
  attendedUat: AttendedUat | null;
  adhocTestCallsAllowed: boolean;
}

/** Either shape the `/retell-status` route may answer with while the outbound components migrate. */
export type RetellStatusLike = RetellStatus | RetellStatusResponse;

export function isRetellStatusResponse(value: RetellStatusLike): value is RetellStatusResponse {
  return 'blockers' in value && Array.isArray((value as RetellStatusResponse).blockers);
}

const LEGACY_ENV_KEYS = new Set(['RETELL_API_KEY', 'RETELL_FROM_NUMBER']);

/**
 * Maps the pre-C5 `/retell-status` body (configured / missing / checklist /
 * liveTest) onto the new shape so one card renders both. Legacy blockers carry
 * only the checklist label; the server copy arrives once the route is rewritten.
 */
export function normalizeRetellStatus(input: RetellStatusLike): RetellStatusResponse {
  if (isRetellStatusResponse(input)) return input;
  const missingEnv = input.missing.filter(key => LEGACY_ENV_KEYS.has(key));
  const blockers: Blocker[] = input.checklist
    .filter(item => !item.set && item.key !== 'LIVE_TEST_CALLS_AUTHORIZED')
    .map(item => ({
      code: item.key.toLowerCase(),
      severity: 'blocking',
      title: item.label,
      action: LEGACY_ENV_KEYS.has(item.key) ? 'Ask your CareCommand administrator to set this on the server.' : 'Link and verify a published agent in the Agent tab.',
      fixHref: null,
      scope: LEGACY_ENV_KEYS.has(item.key) ? 'server' : 'agent',
    }));
  return {
    providerConfigured: missingEnv.length === 0,
    providerMode: input.mock ? 'mock' : missingEnv.length ? 'unconfigured' : 'live',
    agentReady: input.readyAgents > 0,
    agentScope: { clinicId: null, campaignId: null, agentId: null, agentName: null },
    verification: { status: null, expiresAt: null, expiresInMs: null, autoRenew: { enabled: false, lastSystemAttemptAt: null } },
    blockers,
    attendedUat: input.liveTest?.enabled ? input.liveTest : null,
    adhocTestCallsAllowed: input.adhocTestCallsAllowed,
  };
}

export const AUTO_RENEW_RECENT_MS = 2 * 60 * 60 * 1000;

/** "19h", "45m", "2d 3h" — or "expired". */
export function formatExpiresIn(ms: number | null): string {
  if (ms === null) return 'unknown';
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

export interface VerificationLine { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' }

/**
 * The one sentence AgentEditor and RetellStatusCard both print for a verified
 * agent: expiry plus whether the re-verification worker is actually renewing.
 */
export function verificationLine(verification: VerificationView, now: number = Date.now()): VerificationLine {
  if (verification.status === 'INVALID') return { text: 'Verification failed — see the provider check below.', tone: 'error' };
  if (verification.status !== 'VERIFIED') return { text: 'Not verified yet.', tone: 'muted' };
  const expiresIn = formatExpiresIn(verification.expiresInMs);
  if (verification.expiresInMs !== null && verification.expiresInMs <= 0) {
    return { text: 'Verification expired — verify again before calls can be placed or answered.', tone: 'error' };
  }
  const last = verification.autoRenew.lastSystemAttemptAt ? Date.parse(verification.autoRenew.lastSystemAttemptAt) : Number.NaN;
  const renewing = verification.autoRenew.enabled && Number.isFinite(last) && now - last <= AUTO_RENEW_RECENT_MS;
  return renewing
    ? { text: `Verified · expires in ${expiresIn} — auto-renews`, tone: 'ok' }
    : { text: `Verified · expires in ${expiresIn} — auto-renewal is not running; verify manually before then`, tone: 'warn' };
}

// --- Deployments -------------------------------------------------------------

export type DeploymentStatus = 'PENDING' | 'PUBLISHED' | 'VERIFIED' | 'FAILED' | 'SUPERSEDED';

export interface DeploymentStep { name: string; status: 'ok' | 'failed' | 'skipped'; at: string; providerErrorCode?: string | null }

export interface Deployment {
  id: string;
  campaignId: string;
  agentId: string;
  status: DeploymentStatus;
  mock: boolean;
  /** Masked by the server (`agent_…1234`); the full id stays on the agent row. */
  providerAgentId: string | null;
  providerAgentVersion: number | null;
  providerLlmVersion: number | null;
  promptHash: string;
  toolFingerprint: string;
  intakeFingerprint: string;
  voiceId: string;
  language: string;
  steps: DeploymentStep[];
  providerErrorCode: string | null;
  startedAt: string;
  publishedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export type DeployFailureCode =
  | 'setup_required' | 'mock_forbidden_in_profile' | 'agent_unlinked_and_not_creatable' | 'agent_inactive'
  | 'engine_not_owned' | 'placeholders_present' | 'cooldown' | 'tenant_rate_limited'
  | 'provider_unauthorized' | 'provider_rate_limited' | 'provider_unavailable' | 'provider_invalid_request'
  | 'verification_failed' | 'concurrent_change';

export interface DeployResponse {
  deployment: Deployment;
  agent: Agent;
  verification: { status: 'pending' | 'verified' | 'failed'; code?: string; message?: string };
}

export type DeploymentChange = 'prompt' | 'tools' | 'intake' | 'voice' | 'language' | 'webhook' | 'beginMessage';

export interface DeploymentDiff {
  deployment: {
    id: string; status: DeploymentStatus; mock: boolean; verifiedAt: string | null; publishedAt: string | null;
    providerAgentVersion: number | null; promptHash: string; toolFingerprint: string; voiceId: string; language: string;
    providerErrorCode: string | null;
  } | null;
  draft: { promptHash: string; toolFingerprint: string; intakeFingerprint: string; voiceId: string; language: string; webhookUrl: string };
  changed: DeploymentChange[];
  toolsDiff: { added: string[]; removed: string[]; changed: string[] };
}

export type DeployPanelState =
  | 'no-agent' | 'never-deployed' | 'deploying' | 'deployed-current' | 'deployed-stale'
  | 'deploy-failed' | 'verification-failed' | 'drift-blocked';

/** Pure derivation of the DeployPanel state from what the server holds (local in-flight / error states override it). */
export function deriveDeployState(input: { status: RetellStatusResponse | null; diff: DeploymentDiff | null }): DeployPanelState {
  const agentId = input.status?.agentScope.agentId ?? null;
  const unlinked = input.status?.blockers.some(b => b.code === 'agent_unlinked') ?? false;
  if (input.status && (!agentId || unlinked)) return 'no-agent';
  const deployment = input.diff?.deployment ?? null;
  if (!deployment) return 'never-deployed';
  if (deployment.status === 'FAILED') return 'deploy-failed';
  if (deployment.status === 'PUBLISHED' && input.status?.verification.status === 'INVALID') return 'verification-failed';
  if (input.diff && input.diff.changed.length > 0) return 'deployed-stale';
  return 'deployed-current';
}

// --- Export checklist (BYO fallback) -----------------------------------------

export interface DeployChecklistItem { step: number; key: string; label: string; value: string; copyable: boolean }

export interface RetellConfigExport extends RetellConfig {
  /** Live custom-function tools; present on the server type, optional here until the route is confirmed. */
  tools?: Array<Record<string, unknown>>;
  deployChecklist?: DeployChecklistItem[];
  agentSource?: 'deployment' | 'local' | 'provider';
}

function toolName(tool: Record<string, unknown>): string {
  return typeof tool.name === 'string' ? tool.name : 'unnamed tool';
}

/**
 * The ordered manual-setup checklist. The server supplies it (`deployChecklist`)
 * with the current export route extension; until then it is derived from the
 * same config so the BYO path is never blank.
 */
export function deployChecklistOf(config: RetellConfigExport): DeployChecklistItem[] {
  if (config.deployChecklist && config.deployChecklist.length) return config.deployChecklist;
  const tools = config.tools ?? [];
  const rows: Array<Omit<DeployChecklistItem, 'step'>> = [
    { key: 'agent_language', label: 'Agent language', value: config.language, copyable: true },
    { key: 'agent_voice', label: 'Agent voice', value: config.voiceId, copyable: true },
    { key: 'begin_message', label: 'Begin message', value: config.beginMessage, copyable: true },
    { key: 'response_engine', label: 'Response engine', value: 'retell-llm · general_prompt = system prompt (copy from Preview)', copyable: false },
    { key: 'tool_call_strict_mode', label: 'Tool call strict mode', value: 'true', copyable: false },
    { key: 'tools', label: 'Custom tools', value: tools.length ? `${tools.length}: ${tools.map(toolName).join(', ')}` : 'none exported', copyable: false },
    { key: 'webhook_url', label: 'Webhook URL', value: config.webhookUrl, copyable: true },
    { key: 'webhook_events', label: 'Webhook events', value: 'call_started, call_ended, call_analyzed', copyable: true },
    { key: 'data_storage_setting', label: 'Data storage setting', value: 'basic_attributes_only', copyable: true },
    { key: 'opt_in_signed_url', label: 'Signed webhook URLs', value: 'true', copyable: false },
    { key: 'publish', label: 'Publish the agent version', value: 'Publish, then paste the agent id in the Agent tab and verify', copyable: false },
    { key: 'tag_dynamic_variables_empty', label: 'Default dynamic variables', value: 'none — CareCommand supplies every variable per call', copyable: false },
    { key: 'post_call_analysis', label: 'Post-call analysis fields', value: `${config.callOutcomeFields.length} field${config.callOutcomeFields.length === 1 ? '' : 's'}`, copyable: false },
  ];
  return rows.map((row, index) => ({ step: index + 1, ...row }));
}

// --- Readiness and actions ---------------------------------------------------

export type ReadinessKey =
  | 'agent_linked' | 'agent_verified' | 'deployment_current' | 'locale_pack_approved' | 'hours_set'
  | 'location_mapped' | 'services_bookable' | 'provider_availability' | 'intake_attested' | 'placeholders_absent'
  | 'disclosure_composed' | 'confirmation_channels' | 'offer_content' | 'test_call_completed'
  | 'transfer_target_distinct' | 'phone_number_bound' | 'data_storage_setting';

export type ReadinessStatus = 'pass' | 'fail' | 'warn' | 'pending';

export interface ReadinessCheck {
  key: ReadinessKey | string;
  label: string;
  status: ReadinessStatus;
  code: string | null;
  detail: string;
  fixHref: string | null;
}

export interface ReadinessAction { allowed: boolean; reasons: string[] }

export interface ReadinessResponse {
  campaignId: string;
  status: Campaign['status'];
  ready: boolean;
  checks: ReadinessCheck[];
  actions: { activate: ReadinessAction; pause: ReadinessAction; archive: ReadinessAction };
  evaluatedAt: string;
}

export function failingChecks(readiness: ReadinessResponse): ReadinessCheck[] {
  return readiness.checks.filter(check => check.status === 'fail' || check.status === 'pending');
}

export type GoLiveStepStatus = 'done' | 'todo' | 'warn' | 'pending';

export interface GoLiveStep {
  key: 'deploy' | 'verify' | 'forward' | 'test_call' | 'activate';
  label: string;
  detail: string;
  status: GoLiveStepStatus;
  fixHref: string | null;
}

function stepFromCheck(readiness: ReadinessResponse | null, key: ReadinessKey, label: string, todoDetail: string): GoLiveStep {
  const check = readiness?.checks.find(row => row.key === key) ?? null;
  const base: GoLiveStep = { key: 'deploy', label, detail: todoDetail, status: 'pending', fixHref: null };
  if (!check) return { ...base, detail: 'Not evaluated yet.' };
  const status: GoLiveStepStatus = check.status === 'pass' ? 'done' : check.status === 'warn' ? 'warn' : check.status === 'pending' ? 'pending' : 'todo';
  return { ...base, status, detail: check.detail || todoDetail, fixHref: check.fixHref };
}

/**
 * The ordered "Go live" steps (contract §6): deploy → verify → forward the
 * public number to the DID → test call → activate. Each reads one readiness
 * row; a row the server has not evaluated is `pending`, never assumed done.
 */
export function goLiveSteps(readiness: ReadinessResponse | null, campaignStatus: Campaign['status']): GoLiveStep[] {
  return [
    { ...stepFromCheck(readiness, 'deployment_current', 'Deploy the agent to Retell', 'Deploy from the RetellAI Export tab.'), key: 'deploy' },
    { ...stepFromCheck(readiness, 'agent_verified', 'Verify the deployment', 'Verify after deploying; verification expires and auto-renews.'), key: 'verify' },
    { ...stepFromCheck(readiness, 'phone_number_bound', 'Forward the public number to the DID', 'Bind the clinic number to the deployed agent and forward the public line to it.'), key: 'forward' },
    { ...stepFromCheck(readiness, 'test_call_completed', 'Place a test call', 'Call the line from a staff number; the call log must show it.'), key: 'test_call' },
    {
      key: 'activate',
      label: 'Activate the campaign',
      detail: campaignStatus === 'ACTIVE' ? 'The campaign is live.' : readiness?.ready ? 'Every check passes — activate below.' : 'Activate once every readiness check passes.',
      status: campaignStatus === 'ACTIVE' ? 'done' : 'todo',
      fixHref: null,
    },
  ];
}

// --- Preview -------------------------------------------------------------------

export interface PreviewTurn { speaker: 'agent' | 'caller' | 'tool'; text: string; note?: string }

export interface PreviewPlaceholder { field: string; value: string; reason: 'known_default' | 'template_syntax' | 'todo_marker' | 'too_short' }

export interface PreviewResponse {
  openingSequence: PreviewTurn[];
  inboundSample: PreviewTurn[];
  outboundSample: PreviewTurn[];
  tools: Array<{ name: string; kind: 'custom' | 'transfer'; description: string; requiresConsent: boolean }>;
  disclosure: { baseline: string; additional: string; composed: string };
  placeholders: PreviewPlaceholder[];
  agent: { name: string; voice: string; language: string; placeholder: boolean };
  systemPrompt: string;
}

// --- Confirmation channels -----------------------------------------------------

export type ChannelState = 'live' | 'mock' | 'configured_pending' | 'unconfigured';
export interface ChannelStatus { status: ChannelState; detail: string }
export interface ConfirmationChannels { sms: ChannelStatus; email: ChannelStatus }

export function channelUsable(channel: ChannelStatus | null | undefined): boolean {
  return channel?.status === 'live' || channel?.status === 'mock';
}

// --- Agents (C5 additions) -----------------------------------------------------

export interface AgentRow extends Agent {
  providerMismatch?: { voice: boolean; language: boolean } | null;
  currentDeploymentId?: string | null;
}

/** Computed from the verified snapshot when the server has not stamped `providerMismatch`. */
export function providerMismatchOf(agent: AgentRow): { voice: boolean; language: boolean } | null {
  if (agent.providerMismatch !== undefined) return agent.providerMismatch;
  if (agent.providerStatus !== 'VERIFIED') return null;
  const voice = agent.providerVoiceId !== null && agent.providerVoiceId !== agent.voice;
  const language = agent.providerLanguage !== null && agent.providerLanguage !== agent.language;
  return voice || language ? { voice, language } : null;
}

// --- Error helpers ---------------------------------------------------------------

export function retryAfterSecondsOf(error: unknown): number | null {
  if (!(error instanceof ApiError)) return null;
  const value = error.details?.retryAfterSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : error.status === 429 ? 60 : null;
}

export interface BlockedByCampaign { campaignId: string; name: string }

/** Campaigns a 409 names as blocking (drift under an ACTIVE campaign, archive with RUNNING outbound). */
export function blockedByOf(error: unknown): BlockedByCampaign[] {
  if (!(error instanceof ApiError) || !error.details) return [];
  const raw = (error.details.blockedBy ?? error.details.campaigns) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const id = typeof row.campaignId === 'string' ? row.campaignId : typeof row.id === 'string' ? row.id : null;
      const name = typeof row.name === 'string' ? row.name : id;
      return id && name ? { campaignId: id, name } : null;
    })
    .filter((row): row is BlockedByCampaign => row !== null);
}

/** Failing readiness rows a 409 `campaign_not_ready` carries. */
export function readinessReasonsOf(error: unknown): ReadinessCheck[] {
  if (!(error instanceof ApiError) || !error.details) return [];
  const raw = error.details.reasons as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is ReadinessCheck =>
    Boolean(item) && typeof item === 'object' && typeof (item as ReadinessCheck).label === 'string' && typeof (item as ReadinessCheck).detail === 'string');
}

/** The agent row a failed verify / deploy still carries, so the durable attempt state is shown. */
export function agentRowOf(error: unknown): AgentRow | null {
  if (!(error instanceof ApiError)) return null;
  const row = error.details?.agent as AgentRow | undefined;
  return row && typeof row === 'object' && typeof row.id === 'string' ? row : null;
}

// --- Catalog (stop-gap until C2's src/lib/receptionistCatalog.ts lands) ---------

export interface CatalogOption { id: string; label: string }
export interface CatalogVoice { voiceId: string; name: string; provider: string; gender: string | null; accent: string | null; previewUrl: string | null }

export interface CatalogView {
  voices: CatalogVoice[];
  languages: CatalogOption[];
  tones: CatalogOption[];
  campaignTypes: CatalogOption[];
  providerMode: ProviderMode | null;
}

function asOption(item: unknown): CatalogOption | null {
  if (typeof item === 'string') return item.trim() ? { id: item, label: item } : null;
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const id = [row.id, row.code, row.value, row.key].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (!id) return null;
  const label = [row.label, row.name, row.title].find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? id;
  return { id, label };
}

function asVoice(item: unknown): CatalogVoice | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const voiceId = [row.voiceId, row.voice_id, row.id].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (!voiceId) return null;
  const name = [row.name, row.voice_name, row.label].find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? voiceId;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return { voiceId, name, provider: str(row.provider) ?? 'unknown', gender: str(row.gender), accent: str(row.accent), previewUrl: str(row.previewUrl ?? row.preview_audio_url) };
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items)) return (value as Record<string, unknown>).items as unknown[];
  return [];
}

/** Tolerant read of `/catalog`: C2 owns the exact shape, the editors need only these four lists. */
export function normalizeCatalog(raw: unknown): CatalogView {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = root.providerMode ?? (root.provider && typeof root.provider === 'object' ? (root.provider as Record<string, unknown>).mode : root.provider);
  return {
    voices: asList(root.voices).map(asVoice).filter((v): v is CatalogVoice => v !== null),
    languages: asList(root.languages).map(asOption).filter((v): v is CatalogOption => v !== null),
    tones: asList(root.tones).map(asOption).filter((v): v is CatalogOption => v !== null),
    campaignTypes: asList(root.campaignTypes).map(asOption).filter((v): v is CatalogOption => v !== null),
    providerMode: mode === 'live' || mode === 'mock' || mode === 'unconfigured' ? mode : null,
  };
}

export function voiceLabel(voice: CatalogVoice): string {
  const traits = [voice.gender, voice.accent].filter(Boolean).join(', ');
  return traits ? `${voice.name} (${traits}) · ${voice.provider}` : `${voice.name} · ${voice.provider}`;
}

/**
 * Select options for a catalog list with the stored value merged in, so a
 * value outside the catalogue (a legacy voice, a provider-adopted language)
 * still renders and is never silently replaced by the first option.
 */
export function withCurrentOption(options: CatalogOption[], current: string): CatalogOption[] {
  const value = current.trim();
  if (!value || options.some(option => option.id === value)) return options;
  return [{ id: value, label: `${value} (not in catalog)` }, ...options];
}

const CATALOG_PATH = `${base}/catalog`;
const loadCatalog = (signal: AbortSignal) => apiRequest<unknown>(CATALOG_PATH, { signal }).then(normalizeCatalog);

export interface CatalogHookResult { catalog: CatalogView | null; failure: ResourceFailure | null; reload: () => void }

export function useReceptionistCatalog(): CatalogHookResult {
  const { state, reload } = useResource<CatalogView>(loadCatalog);
  return { catalog: receivedData(state), failure: resourceFailure(state), reload };
}

/** Stable loader for a per-campaign readiness read. */
export function useCampaignReadiness(campaignId: string) {
  const loader = useCallback((signal: AbortSignal) => deploymentApi.readiness(campaignId, signal), [campaignId]);
  return useResource<ReadinessResponse>(loader);
}

// --- Polling -------------------------------------------------------------------------

export const DEPLOYMENT_POLL_INTERVAL_MS = 1500;
export const DEPLOYMENT_POLL_MAX_ATTEMPTS = 12;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * After deploy → verify, the deployment row settles to VERIFIED or FAILED (or
 * stays PUBLISHED when verification is still pending). Polls `deployments/latest`
 * until it settles or the budget is spent; the last row seen is returned so the
 * panel can say "still pending" instead of pretending.
 */
export async function pollLatestDeployment(campaignId: string, options: { intervalMs?: number; maxAttempts?: number } = {}): Promise<Deployment | null> {
  const intervalMs = options.intervalMs ?? DEPLOYMENT_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEPLOYMENT_POLL_MAX_ATTEMPTS;
  let latest: Deployment | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    latest = await deploymentApi.latestDeployment(campaignId);
    if (latest && (latest.status === 'VERIFIED' || latest.status === 'FAILED')) return latest;
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }
  return latest;
}

// --- API -------------------------------------------------------------------------------

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const deploymentApi = {
  retellStatus: (scope: { clinicId?: string; campaignId?: string } = {}, signal?: AbortSignal) =>
    apiRequest<RetellStatusLike>(`${base}/retell-status${query(scope)}`, { signal }).then(normalizeRetellStatus),
  deploy: (campaignId: string) => apiRequest<DeployResponse>(`${base}/campaigns/${campaignId}/deploy`, { method: 'POST', body: JSON.stringify({}) }),
  latestDeployment: (campaignId: string, signal?: AbortSignal) => apiRequest<Deployment | null>(`${base}/campaigns/${campaignId}/deployments/latest`, { signal }).then(row => row ?? null),
  deploymentDiff: (campaignId: string, signal?: AbortSignal) => apiRequest<DeploymentDiff>(`${base}/campaigns/${campaignId}/deployment-diff`, { signal }),
  readiness: (campaignId: string, signal?: AbortSignal) => apiRequest<ReadinessResponse>(`${base}/campaigns/${campaignId}/readiness`, { signal }),
  activate: (campaignId: string) => apiRequest<Campaign>(`${base}/campaigns/${campaignId}/activate`, { method: 'POST', body: JSON.stringify({}) }),
  pause: (campaignId: string) => apiRequest<Campaign>(`${base}/campaigns/${campaignId}/pause`, { method: 'POST', body: JSON.stringify({}) }),
  archive: (campaignId: string) => apiRequest<Campaign>(`${base}/campaigns/${campaignId}/archive`, { method: 'POST', body: JSON.stringify({}) }),
  preview: (campaignId: string, signal?: AbortSignal) => apiRequest<PreviewResponse>(`${base}/campaigns/${campaignId}/preview`, { signal }),
  confirmationChannels: (signal?: AbortSignal) => apiRequest<ConfirmationChannels>(`${base}/confirmation-channels`, { signal }),
  adoptProviderValues: (agentId: string) => apiRequest<AgentRow>(`${base}/agents/${agentId}/adopt-provider-values`, { method: 'POST', body: JSON.stringify({}) }),
  retellConfig: (campaignId: string, signal?: AbortSignal) => apiRequest<RetellConfigExport>(`${base}/campaigns/${campaignId}/retell-config`, { signal }),
  catalog: (signal?: AbortSignal) => apiRequest<unknown>(CATALOG_PATH, { signal }).then(normalizeCatalog),
};
