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

// ===========================================================================
// Deploy integrity — Package A.
//
// The suite that would have caught the seven defects in the register. Each
// test below fails on the parent commit and is the reason the corresponding
// fix exists, so the assertions are about the SPECIFIC harm, not about a
// request having returned the right status code.
//
// The one that matters most is the first. Every deploy used to bind one
// process-wide `env.RETELL_FROM_NUMBER`, so the second clinic's deploy
// silently repointed the first clinic's line — callers to A reached B's agent,
// B's hours and B's disclosure, bookings landed in B's branch, and BOTH
// clinics' checklists read `number_bound = pass`, because the check read a
// column we had written ourselves.
// ===========================================================================

type Role = 'OWNER' | 'MANAGER';
type TenantFixture = { id: string; users: Record<Role, string>; branchId: string };
const tenantIds: string[] = [];
let app: FastifyInstance;
const originalRetell = { apiKey: env.RETELL_API_KEY, baseUrl: env.RETELL_BASE_URL, fromNumber: env.RETELL_FROM_NUMBER };

const phone = () => `+1${(BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;
/** Per-test provider ids: `ReceptionistAgent_active_provider_deployment_unique` is global. */
const providerId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

async function tenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Integrity ${id.slice(0, 8)}`, slug: `integrity-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const users = {} as Record<Role, string>;
  for (const role of ['OWNER', 'MANAGER'] as const) {
    const row = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role.toLowerCase()}-${id.slice(0, 8)}@integrity.test`, displayName: role },
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

/** A clinic, agent and campaign readiness would accept — one per clinic. */
async function deployableCampaign(t: TenantFixture, label = 'Front desk') {
  const clinic = await db.receptionistClinic.create({
    data: clinicFixtureData({
      tenantId: t.id, name: `Clinic ${randomUUID().slice(0, 8)}`, phone: phone(),
      humanFallbackNumber: phone(), timezone: 'America/New_York', active: true,
    }) as never,
  });
  const agent = await db.receptionistAgent.create({
    data: { tenantId: t.id, clinicId: clinic.id, name: `Avery ${randomUUID().slice(0, 4)}`, voice: 'mock-voice-nova', language: 'en-US', active: true },
  });
  const campaign = await db.receptionistCampaign.create({
    data: {
      tenantId: t.id, clinicId: clinic.id, agentId: agent.id,
      name: label, campaignType: 'Inbound reception', status: 'DRAFT',
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
  await readyCampaignFixture({
    tenantId: t.id, clinicId: clinic.id, campaignId: campaign.id, branchId: t.branchId,
    appointmentType: 'New patient consultation', agentId: agent.id,
  });
  return { clinic, agent, campaign };
}

const deploy = (t: TenantFixture, campaignId: string) =>
  app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaignId}/deploy`, headers: auth(t) });
const verify = (t: TenantFixture, agentId: string) =>
  app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agentId}/verify-provider`, headers: auth(t) });

function useMockProvider() {
  env.RETELL_API_KEY = 'mock_integrity_key';
  env.RETELL_FROM_NUMBER = '+15550100000';
}

function restoreProvider() {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  vi.unstubAllGlobals();
}

/**
 * A live Retell account, stubbed. `binding` is what `/get-phone-number` reports
 * — the whole point of A2 is that this can disagree with what we wrote, so the
 * test has to be able to make it disagree.
 */
