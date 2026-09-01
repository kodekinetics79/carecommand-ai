import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { env } = await import('../config/env');
const { readyCampaignFixture, clinicFixtureData, proveTestCall } = await import('./helpers/receptionistFixtures');
const { hashPrompt, llmRequestBody } = await import('../lib/retell');
const { RETELL_GENERAL_TOOL_TYPES, retellLlmRequestIssues } = await import('../lib/receptionist/retellRequestContract');

// ===========================================================================
// Deploying to Retell, end to end.
//
// The live system's failure mode this suite exists to prevent: an agent
// published at the provider with none of our prompt, none of our thirteen
// tools and a blank webhook, while the phone number pointed at something else
// entirely. Every assertion below is about the deployment being REAL — the
// version pinned, the number bound, the prompt attested — rather than about a
// request having returned 200.
// ===========================================================================

type Role = 'OWNER' | 'MANAGER' | 'BILLING';
type TenantFixture = { id: string; users: Record<Role, string>; branchId: string };
const tenantIds: string[] = [];
let app: FastifyInstance;
const originalRetell = { apiKey: env.RETELL_API_KEY, baseUrl: env.RETELL_BASE_URL, fromNumber: env.RETELL_FROM_NUMBER };

const phone = () => `+1${(BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

// Provider ids are per-test, never literals.
//
// `ReceptionistAgent_active_provider_deployment_unique` is a GLOBAL partial
// index on (providerAgentId, providerVersion) for active agents — deliberately
// cross-tenant, because two live configurations sharing one provider version
// would share its webhook and response-engine blast radius. A suite that
// verifies against a hardcoded `agent_drift` therefore leaves a row that
// collides with the next run on a shared development database, and the failure
// lands on whichever test verifies second rather than on the one that leaked.
// Isolating the ids keeps the constraint at full strength.
const providerId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

async function tenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Deploy ${id.slice(0, 8)}`, slug: `deploy-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const users = {} as Record<Role, string>;
  for (const role of ['OWNER', 'MANAGER', 'BILLING'] as const) {
    const row = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role.toLowerCase()}-${id.slice(0, 8)}@deploy.test`, displayName: role },
      select: { id: true },
    });
    users[role] = row.id;
  }
  const branch = await db.branch.create({
    data: { tenantId: id, name: 'Main branch', location: '1 Main Street', timezone: 'America/New_York', active: true },
    select: { id: true },
  });
  return { id, users, branchId: branch.id };
}

function auth(t: TenantFixture, role: Role = 'OWNER') {
  return { authorization: `Bearer ${app.jwt.sign({ userId: t.users[role], tenantId: t.id, role, type: 'access' })}` };
}

/** A clinic, agent and campaign that readiness would accept. */
async function deployableCampaign(t: TenantFixture) {
  const clinic = await db.receptionistClinic.create({
    data: clinicFixtureData({
      tenantId: t.id, name: `Clinic ${randomUUID().slice(0, 8)}`, phone: phone(),
      humanFallbackNumber: phone(), timezone: 'America/New_York', active: true,
    }) as never,
  });
  const agent = await db.receptionistAgent.create({
    data: { tenantId: t.id, clinicId: clinic.id, name: 'Avery', voice: 'mock-voice-nova', language: 'en-US', active: true },
  });
  const campaign = await db.receptionistCampaign.create({
    data: {
      tenantId: t.id, clinicId: clinic.id, agentId: agent.id,
      name: 'Front desk', campaignType: 'Inbound reception', status: 'DRAFT',
      offerTitle: 'Book a consultation', offerDescription: 'We are welcoming new patients this month.',
      offerScript: 'I can check what we have available and book you in now.',
      appointmentType: 'New patient consultation', eligibleLocationIds: [],
      smsConfirmation: false, emailConfirmation: false,
    },
  });
  await db.receptionistIntakeField.createMany({ data: [
    { tenantId: t.id, campaignId: campaign.id, fieldType: 'FIRST_NAME', label: 'First name', aiQuestion: 'Can I start with your first name?', required: true, sortOrder: 0 },
    { tenantId: t.id, campaignId: campaign.id, fieldType: 'PHONE', label: 'Phone', aiQuestion: 'What is the best number to reach you on?', required: true, sortOrder: 1 },
  ] });
  const fixture = await readyCampaignFixture({
    tenantId: t.id, clinicId: clinic.id, campaignId: campaign.id, branchId: t.branchId,
    appointmentType: 'New patient consultation', agentId: agent.id,
  });
  return { clinic, agent, campaign, fixture };
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  vi.unstubAllGlobals();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app.close();
  await db.$disconnect();
});

