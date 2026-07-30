import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

const rateStoreState = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: {
    get client() { return Promise.resolve(rateStoreState.client); },
    add: async () => undefined,
  },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { env } = await import('../config/env');
const { verifyRetellSignature } = await import('../modules/receptionist/routes');
const {
  RETELL_EVENT_PER_CALL_LIMIT,
  RETELL_INVALID_SIGNATURE_SOURCE_LIMIT,
} = await import('../lib/receptionist/providerRateLimit');

class FakeRateRedis {
  readonly counters = new Map<string, number>();
  evalCalls = 0;
  fail = false;
  nextVerifiedCounts: [number, number] | null = null;
  nextSourceCount: number | null = null;

  async eval(_script: string, numberOfKeys: number, ...args: Array<string | number>) {
    this.evalCalls += 1;
    if (this.fail) throw new Error('rate store unavailable');
    if (numberOfKeys === 2) {
      if (this.nextVerifiedCounts) {
        const result = this.nextVerifiedCounts;
        this.nextVerifiedCounts = null;
        return result;
      }
      const tenantKey = String(args[0]);
      const callKey = String(args[1]);
      const tenantCount = (this.counters.get(tenantKey) ?? 0) + 1;
      const callCount = (this.counters.get(callKey) ?? 0) + 1;
      this.counters.set(tenantKey, tenantCount);
      this.counters.set(callKey, callCount);
      return [tenantCount, callCount];
    }
    if (this.nextSourceCount !== null) {
      const result = this.nextSourceCount;
      this.nextSourceCount = null;
      return result;
    }
    const sourceKey = String(args[0]);
    const sourceCount = (this.counters.get(sourceKey) ?? 0) + 1;
    this.counters.set(sourceKey, sourceCount);
    return sourceCount;
  }
}

let app: FastifyInstance;
const tenantIds: string[] = [];
const original = {
  NODE_ENV: env.NODE_ENV,
  RETELL_API_KEY: env.RETELL_API_KEY,
  INGRESS_MODE: env.INGRESS_MODE,
  TRUSTED_PROXY_CIDRS: env.TRUSTED_PROXY_CIDRS,
};
const phoneFor = (id: string) => `+1${(BigInt(`0x${id.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `sec-${id.slice(0, 6)}`, slug: `sec-${id.slice(0, 8)}` } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'X' } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Clinic', phone: phoneFor(id) }, select: { id: true } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  return { id, branchId: branch.id, clinicId: clinic.id };
}

async function makeMappedCall(tenant: { id: string; clinicId: string }, callId = `mapped-${randomUUID()}`) {
  await db.receptionistCallLog.create({
    data: {
      tenantId: tenant.id,
      clinicId: tenant.clinicId,
      retellCallId: callId,
      callerPhone: '+14155550100',
      direction: 'outbound',
      startedAt: new Date(),
    },
  });
  return callId;
}

function setEnv(patch: Partial<typeof original>) {
  const mutable = env as typeof env;
  if (patch.NODE_ENV !== undefined) mutable.NODE_ENV = patch.NODE_ENV;
  if (patch.RETELL_API_KEY !== undefined) mutable.RETELL_API_KEY = patch.RETELL_API_KEY;
  if (patch.INGRESS_MODE !== undefined) mutable.INGRESS_MODE = patch.INGRESS_MODE;
  if (patch.TRUSTED_PROXY_CIDRS !== undefined) mutable.TRUSTED_PROXY_CIDRS = patch.TRUSTED_PROXY_CIDRS;
}

const eventUrl = (clinicId?: string) => `/v1/receptionist/webhooks/retell${clinicId ? `?clinicId=${clinicId}` : ''}`;
const fnUrl = (clinicId?: string) => `/v1/receptionist/webhooks/retell/fn${clinicId ? `?clinicId=${clinicId}` : ''}`;
const toolBody = (callId: string, name = 'check_availability') => JSON.stringify({
  name,
  args: { appointment_date: '2030-01-01' },
  call: { call_id: callId, direction: 'outbound', to_number: '+14155550100' },
});
const eventBody = (callId: string, event = 'call_started') => JSON.stringify({ event, call: { call_id: callId, direction: 'outbound' } });