function stubLiveProvider(options: {
  agentId: string;
  llmId: string;
  prompt: () => string;
  tools: () => unknown[];
  binding: () => { agentId: string | null; version: number | null } | 'unavailable';
}) {
  env.RETELL_API_KEY = 'real-provider-key';
  env.RETELL_BASE_URL = 'https://api.retellai.com';
  env.RETELL_FROM_NUMBER = '+15550100000';
  const webhookUrl = `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const value = String(url);
    calls.push(value.replace('https://api.retellai.com', ''));
    if (value.includes('/create-retell-llm') || value.includes('/update-retell-llm')) {
      return new Response(JSON.stringify({ llm_id: options.llmId, version: 0 }), { status: 200 });
    }
    if (value.includes('/create-agent') || value.includes('/update-agent')) {
      return new Response(JSON.stringify({ agent_id: options.agentId, version: 0 }), { status: 200 });
    }
    if (value.includes('/publish-agent-version/')) return new Response(JSON.stringify({}), { status: 200 });
    if (value.includes('/update-phone-number/')) {
      const number = decodeURIComponent(value.split('phone-number/')[1] ?? '');
      return new Response(JSON.stringify({ phone_number: number, inbound_agents: [{ agent_id: options.agentId, agent_version: 0 }] }), { status: 200 });
    }
    if (value.includes('/get-phone-number/')) {
      const answer = options.binding();
      if (answer === 'unavailable') return new Response('upstream is down', { status: 503 });
      const number = decodeURIComponent(value.split('phone-number/')[1] ?? '');
      return new Response(JSON.stringify({
        phone_number: number,
        inbound_agents: answer.agentId ? [{ agent_id: answer.agentId, agent_version: answer.version }] : [],
      }), { status: 200 });
    }
    if (value.includes('/get-retell-llm/')) {
      return new Response(JSON.stringify({
        llm_id: options.llmId, version: 0, is_published: true, tool_call_strict_mode: true,
        general_prompt: options.prompt(), begin_message: 'Hi, this may be recorded. Is that okay?', general_tools: options.tools(),
      }), { status: 200 });
    }
    if (value.includes('list-agents')) {
      return new Response(JSON.stringify({
        has_more: false,
        items: [{ agent_id: options.agentId, agent_name: 'Avery', channel: 'voice', user_modified_timestamp: 1, tags: { prod: { version: 0, dynamic_variables: {} } } }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      agent_id: options.agentId, version: 0, assigned_tags: ['prod'], is_published: true,
      voice_id: 'mock-voice-nova', language: 'en-US', webhook_url: webhookUrl,
      webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
      data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true,
      response_engine: { type: 'retell-llm', llm_id: options.llmId, version: 0 },
    }), { status: 200 });
  }));
  return calls;
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  restoreProvider();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app.close();
  await db.$disconnect();
});

describe('A1 — the line belongs to the clinic', () => {
  it('gives each clinic its own inbound number instead of both deploys fighting over one', async () => {
    useMockProvider();
    try {
      const t = await tenant();
      const first = await deployableCampaign(t, 'Northside front desk');
      const second = await deployableCampaign(t, 'Southside front desk');
      expect(first.clinic.phone).not.toBe(second.clinic.phone);

      expect((await deploy(t, first.campaign.id)).statusCode).toBe(200);
      expect((await deploy(t, second.campaign.id)).statusCode).toBe(200);

      const rows = await db.receptionistAgentDeployment.findMany({
        where: { tenantId: t.id, status: 'PUBLISHED' },
        select: { clinicId: true, boundPhoneNumber: true, numberBound: true },
      });
      expect(rows).toHaveLength(2);
      const bound = new Map(rows.map(row => [row.clinicId, row.boundPhoneNumber]));
      expect(bound.get(first.clinic.id)).toBe(first.clinic.phone);
      expect(bound.get(second.clinic.id)).toBe(second.clinic.phone);
      // The defect in one line: these used to be the same string.
      expect(bound.get(first.clinic.id)).not.toBe(bound.get(second.clinic.id));
      expect(rows.every(row => row.numberBound)).toBe(true);

      // And the first clinic's line still answers with the first clinic's
      // agent after the second clinic deployed — which is the harm, not the
      // column value.
      expect((await verify(t, first.agent.id)).statusCode).toBe(200);
      const firstDeployment = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { tenantId: t.id, clinicId: first.clinic.id } });
      expect(firstDeployment.numberBindingVerifiedAt).not.toBeNull();
      expect(firstDeployment.numberBindingAgentId).toBe(firstDeployment.providerAgentId);
    } finally {
      restoreProvider();
    }
  });

  it('refuses to rebind a number a live deployment already owns', async () => {
    useMockProvider();
    try {
      const t = await tenant();
      const holder = await deployableCampaign(t, 'Holder');
      const claimant = await deployableCampaign(t, 'Claimant');
      expect((await deploy(t, holder.campaign.id)).statusCode).toBe(200);

      // The holder is retired from the directory, but its deployment is still
      // published at the provider and still answering that line. Somebody now
      // points the second clinic at the same number.
      await db.receptionistClinic.update({ where: { id: holder.clinic.id }, data: { active: false } });
      await db.receptionistClinic.update({ where: { id: claimant.clinic.id }, data: { inboundNumber: holder.clinic.phone } });

      const refused = await deploy(t, claimant.campaign.id);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('inbound_number_conflict');
      expect(refused.json().message).toMatch(/one number cannot answer for two clinics/i);
      // Nothing was published, so the holder's line is untouched.
      expect(await db.receptionistAgentDeployment.count({ where: { tenantId: t.id, clinicId: claimant.clinic.id, status: 'PUBLISHED' } })).toBe(0);
      const holderRow = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { tenantId: t.id, clinicId: holder.clinic.id } });
      expect(holderRow.boundPhoneNumber).toBe(holder.clinic.phone);
      expect(holderRow.numberBound).toBe(true);
    } finally {
      restoreProvider();
    }
  });
});

describe('A2 — number_bound is attested, not asserted', () => {
  it('reports the line as no longer ours when the provider says somebody else answers it', async () => {
    const agentId = providerId('agent_readback');
    const llmId = providerId('llm_readback');
    let prompt = 'placeholder, replaced below with what was actually deployed';
    let tools: unknown[] = [];
    let owner: { agentId: string | null; version: number | null } = { agentId, version: 0 };
    const calls = stubLiveProvider({ agentId, llmId, prompt: () => prompt, tools: () => tools, binding: () => owner });
    try {
      const t = await tenant();
      const { agent, campaign, clinic } = await deployableCampaign(t);
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);
      const row = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      prompt = row.promptText;
      tools = row.toolsJson as unknown[];

      const verified = await verify(t, agent.id);
      expect(verified.json().code).toBeNull();
      // `getPhoneNumberBinding` had zero callers in the tree. It has one now,
      // and it is asking about the clinic's own line.
      expect(calls.some(call => call.startsWith(`/get-phone-number/${encodeURIComponent(clinic.phone)}`))).toBe(true);
      const attested = await db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: row.id } });
      expect(attested.numberBindingVerifiedAt).not.toBeNull();
      expect(attested.numberBound).toBe(true);

      // Now somebody repoints the number in the Retell dashboard. Nothing about
      // the agent changed, so every previous signal stays green — and the line
      // is dead. This is REC-P0-001.
      owner = { agentId: providerId('agent_somebody_else'), version: 3 };
      const rechecked = await verify(t, agent.id);
      expect(rechecked.statusCode).toBe(200);
      expect(rechecked.json().agent.providerStatus).toBe('VERIFIED');

      const moved = await db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: row.id } });
      expect(moved.numberBound).toBe(false);
      expect(moved.numberBindingVerifiedAt).toBeNull();
      expect(moved.numberBindingErrorCode).toBe('number_bound_elsewhere');
      expect(moved.numberBindingAgentId).not.toBe(moved.providerAgentId);
      // The read happened, so we know WHEN we learned it.
      expect(moved.numberBindingReadAt).not.toBeNull();
    } finally {
      restoreProvider();
    }
  });

  it('treats an unreadable binding as pending, never as a pass and never as a wrong number', async () => {
    const agentId = providerId('agent_unreadable');
    const llmId = providerId('llm_unreadable');
    let prompt = 'placeholder';
    let tools: unknown[] = [];
    let answer: { agentId: string | null; version: number | null } | 'unavailable' = { agentId, version: 0 };
    stubLiveProvider({ agentId, llmId, prompt: () => prompt, tools: () => tools, binding: () => answer });
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);
      const row = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      prompt = row.promptText;
      tools = row.toolsJson as unknown[];
      await verify(t, agent.id);
      expect((await db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: row.id } })).numberBindingVerifiedAt).not.toBeNull();

      answer = 'unavailable';
      await verify(t, agent.id);
      const unreadable = await db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: row.id } });
      // Not a pass: the attestation is gone, so readiness must show pending.
      expect(unreadable.numberBindingVerifiedAt).toBeNull();
      expect(unreadable.numberBindingErrorCode).toBe('provider_unavailable');
      // And not a fail either. A provider outage is not "your number is wrong",
      // and telling an operator it is sends them to fix something that is not
      // broken — so the last thing we actually knew is left standing.
      expect(unreadable.numberBound).toBe(true);
      expect(unreadable.numberBindingAgentId).toBe(unreadable.providerAgentId);
    } finally {
      restoreProvider();
    }
  });
});

describe('A4 — a live campaign is not degraded without being asked', () => {
  it('refuses to redeploy while the campaign is active and answering', async () => {
    useMockProvider();
    try {
      const t = await tenant();
      const { agent, campaign, clinic } = await deployableCampaign(t);
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);
      expect((await verify(t, agent.id)).statusCode).toBe(200);
      // `test_call_completed` is blocking and scoped to this deployment (B4),
      // so the campaign only reaches ACTIVE once a caller has actually
      // reached this version of the line.
      const deployment = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id, status: 'VERIFIED' } });
      await proveTestCall({ tenantId: t.id, clinicId: clinic.id, campaignId: campaign.id, deploymentId: deployment.id });
      const activated = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/activate`, headers: auth(t) });
      expect(activated.statusCode).toBe(200);

      // A redeploy flips the agent to UNVERIFIED, and the runtime gate then
      // drops every caller to the five safe tools until verification lands.
      const refused = await deploy(t, campaign.id);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('campaign_active_deploy_blocked');
      expect(refused.json().message).toMatch(/pause the campaign/i);
      // The live agent is untouched: still attested, still answering.
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({ providerStatus: 'VERIFIED' });

      // Pausing is the documented way through, and it works.
      expect((await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/pause`, headers: auth(t) })).statusCode).toBe(200);
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);
    } finally {
      restoreProvider();
    }
  });
});

describe('A5 — a failed deploy does not leak the engine it created', () => {
  it('keeps the response engine it made and updates it on the retry', async () => {
    const agentId = providerId('agent_retry');
    const llmId = providerId('llm_retry');
    env.RETELL_API_KEY = 'real-provider-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    env.RETELL_FROM_NUMBER = '+15550100000';
    let agentStepFails = true;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url).replace('https://api.retellai.com', '');
      calls.push(value);
      if (value.startsWith('/create-retell-llm') || value.startsWith('/update-retell-llm')) {
        return new Response(JSON.stringify({ llm_id: llmId, version: value.startsWith('/update') ? 1 : 0 }), { status: 200 });
      }
      if (value.startsWith('/create-agent')) {
        if (agentStepFails) return new Response('upstream is down', { status: 503 });
        return new Response(JSON.stringify({ agent_id: agentId, version: 0 }), { status: 200 });
      }
      if (value.startsWith('/publish-agent-version/')) return new Response(JSON.stringify({}), { status: 200 });
      if (value.startsWith('/update-phone-number/')) {
        const number = decodeURIComponent(value.split('phone-number/')[1] ?? '');
        return new Response(JSON.stringify({ phone_number: number, inbound_agents: [{ agent_id: agentId, agent_version: 0 }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    try {
      const t = await tenant();
      const { campaign } = await deployableCampaign(t);

      const failed = await deploy(t, campaign.id);
      expect(failed.statusCode).toBe(503);
      // The engine exists at Retell whether or not we remember it, so we
      // remember it. Forgetting is what minted a fresh orphan on every retry —
      // twenty an hour per tenant at the configured deploy limit.
      const failedRow = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      expect(failedRow.status).toBe('FAILED');
      expect(failedRow.providerLlmId).toBe(llmId);
      expect(failedRow.providerLlmVersion).toBe(0);

      agentStepFails = false;
      calls.length = 0;
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);
      // The retry UPDATES the engine it already owns rather than creating a
      // second one, so the response-engine id stops churning on every deploy.
      expect(calls.some(call => call.startsWith(`/update-retell-llm/${llmId}`))).toBe(true);
      expect(calls.some(call => call.startsWith('/create-retell-llm'))).toBe(false);
      const engines = await db.receptionistAgentDeployment.findMany({
        where: { campaignId: campaign.id, providerLlmId: { not: null } },
        select: { providerLlmId: true },
      });
      expect(new Set(engines.map(row => row.providerLlmId)).size).toBe(1);
    } finally {
      restoreProvider();
    }
  });
});

describe('a published engine is frozen, so the next deploy makes a new one', () => {
  it('creates a fresh response engine once the prior deployment was published', async () => {
    // Confirmed against the live provider on 2026-08-30: PATCHing the engine of
    // a published deployment answers `400 Cannot update published LLM`, which
    // our provider layer reports as the generic `invalid_request`. The prior
    // engine was chosen without regard to publication, so EVERY deploy after
    // the first successful one failed at ensure_llm, permanently — a clinic
    // could publish once and then never change its prompt, hours, services or
    // disclosure again.
    const agentId = providerId('agent_pub');
    const firstLlm = providerId('llm_pub_one');
    const secondLlm = providerId('llm_pub_two');
    env.RETELL_API_KEY = 'real-provider-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    env.RETELL_FROM_NUMBER = '+15550100000';
    let createdEngines = 0;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const value = String(url).replace('https://api.retellai.com', '');
      calls.push(value);
      if (value.startsWith('/create-retell-llm')) {
        createdEngines += 1;
        return new Response(JSON.stringify({ llm_id: createdEngines === 1 ? firstLlm : secondLlm, version: 0 }), { status: 200 });
      }
      if (value.startsWith('/update-retell-llm/')) {
        // The provider's real answer for an engine that has been published.
        return new Response(JSON.stringify({ status: 'error', message: 'Cannot update published LLM' }), { status: 400 });
      }
      if (value.startsWith('/create-agent') || value.startsWith('/update-agent/')) {
        return new Response(JSON.stringify({ agent_id: agentId, version: 0 }), { status: 200 });
      }
      if (value.startsWith('/publish-agent-version/')) return new Response(JSON.stringify({}), { status: 200 });
      if (value.startsWith('/update-phone-number/')) {
        const number = decodeURIComponent(value.split('phone-number/')[1] ?? '');
        return new Response(JSON.stringify({ phone_number: number, inbound_agents: [{ agent_id: agentId, agent_version: 0 }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    try {
      const t = await tenant();
      const { campaign } = await deployableCampaign(t);

      expect((await deploy(t, campaign.id)).statusCode).toBe(200);
      const published = await db.receptionistAgentDeployment.findFirstOrThrow({ where: { campaignId: campaign.id } });
      expect(published.publishedAt).not.toBeNull();
      expect(published.providerLlmId).toBe(firstLlm);

      calls.length = 0;
      // The second deploy must not touch the frozen engine.
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);
      expect(calls.some(call => call.startsWith('/update-retell-llm/'))).toBe(false);
      expect(calls.some(call => call.startsWith('/create-retell-llm'))).toBe(true);
      expect(createdEngines).toBe(2);
    } finally {
      restoreProvider();
    }
  });
});

describe('the agent write never pins an engine version', () => {
  it('omits response_engine.version so the provider aligns it with the agent version', async () => {
    // Retell answers `400 Response engine version must match agent version`
    // when `response_engine.version` is not the AGENT version being written.
    // Pinning the engine's own version was correct only by coincidence — on a
    // first deploy both are 0. Once a published agent at version 1 takes a
    // freshly created engine at version 0 (exactly what the published-engine
    // fix produces), every agent write failed. Confirmed against the live
    // provider on 2026-08-30.
    const agentId = providerId('agent_ver');
    const llmId = providerId('llm_ver');
    env.RETELL_API_KEY = 'real-provider-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    env.RETELL_FROM_NUMBER = '+15550100000';
    const agentWrites: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: { body?: string }) => {
      const value = String(url).replace('https://api.retellai.com', '');
      if (value.startsWith('/create-retell-llm') || value.startsWith('/update-retell-llm/')) {
        return new Response(JSON.stringify({ llm_id: llmId, version: 0 }), { status: 200 });
      }
      if (value.startsWith('/create-agent') || value.startsWith('/update-agent/')) {
        agentWrites.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
        return new Response(JSON.stringify({ agent_id: agentId, version: 1 }), { status: 200 });
      }
      if (value.startsWith('/publish-agent-version/')) return new Response(JSON.stringify({}), { status: 200 });
      if (value.startsWith('/update-phone-number/')) {
        const number = decodeURIComponent(value.split('phone-number/')[1] ?? '');
        return new Response(JSON.stringify({ phone_number: number, inbound_agents: [{ agent_id: agentId, agent_version: 1 }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    try {
      const t = await tenant();
      const { campaign } = await deployableCampaign(t);
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);

      expect(agentWrites.length).toBeGreaterThan(0);
      for (const body of agentWrites) {
        const engine = body.response_engine as Record<string, unknown>;
        expect(engine.llm_id).toBe(llmId);
        expect(engine.type).toBe('retell-llm');
        // The engine we just wrote, with the version left to the provider.
        expect(engine).not.toHaveProperty('version');
      }
    } finally {
      restoreProvider();
    }
  });
});

describe('A6 — two deploys of one agent do not both win', () => {
  it('serialises concurrent deploys and refuses to adopt the loser', async () => {
    useMockProvider();
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);

      const [a, b] = await Promise.all([deploy(t, campaign.id), deploy(t, campaign.id)]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(loser.json().code).toBe('concurrent_change');

      // Exactly one deployment is adopted, and the agent points at it. Both
      // used to commit, leaving `currentDeploymentId` on one version while the
      // provider's binding could be the other's.
      const published = await db.receptionistAgentDeployment.findMany({
        where: { tenantId: t.id, agentId: agent.id, status: { in: ['PUBLISHED', 'VERIFIED'] } },
        select: { id: true },
      });
      expect(published).toHaveLength(1);
      const row = await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(row.currentDeploymentId).toBe(published[0]!.id);
      // The revision moved, which is what let the loser's own commit notice.
      expect(row.providerConfigRevision).toBeGreaterThan(1);
    } finally {
      restoreProvider();
    }
  });
});

describe('a version-tag edit does not throw away the version we published', () => {
  it('keeps the deployment pin when only the tag changes', async () => {
    // Observed in production. Editing ONLY `providerVersionTag` nulled
    // `currentDeploymentId`, which is where the numeric version pin lives. An
    // unpinned probe then asks Retell for `?version=<tag>` and gets 404 — Retell
    // exposes no public tag-assignment write, so CareCommand can never create
    // that tag. A healthy published v0 deployment went straight to `not_found`
    // and could never verify again by any route.
    //
    // The agent-id case in A7 below is unaffected and still nulls the pointer:
    // there the deployment really does describe a different provider agent.
    useMockProvider();
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);

      const deployed = await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(deployed.currentDeploymentId).not.toBeNull();
      const published = await db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: deployed.currentDeploymentId! } });
      // Version 0 is the normal published version, so this also guards against
      // anyone reintroducing a falsy-zero check on the pin.
      expect(published.providerAgentVersion).toBe(0);

      const retagged = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/agents/${agent.id}`, headers: auth(t),
        payload: { providerVersionTag: 'carecommand' },
      });
      expect(retagged.statusCode).toBe(200);
      // The pin survives — same deployment, same published version.
      expect(retagged.json().currentDeploymentId).toBe(deployed.currentDeploymentId);
      // Re-attestation is still forced, which is what a tag edit does warrant.
      expect(retagged.json().providerStatus).toBe('UNVERIFIED');
      expect(retagged.json().providerConfigRevision).toBeGreaterThan(deployed.providerConfigRevision);
    } finally {
      restoreProvider();
    }
  });
});

