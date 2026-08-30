import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import {
  createRetellAgent,
  createRetellLlm,
  listRetellVoices,
  probeRetellAgent,
  publishRetellAgent,
  retellConfigStatus,
  retellProviderMode,
  simulatedProviderWasLoaded,
  simulatedRetellProvider,
  updateRetellAgent,
  updateRetellLlm,
  type MockDeploymentSnapshot,
} from '../lib/retell';

// ===========================================================================
// The rehearsal provider is fenced to the demo deployment profile.
//
// A RETELL_API_KEY beginning with "mock" makes the provider client mint agent
// ids, report a publish as successful and confirm a phone-number binding that
// no telephone network knows about. In a demo that is the honest posture. In a
// pilot or enterprise deployment it is a receptionist that reports itself live
// while no line is answered.
//
// Two locks, and this suite is the second one:
//
//   1. server/config/env.ts refuses to BOOT a pilot/enterprise process whose
//      RETELL_API_KEY starts with "mock" (pinned in envSchema.test.ts).
//   2. server/lib/retell.ts refuses to LOAD the simulation unless the profile
//      is demo, which is what this file pins — because all twelve provider call
//      sites resolve their credentials through one accessor in that module, so
//      a single unfenced read there is reachable from every provider call the
//      product makes.
//
// The claim is stronger than "an `if` guards it": the simulation is a module
// reached by one `await import()` behind the gate, so in a pilot process it is
// never evaluated. `simulatedProviderWasLoaded()` reports that, and the tests
// below are ordered so the real-profile cases all run before the demo case
// that is allowed to load it.
//
// Nothing here reads a developer's .env for its premise: every value the
// assertions depend on is set explicitly below and restored afterwards, so the
// suite exercises the same thing on a laptop with our secrets and on a clean
// CI checkout with none.
// ===========================================================================

const original = {
  apiKey: env.RETELL_API_KEY,
  fromNumber: env.RETELL_FROM_NUMBER,
  profile: env.DEPLOYMENT_PROFILE,
};

const REHEARSAL_KEY = 'mock_fence_suite';