async function signedPost(url: string, raw: string, key: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-retell-signature': signRetell(raw, key),
      // The app is direct-origin in this test; this spoofed shared-provider
      // header is deliberately ignored and never keys valid callback limits.
      'x-forwarded-for': '100.20.5.228',
    },
    payload: raw,
  });
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
beforeEach(() => { rateStoreState.client = new FakeRateRedis(); });
afterAll(async () => {
  setEnv(original);
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('Retell current secure-webhook signature contract', () => {
  const key = 'retell-current-contract-key';
  const now = 1_800_000_000_000;
  const raw = Buffer.from('{"event":"call_started","call":{"call_id":"contract"}}');

  it('accepts the exact official format and inclusive five-minute freshness boundary', () => {
    expect(verifyRetellSignature(raw, signRetell(raw, key, now), key, now)).toBe(true);
    expect(verifyRetellSignature(raw, signRetell(raw, key, now - 300_000), key, now)).toBe(true);
    expect(verifyRetellSignature(raw, signRetell(raw, key, now + 300_000), key, now)).toBe(true);
  });

  it('rejects stale/future, wrong-body/key, legacy, malformed, extra, and duplicated fields', () => {
    expect(verifyRetellSignature(raw, signRetell(raw, key, now - 300_001), key, now)).toBe(false);
    expect(verifyRetellSignature(raw, signRetell(raw, key, now + 300_001), key, now)).toBe(false);
    expect(verifyRetellSignature(Buffer.from(`${raw.toString()} `), signRetell(raw, key, now), key, now)).toBe(false);
    expect(verifyRetellSignature(raw, signRetell(raw, 'wrong-key', now), key, now)).toBe(false);
    expect(verifyRetellSignature(raw, signRetell(raw, key, now).split('d=')[1], key, now)).toBe(false);
    expect(verifyRetellSignature(raw, `d=${'a'.repeat(64)},v=${now}`, key, now)).toBe(false);
    expect(verifyRetellSignature(raw, `${signRetell(raw, key, now)},d=${'a'.repeat(64)}`, key, now)).toBe(false);
    expect(verifyRetellSignature(raw, [signRetell(raw, key, now), signRetell(raw, key, now)], key, now)).toBe(false);
  });
});

describe('Retell unauthenticated edge/origin boundary', () => {
  it('rejects unsigned and mutated callbacks and bounds only failed signatures', async () => {
    const tenant = await makeTenant();
    const key = 'retell-auth-key';
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: key });
    const redis = rateStoreState.client as FakeRateRedis;
    const unsignedRaw = toolBody(`unsigned-${randomUUID()}`);
    const unsigned = await app.inject({ method: 'POST', url: fnUrl(tenant.clinicId), headers: { 'content-type': 'application/json' }, payload: unsignedRaw });
    expect(unsigned.statusCode).toBe(401);
    const originalRaw = toolBody(`mutated-${randomUUID()}`);
    const mutated = await app.inject({
      method: 'POST', url: fnUrl(tenant.clinicId),
      headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(originalRaw, key) },
      payload: originalRaw.replace('2030-01-01', '2030-01-02'),
    });
    expect(mutated.statusCode).toBe(401);
    redis.nextSourceCount = RETELL_INVALID_SIGNATURE_SOURCE_LIMIT + 1;
    const bounded = await app.inject({ method: 'POST', url: fnUrl(tenant.clinicId), headers: { 'content-type': 'application/json' }, payload: unsignedRaw });
    expect(bounded.statusCode).toBe(429);
  });

  it('bounds both missing-verifier endpoints while returning truthful 503 before the bound', async () => {
    const tenant = await makeTenant();
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: '' });
    const redis = rateStoreState.client as FakeRateRedis;
    const raw = eventBody(`unconfigured-${randomUUID()}`);
    expect((await app.inject({ method: 'POST', url: eventUrl(tenant.clinicId), headers: { 'content-type': 'application/json' }, payload: raw })).statusCode).toBe(503);
    redis.nextSourceCount = RETELL_INVALID_SIGNATURE_SOURCE_LIMIT + 1;
    expect((await app.inject({ method: 'POST', url: eventUrl(tenant.clinicId), headers: { 'content-type': 'application/json' }, payload: raw })).statusCode).toBe(429);
    const fnRedis = new FakeRateRedis();
    rateStoreState.client = fnRedis;
    const rawTool = toolBody(`unconfigured-tool-${randomUUID()}`);
    expect((await app.inject({ method: 'POST', url: fnUrl(tenant.clinicId), headers: { 'content-type': 'application/json' }, payload: rawTool })).statusCode).toBe(503);
    fnRedis.nextSourceCount = RETELL_INVALID_SIGNATURE_SOURCE_LIMIT + 1;
    expect((await app.inject({ method: 'POST', url: fnUrl(tenant.clinicId), headers: { 'content-type': 'application/json' }, payload: rawTool })).statusCode).toBe(429);
  });

  it('retains the explicit one-MiB request-body cap', async () => {
    setEnv({ RETELL_API_KEY: 'body-cap-key' });
    const response = await app.inject({
      method: 'POST', url: eventUrl(), headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ event: 'call_started', padding: 'x'.repeat(1_048_576) }),
    });
    expect(response.statusCode).toBe(413);
  });
});

