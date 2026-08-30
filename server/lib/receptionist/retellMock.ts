import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fingerprintJson, normalizeBookAppointmentToolContract } from '../../modules/receptionist/intakeContract';
import type { MockDeploymentSnapshot, RetellAgentSnapshot, RetellProviderResult, RetellVoice } from '../retell';

// ===========================================================================
// Mock Retell provider (RETELL_API_KEY starting with "mock").
//
// Deliberately stateless: the only durable state a deployment has is the
// ReceptionistAgentDeployment row CareCommand wrote, so the API process, the
// worker, the demo seed and every test agree on what "the provider" holds.
// Each function below answers from ids it mints or from the deployment
// snapshot it is handed; none of them reads the database and none of them is
// reachable with a real key (server/lib/retell.ts routes only the mock key
// here). Every value it mints is prefixed `mock_`/`mock:` so it can never be
// mistaken for provider evidence.
// ===========================================================================

const MOCK_LLM_MODEL = 'mock-llm';

function mockId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function mockCreateLlm(): RetellProviderResult<{ llmId: string; version: number }> {
  return { ok: true, value: { llmId: mockId('mock_llm'), version: 0 }, mock: true };
}

/** Mirrors Retell: an update is a new draft version of the same engine. */
export function mockUpdateLlm(llmId: string, previousVersion = 0): RetellProviderResult<{ llmId: string; version: number }> {
  return { ok: true, value: { llmId, version: previousVersion + 1 }, mock: true };
}

export function mockCreateAgent(): RetellProviderResult<{ agentId: string; version: number }> {
  return { ok: true, value: { agentId: mockId('mock_agent'), version: 0 }, mock: true };
}

export function mockUpdateAgent(agentId: string, previousVersion = 0): RetellProviderResult<{ agentId: string; version: number }> {
  return { ok: true, value: { agentId, version: previousVersion + 1 }, mock: true };
}

export function mockPublishAgent(_agentId: string, version: number): RetellProviderResult<{ version: number }> {
  return { ok: true, value: { version }, mock: true };
}

let cachedMockVoices: RetellVoice[] | null = null;

/**
 * The fixture is a JSON file so the catalogue can be reviewed without reading
 * code. It is read from the source tree (mock mode is a demo/test posture and
 * is refused at boot for pilot/enterprise); a missing file is an explicit
 * error rather than an empty voice list.
 */
export function mockListVoices(): RetellVoice[] {
  if (!cachedMockVoices) {
    const raw = readFileSync(new URL('./fixtures/retellVoices.mock.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('retell_mock_voice_fixture_invalid');
    cachedMockVoices = parsed as RetellVoice[];
  }
  return cachedMockVoices.map(voice => ({ ...voice }));
}

export function mockLlmModel(): string {
  return MOCK_LLM_MODEL;
}

/**
 * A provider snapshot that satisfies every readiness and intake-evidence rule
 * for the deployment it was built from. The fingerprints are derived from the
 * deployment row so a later prompt edit in Studio still reads as
 * "deployment stale" while the provider side stays internally consistent.
 */
export function buildMockAgentSnapshot(input: {
  agentId: string;
  versionTag: string;
  deployment: MockDeploymentSnapshot;
  webhookUrl: string;
}): RetellAgentSnapshot {
  const { deployment } = input;
  const tools = Array.isArray(deployment.toolsJson) ? deployment.toolsJson as unknown[] : [];
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
    fingerprint: digest(`mock:${input.agentId}|${input.versionTag}|${deployment.providerAgentVersion}|${deployment.promptHash}`),
    promptHash: deployment.promptHash,
    beginMessageHash: deployment.beginMessageHash,
    toolsFingerprint: deployment.toolFingerprint,
    mock: true,
  };
}
