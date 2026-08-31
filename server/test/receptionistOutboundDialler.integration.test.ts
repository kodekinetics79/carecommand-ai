import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// The dialler — proof that automation goes through the same fences a person
// does, and stops when it is told to.
//
// The whole risk of this feature is stated in one sentence: a loop that dials
// on its own is only as safe as the gates it cannot skip. So every test here
// is about a gate, and none of them assert on the dialler's own bookkeeping
// where the observable fact is "the provider was never contacted".
//
// `submitted.length` is therefore the primary assertion almost everywhere: it
// counts the calls that would have made a real telephone ring.
// ===========================================================================

const { buildApp } = await import('../app');
const { env } = await import('../config/env');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { requireQueueRedis } = await import('./helpers/requireQueueRedis');
const { fingerprintJson } = await import('../modules/receptionist/intakeContract');
const { isWithinQuietHours } = await import('../modules/receptionist/outbound');
const { runOutboundDialPass, perPassBudget, OUTBOUND_DIAL_ACTOR } = await import('../lib/receptionist/outboundDialer');
const { runInTenantContext } = await import('../lib/tenantContext');
const { createTenantJobEnvelope, tenantJobId } = await import('../lib/jobEnvelope');
const { createReceptionistOutboundDialWorker } = await import('../workers/receptionistOutboundDial.worker');
const { ALL_QUEUES, receptionistOutboundDialQueue } = await import('../workers/queues');

type TenantFixture = Awaited<ReturnType<typeof makeTenant>>;
type Json = Record<string, unknown>;

let app: FastifyInstance;
const tenantIds: string[] = [];
const originalRetell = {
  apiKey: env.RETELL_API_KEY,
  fromNumber: env.RETELL_FROM_NUMBER,
  baseUrl: env.RETELL_BASE_URL,
};
const originalDial = {
  enabled: env.RECEPTIONIST_OUTBOUND_DIAL_ENABLED,
  interval: env.RECEPTIONIST_OUTBOUND_DIAL_INTERVAL_SECONDS,
  perPass: env.RECEPTIONIST_OUTBOUND_DIAL_MAX_PER_PASS,
};

function phoneFor(seed: string, suffix = 0): string {
  const digits = BigInt(`0x${seed.replaceAll('-', '').slice(0, 14)}`) % 9_000_000_000n;
  return `+1${(digits + 1_000_000_000n + BigInt(suffix)).toString().slice(-10)}`;
}

