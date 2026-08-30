import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

// ===========================================================================
// A vendor-side audit write must never be able to drop a patient's call.
//
// Found live on 2026-08-30. The production runtime behind carecommand.
// kodekinetics.com answered a correctly signed `call_inbound` with a 500 while
// the other runtime answered 200 for the same payload and the same key. The
// difference was PLATFORM_DATABASE_URL: `flagUnresolvedRetellIngress` writes a
// platform audit row, `platformDb` throws outright when that variable is unset,
// and the helper was awaited bare on the pre-answer hook. So a variable only the
// vendor console needs decided whether a caller was answered at all.
//
// The unresolved-ingress path is exactly the path a misconfigured pilot takes —
// a number nobody has mapped yet — so this was reachable on the FIRST real call
// to a newly provisioned line, which is the worst possible moment for it.
// ===========================================================================

const auditCreate = vi.fn(async () => {
  throw new Error('PlatformDatabase: PLATFORM_DATABASE_URL is required');
});

vi.mock('../lib/platformDb', () => ({
  platformDb: { platformAuditEvent: { create: (...args: unknown[]) => auditCreate(...args) } },
  platformDatabaseConfigured: () => false,
  assertPlatformDatabaseRole: async () => ({ ok: true }),
}));

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
const { env } = await import('../config/env');
const { RUNTIME_DYNAMIC_VARIABLE_NAMES } = await import('../lib/receptionist/runtimeVariables');

const RETELL_KEY = 'test-ingress-audit-resilience-key';
const originalRetellKey = env.RETELL_API_KEY;
let app: FastifyInstance;

beforeAll(async () => {
  env.RETELL_API_KEY = RETELL_KEY;
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  env.RETELL_API_KEY = originalRetellKey;
  await app?.close();
});

describe('call_inbound survives a failing platform audit write', () => {
  it('answers an unmapped number with runtime variables instead of a 500', async () => {
    auditCreate.mockClear();
    const payload = JSON.stringify({
      event: 'call_inbound',
      // Deliberately a number no tenant maps, so the handler takes the
      // unresolved-ingress branch that performs the platform audit write.
      call_inbound: { agent_id: 'agent_probe', from_number: '+12125550009', to_number: '+18335550123' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/receptionist/webhooks/retell',
      headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(payload, RETELL_KEY) },
      payload,
    });

    // The audit write was genuinely attempted and genuinely failed...
    expect(auditCreate).toHaveBeenCalledTimes(1);
    // ...and the caller was still served.
    expect(response.statusCode).toBe(200);

    const variables = response.json().call_inbound.dynamic_variables as Record<string, string>;
    // Every variable the deployed prompt reads must be present, or the agent
    // speaks a literal `{{brace}}` to the patient.
    for (const name of RUNTIME_DYNAMIC_VARIABLE_NAMES) {
      expect(variables[name], `missing runtime variable ${name}`).toBeTypeOf('string');
    }
    expect(JSON.stringify(variables)).not.toContain('{{');
  });
});
