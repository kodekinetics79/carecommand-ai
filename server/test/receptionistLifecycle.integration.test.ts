import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

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
const { db } = await import('../lib/db');
const { recomputeEntitlements } = await import('../lib/entitlements');

let app: FastifyInstance;
const tenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `life-${id.slice(0, 6)}`, slug: `life-${id.slice(0, 8)}` } });
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const user = await db.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@life.test`, displayName: 'Owner' } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Main clinic', phone: '+15550000000' }, select: { id: true } });
  return { id, userId: user.id, clinicId: clinic.id };
}
const authFor = (t: { id: string; userId: string }) => ({ authorization: `Bearer ${app.jwt.sign({ userId: t.userId, tenantId: t.id, role: 'OWNER', type: 'access' })}` });

function webhook(clinicId: string, payload: unknown) {
  return app.inject({ method: 'POST', url: `/v1/receptionist/webhooks/retell?clinicId=${clinicId}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('receptionist inbound-call lifecycle (event webhook)', () => {
  it('call_started creates a log; call_analyzed updates it and books once; redelivery is idempotent', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    const caller = '+15551239000';

    // 1. call_started → one IN_PROGRESS log.
    expect((await webhook(t.clinicId, { event: 'call_started', call: { call_id: callId, from_number: caller, direction: 'inbound' } })).statusCode).toBe(200);
    let logs = await db.receptionistCallLog.findMany({ where: { tenantId: t.id, retellCallId: callId } });
    expect(logs).toHaveLength(1);
    expect(logs[0].outcome).toBe('IN_PROGRESS');

    // 2. call_analyzed → UPDATES the same log + books exactly one request.
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
    expect(logs[0].outcome).toBe('BOOKED');
    expect(logs[0].durationSeconds).toBe(125);
    expect(logs[0].transcriptSummary).toBe('Patient booked a cleaning.');
    expect(logs[0].sentiment).toBe('Positive');
    expect(logs[0].recordingUrl).toBe('https://recordings.test/abc');
    expect(logs[0].endedAt).not.toBeNull();

    const requests = await db.receptionistAppointmentRequest.findMany({ where: { tenantId: t.id } });
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('CONFIRMED');
    expect((requests[0].collectedData as Record<string, unknown>).outcome).toBe('BOOKED');
    expect(requests[0].contactName).toBe('Jane');

    // 3. Redelivery of the SAME analyzed webhook → no dupes anywhere.
    expect((await webhook(t.clinicId, analyzed)).statusCode).toBe(200);
    expect(await db.receptionistCallLog.count({ where: { tenantId: t.id, retellCallId: callId } })).toBe(1);
    expect(await db.receptionistAppointmentRequest.count({ where: { tenantId: t.id } })).toBe(1);

    // 4. Retrievable via the authenticated call-logs API (client responses recorded).
    const res = await app.inject({ method: 'GET', url: '/v1/receptionist/call-logs', headers: authFor(t) });
    expect(res.statusCode).toBe(200);
    const apiLogs = res.json() as Array<{ retellCallId: string; outcome: string; durationSeconds: number }>;
    const mine = apiLogs.find(l => l.retellCallId === callId);
    expect(mine?.outcome).toBe('BOOKED');
    expect(mine?.durationSeconds).toBe(125);
  });

  it('OPTED_OUT files exactly one opt-out, idempotent across redelivery', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
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
    const res = await webhook(t.clinicId, { event: 'call_analyzed', call: { call_id: callId, from_number: '+15550001234', direction: 'inbound', call_analysis: { custom_analysis_data: { outcome: 'ORDER_PIZZA' } } } });
    expect(res.statusCode).toBe(200);
    const log = await db.receptionistCallLog.findFirst({ where: { tenantId: t.id, retellCallId: callId } });
    expect(log?.outcome).toBe('IN_PROGRESS');
  });

  it('a webhook can only write into the clinic-owning tenant (cross-tenant isolation)', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await webhook(a.clinicId, { event: 'call_analyzed', call: { call_id: `call-${randomUUID()}`, from_number: '+15558887777', direction: 'inbound', call_analysis: { custom_analysis_data: { outcome: 'BOOKED', first_name: 'Cross', appointment_date: '2030-03-03', appointment_time: '11:00' } } } });
    // Data landed under A (the clinic owner); B is untouched.
    expect(await db.receptionistAppointmentRequest.count({ where: { tenantId: a.id } })).toBe(1);
    expect(await db.receptionistAppointmentRequest.count({ where: { tenantId: b.id } })).toBe(0);
    expect(await db.receptionistCallLog.count({ where: { tenantId: b.id } })).toBe(0);

    // An unknown clinic id is ignored (202) and writes nothing.
    const ghost = await webhook(randomUUID(), { event: 'call_analyzed', call: { call_id: `call-${randomUUID()}`, call_analysis: { custom_analysis_data: { outcome: 'BOOKED' } } } });
    expect(ghost.statusCode).toBe(202);
  });
});
