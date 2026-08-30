import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

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
const { runWithTenantContext } = await import('../lib/tenantContext');
const {
  evaluateCampaignReadiness, activationBlockers, recheckActiveCampaigns,
  findActiveCampaignRegressions, NON_BLOCKING_READINESS_KEYS,
} = await import('../lib/receptionist/campaignReadiness');

// ===========================================================================
// Package B — "the checklist tells the truth".
//
// Every check in here used to pass on a value CareCommand itself wrote and
// never re-read. A campaign bound to another clinic's line, unable to offer a
// time, unable to book its own service and never reached by a caller showed
// 14/14 green. Each test below is the red-then-green proof for one of those.
//
// This suite deliberately builds its own catalogue, provider and call-log rows
// rather than using `readyCampaignFixture`: the point of B2 and B4 is exactly
// which columns are read, so the fixture flags have to be set here, in the open,
// one assertion at a time.
// ===========================================================================

type Role = 'OWNER';
type TenantFixture = { id: string; userId: string; branchId: string };
const tenantIds: string[] = [];
let app: FastifyInstance;
const originalRetell = { apiKey: env.RETELL_API_KEY, baseUrl: env.RETELL_BASE_URL, fromNumber: env.RETELL_FROM_NUMBER };

const phone = () => `+1${(BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

async function tenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Readiness ${id.slice(0, 8)}`, slug: `readiness-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const user = await db.user.create({
    data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@readiness.test`, displayName: 'Owner' },
    select: { id: true },
  });
  const branch = await db.branch.create({
    data: { tenantId: id, name: 'Main branch', location: '1 Main Street', timezone: 'America/New_York', active: true },
    select: { id: true },
  });
  return { id, userId: user.id, branchId: branch.id };
}

function auth(t: TenantFixture, role: Role = 'OWNER') {
  return { authorization: `Bearer ${app.jwt.sign({ userId: t.userId, tenantId: t.id, role, type: 'access' })}` };
}

/** RLS scope for the pure functions the worker will call, with a named actor. */
function asTenant<T>(t: TenantFixture, fn: Parameters<typeof runWithTenantContext<T>>[1]): Promise<T> {
  return runWithTenantContext(t.id, fn, { id: t.userId, role: 'OWNER' });
}

const APPOINTMENT_TYPE = 'New patient consultation';

interface SetupOptions {
  /** B2: the column the voice tool reads before it agrees to book anything. */
  bookableByVoice?: boolean;
  /** B3: how many active clinicians sit at the mapped branch. */
  providerCount?: number;
  workingHours?: unknown;
  country?: string | null;
  approvePack?: boolean;
}

/** A clinic, agent and campaign that everything except the named option accepts. */
async function scenario(t: TenantFixture, options: SetupOptions = {}) {
  const {
    bookableByVoice = true, providerCount = 1, workingHours = ACTIVATION_READY_HOURS,
    country = 'US', approvePack = true,
  } = options;

  const clinic = await db.receptionistClinic.create({
    data: clinicFixtureData({
      tenantId: t.id, name: `Clinic ${randomUUID().slice(0, 8)}`, phone: phone(),
      humanFallbackNumber: phone(), timezone: 'America/New_York', active: true,
      country: country ?? undefined, workingHours: workingHours ?? undefined,
    }) as never,
  });
  await db.receptionistLocation.create({
    data: {
      tenantId: t.id, clinicId: clinic.id, branchId: t.branchId,
      name: 'Readiness location', address: '1 Readiness Way', active: true,
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
      appointmentType: APPOINTMENT_TYPE, eligibleLocationIds: [],
      smsConfirmation: false, emailConfirmation: false,
    },
  });
  await db.receptionistIntakeField.createMany({ data: [
    { tenantId: t.id, campaignId: campaign.id, fieldType: 'FIRST_NAME', label: 'First name', aiQuestion: 'Can I start with your first name?', required: true, sortOrder: 0 },
    { tenantId: t.id, campaignId: campaign.id, fieldType: 'PHONE', label: 'Phone', aiQuestion: 'What is the best number to reach you on?', required: true, sortOrder: 1 },
  ] });

  const service = await db.serviceCatalogItem.create({
    data: { tenantId: t.id, name: APPOINTMENT_TYPE, category: 'general', defaultDurationMinutes: 30, active: true, bookableByVoice },
    select: { id: true },
  });

  const providerProfileIds: string[] = [];
  for (let index = 0; index < providerCount; index += 1) {
    const user = await db.user.create({
      data: {
        tenantId: t.id, role: 'PROVIDER', active: true,
        email: `provider-${randomUUID().slice(0, 8)}@readiness.test`, displayName: `Provider ${index + 1}`,
      },
      select: { id: true },
    });
    const profile = await db.providerProfile.create({
      data: { tenantId: t.id, branchId: t.branchId, userId: user.id, specialty: 'General', active: true },
      select: { id: true },
    });
    providerProfileIds.push(profile.id);
    for (const dayOfWeek of [1, 2, 3, 4, 5]) {
      await db.providerAvailability.create({
        data: {
          tenantId: t.id, branchId: t.branchId, providerProfileId: profile.id,
          dayOfWeek, startMinute: 9 * 60, endMinute: 17 * 60, slotMinutes: 30, active: true,
        },
      });
    }
  }

  if (country === null) await db.receptionistClinic.update({ where: { id: clinic.id }, data: { country: null } });
  if (approvePack && country) await approveLocalePack({ tenantId: t.id, language: 'en-US', country });

  return { clinic, agent, campaign, serviceId: service.id, providerProfileIds };
}

