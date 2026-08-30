import { useCallback } from 'react';
import { ApiError, apiRequest } from './api';
import { useResource } from '../hooks/useResource';
import { describeFailure, receivedData, resourceFailure, type ResourceFailure } from './resourceState';
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

/**
 * A deployment row as `deploymentProjection` in
 * `server/modules/receptionist/deployment.ts` actually sends it.
 *
 * The previous shape here was aspirational — it declared `campaignId`,
 * `agentId`, `createdAt` and an unmasked `providerAgentId`, none of which the
 * server sends, and omitted `numberBound` / `boundPhoneNumberMasked`, the two
 * fields the go-live path is about. Every optional field below is optional
 * because a pre-C5 server may omit it, and a missing field is rendered as
 * unknown, never as a zero or a false.
 */
export interface Deployment {
  id: string;
  status: DeploymentStatus;
  mock: boolean;
  /** Masked by the server (`agen…1234`); the full id stays on the agent row. */
  providerAgentIdMasked: string | null;
  providerAgentVersion: number | null;
  providerLlmVersion: number | null;
  providerVersionTag?: string;
  promptHash: string;
  toolFingerprint: string;
  intakeFingerprint: string;
  configFingerprint?: string;
  voiceId: string;
  language: string;
  steps: DeploymentStep[];
  providerErrorCode: string | null;
  /** Whether the provider number answers with this deployment. */
  numberBound?: boolean;
  /** Masked (`+1 ••• ••• 0142`) — never dial from this; the readiness row carries the dialable number. */
  boundPhoneNumberMasked?: string | null;
  deployedBySource?: string;
  startedAt: string;
  publishedAt: string | null;
  verifiedAt: string | null;
}

function asDeploymentSteps(value: unknown): DeploymentStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    return typeof row.name === 'string'
      ? [{
        name: row.name,
        status: row.status === 'ok' || row.status === 'failed' ? row.status : 'skipped',
        at: typeof row.at === 'string' ? row.at : '',
        providerErrorCode: typeof row.providerErrorCode === 'string' ? row.providerErrorCode : null,
      }]
      : [];
  });
}

/**
 * `GET /deployments/latest` answers `{ deployment: … | null }`, not the row.
 * Reading the envelope as the row is why `pollLatestDeployment` never settled
 * (it compared `undefined` to 'VERIFIED', so every deploy spent its whole
 * 18-second budget) and why the verification-failed panel threw on
 * `latest.status.toLowerCase()`. Unwrap either shape, and drop anything that
 * is not a row.
 */
export function unwrapDeployment(raw: unknown): Deployment | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const row = ('deployment' in root ? root.deployment : root) as Record<string, unknown> | null;
  if (!row || typeof row !== 'object' || typeof row.id !== 'string') return null;
  return { ...(row as unknown as Deployment), steps: asDeploymentSteps(row.steps) };
}

export type DeployFailureCode =
  | 'setup_required' | 'mock_forbidden_in_profile' | 'agent_unlinked_and_not_creatable' | 'agent_inactive'
  | 'engine_not_owned' | 'placeholders_present' | 'cooldown' | 'tenant_rate_limited'
  | 'provider_unauthorized' | 'provider_rate_limited' | 'provider_unavailable' | 'provider_invalid_request'
  | 'verification_failed' | 'concurrent_change';

export interface DeployResponse {
  deployment: Deployment | null;
  /** The route does not send the agent row today; the panel keeps the id it already knew. */
  agent?: Agent;
  verification: { status: 'pending' | 'verified' | 'failed'; code?: string; message?: string };
  message?: string;
}

export type DeploymentChange = 'prompt' | 'tools' | 'intake' | 'voice' | 'language' | 'webhook' | 'beginMessage';

export interface ToolsDiff { added: string[]; removed: string[]; changed: string[] }

export interface DeploymentDiff {
  deployment: {
    id: string; status: DeploymentStatus; verifiedAt: string | null;
    providerAgentVersion: number | null; promptHash: string; toolFingerprint: string; voiceId: string; language: string;
    mock?: boolean; publishedAt?: string | null; providerErrorCode?: string | null;
  } | null;
  draft: { promptHash: string; toolFingerprint: string; intakeFingerprint: string; voiceId: string; language: string; webhookUrl: string; toolNames?: string[] };
  changed: DeploymentChange[];
  /**
   * The route sends `changed` and `placeholders`, not a tools diff. It is
   * normalised to an empty diff rather than left undefined, because the panel
   * used to read `.added.length` off it and threw the moment a draft went
   * stale — the exact state an operator is in when they need this screen.
   */
  toolsDiff: ToolsDiff;
  placeholders?: PreviewPlaceholder[];
}

