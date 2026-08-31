import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { fingerprintJson } = await import('../modules/receptionist/intakeContract');
const { isTargetDialable } = await import('../modules/receptionist/outbound');

// ===========================================================================
// REPRODUCTION — production incident, 2026-08-31.
//
// An outbound call was placed to a real number and the provider never
// connected it. The provider record read back:
//
//   call_status         not_connected
//   disconnection_reason user_declined
//   duration_ms         0
//   start_timestamp     == end_timestamp
//   to_number           absent
//   metadata            absent          <-- the call never started, so the
//                                            per-call metadata we submit was
//                                            never attached to a live call
//
// No lifecycle webhook was ever delivered, because there was no lifecycle:
// `call_started` never fired, so `call_ended` and `call_analyzed` never fired
// either. Every piece of state that only a webhook writes therefore stayed
// exactly as the launch request left it, permanently:
//
//   * ReceptionistCallLog  outcome=IN_PROGRESS, endedAt=null   (forever)
//   * ReceptionistCallTarget status=CALLING                    (forever)
//     — only PENDING is dialable (`DIALABLE_TARGET_STATUS`), so that patient
//       can never be called again by anybody.
//   * provider-sync, the one operator lever, answered
//       409 { status: 'quarantined', reason: 'provider_binding_mismatch' }
//     because it authenticates the provider record by reading OUR metadata
//     back off it (outbound.ts ~2655-2670) — and a call that never started
//     carries none.
//   * every later attended call was refused `live_test_single_active_call`,
//     because `activeCalls > 0` is computed from that same stranded row.
//
// SIX OF THESE NINE TESTS WERE WRITTEN TO FAIL, as `it.fails(...)`, and were
// the acceptance bar for the fix. All six now pass and the markers are gone:
// this file is a regression suite, not a reproduction. It is the whole point
// of the exercise that not one assertion was weakened to get there — the six
// were flipped only after the fix made them true.
//
// What made them true: the malformed per-call webhook URL (a trailing
// `&campaignId=` that failed query parsing with a 400 BEFORE signature
// verification, so the provider's every delivery was permanently refused),
// a `deadlineAt` bound so a non-terminal row stops holding capacity, terminal
// outcomes taken from the provider's own signal rather than from an LLM
// analysis block that a never-connected call never produces, and a
// reconciler that asks the provider instead of waiting to be told.
//
// The remaining three tests were green from the start and stay green. They are
// the guard rails: they stop an over-broad fix from accepting a provider call
// we never submitted, and they record which half of the admission story was
// already sound.
//
// ---------------------------------------------------------------------------
// ASSUMPTIONS, stated out loud (see the report; these are product decisions):
//
//  A. TERMINALITY IS NOT OPTIONAL. A call the provider says never connected
//     must not stay `IN_PROGRESS`. These tests assert the END STATE, and drive
//     it through the only lever the product exposes today (`provider-sync`).
//     A fix that reconciles automatically — a sweeper over non-terminal call
//     logs — satisfies exactly the same assertions, because a sweeper would
//     have already terminalised the row before the sync request arrives.
//  B. THE OUTCOME FOR `not_connected` IS THE ONE ALREADY IN THE CODE.
//     `providerTerminalOutcome` in outbound.ts maps not_connected to
//     NO_ANSWER (VOICEMAIL when the reason mentions voicemail). Nothing here
//     invents a new outcome; `user_declined` lands on NO_ANSWER.
//  C. THE TARGET GOES BACK TO PENDING WHILE RETRIES REMAIN. This is
//     `targetStatusAfterOutcome`'s existing rule for NO_ANSWER, applied
//     through the same reconciliation. With attempts=1 and
//     maxRetryAttempts=2, the intended state is PENDING and the patient is
//     dialable again. The one thing that is unambiguously wrong is CALLING.
//  D. "A CALL WE SUBMITTED" IS ONE WITH LOCAL SUBMISSION EVIDENCE — a
//     ReceptionistOutboundProviderIntent for this call log, bound to this
//     provider call id by our own synchronous create-phone-call response.
//     A retellCallId sitting on a row with no such evidence is NOT ours and
//     must stay quarantined however friendly the provider record looks.
// ===========================================================================

type TenantFixture = Awaited<ReturnType<typeof makeTenant>>;
type Json = Record<string, unknown>;

