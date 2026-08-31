import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fingerprintJson, normalizeBookAppointmentToolContract } from '../../modules/receptionist/intakeContract';
import { retellAgentRequestIssues, retellLlmRequestIssues } from './retellRequestContract';
import { fingerprintTools } from '../retell';
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
// Deliberately stateless: the only durable state a deployment has is the
// ReceptionistAgentDeployment row CareCommand wrote, so the API process, the
// worker, the demo seed and every test agree on what "the provider" holds. Each
// function below answers from ids it mints or from the deployment snapshot it
// is handed; none of them reads the database. Every value minted is prefixed
// `mock_`/`mock:` so it can never be mistaken for provider evidence — a
// deployment made in rehearsal stays legible as one for the rest of its life.
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

function simulatedCreateLlm(body: unknown): RetellProviderResult<{ llmId: string; version: number }> {
  const issues = retellLlmRequestIssues(body);
  if (issues.length) return simulatedInvalidRequest('create-retell-llm', issues);
  return { ok: true, value: { llmId: simulatedId('mock_llm'), version: 0 }, mock: true };
}

/** Mirrors Retell: an update is a new draft version of the same engine. */
function simulatedUpdateLlm(llmId: string, body: unknown, previousVersion = 0): RetellProviderResult<{ llmId: string; version: number }> {
  const issues = retellLlmRequestIssues(body);
  if (issues.length) return simulatedInvalidRequest('update-retell-llm', issues);
  return { ok: true, value: { llmId, version: previousVersion + 1 }, mock: true };
}

function simulatedCreateAgent(body: unknown): RetellProviderResult<{ agentId: string; version: number }> {
  const issues = retellAgentRequestIssues(body);
  if (issues.length) return simulatedInvalidRequest('create-agent', issues);
  return { ok: true, value: { agentId: simulatedId('mock_agent'), version: 0 }, mock: true };
}

function simulatedUpdateAgent(agentId: string, body: unknown, previousVersion = 0): RetellProviderResult<{ agentId: string; version: number }> {
  const issues = retellAgentRequestIssues(body);
  if (issues.length) return simulatedInvalidRequest('update-agent', issues);
  return { ok: true, value: { agentId, version: previousVersion + 1 }, mock: true };
}

function simulatedPublishAgent(_agentId: string, version: number): RetellProviderResult<{ version: number }> {
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
    fingerprint: simulatedDigest(`mock:${input.agentId}|${input.versionTag}|${deployment.providerAgentVersion}|${deployment.promptHash}`),
    promptHash: deployment.promptHash,
    beginMessageHash: deployment.beginMessageHash,
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