async function readiness(t: TenantFixture, campaignId: string) {
  const response = await app.inject({
    method: 'GET', url: `/v1/receptionist/campaigns/${campaignId}/readiness`, headers: auth(t),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    ready: boolean;
    checks: Array<{ key: string; status: string; code: string | null; title: string; detail: string; fixHref: string | null; blocking: boolean }>;
    actions: { activate: { allowed: boolean; reasons: string[] } };
  };
}

function row(result: Awaited<ReturnType<typeof readiness>>, key: string) {
  const found = result.checks.find(check => check.key === key);
  expect(found, `readiness row ${key}`).toBeDefined();
  return found!;
}

/** Deploy against the mock provider, then verify — the real go-live sequence. */
async function deployAndVerify(t: TenantFixture, agentId: string, campaignId: string) {
  const deployed = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaignId}/deploy`, headers: auth(t) });
  expect(deployed.statusCode, deployed.body).toBe(200);
  const verified = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agentId}/verify-provider`, headers: auth(t) });
  expect(verified.statusCode, verified.body).toBe(200);
  return db.receptionistAgentDeployment.findFirstOrThrow({
    where: { campaignId }, orderBy: { createdAt: 'desc' },
  });
}

type Deployment = { providerAgentId: string | null; providerAgentVersion: number | null; publishedAt: Date | null; agentId: string };

/**
 * The binding a live inbound call carries. `webhooks.ts` stamps all four
 * columns together (a DB check constraint enforces all-or-nothing), so a
 * fixture that wants to look like a real call has to stamp all four too.
 */
async function callBinding(deployment: Deployment, versionOffset = 0) {
  const agent = await db.receptionistAgent.findUniqueOrThrow({
    where: { id: deployment.agentId },
    select: { providerConfigRevision: true, providerFingerprint: true },
  });
  return {
    boundProviderAgentId: deployment.providerAgentId,
    boundProviderAgentVersion: (deployment.providerAgentVersion ?? 0) + versionOffset,
    boundProviderConfigRevision: agent.providerConfigRevision,
    boundProviderFingerprint: agent.providerFingerprint,
  };
}

/** The one call that proves the line works: stamped with this deployment, connected. */
async function testCallFor(t: TenantFixture, clinicId: string, deployment: Deployment) {
  return db.receptionistCallLog.create({
    data: {
      tenantId: t.id, clinicId, direction: 'inbound', outcome: 'BOOKED',
      durationSeconds: 42,
      ...(await callBinding(deployment)),
      createdAt: new Date(deployment.publishedAt!.getTime() + 1_000),
      startedAt: new Date(deployment.publishedAt!.getTime() + 1_000),
      endedAt: new Date(deployment.publishedAt!.getTime() + 43_000),
    },
    select: { id: true },
  });
}