let app: FastifyInstance;
const tenantIds: string[] = [];
const originalRetell = {
  apiKey: env.RETELL_API_KEY,
  fromNumber: env.RETELL_FROM_NUMBER,
  baseUrl: env.RETELL_BASE_URL,
};
const originalLiveUat = {
  callsAuthorized: env.LIVE_TEST_CALLS_AUTHORIZED,
  executionId: env.LIVE_TEST_EXECUTION_ID,
  tenantId: env.LIVE_TEST_TENANT_ID,
  authorizedPhone: env.AUTHORIZED_TEST_PHONE_E164,
  allowlist: env.LIVE_TEST_RECIPIENT_ALLOWLIST,
  expiresAt: env.LIVE_TEST_EXPIRES_AT,
  expiresInHours: env.LIVE_TEST_EXPIRES_IN_HOURS,
  timezone: env.LIVE_TEST_TIMEZONE,
  windowStart: env.LIVE_TEST_WINDOW_START,
  windowEnd: env.LIVE_TEST_WINDOW_END,
  maxCalls: env.LIVE_TEST_MAX_CALLS,
  maxCallMinutes: env.LIVE_TEST_MAX_CALL_MINUTES,
  maxTotalMinutes: env.LIVE_TEST_MAX_TOTAL_MINUTES,
  maxCost: env.LIVE_TEST_MAX_PROVIDER_COST_USD,
  estimate: env.LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD,
};

function phoneFor(seed: string, suffix = 0): string {
  const digits = BigInt(`0x${seed.replaceAll('-', '').slice(0, 14)}`) % 9_000_000_000n;
  return `+1${(digits + 1_000_000_000n + BigInt(suffix)).toString().slice(-10)}`;
}

/** A quiet-hours window that is never active now, so no dial is ever skipped. */
function quietWindowOutsideNow(timezone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0);
  const now = hour * 60 + minute;
  const format = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return { quietHoursStart: format((now + 60) % 1440), quietHoursEnd: format((now + 61) % 1440) };
}

/**
 * One tenant with a verified provider deployment.
 *
 * Every provider id is derived from a fresh tenant uuid:
 * `ReceptionistAgent_active_provider_deployment_unique` is on
 * (providerAgentId, providerVersion) GLOBALLY, not per tenant, so a hardcoded
 * id collides with itself on the second run against the same dev database.
 */
async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Lifecycle ${id.slice(0, 6)}`, slug: `lifecycle-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({
    data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' },
  });
  const branch = await db.branch.create({
    data: { tenantId: id, name: 'Main branch', location: 'New York', timezone: 'America/New_York' },
  });
  const owner = await db.user.create({
    data: {
      tenantId: id, role: 'OWNER', active: true, branchId: branch.id,
      email: `owner-${id.slice(0, 8)}@lifecycle.test`, displayName: 'Owner',
    },
  });
  const clinic = await db.receptionistClinic.create({
    data: { tenantId: id, name: 'Main clinic', phone: phoneFor(id), timezone: 'America/New_York', country: 'US', defaultLanguage: 'en-US' },
  });
  const now = new Date();
  const providerAgentId = `agent_${id.replaceAll('-', '')}`;
  const providerResponseEngineId = `llm_${id.replaceAll('-', '')}`;
  const providerResponseEngineGraphFingerprint = 'a'.repeat(64);
  const providerBookToolSchema = { name: 'book_appointment', parameters: { type: 'object', properties: {} } };
  const providerBookToolFingerprint = fingerprintJson({
    tool: providerBookToolSchema,
    engine: { type: 'retell-llm', id: providerResponseEngineId, version: 1, graphFingerprint: providerResponseEngineGraphFingerprint },
  });
  const agent = await db.receptionistAgent.create({
    data: {
      tenantId: id, clinicId: clinic.id, name: 'Verified outbound agent',
      providerAgentId, providerVersion: 1, providerVersionTag: 'prod',
      providerStatus: 'VERIFIED', providerPublished: true, providerAssignedTags: ['prod'],
      providerFingerprint: 'c'.repeat(64), providerConfigRevision: 1, providerVerifiedRevision: 1,
      providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
      providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
      providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
      providerResponseEngineType: 'retell-llm', providerResponseEngineId, providerResponseEngineVersion: 1,
      providerResponseEngineGraphFingerprint, providerEffectiveDynamicVariables: {},
      providerBookToolSchema, providerBookToolFingerprint, providerToolCallStrictMode: true,
      providerVerifiedAt: now, providerVerificationExpiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
    },
  });
  await db.receptionistLocation.create({
    data: { tenantId: id, clinicId: clinic.id, branchId: branch.id, name: 'Main clinic', address: '1 Main Street', active: true },
  });
  return { id, ownerId: owner.id, branchId: branch.id, clinicId: clinic.id, agentId: agent.id, providerAgentId };
}

