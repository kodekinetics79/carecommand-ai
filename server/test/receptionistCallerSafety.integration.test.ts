import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { signRetell } from './helpers/retellSignature';

// ===========================================================================
// Caller safety, end to end.
//
// Six changes came out of market research, a regulatory read and a real 2026
// incident review, and every one of them is a promise to a specific person:
//
//   · the AI disclosure is spoken at the END of a call as well as the start,
//     because California AB 3030 requires it and our packs had no closing key;
//   · an emergency is handled ON the call — a transfer or an immediate callback
//     — instead of appearing on a board nobody may be watching;
//   · the receptionist stops after two turns it cannot parse, because a stroke
//     survivor tried five times and gave up;
//   · a caller marked Human only never meets the AI line at all;
//   · a number that reaches this line three times in a morning gets a person.
//
// The first two are activation gates: a clinic that cannot keep these promises
// does not get to answer patient calls. Those are the tests that matter most
// here, because they are the ones with teeth.
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
const { approveLocalePack, clinicFixtureData, ACTIVATION_READY_HOURS } = await import('./helpers/receptionistFixtures');
const { PLATFORM_LOCALE_PACKS } = await import('../lib/receptionist/localePacks/defaults');
const { localePackEvidenceHash } = await import('../lib/receptionist/localePacks/render');
const { evaluateCampaignReadiness } = await import('../lib/receptionist/campaignReadiness');
const { runWithTenantContext } = await import('../lib/tenantContext');
const { runWithWebhookTenantContext } = await import('../lib/tenantContext');
const { handleAgentTool } = await import('../lib/receptionist/liveTools');
const { MAX_UNPARSEABLE_TURNS } = await import('../lib/receptionist/comprehension');
const { REPEAT_CALLER_THRESHOLD, REPEAT_CALLER_WINDOW_HOURS } = await import('../lib/receptionist/admissionPolicy');
const { findProhibitedCallerInstructions } = await import('../lib/receptionist/prohibitedPhrases');

const RETELL_KEY = 'test-caller-safety-key';
const originalRetellKey = env.RETELL_API_KEY;
const tenantIds: string[] = [];
let app: FastifyInstance;

const phone = () => `+1${(BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

type TenantFixture = { id: string; userId: string; branchId: string };

async function tenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Safety ${id.slice(0, 8)}`, slug: `safety-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const user = await db.user.create({
    data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@safety.test`, displayName: 'Owner' },
    select: { id: true },
  });
  const branch = await db.branch.create({
    data: { tenantId: id, name: 'Main branch', location: '1 Main Street', timezone: 'America/New_York', active: true },
    select: { id: true },
  });
  return { id, userId: user.id, branchId: branch.id };
}

