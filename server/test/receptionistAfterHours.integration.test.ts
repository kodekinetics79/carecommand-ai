import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

// What the call log records about the world at the time of the call: whether
// the clinic was open, and whether the provider actually handed the caller to
// a human. Both are stamped once and never re-derived.
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
const RETELL_KEY = 'test-retell-after-hours-signature-key';
const originalRetellKey = env.RETELL_API_KEY;
const phone = () => `+1${(BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

// Mon-Fri 09:00-17:00 New York.
const WEEKDAYS = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map(day => [day, { open: true, start: '09:00', end: '17:00' }]),
);

async function makeTenant(options: { hours?: unknown } = {}) {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `ah-${id.slice(0, 6)}`, slug: `ah-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  await db.branch.create({ data: { tenantId: id, name: 'Main', location: '1 Main Street', timezone: 'America/New_York', active: true } });
  const clinic = await db.receptionistClinic.create({
    data: {
      tenantId: id, name: 'After hours clinic', phone: phone(), country: 'US',
      timezone: 'America/New_York', defaultLanguage: 'en-US',
      ...(options.hours === undefined ? { workingHours: WEEKDAYS } : options.hours === null ? {} : { workingHours: options.hours as object }),
    },
    select: { id: true },
  });
  return { id, clinicId: clinic.id };
}

function webhook(clinicId: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  return app.inject({
    method: 'POST', url: `/v1/receptionist/webhooks/retell?clinicId=${clinicId}`,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) },
    payload: raw,
  });
}

async function registerCall(t: { id: string; clinicId: string }, callId: string, startedAt: Date) {
  await db.receptionistCallLog.create({
    data: { tenantId: t.id, clinicId: t.clinicId, retellCallId: callId, direction: 'inbound', outcome: 'IN_PROGRESS', startedAt },
  });
}

beforeAll(async () => {
  env.RETELL_API_KEY = RETELL_KEY;
  app = await buildApp();
}, 60_000);
afterAll(async () => {
  env.RETELL_API_KEY = originalRetellKey;
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('after-hours stamping', () => {
  it('stamps an inbound call that arrived outside the configured hours', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    // 2026-09-02T07:00:00Z is 03:00 in New York: the clinic is shut.
    await registerCall(t, callId, new Date('2026-09-02T07:00:00.000Z'));
    const response = await webhook(t.clinicId, { event: 'call_ended', call: { call_id: callId, direction: 'inbound', duration_ms: 42_000 } });
    expect(response.statusCode).toBe(200);
    const row = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    expect(row.outsideHours).toBe(true);
  });

  it('stamps a call inside the configured hours as not after-hours', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    // 14:00Z is 10:00 in New York on a Wednesday.
    await registerCall(t, callId, new Date('2026-09-02T14:00:00.000Z'));
    await webhook(t.clinicId, { event: 'call_ended', call: { call_id: callId, direction: 'inbound', duration_ms: 42_000 } });
    const row = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    expect(row.outsideHours).toBe(false);
  });

  it('records unknown, not "open", when the clinic has no hours configured', async () => {
    const t = await makeTenant({ hours: null });
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, new Date('2026-09-02T07:00:00.000Z'));
    await webhook(t.clinicId, { event: 'call_ended', call: { call_id: callId, direction: 'inbound', duration_ms: 42_000 } });
    const row = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    // Null means "we could not know", which the front desk renders as
    // unavailable rather than as a reassuring "we were open".
    expect(row.outsideHours).toBeNull();
  });

  it('emits one after-hours business event and one refreshed per-clinic signal', async () => {
    const t = await makeTenant();
    const first = `call-${randomUUID()}`;
    const second = `call-${randomUUID()}`;
    await registerCall(t, first, new Date(Date.now() - 3_600_000));
    await registerCall(t, second, new Date(Date.now() - 7_200_000));
    // Force both into the small hours so the stamp is deterministic.
    await db.receptionistCallLog.updateMany({ where: { tenantId: t.id }, data: { startedAt: new Date('2026-09-02T07:00:00.000Z') } });

    await webhook(t.clinicId, { event: 'call_ended', call: { call_id: first, direction: 'inbound', duration_ms: 30_000 } });
    await webhook(t.clinicId, { event: 'call_ended', call: { call_id: second, direction: 'inbound', duration_ms: 30_000 } });

    const events = await db.businessEvent.findMany({ where: { tenantId: t.id, eventType: 'receptionist.call.after_hours' } });
    expect(events).toHaveLength(2);
    // The signal is per clinic, not per call, and is refreshed rather than duplicated.
    const signals = await db.operationalSignal.findMany({ where: { tenantId: t.id, signalType: 'after_hours_call' } });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ entityType: 'receptionistClinic', entityId: t.clinicId, severity: 'low', status: 'open' });
    expect(signals[0].reason).toMatch(/inbound calls? arrived outside configured hours in the last 7 days/);
  });

  it('does not re-stamp or re-announce a call on webhook redelivery', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, new Date('2026-09-02T07:00:00.000Z'));
    const payload = { event: 'call_ended', call: { call_id: callId, direction: 'inbound', duration_ms: 30_000 } };
    await webhook(t.clinicId, payload);
    await webhook(t.clinicId, { ...payload, event: 'call_analyzed' });
    expect(await db.businessEvent.count({ where: { tenantId: t.id, eventType: 'receptionist.call.after_hours' } })).toBe(1);
  });

  it('leaves an outbound call out of the after-hours count', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await db.receptionistCallLog.create({
      data: { tenantId: t.id, clinicId: t.clinicId, retellCallId: callId, direction: 'outbound', outcome: 'IN_PROGRESS', startedAt: new Date('2026-09-02T07:00:00.000Z') },
    });
    await webhook(t.clinicId, { event: 'call_ended', call: { call_id: callId, direction: 'outbound', duration_ms: 30_000 } });
    expect(await db.businessEvent.count({ where: { tenantId: t.id, eventType: 'receptionist.call.after_hours' } })).toBe(0);
  });

  it('surfaces the stamped counts through /hours-status', async () => {
    const t = await makeTenant();
    const user = await db.user.create({ data: { tenantId: t.id, role: 'OWNER', active: true, email: `owner-${t.id.slice(0, 8)}@ah.test`, displayName: 'Owner' }, select: { id: true } });
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, new Date(Date.now() - 3_600_000));
    await db.receptionistCallLog.updateMany({ where: { tenantId: t.id, retellCallId: callId }, data: { outsideHours: true } });
    const response = await app.inject({
      method: 'GET', url: '/v1/receptionist/hours-status',
      headers: { authorization: `Bearer ${app.jwt.sign({ userId: user.id, tenantId: t.id, role: 'OWNER', type: 'access' })}` },
    });
    expect(response.json().clinics[0].afterHoursCalls).toMatchObject({ last24Hours: 1, last7Days: 1 });
    expect(response.json().clinics[0].afterHoursCalls.lastAt).not.toBeNull();
  });
});