function auth(tenant: TenantFixture) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: tenant.ownerId, tenantId: tenant.id, role: 'OWNER', type: 'access' })}` };
}

async function createCampaign(tenant: TenantFixture, options: { maxRetryAttempts?: number } = {}) {
  const quietHours = quietWindowOutsideNow();
  const created = await app.inject({
    method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: auth(tenant),
    payload: {
      clinicId: tenant.clinicId, agentId: tenant.agentId,
      name: `Lifecycle ${randomUUID().slice(0, 8)}`,
      script: 'Call the patient about care coordination.',
      requiredFields: ['firstName', 'lastName', 'phone'],
      bookingMode: 'APPOINTMENT_REQUEST_ONLY',
      purpose: 'CARE_COORDINATION', legalBasis: 'TREATMENT_OPERATIONS', policyVersion: 'OUTBOUND-LIFECYCLE-1',
      quietHoursStart: quietHours.quietHoursStart, quietHoursEnd: quietHours.quietHoursEnd,
      maxRetryAttempts: options.maxRetryAttempts ?? 2,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const campaignId = (created.json() as { id: string }).id;
  const approved = await app.inject({
    method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/approve`, headers: auth(tenant),
    payload: { approvalConfirmed: true, status: 'RUNNING' },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return campaignId;
}

async function makePatient(tenant: TenantFixture, suffix: number, phone?: string) {
  return db.patient.create({
    data: {
      tenantId: tenant.id, branchId: tenant.branchId,
      firstName: `Patient${suffix}`, lastName: 'Lifecycle', phone: phone ?? phoneFor(tenant.id, suffix), tags: [],
    },
  });
}

