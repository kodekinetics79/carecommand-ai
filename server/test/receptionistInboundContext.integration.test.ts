import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { signRetell } from './helpers/retellSignature';

// ===========================================================================
// What an inbound caller actually gets before they say a word.
//
// C2: there was no `call_inbound` handler anywhere in the tree, so a deployed
// prompt that says "use the live value {{is_open_now}}" ran with the literal
// braces and the agent was instructed to say "We next open {{next_opening}}."
// C7: the fourth simultaneous caller was hung up on by `stopPhoneCall`.
// C11: `callback_window` was read by the task layer and no tool could send it.
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
const { RUNTIME_DYNAMIC_VARIABLE_NAMES } = await import('../lib/receptionist/runtimeVariables');
const { MAX_TENANT_ACTIVE_CALLS } = await import('../lib/receptionist/admissionPolicy');

const RETELL_KEY = 'test-retell-inbound-context-key';
const originalRetellKey = env.RETELL_API_KEY;
const tenantIds: string[] = [];
let app: FastifyInstance;

const FALLBACK_NUMBER = '+14155550100';
const ALL_WEEK_HOURS = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map(day => [day, { open: true, start: '00:00', end: '23:59' }]),
);

function randomE164() {
  const suffix = (Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 12), 16) % 10_000_000).toString().padStart(7, '0');
  return `+1213${suffix}`;
}