const EMPTY_TOOLS_DIFF: ToolsDiff = { added: [], removed: [], changed: [] };

function asToolsDiff(value: unknown): ToolsDiff {
  if (!value || typeof value !== 'object') return EMPTY_TOOLS_DIFF;
  const row = value as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : []);
  return { added: list(row.added), removed: list(row.removed), changed: list(row.changed) };
}

export function normalizeDeploymentDiff(raw: unknown): DeploymentDiff {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ...(root as unknown as DeploymentDiff),
    changed: Array.isArray(root.changed) ? (root.changed as DeploymentChange[]) : [],
    toolsDiff: asToolsDiff(root.toolsDiff),
  };
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

// --- Studio tabs: the client half of the server's `fixTab` map -----------------

/**
 * Every tab id `/receptionist-studio` accepts. It lives here, beside the
 * readiness keys, because it is a contract with the server rather than a
 * detail of the page: `remediation.ts` writes `fixTab` into 54 fix links, and
 * 33 of them named ids the page did not have (`deploy` × 25, `agent` × 8).
 * Those links landed on Clinic Profile at the exact moment the operator was
 * stuck on a deployment.
 *
 * The page moved rather than the catalogue: the deploy tab is now `deploy`
 * ("Go live"), which is what the operator is doing there and what the server
 * has always called it. `retell` — the id it shipped with — and `agent` are
 * kept as aliases so no printed link and no server entry breaks either way.
 */
export const STUDIO_TAB_IDS = ['clinic', 'knowledge', 'campaign', 'intake', 'preview', 'deploy', 'outbound', 'activity'] as const;

export type StudioTab = (typeof STUDIO_TAB_IDS)[number];

const STUDIO_TAB_ALIASES: Record<string, StudioTab> = {
  retell: 'deploy',
  'go-live': 'deploy',
  golive: 'deploy',
  agent: 'campaign',
};

export function isStudioTab(value: string | null | undefined): value is StudioTab {
  return typeof value === 'string' && (STUDIO_TAB_IDS as readonly string[]).includes(value);
}

/** The tab a `?tab=` value opens, or null when nothing defines it — never a guess. */
export function resolveStudioTab(value: string | null | undefined): StudioTab | null {
  if (!value) return null;
  if (isStudioTab(value)) return value;
  return STUDIO_TAB_ALIASES[value] ?? null;
}

// --- Readiness and actions ---------------------------------------------------

/**
 * The readiness rows the server emits, in its own order.
 *
 * This list is the client half of a contract: it must equal the keys of
 * `LABELS` in `server/lib/receptionist/campaignReadiness.ts`, and
 * `receptionistDeployment.contract.test.ts` reads that file and asserts it.
 * The go-live card used to look for `phone_number_bound` — a key the server
 * has never emitted — so the one step that proves a caller can reach the line
 * ("forward the public number to the DID") could never leave "Not evaluated
 * yet." and could never offer a Fix link. Nothing here may be invented: a key
 * the server does not emit is a step that silently never evaluates.
 */
export const READINESS_KEYS = [
  // Checklist order, and it must equal the server's LABELS keys exactly —
  // src/lib/receptionistDeployment.test.ts reads campaignReadiness.ts and
  // asserts set equality, which is how the 14-vs-19 drift was caught.
  'clinic_country_set',
  'clinic_hours_set',
  'locale_pack_approved',
  'agent_language_supported',
  'agent_linked',
  'agent_verified',
  'deployment_current',
  'number_bound',
  'location_mapped',
  'services_bookable',
  'provider_availability',
  'provider_resolvable',
  'intake_attested',
  'placeholders_absent',
  'disclosure_composed',
  'closing_disclosure_present',
  'emergency_path_reachable',
  'confirmation_channels',
  'transfer_target_distinct',
  'test_call_completed',
  'data_storage_setting',
] as const;

export type ReadinessKey = (typeof READINESS_KEYS)[number];

export type ReadinessStatus = 'pass' | 'fail' | 'warn' | 'pending';

export interface ReadinessCheck {
  /** A key outside `READINESS_KEYS` still renders: the server owns this list, and a row we do not recognise is shown, never dropped. */
  key: ReadinessKey | (string & {});
  label: string;
  status: ReadinessStatus;
  code: string | null;
  /** The remediation title for a failing row; equals `label` when it passed. Absent on a pre-C5 server. */
  title?: string;
  detail: string;
  fixHref: string | null;
}

