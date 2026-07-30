import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

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

let app: FastifyInstance;
const tenantIds: string[] = [];
const phoneFor = (id: string) => `+1${(BigInt(`0x${id.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `rcp-${id.slice(0, 6)}`, slug: `rcp-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const user = await db.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@rcp.test`, displayName: 'Owner' } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Main clinic', phone: phoneFor(id) } });
  const now = new Date();
  const agent = await db.receptionistAgent.create({ data: {
    tenantId: id, clinicId: clinic.id, name: 'Outbound pilot agent', providerAgentId: `agent_${id.replaceAll('-', '')}`,
    providerVersion: 1, providerVersionTag: 'prod', providerStatus: 'VERIFIED', providerPublished: true,
    providerAssignedTags: ['prod'], providerFingerprint: 'c'.repeat(64), providerConfigRevision: 1, providerVerifiedRevision: 1,
    providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
    providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'], providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
    providerResponseEngineType: 'retell-llm', providerResponseEngineId: `llm_${id.replaceAll('-', '')}`,
    providerVerifiedAt: now, providerVerificationExpiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
  } });
  return { id, userId: user.id, clinicId: clinic.id, agentId: agent.id };
}

function auth(t: { id: string }, userId: string) {
  return { authorization: `Bearer ${app.jwt.sign({ userId, tenantId: t.id, role: 'OWNER', type: 'access' })}` };
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('AI receptionist outbound targets', () => {
  it('adds, lists, and deletes outbound call targets for a campaign', async () => {
    const tenant = await makeTenant();
    const headers = auth(tenant, tenant.userId);

    const campaignRes = await app.inject({
      method: 'POST',
      url: '/v1/receptionist/outbound-campaigns',
      headers,
      payload: {
        clinicId: tenant.clinicId,
        agentId: tenant.agentId,
        name: 'Pilot cleanup queue',
        script: 'Call the patient.',
        requiredFields: ['firstName', 'lastName', 'phone'],
      },
    });
    expect(campaignRes.statusCode).toBe(201);
    const campaign = campaignRes.json() as { id: string };

    const addRes = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaign.id}/targets`,
      headers,
      payload: {
        targets: [{ phone: '+1 555 101 0101', firstName: 'Test', lastName: 'Target' }],
      },
    });
    expect(addRes.statusCode).toBe(201);
    expect(addRes.json()).toEqual({ added: 1 });

    const listed = await db.receptionistCallTarget.findMany({ where: { tenantId: tenant.id, campaignId: campaign.id } });
    expect(listed).toHaveLength(1);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/receptionist/outbound-campaigns/${campaign.id}/targets/${listed[0].id}`,
      headers,
    });
    expect(delRes.statusCode).toBe(204);
    expect(await db.receptionistCallTarget.count({ where: { tenantId: tenant.id, campaignId: campaign.id } })).toBe(0);
  });

  it('fails closed on campaign state, stop control, target ownership, identity, and terminal status', async () => {
    const tenant = await makeTenant();
    const headers = auth(tenant, tenant.userId);
    const makeCampaign = async (name: string, status: 'DRAFT' | 'RUNNING') => db.receptionistOutboundCampaign.create({
      data: { tenantId: tenant.id, clinicId: tenant.clinicId, agentId: tenant.agentId, name, script: 'Call the patient.', requiredFields: ['phone'], status },
    });
    const draft = await makeCampaign('Draft queue', 'DRAFT');
    const running = await makeCampaign('Running queue', 'RUNNING');
    const other = await makeCampaign('Other running queue', 'RUNNING');
    const target = await db.receptionistCallTarget.create({
      data: { tenantId: tenant.id, campaignId: running.id, phone: '+15551010101', firstName: 'Casey', lastName: 'Jones' },
    });

    const draftDial = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${draft.id}/call`, headers, payload: { phone: '+15551010101' } });
    expect(draftDial.statusCode).toBe(409);
    expect(draftDial.json()).toMatchObject({ status: 'blocked', reason: 'campaign_not_running' });

    const wrongCampaign = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${other.id}/call`, headers, payload: { phone: target.phone, targetId: target.id } });
    expect(wrongCampaign.statusCode).toBe(404);

    const wrongIdentity = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${running.id}/call`, headers, payload: { phone: '+15559999999', targetId: target.id } });
    expect(wrongIdentity.statusCode).toBe(409);
    expect(wrongIdentity.json()).toMatchObject({ reason: 'target_identity_mismatch' });

    await db.receptionistCallLog.create({ data: { tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: running.id, callerPhone: target.phone, retellCallId: 'mock-active-call', outcome: 'IN_PROGRESS' } });
    const stopOriginal = { apiKey: env.RETELL_API_KEY, from: env.RETELL_FROM_NUMBER };
    env.RETELL_API_KEY = 'mock_stop_control';
    env.RETELL_FROM_NUMBER = '+15550000001';
    const stop = await app.inject({ method: 'POST', url: '/v1/receptionist/outbound-control', headers, payload: { stopped: true, reason: 'Pilot emergency stop test' } });
    env.RETELL_API_KEY = stopOriginal.apiKey;
    env.RETELL_FROM_NUMBER = stopOriginal.from;
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ stopped: true, activeCancellation: { requested: 1, confirmed: 0, failed: 0, unconfirmed: 1 } });
    const stoppedDial = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${running.id}/call`, headers, payload: { phone: target.phone, targetId: target.id } });
    expect(stoppedDial.statusCode).toBe(423);
    expect(stoppedDial.json()).toMatchObject({ status: 'blocked', reason: 'outbound_stopped' });

    // Tenant callers cannot override a platform/global stop. Clear it directly
    // here to continue this isolated test (the real resume path is platform-only).
    const tenantResume = await app.inject({ method: 'POST', url: '/v1/receptionist/outbound-control', headers, payload: { stopped: false, reason: 'Emergency stop test complete' } });
    expect(tenantResume.statusCode).toBe(400);
    await db.tenantAiUsage.update({ where: { tenantId: tenant.id }, data: { killSwitch: false, killSwitchReason: null } });
    await db.receptionistCallTarget.update({ where: { id: target.id }, data: { status: 'COMPLETED' } });
    const terminalDial = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${running.id}/call`, headers, payload: { phone: target.phone, targetId: target.id } });
    expect(terminalDial.statusCode).toBe(409);
    expect(terminalDial.json()).toMatchObject({ reason: 'target_not_dialable' });

    await db.receptionistCallTarget.update({ where: { id: target.id }, data: { status: 'PENDING' } });
    const allowed = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${running.id}/call`, headers, payload: { phone: target.phone, targetId: target.id } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ status: 'setup_required' });

    const actions = await db.auditEvent.findMany({ where: { tenantId: tenant.id, action: { in: ['receptionist.call.blocked', 'receptionist.outbound.stopped'] } }, select: { action: true } });
    expect(actions.map(row => row.action)).toEqual(expect.arrayContaining(['receptionist.call.blocked', 'receptionist.outbound.stopped']));
  });

  it('blocks atomically at tenant concurrency and voice-minute capacity', async () => {
    const tenant = await makeTenant();
    const headers = auth(tenant, tenant.userId);
    const original = { apiKey: env.RETELL_API_KEY, from: env.RETELL_FROM_NUMBER };
    env.RETELL_API_KEY = 'mock_capacity';
    env.RETELL_FROM_NUMBER = '+15550000001';
    try {
    const campaign = await db.receptionistOutboundCampaign.create({
      data: { tenantId: tenant.id, clinicId: tenant.clinicId, agentId: tenant.agentId, name: 'Capacity queue', script: 'Call the patient.', requiredFields: ['phone'], status: 'RUNNING' },
    });
    await db.receptionistCallLog.createMany({
      data: [1, 2, 3].map(n => ({ tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: campaign.id, callerPhone: `+1555101040${n}`, outcome: 'IN_PROGRESS' })),
    });
    const concurrent = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers, payload: { phone: '+15551010499' } });
    expect(concurrent.statusCode).toBe(429);
    expect(concurrent.json()).toMatchObject({ status: 'blocked', reason: 'concurrency_limit_reached' });

    await db.receptionistCallLog.updateMany({ where: { tenantId: tenant.id }, data: { outcome: 'FAILED', endedAt: new Date() } });
    await db.tenantUsageLimit.upsert({
      where: { tenantId_key: { tenantId: tenant.id, key: 'voice_minutes' } },
      update: { used: 1, limitValue: 1 },
      create: { tenantId: tenant.id, key: 'voice_minutes', used: 1, limitValue: 1 },
    });
    const spent = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers, payload: { phone: '+15551010499' } });
    expect(spent.statusCode).toBe(402);
    expect(spent.json()).toMatchObject({ status: 'blocked', reason: 'voice_minutes_limit_reached' });
    } finally {
      env.RETELL_API_KEY = original.apiKey;
      env.RETELL_FROM_NUMBER = original.from;
    }
  });

  it('atomically claims a target and applies retry/terminal semantics on provider failure', async () => {
    const tenant = await makeTenant();
    const headers = auth(tenant, tenant.userId);
    const campaign = await db.receptionistOutboundCampaign.create({
      data: { tenantId: tenant.id, clinicId: tenant.clinicId, agentId: tenant.agentId, name: 'Atomic queue', script: 'Call the patient.', requiredFields: ['phone'], status: 'RUNNING', maxRetryAttempts: 0 },
    });
    const target = await db.receptionistCallTarget.create({
      data: { tenantId: tenant.id, campaignId: campaign.id, phone: '+15551010202' },
    });
    const original = { apiKey: env.RETELL_API_KEY, from: env.RETELL_FROM_NUMBER, base: env.RETELL_BASE_URL };

    try {
      env.RETELL_API_KEY = 'mock_atomic_claim';
      env.RETELL_FROM_NUMBER = '+15550000001';
      const payload = { phone: target.phone, targetId: target.id };
      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers, payload }),
        app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers, payload }),
      ]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
      expect(await db.receptionistCallLog.count({ where: { tenantId: tenant.id, targetId: target.id, outcome: 'IN_PROGRESS' } })).toBe(1);
      expect(await db.receptionistCallTarget.findUnique({ where: { id: target.id } })).toMatchObject({ status: 'CALLING', attempts: 1 });

      const failingTarget = await db.receptionistCallTarget.create({ data: { tenantId: tenant.id, campaignId: campaign.id, phone: '+15551010303' } });
      env.RETELL_API_KEY = 'real_provider_key';
      env.RETELL_BASE_URL = 'https://retell.invalid';
      const providerFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ message: 'provider unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', providerFetch);
      const failed = await app.inject({ method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers, payload: { phone: failingTarget.phone, targetId: failingTarget.id } });
      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toMatchObject({ status: 'failed' });
      const providerRequest = providerFetch.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(providerRequest.body))).toMatchObject({
        override_agent_id: `agent_${tenant.id.replaceAll('-', '')}`,
        override_agent_version: 1,
      });
      expect(await db.receptionistCallTarget.findUnique({ where: { id: failingTarget.id } })).toMatchObject({ status: 'FAILED', attempts: 1, lastOutcome: 'FAILED' });
      expect(await db.receptionistCallLog.count({ where: { tenantId: tenant.id, targetId: failingTarget.id, outcome: 'IN_PROGRESS' } })).toBe(0);

      const mismatchTarget = await db.receptionistCallTarget.create({ data: { tenantId: tenant.id, campaignId: campaign.id, phone: '+15551010304' } });
      providerFetch.mockImplementation(async (url) => String(url).includes('/v2/create-phone-call')
        ? new Response(JSON.stringify({ call_id: 'call-provider-mismatch', agent_id: 'agent_wrong', agent_version: 1 }), { status: 201 })
        : new Response(null, { status: 204 }));
      const mismatch = await app.inject({
        method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers,
        payload: { phone: mismatchTarget.phone, targetId: mismatchTarget.id },
      });
      expect(mismatch.statusCode).toBe(502);
      expect(mismatch.json()).toMatchObject({ status: 'failed', error: 'retell_deployment_mismatch', reviewRecorded: true, signalRecorded: true });
      expect(mismatch.json().reviewTaskId).toMatch(/^[0-9a-f-]{36}$/);
      expect(mismatch.json().signalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await db.receptionistCallLog.findFirst({ where: { tenantId: tenant.id, targetId: mismatchTarget.id } })).toMatchObject({
        retellCallId: 'call-provider-mismatch', outcome: 'FAILED',
      });
      expect(await db.auditEvent.findFirst({
        where: { tenantId: tenant.id, action: 'receptionist.call.providerDeploymentMismatch' },
      })).toMatchObject({ metadata: expect.objectContaining({ operationalReviewRequired: true, providerStopApplied: true }) });
      expect(providerFetch).toHaveBeenLastCalledWith(
        'https://retell.invalid/v2/stop-call/call-provider-mismatch',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: tenant.agentId } })).toMatchObject({
        providerStatus: 'INVALID', providerLastErrorCode: 'provider_deployment_mismatch',
      });
      expect(await db.receptionistOutboundCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: 'PAUSED' });
      expect(await db.staffTask.findUnique({ where: { id: mismatch.json().reviewTaskId } })).toMatchObject({
        priority: 'CRITICAL', status: 'OPEN', metadata: expect.objectContaining({ requiresAcknowledgement: true, providerStopApplied: true }),
      });
      expect(await db.operationalSignal.findUnique({ where: { id: mismatch.json().signalId } })).toMatchObject({
        signalType: 'receptionist_provider_deployment_mismatch', severity: 'critical', status: 'open',
      });
      const createCallsAfterStopSuccess = providerFetch.mock.calls.filter(([url]) => String(url).includes('/v2/create-phone-call')).length;
      const blockedAfterStopSuccess = await app.inject({
        method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers, payload: { phone: '+15551010305' },
      });
      expect(blockedAfterStopSuccess.statusCode).toBe(409);
      expect(providerFetch.mock.calls.filter(([url]) => String(url).includes('/v2/create-phone-call'))).toHaveLength(createCallsAfterStopSuccess);

      const reverifiedAt = new Date();
      await db.receptionistAgent.update({ where: { id: tenant.agentId }, data: {
        providerStatus: 'VERIFIED', providerVerifiedRevision: 1, providerVerifiedAt: reverifiedAt,
        providerVerificationExpiresAt: new Date(reverifiedAt.getTime() + 60 * 60 * 1_000),
        providerLastAttemptAt: reverifiedAt, providerLastAttemptStatus: 'SUCCEEDED', providerLastErrorCode: null,
      } });
      await db.receptionistOutboundCampaign.update({ where: { id: campaign.id }, data: { status: 'RUNNING' } });
      const stopFailureTarget = await db.receptionistCallTarget.create({ data: { tenantId: tenant.id, campaignId: campaign.id, phone: '+15551010306' } });
      providerFetch.mockImplementation(async (url) => String(url).includes('/v2/create-phone-call')
        ? new Response(JSON.stringify({ call_id: 'call-provider-mismatch-stop-failed', agent_id: 'agent_wrong', agent_version: 1 }), { status: 201 })
        : new Response(null, { status: 503 }));
      const stopFailure = await app.inject({
        method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers,
        payload: { phone: stopFailureTarget.phone, targetId: stopFailureTarget.id },
      });
      expect(stopFailure.statusCode).toBe(502);
      expect(stopFailure.json()).toMatchObject({ status: 'failed', error: 'retell_deployment_mismatch' });
      expect(await db.staffTask.findUnique({ where: { id: stopFailure.json().reviewTaskId } })).toMatchObject({
        priority: 'CRITICAL', metadata: expect.objectContaining({ providerStopApplied: false, providerStopFailed: true }),
      });
      const createCallsAfterStopFailure = providerFetch.mock.calls.filter(([url]) => String(url).includes('/v2/create-phone-call')).length;
      const blockedAfterStopFailure = await app.inject({
        method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers, payload: { phone: '+15551010307' },
      });
      expect(blockedAfterStopFailure.statusCode).toBe(409);
      expect(providerFetch.mock.calls.filter(([url]) => String(url).includes('/v2/create-phone-call'))).toHaveLength(createCallsAfterStopFailure);
    } finally {
      env.RETELL_API_KEY = original.apiKey;
      env.RETELL_FROM_NUMBER = original.from;
      env.RETELL_BASE_URL = original.base;
      vi.unstubAllGlobals();
    }
  });

  it('keeps the deployment circuit fail-closed when review persistence is unavailable', async () => {
    const tenant = await makeTenant();
    const headers = auth(tenant, tenant.userId);
    const campaign = await db.receptionistOutboundCampaign.create({
      data: { tenantId: tenant.id, clinicId: tenant.clinicId, agentId: tenant.agentId, name: 'Review outage circuit', script: 'Call the patient.', requiredFields: ['phone'], status: 'RUNNING' },
    });
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION receptionist_review_persistence_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW."tenantId" = '${tenant.id}'::uuid THEN
          RAISE EXCEPTION 'injected review persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER receptionist_review_persistence_failure_trigger
      BEFORE INSERT ON "StaffTask"
      FOR EACH ROW EXECUTE FUNCTION receptionist_review_persistence_failure();
      CREATE TRIGGER receptionist_signal_persistence_failure_trigger
      BEFORE INSERT ON "OperationalSignal"
      FOR EACH ROW EXECUTE FUNCTION receptionist_review_persistence_failure();
    `);
    const original = { apiKey: env.RETELL_API_KEY, from: env.RETELL_FROM_NUMBER, base: env.RETELL_BASE_URL };
    try {
      env.RETELL_API_KEY = 'real_provider_key';
      env.RETELL_FROM_NUMBER = '+15550000001';
      env.RETELL_BASE_URL = 'https://retell.invalid';
      const providerFetch = vi.fn<typeof fetch>(async url => String(url).includes('/v2/create-phone-call')
        ? new Response(JSON.stringify({ call_id: 'call-review-outage', agent_id: 'agent_wrong', agent_version: 1 }), { status: 201 })
        : new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', providerFetch);

      const mismatch = await app.inject({
        method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers, payload: { phone: '+15551010801' },
      });
      expect(mismatch.statusCode).toBe(502);
      expect(mismatch.json()).toMatchObject({
        status: 'failed', error: 'retell_deployment_mismatch', reviewTaskId: null, reviewRecorded: false, signalId: null, signalRecorded: false,
      });
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: tenant.agentId } })).toMatchObject({
        providerStatus: 'INVALID', providerLastErrorCode: 'provider_deployment_mismatch',
      });
      expect(await db.receptionistOutboundCampaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: 'PAUSED' });
      expect(await db.receptionistCallLog.findFirst({ where: { tenantId: tenant.id, retellCallId: 'call-review-outage' } })).toMatchObject({ outcome: 'FAILED' });
      expect(await db.staffTask.count({ where: { tenantId: tenant.id } })).toBe(0);
      expect(await db.operationalSignal.count({ where: { tenantId: tenant.id, signalType: 'receptionist_provider_deployment_mismatch' } })).toBe(0);
      const visibleAgentState = await app.inject({ method: 'GET', url: `/v1/receptionist/agents?clinicId=${tenant.clinicId}`, headers });
      expect(visibleAgentState.statusCode).toBe(200);
      expect(visibleAgentState.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: tenant.agentId, providerStatus: 'INVALID', providerLastErrorCode: 'provider_deployment_mismatch' }),
      ]));

      const providerCreateCount = providerFetch.mock.calls.filter(([url]) => String(url).includes('/v2/create-phone-call')).length;
      const blocked = await app.inject({
        method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaign.id}/call`, headers, payload: { phone: '+15551010802' },
      });
      expect(blocked.statusCode).toBe(409);
      expect(providerFetch.mock.calls.filter(([url]) => String(url).includes('/v2/create-phone-call'))).toHaveLength(providerCreateCount);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS receptionist_review_persistence_failure_trigger ON "StaffTask"; DROP TRIGGER IF EXISTS receptionist_signal_persistence_failure_trigger ON "OperationalSignal"; DROP FUNCTION IF EXISTS receptionist_review_persistence_failure();');
      env.RETELL_API_KEY = original.apiKey;
      env.RETELL_FROM_NUMBER = original.from;
      env.RETELL_BASE_URL = original.base;
      vi.unstubAllGlobals();
    }
  });

  it('accounts billable voice minutes once across terminal webhook replay', async () => {
    const tenant = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await db.receptionistCallLog.create({
      data: { tenantId: tenant.id, clinicId: tenant.clinicId, retellCallId: callId, callerPhone: '+15551010505', outcome: 'IN_PROGRESS', durationSeconds: 0 },
    });
    const originalKey = env.RETELL_API_KEY;
    env.RETELL_API_KEY = 'retell_usage_secret';
    try {
      const raw = JSON.stringify({ event: 'call_ended', call: { call_id: callId, from_number: '+15550000001', duration_ms: 61_000, call_analysis: { custom_analysis_data: { outcome: 'OPTED_OUT' } } } });
      const signature = signRetell(raw, env.RETELL_API_KEY);
      const send = () => app.inject({
        method: 'POST',
        url: `/v1/receptionist/webhooks/retell?clinicId=${tenant.clinicId}`,
        headers: { 'content-type': 'application/json', 'x-retell-signature': signature },
        payload: raw,
      });
      expect((await send()).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(200);
      expect(await db.tenantAiUsage.findUnique({ where: { tenantId: tenant.id } })).toMatchObject({ receptionistMinutes: 2 });
      expect(await db.tenantUsageLimit.findUnique({ where: { tenantId_key: { tenantId: tenant.id, key: 'voice_minutes' } } })).toMatchObject({ used: 2 });
      // For outbound calls, the provider from_number is the clinic. Suppress
      // the stored destination instead, never the clinic's own line.
      expect(await db.receptionistOptOut.findFirst({ where: { tenantId: tenant.id } })).toMatchObject({ contactPhone: '+15551010505', channel: 'ALL' });
    } finally {
      env.RETELL_API_KEY = originalKey;
    }
  });
});
