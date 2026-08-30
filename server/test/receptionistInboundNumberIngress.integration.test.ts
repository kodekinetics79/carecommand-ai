import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

// ===========================================================================
// The caller dialled the provider line, not the letterhead.
//
// `ReceptionistClinic.inboundNumber` is the provider-owned DID a clinic answers
// on; `phone` is the public number the agent SPEAKS. Deploy binds
// `inboundNumber`, verification re-reads it, readiness passes `number_bound` on
// it — and the ingress resolver matched `phone` alone, so a clinic configured
// the supported way resolved to no tenant at all.
//
// The introducing migration backfilled `inboundNumber` from `phone`, which is
// why every existing fixture and every seeded clinic hid this: the two columns
// were equal everywhere. The gap opens on the FIRST clinic with a real DID.
//
// What the caller got: no clinic name, `is_open_now = "unknown"`, no fallback
// number, no returning-caller recognition, no admission state — with all 21
// readiness checks green. The checklist was reporting on what we wrote, not on
// what a caller gets, which is the exact failure this module was rebuilt to end.
// ===========================================================================

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

const RETELL_KEY = 'test-inbound-number-ingress-key';
const originalRetellKey = env.RETELL_API_KEY;
const tenantIds: string[] = [];
let app: FastifyInstance;

const ALL_WEEK = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map(day => [day, { open: true, start: '00:00', end: '23:59' }]),
);

function randomE164() {
  const suffix = (Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 12), 16) % 10_000_000).toString().padStart(7, '0');
  return `+1213${suffix}`;
}

async function makeClinic(options: { inboundNumber?: string | null }) {
  const id = randomUUID();
  tenantIds.push(id);
  const publicPhone = randomE164();
  await db.tenant.create({ data: { id, name: `inb-${id.slice(0, 6)}`, slug: `inb-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  await db.branch.create({ data: { tenantId: id, name: 'Main', location: '1 High Street', timezone: 'UTC', active: true } });
  await db.receptionistClinic.create({
    data: {
      tenantId: id, name: 'Brightsmile', phone: publicPhone, inboundNumber: options.inboundNumber ?? null,
      active: true, country: 'US', timezone: 'UTC', defaultLanguage: 'en-US',
      addressLine: '500 Market Street', humanFallbackNumber: '+14155550100',
      workingHours: ALL_WEEK as never,
    },
  });
  return { tenantId: id, publicPhone };
}

function callInbound(toNumber: string) {
  const payload = JSON.stringify({
    event: 'call_inbound',
    call_inbound: { agent_id: 'agent_probe', from_number: '+12125550001', to_number: toNumber },
  });
  return app.inject({
    method: 'POST', url: '/v1/receptionist/webhooks/retell',
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(payload, RETELL_KEY) },
    payload,
  });
}

beforeAll(async () => {
  env.RETELL_API_KEY = RETELL_KEY;
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  env.RETELL_API_KEY = originalRetellKey;
  await app?.close();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
});

describe('inbound ingress resolves on the line the clinic actually answers', () => {
  it('resolves a clinic whose provider DID differs from its public number', async () => {
    const providerDid = randomE164();
    await makeClinic({ inboundNumber: providerDid });

    const variables = (await callInbound(providerDid)).json().call_inbound.dynamic_variables as Record<string, string>;

    expect(variables.location_name).toBe('Brightsmile');
    expect(variables.is_open_now).not.toBe('unknown');
    expect(variables.human_fallback_number).toBe('+14155550100');
  });

  it('still resolves a clinic that has no assigned DID, on its public number', async () => {
    const { publicPhone } = await makeClinic({ inboundNumber: null });

    const variables = (await callInbound(publicPhone)).json().call_inbound.dynamic_variables as Record<string, string>;

    expect(variables.location_name).toBe('Brightsmile');
    expect(variables.is_open_now).not.toBe('unknown');
  });

  it('does not answer on the public number once a different DID is assigned', async () => {
    // The clinic answers on its DID. Its letterhead number is not a line we own,
    // so a call claiming that destination must not silently borrow the clinic's
    // identity.
    const { publicPhone } = await makeClinic({ inboundNumber: randomE164() });

    const variables = (await callInbound(publicPhone)).json().call_inbound.dynamic_variables as Record<string, string>;

    expect(variables.location_name).toBe('');
    expect(variables.is_open_now).toBe('unknown');
  });
});