describe('Retell verified provider capacity with real mapped side effects', () => {
  it('executes more than 30 live tools across mapped calls/tenants from one provider source', async () => {
    const [a, b] = await Promise.all([makeTenant(), makeTenant()]);
    const key = 'retell-shared-provider-key';
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: key });
    const calls = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const tenant = index % 2 ? a : b;
      return { tenant, callId: await makeMappedCall(tenant, `shared-${index}-${randomUUID()}`) };
    }));
    const responses = await Promise.all(calls.map(({ callId }) => signedPost(fnUrl(), toolBody(callId), key)));
    expect(responses).toHaveLength(40);
    expect(responses.every(response => response.statusCode === 200)).toBe(true);
    expect(responses.some(response => response.statusCode === 429)).toBe(false);
  }, 60_000);

  it('persists over 200 terminal callbacks without loss and accounts each call', async () => {
    const tenant = await makeTenant();
    const key = 'retell-terminal-volume-key';
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: key });
    const callIds = Array.from({ length: 205 }, (_, index) => `terminal-${index}-${randomUUID()}`);
    await db.receptionistCallLog.createMany({ data: callIds.map(callId => ({
      tenantId: tenant.id,
      clinicId: tenant.clinicId,
      retellCallId: callId,
      callerPhone: '+14155550100',
      direction: 'outbound',
      startedAt: new Date(),
    })) });
    const codes: number[] = [];
    for (let offset = 0; offset < callIds.length; offset += 15) {
      const batch = callIds.slice(offset, offset + 15);
      const responses = await Promise.all(batch.map(callId => {
        const raw = JSON.stringify({
          event: 'call_analyzed',
          call: { call_id: callId, direction: 'outbound', duration_ms: 60_000, call_analysis: { custom_analysis_data: { outcome: 'NO_ANSWER' } } },
        });
        return signedPost(eventUrl(), raw, key);
      }));
      codes.push(...responses.map(response => response.statusCode));
    }
    expect(codes).toHaveLength(205);
    expect(codes.every(code => code === 200)).toBe(true);
    expect(await db.receptionistCallLog.count({ where: { tenantId: tenant.id, retellCallId: { in: callIds }, endedAt: { not: null }, outcome: 'NO_ANSWER', durationSeconds: 60 } })).toBe(205);
    expect((await db.tenantAiUsage.findUniqueOrThrow({ where: { tenantId: tenant.id } })).receptionistMinutes).toBe(205);
  }, 120_000);

  it('saturates nonterminal chatter but still persists and idempotently redelivers terminal state', async () => {
    const tenant = await makeTenant();
    const callId = await makeMappedCall(tenant);
    const key = 'retell-terminal-reserve-key';
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: key });
    for (let index = 0; index < RETELL_EVENT_PER_CALL_LIMIT; index++) {
      expect((await signedPost(eventUrl(), eventBody(callId), key)).statusCode).toBe(200);
    }
    expect((await signedPost(eventUrl(), eventBody(callId), key)).statusCode).toBe(429);
    const terminalRaw = JSON.stringify({
      event: 'call_analyzed',
      call: { call_id: callId, direction: 'outbound', duration_ms: 61_000, call_analysis: { custom_analysis_data: { outcome: 'NO_ANSWER' } } },
    });
    expect((await signedPost(eventUrl(), terminalRaw, key)).statusCode).toBe(200);
    expect((await signedPost(eventUrl(), terminalRaw, key)).statusCode).toBe(200);
    const persisted = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: tenant.id, retellCallId: callId } });
    expect(persisted.endedAt).not.toBeNull();
    expect(persisted.outcome).toBe('NO_ANSWER');
    expect(persisted.durationSeconds).toBe(61);
    expect((await db.tenantAiUsage.findUniqueOrThrow({ where: { tenantId: tenant.id } })).receptionistMinutes).toBe(2);
  }, 60_000);
});