async function makeTenant(options: { workingHours?: unknown } = {}) {
  const id = randomUUID();
  tenantIds.push(id);
  const phone = randomE164();
  await db.tenant.create({ data: { id, name: `ic-${id.slice(0, 6)}`, slug: `ic-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: '1 High Street', timezone: 'UTC', active: true }, select: { id: true } });
  const clinic = await db.receptionistClinic.create({
    data: {
      tenantId: id, name: 'Brightsmile', phone, active: true,
      country: 'US', timezone: 'UTC', defaultLanguage: 'en-US',
      addressLine: '500 Market Street', humanFallbackNumber: FALLBACK_NUMBER,
      workingHours: ('workingHours' in options ? options.workingHours : ALL_WEEK_HOURS) as never,
    },
    select: { id: true },
  });
  const location = await db.receptionistLocation.create({
    data: {
      tenantId: id, clinicId: clinic.id, branchId: branch.id, name: 'Downtown surgery',
      address: '12 Market Street', phone: '+14155550111', active: true,
    },
    select: { id: true, name: true, address: true, phone: true },
  });
  const providerAgentId = `agent_${id.replaceAll('-', '')}`;
  const providerAgentVersion = 2;
  const verifiedAt = new Date();
  await db.receptionistAgent.create({
    data: {
      tenantId: id, clinicId: clinic.id, name: 'Avery', active: true,
      providerAgentId, providerVersionTag: 'prod', providerVersion: providerAgentVersion,
      providerStatus: 'VERIFIED', providerPublished: true, providerAssignedTags: ['prod'],
      providerWebhookUrl: 'https://api.example.test/v1/receptionist/webhooks/retell',
      providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
      providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
      providerResponseEngineType: 'retell-llm', providerResponseEngineId: `llm_${id.replaceAll('-', '')}`,
      providerResponseEngineVersion: 1,
      providerFingerprint: 'a'.repeat(64), providerConfigRevision: 1, providerVerifiedRevision: 1,
      providerVerifiedAt: verifiedAt, providerVerificationExpiresAt: new Date(verifiedAt.getTime() + 60 * 60_000),
    },
  });
  return { id, clinicId: clinic.id, branchId: branch.id, phone, location, providerAgentId, providerAgentVersion };
}
type T = Awaited<ReturnType<typeof makeTenant>>;

function signedInject(url: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  return app.inject({
    method: 'POST', url,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) },
    payload: raw,
  });
}

function callInbound(toNumber: string, fromNumber = '+12125550001') {
  return signedInject('/v1/receptionist/webhooks/retell', {
    event: 'call_inbound',
    call_inbound: { agent_id: 'agent_whatever', from_number: fromNumber, to_number: toNumber },
  });
}

type InboundBody = {
  call_inbound: {
    dynamic_variables: Record<string, string>;
    metadata?: { patient_known?: boolean; admission_state?: string; admission_message?: string; clinic_id?: string };
  };
};

async function fillTenantCapacity(t: T) {
  await db.receptionistCallLog.createMany({
    data: Array.from({ length: MAX_TENANT_ACTIVE_CALLS }, (_, index) => ({
      tenantId: t.id,
      clinicId: t.clinicId,
      retellCallId: `busy-${index}-${randomUUID()}`,
      direction: 'inbound',
      outcome: 'IN_PROGRESS' as const,
      startedAt: new Date(),
    })),
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

describe('C2 — call_inbound resolves the values the prompt reads', () => {
  it('answers with every runtime variable, and never with a brace', async () => {
    const t = await makeTenant();
    const response = await callInbound(t.phone);
    expect(response.statusCode).toBe(200);
    const variables = (response.json() as InboundBody).call_inbound.dynamic_variables;

    // The frozen runtime list is the contract. Every name is answered.
    for (const name of RUNTIME_DYNAMIC_VARIABLE_NAMES) expect(variables).toHaveProperty(name);
    for (const value of Object.values(variables)) expect(value).not.toContain('{{');

    // The hours engine finally reaches an inbound caller.
    expect(variables.is_open_now).toBe('true');
    expect(variables.hours_today.length).toBeGreaterThan(0);
    expect(variables.emergency_number).toBe('911');
  });

  it('names the location the caller reached and the human they can be sent to', async () => {
    const t = await makeTenant();
    const variables = ((await callInbound(t.phone)).json() as InboundBody).call_inbound.dynamic_variables;
    expect(variables.location_name).toBe(t.location.name);
    expect(variables.location_address).toBe(t.location.address);
    expect(variables.location_phone).toBe(t.location.phone);
    expect(variables.human_fallback_number).toBe(FALLBACK_NUMBER);
  });

  it('says "unknown" rather than a brace when the line maps to no clinic', async () => {
    const response = await callInbound('+15005550999');
    expect(response.statusCode).toBe(200);
    const variables = (response.json() as InboundBody).call_inbound.dynamic_variables;
    for (const name of RUNTIME_DYNAMIC_VARIABLE_NAMES) expect(variables).toHaveProperty(name);
    expect(variables.is_open_now).toBe('unknown');
    for (const value of Object.values(variables)) expect(value).not.toContain('{{');
  });

  it('reports hours as unknown, not as open, when the clinic has none configured', async () => {
    const t = await makeTenant({ workingHours: null });
    const variables = ((await callInbound(t.phone)).json() as InboundBody).call_inbound.dynamic_variables;
    expect(variables.is_open_now).toBe('unknown');
    expect(variables.hours_today).toBe('');
  });
});

describe('C5 — the caller is greeted by name when we can be sure who they are', () => {
  it('publishes known_first_name on a single canonical phone match', async () => {
    const t = await makeTenant();
    const callerPhone = '+12125550777';
    await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchId, firstName: 'Casey', lastName: 'Nguyen', phone: callerPhone, lifecycleStage: 'ACTIVE' },
    });
    const body = (await callInbound(t.phone, callerPhone)).json() as InboundBody;
    expect(body.call_inbound.dynamic_variables.known_first_name).toBe('Casey');
    expect(body.call_inbound.metadata?.patient_known).toBe(true);
  });

  it('stays anonymous for an unknown caller', async () => {
    const t = await makeTenant();
    const body = (await callInbound(t.phone, '+12125550778')).json() as InboundBody;
    expect(body.call_inbound.dynamic_variables.known_first_name).toBe('');
    expect(body.call_inbound.metadata?.patient_known).toBe(false);
  });

  it('stays anonymous when two family members share the number', async () => {
    const t = await makeTenant();
    const callerPhone = '+12125550779';
    for (const firstName of ['Casey', 'Jordan']) {
      await db.patient.create({
        data: { tenantId: t.id, branchId: t.branchId, firstName, lastName: 'Nguyen', phone: callerPhone, lifecycleStage: 'ACTIVE' },
      });
    }
    const body = (await callInbound(t.phone, callerPhone)).json() as InboundBody;
    expect(body.call_inbound.dynamic_variables.known_first_name).toBe('');
    expect(body.call_inbound.metadata?.patient_known).toBe(false);
  });
});

describe('C7 — the caller past the limit is transferred, not disconnected', () => {
  it('admits at call_inbound and says so', async () => {
    const t = await makeTenant();
    const body = (await callInbound(t.phone)).json() as InboundBody;
    expect(body.call_inbound.dynamic_variables.admission_state).toBe('admitted');
    // Evaluating admission must not consume a capacity slot of its own.
    expect(await db.receptionistCallLog.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('tells the caller in their first turn when the practice is at capacity', async () => {
    const t = await makeTenant();
    await fillTenantCapacity(t);
    const body = (await callInbound(t.phone)).json() as InboundBody;
    expect(body.call_inbound.dynamic_variables.admission_state).toBe('at_capacity');
    expect(body.call_inbound.metadata?.admission_message?.length).toBeGreaterThan(0);
    expect(body.call_inbound.dynamic_variables.human_fallback_number).toBe(FALLBACK_NUMBER);
  });

  it('hands a denied tool call to the front desk instead of stopping the call', async () => {
    const t = await makeTenant();
    await fillTenantCapacity(t);
    const raw = {
      name: 'take_message',
      args: { reason_category: 'other', message: 'Please call me back.' },
      call: {
        call_id: `denied-${randomUUID()}`, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion,
        direction: 'inbound', to_number: t.phone, from_number: '+12125550002',
      },
    };
    const response = await signedInject('/v1/receptionist/webhooks/retell/fn', raw);
    expect(response.statusCode).toBe(202);
    const body = response.json() as Record<string, unknown>;
    // The old behaviour: `stopPhoneCall` and a dead line.
    expect(body.providerStopApplied).toBe(false);
    expect(body.disposition).toBe('transfer_to_human');
    expect(body.transfer_number).toBe(FALLBACK_NUMBER);
    expect(body.transfer_required).toBe(true);
    expect(String(body.message).length).toBeGreaterThan(0);
    expect(String(body.message)).not.toContain('{{');

    const signal = await db.operationalSignal.findFirstOrThrow({
      where: { tenantId: t.id, signalType: 'RECEPTIONIST_INGRESS_REVIEW' },
      select: { reason: true },
    });
    expect(signal.reason).toContain('concurrency_limit_reached');
    expect(signal.reason).toContain('provider_stop_applied=false');
  });

  it('refuses a demonstration workspace without hanging up on it', async () => {
    const t = await makeTenant();
    await db.tenant.update({ where: { id: t.id }, data: { mode: 'demo' } });
    const inbound = (await callInbound(t.phone)).json() as InboundBody;
    expect(inbound.call_inbound.dynamic_variables.admission_state).toBe('demo_workspace');

    const response = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'take_message',
      args: { reason_category: 'other', message: 'Please call me back.' },
      call: {
        call_id: `demo-${randomUUID()}`, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion,
        direction: 'inbound', to_number: t.phone, from_number: '+12125550003',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ providerStopApplied: false, disposition: 'transfer_to_human' });
  });
});

describe('C11 — the callback window a tool can finally send', () => {
  it('stores the window the caller gave and makes it the task due time', async () => {
    const t = await makeTenant();
    const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const response = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'take_message',
      args: {
        reason_category: 'billing',
        message: 'Question about my last invoice.',
        callback_window: { date, from: '14:00', to: '16:00' },
      },
      call: {
        call_id: `cbw-${randomUUID()}`, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion,
        direction: 'inbound', to_number: t.phone, from_number: '+12125550004',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ message_recorded: true, callback_window_recorded: true });

    const task = await db.staffTask.findFirstOrThrow({ where: { tenantId: t.id }, select: { metadata: true, dueAt: true } });
    const window = (task.metadata as { callbackWindow?: { start: string; end: string; timezone: string } }).callbackWindow;
    expect(window).toBeTruthy();
    expect(window!.start).toBe(`${date}T14:00:00.000Z`);
    expect(window!.end).toBe(`${date}T16:00:00.000Z`);
    // `dueAt` prefers the window: staff call back when the caller said to.
    expect(task.dueAt?.toISOString()).toBe(window!.start);
  });

  it('records no window rather than an invented one when the caller gave nothing usable', async () => {
    const t = await makeTenant();
    const response = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'take_message',
      args: { reason_category: 'other', message: 'Please call me back.', callback_window: { date: 'thursday', from: 'afternoon', to: 'evening' } },
      call: {
        call_id: `cbw-bad-${randomUUID()}`, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion,
        direction: 'inbound', to_number: t.phone, from_number: '+12125550005',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ callback_window_recorded: false });
    const task = await db.staffTask.findFirstOrThrow({ where: { tenantId: t.id }, select: { metadata: true } });
    expect((task.metadata as { callbackWindow?: unknown }).callbackWindow).toBeNull();
  });

  it('carries the window through request_human_handoff too', async () => {
    const t = await makeTenant();
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const response = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'request_human_handoff',
      args: { reason_category: 'human_requested', callback_window: { date, from: '09:30', to: '11:00' } },
      call: {
        call_id: `hoff-${randomUUID()}`, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion,
        direction: 'inbound', to_number: t.phone, from_number: '+12125550006',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ handoff_recorded: true, callback_window_recorded: true });
    const task = await db.staffTask.findFirstOrThrow({ where: { tenantId: t.id }, select: { metadata: true } });
    expect((task.metadata as { callbackWindow?: { start: string } }).callbackWindow?.start).toBe(`${date}T09:30:00.000Z`);
  });
});