describe('A7 — ownership is about this provider agent, not about any row', () => {
  it('refuses the second deploy after the binding is relinked to a hand-built agent', async () => {
    useMockProvider();
    try {
      const t = await tenant();
      const { agent, campaign } = await deployableCampaign(t);
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);

      // Deploy once, then relink to somebody's hand-built agent. A deployment
      // row now exists, which is all the old guard ever asked — so the next
      // deploy would have PATCHed and republished an agent we did not create.
      const strangersAgent = providerId('agent_built_by_hand');
      const relinked = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/agents/${agent.id}`, headers: auth(t),
        payload: { providerAgentId: strangersAgent },
      });
      expect(relinked.statusCode).toBe(200);
      // The deployment we published describes the OLD provider agent, so it is
      // no longer this agent's current deployment.
      expect(relinked.json().currentDeploymentId).toBeNull();

      const refused = await deploy(t, campaign.id);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('engine_not_owned');
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } }))
        .toMatchObject({ providerAgentId: strangersAgent });
    } finally {
      restoreProvider();
    }
  });
});

describe('the second deploy of a line that is already live', () => {
  it('deploys, verifies, deploys again and verifies again', async () => {
    // No test in this repo had ever deployed twice AND verified twice. That is
    // the shape of every second-deploy defect we shipped this week — the frozen
    // response engine, the pinned engine version, the tag that was never
    // assigned — each one invisible to a suite whose deployments were all
    // first deployments. A clinic edits its hours and redeploys; that is the
    // ordinary case, not an edge one, so it is covered as four steps that all
    // have to succeed.
    //
    // Against the simulated provider, which now models what Retell does on a
    // republish: a published response engine is frozen and refuses an update,
    // and a published agent VERSION cannot be rewritten in place.
    useMockProvider();
    try {
      const t = await tenant();
      const { agent, campaign, clinic } = await deployableCampaign(t);

      // ---- 1. deploy -------------------------------------------------------
      expect((await deploy(t, campaign.id)).statusCode).toBe(200);
      const first = await db.receptionistAgentDeployment.findFirstOrThrow({
        where: { campaignId: campaign.id }, orderBy: { startedAt: 'desc' },
      });
      expect(first.status).toBe('PUBLISHED');
      expect(first.providerAgentVersion).toBe(0);

      // ---- 2. verify -------------------------------------------------------
      const firstVerify = await verify(t, agent.id);
      expect(firstVerify.statusCode).toBe(200);
      expect(firstVerify.json().code).toBeNull();
      expect(firstVerify.json().agent.providerStatus).toBe('VERIFIED');
      expect((await db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('VERIFIED');

      // The clinic changes what the receptionist says, which is the reason a
      // second deploy exists at all. The prompt genuinely differs from here on.
      await db.receptionistCampaign.update({
        where: { id: campaign.id },
        data: { offerScript: 'We have moved to late appointments on Thursdays; I can book you one now.' },
      });

      // ---- 3. deploy again -------------------------------------------------
      const second = await deploy(t, campaign.id);
      expect(second.statusCode).toBe(200);
      const republished = await db.receptionistAgentDeployment.findFirstOrThrow({
        where: { campaignId: campaign.id }, orderBy: { startedAt: 'desc' },
      });
      expect(republished.id).not.toBe(first.id);
      expect(republished.status).toBe('PUBLISHED');
      // Same agent, next version — and a NEW response engine, because
      // publishing froze the previous one. Updating it would have been refused
      // by the simulation exactly as the live account refuses it.
      expect(republished.providerAgentId).toBe(first.providerAgentId);
      expect(republished.providerAgentVersion).toBe(1);
      expect(republished.providerLlmId).not.toBe(first.providerLlmId);
      // A second deploy is a real change, not a re-publish of the same words.
      expect(republished.promptHash).not.toBe(first.promptHash);
      expect(republished.boundPhoneNumber).toBe(clinic.phone);
      // The first deployment stops being current the moment the second lands.
      expect((await db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('SUPERSEDED');

      // ---- 4. verify again -------------------------------------------------
      const secondVerify = await verify(t, agent.id);
      expect(secondVerify.statusCode).toBe(200);
      expect(secondVerify.json().code).toBeNull();
      expect(secondVerify.json().agent.providerStatus).toBe('VERIFIED');

      const attested = await db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: republished.id } });
      expect(attested.status).toBe('VERIFIED');
      expect(attested.providerErrorCode).toBeNull();
      // The line answers with the version we just published, read back rather
      // than asserted.
      expect(attested.numberBindingVerifiedAt).not.toBeNull();
      expect(attested.numberBindingAgentVersion).toBe(1);

      const row = await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(row.currentDeploymentId).toBe(republished.id);
      expect(row.providerStatus).toBe('VERIFIED');
      expect(row.providerVersion).toBe(1);
      // A deployment CareCommand made is routed by number, so the row is a
      // pinned attestation; the CHECK constraint accepts it without a tag.
      expect(row.providerVersionPinned).toBe(true);
      expect(row.providerVerifiedRevision).toBe(row.providerConfigRevision);
      // And the attested prompt is the one the second deploy published.
      expect(row.providerPromptHash).toBe(republished.promptHash);
    } finally {
      restoreProvider();
    }
  });
});
