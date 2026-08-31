import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fingerprintJson, normalizeBookAppointmentToolContract } from '../../modules/receptionist/intakeContract';
import { retellAgentRequestIssues, retellLlmRequestIssues } from './retellRequestContract';
import { fingerprintTools, hashPrompt } from '../retell';
import type {
  MockDeploymentSnapshot,
  MockPhoneNumberBinding,
  PhoneNumberBinding,
  RetellAgentSnapshot,
  RetellProviderResult,
  RetellVoice,
  SimulatedRetellProvider,
} from '../retell';

// ===========================================================================
// The simulated voice provider — DEMO DEPLOYMENT PROFILE ONLY.
//
// NOTHING IN PRODUCTION IMPORTS THIS FILE AT LOAD TIME. `server/lib/retell.ts`
// reaches it through one `await import()` inside `simulatedRetellProvider()`,
// which returns null unless `retellConfigStatus().mock` says both that the key
// is a rehearsal key AND that DEPLOYMENT_PROFILE is `demo`. In a pilot or
// enterprise process this module is therefore never evaluated at all: it is not
// in the image, not merely unreachable by an `if`. `retell.ts` exports
// `simulatedProviderWasLoaded()` so a test can prove exactly that.
//
// Why it matters. A rehearsal key makes the provider client mint agent ids,
// report a publish as successful and confirm phone-number bindings that no
// telephone network knows about. All twelve provider call sites resolve their
// credentials through one accessor in `retell.ts`, so an unfenced route into
// this file is reachable from every provider call the product makes.
//
// Almost stateless: the durable state a deployment has is the
// ReceptionistAgentDeployment row CareCommand wrote, so the API process, the
// worker, the demo seed and every test agree on what "the provider" holds. Each
// function below answers from ids it mints or from the deployment snapshot it
// is handed; none of them reads the database. Every value minted is prefixed
// `mock_`/`mock:` so it can never be mistaken for provider evidence — a
// deployment made in rehearsal stays legible as one for the rest of its life.
//
// The ONE thing it now remembers is the bodies it was handed (see
// `simulatedEngines` / `simulatedAgents`). It has to: a provider that keeps no
// copy of the prompt it was given cannot be asked what prompt it is running,
// and answering that question from the expectation is what made prompt drift
// undetectable. That memory is process-local and bounded, never a source of
// truth, and a cold memory answers "I do not know" rather than "you are right".
//
// AND IT SAYS NO. This file used to answer `ok` to every payload, so the entire
// deploy path had only ever been exercised against a provider that could not
// reject anything — which is how eleven of our thirteen tools shipped declaring
// `type: 'function'`, a word not in Retell's discriminator, and died on a live
// attended deploy. Every request still goes through the real provider's request
// contract (`./retellRequestContract`) and is refused here exactly as the live
// account refuses it, with the same mapped `invalid_request`. A simulator that
// cannot fail is a way of not testing; do not let it become one again.
// ===========================================================================

function simulatedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function simulatedDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A rejection identical to what the live client produces for Retell's 400:
 * `mapRetellProviderStatus(400)` is `invalid_request`, and the deploy service
 * maps that to `provider_invalid_request` with no provider body surfaced. The
 * issues are printed once outside tests, because a mock that says only "no" is
 * a worse debugging experience than the real provider without being any more
 * honest than it.
 */
function simulatedInvalidRequest<T>(operation: string, issues: string[]): RetellProviderResult<T> {
  if (process.env.NODE_ENV !== 'test') {
    console.error(`[retell-simulated] ${operation} rejected: ${issues.join('; ')}`);
  }
  return { ok: false, error: 'invalid_request', status: 400, mock: true };
}

// ---------------------------------------------------------------------------
// What the simulation remembers.
//
// Retell keeps the prompt, the begin message and the tools it was written, and
// answers `get-retell-llm` from that copy — which is the only reason a probe
// can tell us the provider is running something other than what we deployed.
// The simulation kept nothing, so it had nothing to answer from, so it answered
// from the expectation. Keeping the write bodies is what makes the read honest.
//
// It is a cache of writes, never a source of truth. Two consequences are
// deliberate. It is bounded, so a long-lived demo process cannot grow one entry
// per deploy forever. And when the entry is missing — evicted, or the deploy
// happened in another process, which on a serverless deployment is the normal
// case — the read answers `null`, exactly as the live client does when the
// engine body could not be fetched. Null means "not known", and readiness
// judges no drift on it. It must never be made to mean "matches".
// ---------------------------------------------------------------------------