export interface ReadinessAction { allowed: boolean; reasons: string[] }

export interface ReadinessResponse {
  campaignId: string;
  status: Campaign['status'];
  ready: boolean;
  /** Present since C5; absent from a pre-C5 server, in which case the badge is simply not shown. */
  providerMode?: ProviderMode;
  checks: ReadinessCheck[];
  actions: { activate: ReadinessAction; pause: ReadinessAction; archive: ReadinessAction };
  evaluatedAt: string;
}

export function checkFor(readiness: ReadinessResponse | null, key: ReadinessKey): ReadinessCheck | null {
  return readiness?.checks.find(row => row.key === key) ?? null;
}

export function failingChecks(readiness: ReadinessResponse): ReadinessCheck[] {
  return readiness.checks.filter(check => check.status === 'fail' || check.status === 'pending');
}

export type GoLiveStepStatus = 'done' | 'todo' | 'warn' | 'pending';

export type GoLiveStepKey = 'deploy' | 'verify' | 'forward' | 'test_call' | 'activate';

export interface GoLiveStep {
  key: GoLiveStepKey;
  label: string;
  /** The remediation title the server wrote for a failing row, when it sent one. */
  title: string | null;
  detail: string;
  status: GoLiveStepStatus;
  fixHref: string | null;
}

function stepFromCheck(readiness: ReadinessResponse | null, key: ReadinessKey, stepKey: GoLiveStepKey, label: string, todoDetail: string): GoLiveStep {
  const check = checkFor(readiness, key);
  const base: GoLiveStep = { key: stepKey, label, title: null, detail: todoDetail, status: 'pending', fixHref: null };
  // No row means the server did not evaluate this step. Saying so is the
  // whole point: a step nobody evaluated must never read as done.
  if (!check) return { ...base, detail: readiness ? `The server did not report “${key}”, so this step is unproven.` : 'Not evaluated yet.' };
  const status: GoLiveStepStatus = check.status === 'pass' ? 'done' : check.status === 'warn' ? 'warn' : check.status === 'pending' ? 'pending' : 'todo';
  return { ...base, status, title: check.status === 'pass' ? null : check.title ?? null, detail: check.detail || todoDetail, fixHref: check.fixHref };
}

/**
 * The ordered "Go live" steps (contract §6): deploy → verify → forward the
 * public number to the DID → test call → activate. Each reads one readiness
 * row; a row the server has not evaluated is `pending`, never assumed done.
 */
export function goLiveSteps(readiness: ReadinessResponse | null, campaignStatus: Campaign['status']): GoLiveStep[] {
  return [
    stepFromCheck(readiness, 'deployment_current', 'deploy', 'Deploy the agent to Retell', 'Deploy from the Go live tab.'),
    stepFromCheck(readiness, 'agent_verified', 'verify', 'Verify the deployment', 'Verify after deploying; verification expires and auto-renews.'),
    stepFromCheck(readiness, 'number_bound', 'forward', 'Forward the public number to the DID', 'Bind the clinic number to the deployed agent and forward the public line to it.'),
    stepFromCheck(readiness, 'test_call_completed', 'test_call', 'Place a test call', 'Call the line from a staff number; the call log must show it.'),
    {
      key: 'activate',
      label: 'Activate the campaign',
      title: null,
      detail: campaignStatus === 'ACTIVE' ? 'The campaign is live.' : readiness?.ready ? 'Every check passes — activate below.' : 'Activate once every readiness check passes.',
      status: campaignStatus === 'ACTIVE' ? 'done' : 'todo',
      fixHref: null,
    },
  ];
}

/**
 * The dialable number, taken only from the passing `number_bound` row, which
 * is the one place the server states it in full (the deployment projection
 * masks it, and a masked number cannot be dialled or forwarded). Anything
 * that is not an unambiguous E.164 number yields null, and the rail then says
 * the number is not confirmed rather than printing a guess.
 *
 * TODO(Package A/B): send it as a field — `readiness.boundNumber`, or
 * `boundPhoneNumber` on the deployment for roles allowed to see it — so this
 * stops depending on the wording of a sentence.
 */
export function boundNumberOf(readiness: ReadinessResponse | null): string | null {
  const check = checkFor(readiness, 'number_bound');
  if (!check || check.status !== 'pass') return null;
  const match = /\+[1-9]\d{6,14}/.exec(check.detail);
  return match ? match[0] : null;
}