async function addTarget(tenant: TenantFixture, campaignId: string, patient: { id: string; firstName: string; lastName: string; phone: string | null }) {
  const added = await app.inject({
    method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`, headers: auth(tenant),
    payload: { targets: [{ patientId: patient.id, phone: patient.phone, firstName: patient.firstName, lastName: patient.lastName }] },
  });
  expect(added.statusCode, added.body).toBe(201);
  return db.receptionistCallTarget.findFirstOrThrow({ where: { tenantId: tenant.id, campaignId, patientId: patient.id } });
}

async function addPatientTarget(tenant: TenantFixture, campaignId: string, suffix: number, phone?: string) {
  return addTarget(tenant, campaignId, await makePatient(tenant, suffix, phone));
}

function jsonResponse(body: Json, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * The provider exactly as it behaved during the incident: it ACCEPTS the call
 * (a real `call_id` comes back synchronously, so we hold the id ourselves),
 * and every later read of that id says the call never connected — with no
 * metadata, no to_number, zero duration and identical timestamps.
 *
 * No webhook is ever delivered by this stub, because the real provider never
 * delivered one: there was no call to report a lifecycle for.
 */
function stubNeverConnectedProvider(agentId: string, options: { includeMetadata?: boolean } = {}) {
  const submitted: Array<{ callId: string; metadata: Json }> = [];
  const reads: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes('/v2/create-phone-call')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { metadata?: Json };
      const callId = `call_${randomUUID().replaceAll('-', '')}`;
      submitted.push({ callId, metadata: body.metadata ?? {} });
      return jsonResponse({ call_id: callId, agent_id: agentId, agent_version: 1 }, 201);
    }
    if (url.includes('/v2/get-call/')) {
      const callId = decodeURIComponent(url.split('/v2/get-call/')[1] ?? '');
      reads.push(callId);
      const instant = Date.now();
      const record = submitted.find(entry => entry.callId === callId);
      return jsonResponse({
        call_id: callId,
        call_status: 'not_connected',
        disconnection_reason: 'user_declined',
        duration_ms: 0,
        // Identical start and end: the provider registered the call and closed
        // it in the same instant. There is no elapsed call here at all.
        start_timestamp: instant,
        end_timestamp: instant,
        agent_id: agentId,
        agent_version: 1,
        // The heart of the incident. `to_number` and `metadata` are absent from
        // a record for a call that never started.
        ...(options.includeMetadata && record ? { metadata: record.metadata } : {}),
      });
    }
    if (url.includes('/v2/stop-call/')) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, submitted, reads };
}

const placeCall = (tenant: TenantFixture, campaignId: string, payload: Json) => app.inject({
  method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant), payload,
});

/**
 * The only lever an operator has for a call with no webhook. A fix that
 * reconciles on a timer instead makes this a no-op rather than a failure, and
 * every assertion downstream of it still holds.
 */
const reconcile = (tenant: TenantFixture, campaignId: string, callLogId: string) => app.inject({
  method: 'POST',
  url: `/v1/receptionist/outbound-campaigns/${campaignId}/call-logs/${callLogId}/provider-sync`,
  headers: auth(tenant),
});

const callLog = (id: string) => db.receptionistCallLog.findUniqueOrThrow({ where: { id } });
const callTarget = (id: string) => db.receptionistCallTarget.findUniqueOrThrow({ where: { id } });

/** How many calls the admission gate believes this tenant currently has up. */
const activeCallCount = (tenantId: string) => db.receptionistCallLog.count({
  where: { tenantId, outcome: 'IN_PROGRESS', endedAt: null },
});

/** Launch one call the provider accepts and then never connects. */
async function strandOneCall(tenant: TenantFixture, campaignId: string, targetId: string, phone: string) {
  const launched = await placeCall(tenant, campaignId, { targetId, phone });
  expect(launched.statusCode, launched.body).toBe(201);
  const body = launched.json() as { status: string; callId: string; callLogId: string };
  expect(body.status).toBe('launched');
  // The launch left exactly the state the incident started from.
  expect(await callLog(body.callLogId)).toMatchObject({ outcome: 'IN_PROGRESS', endedAt: null, retellCallId: body.callId });
  expect((await callTarget(targetId)).status).toBe('CALLING');
  return body;
}

function configureLiveUat(tenant: TenantFixture, destination: string) {
  env.LIVE_TEST_CALLS_AUTHORIZED = true;
  env.LIVE_TEST_EXECUTION_ID = `voice-uat-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  env.LIVE_TEST_TENANT_ID = tenant.id;
  env.AUTHORIZED_TEST_PHONE_E164 = destination;
  env.LIVE_TEST_RECIPIENT_ALLOWLIST = '';
  env.LIVE_TEST_EXPIRES_AT = undefined;
  env.LIVE_TEST_EXPIRES_IN_HOURS = 24;
  env.LIVE_TEST_TIMEZONE = 'UTC';
  env.LIVE_TEST_WINDOW_START = '00:00';
  env.LIVE_TEST_WINDOW_END = '23:59';
  env.LIVE_TEST_MAX_CALLS = 4;
  env.LIVE_TEST_MAX_CALL_MINUTES = 5;
  env.LIVE_TEST_MAX_TOTAL_MINUTES = 30;
  env.LIVE_TEST_MAX_PROVIDER_COST_USD = 10;
  env.LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD = 0.1;
}

function restoreLiveUat() {
  env.LIVE_TEST_CALLS_AUTHORIZED = originalLiveUat.callsAuthorized;
  env.LIVE_TEST_EXECUTION_ID = originalLiveUat.executionId;
  env.LIVE_TEST_TENANT_ID = originalLiveUat.tenantId;
  env.AUTHORIZED_TEST_PHONE_E164 = originalLiveUat.authorizedPhone;
  env.LIVE_TEST_RECIPIENT_ALLOWLIST = originalLiveUat.allowlist;
  env.LIVE_TEST_EXPIRES_AT = originalLiveUat.expiresAt;
  env.LIVE_TEST_EXPIRES_IN_HOURS = originalLiveUat.expiresInHours;
  env.LIVE_TEST_TIMEZONE = originalLiveUat.timezone;
  env.LIVE_TEST_WINDOW_START = originalLiveUat.windowStart;
  env.LIVE_TEST_WINDOW_END = originalLiveUat.windowEnd;
  env.LIVE_TEST_MAX_CALLS = originalLiveUat.maxCalls;
  env.LIVE_TEST_MAX_CALL_MINUTES = originalLiveUat.maxCallMinutes;
  env.LIVE_TEST_MAX_TOTAL_MINUTES = originalLiveUat.maxTotalMinutes;
  env.LIVE_TEST_MAX_PROVIDER_COST_USD = originalLiveUat.maxCost;
  env.LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD = originalLiveUat.estimate;
}

/** Register the client attempt token an attended live-test dial requires. */
async function registerAttempt(tenant: TenantFixture, campaignId: string) {
  const token = randomUUID();
  const registered = await app.inject({
    method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/launch-attempts`,
    headers: auth(tenant), payload: { token },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  return token;
}

beforeAll(async () => {
  // A real (non-`mock`) key, so every provider interaction goes through the
  // stubbed fetch and exercises the real client code paths.
  env.RETELL_API_KEY = 'real_lifecycle_test_key';
  env.RETELL_FROM_NUMBER = '+15550000009';
  env.RETELL_BASE_URL = 'https://retell.lifecycle.test';
  app = await buildApp();
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  restoreLiveUat();
});

afterAll(async () => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  restoreLiveUat();
  vi.unstubAllGlobals();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

// ===========================================================================
// 1. A call the provider never connects must reach a terminal state.
// ===========================================================================
describe('an outbound call the provider never connects', () => {
  it('reaches a terminal outcome and releases its target, with no webhook ever delivered', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const target = await addPatientTarget(tenant, campaignId, 1);
    const provider = stubNeverConnectedProvider(tenant.providerAgentId);

    const launched = await strandOneCall(tenant, campaignId, target.id, target.phone);

    // The provider now says the call never connected. Nothing signed ever
    // arrives — `call_started` never fired, so there is no lifecycle webhook
    // for this call and there never will be.
    await reconcile(tenant, campaignId, launched.callLogId);

    const row = await callLog(launched.callLogId);
    expect(row.outcome, 'the call log is still IN_PROGRESS for a call that never happened').not.toBe('IN_PROGRESS');
    expect(row.endedAt, 'a call the provider never connected has no end time').not.toBeNull();
    expect(row.durationSeconds).toBe(0);

    const releasedTarget = await callTarget(target.id);
    expect(releasedTarget.status, 'the patient is pinned in CALLING and can never be dialled again').not.toBe('CALLING');

    // Nothing signed was ever delivered for this call, and nothing ever will
    // be. The provider read is the only evidence that exists — so the system
    // has to be able to act on it.
    expect(provider.reads).toContain(launched.callId);
  });

  it('does not leave a call the provider never started counted as an active call', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const target = await addPatientTarget(tenant, campaignId, 2);
    stubNeverConnectedProvider(tenant.providerAgentId);

    const launched = await strandOneCall(tenant, campaignId, target.id, target.phone);
    expect(await activeCallCount(tenant.id)).toBe(1);

    await reconcile(tenant, campaignId, launched.callLogId);

    // This exact count is what every admission gate reads. While it stays at
    // 1 the tenant is permanently one call closer to its ceiling — and at the
    // attended-test ceiling of one, permanently shut.
    expect(await activeCallCount(tenant.id), 'a call that never connected still occupies a concurrency slot').toBe(0);
  });

  it('lets the operator clear the launch attempt it was dispatched under', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const target = await addPatientTarget(tenant, campaignId, 8);
    stubNeverConnectedProvider(tenant.providerAgentId);

    const token = await registerAttempt(tenant, campaignId);
    const launched = await placeCall(tenant, campaignId, { targetId: target.id, phone: target.phone, clientAttemptToken: token });
    expect(launched.statusCode, launched.body).toBe(201);

    await reconcile(tenant, campaignId, (launched.json() as { callLogId: string }).callLogId);

    // `verify-clear` is the console's own definition of "this attempt is
    // finished": the call is terminal AND its target is no longer CALLING.
    // It is the same wedge, read back through the operator's screen.
    const cleared = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/launch-attempts/${token}/verify-clear`,
      headers: auth(tenant),
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ cleared: true, proof: 'durable_terminal_reconciliation' });
  });
});