/** How many engines/agents the simulation keeps write bodies for. */
const SIMULATED_MEMORY_LIMIT = 128;

interface SimulatedEngineVersion {
  generalPrompt: string;
  beginMessage: string;
  tools: unknown[];
}

interface SimulatedEngine {
  versions: Map<number, SimulatedEngineVersion>;
  /** Set when an agent version referencing this engine is published. */
  published: boolean;
}

interface SimulatedAgent {
  /** Response-engine id per agent version, so a publish can freeze the right engine. */
  engineByVersion: Map<number, string>;
  publishedVersions: Set<number>;
}

const simulatedEngines = new Map<string, SimulatedEngine>();
const simulatedAgents = new Map<string, SimulatedAgent>();

/** Oldest-first eviction. The map is a convenience, so losing the tail is safe. */
function boundMemory<T>(store: Map<string, T>): void {
  while (store.size > SIMULATED_MEMORY_LIMIT) {
    const oldest = store.keys().next();
    if (oldest.done) return;
    store.delete(oldest.value);
  }
}

function rememberEngineVersion(llmId: string, version: number, body: Record<string, unknown>): void {
  const engine = simulatedEngines.get(llmId) ?? { versions: new Map<number, SimulatedEngineVersion>(), published: false };
  engine.versions.set(version, {
    generalPrompt: typeof body.general_prompt === 'string' ? body.general_prompt : '',
    beginMessage: typeof body.begin_message === 'string' ? body.begin_message : '',
    tools: Array.isArray(body.general_tools) ? body.general_tools as unknown[] : [],
  });
  simulatedEngines.set(llmId, engine);
  boundMemory(simulatedEngines);
}

function rememberAgentVersion(agentId: string, version: number, body: Record<string, unknown>): void {
  const agent = simulatedAgents.get(agentId) ?? { engineByVersion: new Map<number, string>(), publishedVersions: new Set<number>() };
  const engine = record(body.response_engine);
  const llmId = typeof engine?.llm_id === 'string' ? engine.llm_id : null;
  if (llmId) agent.engineByVersion.set(version, llmId);
  simulatedAgents.set(agentId, agent);
  boundMemory(simulatedAgents);
}

function simulatedCreateLlm(body: unknown): RetellProviderResult<{ llmId: string; version: number }> {
  const issues = retellLlmRequestIssues(body);
  if (issues.length) return simulatedInvalidRequest('create-retell-llm', issues);
  const llmId = simulatedId('mock_llm');
  rememberEngineVersion(llmId, 0, body as Record<string, unknown>);
  return { ok: true, value: { llmId, version: 0 }, mock: true };
}

/**
 * Mirrors Retell: an update is a new draft version of the same engine — unless
 * the engine has been published, which freezes it. Retell answers
 * `400 Cannot update published LLM` (confirmed against the live account on
 * 2026-08-30); the live client maps that to `invalid_request`, so this does
 * too. Without this the simulation modelled a provider on which every second
 * deploy trivially succeeded, which is precisely the deploy that failed
 * permanently in production for every clinic that had published once.
 *
 * An engine this process has never written is NOT refused: we have no evidence
 * it was published, and inventing one would fail deploys that should succeed.
 */
function simulatedUpdateLlm(llmId: string, body: unknown, previousVersion = 0): RetellProviderResult<{ llmId: string; version: number }> {
  const issues = retellLlmRequestIssues(body);
  if (issues.length) return simulatedInvalidRequest('update-retell-llm', issues);
  if (simulatedEngines.get(llmId)?.published) {
    return simulatedInvalidRequest('update-retell-llm', ['Cannot update published LLM']);
  }
  const version = previousVersion + 1;
  rememberEngineVersion(llmId, version, body as Record<string, unknown>);
  return { ok: true, value: { llmId, version }, mock: true };
}

function simulatedCreateAgent(body: unknown): RetellProviderResult<{ agentId: string; version: number }> {
  const issues = retellAgentRequestIssues(body);
  if (issues.length) return simulatedInvalidRequest('create-agent', issues);
  const agentId = simulatedId('mock_agent');
  rememberAgentVersion(agentId, 0, body as Record<string, unknown>);
  return { ok: true, value: { agentId, version: 0 }, mock: true };
}