describe('deploying a campaign to Retell', () => {
  it('publishes, binds the number, and verifies against what the provider actually reports', async () => {
    env.RETELL_API_KEY = 'mock_deploy_key';
    env.RETELL_FROM_NUMBER = '+15550100000';
    try {
      const t = await tenant();
      const { clinic, agent, campaign } = await deployableCampaign(t);

      const deployed = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      expect(deployed.statusCode).toBe(200);
      // Deploy publishes; it does NOT claim verification, because four provider
      // round trips plus a probe do not fit in one serverless invocation.
      expect(deployed.json().verification).toEqual({ status: 'pending' });
      expect(deployed.json().deployment).toMatchObject({ status: 'PUBLISHED', mock: true, numberBound: true });
      // Masking the provider id was not enough, so the tenant projection no
      // longer carries it at all — nor the published version, the LLM version,
      // the deployment tag or the four fingerprints. One opaque reference
      // stands for all of them, and it is derived from CareCommand's own row
      // id rather than from anything the supplier issued.
      expect(deployed.json().deployment.configurationReference).toMatch(/^LINE-[A-Z0-9]{6}$/);
      const body = JSON.stringify(deployed.json());
      expect(body).not.toContain('mock_deploy_key');
      for (const withheld of ['providerAgentIdMasked', 'providerAgentVersion', 'providerLlmVersion', 'providerVersionTag', 'promptHash', 'toolFingerprint', 'intakeFingerprint', 'configFingerprint']) {
        expect(deployed.json().deployment, `${withheld} must not reach a tenant`).not.toHaveProperty(withheld);
      }

      const row = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      expect(row.promptHash.startsWith('mock:')).toBe(true);
      expect(row.providerAgentVersion).not.toBeNull();
      // A1 — this clinic's own line, claimed onto the clinic row, not the one
      // global RETELL_FROM_NUMBER every clinic used to fight over.
      expect(row.boundPhoneNumber).toBe(clinic.phone);
      expect(await db.receptionistClinic.findUniqueOrThrow({ where: { id: clinic.id } }))
        .toMatchObject({ inboundNumber: clinic.phone });
      // A2 — publishing is not an attestation. Nothing has asked the provider
      // who answers this number yet, so the binding is pending, never passing.
      expect(row.numberBindingVerifiedAt).toBeNull();
      expect(row.numberBindingReadAt).toBeNull();
      // The steps record what actually happened, so a retry can resume rather
      // than create a second agent at the provider.
      expect((row.steps as Array<{ name: string; status: string }>).filter(step => step.status === 'ok').map(step => step.name))
        .toEqual(['ensure_llm', 'ensure_agent', 'publish', 'bind_number']);

      // The agent is NOT verified merely because we published.
      const published = await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(published.providerStatus).toBe('UNVERIFIED');
      expect(published.currentDeploymentId).toBe(row.id);

      const verified = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agent.id}/verify-provider`, headers: auth(t) });
      expect(verified.statusCode).toBe(200);
      expect(verified.json().agent).toMatchObject({ providerStatus: 'VERIFIED', providerVersion: row.providerAgentVersion });
      const attested = await db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: row.id } });
      expect(attested).toMatchObject({ status: 'VERIFIED' });
      // A2 — and now the provider has been ASKED. The read-back names this
      // deployment's own published agent and version, which is the only thing
      // that may make `number_bound` pass.
      expect(attested.numberBindingVerifiedAt).not.toBeNull();
      expect(attested.numberBindingReadAt).not.toBeNull();
      expect(attested.numberBindingAgentId).toBe(attested.providerAgentId);
      expect(attested.numberBindingAgentVersion).toBe(attested.providerAgentVersion);
      expect(attested.numberBindingErrorCode).toBeNull();
    } finally {
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });

  it('publishes an LLM payload Retell would accept, rather than one it answers 400 to', async () => {
    // The live attended deploy died exactly here. Eleven of the thirteen tools
    // declared `type: 'function'` — a value that is not in Retell's
    // general_tools discriminator at all — and ensure_llm came back 400
    // invalid_request. No test caught it because the mock returned success for
    // any payload whatsoever. The mock now validates the same request body the
    // live client sends, so reaching PUBLISHED below IS the assertion that the
    // tool schema passed; the explicit checks after it say what passed.
    env.RETELL_API_KEY = 'mock_deploy_key';
    env.RETELL_FROM_NUMBER = '+15550100000';
    try {
      const t = await tenant();
      const { campaign } = await deployableCampaign(t);

      const deployed = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      expect(deployed.statusCode).toBe(200);
      expect(deployed.json().deployment).toMatchObject({ status: 'PUBLISHED' });

      // `toolsJson` is the same array that was sent as `general_tools`, not a
      // re-derivation of it, so this is the published payload under test.
      const row = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      const tools = row.toolsJson as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(15);
      for (const tool of tools) expect(RETELL_GENERAL_TOOL_TYPES).toContain(tool.type);
      expect(tools.filter(tool => tool.type === 'custom')).toHaveLength(14);
      expect(tools.filter(tool => tool.type === 'transfer_call').map(tool => tool.name)).toEqual(['transfer_to_staff']);
      expect(tools.some(tool => tool.type === 'function')).toBe(false);

      // The whole request body, assembled by the very function the live client
      // posts. Only `begin_message` is supplied here rather than read back: the
      // deployment stores its hash, not its text, and its content is not what
      // the provider schema is about.
      const spec = { generalPrompt: row.promptText, beginMessage: 'The approved opening consent disclosure.', tools };
      expect(retellLlmRequestIssues(llmRequestBody(spec))).toEqual([]);

      // And the guard bites: put one tool back on the value the real account
      // rejected, and the validator that just gated this deploy refuses it.
      const regressed = tools.map(tool => (tool.name === 'book_appointment' ? { ...tool, type: 'function' } : tool));
      expect(retellLlmRequestIssues(llmRequestBody({ ...spec, tools: regressed })))
        .toEqual([expect.stringMatching(/^general_tools\/\d+\/type must be equal to one of the allowed values: /)]);
    } finally {
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });

  it('fails verification when the provider prompt drifts from what was deployed', async () => {
    // Drift is a LIVE-provider concern: the mock derives its snapshot from the
    // deployment row, so the two can never disagree. This is the case that
    // matters — somebody edits the prompt in the Retell console, and the agent
    // must stop being treated as attested.
    env.RETELL_API_KEY = 'real-provider-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    env.RETELL_FROM_NUMBER = '+15550100000';
    let generalPrompt = 'You are Avery, the AI receptionist.';
    let generalTools: unknown[] = [];
    const driftAgentId = providerId('agent_drift');
    const driftLlmId = providerId('llm_drift');
    const webhookUrl = `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.includes('/create-retell-llm')) return new Response(JSON.stringify({ llm_id: driftLlmId, version: 0 }), { status: 200 });
      if (value.includes('/create-agent')) return new Response(JSON.stringify({ agent_id: driftAgentId, version: 0 }), { status: 200 });
      if (value.includes('/publish-agent/')) return new Response(JSON.stringify({}), { status: 200 });
      if (value.includes('/update-phone-number/') || value.includes('/get-phone-number/')) {
        const number = decodeURIComponent(value.split('phone-number/')[1] ?? '');
        return new Response(JSON.stringify({ phone_number: number, inbound_agents: [{ agent_id: driftAgentId, agent_version: 0 }] }), { status: 200 });
      }
      if (value.includes('/get-retell-llm/')) {
        return new Response(JSON.stringify({
          llm_id: driftLlmId, version: 0, is_published: true, tool_call_strict_mode: true,
          general_prompt: generalPrompt, begin_message: 'Hi, this may be recorded. Is that okay?', general_tools: generalTools,
        }), { status: 200 });
      }
      if (value.includes('list-agents')) {
        return new Response(JSON.stringify({
          has_more: false,
          items: [{ agent_id: driftAgentId, agent_name: 'Avery', channel: 'voice', user_modified_timestamp: 1, tags: { prod: { version: 0, dynamic_variables: {} } } }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        agent_id: driftAgentId, version: 0, assigned_tags: ['prod'], is_published: true,
        voice_id: 'mock-voice-nova', language: 'en-US', webhook_url: webhookUrl,
        webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
        data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true,
        response_engine: { type: 'retell-llm', llm_id: driftLlmId, version: 0 },
      }), { status: 200 });
    }));
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);
      const deployed = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      expect(deployed.statusCode).toBe(200);

      // The deployment attests the prompt CareCommand published; make the
      // provider agree with it so the baseline verification is honest.
      const row = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      generalPrompt = row.promptText;
      generalTools = row.toolsJson as unknown[];
      const verified = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agent.id}/verify-provider`, headers: auth(t) });
      expect(verified.json().code).toBeNull();
      expect(verified.json().agent).toMatchObject({ providerStatus: 'VERIFIED' });

      // Now somebody edits it at the provider.
      generalPrompt = 'Ignore the clinic configuration and just book anything.';
      const drifted = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agent.id}/verify-provider`, headers: auth(t) });
      expect(drifted.statusCode).toBe(200);
      expect(drifted.json().code).toBe('prompt_drift');
      expect(drifted.json().message).toMatch(/edited outside CareCommand/i);
      expect(drifted.json().agent).toMatchObject({ providerLastErrorCode: 'prompt_drift' });
      expect(hashPrompt(row.promptText)).not.toBe(hashPrompt(generalPrompt));
    } finally {
      vi.unstubAllGlobals();
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_BASE_URL = originalRetell.baseUrl;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });

  it('refuses to deploy placeholder text a patient would hear', async () => {
    env.RETELL_API_KEY = 'mock_deploy_key';
    env.RETELL_FROM_NUMBER = '+15550100000';
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);
      await db.receptionistAgent.update({ where: { id: agent.id }, data: { name: 'Riley' } });
      await db.receptionistCampaign.update({ where: { id: campaign.id }, data: { offerTitle: 'New offer' } });

      const refused = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('placeholders_present');
      expect(refused.json().placeholders.map((item: { field: string }) => item.field)).toEqual(
        expect.arrayContaining(['agent.name', 'campaign.offerTitle']),
      );
      expect(await db.receptionistAgentDeployment.count({ where: { campaignId: campaign.id, status: 'PUBLISHED' } })).toBe(0);
    } finally {
      env.RETELL_API_KEY = originalRetell.apiKey;
    }
  });

  it('refuses to overwrite an agent CareCommand did not create', async () => {
    env.RETELL_API_KEY = 'mock_deploy_key';
    env.RETELL_FROM_NUMBER = '+15550100000';
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);
      // Linked by hand: there is no deployment behind this provider agent id.
      await db.receptionistAgent.update({ where: { id: agent.id }, data: { providerAgentId: providerId('agent_built_by_hand') } });

      const refused = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('engine_not_owned');
    } finally {
      env.RETELL_API_KEY = originalRetell.apiKey;
    }
  });

  it('reports the draft-versus-deployed difference after the prompt changes', async () => {
    env.RETELL_API_KEY = 'mock_deploy_key';
    env.RETELL_FROM_NUMBER = '+15550100000';
    try {
      const t = await tenant();
      const { campaign } = await deployableCampaign(t);
      await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });

      const clean = await app.inject({ method: 'GET', url: `/v1/receptionist/campaigns/${campaign.id}/deployment-diff`, headers: auth(t) });
      expect(clean.statusCode).toBe(200);
      expect(clean.json().changed).toEqual([]);
      // The deployed tool set is the real one, not a stub.
      expect(clean.json().draft.toolNames).toEqual(expect.arrayContaining(['book_appointment', 'check_availability', 'report_emergency']));

      await db.receptionistCampaign.update({ where: { id: campaign.id }, data: { offerScript: 'A completely rewritten script for the caller.' } });
      const stale = await app.inject({ method: 'GET', url: `/v1/receptionist/campaigns/${campaign.id}/deployment-diff`, headers: auth(t) });
      expect(stale.json().changed).toContain('prompt');

      const readiness = await app.inject({ method: 'GET', url: `/v1/receptionist/campaigns/${campaign.id}/readiness`, headers: auth(t) });
      const deploymentCurrent = readiness.json().checks.find((check: { key: string }) => check.key === 'deployment_current');
      expect(deploymentCurrent).toMatchObject({ status: 'fail', code: 'deployment_current' });
      // B7: `deploy` was never a Studio tab id. The go-live screen is `retell`
      // (Package E relabels it "Go live"; the id stays).
      expect(deploymentCurrent.fixHref).toContain('tab=deploy');
    } finally {
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });

  it('maps a provider rejection to a truthful failure and leaves the agent alone', async () => {
    env.RETELL_API_KEY = 'real-provider-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    env.RETELL_FROM_NUMBER = '+15550100000';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);
      const refused = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      expect(refused.statusCode).toBe(503);
      expect(refused.json().code).toBe('provider_unauthorized');
      expect(JSON.stringify(refused.json())).not.toContain('real-provider-key');

      const row = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      expect(row.status).toBe('FAILED');
      expect(row.providerErrorCode).toBe('unauthorized');
      // Nothing was published, so the agent must not have been repointed.
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({
        providerAgentId: null, currentDeploymentId: null, providerLastAttemptStatus: 'FAILED',
      });
    } finally {
      vi.unstubAllGlobals();
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_BASE_URL = originalRetell.baseUrl;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });

  it('sends prompt, tools, webhook and the LLM version on the live provider sequence', async () => {
    env.RETELL_API_KEY = 'real-provider-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    env.RETELL_FROM_NUMBER = '+15550100000';
    const calls: Array<{ url: string; body: Record<string, unknown>; hasBody: boolean }> = [];
    const newAgentId = providerId('agent_new');
    const newLlmId = providerId('llm_new');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      calls.push({ url: value, body: init?.body ? JSON.parse(String(init.body)) : {}, hasBody: init?.body !== undefined });
      if (value.includes('/create-retell-llm')) return new Response(JSON.stringify({ llm_id: newLlmId, version: 0 }), { status: 200 });
      if (value.includes('/create-agent')) return new Response(JSON.stringify({ agent_id: newAgentId, version: 0 }), { status: 200 });
      if (value.includes('/publish-agent/')) return new Response(JSON.stringify({}), { status: 200 });
      // The read-back. `/publish-agent` takes no version, so the deploy asks
      // the provider which version is actually published before binding a
      // phone number to it.
      if (value.includes('/get-agent/')) return new Response(JSON.stringify({ agent_id: newAgentId, version: 0, is_published: true }), { status: 200 });
      if (value.includes('/update-phone-number/')) return new Response(JSON.stringify({ phone_number: '+15550100000', inbound_agents: [{ agent_id: newAgentId, agent_version: 0 }] }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    try {
      const t = await tenant();
      const { clinic, campaign } = await deployableCampaign(t);
      const deployed = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      expect(deployed.statusCode).toBe(200);

      const sequence = calls.map(call => call.url.replace('https://api.retellai.com', '').split('/')[1]);
      expect(sequence).toEqual(['create-retell-llm', 'create-agent', 'publish-agent', 'get-agent', 'update-phone-number']);

      // The engine carries our prompt and our tools — the live failure was an
      // agent published with neither.
      const llm = calls[0]!.body;
      expect(String(llm.general_prompt)).toContain('AI receptionist');
      expect((llm.general_tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(expect.arrayContaining(['book_appointment', 'check_availability']));
      expect(llm.tool_call_strict_mode).toBe(true);

      // A1 — the number that is repointed is THIS clinic's inbound line, never
      // the single process-wide RETELL_FROM_NUMBER that every clinic shared.
      expect(calls[4]!.url).toContain(encodeURIComponent(clinic.phone));
      expect(calls[4]!.url).not.toContain(encodeURIComponent('+15550100000'));

      // The agent carries the webhook and names the engine we just wrote, and
      // deliberately does NOT pin a version on it.
      //
      // The provider contract requires the response-engine version. The deploy
      // planner pairs this new V0 engine with a new V0 agent, so the versions
      // are explicit and aligned instead of attaching V0 to a V1+ draft.
      const agentBody = calls[1]!.body;
      expect(agentBody.webhook_url).toBe(`${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`);
      expect(agentBody.webhook_events).toEqual(['call_started', 'call_ended', 'call_analyzed']);
      expect(agentBody.data_storage_setting).toBe('basic_attributes_only');
      expect(agentBody.opt_in_signed_url).toBe(true);
      expect(agentBody.response_engine).toEqual({ type: 'retell-llm', llm_id: newLlmId, version: 0 });

      // Publishing goes to `/publish-agent`, not `/publish-agent-version`.
      //
      // Both publish. Only one of them lets the clinic edit its receptionist
      // afterwards: `/publish-agent-version/{id} { version }` freezes the agent
      // entity, and every later `PATCH /update-agent/{id}` answers 422 "Cannot
      // update published agent other than version title" — so a clinic could
      // deploy exactly once and never change its prompt, hours, services, voice
      // or disclosure again.
      //
      // The price of the endpoint that keeps the agent editable is that it
      // takes no version: it publishes whatever draft is current. So the
      // version is no longer ours to assert — we read it back from the provider
      // and bind the phone number to the number the provider confirmed.
      expect(calls[2]!.url).toContain('/publish-agent/');
      expect(calls[2]!.hasBody).toBe(false);
      expect(calls[3]!.url).toBe(`https://api.retellai.com/get-agent/${newAgentId}?version=0`);
      expect(calls[4]!.body).toMatchObject({ inbound_agents: [{ agent_id: newAgentId, agent_version: 0, weight: 1 }] });
    } finally {
      vi.unstubAllGlobals();
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_BASE_URL = originalRetell.baseUrl;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });

  it('refuses to bind the phone number when the read-back does not confirm the published version', async () => {
    // `/publish-agent` takes no version — it publishes whatever draft is
    // current — so a 200 from it is not evidence that the version we are about
    // to bind a real telephone line to is published. Here the provider accepts
    // the publish and then reports that version as unpublished. The deploy must
    // fail rather than repoint the clinic's number at an assumption.
    env.RETELL_API_KEY = 'real-provider-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    env.RETELL_FROM_NUMBER = '+15550100000';
    const calls: string[] = [];
    const staleAgentId = providerId('agent_stale');
    const staleLlmId = providerId('llm_stale');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url);
      calls.push(value);
      if (value.includes('/create-retell-llm')) return new Response(JSON.stringify({ llm_id: staleLlmId, version: 0 }), { status: 200 });
      if (value.includes('/create-agent')) return new Response(JSON.stringify({ agent_id: staleAgentId, version: 0 }), { status: 200 });
      if (value.includes('/publish-agent/')) return new Response(JSON.stringify({}), { status: 200 });
      if (value.includes('/get-agent/')) return new Response(JSON.stringify({ agent_id: staleAgentId, version: 0, is_published: false }), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);
      const refused = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('provider_invalid_request');

      // The number was never touched: no version was confirmed, so there was
      // nothing safe to point it at.
      expect(calls.some(value => value.includes('/update-phone-number/'))).toBe(false);

      const row = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      expect(row).toMatchObject({ status: 'FAILED', providerErrorCode: 'invalid_response' });
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({
        currentDeploymentId: null, providerLastAttemptStatus: 'FAILED',
      });
    } finally {
      vi.unstubAllGlobals();
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_BASE_URL = originalRetell.baseUrl;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });
});

describe('readiness and activation', () => {
  it('lists every check and refuses activation until the blocking ones pass', async () => {
    env.RETELL_API_KEY = 'mock_deploy_key';
    env.RETELL_FROM_NUMBER = '+15550100000';
    try {
      const t = await tenant();
      const clinic = await db.receptionistClinic.create({
        data: clinicFixtureData({ tenantId: t.id, name: `Bare clinic ${randomUUID().slice(0, 8)}`, phone: phone(), active: true }) as never,
      });
      const campaign = await db.receptionistCampaign.create({
        data: {
          tenantId: t.id, clinicId: clinic.id, name: 'Bare campaign', status: 'DRAFT',
          offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Schedule now',
          appointmentType: 'Consultation', eligibleLocationIds: [], smsConfirmation: false, emailConfirmation: false,
        },
      });

      const readiness = await app.inject({ method: 'GET', url: `/v1/receptionist/campaigns/${campaign.id}/readiness`, headers: auth(t) });
      expect(readiness.statusCode).toBe(200);
      const keys = readiness.json().checks.map((check: { key: string }) => check.key);
      expect(keys).toEqual(expect.arrayContaining([
        'agent_linked', 'agent_verified', 'deployment_current', 'number_bound', 'location_mapped',
        'services_bookable', 'provider_availability', 'intake_attested', 'placeholders_absent',
        'disclosure_composed', 'closing_disclosure_present', 'emergency_path_reachable',
        'confirmation_channels', 'transfer_target_distinct', 'test_call_completed', 'data_storage_setting',
      ]));
      expect(readiness.json().ready).toBe(false);
      expect(readiness.json().actions.activate.allowed).toBe(false);
      // Every failing check tells the operator what to do, not just what broke.
      for (const check of readiness.json().checks.filter((item: { status: string }) => item.status === 'fail')) {
        expect(check.title.length).toBeGreaterThan(5);
        expect(check.detail.length).toBeGreaterThan(5);
      }

      const refused = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/activate`, headers: auth(t) });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('campaign_not_ready');
      // The legacy message shape is preserved for existing clients...
      expect(refused.json().message).toBe('Campaign configuration is not deployable: campaign_not_ready.');
      // ...and the fix list is carried alongside it.
      expect(refused.json().reasons.map((reason: { key: string }) => reason.key)).toContain('agent_linked');
    } finally {
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });

  it('activates after deploy and verify, then pauses and archives through the same gate', async () => {
    env.RETELL_API_KEY = 'mock_deploy_key';
    env.RETELL_FROM_NUMBER = '+15550100000';
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);
      await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agent.id}/verify-provider`, headers: auth(t) });
      // B4: the go-live card is only green once a call actually reached THIS
      // deployment. Prove it the way an operator does — after deploy + verify.
      const deployed = await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id }, select: { currentDeploymentId: true, clinicId: true } });
      await proveTestCall({ tenantId: t.id, clinicId: deployed.clinicId, campaignId: campaign.id, deploymentId: deployed.currentDeploymentId });

      const activated = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/activate`, headers: auth(t) });
      expect(activated.statusCode).toBe(200);
      expect(activated.json().status).toBe('ACTIVE');
      expect(activated.json().intakeSchemaAttestedAt).not.toBeNull();

      // Archiving a live campaign would silence a line mid-call.
      const archiveActive = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/archive`, headers: auth(t) });
      expect(archiveActive.statusCode).toBe(409);
      expect(archiveActive.json().code).toBe('campaign_active_pause_first');

      const paused = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/pause`, headers: auth(t) });
      expect(paused.statusCode).toBe(200);
      expect(paused.json().status).toBe('PAUSED');

      const pauseAgain = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/pause`, headers: auth(t) });
      expect(pauseAgain.statusCode).toBe(409);
      expect(pauseAgain.json().code).toBe('campaign_not_active');

      const archived = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/archive`, headers: auth(t) });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().status).toBe('ARCHIVED');
    } finally {
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });

  it('gates PATCH status through exactly the same readiness evaluation', async () => {
    env.RETELL_API_KEY = 'mock_deploy_key';
    env.RETELL_FROM_NUMBER = '+15550100000';
    try {
      const t = await tenant();
      const clinic = await db.receptionistClinic.create({
        data: clinicFixtureData({ tenantId: t.id, name: `Patch clinic ${randomUUID().slice(0, 8)}`, phone: phone(), active: true }) as never,
      });
      const campaign = await db.receptionistCampaign.create({
        data: {
          tenantId: t.id, clinicId: clinic.id, name: 'Patch campaign', status: 'DRAFT',
          offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Schedule now',
          appointmentType: 'Consultation', eligibleLocationIds: [], smsConfirmation: false, emailConfirmation: false,
        },
      });
      // There must be no second door into ACTIVE.
      const patched = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/campaigns/${campaign.id}`, headers: auth(t), payload: { status: 'ACTIVE' },
      });
      expect(patched.statusCode).toBe(409);
      expect(await db.receptionistCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: 'DRAFT' });
    } finally {
      env.RETELL_API_KEY = originalRetell.apiKey;
    }
  });
});