// ===========================================================================
// 2. The target must become retryable (ASSUMPTION C).
// ===========================================================================
describe('the target of a call that never connected', () => {
  it('returns to a dialable state and can actually be called again', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { maxRetryAttempts: 2 });
    const target = await addPatientTarget(tenant, campaignId, 3);
    stubNeverConnectedProvider(tenant.providerAgentId);

    const first = await strandOneCall(tenant, campaignId, target.id, target.phone);
    await reconcile(tenant, campaignId, first.callLogId);

    // ASSUMPTION C: one attempt used, two allowed, so the existing
    // `targetStatusAfterOutcome` rule for NO_ANSWER puts this back to PENDING.
    // If the product decides a declined call is terminal instead, this row
    // must read FAILED — but never CALLING.
    const afterFirst = await callTarget(target.id);
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.status).toBe('PENDING');
    expect(isTargetDialable(afterFirst.status, afterFirst.attempts, 2)).toBe(true);

    // And the claim has to survive contact with the dispatcher, not just look
    // right in the database.
    const second = await placeCall(tenant, campaignId, { targetId: target.id, phone: target.phone });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toMatchObject({ status: 'launched' });
    expect((await callTarget(target.id)).attempts).toBe(2);
  });
});

// ===========================================================================
// 3. Reconciliation from the call id alone.
// ===========================================================================
describe('provider-sync reconciliation authority', () => {
  it('reconciles a call WE submitted even though the provider record carries no metadata', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const target = await addPatientTarget(tenant, campaignId, 4);
    stubNeverConnectedProvider(tenant.providerAgentId);

    const launched = await strandOneCall(tenant, campaignId, target.id, target.phone);

    // We hold this call id because the provider handed it to us synchronously
    // on our own create-phone-call, under a durable ReceptionistOutboundProviderIntent.
    // That is the binding. Reading our own metadata back off the provider
    // record is a second, weaker copy of the same fact — and it is the copy a
    // call that never started does not have.
    const intent = await db.receptionistOutboundProviderIntent.findFirst({
      where: { tenantId: tenant.id, callLogId: launched.callLogId },
    });
    expect(intent, 'our own durable submission evidence').not.toBeNull();

    const synced = await reconcile(tenant, campaignId, launched.callLogId);
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json()).toMatchObject({
      status: 'synchronized',
      providerStatus: 'not_connected',
      // ASSUMPTION B: the existing not_connected mapping in outbound.ts.
      outcome: 'NO_ANSWER',
      durationSeconds: 0,
    });
    expect((await callLog(launched.callLogId)).endedAt).not.toBeNull();
  });

  it('still quarantines a provider call this tenant never submitted', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);

    // A provider call id that never came from one of our submissions: no
    // ReceptionistOutboundProviderIntent, no launch, no correlation. Somebody
    // put the id on a local row. It is not ours (ASSUMPTION D).
    const foreignCallId = `call_${randomUUID().replaceAll('-', '')}`;
    const planted = await db.receptionistCallLog.create({
      data: {
        tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: campaignId,
        retellCallId: foreignCallId, callerPhone: phoneFor(tenant.id, 51),
        direction: 'outbound', outcome: 'IN_PROGRESS', startedAt: new Date(),
      },
    });
    // The provider answers about it in the friendliest possible way: our own
    // agent id, our own version, no metadata. A fix that trusts "the id is on
    // one of our rows" would accept this. It must not.
    stubNeverConnectedProvider(tenant.providerAgentId);

    const synced = await reconcile(tenant, campaignId, planted.id);
    expect(synced.statusCode, synced.body).toBe(409);
    expect(synced.json()).toMatchObject({ status: 'quarantined', reason: 'provider_binding_mismatch' });
    expect((await callLog(planted.id)).outcome).toBe('IN_PROGRESS');
    expect(await db.auditEvent.count({
      where: { tenantId: tenant.id, action: 'receptionist.call.providerSyncQuarantined', resourceId: planted.id },
    })).toBe(1);
  });

  it('still quarantines a provider call whose record belongs to another tenant', async () => {
    const tenant = await makeTenant();
    const other = await makeTenant();
    const campaignId = await createCampaign(tenant);

    const strangerCallId = `call_${randomUUID().replaceAll('-', '')}`;
    const planted = await db.receptionistCallLog.create({
      data: {
        tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: campaignId,
        retellCallId: strangerCallId, callerPhone: phoneFor(tenant.id, 52),
        direction: 'outbound', outcome: 'IN_PROGRESS', startedAt: new Date(),
      },
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      if (String(input).includes('/v2/get-call/')) {
        return jsonResponse({
          call_id: strangerCallId, call_status: 'ended', disconnection_reason: 'user_hangup',
          duration_ms: 42_000, agent_id: other.providerAgentId, agent_version: 1,
          metadata: { tenantId: other.id, outboundCampaignId: randomUUID(), callLogId: randomUUID() },
        });
      }
      return new Response(null, { status: 404 });
    }));

    const synced = await reconcile(tenant, campaignId, planted.id);
    expect(synced.statusCode, synced.body).toBe(409);
    expect(synced.json()).toMatchObject({ status: 'quarantined', reason: 'provider_binding_mismatch' });
    expect((await callLog(planted.id)).outcome).toBe('IN_PROGRESS');
    expect((await callLog(planted.id)).durationSeconds).toBe(0);
  });
});