/**
 * An agent update is a new DRAFT version, and Retell allows it on an agent
 * whose current version is published — that is how a second deploy of a live
 * line is possible at all. What it must never do is rewrite a version that has
 * already been published, so that case is refused rather than silently
 * mutating a version callers are on right now.
 */
function simulatedUpdateAgent(agentId: string, body: unknown, previousVersion = 0): RetellProviderResult<{ agentId: string; version: number }> {
  const issues = retellAgentRequestIssues(body);
  if (issues.length) return simulatedInvalidRequest('update-agent', issues);
  const version = previousVersion + 1;
  if (simulatedAgents.get(agentId)?.publishedVersions.has(version)) {
    return simulatedInvalidRequest('update-agent', [`Cannot update published agent version ${version}`]);
  }
  rememberAgentVersion(agentId, version, body as Record<string, unknown>);
  return { ok: true, value: { agentId, version }, mock: true };
}

/**
 * Publishing freezes both halves: the agent version stops being writable, and
 * so does the response engine that version answers from. The engine freeze is
 * the one that mattered — it is why `retellDeploy` creates a new engine rather
 * than updating the published one, and until now no test could tell whether
 * that branch was needed, because the simulation let a published engine be
 * updated forever.
 */
function simulatedPublishAgent(agentId: string, version: number): RetellProviderResult<{ version: number }> {
  const agent = simulatedAgents.get(agentId);
  if (agent) {
    agent.publishedVersions.add(version);
    const llmId = agent.engineByVersion.get(version);
    const engine = llmId ? simulatedEngines.get(llmId) : undefined;
    if (engine) engine.published = true;
  }
  return { ok: true, value: { version }, mock: true };
}

/**
 * The mock's answer to "who answers this number?".
 *
 * It reads the deployment row CareCommand wrote — the same durable state every
 * other mock answer comes from — so a demo tenant exercises the real read-back
 * path in `verifyAgentProvider` instead of routing around it. Three honest
 * negatives it must be able to give, because each one is a real failure the
 * live provider produces and readiness has to be able to see:
 *
 *   - no deployment evidence at all            → nothing is bound
 *   - the deploy's bind step did not succeed   → nothing is bound
 *   - the read is for a DIFFERENT number       → nothing is bound on THAT one
 *
 * It never invents a binding, and it never answers for a number the deployment
 * did not target.
 */
function simulatedPhoneNumberBinding(
  phoneNumber: string,
  binding: MockPhoneNumberBinding | null,
): RetellProviderResult<PhoneNumberBinding> {
  const unbound = { ok: true as const, value: { phoneNumber, inboundAgentId: null, inboundAgentVersion: null }, mock: true };
  if (!binding || !binding.numberBound) return unbound;
  if (binding.boundPhoneNumber !== phoneNumber) return unbound;
  if (!binding.providerAgentId || binding.providerAgentVersion === null) return unbound;
  return {
    ok: true,
    value: { phoneNumber, inboundAgentId: binding.providerAgentId, inboundAgentVersion: binding.providerAgentVersion },
    mock: true,
  };
}

let cachedSimulatedVoices: RetellVoice[] | null = null;

/**
 * The fixture is a JSON file so the catalogue can be reviewed without reading
 * code. It is read from the source tree (mock mode is a demo/test posture and
 * is refused at boot for pilot/enterprise); a missing file is an explicit
 * error rather than an empty voice list.
 */