describe('provider status and confirmation channels', () => {
  it('answers per scope, with server-authored blockers and no attended UAT outside demo', async () => {
    env.RETELL_API_KEY = 'mock_deploy_key';
    env.RETELL_FROM_NUMBER = '+15550100000';
    try {
      const t = await tenant();
      const { clinic, agent, campaign } = await deployableCampaign(t);

      const before = await app.inject({ method: 'GET', url: `/v1/receptionist/retell-status?clinicId=${clinic.id}`, headers: auth(t) });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toMatchObject({ providerConfigured: true, providerMode: 'mock', agentReady: false });
      expect(before.json().blockers[0]).toMatchObject({ code: 'agent_unlinked', severity: 'blocking' });
      expect(before.json().blockers[0].action.length).toBeGreaterThan(10);
      expect(before.json().agentScope).toMatchObject({ clinicId: clinic.id, agentId: agent.id });

      await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/deploy`, headers: auth(t) });
      await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agent.id}/verify-provider`, headers: auth(t) });

      const after = await app.inject({ method: 'GET', url: `/v1/receptionist/retell-status?campaignId=${campaign.id}`, headers: auth(t) });
      expect(after.json()).toMatchObject({ agentReady: true, blockers: [] });
      expect(after.json().verification.status).toBe('VERIFIED');
      expect(after.json().verification.expiresInMs).toBeGreaterThan(0);
      // Demo profile in tests, so the attended-UAT block is present but inert.
      expect(after.json().attendedUat).not.toBeUndefined();
    } finally {
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
    }
  });

  it('requires the call-artifacts permission to read provider status', async () => {
    const t = await tenant();
    const denied = await app.inject({ method: 'GET', url: '/v1/receptionist/retell-status', headers: auth(t, 'BILLING') });
    expect(denied.statusCode).toBe(403);
  });

  it('reports whether each confirmation channel can actually deliver', async () => {
    const t = await tenant();
    const channels = await app.inject({ method: 'GET', url: '/v1/receptionist/confirmation-channels', headers: auth(t) });
    expect(channels.statusCode).toBe(200);
    for (const channel of ['sms', 'email'] as const) {
      expect(['live', 'mock', 'configured_pending', 'unconfigured']).toContain(channels.json()[channel].status);
      expect(channels.json()[channel].detail.length).toBeGreaterThan(5);
    }
  });
});