// ===========================================================================
// 4. A stranded call must not block unrelated calls.
//
// The generic tenant ceiling is 25 (`MAX_TENANT_ACTIVE_CALLS`), so one stuck
// row does not shut an ordinary clinic — that half is a GUARD and is green
// today. The attended-test ceiling is ONE, and that is the half that shut the
// pilot line for good.
// ===========================================================================
describe('admission after a call that never connected', () => {
  it('still admits an unrelated patient while one stranded call sits unreconciled', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const stranded = await addPatientTarget(tenant, campaignId, 5);
    const unrelated = await addPatientTarget(tenant, campaignId, 6);
    stubNeverConnectedProvider(tenant.providerAgentId);

    await strandOneCall(tenant, campaignId, stranded.id, stranded.phone);

    const second = await placeCall(tenant, campaignId, { targetId: unrelated.id, phone: unrelated.phone });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toMatchObject({ status: 'launched' });
  });

  it('does not refuse every later attended call with live_test_single_active_call', async () => {
    const tenant = await makeTenant();
    // Two campaigns, one authorized destination. The attended UAT allowlist
    // holds exactly one number, so the second attempt is a genuinely separate
    // call on a separate campaign — not a retry of the stuck target, which
    // `target_not_dialable` refuses for its own (also broken) reason.
    const firstCampaignId = await createCampaign(tenant);
    const secondCampaignId = await createCampaign(tenant);
    const destination = phoneFor(tenant.id, 7);
    const patient = await makePatient(tenant, 7, destination);
    const firstTarget = await addTarget(tenant, firstCampaignId, patient);
    const secondTarget = await addTarget(tenant, secondCampaignId, patient);
    configureLiveUat(tenant, destination);
    stubNeverConnectedProvider(tenant.providerAgentId);

    const firstToken = await registerAttempt(tenant, firstCampaignId);
    const first = await placeCall(tenant, firstCampaignId, { targetId: firstTarget.id, phone: destination, clientAttemptToken: firstToken });
    expect(first.statusCode, first.body).toBe(201);
    const firstBody = first.json() as { callLogId: string };

    // The exact production sequence: the call never connects, nothing signed
    // is delivered, and the operator reaches for the only lever there is.
    await reconcile(tenant, firstCampaignId, firstBody.callLogId);

    // The attended ceiling is ONE active call, counted from call logs that are
    // still IN_PROGRESS. A call the provider never connected holding that slot
    // is what took the line off the air: every later attempt was refused, and
    // the only documented escape is a platform-console kill-switch clear.
    const secondToken = await registerAttempt(tenant, secondCampaignId);
    const second = await placeCall(tenant, secondCampaignId, { targetId: secondTarget.id, phone: destination, clientAttemptToken: secondToken });
    expect((second.json() as { reason?: string }).reason, 'the stranded call still owns the only attended slot').not.toBe('live_test_single_active_call');
    expect(second.statusCode, second.body).toBe(201);
    expect((await callLog(firstBody.callLogId)).outcome).not.toBe('IN_PROGRESS');
  });
});
