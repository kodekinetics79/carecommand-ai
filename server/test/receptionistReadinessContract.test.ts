import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { env } = await import('../config/env');
const { evaluateCampaignReadiness } = await import('../lib/receptionist/campaignReadiness');
const { deployAndVerify } = await import('../lib/receptionist/retellDeploy');
const { transitionCampaign } = await import('../modules/receptionist/campaigns');
const { runWithTrustedTenantContext } = await import('../lib/tenantContext');
const {
  readyCampaignFixture, clinicFixtureData, proveTestCall, fixturePhone,
} = await import('./helpers/receptionistFixtures');

// ===========================================================================
// THE GATE INVARIANT
//
//   No readiness check may pass on a value CareCommand itself wrote without
//   re-reading it.
//
// This is the one sentence that explains 11 of the 19 P0s in the day-2
// register. A campaign could show 14/14 green while it was bound to another
// clinic's line, could not offer a time, could not book its own service, and
// had never been reached by a caller — because every green signal was derived
// from a column we wrote at deploy time rather than from a re-read of reality.
//
// So this suite does not ask "does the check pass on a good fixture". It takes
// a genuinely deployed campaign and then breaks THE REALITY BEHIND ONE CHECK
// while leaving CareCommand's own stored claim about it intact. A check that
// still says `pass` is certifying itself, and fails here.
//
// The register's second rule is asserted alongside it: a check that cannot be
// evaluated is `pending`, never `pass`. The receptionist does not go live on a
// question mark.
//
// TESTS MARKED `it.fails`
// -----------------------
// are written to the INTENDED contract and carry the defect id that owns them.
// They are red-then-green markers: the owning package deletes the `.fails` when
// its fix lands. Do not weaken one to match today's behaviour — that is exactly
// how 2,086 passing tests came to certify a readiness checklist that lied.
// ===========================================================================

type Role = 'OWNER';
type TenantFixture = { id: string; users: Record<Role, string>; branchId: string };

const tenantIds: string[] = [];
const originalRetell = { apiKey: env.RETELL_API_KEY, fromNumber: env.RETELL_FROM_NUMBER };

/**
 * The trusted actor is a real, active OWNER of the tenant, because the RLS
 * predicate checks exactly that: a context that merely looks well-formed does
 * not get to read the tenant's rows. Deploying under it is the same posture an
 * operator's request runs in.
 */
function actorFor(t: TenantFixture) {
  return {
    userId: t.users.OWNER,
    source: 'USER' as const,
    trustedActor: { id: t.users.OWNER, role: 'OWNER' },
  };
}