function minutesNowIn(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** A quiet window that is never active right now in `timezone`. */
function quietWindowOutsideNow(timezone: string) {
  const now = minutesNowIn(timezone);
  return { quietHoursStart: hhmm((now + 90) % 1440), quietHoursEnd: hhmm((now + 150) % 1440) };
}

/** A quiet window that IS active right now in `timezone`. */
function quietWindowCoveringNow(timezone: string) {
  const now = minutesNowIn(timezone);
  return { quietHoursStart: hhmm((now + 1380) % 1440), quietHoursEnd: hhmm((now + 60) % 1440) };
}

/**
 * A timezone whose local clock is far enough from this machine's that a window
 * open in one is shut in the other. Picked at runtime because the test must
 * hold wherever CI happens to be.
 */
function timezoneOffsetFromServer(): string {
  const server = minutesNowIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const candidates = [
    'Pacific/Kiritimati', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/Berlin',
    'UTC', 'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu',
  ];
  for (const zone of candidates) {
    const delta = Math.abs(minutesNowIn(zone) - server);
    const circular = Math.min(delta, 1440 - delta);
    if (circular >= 240) return zone;
  }
  throw new Error('no candidate timezone is far enough from the server clock for this test');
}

async function makeTenant(timezone = 'America/New_York') {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Dialler ${id.slice(0, 6)}`, slug: `dialler-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({
    data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' },
  });
  const branch = await db.branch.create({
    data: { tenantId: id, name: 'Main branch', location: 'Main', timezone },
  });
  const owner = await db.user.create({
    data: {
      tenantId: id, role: 'OWNER', active: true, branchId: branch.id,
      email: `owner-${id.slice(0, 8)}@dialler.test`, displayName: 'Owner',
    },
  });
  const clinic = await db.receptionistClinic.create({
    data: { tenantId: id, name: 'Main clinic', phone: phoneFor(id), timezone, country: 'US', defaultLanguage: 'en-US' },
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
  return { id, ownerId: owner.id, branchId: branch.id, clinicId: clinic.id, agentId: agent.id, providerAgentId, timezone };
}

function auth(tenant: TenantFixture) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: tenant.ownerId, tenantId: tenant.id, role: 'OWNER', type: 'access' })}` };
}

interface CampaignOptions {
  quietHours?: { quietHoursStart: string; quietHoursEnd: string };
  maxRetryAttempts?: number;
  dialer?: {
    dialerEnabled?: boolean;
    dialerMaxConcurrentCalls?: number;
    dialerCallsPerMinute?: number;
    dialerRetryGapMinutes?: number;
  };
}

/**
 * A RUNNING, approved campaign. The pacing fields are written straight to the
 * row rather than through the API so a suite that is about the dialler is not
 * also about the deployment's env flags — the API guard has its own test.
 */
async function createCampaign(tenant: TenantFixture, options: CampaignOptions = {}) {
  const quietHours = options.quietHours ?? quietWindowOutsideNow(tenant.timezone);
  const created = await app.inject({
    method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: auth(tenant),
    payload: {
      clinicId: tenant.clinicId, agentId: tenant.agentId,
      name: `Dialler ${randomUUID().slice(0, 8)}`,
      script: 'Call the patient about care coordination.',
      requiredFields: ['firstName', 'lastName', 'phone'],
      bookingMode: 'APPOINTMENT_REQUEST_ONLY',
      purpose: 'CARE_COORDINATION', legalBasis: 'TREATMENT_OPERATIONS', policyVersion: 'OUTBOUND-DIALLER-1',
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
  await db.receptionistOutboundCampaign.update({
    where: { id: campaignId },
    data: {
      dialerEnabled: options.dialer?.dialerEnabled ?? true,
      dialerMaxConcurrentCalls: options.dialer?.dialerMaxConcurrentCalls ?? 5,
      dialerCallsPerMinute: options.dialer?.dialerCallsPerMinute ?? 60,
      dialerRetryGapMinutes: options.dialer?.dialerRetryGapMinutes ?? 0,
    },
  });
  return campaignId;
}

async function addPatientTarget(tenant: TenantFixture, campaignId: string, suffix: number) {
  const patient = await db.patient.create({
    data: {
      tenantId: tenant.id, branchId: tenant.branchId,
      firstName: `Patient${suffix}`, lastName: 'Dialler', phone: phoneFor(tenant.id, suffix), tags: [],
    },
  });
  const added = await app.inject({
    method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`, headers: auth(tenant),
    payload: { targets: [{ patientId: patient.id, phone: patient.phone, firstName: patient.firstName, lastName: patient.lastName }] },
  });
  expect(added.statusCode, added.body).toBe(201);
  return db.receptionistCallTarget.findFirstOrThrow({ where: { tenantId: tenant.id, campaignId, patientId: patient.id } });
}

function jsonResponse(body: Json, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A provider that accepts every call and reports nothing afterwards, which is
 * the state a live call is in for its whole duration. `onSubmit` is the seam
 * the kill-switch test uses to change the world mid-pass.
 */
function stubAcceptingProvider(agentId: string, onSubmit?: (callId: string) => Promise<void>) {
  const submitted: Array<{ callId: string; toNumber: string; metadata: Json }> = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes('/v2/create-phone-call')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { metadata?: Json; to_number?: string };
      const callId = `call_${randomUUID().replaceAll('-', '')}`;
      submitted.push({ callId, toNumber: String(body.to_number ?? ''), metadata: body.metadata ?? {} });
      if (onSubmit) await onSubmit(callId);
      return jsonResponse({ call_id: callId, agent_id: agentId, agent_version: 1 }, 201);
    }
    if (url.includes('/v2/stop-call/')) return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, submitted };
}

/** Run one dialler pass exactly as the worker does. */
async function dialPass(tenant: TenantFixture, options: { runId?: string; jobId?: string } = {}) {
  const runId = options.runId ?? randomUUID();
  const jobId = options.jobId ?? `job-${runId}`;
  return runInTenantContext(
    { tenantId: tenant.id, actorId: OUTBOUND_DIAL_ACTOR, actorRole: 'WORKER', source: 'worker' },
    () => runOutboundDialPass(tenant.id, { runId, jobId }),
  );
}