function auth(t: TenantFixture) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: t.userId, tenantId: t.id, role: 'OWNER', type: 'access' })}` };
}

interface ScenarioOptions {
  /** Omit the human fallback the emergency path needs. */
  humanFallbackNumber?: string | null;
  /**
   * Approve a pack the way every tenant approved one BEFORE the closing
   * disclosure existed: with the key simply absent.
   */
  packWithoutClosingDisclosure?: boolean;
}

/**
 * A clinic and campaign that pass every readiness check the caller-safety rows
 * do not own, so a failure below is attributable to exactly one thing.
 */
async function scenario(t: TenantFixture, options: ScenarioOptions = {}) {
  const { humanFallbackNumber = phone(), packWithoutClosingDisclosure = false } = options;
  const clinic = await db.receptionistClinic.create({
    data: clinicFixtureData({
      tenantId: t.id, name: `Clinic ${randomUUID().slice(0, 8)}`, phone: phone(),
      humanFallbackNumber: humanFallbackNumber ?? undefined,
      timezone: 'America/New_York', active: true, workingHours: ACTIVATION_READY_HOURS,
    }) as never,
  });
  await db.receptionistLocation.create({
    data: {
      tenantId: t.id, clinicId: clinic.id, branchId: t.branchId,
      name: 'Safety location', address: '1 Safety Way', active: true,
    },
  });
  const agent = await db.receptionistAgent.create({
    data: { tenantId: t.id, clinicId: clinic.id, name: 'Avery', voice: 'mock-voice-nova', language: 'en-US', active: true },
  });
  const campaign = await db.receptionistCampaign.create({
    data: {
      tenantId: t.id, clinicId: clinic.id, agentId: agent.id,
      name: 'Front desk', campaignType: 'Inbound reception', status: 'DRAFT',
      offerTitle: 'Book a consultation', offerDescription: 'We are welcoming new patients this month.',
      offerScript: 'I can check what we have available and book you in now.',
      appointmentType: 'New patient consultation', eligibleLocationIds: [],
      smsConfirmation: false, emailConfirmation: false,
    },
  });
  if (packWithoutClosingDisclosure) await approveLegacyPack(t);
  else await approveLocalePack({ tenantId: t.id, language: 'en-US', country: 'US', approvedByUserId: t.userId });
  return { clinic, agent, campaign };
}

/**
 * The pack every existing tenant already has: approved, valid at the time, and
 * with no `disclosure.closing` in it — because the key did not exist when they
 * approved it. `resolve.ts` backfills the key from the platform default so the
 * agent still SAYS something, and that is precisely the state the readiness
 * check has to refuse: the clinic's evidence hash does not cover those words.
 */
async function approveLegacyPack(t: TenantFixture) {
  const platform = PLATFORM_LOCALE_PACKS.find(pack => pack.language === 'en-US' && pack.country === 'US')!;
  const messages = { ...platform.strings.messages };
  delete messages['disclosure.closing'];
  const strings = { ...platform.strings, messages };
  await db.receptionistLocalePack.create({
    data: {
      tenantId: t.id, language: 'en-US', country: 'US', version: 1, status: 'APPROVED', source: 'platform_default',
      baseDefaultVersion: platform.version, strings: strings as never,
      evidenceHash: localePackEvidenceHash(strings as never),
      approvedByUserId: t.userId, approvedAt: new Date(),
    },
  });
}

async function checks(t: TenantFixture, campaignId: string) {
  const result = await runWithTenantContext(t.id, tx => evaluateCampaignReadiness(tx, { tenantId: t.id, campaignId }), { id: t.userId, role: 'OWNER' });
  expect(result, 'readiness could not be evaluated').not.toBeNull();
  return result!;
}

function row(result: Awaited<ReturnType<typeof checks>>, key: string) {
  const found = result.checks.find(check => check.key === key);
  expect(found, `readiness row ${key}`).toBeDefined();
  return found!;
}

async function activate(t: TenantFixture, campaignId: string) {
  return app.inject({
    method: 'PATCH', url: `/v1/receptionist/campaigns/${campaignId}`, headers: auth(t), payload: { status: 'ACTIVE' },
  });
}

// --- Live-call helpers ------------------------------------------------------

type ToolContext = Parameters<typeof handleAgentTool>[0];

function tool(ctx: ToolContext, name: string, args: Record<string, unknown> = {}) {
  return runWithWebhookTenantContext(ctx.tenantId, () => handleAgentTool(ctx, name, args), 'webhook:test-caller-safety') as Promise<Record<string, unknown>>;
}

/** An in-progress inbound call on a clinic with an approved en-US pack. */
async function liveCall(t: TenantFixture, clinicId: string, callerPhone: string) {
  const callId = `call-${randomUUID()}`;
  const pack = await db.receptionistLocalePack.findFirstOrThrow({ where: { tenantId: t.id, status: 'APPROVED' }, select: { id: true } });
  const call = await db.receptionistCallLog.create({
    data: {
      tenantId: t.id, clinicId, retellCallId: callId, direction: 'inbound',
      callerPhone, localePackId: pack.id, startedAt: new Date(),
    },
    select: { id: true },
  });
  return { callId, callLogId: call.id, ctx: { tenantId: t.id, callId, callerPhone } as ToolContext };
}

function signedInject(url: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  return app.inject({
    method: 'POST', url,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, RETELL_KEY) },
    payload: raw,
  });
}

type InboundBody = {
  call_inbound: {
    dynamic_variables: Record<string, string>;
    metadata?: { patient_known?: boolean; human_only?: boolean; repeat_caller?: boolean; admission_state?: string; admission_message?: string };
  };
};

function callInbound(toNumber: string, fromNumber: string) {
  return signedInject('/v1/receptionist/webhooks/retell', {
    event: 'call_inbound',
    call_inbound: { agent_id: 'agent_whatever', from_number: fromNumber, to_number: toNumber },
  });
}

beforeAll(async () => {
  env.RETELL_API_KEY = RETELL_KEY;
  app = await buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  env.RETELL_API_KEY = originalRetellKey;
  await app?.close();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

// ===========================================================================
// 1. The closing disclosure is a blocking gate, not a nice-to-have.
// ===========================================================================

describe('AB 3030 — a pack that never says goodbye as an AI cannot go live', () => {
  it('refuses activation when the approved pack does not itself carry the closing disclosure', async () => {
    const t = await tenant();
    const { campaign } = await scenario(t, { packWithoutClosingDisclosure: true });

    const readiness = await checks(t, campaign.id);
    const closing = row(readiness, 'closing_disclosure_present');
    expect(closing.status).toBe('fail');
    // Blocking, so `ready`, the badge and the button cannot disagree with it.
    expect(closing.blocking).toBe(true);
    expect(readiness.ready).toBe(false);
    expect(readiness.actions.activate.allowed).toBe(false);
    // The row says what to do, in the practice manager's words, and never
    // mentions a supplier.
    expect(closing.title).toMatch(/never tells the caller they spoke to an AI at the end/i);
    expect(closing.detail).toMatch(/evidence hash does not cover/i);
    expect(closing.fixHref).toBeTruthy();

    // And the gate actually holds: activation is refused, not merely warned about.
    const activation = await activate(t, campaign.id);
    expect(activation.statusCode).toBe(409);
    expect(await db.receptionistCampaign.findUniqueOrThrow({ where: { id: campaign.id }, select: { status: true } }))
      .toMatchObject({ status: 'DRAFT' });
  });

  it('passes once the clinic approves a pack that includes it, and quotes the words back', async () => {
    const t = await tenant();
    const { campaign } = await scenario(t);
    const closing = row(await checks(t, campaign.id), 'closing_disclosure_present');
    expect(closing.status).toBe('pass');
    expect(closing.detail).toMatch(/Every call ends with/);
    expect(closing.detail).toMatch(/AI assistant/);
  });
});

// ===========================================================================
// 2. The emergency path must not be a screen.
// ===========================================================================

describe('an emergency reaches a person during the call, not a board', () => {
  it('refuses activation when there is nowhere to put an emergency caller through to', async () => {
    const t = await tenant();
    const { campaign } = await scenario(t, { humanFallbackNumber: null });

    const readiness = await checks(t, campaign.id);
    const emergency = row(readiness, 'emergency_path_reachable');
    expect(emergency.status).toBe('fail');
    expect(emergency.blocking).toBe(true);
    expect(readiness.ready).toBe(false);
    // This used to be a WARNING on `transfer_target_distinct`, which is how a
    // clinic could go live with its emergency path pointing at a poll nobody
    // was watching. The detail says exactly that.
    expect(emergency.detail).toMatch(/20-second poll/);
    expect(row(readiness, 'transfer_target_distinct').status).toBe('warn');

    const activation = await activate(t, campaign.id);
    expect(activation.statusCode).toBe(409);
  });

  it('places the transfer on the call, and files the board card as the record of it', async () => {
    const t = await tenant();
    const { clinic } = await scenario(t);
    const { ctx, callLogId } = await liveCall(t, clinic.id, '+12125550143');

    const result = await tool(ctx, 'report_emergency', { reason_category: 'possible_emergency', message: 'Chest pain' });

    // The caller hears the emergency instruction FIRST, then what we are doing.
    expect(String(result.message)).toMatch(/call 911 now/i);
    expect(String(result.message)).toMatch(/connecting you to someone at the practice/i);
    // And the agent is told to do it, on this call, rather than to stop here.
    expect(result.next_action).toBe('transfer_now');
    expect(result.transfer_available).toBe(true);
    expect(result.alerting_channel).toBe('live_transfer');

    // The task still exists — as evidence of what happened, not as the alert.
    const task = await db.staffTask.findFirstOrThrow({ where: { tenantId: t.id, callLogId } });
    expect(task.metadata).toMatchObject({ kind: 'emergency' });
    expect(result.task_id).toBe(task.id);
  });

  it('offers an immediate callback when no transfer target exists, and says so', async () => {
    const t = await tenant();
    const { clinic } = await scenario(t, { humanFallbackNumber: null });
    const { ctx } = await liveCall(t, clinic.id, '+12125550144');

    const result = await tool(ctx, 'report_emergency', { reason_category: 'possible_emergency' });
    expect(result.next_action).toBe('offer_callback');
    expect(result.transfer_available).toBe(false);
    expect(result.alerting_channel).toBe('immediate_callback');
    expect(String(result.message)).toMatch(/call 911 now/i);
    expect(String(result.message)).toMatch(/call you straight back/i);
    // It never tells an emergency caller to wait for staff to notice something.
    expect(String(result.message)).not.toMatch(/wait for (the )?(staff|team)/i);
  });
});

// ===========================================================================
// 3. Two unparseable turns, and it stops. There is no third attempt.
// ===========================================================================

describe('the comprehension bail-out', () => {
  it('retries once, hands over on the second, and never attempts a third', async () => {
    const t = await tenant();
    const { clinic } = await scenario(t);
    const { ctx, callLogId } = await liveCall(t, clinic.id, '+12125550145');

    const first = await tool(ctx, 'report_comprehension_failure', { reason: 'speech_not_recognised' });
    expect(first.bail_out).toBe(false);
    expect(first.attempts_remaining).toBe(1);
    expect(first.next_action).toBe('ask_once_more');
    expect(String(first.message)).toMatch(/didn't catch that/i);

    const second = await tool(ctx, 'report_comprehension_failure', { reason: 'speech_not_recognised' });
    expect(second.bail_out).toBe(true);
    expect(second.attempts_remaining).toBe(0);
    expect(second.next_action).toBe('transfer_now');
    expect(String(second.message)).toMatch(/this is me, not you/i);
    expect(second.task_id).toBeTruthy();

    // The third call is the whole point. A model that decides to try once more
    // is told no, by the server, with no retry branch left to take.
    const third = await tool(ctx, 'report_comprehension_failure', { reason: 'speech_not_recognised' });
    expect(third.bail_out).toBe(true);
    expect(third.attempts_remaining).toBe(0);
    expect(third.next_action).not.toBe('ask_once_more');

    for (const result of [first, second, third]) {
      // Not one of the three sentences may instruct the caller to change how
      // they speak, what they are calling from, or where they are. This is the
      // exact turn where the Rotherham deployment failed a stroke survivor.
      expect(findProhibitedCallerInstructions(String(result.message))).toEqual([]);
    }

    const call = await db.receptionistCallLog.findUniqueOrThrow({
      where: { id: callLogId },
      select: { unparseableTurns: true, comprehensionBailoutAt: true },
    });
    expect(call.unparseableTurns).toBe(3);
    // Stamped on the turn it gave up, and not moved by the attempts after it.
    expect(call.comprehensionBailoutAt).not.toBeNull();

    // Durable work for a person, filed with its own reason so the front desk
    // knows this caller did NOT ask for a human — we failed them.
    const task = await db.staffTask.findFirstOrThrow({ where: { tenantId: t.id, callLogId } });
    expect(task.metadata).toMatchObject({ kind: 'human_handoff', reasonCategory: 'comprehension_failure' });

    // And it is visible as a signal, on the existing path, not a new channel.
    const signal = await db.operationalSignal.findFirstOrThrow({
      where: { tenantId: t.id, signalType: 'receptionist_comprehension_bailout' },
    });
    expect(signal.severity).toBe('high');
    expect(signal.reason).toMatch(/could not understand/i);
  });

  it('clears the count on a turn it DID understand, so two means two in a row', async () => {
    // Without this a caller who is understood, misheard once, understood again
    // and misheard once more twenty turns later would be handed over for two
    // unrelated stumbles — a worse service, and the fastest way to teach a
    // practice to distrust the bail-out.
    const t = await tenant();
    const { clinic } = await scenario(t);
    const { ctx, callLogId } = await liveCall(t, clinic.id, '+12125550147');

    expect((await tool(ctx, 'report_comprehension_failure', { reason: 'audio_unclear' })).bail_out).toBe(false);
    // The agent reaches for a tool, which it only does because it understood.
    await tool(ctx, 'take_message', { reason_category: 'other', message: 'Please call me back about my filling.' });
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId }, select: { unparseableTurns: true } }))
      .toMatchObject({ unparseableTurns: 0 });

    // So the next single failure is the FIRST again, not the second.
    const next = await tool(ctx, 'report_comprehension_failure', { reason: 'audio_unclear' });
    expect(next.bail_out).toBe(false);
    expect(next.attempts_remaining).toBe(1);
  });

  it('bails out immediately when it cannot even count the turns', async () => {
    // No call row means no counter, and a comprehension failure we cannot count
    // is not one to keep guessing on. The safe direction is toward a person.
    const t = await tenant();
    await scenario(t);
    const result = await tool({ tenantId: t.id, callId: null, callerPhone: '+12125550146' } as ToolContext, 'report_comprehension_failure', { reason: 'audio_unclear' });
    expect(result.bail_out).toBe(true);
    expect(result.unparseable_turns).toBe(MAX_UNPARSEABLE_TURNS);
  });
});

// ===========================================================================
// 5. Human only — no AI turn, at all.
// ===========================================================================

describe('a caller marked Human only never meets the AI line', () => {
  async function humanOnlyPatient(t: TenantFixture, callerPhone: string, humanOnly: boolean) {
    return db.patient.create({
      data: {
        tenantId: t.id, branchId: t.branchId, firstName: 'Margaret', lastName: 'Hale', phone: callerPhone,
        ...(humanOnly ? { humanOnly: true, humanOnlyReason: 'Stroke; cannot use an automated line.', humanOnlySetAt: new Date() } : {}),
      },
      select: { id: true },
    });
  }

  it('routes straight to a person at call_inbound, before a single turn is spoken', async () => {
    const t = await tenant();
    const { clinic } = await scenario(t);
    const callerPhone = '+12125550151';
    await humanOnlyPatient(t, callerPhone, true);

    const response = await callInbound(
      (await db.receptionistClinic.findUniqueOrThrow({ where: { id: clinic.id }, select: { phone: true } })).phone,
      callerPhone,
    );
    expect(response.statusCode).toBe(200);
    const body = (response.json() as InboundBody).call_inbound;
    expect(body.metadata?.human_only).toBe(true);
    expect(body.dynamic_variables.admission_state).toBe('human_only');
    expect(body.metadata?.admission_state).toBe('human_only');
    // A routing line the agent speaks instead of the opening turn. It never
    // reads the patient their own flag back to them.
    expect(body.metadata?.admission_message).toMatch(/straight through to someone/i);
    expect(body.metadata?.admission_message).not.toMatch(/human only|flag|record/i);
  });

  it('refuses every patient-data tool on that call, whatever the model tries', async () => {
    // The prompt rule is a request; this is the guarantee. If the routing state
    // never arrived, or the model ignored it, the receptionist still cannot DO
    // anything on this call.
    const t = await tenant();
    const { clinic } = await scenario(t);
    const callerPhone = '+12125550152';
    await humanOnlyPatient(t, callerPhone, true);
    const { ctx } = await liveCall(t, clinic.id, callerPhone);

    for (const name of ['check_availability', 'book_appointment', 'verify_patient_identity', 'list_upcoming_appointments']) {
      const result = await tool(ctx, name, { appointment_date: '2026-09-03', service: 'New patient consultation' });
      expect(result.routed_to_human, `${name} was not refused`).toBe(true);
      expect(result.human_only, name).toBe(true);
      expect(result.tool_refused, name).toBe(name);
      expect(result.next_action, name).toBe('transfer_now');
      // No AI work happened: nothing was offered, nothing was booked, nothing
      // about a patient record was confirmed or denied.
      expect(result.slots, name).toBeUndefined();
      expect(result.booked, name).toBeUndefined();
      expect(result.verified, name).toBeUndefined();
    }
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
    // One thing for a person to pick up, not one per tool the model tried.
    expect(await db.staffTask.count({ where: { tenantId: t.id } })).toBe(1);

    // Getting them to a person still works, and so does an emergency — which
    // outranks every flag in the product.
    const emergency = await tool(ctx, 'report_emergency', { reason_category: 'possible_emergency' });
    expect(emergency.emergency_recorded).toBe(true);
  });

  it('leaves an unflagged caller on the same number completely alone', async () => {
    const t = await tenant();
    const { clinic } = await scenario(t);
    const callerPhone = '+12125550153';
    await humanOnlyPatient(t, callerPhone, false);
    const clinicPhone = (await db.receptionistClinic.findUniqueOrThrow({ where: { id: clinic.id }, select: { phone: true } })).phone;

    const body = ((await callInbound(clinicPhone, callerPhone)).json() as InboundBody).call_inbound;
    expect(body.metadata?.human_only).toBe(false);
    expect(body.dynamic_variables.admission_state).toBe('admitted');
    // And the returning-caller greeting still works, because the two facts are
    // read on one query and neither one broke the other.
    expect(body.metadata?.patient_known).toBe(true);
    expect(body.dynamic_variables.known_first_name).toBe('Margaret');
  });

  it('marks a caller Human only in one tap from the call they failed on', async () => {
    const t = await tenant();
    const { clinic } = await scenario(t);
    const callerPhone = '+12125550154';
    const patient = await humanOnlyPatient(t, callerPhone, false);
    const { callLogId } = await liveCall(t, clinic.id, callerPhone);
    await db.receptionistCallLog.update({ where: { id: callLogId }, data: { patientId: patient.id } });

    const response = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callLogId}/human-only`, headers: auth(t),
      payload: { humanOnly: true, reason: 'Could not get through on three calls; hand these to a person.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ patientId: patient.id, humanOnly: true });

    const stored = await db.patient.findUniqueOrThrow({ where: { id: patient.id } });
    expect(stored.humanOnly).toBe(true);
    // It is a decision with an author and a date, or it is not a clinical
    // decision at all.
    expect(stored.humanOnlySetByUserId).toBe(t.userId);
    expect(stored.humanOnlySetAt).not.toBeNull();
    expect(stored.humanOnlyReason).toMatch(/hand these to a person/);

    // And it travels with the caller to where staff read them.
    const list = await app.inject({ method: 'GET', url: '/v1/receptionist/call-logs', headers: auth(t) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { data: Array<{ id: string; humanOnly: boolean }> }).data.find(callRow => callRow.id === callLogId))
      .toMatchObject({ humanOnly: true });

    // The staff-authored reason never lands in an audit payload.
    const audits = await db.auditEvent.findMany({ where: { tenantId: t.id, action: 'receptionistPatient.humanOnly.set' } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].metadata)).not.toContain('hand these to a person');
  });
});