/** A clinic-level prerequisite (country, hours, locale pack) promoted onto the rail. */
export interface GoLivePrerequisite { code: string; label: string; fixHref: string | null }

export interface GoLiveRail {
  steps: GoLiveStep[];
  prerequisites: GoLivePrerequisite[];
  done: number;
  total: number;
  /** The one thing to do next — a prerequisite first, then the first unfinished step. */
  next: { label: string; detail: string; fixHref: string | null } | null;
  boundNumber: string | null;
}

export function goLiveRail(input: {
  readiness: ReadinessResponse | null;
  campaignStatus: Campaign['status'];
  prerequisites?: GoLivePrerequisite[];
}): GoLiveRail {
  const steps = goLiveSteps(input.readiness, input.campaignStatus);
  const prerequisites = input.prerequisites ?? [];
  const done = steps.filter(step => step.status === 'done' || step.status === 'warn').length;
  const blockedStep = steps.find(step => step.status !== 'done' && step.status !== 'warn') ?? null;
  const next = prerequisites.length
    ? { label: prerequisites[0].label, detail: 'Finish the clinic profile before the receptionist can go live.', fixHref: prerequisites[0].fixHref }
    : blockedStep
      ? { label: blockedStep.title ?? blockedStep.label, detail: blockedStep.detail, fixHref: blockedStep.fixHref }
      : null;
  return { steps, prerequisites, done, total: steps.length, next, boundNumber: boundNumberOf(input.readiness) };
}

// --- Service status (SF-3) -----------------------------------------------------

export type ServiceState = 'answering' | 'degraded' | 'not_answering' | 'unknown';

export interface ServiceStatus {
  state: ServiceState;
  /** Short enough to sit on one always-visible line. */
  headline: string;
  detail: string;
  action: string | null;
  fixHref: string | null;
}

/** Verification this close to lapsing is worth saying out loud before it does. */
export const VERIFICATION_WARN_MS = 4 * 60 * 60 * 1000;

const SERVICE_BLOCKING_KEYS: ReadinessKey[] = ['agent_linked', 'agent_verified', 'deployment_current', 'number_bound'];

/**
 * One always-visible sentence: is this clinic's receptionist answering right
 * now, and if not, what is the next click. Derived only from what the server
 * reported — a state it did not report is `unknown`, never `answering`.
 */
export function serviceStatus(input: {
  campaignStatus: Campaign['status'];
  readiness: ReadinessResponse | null;
  verification?: VerificationView | null;
  /** A deploy is in flight right now: the provider is mid-swap. */
  deploying?: boolean;
}): ServiceStatus {
  const { campaignStatus, readiness, verification = null, deploying = false } = input;

  if (deploying) {
    return {
      state: 'degraded',
      headline: 'Redeploying — reduced service',
      detail: 'Between publishing and verification the agent is unverified, so a caller reaches only the safe tools: it can take a message or transfer, but it cannot book. Verification ends the window.',
      action: 'Stay on this screen until verification finishes.',
      fixHref: null,
    };
  }

  if (!readiness) {
    return {
      state: 'unknown',
      headline: 'Service status unknown',
      detail: 'Readiness has not been evaluated, so CareCommand cannot say whether this line answers.',
      action: 'Reload the readiness check.',
      fixHref: null,
    };
  }

  const broken = SERVICE_BLOCKING_KEYS
    .map(key => checkFor(readiness, key))
    .find(check => check !== null && check.status !== 'pass' && check.status !== 'warn') ?? null;

  if (campaignStatus !== 'ACTIVE') {
    const word = campaignStatus === 'ARCHIVED' ? 'archived' : campaignStatus === 'PAUSED' ? 'paused' : 'a draft';
    return {
      state: 'not_answering',
      headline: 'Not answering',
      detail: `The campaign is ${word}, so no caller reaches this receptionist.`,
      action: broken ? broken.title ?? broken.label : readiness.ready ? 'Every check passes — activate the campaign.' : 'Clear the readiness checks, then activate.',
      fixHref: broken?.fixHref ?? null,
    };
  }

  if (broken) {
    return {
      state: 'not_answering',
      headline: 'Active, but not answering',
      detail: broken.detail,
      action: broken.title ?? broken.label,
      fixHref: broken.fixHref,
    };
  }

  if (verification && verification.status === 'VERIFIED' && verification.expiresInMs !== null && verification.expiresInMs <= VERIFICATION_WARN_MS) {
    return {
      state: verification.expiresInMs <= 0 ? 'not_answering' : 'degraded',
      headline: verification.expiresInMs <= 0 ? 'Verification expired' : `Verification expires in ${formatExpiresIn(verification.expiresInMs)}`,
      detail: verificationLine(verification).text,
      action: 'Verify the agent again.',
      fixHref: null,
    };
  }

  const warnings = readiness.checks.filter(check => check.status === 'warn');
  return {
    state: 'answering',
    headline: 'Answering calls',
    detail: warnings.length
      ? `Callers reach this receptionist. ${warnings.length} warning${warnings.length === 1 ? '' : 's'} on the checklist.`
      : 'Callers reach this receptionist.',
    action: null,
    fixHref: null,
  };
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
  /**
   * Why the voice list is empty, in the server's words. An empty select with
   * no reason is the defect this closes: an operator could not choose or
   * change the agent voice anywhere in Studio and nothing said why.
   */
  voicesUnavailable: string | null;
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
    voicesUnavailable: null,
  };
}