const targetRow = (id: string) => db.receptionistCallTarget.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  // A real (non-`mock`) key so every provider interaction goes through the
  // stubbed fetch and exercises the real client code path.
  env.RETELL_API_KEY = 'real_dialler_test_key';
  env.RETELL_FROM_NUMBER = '+15550000019';
  env.RETELL_BASE_URL = 'https://retell.dialler.test';
  env.RECEPTIONIST_OUTBOUND_DIAL_INTERVAL_SECONDS = 60;
  env.RECEPTIONIST_OUTBOUND_DIAL_MAX_PER_PASS = 25;
  app = await buildApp();
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  env.RECEPTIONIST_OUTBOUND_DIAL_ENABLED = originalDial.enabled;
});

afterAll(async () => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  env.RECEPTIONIST_OUTBOUND_DIAL_ENABLED = originalDial.enabled;
  env.RECEPTIONIST_OUTBOUND_DIAL_INTERVAL_SECONDS = originalDial.interval;
  env.RECEPTIONIST_OUTBOUND_DIAL_MAX_PER_PASS = originalDial.perPass;
  vi.unstubAllGlobals();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

// ===========================================================================
// 1. The loop itself.
// ===========================================================================
describe('the dialler works through a campaign without anyone clicking Call', () => {
  it('dials every PENDING target in one pass and attributes each call to the worker, not a user', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { dialer: { dialerMaxConcurrentCalls: 3 } });
    const targets = [
      await addPatientTarget(tenant, campaignId, 1),
      await addPatientTarget(tenant, campaignId, 2),
      await addPatientTarget(tenant, campaignId, 3),
    ];
    const provider = stubAcceptingProvider(tenant.providerAgentId);

    const runId = randomUUID();
    const summary = await dialPass(tenant, { runId });

    expect(summary.launched).toBe(3);
    expect(provider.submitted).toHaveLength(3);
    expect(new Set(provider.submitted.map(call => call.toNumber)))
      .toEqual(new Set(targets.map(target => target.phone)));
    for (const target of targets) expect((await targetRow(target.id)).status).toBe('CALLING');

    // Attribution: an automated dial must never look like a person clicking
    // Call, and it must be traceable back to the pass that made it.
    const launches = await db.auditEvent.findMany({
      where: { tenantId: tenant.id, action: 'receptionist.call.launched' },
      select: { actorUserId: true, metadata: true },
    });
    expect(launches).toHaveLength(3);
    for (const row of launches) {
      expect(row.actorUserId, 'a worker dial has no user to attribute it to').toBeNull();
      expect((row.metadata as { dialer?: { runId?: string } }).dialer?.runId).toBe(runId);
    }
  }, 60_000);

  it('leaves a campaign alone until its dialler switch is on', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { dialer: { dialerEnabled: false } });
    await addPatientTarget(tenant, campaignId, 11);
    const provider = stubAcceptingProvider(tenant.providerAgentId);

    const summary = await dialPass(tenant);

    expect(summary.campaignsConsidered).toBe(0);
    expect(provider.submitted).toHaveLength(0);
  }, 60_000);
});

// ===========================================================================
// 2. The kill switch, mid-run.
// ===========================================================================
describe('the tenant kill switch', () => {
  it('stops the pass on the very next target, not at the end of the batch', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { dialer: { dialerMaxConcurrentCalls: 5 } });
    for (const suffix of [21, 22, 23, 24, 25]) await addPatientTarget(tenant, campaignId, suffix);

    // The operator hits stop while the first call is being submitted.
    const provider = stubAcceptingProvider(tenant.providerAgentId, async () => {
      await db.tenantAiUsage.upsert({
        where: { tenantId: tenant.id },
        update: { killSwitch: true },
        create: { tenantId: tenant.id, killSwitch: true },
      });
    });

    const summary = await dialPass(tenant);

    expect(summary.stoppedByKillSwitch).toBe(true);
    expect(provider.submitted, 'the stop must land before the second patient is dialled').toHaveLength(1);
    const pending = await db.receptionistCallTarget.count({
      where: { tenantId: tenant.id, campaignId, status: 'PENDING' },
    });
    expect(pending).toBe(4);
  }, 60_000);

  it('claims nothing and dials nothing at all once the switch is already on', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    await addPatientTarget(tenant, campaignId, 31);
    await db.tenantAiUsage.upsert({
      where: { tenantId: tenant.id },
      update: { killSwitch: true },
      create: { tenantId: tenant.id, killSwitch: true },
    });
    const provider = stubAcceptingProvider(tenant.providerAgentId);

    const summary = await dialPass(tenant);

    expect(summary).toMatchObject({ stoppedByKillSwitch: true, launched: 0, campaignsConsidered: 0 });
    expect(provider.submitted).toHaveLength(0);
    // A stopped tenant should not even be generating audit noise.
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: 'receptionist.call.blocked' } })).toBe(0);
  }, 60_000);
});