function withMockProvider<T>(fn: () => Promise<T>): Promise<T> {
  env.RETELL_API_KEY = 'mock_deploy_key';
  env.RETELL_FROM_NUMBER = '+15550100000';
  return fn().finally(() => {
    env.RETELL_API_KEY = originalRetell.apiKey;
    env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  });
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app.close();
  await db.$disconnect();
});

// ---------------------------------------------------------------------------

describe('B1 — the number binding is proved, never assumed', () => {
  it('fails, and blocks, for a hand-linked agent no deployment ever bound', async () => {
    const t = await tenant();
    const { agent, campaign } = await scenario(t);
    // The BYO case: somebody pasted a Retell agent id in. There is no
    // deployment row, so nothing in CareCommand knows what the line answers
    // with. This used to be a `warn`, and a warn does not block, so the
    // campaign went ACTIVE while the number's inbound agent was still None.
    await db.receptionistAgent.update({
      where: { id: agent.id },
      data: { providerAgentId: 'agent_hand_linked', providerVersion: 3 },
    });

    const result = await readiness(t, campaign.id);
    const bound = row(result, 'number_bound');
    expect(bound.status).toBe('fail');
    expect(bound.status).not.toBe('warn');
    expect(bound.blocking).toBe(true);
    expect(bound.code).toBe('number_binding_unattested');
    expect(bound.fixHref).toContain('tab=retell');
    expect(result.ready).toBe(false);
    expect(result.actions.activate.allowed).toBe(false);
    expect(result.actions.activate.reasons).toContain('number_binding_unattested');

    const activated = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/activate`, headers: auth(t) });
    expect(activated.statusCode).toBe(409);
    expect(activated.json().code).toBe('campaign_not_ready');
  });

  it('passes only when a deployment row carries the number it bound', async () => {
    const t = await tenant();
    await withMockProvider(async () => {
      const { agent, campaign, clinic } = await scenario(t);
      const deployment = await deployAndVerify(t, agent.id, campaign.id);
      expect(deployment.numberBound).toBe(true);
      expect(deployment.boundPhoneNumber).toBeTruthy();
      expect(row(await readiness(t, campaign.id), 'number_bound').status).toBe('pass');

      // `numberBound: true` with no number is a claim, not evidence.
      await db.receptionistAgentDeployment.update({ where: { id: deployment.id }, data: { boundPhoneNumber: null } });
      const bound = row(await readiness(t, campaign.id), 'number_bound');
      expect(bound.status).toBe('fail');
      expect(clinic.id).toBeTruthy();
    });
  });
});

describe('B2 — a service is bookable only when the voice tool can book it', () => {
  it('fails on a catalogue service that is not bookable by voice', async () => {
    const t = await tenant();
    const { campaign, serviceId } = await scenario(t, { bookableByVoice: false });
    const check = row(await readiness(t, campaign.id), 'services_bookable');
    // Name + active used to be enough. The agent's own prompt then said
    // "Not bookable on this call: take a message instead" to every caller.
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('not marked bookable by voice');
    expect(check.blocking).toBe(true);

    await db.serviceCatalogItem.update({ where: { id: serviceId }, data: { bookableByVoice: true } });
    expect(row(await readiness(t, campaign.id), 'services_bookable').status).toBe('pass');
  });

  it('still fails when no active catalogue row carries the name at all', async () => {
    const t = await tenant();
    const { campaign, serviceId } = await scenario(t);
    await db.serviceCatalogItem.update({ where: { id: serviceId }, data: { active: false } });
    expect(row(await readiness(t, campaign.id), 'services_bookable').status).toBe('fail');
  });
});

describe('B3 — provider_resolvable says what the booking tool can actually do', () => {
  it('fails on a two-clinician branch, where the live tool refuses to offer a time', async () => {
    const t = await tenant();
    const { campaign } = await scenario(t, { providerCount: 2 });
    const result = await readiness(t, campaign.id);
    // Availability rows exist for both, so the old check is green...
    expect(row(result, 'provider_availability').status).toBe('pass');
    // ...while `resolveSoleProvider` returns null and the agent takes a message.
    const resolvable = row(result, 'provider_resolvable');
    expect(resolvable.status).toBe('fail');
    expect(resolvable.detail).toContain('2 active providers');
    expect(resolvable.blocking).toBe(true);
    expect(result.ready).toBe(false);
  });

  it('passes on a single-clinician branch, and fails when nobody is active there', async () => {
    const t = await tenant();
    const { campaign, providerProfileIds } = await scenario(t, { providerCount: 1 });
    expect(row(await readiness(t, campaign.id), 'provider_resolvable').status).toBe('pass');
    await db.providerProfile.update({ where: { id: providerProfileIds[0] }, data: { active: false } });
    const empty = row(await readiness(t, campaign.id), 'provider_resolvable');
    expect(empty.status).toBe('fail');
    expect(empty.detail).toContain('No active provider');
  });

  it('stops failing the moment the booking tool can choose between providers', async () => {
    // Package C1 unions slots across providers and carries providerProfileId on
    // each one. This is the handover: the check keeps running, it stops failing.
    const t = await tenant();
    const { campaign } = await scenario(t, { providerCount: 3 });
    const evaluated = await asTenant(t, tx => evaluateCampaignReadiness(tx, {
      tenantId: t.id, campaignId: campaign.id, capabilities: { multiProviderBooking: true },
    }));
    expect(evaluated!.checks.find(check => check.key === 'provider_resolvable')!.status).toBe('pass');
  });
});

describe('B4 — a test call has to be a call to THIS deployment', () => {
  it('ignores the historical zero-second inbound rows that used to pre-satisfy it', async () => {
    const t = await tenant();
    await withMockProvider(async () => {
      const { agent, campaign, clinic } = await scenario(t);
      // Exactly what live clinics hold: unconnected inbound attempts, unscoped
      // to any deployment. Fourteen of these used to read as "the line works".
      await db.receptionistCallLog.createMany({ data: [
        { tenantId: t.id, clinicId: clinic.id, direction: 'inbound', outcome: 'NO_ANSWER', durationSeconds: 0 },
        { tenantId: t.id, clinicId: clinic.id, direction: 'inbound', outcome: 'NO_ANSWER', durationSeconds: 0 },
      ] });
      expect(row(await readiness(t, campaign.id), 'test_call_completed').status).toBe('fail');

      const deployment = await deployAndVerify(t, agent.id, campaign.id);
      // Still failing: the rows predate the deployment and carry no binding.
      expect(row(await readiness(t, campaign.id), 'test_call_completed').status).toBe('fail');

      // A connected call that arrived at this exact published version clears it.
      await testCallFor(t, clinic.id, deployment);
      const cleared = row(await readiness(t, campaign.id), 'test_call_completed');
      expect(cleared.status).toBe('pass');
      expect(cleared.detail).toContain(`version ${deployment.providerAgentVersion}`);
    });
  });

  it('rejects a call that connected for zero seconds, or reached an older version', async () => {
    const t = await tenant();
    await withMockProvider(async () => {
      const { agent, campaign, clinic } = await scenario(t);
      const deployment = await deployAndVerify(t, agent.id, campaign.id);

      // Right deployment, but the caller never connected.
      await db.receptionistCallLog.create({ data: {
        tenantId: t.id, clinicId: clinic.id, direction: 'inbound', outcome: 'NO_ANSWER', durationSeconds: 0,
        ...(await callBinding(deployment)),
        createdAt: new Date(deployment.publishedAt!.getTime() + 1_000),
      } });
      expect(row(await readiness(t, campaign.id), 'test_call_completed').status).toBe('fail');

      // Connected, but it reached the version this deployment replaced.
      await db.receptionistCallLog.create({ data: {
        tenantId: t.id, clinicId: clinic.id, direction: 'inbound', outcome: 'BOOKED', durationSeconds: 90,
        ...(await callBinding(deployment, -1)),
        createdAt: new Date(deployment.publishedAt!.getTime() + 1_000),
      } });
      expect(row(await readiness(t, campaign.id), 'test_call_completed').status).toBe('fail');
    });
  });

  it('self-resets on every redeploy', async () => {
    const t = await tenant();
    await withMockProvider(async () => {
      const { agent, campaign, clinic } = await scenario(t);
      const first = await deployAndVerify(t, agent.id, campaign.id);
      await testCallFor(t, clinic.id, first);
      expect(row(await readiness(t, campaign.id), 'test_call_completed').status).toBe('pass');

      // Change the campaign so the redeploy publishes a new version, then
      // deploy again. The proof does not carry over — that is the promise the
      // Go-live card makes and the one this check exists to keep.
      await db.receptionistCampaign.update({
        where: { id: campaign.id },
        data: { offerScript: 'A completely rewritten script for the caller to hear.' },
      });
      const second = await deployAndVerify(t, agent.id, campaign.id);
      expect(second.id).not.toBe(first.id);
      expect(row(await readiness(t, campaign.id), 'test_call_completed').status).toBe('fail');

      await testCallFor(t, clinic.id, second);
      expect(row(await readiness(t, campaign.id), 'test_call_completed').status).toBe('pass');
    });
  });
});

describe('B5 — one gate: the badge, the button and the transition agree', () => {
  it('never lets POST /activate succeed on a campaign readiness calls not ready', async () => {
    const t = await tenant();
    const { campaign } = await scenario(t, { bookableByVoice: false });
    const result = await readiness(t, campaign.id);
    expect(result.ready).toBe(false);
    expect(result.actions.activate.allowed).toBe(false);
    const activated = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/activate`, headers: auth(t) });
    expect(activated.statusCode).toBe(409);
  });

  it('activates exactly when readiness says it may, with intake_attested reported but not gating', async () => {
    const t = await tenant();
    await withMockProvider(async () => {
      const { agent, campaign, clinic } = await scenario(t);
      const deployment = await deployAndVerify(t, agent.id, campaign.id);
      await testCallFor(t, clinic.id, deployment);

      const result = await readiness(t, campaign.id);
      const activated = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/activate`, headers: auth(t) });

      // The defect, stated as one line: POST /activate used to succeed on a
      // campaign the readiness response called not-ready and the UI showed as
      // un-activatable, because the two evaluations excluded different rows.
      expect(result.ready, 'readiness must agree with what /activate does').toBe(activated.statusCode === 200);
      expect(result.actions.activate.allowed).toBe(activated.statusCode === 200);
      expect(activated.statusCode, activated.body).toBe(200);
      expect(activated.json().status).toBe('ACTIVE');

      // The attestation is written BY activation, so before the first one this
      // row cannot pass. It is reported, and it does not gate — that exclusion
      // now lives in exactly one place and all three consumers read it.
      const intake = row(result, 'intake_attested');
      expect(intake.status).toBe('fail');
      expect(intake.blocking).toBe(false);
      expect([...NON_BLOCKING_READINESS_KEYS]).toEqual(['intake_attested']);
      expect(result.checks.filter(check => check.blocking && (check.status === 'fail' || check.status === 'pending'))).toEqual([]);
      // ...and the attestation the transition performs then clears the row.
      expect(row(await readiness(t, campaign.id), 'intake_attested').status).toBe('pass');
    });
  });

  it('computes the same blocker list the transition refuses on', async () => {
    const t = await tenant();
    const { campaign } = await scenario(t, { providerCount: 2 });
    const evaluated = await asTenant(t, tx => evaluateCampaignReadiness(tx, { tenantId: t.id, campaignId: campaign.id }));
    const blockers = activationBlockers(evaluated!);
    expect(evaluated!.ready).toBe(blockers.length === 0);
    expect(evaluated!.actions.activate.reasons).toEqual(blockers.map(check => check.code ?? check.key));
  });
});

describe('B6 — the clinic prerequisites are guided checklist rows, not bare codes', () => {
  it('reports missing country, hours and locale pack as remediable rows', async () => {
    const t = await tenant();
    const { campaign } = await scenario(t, { country: null, workingHours: null, approvePack: false });
    const result = await readiness(t, campaign.id);
    for (const key of ['clinic_country_set', 'clinic_hours_set', 'locale_pack_approved']) {
      const check = row(result, key);
      expect(check.status, key).toBe('fail');
      expect(check.blocking, key).toBe(true);
      expect(check.title, key).not.toBe('Something went wrong');
      expect(check.detail, key).not.toContain('report the code');
      expect(check.fixHref, key).toContain('tab=clinic');
    }
    expect(result.ready).toBe(false);
  });

  it('never answers a first-run activation with an unclassified failure', async () => {
    const t = await tenant();
    const { campaign } = await scenario(t, { workingHours: null });
    const activated = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/activate`, headers: auth(t) });
    expect(activated.statusCode).toBe(409);
    const body = activated.json();
    expect(body.title).not.toBe('Something went wrong');
    expect(body.action).not.toContain('report the code');
    // B7: the 409's fix link now carries the ids, so it opens THIS campaign.
    expect(body.fixHref).toContain(`campaign=${campaign.id}`);
    expect((body.reasons as Array<{ key: string }>).map(reason => reason.key)).toContain('clinic_hours_set');
  });

  it('passes the clinic rows for a configured clinic and says what it read', async () => {
    const t = await tenant();
    const { campaign } = await scenario(t);
    const result = await readiness(t, campaign.id);
    expect(row(result, 'clinic_country_set')).toMatchObject({ status: 'pass' });
    expect(row(result, 'clinic_hours_set')).toMatchObject({ status: 'pass' });
    expect(row(result, 'agent_language_supported')).toMatchObject({ status: 'pass' });
    expect(row(result, 'locale_pack_approved').detail).toContain('version');
  });
});