describe('transfer outcome', () => {
  it('records a provider transfer as connected', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, new Date('2026-09-02T14:00:00.000Z'));
    await webhook(t.clinicId, { event: 'call_ended', call: { call_id: callId, direction: 'inbound', duration_ms: 60_000, disconnection_reason: 'call_transfer' } });
    const row = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    expect(row.transferOutcome).toBe('connected');
  });

  it('records any other disconnection reason as unknown rather than inventing a failure', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, new Date('2026-09-02T14:00:00.000Z'));
    // Retell has no transfer_failed disposition, so "the caller hung up" is not
    // evidence that a transfer was attempted and failed.
    await webhook(t.clinicId, { event: 'call_ended', call: { call_id: callId, direction: 'inbound', duration_ms: 60_000, disconnection_reason: 'user_hangup' } });
    const row = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    expect(row.transferOutcome).toBe('unknown');
  });

  it('leaves the outcome null when the provider says nothing about why the call ended', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, new Date('2026-09-02T14:00:00.000Z'));
    await webhook(t.clinicId, { event: 'call_ended', call: { call_id: callId, direction: 'inbound', duration_ms: 60_000 } });
    const row = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    expect(row.transferOutcome).toBeNull();
  });

  it('keeps the first transfer evidence when a later redelivery disagrees', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, new Date('2026-09-02T14:00:00.000Z'));
    await webhook(t.clinicId, { event: 'call_ended', call: { call_id: callId, direction: 'inbound', duration_ms: 60_000, disconnection_reason: 'call_transfer' } });
    await webhook(t.clinicId, { event: 'call_analyzed', call: { call_id: callId, direction: 'inbound', duration_ms: 60_000, disconnection_reason: 'user_hangup' } });
    const row = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
    expect(row.transferOutcome).toBe('connected');
  });

  it('refuses an outcome the database does not recognise', async () => {
    const t = await makeTenant();
    const callId = `call-${randomUUID()}`;
    await registerCall(t, callId, new Date('2026-09-02T14:00:00.000Z'));
    await expect(db.receptionistCallLog.updateMany({
      where: { tenantId: t.id, retellCallId: callId }, data: { transferOutcome: 'failed' },
    })).rejects.toThrow();
  });
});