// ===========================================================================
// 6. Repeat caller — three tries in a morning is the AI failing somebody.
// ===========================================================================

describe('repeat-caller detection', () => {
  it('routes the third call in the window to a person and records why', async () => {
    const t = await tenant();
    const { clinic } = await scenario(t);
    const clinicPhone = (await db.receptionistClinic.findUniqueOrThrow({ where: { id: clinic.id }, select: { phone: true } })).phone;
    const callerPhone = '+12125550161';

    // Two earlier calls, inside the window, that got the caller nowhere.
    for (let index = 0; index < REPEAT_CALLER_THRESHOLD - 1; index += 1) {
      await db.receptionistCallLog.create({
        data: {
          tenantId: t.id, clinicId: clinic.id, retellCallId: `prior-${randomUUID()}`, direction: 'inbound',
          callerPhone, startedAt: new Date(), outcome: 'ESCALATED',
        },
      });
    }

    const body = ((await callInbound(clinicPhone, callerPhone)).json() as InboundBody).call_inbound;
    expect(body.metadata?.repeat_caller).toBe(true);
    expect(body.dynamic_variables.admission_state).toBe('repeat_caller');
    expect(body.metadata?.admission_message).toMatch(/rather than have you go through this again/i);

    // Recorded on the business-event / signal path that already exists, rather
    // than through a channel invented for it.
    const event = await db.businessEvent.findFirstOrThrow({
      where: { tenantId: t.id, eventType: 'receptionist.call.repeat_caller' },
    });
    expect(event.payload).toMatchObject({ callsInWindow: REPEAT_CALLER_THRESHOLD, windowHours: REPEAT_CALLER_WINDOW_HOURS });
    const signal = await db.operationalSignal.findFirstOrThrow({
      where: { tenantId: t.id, signalType: 'receptionist_repeat_caller' },
    });
    expect(signal.severity).toBe('high');
    expect(signal.reason).toMatch(new RegExp(`${REPEAT_CALLER_THRESHOLD} times`));
  });

  it('leaves the second call of the morning alone', async () => {
    const t = await tenant();
    const { clinic } = await scenario(t);
    const clinicPhone = (await db.receptionistClinic.findUniqueOrThrow({ where: { id: clinic.id }, select: { phone: true } })).phone;
    const callerPhone = '+12125550162';
    await db.receptionistCallLog.create({
      data: {
        tenantId: t.id, clinicId: clinic.id, retellCallId: `prior-${randomUUID()}`, direction: 'inbound',
        callerPhone, startedAt: new Date(),
      },
    });

    const body = ((await callInbound(clinicPhone, callerPhone)).json() as InboundBody).call_inbound;
    expect(body.metadata?.repeat_caller).toBe(false);
    expect(body.dynamic_variables.admission_state).toBe('admitted');
  });

  it('does not punish a caller whose earlier calls actually booked something', async () => {
    // A family booking three appointments on one number in a morning is the
    // product working. Routing them to the front desk every time would spend a
    // receptionist's afternoon punishing a good outcome.
    const t = await tenant();
    const { clinic } = await scenario(t);
    const clinicPhone = (await db.receptionistClinic.findUniqueOrThrow({ where: { id: clinic.id }, select: { phone: true } })).phone;
    const callerPhone = '+12125550164';
    for (let index = 0; index < REPEAT_CALLER_THRESHOLD - 1; index += 1) {
      await db.receptionistCallLog.create({
        data: {
          tenantId: t.id, clinicId: clinic.id, retellCallId: `booked-${randomUUID()}`, direction: 'inbound',
          callerPhone, startedAt: new Date(), outcome: 'BOOKED',
        },
      });
    }

    const body = ((await callInbound(clinicPhone, callerPhone)).json() as InboundBody).call_inbound;
    expect(body.metadata?.repeat_caller).toBe(false);
    expect(body.dynamic_variables.admission_state).toBe('admitted');
  });

  it('does not count a call from outside the window', async () => {
    const t = await tenant();
    const { clinic } = await scenario(t);
    const clinicPhone = (await db.receptionistClinic.findUniqueOrThrow({ where: { id: clinic.id }, select: { phone: true } })).phone;
    const callerPhone = '+12125550163';
    const stale = new Date(Date.now() - (REPEAT_CALLER_WINDOW_HOURS + 2) * 3_600_000);
    for (let index = 0; index < REPEAT_CALLER_THRESHOLD - 1; index += 1) {
      await db.receptionistCallLog.create({
        data: {
          tenantId: t.id, clinicId: clinic.id, retellCallId: `stale-${randomUUID()}`, direction: 'inbound',
          callerPhone, startedAt: stale, createdAt: stale,
        },
      });
    }

    const body = ((await callInbound(clinicPhone, callerPhone)).json() as InboundBody).call_inbound;
    expect(body.metadata?.repeat_caller).toBe(false);
    expect(body.dynamic_variables.admission_state).toBe('admitted');
  });
});