describe('B8 — a live campaign is re-gated, and the regression is emitted', () => {
  it('finds an ACTIVE campaign that no longer passes its own gate and raises a signal', async () => {
    const t = await tenant();
    await withMockProvider(async () => {
      const { agent, campaign, clinic, serviceId } = await scenario(t);
      const deployment = await deployAndVerify(t, agent.id, campaign.id);
      await testCallFor(t, clinic.id, deployment);
      const activated = await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/activate`, headers: auth(t) });
      expect(activated.statusCode, activated.body).toBe(200);

      // Nothing re-ran the checklist after this point, so the campaign stayed
      // green while it could no longer book anything it answers the phone for.
      const clean = await recheckActiveCampaigns(t.id);
      expect(clean).toEqual([]);

      await db.serviceCatalogItem.update({ where: { id: serviceId }, data: { bookableByVoice: false } });
      const regressions = await recheckActiveCampaigns(t.id);
      expect(regressions).toHaveLength(1);
      expect(regressions[0].campaignId).toBe(campaign.id);
      expect(regressions[0].blockers.map(check => check.key)).toContain('services_bookable');

      const event = await db.businessEvent.findFirst({
        where: { tenantId: t.id, eventType: 'receptionist.campaign.readiness_regressed', entityId: campaign.id },
      });
      expect(event, 'a business event exists for the regression').not.toBeNull();
      expect((event!.payload as { blockingCodes?: string[] }).blockingCodes).toContain('services_bookable');

      // `intelligence.ts` routes it into the signal the briefing and the Front
      // Desk banner already read; no new infrastructure was added for it.
      const signal = await db.operationalSignal.findFirst({
        where: { tenantId: t.id, signalType: 'receptionist_readiness_regressed', entityId: campaign.id },
      });
      expect(signal, 'an operational signal exists for the regression').not.toBeNull();
      expect(signal!.status).toBe('open');
      expect(signal!.reason).toContain('services_bookable');
    });
  });

  it('leaves the campaign ACTIVE — a silent auto-pause would take the line down', async () => {
    const t = await tenant();
    await withMockProvider(async () => {
      const { agent, campaign, clinic, serviceId } = await scenario(t);
      const deployment = await deployAndVerify(t, agent.id, campaign.id);
      await testCallFor(t, clinic.id, deployment);
      await app.inject({ method: 'POST', url: `/v1/receptionist/campaigns/${campaign.id}/activate`, headers: auth(t) });
      await db.serviceCatalogItem.update({ where: { id: serviceId }, data: { active: false } });

      const regressions = await asTenant(t, tx => findActiveCampaignRegressions(tx, { tenantId: t.id }));
      expect(regressions).toHaveLength(1);
      const after = await db.receptionistCampaign.findUniqueOrThrow({ where: { id: campaign.id }, select: { status: true } });
      expect(after.status).toBe('ACTIVE');
    });
  });

  it('ignores campaigns that are not ACTIVE', async () => {
    const t = await tenant();
    await scenario(t, { bookableByVoice: false });
    expect(await asTenant(t, tx => findActiveCampaignRegressions(tx, { tenantId: t.id }))).toEqual([]);
  });
});