// ===========================================================================
// 3. Consent and DNC, re-checked at dial time.
// ===========================================================================
describe('a target whose consent or DNC state changed after it was queued', () => {
  it('is never dialled when the number goes on the do-not-call list after enrolment', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { dialer: { dialerMaxConcurrentCalls: 5 } });
    const suppressed = await addPatientTarget(tenant, campaignId, 41);
    const reachable = await addPatientTarget(tenant, campaignId, 42);

    // Enrolled first, opted out afterwards — the state the enqueue could not
    // have known about.
    const optOut = await app.inject({
      method: 'POST', url: '/v1/receptionist/opt-outs', headers: auth(tenant),
      payload: { contactPhone: suppressed.phone, channel: 'VOICE', reason: 'Patient asked not to be called' },
    });
    expect(optOut.statusCode, optOut.body).toBe(201);

    const provider = stubAcceptingProvider(tenant.providerAgentId);
    await dialPass(tenant);

    expect(provider.submitted.map(call => call.toNumber)).toEqual([reachable.phone]);
    expect((await targetRow(suppressed.id)).status).toBe('OPTED_OUT');
  }, 60_000);

  it('is never dialled when voice consent is revoked after enrolment, and is not re-offered next pass', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { dialer: { dialerMaxConcurrentCalls: 5 } });
    const revoked = await addPatientTarget(tenant, campaignId, 51);
    const reachable = await addPatientTarget(tenant, campaignId, 52);
    await db.communicationConsent.create({
      data: {
        tenantId: tenant.id, patientId: revoked.patientId, channel: 'voice', status: 'opted_out',
        source: 'dialler_regression_test', revokedAt: new Date(),
      },
    });

    const provider = stubAcceptingProvider(tenant.providerAgentId);
    await dialPass(tenant);
    expect(provider.submitted.map(call => call.toNumber)).toEqual([reachable.phone]);

    // The loop must not grind. Shared suppression used to leave the target
    // PENDING with no call log, so every later pass re-offered the same
    // suppressed patient, refused, and wrote another audit row — forever.
    expect((await targetRow(revoked.id)).status).toBe('OPTED_OUT');
    const second = await dialPass(tenant);
    expect(second.targetsConsidered, 'a suppressed target must not be reconsidered').toBe(0);
    expect(provider.submitted).toHaveLength(1);
  }, 60_000);
});

// ===========================================================================
// 4. Quiet hours, in the clinic's timezone.
// ===========================================================================
describe('quiet hours', () => {
  it('honours a window that is closed in the clinic timezone even when the server clock says otherwise', async () => {
    const timezone = timezoneOffsetFromServer();
    const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tenant = await makeTenant(timezone);
    const quietHours = quietWindowCoveringNow(timezone);

    // The premise of the test, asserted rather than assumed: this exact window
    // is quiet in the clinic's timezone and open in the server's. A dialler
    // that used the server clock would dial.
    expect(isWithinQuietHours(quietHours.quietHoursStart, quietHours.quietHoursEnd, timezone)).toBe(true);
    expect(isWithinQuietHours(quietHours.quietHoursStart, quietHours.quietHoursEnd, serverZone)).toBe(false);

    const campaignId = await createCampaign(tenant, { quietHours });
    await addPatientTarget(tenant, campaignId, 61);
    const provider = stubAcceptingProvider(tenant.providerAgentId);

    const summary = await dialPass(tenant);

    expect(summary.campaignsSkippedQuietHours).toBe(1);
    expect(summary.launched).toBe(0);
    expect(provider.submitted).toHaveLength(0);
    // And it skips the campaign whole, rather than offering each patient to
    // the fence and collecting a refusal per target all night.
    expect(summary.targetsConsidered).toBe(0);
  }, 60_000);

  it('dials in the same clinic timezone once the window is open', async () => {
    const timezone = timezoneOffsetFromServer();
    const tenant = await makeTenant(timezone);
    const campaignId = await createCampaign(tenant, { quietHours: quietWindowOutsideNow(timezone) });
    const target = await addPatientTarget(tenant, campaignId, 62);
    const provider = stubAcceptingProvider(tenant.providerAgentId);

    const summary = await dialPass(tenant);

    expect(summary.launched).toBe(1);
    expect(provider.submitted.map(call => call.toNumber)).toEqual([target.phone]);
  }, 60_000);
});