/**
 * The voice catalogue (`GET /voices`) folded into the catalog view.
 *
 * Contract §7 says `buildReceptionistCatalog` should carry `voices` and
 * `providerMode`; it does not yet, and `voicesCatalogSection()` is served only
 * from the standalone route that no client called — which is why the picker
 * was empty in every tenant and the mock-mode badge never appeared. Until the
 * server folds the section in, the client asks for it and merges it here.
 * `source: 'unavailable'` and `error` are carried through so the reason is
 * shown instead of an empty select.
 */
export function mergeVoicesSection(view: CatalogView, raw: unknown): CatalogView {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const voices = asList(root.voices).map(asVoice).filter((v): v is CatalogVoice => v !== null);
  const mode = root.providerMode;
  const providerMode = mode === 'live' || mode === 'mock' || mode === 'unconfigured' ? mode : view.providerMode;
  const error = typeof root.error === 'string' && root.error.trim() ? root.error : null;
  return {
    ...view,
    voices: voices.length ? voices : view.voices,
    providerMode,
    voicesUnavailable: voices.length || view.voices.length
      ? null
      : error
        ? `The voice catalogue could not be read from the provider (${error}).`
        : providerMode === 'unconfigured'
          ? 'The voice provider is not configured on this server, so no voices can be listed.'
          : 'The provider returned no voices.',
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
const VOICES_PATH = `${base}/voices`;

/**
 * One catalog read for the editors. `/catalog` carries no voices today, so
 * the voice section is fetched from its own route and merged; a failure there
 * degrades to a stated reason, never to a silently empty picker, and never
 * fails the whole catalog.
 */
async function loadCatalogWithVoices(signal?: AbortSignal): Promise<CatalogView> {
  const view = normalizeCatalog(await apiRequest<unknown>(CATALOG_PATH, { signal }));
  if (view.voices.length) return view;
  try {
    return mergeVoicesSection(view, await apiRequest<unknown>(VOICES_PATH, { signal }));
  } catch (error) {
    return { ...view, voicesUnavailable: `The voice catalogue could not be loaded: ${describeFailure(error).message}` };
  }
}

const loadCatalog = (signal: AbortSignal) => loadCatalogWithVoices(signal);

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

// --- Overview KPIs (kpi-v2, SF-2) ----------------------------------------------------

export interface OverviewCounts {
  inbound: number | null; outbound: number | null; answeredInbound: number | null; booked: number | null;
  escalated: number | null; optedOut: number | null; pendingRequests: number | null; openHandoffs: number | null;
  activeCampaigns: number | null; clinics: number | null;
}

export interface OverviewRates {
  bookingRate: number | null; containedPct: number | null; afterHoursPct: number | null; callbacksWithinSlaPct: number | null;
}

export interface OverviewKpis {
  counts: OverviewCounts;
  rates: OverviewRates;
  /** Average handle time in seconds. Null when nothing was answered. */
  aht: number | null;
  /** The server's own sentence for each metric, printed beside it. */
  definitions: Record<string, string>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The kpi-v2 block, read exactly as the server sends it.
 *
 * The rule this enforces is the one the legacy header broke: a rate with no
 * denominator is UNAVAILABLE, never 0. `null` survives all the way to the
 * screen, where it renders as an em dash. The legacy scalars (`totalCalls`,
 * `bookingRate` as a percent over calls in both directions, `avgDurationSeconds`
 * collapsed to 0) are deliberately not read — Package D deletes them.
 */
export function normalizeOverviewKpis(raw: unknown): OverviewKpis | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const counts = (root.counts && typeof root.counts === 'object' ? root.counts : null) as Record<string, unknown> | null;
  const rates = (root.rates && typeof root.rates === 'object' ? root.rates : null) as Record<string, unknown> | null;
  if (!counts && !rates) return null;
  const definitions: Record<string, string> = {};
  if (root.definitions && typeof root.definitions === 'object') {
    for (const [key, value] of Object.entries(root.definitions as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) definitions[key] = value;
    }
  }
  return {
    counts: {
      inbound: numberOrNull(counts?.inbound), outbound: numberOrNull(counts?.outbound),
      answeredInbound: numberOrNull(counts?.answeredInbound), booked: numberOrNull(counts?.booked),
      escalated: numberOrNull(counts?.escalated), optedOut: numberOrNull(counts?.optedOut),
      pendingRequests: numberOrNull(counts?.pendingRequests), openHandoffs: numberOrNull(counts?.openHandoffs),
      activeCampaigns: numberOrNull(counts?.activeCampaigns), clinics: numberOrNull(counts?.clinics),
    },
    rates: {
      bookingRate: numberOrNull(rates?.bookingRate), containedPct: numberOrNull(rates?.containedPct),
      afterHoursPct: numberOrNull(rates?.afterHoursPct), callbacksWithinSlaPct: numberOrNull(rates?.callbacksWithinSlaPct),
    },
    aht: numberOrNull(root.aht),
    definitions,
  };
}

/** An em dash, never "0%", when the server could not compute the rate. */
export function formatRate(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

export function formatCount(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** "0m 54s", or an em dash when no call was long enough to average. */
export function formatSeconds(value: number | null): string {
  if (value === null) return '—';
  return `${Math.floor(value / 60)}m ${value % 60}s`;
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
  deploy: (campaignId: string) => apiRequest<unknown>(`${base}/campaigns/${campaignId}/deploy`, { method: 'POST', body: JSON.stringify({}) })
    .then(raw => {
      const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const verification = body.verification && typeof body.verification === 'object'
        ? body.verification as DeployResponse['verification']
        : { status: 'pending' as const };
      return { ...(body as unknown as DeployResponse), deployment: unwrapDeployment(body.deployment), verification };
    }),
  latestDeployment: (campaignId: string, signal?: AbortSignal) =>
    apiRequest<unknown>(`${base}/campaigns/${campaignId}/deployments/latest`, { signal }).then(unwrapDeployment),
  deploymentDiff: (campaignId: string, signal?: AbortSignal) =>
    apiRequest<unknown>(`${base}/campaigns/${campaignId}/deployment-diff`, { signal }).then(normalizeDeploymentDiff),
  readiness: (campaignId: string, signal?: AbortSignal) => apiRequest<ReadinessResponse>(`${base}/campaigns/${campaignId}/readiness`, { signal }),
  activate: (campaignId: string) => apiRequest<Campaign>(`${base}/campaigns/${campaignId}/activate`, { method: 'POST', body: JSON.stringify({}) }),
  pause: (campaignId: string) => apiRequest<Campaign>(`${base}/campaigns/${campaignId}/pause`, { method: 'POST', body: JSON.stringify({}) }),
  archive: (campaignId: string) => apiRequest<Campaign>(`${base}/campaigns/${campaignId}/archive`, { method: 'POST', body: JSON.stringify({}) }),
  preview: (campaignId: string, signal?: AbortSignal) => apiRequest<PreviewResponse>(`${base}/campaigns/${campaignId}/preview`, { signal }),
  confirmationChannels: (signal?: AbortSignal) => apiRequest<ConfirmationChannels>(`${base}/confirmation-channels`, { signal }),
  adoptProviderValues: (agentId: string) => apiRequest<AgentRow>(`${base}/agents/${agentId}/adopt-provider-values`, { method: 'POST', body: JSON.stringify({}) }),
  retellConfig: (campaignId: string, signal?: AbortSignal) => apiRequest<RetellConfigExport>(`${base}/campaigns/${campaignId}/retell-config`, { signal }),
  catalog: loadCatalogWithVoices,
  /** The kpi-v2 block. Legacy scalars in the same body are deliberately ignored. */
  overview: (signal?: AbortSignal) => apiRequest<unknown>(`${base}/overview`, { signal }).then(normalizeOverviewKpis),
};