/** Every provider call this module can make is answered with an explicit 401. */
function stubProviderNetwork() {
  const fetchSpy = vi.fn(async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

const LLM_SPEC = { generalPrompt: 'You are the front desk.', beginMessage: 'Hello.', tools: [] };
const AGENT_SPEC = {
  agentName: 'fence-suite',
  llmId: 'llm_fence',
  llmVersion: 0,
  voiceId: 'voice_fence',
  language: 'en-US',
  webhookUrl: 'https://example.test/v1/receptionist/webhooks/retell',
  postCallAnalysisData: [],
};

const DEPLOYMENT: MockDeploymentSnapshot = {
  providerAgentId: 'mock_agent_fence',
  providerAgentVersion: 3,
  providerLlmId: 'llm_fence',
  providerLlmVersion: 0,
  providerVersionTag: 'carecommand-v3',
  promptHash: 'prompt-hash',
  beginMessageHash: 'begin-hash',
  toolFingerprint: 'tool-fingerprint',
  voiceId: 'voice_fence',
  language: 'en-US',
  toolsJson: [],
};

beforeEach(() => {
  env.RETELL_API_KEY = REHEARSAL_KEY;
  env.RETELL_FROM_NUMBER = '+15550100000';
});

afterEach(() => {
  vi.unstubAllGlobals();
  env.RETELL_API_KEY = original.apiKey;
  env.RETELL_FROM_NUMBER = original.fromNumber;
  env.DEPLOYMENT_PROFILE = original.profile;
});

describe('the simulated voice provider is reachable only in the demo profile', () => {
  // ---- Real profiles, first, while the module has never been loaded --------
  for (const profile of ['pilot', 'enterprise'] as const) {
    it(`refuses the simulation and takes the live path in ${profile}, with the same key`, async () => {
      env.DEPLOYMENT_PROFILE = profile;
      const fetchSpy = stubProviderNetwork();

      // The key is unchanged. The profile alone decides.
      expect(env.RETELL_API_KEY).toBe(REHEARSAL_KEY);
      expect(retellConfigStatus().mock).toBe(false);
      expect(retellProviderMode()).toBe('live');
      expect(await simulatedRetellProvider()).toBeNull();

      // Each deployment call goes to the provider and fails honestly on the
      // key, rather than returning a fabricated success.
      const calls = [
        await createRetellLlm(LLM_SPEC),
        await updateRetellLlm('llm_fence', LLM_SPEC, 0),
        await createRetellAgent(AGENT_SPEC),
        await updateRetellAgent('agent_fence', AGENT_SPEC, 0),
        await publishRetellAgent('agent_fence', 1),
        await listRetellVoices(),
      ];
      for (const result of calls) {
        expect(result).toMatchObject({ ok: false, mock: false });
        expect(result.ok === false && result.error).toBe('unauthorized');
      }
      expect(fetchSpy.mock.calls.length).toBe(calls.length);
      for (const call of fetchSpy.mock.calls as unknown as Array<[string]>) {
        expect(String(call[0])).toContain(env.RETELL_BASE_URL);
      }

      // The point of the dynamic import: not merely unreached, absent.
      expect(simulatedProviderWasLoaded()).toBe(false);
    });
  }

  it('does not let the agent probe answer from a deployment row outside demo', async () => {
    env.DEPLOYMENT_PROFILE = 'pilot';
    const fetchSpy = stubProviderNetwork();

    // In demo this exact call is answered from the deployment CareCommand
    // wrote. Under a real profile it must ask the provider — and be refused.
    const probe = await probeRetellAgent('mock_agent_fence', 'carecommand-v3', { mockDeployment: DEPLOYMENT });
    expect(probe).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(fetchSpy).toHaveBeenCalled();
    expect(simulatedProviderWasLoaded()).toBe(false);
  });

  it('keeps the simulation out of the image: the provider client imports no scaffolding at load time', () => {
    // The simulation used to be imported unconditionally at the top of
    // retell.ts, so a provider that fabricates deployments was linked into
    // pilot and enterprise processes too. Its one reference is now a dynamic
    // import inside the gate. This pins that no STATIC import brings it, or
    // any other test/demo module, back in.
    const source = readFileSync(new URL('../lib/retell.ts', import.meta.url), 'utf8');
    const staticImports = [...source.matchAll(/^import[^;]*?from\s+'([^']+)';/gms)].map(match => match[1]);
    expect(staticImports.length).toBeGreaterThan(0);
    for (const specifier of staticImports) {
      expect(specifier, `${specifier} is loaded at import time`).not.toMatch(/SimulatedProvider|mock|fixture|\/tests?\//i);
    }
    // And exactly one lazy reference, which is the gate itself.
    expect([...source.matchAll(/await import\('([^']+)'\)|import\('([^']+)'\)/g)].map(m => m[1] ?? m[2]))
      .toEqual(['./receptionist/retellSimulatedProvider']);
  });

  // ---- Demo, last, because it is the case that may load the module ---------
  it('answers from the simulation, without touching the network, in demo', async () => {
    env.DEPLOYMENT_PROFILE = 'demo';
    const fetchSpy = stubProviderNetwork();

    expect(retellConfigStatus().mock).toBe(true);
    expect(retellProviderMode()).toBe('mock');
    expect(await simulatedRetellProvider()).not.toBeNull();
    expect(simulatedProviderWasLoaded()).toBe(true);

    const created = await createRetellLlm(LLM_SPEC);
    expect(created).toMatchObject({ ok: true, mock: true });
    // Every minted value stays legible as rehearsal evidence for the rest of
    // its life, so a demo deployment can never be mistaken for a live one.
    expect(created.ok && created.value.llmId).toMatch(/^mock_llm_/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still refuses in demo what the real provider refuses — it is not a fake that cannot fail', async () => {
    env.DEPLOYMENT_PROFILE = 'demo';
    stubProviderNetwork();
    // `type: 'function'` is the exact payload that killed a live attended
    // deploy: eleven of thirteen tools carried an OpenAI word that is not in
    // Retell's discriminator, and the simulation of the day said yes to all of
    // them. Gating this module must never cost us that refusal.
    const refused = await createRetellLlm({
      ...LLM_SPEC,
      tools: [{ type: 'function', name: 'book_appointment', url: 'https://example.test/fn' }],
    });
    expect(refused).toMatchObject({ ok: false, error: 'invalid_request', status: 400, mock: true });
  });
});