// ===========================================================================
// 5. Pacing: concurrency and rate.
// ===========================================================================
describe('pacing', () => {
  it('never exceeds the campaign concurrency the clinic set, across passes', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { dialer: { dialerMaxConcurrentCalls: 2 } });
    for (const suffix of [71, 72, 73, 74, 75]) await addPatientTarget(tenant, campaignId, suffix);
    const provider = stubAcceptingProvider(tenant.providerAgentId);

    const first = await dialPass(tenant);
    expect(first.launched).toBe(2);
    expect(provider.submitted).toHaveLength(2);

    // Both calls are still up, so the next pass may start none.
    const second = await dialPass(tenant);
    expect(second.launched).toBe(0);
    expect(second.campaignsAtConcurrencyCeiling).toBe(1);
    expect(provider.submitted).toHaveLength(2);

    const inFlight = await db.receptionistCallLog.count({
      where: { tenantId: tenant.id, outboundCampaignId: campaignId, outcome: 'IN_PROGRESS', endedAt: null },
    });
    expect(inFlight).toBe(2);
  }, 60_000);

  it('spends only the per-tick share of the campaign rate', async () => {
    // 6 calls a minute on a 10-second tick is one call per pass.
    expect(perPassBudget(6, 10, 25)).toBe(1);
    // A rate below one per tick still makes progress rather than rounding to
    // zero and stalling the campaign forever.
    expect(perPassBudget(1, 10, 25)).toBe(1);
    // And a misconfigured rate cannot flood the queue in a single tick.
    expect(perPassBudget(60, 3600, 25)).toBe(25);

    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, {
      dialer: { dialerMaxConcurrentCalls: 10, dialerCallsPerMinute: 1 },
    });
    for (const suffix of [81, 82, 83]) await addPatientTarget(tenant, campaignId, suffix);
    const provider = stubAcceptingProvider(tenant.providerAgentId);

    // One call a minute, 60-second tick: exactly one dial this pass.
    const summary = await dialPass(tenant);
    expect(summary.launched).toBe(1);
    expect(provider.submitted).toHaveLength(1);
  }, 60_000);

  it('holds a patient back inside the clinic minimum gap since their last call', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, {
      dialer: { dialerMaxConcurrentCalls: 5, dialerRetryGapMinutes: 60 },
    });
    const target = await addPatientTarget(tenant, campaignId, 91);
    const provider = stubAcceptingProvider(tenant.providerAgentId);

    await dialPass(tenant);
    expect(provider.submitted).toHaveLength(1);

    // The call ends without an answer, so the target becomes dialable again —
    // but not within the hour.
    const call = await db.receptionistCallLog.findFirstOrThrow({
      where: { tenantId: tenant.id, targetId: target.id },
    });
    await db.receptionistCallLog.update({
      where: { id: call.id }, data: { outcome: 'NO_ANSWER', endedAt: new Date() },
    });
    await db.receptionistCallTarget.update({
      where: { id: target.id }, data: { status: 'PENDING', lastOutcome: 'NO_ANSWER', lastCallLogId: call.id },
    });

    const held = await dialPass(tenant);
    expect(held.targetsHeldByRetryGap).toBe(1);
    expect(provider.submitted).toHaveLength(1);

    // Age the previous attempt past the gap and the same patient is offered.
    await db.receptionistCallLog.update({
      where: { id: call.id }, data: { startedAt: new Date(Date.now() - 90 * 60_000) },
    });
    const resumed = await dialPass(tenant);
    expect(resumed.launched).toBe(1);
    expect(provider.submitted).toHaveLength(2);
  }, 60_000);

  it('stops offering a campaign that refuses three patients in a row for the same reason', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { dialer: { dialerMaxConcurrentCalls: 10 } });
    for (const suffix of [111, 112, 113, 114, 115]) await addPatientTarget(tenant, campaignId, suffix);
    // The agent is deactivated after approval. Every patient in this campaign
    // is now refused for a reason that has nothing to do with the patient, so
    // working through all five would write five identical audit rows and dial
    // nobody.
    await db.receptionistAgent.update({ where: { id: tenant.agentId }, data: { active: false } });
    const provider = stubAcceptingProvider(tenant.providerAgentId);

    const summary = await dialPass(tenant);

    expect(summary.launched).toBe(0);
    expect(summary.blocked, 'a campaign-scoped refusal must not be re-asked for every patient').toBe(3);
    expect(provider.submitted).toHaveLength(0);
  }, 60_000);
});

