import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

// Inbound-call lifecycle over the PUBLIC Retell event webhook: a call_started
// creates a log, a later call_analyzed UPDATES the same log (duration, summary,
// sentiment, recording), a BOOKED outcome files exactly one appointment request,
// webhook redelivery is idempotent, an OPTED_OUT files one opt-out, an unknown
// outcome degrades to IN_PROGRESS, and a webhook can only ever write into the
// tenant that owns the clinic on the URL.
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
const RETELL_KEY = 'test-retell-lifecycle-signature-key';
const originalRetellKey = env.RETELL_API_KEY;
const phoneFor = (id: string) => `+1${(BigInt(`0x${id.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `life-${id.slice(0, 6)}`, slug: `life-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const user = await db.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@life.test`, displayName: 'Owner' } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Main clinic', phone: phoneFor(id), country: 'US', timezone: 'America/New_York', defaultLanguage: 'en-US' }, select: { id: true } });
  const providerAgentId = `agent_${id.replaceAll('-', '')}`;
  const providerAgentVersion = 2;
  const verifiedAt = new Date();
  await db.receptionistAgent.create({ data: {
    tenantId: id, clinicId: clinic.id, name: 'Avery', active: true,
    providerAgentId, providerVersionTag: 'prod', providerVersion: providerAgentVersion, providerStatus: 'VERIFIED',
    providerPublished: true, providerAssignedTags: ['prod'],
    providerWebhookUrl: 'https://api.example.test/v1/receptionist/webhooks/retell',
    providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
    providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
    providerResponseEngineType: 'retell-llm', providerResponseEngineId: `llm_${id.replaceAll('-', '')}`,
    providerResponseEngineVersion: 1,
    providerFingerprint: 'c'.repeat(64), providerConfigRevision: 1, providerVerifiedRevision: 1,
    providerVerifiedAt: verifiedAt, providerVerificationExpiresAt: new Date(verifiedAt.getTime() + 60 * 60_000),
  } });
  return { id, userId: user.id, clinicId: clinic.id, providerAgentId, providerAgentVersion };
}
const authFor = (t: { id: string; userId: string }) => ({ authorization: `Bearer ${app.jwt.sign({ userId: t.userId, tenantId: t.id, role: 'OWNER', type: 'access' })}` });

async function registerCall(t: { id: string; clinicId: string }, callId: string, caller?: string) {
  return db.receptionistCallLog.create({
    data: { tenantId: t.id, clinicId: t.clinicId, retellCallId: callId, callerPhone: caller, direction: 'inbound', outcome: 'IN_PROGRESS' },
  });
}

function webhook(clinicId: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  return app.inject({
    method: 'POST', url: `/v1/receptionist/webhooks/retell?clinicId=${clinicId}`,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) },
    payload: raw,
  });
}

function webhookTool(clinicId: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  return app.inject({
    method: 'POST', url: `/v1/receptionist/webhooks/retell/fn?clinicId=${clinicId}`,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) },
    payload: raw,
  });
}