function simulatedListVoices(): RetellVoice[] {
  if (!cachedSimulatedVoices) {
    const raw = readFileSync(new URL('./fixtures/retellVoices.mock.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('retell_mock_voice_fixture_invalid');
    cachedSimulatedVoices = parsed as RetellVoice[];
  }
  return cachedSimulatedVoices.map(voice => ({ ...voice }));
}


/**
 * A provider snapshot that satisfies every readiness and intake-evidence rule
 * for the deployment it was built from. The fingerprints are derived from the
 * deployment row so a later prompt edit in Studio still reads as
 * "deployment stale" while the provider side stays internally consistent.
 */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function simulatedAgentSnapshot(input: {
  agentId: string;
  versionTag: string;
  deployment: MockDeploymentSnapshot;
  webhookUrl: string;
}): RetellAgentSnapshot {
  const { deployment } = input;
  // NOT `deployment.promptHash` / `deployment.beginMessageHash`. Echoing the
  // expected values made verification compare `x !== x`, so a prompt that had
  // drifted at the provider was undetectable by any test in this repo — on the
  // field that decides what the agent actually says to a patient.
  //
  // Answer the way Retell does: hash the body we were written. `null` when this
  // process holds no copy of that engine version, which is what the live client
  // reports when the engine body could not be read, and which readiness treats
  // as "no drift judged" rather than as agreement.
  const engineBody = simulatedEngines.get(deployment.providerLlmId)?.versions.get(deployment.providerLlmVersion) ?? null;
  const tools = Array.isArray(deployment.toolsJson) ? deployment.toolsJson as unknown[] : [];
  // Retell fills in optional keys on write — `speak_after_execution` is one it
  // adds to tools that omit it. The simulation must do the same, or it models a
  // provider that stores exactly what it is given, which Retell does not.
  const providerStoredTools = tools.map(tool => {
    const row = record(tool);
    return row ? { speak_after_execution: false, ...row } : tool;
  });
  const bookingTools = tools.filter((tool): tool is Record<string, unknown> =>
    Boolean(tool) && typeof tool === 'object' && (tool as Record<string, unknown>).name === 'book_appointment');
  const bookToolSchema = bookingTools.length === 1 ? normalizeBookAppointmentToolContract(bookingTools[0]!) : null;
  const graphFingerprint = fingerprintJson({
    mock: true,
    llmId: deployment.providerLlmId,
    version: deployment.providerLlmVersion,
    promptHash: deployment.promptHash,
    toolFingerprint: deployment.toolFingerprint,
  });
  const bookToolFingerprint = bookToolSchema
    ? fingerprintJson({
      tool: bookToolSchema,
      engine: { type: 'retell-llm', id: deployment.providerLlmId, version: deployment.providerLlmVersion, graphFingerprint },
    })
    : null;
  return {
    agentId: input.agentId,
    version: deployment.providerAgentVersion,
    assignedTags: [input.versionTag],
    published: true,
    voiceId: deployment.voiceId,
    language: deployment.language,
    webhookUrl: input.webhookUrl,
    webhookEvents: ['call_analyzed', 'call_ended', 'call_started'],
    dataStorageSetting: 'basic_attributes_only',
    signedUrl: true,
    responseEngineType: 'retell-llm',
    responseEngineId: deployment.providerLlmId,
    responseEngineVersion: deployment.providerLlmVersion,
    responseEngineGraphFingerprint: graphFingerprint,
    bookToolProbeStatus: 'SUCCEEDED',
    bookToolSchema: bookToolSchema as unknown as Record<string, unknown> | null,
    bookToolFingerprint,
    toolCallStrictMode: true,
    effectiveDynamicVariables: {},
    lastModifiedAt: null,
    // Deliberately still from the deployment row: this is the stable identity
    // of the published version, and `verifyAgentProvider` treats a fingerprint
    // that MOVED as the provider having been changed underneath us. Deriving it
    // from the write-body cache would make it flip on a cold process and report
    // a drift that never happened. Prompt drift is reported as `prompt_drift`.
    fingerprint: simulatedDigest(`mock:${input.agentId}|${input.versionTag}|${deployment.providerAgentVersion}|${deployment.promptHash}`),
    promptHash: engineBody ? hashPrompt(engineBody.generalPrompt, { mock: true }) : null,
    beginMessageHash: engineBody ? hashPrompt(engineBody.beginMessage, { mock: true }) : null,
    // NOT `deployment.toolFingerprint`. Echoing the expected value made
    // verification compare `x !== x`, so tool drift was undetectable by any
    // test in this repo — on one of the three fields that gate go-live. That
    // tautology is why a permanent `tools_drift` against the real provider
    // shipped unnoticed.
    //
    // Answer the way Retell does: from the tools we were handed, with the
    // provider's write-time defaults applied. A comparison that cannot survive
    // a default being added here would not survive the real provider either.
    toolsFingerprint: fingerprintTools(providerStoredTools, { mock: true }),
    tools: providerStoredTools,
    mock: true,
  };
}

/** The one exported value: the whole simulation, frozen. */
export const SIMULATED_RETELL_PROVIDER: SimulatedRetellProvider = Object.freeze({
  createLlm: simulatedCreateLlm,
  updateLlm: simulatedUpdateLlm,
  createAgent: simulatedCreateAgent,
  updateAgent: simulatedUpdateAgent,
  publishAgent: simulatedPublishAgent,
  phoneNumberBinding: simulatedPhoneNumberBinding,
  listVoices: simulatedListVoices,
  agentSnapshot: simulatedAgentSnapshot,
});