// ===========================================================================
// 6. Honesty about a deployment that cannot dial.
// ===========================================================================
describe('a deployment with no dispatcher', () => {
  it('refuses to switch the dialler on rather than accepting it and never dialling', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { dialer: { dialerEnabled: false } });
    env.RECEPTIONIST_OUTBOUND_DIAL_ENABLED = false;

    const refused = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/outbound-campaigns/${campaignId}`, headers: auth(tenant),
      payload: { dialerEnabled: true },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ status: 'setup_required', reason: 'dispatcher_not_running' });
    expect((await db.receptionistOutboundCampaign.findUniqueOrThrow({ where: { id: campaignId } })).dialerEnabled).toBe(false);

    // With a dispatcher, the same request is accepted — and the pacing knobs
    // are not campaign authority, so a RUNNING campaign stays approved.
    env.RECEPTIONIST_OUTBOUND_DIAL_ENABLED = true;
    const accepted = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/outbound-campaigns/${campaignId}`, headers: auth(tenant),
      payload: { dialerEnabled: true, dialerCallsPerMinute: 4, dialerMaxConcurrentCalls: 2 },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const row = await db.receptionistOutboundCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(row).toMatchObject({ dialerEnabled: true, dialerCallsPerMinute: 4, dialerMaxConcurrentCalls: 2, status: 'RUNNING' });
    expect(row.authorityApprovedAt, 'changing the pace must not void the approval').not.toBeNull();
  }, 60_000);
});

// ===========================================================================
// 7. At-least-once delivery.
// ===========================================================================
describe('the queued job', () => {
  beforeAll(requireQueueRedis);

  it('is registered in the queue registry so teardown and depth sampling see it', () => {
    expect(ALL_QUEUES).toContain(receptionistOutboundDialQueue);
  });

  it('dials a patient exactly once when the same job is delivered twice', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { dialer: { dialerMaxConcurrentCalls: 5 } });
    const target = await addPatientTarget(tenant, campaignId, 101);
    const provider = stubAcceptingProvider(tenant.providerAgentId);
    const worker = createReceptionistOutboundDialWorker();

    try {
      const envelope = createTenantJobEnvelope({ queue: 'receptionist-outbound-dial', operation: 'dial', tenantId: tenant.id });
      const jobId = tenantJobId(envelope);
      await receptionistOutboundDialQueue.add('dial-tenant', envelope, { jobId });
      await waitForJobState(jobId, 'completed');
      expect(provider.submitted).toHaveLength(1);

      // Redelivery of the identical job — BullMQ's at-least-once guarantee in
      // practice. The launch path's target claim is atomic, so the second
      // delivery finds the target CALLING and cannot dial it again.
      const job = await receptionistOutboundDialQueue.getJob(jobId);
      const firstProcessedOn = job!.processedOn;
      await job!.retry('completed');
      const redelivered = await waitForJobState(jobId, 'completed');
      // Guards against a vacuous pass: the assertion below is only worth
      // anything if the job actually ran a second time.
      expect(redelivered.processedOn).not.toBe(firstProcessedOn);

      expect(provider.submitted, 'a redelivered pass must not phone the patient twice').toHaveLength(1);
      expect(await db.receptionistCallLog.count({ where: { tenantId: tenant.id, targetId: target.id } })).toBe(1);
    } finally {
      await worker.close();
      await receptionistOutboundDialQueue.obliterate({ force: true }).catch(() => undefined);
    }
  }, 60_000);
});

async function waitForJobState(jobId: string, expected: 'completed' | 'failed') {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const job = await receptionistOutboundDialQueue.getJob(jobId);
    if (job && await job.getState() === expected) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for outbound dial job ${jobId} to become ${expected}`);
}