beforeAll(async () => {
  env.RETELL_API_KEY = RETELL_KEY;
  app = await buildApp();
}, 60_000);
afterAll(async () => {
  env.RETELL_API_KEY = originalRetellKey;
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('receptionist inbound-call lifecycle (event webhook)', () => {
  it('a verified mapped call never treats provider analysis alone as a canonical booking and remains idempotent', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    const caller = '+15551239000';
    await registerCall(t, callId, caller);

    // The provider call id is mapped before accepting tenant-scoped events.
    // call_started preserves the single canonical IN_PROGRESS log.
    expect((await webhook(t.clinicId, { event: 'call_started', call: { call_id: callId, from_number: caller, direction: 'inbound' } })).statusCode).toBe(200);
    let logs = await db.receptionistCallLog.findMany({ where: { tenantId: t.id, retellCallId: callId } });
    expect(logs).toHaveLength(1);
    expect(logs[0].outcome).toBe('IN_PROGRESS');

    // Consent comes only from the explicit signed in-call tool, never from
    // post-call model analysis.
    expect((await webhookTool(t.clinicId, {
      name: 'record_recording_preference',
      args: { recording_decision: 'GRANTED', jurisdiction: 'US-NY' },
      call: { call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion, from_number: caller, direction: 'inbound' },
    })).statusCode).toBe(200);

    // 2. call_analyzed → updates the same log and creates one pending review;
    // provider/model analysis alone cannot create or confirm an Appointment.
    const analyzed = {
      event: 'call_analyzed',
      call: {
        call_id: callId, from_number: caller, direction: 'inbound', recording_url: 'https://recordings.test/abc', duration_ms: 125_000,
        call_analysis: { call_summary: 'Patient booked a cleaning.', user_sentiment: 'Positive', custom_analysis_data: { outcome: 'BOOKED', first_name: 'Jane', appointment_date: '2030-02-02', appointment_time: '10:00' } },
      },
    };
    expect((await webhook(t.clinicId, analyzed)).statusCode).toBe(200);

    logs = await db.receptionistCallLog.findMany({ where: { tenantId: t.id, retellCallId: callId } });
    expect(logs).toHaveLength(1); // still ONE log — updated, not duplicated
    expect(logs[0].outcome).toBe('ESCALATED');
    expect(logs[0].durationSeconds).toBe(125);
    expect(logs[0].transcriptSummary).toBe('Patient booked a cleaning.');
    expect(logs[0].sentiment).toBe('Positive');
    expect(logs[0].recordingUrl).toBe('https://recordings.test/abc');
    expect(logs[0].endedAt).not.toBeNull();

    const requests = await db.appointmentRequest.findMany({ where: { tenantId: t.id } });
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('PENDING_REVIEW');
    expect(requests[0].source).toBe('retell_analysis_review_only');
    expect((requests[0].rawCollectedFields as Record<string, unknown>).first_name).toBe('Jane');
    expect(requests[0].collectedName).toBe('Jane');
    expect(requests[0].callLogId).toBe(logs[0].id);
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);

    // 3. Redelivery of the SAME analyzed webhook → no dupes anywhere.
    expect((await webhook(t.clinicId, analyzed)).statusCode).toBe(200);
    expect(await db.receptionistCallLog.count({ where: { tenantId: t.id, retellCallId: callId } })).toBe(1);
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id } })).toBe(1);

    // 4. Retrievable via the authenticated call-logs API (client responses recorded).
    const res = await app.inject({ method: 'GET', url: '/v1/receptionist/call-logs', headers: authFor(t) });
    expect(res.statusCode).toBe(200);
    // The queue paginates and the list projection carries no raw phone,
    // recording URL or sentiment — those live on the detail route now.
    const apiLogs = res.json().data as Array<{ retellCallId: string; outcome: string; durationSeconds: number; callerPhoneMasked: string | null; recordingUrl: null }>;
    const mine = apiLogs.find(l => l.retellCallId === callId);
    expect(mine?.outcome).toBe('ESCALATED');
    expect(mine?.durationSeconds).toBe(125);
    expect(mine?.recordingUrl).toBeNull();
    expect(mine).not.toHaveProperty('callerPhone');
  });

  it('OPTED_OUT files exactly one opt-out, idempotent across redelivery', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, '+15551117777');
    const payload = { event: 'call_analyzed', call: { call_id: callId, from_number: '+15551117777', direction: 'inbound', call_analysis: { custom_analysis_data: { outcome: 'OPTED_OUT' } } } };
    await webhook(t.clinicId, payload);
    await webhook(t.clinicId, payload); // redelivery
    const optOuts = await db.receptionistOptOut.findMany({ where: { tenantId: t.id } });
    expect(optOuts).toHaveLength(1);
    expect(optOuts[0].contactPhone).toBe('+15551117777');
    expect(optOuts[0].channel).toBe('ALL');
  });

  it('an unrecognized outcome degrades to IN_PROGRESS (never crashes)', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, '+15550001234');
    const res = await webhook(t.clinicId, { event: 'call_analyzed', call: { call_id: callId, from_number: '+15550001234', direction: 'inbound', call_analysis: { custom_analysis_data: { outcome: 'ORDER_PIZZA' } } } });
    expect(res.statusCode).toBe(200);
    const log = await db.receptionistCallLog.findFirst({ where: { tenantId: t.id, retellCallId: callId } });
    expect(log?.outcome).toBe('IN_PROGRESS');
  });

  it('stored call authority cannot be redirected by a clinicId selector', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await registerCall(a, callId, '+15558887777');
    await webhook(a.clinicId, { event: 'call_analyzed', call: { call_id: callId, from_number: '+15558887777', direction: 'inbound', call_analysis: { custom_analysis_data: { outcome: 'BOOKED', first_name: 'Cross', appointment_date: '2030-03-03', appointment_time: '11:00' } } } });
    // The stored opaque call mapping establishes A; the URL is only a selector.
    expect(await db.appointmentRequest.count({ where: { tenantId: a.id } })).toBe(1);
    expect(await db.appointmentRequest.count({ where: { tenantId: b.id } })).toBe(0);
    expect(await db.receptionistCallLog.count({ where: { tenantId: b.id } })).toBe(0);

    const redirectedCall = `call-${randomUUID()}`;
    await registerCall(a, redirectedCall, '+15558887778');
    const redirected = await webhook(b.clinicId, { event: 'call_analyzed', call: { call_id: redirectedCall, call_analysis: { custom_analysis_data: { outcome: 'BOOKED' } } } });
    expect(redirected.statusCode).toBe(202);
    expect(await db.appointmentRequest.count({ where: { tenantId: a.id } })).toBe(1);
    expect(await db.appointmentRequest.count({ where: { tenantId: b.id } })).toBe(0);

    // Even a valid clinic selector cannot authorize an unknown provider call.
    const unknown = await webhook(a.clinicId, { event: 'call_analyzed', call: { call_id: `unknown-${randomUUID()}`, call_analysis: { custom_analysis_data: { outcome: 'BOOKED' } } } });
    expect(unknown.statusCode).toBe(202);
  });
});