async function tenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Readiness ${id.slice(0, 8)}`, slug: `readiness-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const owner = await db.user.create({
    data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@readiness.test`, displayName: 'Owner' },
    select: { id: true },
  });
  const branch = await db.branch.create({
    data: { tenantId: id, name: 'Main branch', location: '1 Main Street', timezone: 'America/New_York', active: true },
    select: { id: true },
  });
  return { id, users: { OWNER: owner.id }, branchId: branch.id };
}

const APPOINTMENT_TYPE = 'New patient consultation';

interface DeployedCampaign {
  clinicId: string;
  agentId: string;
  campaignId: string;
  deploymentId: string;
  locationId: string;
  serviceId: string;
  providerProfileIds: string[];
  callLogId: string;
}

/**
 * A campaign taken all the way through the production path an operator uses:
 * configure, deploy to the provider, verify against what the provider reports,
 * then prove the line with one inbound call scoped to that deployment.
 */
async function deployedCampaign(t: TenantFixture, options: { providers?: number; bookableByVoice?: boolean } = {}): Promise<DeployedCampaign> {
  const clinic = await db.receptionistClinic.create({
    data: clinicFixtureData({
      tenantId: t.id, name: `Clinic ${randomUUID().slice(0, 8)}`, phone: fixturePhone(),
      humanFallbackNumber: fixturePhone(), timezone: 'America/New_York', active: true,
    }) as never,
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
  const fixture = await readyCampaignFixture({
    tenantId: t.id, clinicId: clinic.id, campaignId: campaign.id, branchId: t.branchId,
    appointmentType: APPOINTMENT_TYPE, agentId: agent.id,
    providers: options.providers ?? 1,
    bookableByVoice: options.bookableByVoice ?? true,
  });

  const result = await deployAndVerify({ tenantId: t.id, campaignId: campaign.id, actor: actorFor(t) });
  if (!result.deploy.ok) throw new Error(`fixture deploy failed: ${result.deploy.code}`);
  if (result.verification?.kind !== 'verified') throw new Error(`fixture verify failed: ${result.verification?.kind ?? 'unknown'}`);

  const callLogId = await proveTestCall({
    tenantId: t.id, clinicId: clinic.id, campaignId: campaign.id, deploymentId: result.deploy.deployment.id,
  });

  return {
    clinicId: clinic.id, agentId: agent.id, campaignId: campaign.id,
    deploymentId: result.deploy.deployment.id, locationId: fixture.locationId, serviceId: fixture.serviceId,
    providerProfileIds: fixture.providerProfileIds, callLogId,
  };
}

type CheckRow = { key: string; status: string; code: string | null; detail: string; fixHref: string | null; blocking: boolean };

async function readiness(t: TenantFixture, campaignId: string) {
  const tenantId = t.id;
  const response = await runWithTrustedTenantContext(
    { tenantId, actorId: t.users.OWNER, actorRole: 'OWNER', source: 'request' },
    tx => evaluateCampaignReadiness(tx, { tenantId, campaignId }),
  );
  if (!response) throw new Error('readiness returned null');
  const byKey = new Map<string, CheckRow>(response.checks.map(check => [check.key, check as CheckRow]));
  return { response, byKey, status: (key: string) => byKey.get(key)?.status ?? 'MISSING' };
}

beforeAll(async () => {
  // The mock provider, which is what a rehearsal honestly is. Deploying and
  // verifying through the real code paths is the point: a fixture that wrote a
  // VERIFIED row by hand would be the very self-certification under test.
  env.RETELL_API_KEY = 'mock_readiness_contract_key';
  env.RETELL_FROM_NUMBER = '+15550100000';
}, 60_000);

afterAll(async () => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. Every key is classified. A new check cannot ship unclassified.
// ---------------------------------------------------------------------------

type EvidenceKind =
  /** Must re-read the voice provider. A stored column is not evidence. */
  | 'provider_read_back'
  /** Must read a row written by something other than the act being certified. */
  | 'independent_row'
  /** Is legitimately about CareCommand's own configuration, and says so. */
  | 'own_configuration';

const EVIDENCE: Record<string, { evidence: EvidenceKind; why: string }> = {
  // B6 — the clinic prerequisites `transitionCampaign` used to throw as bare
  // 409s after readiness had already said "ready". Three of the four read
  // nothing but our own record of what the practice told us, and are marked as
  // such: "the clinic has hours" is not the same promise as "the agent will
  // say something true about them".
  clinic_country_set: { evidence: 'own_configuration', why: 'B6: `ReceptionistClinic.country`, a field on our own row that our own Clinic Profile form wrote. Nothing outside CareCommand corroborates it.' },
  clinic_hours_set: { evidence: 'own_configuration', why: 'B6: the weekly hours the practice typed into our clinic and location rows, via `loadHoursSource`. No independent source confirms the door is open when they say.' },
  locale_pack_approved: { evidence: 'independent_row', why: 'B6: `resolveApprovedLocalePack` requires an APPROVED `ReceptionistLocalePack` row with its evidence hash, and refuses the platform default. Approval is a separate governed act on a separate row; a campaign cannot write itself one.' },
  agent_language_supported: { evidence: 'own_configuration', why: 'B6: the language we stored on the agent, checked against the languages this product supports. Both halves are ours, and the row says so.' },
  agent_linked: { evidence: 'own_configuration', why: 'Whether this campaign has an agent is our configuration and nothing else.' },
  agent_verified: { evidence: 'provider_read_back', why: 'An attestation with a TTL, written only from what the provider reported.' },
  deployment_current: { evidence: 'own_configuration', why: 'Compares the planned configuration against the deployed hashes — a comparison, not a claim.' },
  number_bound: { evidence: 'provider_read_back', why: 'A2: who answers the number is a fact at Retell. `deployment.numberBound` is a column we wrote.' },
  location_mapped: { evidence: 'own_configuration', why: 'Whether a location is mapped to a branch is our configuration.' },
  services_bookable: { evidence: 'independent_row', why: 'B2: the practice marks a service bookable by voice; a name match is not that decision.' },
  provider_availability: { evidence: 'independent_row', why: 'B3: the `ProviderAvailability` rows the scheduler reads before it can offer any time.' },
  provider_resolvable: { evidence: 'independent_row', why: 'B3: the practice’s own `ProviderProfile` roster at the mapped branch, under the same "exactly one active provider" rule `resolveSoleProvider` applies at call time. A row count is not an offerable time.' },
  intake_attested: { evidence: 'provider_read_back', why: 'The published booking tool as the provider reports it, versus these intake fields.' },
  placeholders_absent: { evidence: 'own_configuration', why: 'Placeholder detection over the assembled prompt.' },
  disclosure_composed: { evidence: 'own_configuration', why: 'Whether the clinic added wording to the baseline disclosure.' },
  closing_disclosure_present: { evidence: 'independent_row', why: 'AB 3030: the APPROVED `ReceptionistLocalePack` row must itself carry `disclosure.closing`. A key the platform backfilled at render time is not in the approved pack’s evidence hash, so this reads `backfilledKeys` and refuses it — a campaign cannot approve its own wording.' },
  emergency_path_reachable: { evidence: 'own_configuration', why: 'Whether a human fallback number exists that is not the AI line. Our own row — and stated as its own check because "an emergency reaches a person" is a different promise from "a transfer does not loop", and this one blocks.' },
  confirmation_channels: { evidence: 'own_configuration', why: 'Whether a channel the campaign promises is configured on this deployment.' },
  transfer_target_distinct: { evidence: 'own_configuration', why: 'Whether the fallback number differs from the AI line.' },
  test_call_completed: { evidence: 'independent_row', why: 'B4: a call log a CALLER caused, scoped to this deployment. Nothing we wrote.' },
  data_storage_setting: { evidence: 'own_configuration', why: 'Read-only for the pilot; must report `warn`, never `pass`.' },
};

function serverReadinessKeys(): string[] {
  const source = readFileSync(resolve(process.cwd(), 'server/lib/receptionist/campaignReadiness.ts'), 'utf8');
  const block = source.match(/const LABELS: Record<ReadinessKey, string> = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('Could not find the LABELS record in campaignReadiness.ts');
  return [...block[1].matchAll(/^\s+([a-z_0-9]+):/gm)].map(match => match[1]);
}

describe('the readiness contract', () => {
  it('classifies every readiness key by the evidence it must consult', () => {
    const keys = serverReadinessKeys();
    expect(keys.length).toBeGreaterThan(0);
    // A new check is a new promise to an operator. It does not ship until
    // somebody has written down what makes it true, and it is not us.
    expect([...keys].sort()).toEqual(Object.keys(EVIDENCE).sort());
  });

  it('names the register rule for every provider-read-back check', () => {
    for (const [key, entry] of Object.entries(EVIDENCE)) {
      expect(entry.why, `${key} must say what it re-reads`).not.toBe('');
    }
    // The three that can never be satisfied by our own writes.
    expect(Object.entries(EVIDENCE).filter(([, item]) => item.evidence === 'provider_read_back').map(([key]) => key).sort())
      .toEqual(['agent_verified', 'intake_attested', 'number_bound']);
  });
});

describe('a check that cannot be evaluated', () => {
  it('is pending, never pass, and pending blocks', async () => {
    const t = await tenant();
    const clinic = await db.receptionistClinic.create({
      data: clinicFixtureData({ tenantId: t.id, name: 'Unassigned', phone: fixturePhone(), active: true }) as never,
    });
    const campaign = await db.receptionistCampaign.create({
      data: {
        tenantId: t.id, clinicId: clinic.id, agentId: null,
        name: 'No agent', campaignType: 'Inbound reception', status: 'DRAFT',
        offerTitle: 'Book a consultation', offerDescription: 'Welcoming new patients.', offerScript: 'I can book you in.',
        appointmentType: APPOINTMENT_TYPE, eligibleLocationIds: [], smsConfirmation: false, emailConfirmation: false,
      },
    });
    const { response, status } = await readiness(t, campaign.id);
    for (const key of ['agent_verified', 'deployment_current', 'number_bound']) {
      expect(status(key), `${key} with no agent`).toBe('pending');
    }
    expect(response.ready).toBe(false);
    expect(response.actions.activate.allowed).toBe(false);
  }, 60_000);

  it('never reports pass with a code or a fix link, and never reports not-pass without one', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    const { response } = await readiness(t, deployed.campaignId);
    for (const check of response.checks) {
      if (check.status === 'pass') {
        expect(check.code, `${check.key} passed but carries a code`).toBeNull();
        expect(check.fixHref, `${check.key} passed but carries a fix link`).toBeNull();
      } else {
        expect(check.code, `${check.key} is ${check.status} with no code`).toBeTruthy();
        expect(check.detail, `${check.key} is ${check.status} with no detail`).not.toBe('');
      }
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. Break the reality, keep our claim. Per key.
// ---------------------------------------------------------------------------

describe('number_bound — who answers the number is a fact at the provider (A1/A2)', () => {
  it('does not let a second clinic\'s deploy take the first clinic\'s line at all', async () => {
    const t = await tenant();
    const first = await deployedCampaign(t);
    expect((await readiness(t, first.campaignId)).status('number_bound')).toBe('pass');

    // Every deploy used to bind the one global RETELL_FROM_NUMBER, so the
    // second clinic silently took the first clinic's line — callers to the
    // first reached the second's agent, its hours and its disclosure — and the
    // first clinic's stored `numberBound` column stayed true, because we wrote
    // it and never looked again.
    //
    // A1 removes the theft rather than detecting it: each deploy binds its own
    // clinic's line. The marker this test carried asked for the weaker
    // property (notice the theft); the stronger one is asserted here, and the
    // detection half is the two tests below.
    const second = await deployedCampaign(t);
    expect((await readiness(t, second.campaignId)).status('number_bound')).toBe('pass');

    const untouched = await readiness(t, first.campaignId);
    expect(untouched.status('number_bound'), 'A1: the first clinic still owns its own line').toBe('pass');

    const [firstRow, secondRow] = await Promise.all([
      db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: first.deploymentId } }),
      db.receptionistAgentDeployment.findUniqueOrThrow({ where: { id: second.deploymentId } }),
    ]);
    expect(firstRow.boundPhoneNumber).toBeTruthy();
    expect(firstRow.boundPhoneNumber, 'A1: two clinics, two lines').not.toBe(secondRow.boundPhoneNumber);
    // And each pass is the provider's answer about that clinic's own number,
    // not the column the deploy wrote.
    expect(firstRow.numberBindingVerifiedAt).not.toBeNull();
    expect(firstRow.numberBindingAgentId).toBe(firstRow.providerAgentId);
    expect(secondRow.numberBindingAgentId).toBe(secondRow.providerAgentId);
  }, 180_000);

  it('is pending, not pass, when the provider cannot be read', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    // The attestation is what the provider said, and it ages out on the same
    // 24h TTL `agent_verified` uses. Age it past that: nothing has confirmed
    // the line for a day, and nobody can say who answers it now.
    await db.receptionistAgentDeployment.update({
      where: { id: deployed.deploymentId },
      data: { numberBindingVerifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) },
    });
    const stale = await readiness(t, deployed.campaignId);
    // The register's rule, stated exactly: unreadable ⇒ pending, never pass.
    expect(stale.status('number_bound'), 'A2: an unconfirmed binding ⇒ pending').toBe('pending');
    expect(stale.byKey.get('number_bound')!.blocking, 'A2: pending still blocks').toBe(true);

    // And a provider that answered with an error is the same answer — pending,
    // never fail. Telling an operator their number is wrong during a Retell
    // outage sends them to fix something that is not broken.
    await db.receptionistAgentDeployment.update({
      where: { id: deployed.deploymentId },
      data: { numberBindingVerifiedAt: null, numberBindingErrorCode: 'provider_unavailable' },
    });
    const unreadable = await readiness(t, deployed.campaignId);
    expect(unreadable.status('number_bound')).toBe('pending');
    expect(unreadable.byKey.get('number_bound')!.detail).toMatch(/provider_unavailable/);
  }, 120_000);

  it('refuses a hand-forged binding claim with nothing published behind it', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);

    // Erasing the published evidence while keeping the attestation is not even
    // representable: the database refuses an attestation that does not name the
    // version actually published, so the forgery cannot be written at all.
    await expect(db.receptionistAgentDeployment.update({
      where: { id: deployed.deploymentId },
      data: { providerAgentVersion: 9_999, boundPhoneNumber: '+15550199999', numberBound: true },
    })).rejects.toThrow(/number_binding_verified_check/);

    // So the strongest forgery available is the claim on its own: our two
    // columns set by hand, with nothing from the provider behind them. That is
    // precisely the shape `number_bound` used to pass on.
    await db.receptionistAgentDeployment.update({
      where: { id: deployed.deploymentId },
      data: {
        providerAgentVersion: 9_999, boundPhoneNumber: '+15550199999', numberBound: true,
        numberBindingVerifiedAt: null, numberBindingAgentId: null, numberBindingAgentVersion: null,
        numberBindingReadAt: null, numberBindingErrorCode: null,
      },
    });
    const forged = await readiness(t, deployed.campaignId);
    expect(forged.status('number_bound'), 'A2: a column we wrote is not evidence').not.toBe('pass');
  }, 120_000);
});

describe('services_bookable — the practice decides what a machine may book (B2)', () => {
  it('fails when the matching service is not bookable by voice', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    expect((await readiness(t, deployed.campaignId)).status('services_bookable')).toBe('pass');

    // The column defaults to false, and the prompt this campaign deploys says
    // "Not bookable on this call: take a message instead" for everything that
    // is not flagged. A name match is not the practice's decision.
    await db.serviceCatalogItem.update({ where: { id: deployed.serviceId }, data: { bookableByVoice: false } });
    const refused = await readiness(t, deployed.campaignId);
    expect(refused.status('services_bookable'), 'B2: an unflagged service is not bookable').toBe('fail');
  }, 120_000);

  it('fails when the service is deactivated entirely', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    await db.serviceCatalogItem.update({ where: { id: deployed.serviceId }, data: { active: false } });
    expect((await readiness(t, deployed.campaignId)).status('services_bookable')).toBe('fail');
  }, 120_000);
});

describe('provider_availability — a row count is not an offerable time (B3)', () => {
  it('stops passing on a branch with more than one provider and no selection rule', async () => {
    const t = await tenant();
    // Every real practice is this shape. `resolveSoleProvider` (liveTools.ts)
    // returns null for 2+ active providers, so the agent answers every booking
    // request with "I need a team member to confirm the provider or service" —
    // silently degraded to message-taking, while the checklist reads green.
    const deployed = await deployedCampaign(t, { providers: 2 });
    expect(deployed.providerProfileIds.length).toBe(2);
    const twoDentists = await readiness(t, deployed.campaignId);
    // B3 shipped as a SPLIT, not as a change to the counting check: both
    // clinicians have weekday windows, so counting rows is honestly satisfied
    // and still says `pass`. The lie was ever calling that "ready", and the new
    // `provider_resolvable` row is what refuses to. Assert both halves, so
    // neither can quietly absorb the other's meaning again.
    expect(twoDentists.status('provider_availability'), 'B3: rows exist, and this check only ever claimed that').toBe('pass');
    expect(twoDentists.status('provider_resolvable'), 'B3: the tool cannot resolve a provider here').not.toBe('pass');
  }, 180_000);

  it('fails when the mapped branch has availability rows but all are inactive', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    await db.providerAvailability.updateMany({ where: { tenantId: t.id, branchId: t.branchId }, data: { active: false } });
    expect((await readiness(t, deployed.campaignId)).status('provider_availability')).toBe('fail');
  }, 120_000);
});

describe('test_call_completed — proof a caller reached THIS deployment (B4)', () => {
  it('is not satisfied by an inbound call recorded before the deployment published', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    await db.receptionistCallLog.delete({ where: { id: deployed.callLogId } });
    const published = await db.receptionistAgentDeployment.findUniqueOrThrow({
      where: { id: deployed.deploymentId }, select: { publishedAt: true },
    });
    // The shape every clinic already holds: historical inbound rows from
    // before this configuration existed.
    await proveTestCall({
      tenantId: t.id, clinicId: deployed.clinicId, campaignId: deployed.campaignId,
      deploymentId: deployed.deploymentId,
      createdAt: new Date((published.publishedAt ?? new Date()).getTime() - 5 * 86_400_000),
    });
    const stale = await readiness(t, deployed.campaignId);
    expect(stale.status('test_call_completed'), 'B4: evidence must postdate the deployment').not.toBe('pass');
  }, 120_000);

  it('is not satisfied by a zero-second call that never connected', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    await db.receptionistCallLog.delete({ where: { id: deployed.callLogId } });
    // Contract §16: the clinics already hold historical zero-second
    // `not_connected` inbound rows. They are the reason this check is
    // pre-satisfied on tenants that have never been reached at all.
    await proveTestCall({
      tenantId: t.id, clinicId: deployed.clinicId, campaignId: deployed.campaignId,
      deploymentId: deployed.deploymentId, durationSeconds: 0, outcome: 'NO_ANSWER',
    });
    const notConnected = await readiness(t, deployed.campaignId);
    expect(notConnected.status('test_call_completed'), 'B4: a zero-second row proves nothing').not.toBe('pass');
  }, 120_000);

  it('is invalidated by the next deploy, which is what the Go-live card promises', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    expect((await readiness(t, deployed.campaignId)).status('test_call_completed')).toBe('pass');

    // A new configuration is a new thing for a caller to reach. Evidence from
    // the version it replaced is not evidence about this one.
    await db.receptionistCampaign.update({
      where: { id: deployed.campaignId },
      data: { offerScript: 'A newly deployed script no caller has yet heard.' },
    });
    const again = await deployAndVerify({ tenantId: t.id, campaignId: deployed.campaignId, actor: actorFor(t) });
    expect(again.deploy.ok, 'the redeploy itself must succeed').toBe(true);

    const superseded = await readiness(t, deployed.campaignId);
    expect(superseded.status('test_call_completed'), 'B4: a redeploy invalidates the proof').not.toBe('pass');
  }, 180_000);

  it('fails outright when no inbound call has ever reached the clinic', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    await db.receptionistCallLog.deleteMany({ where: { tenantId: t.id, clinicId: deployed.clinicId } });
    expect((await readiness(t, deployed.campaignId)).status('test_call_completed')).toBe('fail');
  }, 120_000);
});

describe('the checks that are honestly about our own configuration', () => {
  it('agent_verified stops passing when the attestation has expired', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    expect((await readiness(t, deployed.campaignId)).status('agent_verified')).toBe('pass');
    // Age the attestation past its 24h TTL. The shape constraint still holds
    // (expiry after verification) — what has changed is that the window closed,
    // which is the state an outage of the hourly re-verify worker produces.
    await db.receptionistAgent.update({
      where: { id: deployed.agentId },
      data: {
        providerVerifiedAt: new Date(Date.now() - 25 * 60 * 60_000),
        providerVerificationExpiresAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    expect((await readiness(t, deployed.campaignId)).status('agent_verified')).toBe('fail');
  }, 120_000);

  it('deployment_current stops passing when the campaign changes after deploying', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    expect((await readiness(t, deployed.campaignId)).status('deployment_current')).toBe('pass');
    await db.receptionistCampaign.update({
      where: { id: deployed.campaignId },
      data: { offerScript: 'A different thing entirely, which no caller has ever heard us say.' },
    });
    expect((await readiness(t, deployed.campaignId)).status('deployment_current')).toBe('fail');
  }, 120_000);

  it('location_mapped stops passing when the branch mapping is removed', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    await db.receptionistLocation.update({ where: { id: deployed.locationId }, data: { branchId: null } });
    expect((await readiness(t, deployed.campaignId)).status('location_mapped')).toBe('fail');
  }, 120_000);

  it('placeholders_absent stops passing when placeholder copy returns', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    expect((await readiness(t, deployed.campaignId)).status('placeholders_absent')).toBe('pass');
    await db.receptionistCampaign.update({ where: { id: deployed.campaignId }, data: { offerTitle: 'New offer' } });
    expect((await readiness(t, deployed.campaignId)).status('placeholders_absent')).toBe('fail');
  }, 120_000);

  it('transfer_target_distinct stops passing when the fallback loops back to the AI line', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    const clinic = await db.receptionistClinic.findUniqueOrThrow({ where: { id: deployed.clinicId }, select: { phone: true } });
    await db.receptionistClinic.update({ where: { id: deployed.clinicId }, data: { humanFallbackNumber: clinic.phone } });
    expect((await readiness(t, deployed.campaignId)).status('transfer_target_distinct')).toBe('fail');
  }, 120_000);

  it('confirmation_channels stops passing when the campaign promises a text nothing can send', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    await db.receptionistCampaign.update({ where: { id: deployed.campaignId }, data: { smsConfirmation: true } });
    // The promise is only broken when no sender exists. This suite inherits the
    // developer `.env`, where Twilio is mock-configured and a confirmation IS
    // recorded — so enabling the channel alone proves nothing. Take the sender
    // away, which is the state a pilot tenant that never wired Twilio is in.
    const twilio = {
      TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
      TWILIO_FROM_NUMBER: env.TWILIO_FROM_NUMBER,
    };
    try {
      env.TWILIO_ACCOUNT_SID = undefined;
      env.TWILIO_AUTH_TOKEN = undefined;
      env.TWILIO_FROM_NUMBER = undefined;
      const promised = await readiness(t, deployed.campaignId);
      expect(promised.status('confirmation_channels')).toBe('fail');
      expect(promised.byKey.get('confirmation_channels')?.detail, 'the row must name the channel that cannot deliver').toContain('sms');
    } finally {
      Object.assign(env, twilio);
    }
  }, 120_000);

  it('data_storage_setting never reports pass while no tenant retention policy exists', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    expect((await readiness(t, deployed.campaignId)).status('data_storage_setting')).toBe('warn');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. One gate. The badge and the transition are the same evaluation (B5).
// ---------------------------------------------------------------------------

describe('the badge and the gate are one evaluation (B5)', () => {
  it.fails('refuses to activate a campaign the readiness response calls not ready', async () => {
    const t = await tenant();
    const deployed = await deployedCampaign(t);
    const before = await readiness(t, deployed.campaignId);
    // Deploy does not attest the intake contract — activation does — so this
    // campaign reports not-ready and un-activatable while the transition gate
    // quietly drops `intake_attested` from the same decision.
    expect(before.response.ready).toBe(false);
    expect(before.response.actions.activate.allowed).toBe(false);

    await expect(runWithTrustedTenantContext(
      { tenantId: t.id, actorId: t.users.OWNER, actorRole: 'OWNER', source: 'request' },
      tx => transitionCampaign(tx, { tenantId: t.id, campaignId: deployed.campaignId, to: 'ACTIVE' }),
    ), 'B5: activation must apply exactly the gate the badge shows').rejects.toThrow();
  }, 120_000);
});
