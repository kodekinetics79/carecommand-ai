import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

// FIX 1 proof: the live-agent tool webhook (/webhooks/retell/fn) is a booking +
// SMS primitive. It must reject unsigned/invalid calls in production EXACTLY like
// the sibling event webhook, 503 when the key is missing, allow the dev bypass
// only outside production, and carry a tight per-route rate limit.
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
const { verifyRetellSignature } = await import('../modules/receptionist/routes');

let app: FastifyInstance;
const tenantIds: string[] = [];
const original = { NODE_ENV: env.NODE_ENV, RETELL_API_KEY: env.RETELL_API_KEY };
const phoneFor = (id: string) => `+1${(BigInt(`0x${id.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `sec-${id.slice(0, 6)}`, slug: `sec-${id.slice(0, 8)}` } });
  await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'X' } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Clinic', phone: phoneFor(id) }, select: { id: true } });
  return { id, clinicId: clinic.id };
}

function setEnv(patch: { NODE_ENV?: string; RETELL_API_KEY?: string }) {
  const e = env as typeof env;
  if (patch.NODE_ENV !== undefined) e.NODE_ENV = patch.NODE_ENV as typeof env.NODE_ENV;
  if (patch.RETELL_API_KEY !== undefined) e.RETELL_API_KEY = patch.RETELL_API_KEY;
}

const fnUrl = (clinicId: string) => `/v1/receptionist/webhooks/retell/fn?clinicId=${clinicId}`;
const body = (name: string, args: Record<string, unknown> = {}) => JSON.stringify({ name, args, call: { call_id: `sec-${randomUUID()}` } });
const sign = signRetell;

beforeAll(async () => { app = await buildApp(); }, 60_000);
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
    expect(verifyRetellSignature(raw, sign(raw, key, now), key, now)).toBe(true);
    expect(verifyRetellSignature(raw, sign(raw, key, now - 300_000), key, now)).toBe(true);
    expect(verifyRetellSignature(raw, sign(raw, key, now + 300_000), key, now)).toBe(true);
  });

  it('rejects stale/future, wrong-body/key, legacy, malformed, extra, and duplicated fields', () => {
    expect(verifyRetellSignature(raw, sign(raw, key, now - 300_001), key, now)).toBe(false);
    expect(verifyRetellSignature(raw, sign(raw, key, now + 300_001), key, now)).toBe(false);
    expect(verifyRetellSignature(Buffer.from(`${raw.toString()} `), sign(raw, key, now), key, now)).toBe(false);
    expect(verifyRetellSignature(raw, sign(raw, 'wrong-key', now), key, now)).toBe(false);
    expect(verifyRetellSignature(raw, sign(raw, key, now).split('d=')[1], key, now)).toBe(false);
    expect(verifyRetellSignature(raw, `d=${'a'.repeat(64)},v=${now}`, key, now)).toBe(false);
    expect(verifyRetellSignature(raw, `${sign(raw, key, now)},d=${'a'.repeat(64)}`, key, now)).toBe(false);
    expect(verifyRetellSignature(raw, [sign(raw, key, now), sign(raw, key, now)], key, now)).toBe(false);
  });
});

describe('receptionist /fn — signature enforcement (FIX 1)', () => {
  it('production + real key + UNSIGNED → 401 (the auth-bypass proof)', async () => {
    const t = await makeTenant();
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: 'retell_real_secret' });
    try {
      const res = await app.inject({ method: 'POST', url: fnUrl(t.clinicId), headers: { 'content-type': 'application/json' }, payload: body('check_availability', { appointment_date: '2030-01-01' }) });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('INVALID_SIGNATURE');
    } finally {
      setEnv(original);
    }
  });

  it('production + missing key → 503 (never accept, never process)', async () => {
    const t = await makeTenant();
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: '' });
    try {
      const res = await app.inject({ method: 'POST', url: fnUrl(t.clinicId), headers: { 'content-type': 'application/json' }, payload: body('check_availability') });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('WEBHOOK_NOT_CONFIGURED');
    } finally {
      setEnv(original);
    }
  });

  it('a current-format correctly-signed call passes authentication', async () => {
    const t = await makeTenant();
    setEnv({ RETELL_API_KEY: 'retell_real_secret' });
    try {
      const raw = body('check_availability', { appointment_date: '2030-01-01' });
      const res = await app.inject({ method: 'POST', url: fnUrl(t.clinicId), headers: { 'content-type': 'application/json', 'x-retell-signature': sign(raw, 'retell_real_secret') }, payload: raw });
      expect(res.statusCode).toBe(202); // verified but no persisted call mapping: fail closed
    } finally {
      setEnv(original);
    }
  });

  it('a WRONG signature is rejected (401) even outside production', async () => {
    const t = await makeTenant();
    setEnv({ RETELL_API_KEY: 'retell_real_secret' });
    try {
      const raw = body('check_availability');
      const res = await app.inject({ method: 'POST', url: fnUrl(t.clinicId), headers: { 'content-type': 'application/json', 'x-retell-signature': sign(raw, 'a_different_key') }, payload: raw });
      expect(res.statusCode).toBe(401);
    } finally {
      setEnv(original);
    }
  });

  it('rejects body mutation after signing', async () => {
    const t = await makeTenant();
    setEnv({ RETELL_API_KEY: 'retell_real_secret' });
    try {
      const originalRaw = body('check_availability', { appointment_date: '2030-01-01' });
      const mutatedRaw = originalRaw.replace('2030-01-01', '2030-01-02');
      const res = await app.inject({ method: 'POST', url: fnUrl(t.clinicId), headers: { 'content-type': 'application/json', 'x-retell-signature': sign(originalRaw, 'retell_real_secret') }, payload: mutatedRaw });
      expect(res.statusCode).toBe(401);
    } finally {
      setEnv(original);
    }
  });

  it('does not permit an unsigned development bypass when no verifier is configured', async () => {
    const t = await makeTenant();
    setEnv({ NODE_ENV: 'development', RETELL_API_KEY: '' });
    const res = await app.inject({ method: 'POST', url: fnUrl(t.clinicId), headers: { 'content-type': 'application/json' }, payload: body('check_availability', { appointment_date: '2030-01-01' }) });
    expect(res.statusCode).toBe(503);
  });
});