describe('Retell authorization ordering and fail-closed store', () => {
  it('does not let an unsigned query selector poison a mapped event quota', async () => {
    const [trusted, other] = await Promise.all([makeTenant(), makeTenant()]);
    const callId = await makeMappedCall(trusted);
    const key = 'retell-selector-key';
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: key });
    const redis = rateStoreState.client as FakeRateRedis;
    redis.nextVerifiedCounts = [1, RETELL_EVENT_PER_CALL_LIMIT + 1];
    expect((await signedPost(eventUrl(other.clinicId), eventBody(callId), key)).statusCode).toBe(202);
    expect(redis.evalCalls).toBe(0);
    redis.nextVerifiedCounts = null;
    expect((await signedPost(eventUrl(trusted.clinicId), eventBody(callId), key)).statusCode).toBe(200);
  });

  it('creates one truthful idempotent handoff only for an authorized active overloaded tool call', async () => {
    const tenant = await makeTenant();
    const callId = await makeMappedCall(tenant);
    const key = 'retell-tool-overload-key';
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: key });
    const redis = rateStoreState.client as FakeRateRedis;
    redis.nextVerifiedCounts = [1, 121];
    const first = await signedPost(fnUrl(tenant.clinicId), toolBody(callId), key);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ allowed: false, needs_human: true, handoff_recorded: true, transfer_completed: false });
    redis.nextVerifiedCounts = [2, 122];
    const retry = await signedPost(fnUrl(tenant.clinicId), toolBody(callId), key);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().task_id).toBe(first.json().task_id);
    expect(retry.json().duplicate).toBe(true);
    expect(await db.staffTask.count({ where: { tenantId: tenant.id, title: 'AI receptionist human handoff requested' } })).toBe(1);
  });

  it('counts pre-consent denied mutation attempts and hands off at the tool bound', async () => {
    const tenant = await makeTenant();
    const callId = await makeMappedCall(tenant);
    const key = 'retell-pre-consent-bound-key';
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: key });
    const redis = rateStoreState.client as FakeRateRedis;
    redis.nextVerifiedCounts = [1, 121];
    const response = await signedPost(fnUrl(tenant.clinicId), toolBody(callId, 'book_appointment'), key);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ allowed: false, needs_human: true, reason: 'call_limit', handoff_recorded: true });
    expect(await db.staffTask.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it('mismatched selectors and ended calls never consume tool quota or create overload tasks', async () => {
    const [trusted, other] = await Promise.all([makeTenant(), makeTenant()]);
    const key = 'retell-tool-order-key';
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: key });
    const activeId = await makeMappedCall(trusted);
    const redis = rateStoreState.client as FakeRateRedis;
    redis.nextVerifiedCounts = [1, 121];
    expect((await signedPost(fnUrl(other.clinicId), toolBody(activeId), key)).statusCode).toBe(202);
    expect(redis.evalCalls).toBe(0);
    const endedId = await makeMappedCall(trusted);
    await db.receptionistCallLog.updateMany({ where: { tenantId: trusted.id, retellCallId: endedId }, data: { endedAt: new Date(), outcome: 'NO_ANSWER' } });
    expect((await signedPost(fnUrl(trusted.clinicId), toolBody(endedId), key)).statusCode).toBe(200);
    expect(redis.evalCalls).toBe(0);
    expect(await db.staffTask.count({ where: { tenantId: trusted.id } })).toBe(0);
  });

  it('fails closed on verified callback Redis outage and persists one safe handoff', async () => {
    const tenant = await makeTenant();
    const callId = await makeMappedCall(tenant);
    const key = 'retell-store-failure-key';
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: key });
    (rateStoreState.client as FakeRateRedis).fail = true;
    const response = await signedPost(fnUrl(tenant.clinicId), toolBody(callId), key);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ allowed: false, needs_human: true, reason: 'store_unavailable', handoff_recorded: true });
    expect(response.json().message).toContain('staff have not acknowledged');
    expect(await db.staffTask.count({ where: { tenantId: tenant.id } })).toBe(1);
  });
});