describe('receptionist event webhook — production fail-closed posture', () => {
  const eventUrl = (clinicId: string) => `/v1/receptionist/webhooks/retell?clinicId=${clinicId}`;
  const eventBody = () => JSON.stringify({ event: 'call_started', call: { call_id: `evt-${randomUUID()}`, from_number: '+15551239999', direction: 'inbound' } });

  it('production + real key + UNSIGNED → 401 (no PHI ingested unverified)', async () => {
    const t = await makeTenant();
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: 'retell_real_secret' });
    try {
      const res = await app.inject({ method: 'POST', url: eventUrl(t.clinicId), headers: { 'content-type': 'application/json' }, payload: eventBody() });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('INVALID_SIGNATURE');
    } finally {
      setEnv(original);
    }
  });

  it('production + missing key → 503', async () => {
    const t = await makeTenant();
    setEnv({ NODE_ENV: 'production', RETELL_API_KEY: '' });
    try {
      const res = await app.inject({ method: 'POST', url: eventUrl(t.clinicId), headers: { 'content-type': 'application/json' }, payload: eventBody() });
      expect(res.statusCode).toBe(503);
    } finally {
      setEnv(original);
    }
  });

  it('a current-format correctly-signed event passes authentication', async () => {
    const t = await makeTenant();
    setEnv({ RETELL_API_KEY: 'retell_real_secret' });
    try {
      const raw = eventBody();
      const res = await app.inject({ method: 'POST', url: eventUrl(t.clinicId), headers: { 'content-type': 'application/json', 'x-retell-signature': sign(raw, 'retell_real_secret') }, payload: raw });
      expect(res.statusCode).toBe(202); // verified but unresolved first-call mapping
    } finally {
      setEnv(original);
    }
  });

  it('rejects stale official-format event and tool callbacks', async () => {
    const t = await makeTenant();
    setEnv({ RETELL_API_KEY: 'retell_real_secret' });
    try {
      const timestamp = Date.now() - 300_001;
      const rawEvent = eventBody();
      const rawTool = body('check_availability');
      const [eventResponse, toolResponse] = await Promise.all([
        app.inject({ method: 'POST', url: eventUrl(t.clinicId), headers: { 'content-type': 'application/json', 'x-retell-signature': sign(rawEvent, 'retell_real_secret', timestamp) }, payload: rawEvent }),
        app.inject({ method: 'POST', url: fnUrl(t.clinicId), headers: { 'content-type': 'application/json', 'x-retell-signature': sign(rawTool, 'retell_real_secret', timestamp) }, payload: rawTool }),
      ]);
      expect(eventResponse.statusCode).toBe(401);
      expect(toolResponse.statusCode).toBe(401);
    } finally {
      setEnv(original);
    }
  });
});

describe('receptionist /fn — per-route rate limit engages', () => {
  it('a non-allowlisted IP is cut off at the 30/min /fn ceiling', async () => {
    const t = await makeTenant();
    setEnv({ NODE_ENV: 'development', RETELL_API_KEY: '' });
    const ip = '203.0.113.77'; // non-loopback → not on the dev allowList
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await app.inject({ method: 'POST', url: fnUrl(t.clinicId), headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, payload: body('check_availability', { appointment_date: '2030-01-01' }) });
      codes.push(res.statusCode);
    }
    expect(codes[0]).toBe(503);
    expect(codes.filter(c => c === 503).length).toBeLessThanOrEqual(30);
    expect(codes[codes.length - 1]).toBe(429); // the 31st is blocked
  });
});
