import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import http from 'node:http';
import { Pool } from 'pg';
import type { AddressInfo } from 'node:net';

// Function/DB-level suite (no HTTP app). It exercises the campaign dispatch
// fence directly against real Postgres and a real local Twilio stub, because
// the property under test — "exactly one provider submission" — is only
// meaningful when a real provider request is counted.
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { env } = await import('../config/env');
const { dispatchCampaign } = await import('../lib/campaignDispatch');
const { sendMessage } = await import('../lib/commsProvider');
const {
  buildCampaignLaunchPreview, claimCampaignProviderIntent, campaignSubmissionFenceKey,
  campaignRecipientIdentity,
} = await import('../lib/campaignIntegrity');
const { providerReadiness, resolveDispatchActivations, LIVE_DISPATCH_FENCE_VERSION } = await import('../lib/campaigns');
const { dncFenceKey } = await import('../lib/receptionist/dncFence');
const { runWithJobTenantContext } = await import('../lib/tenantContext');

const MIGRATION_SQL = new URL('../../prisma/migrations/20260828200000_campaign_dispatch_fence/migration.sql', import.meta.url);

const tenantIds: string[] = [];

// ---- Local Twilio stub (real HTTP on an ephemeral port) --------------------
let twilioStub: http.Server;
let twilioBase = '';
let stubHits = 0;
let ownerPool: Pool;

const originalEnv = {
  NODE_ENV: env.NODE_ENV,
  TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: env.TWILIO_FROM_NUMBER,
  TWILIO_BASE_URL: env.TWILIO_BASE_URL,
};

function setLiveCreds() {
  const e = env as typeof env;
  e.NODE_ENV = 'development'; // not production, but creds do NOT start with "mock"
  e.TWILIO_ACCOUNT_SID = 'ACtestfenceaccountsid';
  e.TWILIO_AUTH_TOKEN = 'live_token';
  e.TWILIO_FROM_NUMBER = '+15550000000';
  e.TWILIO_BASE_URL = twilioBase;
}

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `fence-${id.slice(0, 6)}`, slug: `fence-${id.slice(0, 8)}` } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'Main St', active: true } });
  return { id, branchId: branch.id };
}

async function makeInactivePatient(tenantId: string, branchId: string, phone: string) {
  return runWithJobTenantContext(tenantId, tx => tx.patient.create({
    data: {
      tenantId, branchId, firstName: 'Inactive', lastName: 'Patient', phone,
      lifecycleStage: 'ACTIVE', lastVisitAt: new Date('2020-01-01T00:00:00Z'),
    },
    select: { id: true, phone: true },
  }), 'worker:test-fence');
}

/** The exact versioned authority a live regulated SMS send requires. */
async function grantAffirmativeSmsAuthority(tenantId: string, patientId: string) {
  await runWithJobTenantContext(tenantId, tx => tx.consentEvent.create({
    data: {
      tenantId, patientId, purpose: 'SMS', granted: true, source: 'patient_written',
      occurredAt: new Date('2026-08-01T10:00:00.000Z'),
      metadata: {
        authorityVersion: 1,
        outreachPurpose: 'inactive_patient_reactivation',
        policyVersion: 'sms-reactivation-2026-08-01',
        disclosureTextHash: 'a'.repeat(64),
        evidenceReference: 'consent-form:fence-test',
        captureMethod: 'written',
        evidenceSource: 'patient_written',
        jurisdiction: 'US-NY',
      },
    },
  }), 'worker:test-fence');
}

/**
 * Writes an activation row directly. The HTTP surface that is the ONLY way an
 * operator can produce one (OWNER/ADMIN + attestation + configured provider) is
 * covered by campaignLiveDispatchActivation.integration.test.ts.
 */
async function activateSms(tenantId: string) {
  await db.campaignLiveDispatchActivation.create({
    data: {
      tenantId, channel: 'sms',
      activatedByUserId: '00000000-0000-4000-8000-000000000001',
      attestation: 'I confirm live SMS submission to real patients for this tenant, under the reviewed submission fence.',
      attestationHash: 'b'.repeat(64),
      fenceVersion: LIVE_DISPATCH_FENCE_VERSION,
      providerSnapshot: { provider: 'twilio', providerMode: 'live_supported' },
    },
  });
}

async function makeCampaign(tenantId: string) {
  return db.campaign.create({
    data: {
      tenantId, name: 'Reactivation', goal: 'inactive_patient_reactivation', status: 'SCHEDULED', channels: [],
      campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', campaignChannel: 'sms',
      messageTemplate: 'Hi {{firstName}}, it has been a while since your visit to {{clinicName}}.',
      requiresApproval: true, approvedAt: new Date(), draftSource: 'rule_based',
    },
    select: { id: true },
  });
}

/** Records the operator authorization for the CURRENT preview, as the route does. */
async function authorize(tenantId: string, campaignId: string): Promise<string> {
  return runWithJobTenantContext(tenantId, async () => {
    const campaign = await db.campaign.findFirstOrThrow({ where: { tenantId, id: campaignId } });
    const preview = await buildCampaignLaunchPreview(tenantId, campaign);
    await db.campaign.update({ where: { id: campaignId }, data: {
      dispatchAuthorizationFingerprint: preview.fingerprint,
      dispatchAuthorizedByUserId: '00000000-0000-4000-8000-000000000001',
      dispatchAuthorizedAt: new Date(),
    } });
    return preview.fingerprint;
  }, 'worker:test-fence');
}

const dispatch = (tenantId: string, campaignId: string) =>
  runWithJobTenantContext(tenantId, () => dispatchCampaign(tenantId, campaignId), 'worker:test-fence');

beforeAll(async () => {
  twilioStub = http.createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      stubHits++;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sid: `SM_fence_${stubHits}` }));
    });
  });
  await new Promise<void>(resolve => twilioStub.listen(0, '127.0.0.1', resolve));
  twilioBase = `http://127.0.0.1:${(twilioStub.address() as AddressInfo).port}`;
  ownerPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL, max: 3 });
}, 30_000);

afterAll(async () => {
  Object.assign(env as typeof env, originalEnv);
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await ownerPool?.end();
  await new Promise<void>(resolve => twilioStub?.close(() => resolve()));
  await db.$disconnect();
});

// ===========================================================================
// 1. DEFAULT OFF. Building the fence does not turn anything on.
// ===========================================================================
describe('live campaign dispatch is default OFF', () => {
  it('the migration that adds the fence activates nobody', async () => {
    // Executable statements only — the file's own prose explains that it does
    // not activate anyone, and that prose must not satisfy the assertion.
    const sql = readFileSync(MIGRATION_SQL, 'utf8')
      .split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
    // No seed, no backfill, no default that could switch a tenant on.
    expect(/INSERT\s+INTO\s+"CampaignLiveDispatchActivation"/i.test(sql)).toBe(false);
    expect(/ALTER\s+TABLE\s+"CampaignLiveDispatchActivation"[^;]*SET\s+DEFAULT/i.test(sql)).toBe(false);
    expect(/UPDATE\s+"CampaignLiveDispatchActivation"/i.test(sql)).toBe(false);

    // Nor can anything else in the product write one. The activation route is
    // the ONLY writer: no seed, no provisioning hook, no worker, no backfill.
    const writers = execSync(
      String.raw`grep -rlnE "campaignLiveDispatchActivation\.(create|upsert|update|updateMany|createMany)" prisma server --include='*.ts' | grep -v '^server/generated/' | grep -v '^server/test/' || true`,
      { cwd: new URL('../..', import.meta.url), encoding: 'utf8' },
    ).split('\n').filter(Boolean).sort();
    expect(writers).toEqual(['server/modules/campaigns/routes.ts']);

    // And a brand-new tenant starts with nothing activated.
    const fresh = await makeTenant();
    expect(await db.campaignLiveDispatchActivation.count({ where: { tenantId: fresh.id } })).toBe(0);
  });

  it('a fresh, fully provider-configured tenant still cannot dispatch live, and says exactly why', async () => {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770001');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    setLiveCreds();

    // The provider really is configured and really has a live sender.
    const readiness = providerReadiness(await runWithJobTenantContext(t.id, () => resolveDispatchActivations(t.id), 'worker:test-fence'));
    expect(readiness.smsConfigured).toBe(true);
    expect(readiness.providerMode.sms).toBe('live_supported');
    expect(readiness.liveProviderChannels).toContain('sms');
    // The fence exists...
    expect(readiness.liveDispatchFenceImplemented).toBe(true);
    expect(readiness.channelActivation.sms.fencePresent).toBe(true);
    expect(readiness.channelActivation.sms.providerConfigured).toBe(true);
    expect(readiness.channelActivation.sms.liveProviderReady).toBe(true);
    // ...and the ONLY thing missing is this tenant's own activation.
    expect(readiness.channelActivation.sms.tenantActivated).toBe(false);
    expect(readiness.channelActivation.sms.blockingReasons).toEqual(['tenant_activation_missing']);
    expect(readiness.liveSendingSupported).toBe(false);
    expect(readiness.liveCampaignDispatchActivated).toBe(false);
    expect(readiness.activatedChannels).toEqual([]);
    expect(readiness.activationNotice).toContain('no OWNER or ADMIN has recorded an activation attestation');

    const campaign = await makeCampaign(t.id);
    await authorize(t.id, campaign.id);
    const before = stubHits;
    const summary = await dispatch(t.id, campaign.id);

    expect(stubHits).toBe(before);              // provider never contacted
    expect(summary.accepted).toBe(0);
    expect(summary.atomicBoundaryBlocked).toBe(1);
    expect(summary.activationBlockers).toEqual(['tenant_activation_missing']);
    const row = await db.campaignDelivery.findFirst({ where: { tenantId: t.id, campaignId: campaign.id } });
    expect(row?.status).toBe('failed');
    expect(row?.failureReason).toBe('live_outreach_atomic_boundary_not_activated');
    expect(row?.providerMessageId).toBeNull();
    // Nothing was claimed: a refused dispatch leaves no submission evidence.
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id } })).toBe(0);
  });
});

// ===========================================================================
// 2. CONCURRENCY. Two simultaneous dispatchers, ONE provider submission.
// ===========================================================================
describe('campaign submission fence — concurrency', () => {
  it('two simultaneous dispatch attempts for the same recipient produce exactly one provider submission', async () => {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770002');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    await authorize(t.id, campaign.id);

    const before = stubHits;
    const [a, b] = await Promise.all([
      dispatch(t.id, campaign.id),
      dispatch(t.id, campaign.id),
    ]);

    expect(stubHits - before).toBe(1);                       // ONE real provider request
    expect(a.accepted + b.accepted).toBeGreaterThanOrEqual(1);
    // Exactly one durable submission claim, and exactly one intent behind it.
    const claims = await db.campaignSubmissionClaim.findMany({
      where: { tenantId: t.id }, orderBy: { startedAt: 'asc' },
    });
    expect(claims.filter(c => c.phase === 'SUBMISSION_CLAIM')).toHaveLength(1);
    expect(claims.filter(c => c.phase === 'PROVIDER_INTENT')).toHaveLength(1);
    expect(claims.filter(c => c.phase === 'PROVIDER_INTENT')[0].attemptNumber).toBe(1);
    const deliveries = await db.campaignDelivery.findMany({ where: { tenantId: t.id, campaignId: campaign.id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('accepted');           // acceptance, not delivery
    expect(deliveries[0].deliveredAt).toBeNull();
    expect(deliveries[0].providerAcceptedAt).not.toBeNull();
  });

  it('a re-dispatch after acceptance is a no-op, not a second message', async () => {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770003');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    await authorize(t.id, campaign.id);

    const before = stubHits;
    await dispatch(t.id, campaign.id);
    expect(stubHits - before).toBe(1);
    // Re-authorize (the fingerprint moved when the recipient became accepted)
    // and dispatch again: the recipient is already accepted, so nothing is sent.
    await authorize(t.id, campaign.id);
    const second = await dispatch(t.id, campaign.id);
    expect(stubHits - before).toBe(1);
    expect(second.accepted).toBe(1);
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id, phase: 'SUBMISSION_CLAIM' } })).toBe(1);
  });
});

// ===========================================================================
// 3. RACE. An opt-out that lands between preview and dispatch sends nothing.
// ===========================================================================
describe('campaign submission fence — opt-out races', () => {
  it('an opt-out after the authorized preview invalidates the authorization: nothing is dispatched', async () => {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770004');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    await authorize(t.id, campaign.id);

    // The opt-out an AI receptionist call writes.
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: '+15557770004', channel: 'ALL', reason: 'Requested during AI call' } });

    const before = stubHits;
    await expect(dispatch(t.id, campaign.id)).rejects.toThrow('CAMPAIGN_DISPATCH_AUTHORIZATION_STALE');
    expect(stubHits).toBe(before);
    expect(await db.campaignDelivery.count({ where: { tenantId: t.id, campaignId: campaign.id } })).toBe(0);
  });

  it('an opt-out committed before the claim is seen by the fence: no intent, no send', async () => {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770005');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    const fingerprint = await authorize(t.id, campaign.id);
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: '+15557770005', channel: 'ALL', reason: 'AI call' } });

    const before = stubHits;
    const outcome = await runWithJobTenantContext(t.id, () => claimCampaignProviderIntent({
      tenantId: t.id, campaignId: campaign.id, channel: 'sms',
      candidate: { patientId: patient.id, leadId: null },
      destination: '+15557770005', destinationMasked: '***0005', provider: 'twilio',
      idempotencyKey: `${campaign.id}:${patient.id}:sms`, launchFingerprint: fingerprint,
      submissionMode: 'live', force: false,
    }), 'worker:test-fence');

    expect(outcome.outcome).toBe('suppressed');
    expect(stubHits).toBe(before);
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id } })).toBe(0);
    const row = await db.campaignDelivery.findFirst({ where: { tenantId: t.id, campaignId: campaign.id } });
    expect(row?.status).toBe('suppressed');
    expect(row?.providerMessageId).toBeNull();
  });

  it('an opt-out that lands AFTER the intent commits still suppresses the provider request', async () => {
    // This is the exact window the boundary was previously failing closed for:
    // the claim is durable and committed, and the opt-out arrives before the
    // provider call. sendMessage's last-second gate is authoritative and wins.
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770006');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    const fingerprint = await authorize(t.id, campaign.id);
    const key = `${campaign.id}:${patient.id}:sms`;

    const outcome = await runWithJobTenantContext(t.id, () => claimCampaignProviderIntent({
      tenantId: t.id, campaignId: campaign.id, channel: 'sms',
      candidate: { patientId: patient.id, leadId: null },
      destination: '+15557770006', destinationMasked: '***0006', provider: 'twilio',
      idempotencyKey: key, launchFingerprint: fingerprint,
      submissionMode: 'live', force: false,
    }), 'worker:test-fence');
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome !== 'claimed') return;

    // The opt-out lands now — after a committed, valid submission claim.
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: '+15557770006', channel: 'ALL', reason: 'AI call' } });

    const before = stubHits;
    const result = await runWithJobTenantContext(t.id, () => sendMessage('sms', '+15557770006', 'S', 'B', key, {
      tenantId: t.id, patientId: patient.id, leadId: null,
      regulatedOutreach: { purpose: 'inactive_patient_reactivation' },
      campaignSubmission: {
        campaignId: campaign.id,
        fenceKey: campaignSubmissionFenceKey(t.id, campaign.id, campaignRecipientIdentity({ patientId: patient.id }), 'sms'),
        ticket: outcome.ticket,
      },
    }), 'worker:test-fence');

    expect(result.status).toBe('suppressed');
    expect(result.providerMessageId).toBeUndefined();
    expect(stubHits).toBe(before);
    // A valid claim was held and deliberately not used. No submission was made.
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id, phase: 'SUBMISSION_CLAIM' } })).toBe(0);
  });

  it('serializes against an opt-out writer holding the same suppression fence', async () => {
    // Proves the advisory-lock linearization, not just check ordering: an
    // opt-out writer that holds the destination fence blocks the dispatcher's
    // claim transaction, and the dispatcher then observes the committed opt-out.
    const t = await makeTenant();
    const phone = '+15557770007';
    const patient = await makeInactivePatient(t.id, t.branchId, phone);
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    const fingerprint = await authorize(t.id, campaign.id);

    const writer = await ownerPool.connect();
    let claimStarted = false;
    try {
      await writer.query('BEGIN');
      // Exactly what server/modules/receptionist/routes.ts takes before writing
      // a ReceptionistOptOut row.
      await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [dncFenceKey(t.id, phone)]);

      const claiming = runWithJobTenantContext(t.id, () => {
        claimStarted = true;
        return claimCampaignProviderIntent({
          tenantId: t.id, campaignId: campaign.id, channel: 'sms',
          candidate: { patientId: patient.id, leadId: null },
          destination: phone, destinationMasked: '***0007', provider: 'twilio',
          idempotencyKey: `${campaign.id}:${patient.id}:sms`, launchFingerprint: fingerprint,
          submissionMode: 'live', force: false,
        });
      }, 'worker:test-fence');

      // Give the claim transaction time to reach (and block on) the fence.
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(claimStarted).toBe(true);

      await writer.query(
        'INSERT INTO "ReceptionistOptOut" (id, "tenantId", "contactPhone", channel, reason, "createdAt") VALUES (gen_random_uuid(), $1, $2, $3::"ReceptionistOptOutChannel", $4, now())',
        [t.id, phone, 'ALL', 'Requested during AI call'],
      );
      await writer.query('COMMIT');

      const outcome = await claiming;
      // The dispatcher waited behind the writer and saw the committed opt-out.
      expect(outcome.outcome).toBe('suppressed');
      expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id } })).toBe(0);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  }, 30_000);
});

// ===========================================================================
// 4. The claim itself: single-use, and bound to this exact recipient attempt.
// ===========================================================================
describe('campaign submission claim is single-use', () => {
  it('replaying a used claim submits nothing', async () => {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770008');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    const fingerprint = await authorize(t.id, campaign.id);
    const key = `${campaign.id}:${patient.id}:sms`;
    const fenceKey = campaignSubmissionFenceKey(t.id, campaign.id, campaignRecipientIdentity({ patientId: patient.id }), 'sms');

    const outcome = await runWithJobTenantContext(t.id, () => claimCampaignProviderIntent({
      tenantId: t.id, campaignId: campaign.id, channel: 'sms',
      candidate: { patientId: patient.id, leadId: null },
      destination: '+15557770008', destinationMasked: '***0008', provider: 'twilio',
      idempotencyKey: key, launchFingerprint: fingerprint, submissionMode: 'live', force: false,
    }), 'worker:test-fence');
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome !== 'claimed') return;

    const send = () => runWithJobTenantContext(t.id, () => sendMessage('sms', '+15557770008', 'S', 'B', key, {
      tenantId: t.id, patientId: patient.id, leadId: null,
      regulatedOutreach: { purpose: 'inactive_patient_reactivation' },
      campaignSubmission: { campaignId: campaign.id, fenceKey, ticket: outcome.ticket },
    }), 'worker:test-fence');

    const before = stubHits;
    const first = await send();
    expect(first.status).toBe('sent');
    expect(stubHits - before).toBe(1);

    const replay = await send();
    expect(replay.status).toBe('failed');
    expect(replay.failureReason).toBe('campaign_submission_not_claimed:already_submitted');
    expect(stubHits - before).toBe(1);           // still ONE provider request
  });

  it('refuses a claim whose destination does not match the intent', async () => {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770009');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    const fingerprint = await authorize(t.id, campaign.id);
    const key = `${campaign.id}:${patient.id}:sms`;
    const fenceKey = campaignSubmissionFenceKey(t.id, campaign.id, campaignRecipientIdentity({ patientId: patient.id }), 'sms');

    const outcome = await runWithJobTenantContext(t.id, () => claimCampaignProviderIntent({
      tenantId: t.id, campaignId: campaign.id, channel: 'sms',
      candidate: { patientId: patient.id, leadId: null },
      destination: '+15557770009', destinationMasked: '***0009', provider: 'twilio',
      idempotencyKey: key, launchFingerprint: fingerprint, submissionMode: 'live', force: false,
    }), 'worker:test-fence');
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome !== 'claimed') return;

    const before = stubHits;
    const redirected = await runWithJobTenantContext(t.id, () => sendMessage('sms', '+15558880000', 'S', 'B', key, {
      tenantId: t.id, patientId: patient.id, leadId: null,
      regulatedOutreach: { purpose: 'inactive_patient_reactivation' },
      campaignSubmission: { campaignId: campaign.id, fenceKey, ticket: outcome.ticket },
    }), 'worker:test-fence');
    expect(redirected.status).toBe('failed');
    expect(redirected.failureReason).toBe('campaign_submission_not_claimed:intent_missing_or_stale');
    expect(stubHits).toBe(before);
  });

  it('a live claim stops being usable the moment activation is revoked', async () => {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770010');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    const fingerprint = await authorize(t.id, campaign.id);
    const key = `${campaign.id}:${patient.id}:sms`;
    const fenceKey = campaignSubmissionFenceKey(t.id, campaign.id, campaignRecipientIdentity({ patientId: patient.id }), 'sms');

    const outcome = await runWithJobTenantContext(t.id, () => claimCampaignProviderIntent({
      tenantId: t.id, campaignId: campaign.id, channel: 'sms',
      candidate: { patientId: patient.id, leadId: null },
      destination: '+15557770010', destinationMasked: '***0010', provider: 'twilio',
      idempotencyKey: key, launchFingerprint: fingerprint, submissionMode: 'live', force: false,
    }), 'worker:test-fence');
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome !== 'claimed') return;

    await db.campaignLiveDispatchActivation.updateMany({
      where: { tenantId: t.id, channel: 'sms' },
      data: { revokedAt: new Date(), revocationReason: 'test' },
    });

    const before = stubHits;
    const result = await runWithJobTenantContext(t.id, () => sendMessage('sms', '+15557770010', 'S', 'B', key, {
      tenantId: t.id, patientId: patient.id, leadId: null,
      regulatedOutreach: { purpose: 'inactive_patient_reactivation' },
      campaignSubmission: { campaignId: campaign.id, fenceKey, ticket: outcome.ticket },
    }), 'worker:test-fence');
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('campaign_submission_not_claimed:activation_revoked');
    expect(stubHits).toBe(before);
  });
});

// ===========================================================================
// 4b. Adversarial: things that happen BETWEEN the claim and the provider call.
// ===========================================================================
describe('campaign submission fence — adversarial interleavings', () => {
  async function claimFor(phone: string, tag: string) {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, phone);
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();
    const campaign = await makeCampaign(t.id);
    const fingerprint = await authorize(t.id, campaign.id);
    const key = `${campaign.id}:${patient.id}:sms`;
    const fenceKey = campaignSubmissionFenceKey(t.id, campaign.id, campaignRecipientIdentity({ patientId: patient.id }), 'sms');
    const outcome = await runWithJobTenantContext(t.id, () => claimCampaignProviderIntent({
      tenantId: t.id, campaignId: campaign.id, channel: 'sms',
      candidate: { patientId: patient.id, leadId: null },
      destination: phone, destinationMasked: `***${phone.slice(-4)}`, provider: 'twilio',
      idempotencyKey: key, launchFingerprint: fingerprint, submissionMode: 'live', force: false,
    }), `worker:test-fence-${tag}`);
    return { t, patient, campaign, key, fenceKey, outcome };
  }

  it('a provider webhook that advances the delivery row invalidates the pending claim', async () => {
    // The webhook takes a DIFFERENT advisory lock namespace, so it is not
    // serialized with the fence. It can only ever move the row forward to a
    // terminal/accepted state — which the claim then refuses. Fail-closed.
    const { t, key, fenceKey, outcome, campaign, patient } = await claimFor('+15557770012', 'webhook');
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome !== 'claimed') return;

    await db.campaignDelivery.update({
      where: { id: outcome.ticket.campaignDeliveryId },
      data: { status: 'delivered', deliveredAt: new Date() },
    });

    const before = stubHits;
    const result = await runWithJobTenantContext(t.id, () => sendMessage('sms', '+15557770012', 'S', 'B', key, {
      tenantId: t.id, patientId: patient.id, leadId: null,
      regulatedOutreach: { purpose: 'inactive_patient_reactivation' },
      campaignSubmission: { campaignId: campaign.id, fenceKey, ticket: outcome.ticket },
    }), 'worker:test-fence-webhook');
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('campaign_submission_not_claimed:delivery_state_changed');
    expect(stubHits).toBe(before);
  });

  it('an identity-keyed suppression written after the claim is caught inside the claim transaction', async () => {
    // CampaignSuppression is identity-keyed, so the destination-based
    // ReceptionistOptOut path is not what catches it — the in-claim
    // isSuppressedTx re-check under the identity fence is.
    const { t, key, fenceKey, outcome, campaign, patient } = await claimFor('+15557770013', 'suppression');
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome !== 'claimed') return;

    await db.campaignSuppression.create({ data: { tenantId: t.id, patientId: patient.id, channel: 'sms', reason: 'requested', active: true } });

    const before = stubHits;
    const result = await runWithJobTenantContext(t.id, () => sendMessage('sms', '+15557770013', 'S', 'B', key, {
      tenantId: t.id, patientId: patient.id, leadId: null,
      regulatedOutreach: { purpose: 'inactive_patient_reactivation' },
      campaignSubmission: { campaignId: campaign.id, fenceKey, ticket: outcome.ticket },
    }), 'worker:test-fence-suppression');
    expect(result.status).toBe('suppressed');
    expect(stubHits).toBe(before);
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id, phase: 'SUBMISSION_CLAIM' } })).toBe(0);
  });

  it('a claim minted for one tenant cannot be replayed against another', async () => {
    const { outcome, campaign, fenceKey, key } = await claimFor('+15557770014', 'cross');
    expect(outcome.outcome).toBe('claimed');
    if (outcome.outcome !== 'claimed') return;
    const other = await makeTenant();

    const before = stubHits;
    const result = await runWithJobTenantContext(other.id, () => sendMessage('sms', '+15557770014', 'S', 'B', key, {
      tenantId: other.id, patientId: null, leadId: null,
      campaignSubmission: { campaignId: campaign.id, fenceKey, ticket: outcome.ticket },
    }), 'worker:test-fence-cross');
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('campaign_submission_not_claimed:intent_missing_or_stale');
    expect(stubHits).toBe(before);
  });
});

// ===========================================================================
// 5. Activation makes a real, fenced live dispatch work end to end.
// ===========================================================================
describe('activated tenant dispatches live through the fence', () => {
  it('submits once, records provider acceptance (not delivery), and leaves full claim evidence', async () => {
    const t = await makeTenant();
    const patient = await makeInactivePatient(t.id, t.branchId, '+15557770011');
    await grantAffirmativeSmsAuthority(t.id, patient.id);
    await activateSms(t.id);
    setLiveCreds();

    const readiness = providerReadiness(await runWithJobTenantContext(t.id, () => resolveDispatchActivations(t.id), 'worker:test-fence'));
    expect(readiness.liveCampaignDispatchActivated).toBe(true);
    expect(readiness.activatedChannels).toEqual(['sms']);
    expect(readiness.channelActivation.sms.blockingReasons).toEqual([]);
    expect(readiness.activationNotice).toContain('ACTIVE for sms');

    const campaign = await makeCampaign(t.id);
    const fingerprint = await authorize(t.id, campaign.id);
    const before = stubHits;
    const summary = await dispatch(t.id, campaign.id);

    expect(stubHits - before).toBe(1);
    expect(summary.accepted).toBe(1);
    expect(summary.atomicBoundaryBlocked).toBe(0);
    expect(summary.authorityBlocked).toBe(0);

    const claims = await db.campaignSubmissionClaim.findMany({ where: { tenantId: t.id }, orderBy: { startedAt: 'asc' } });
    expect(claims.map(c => c.phase)).toEqual(['PROVIDER_INTENT', 'SUBMISSION_CLAIM', 'RESULT']);
    expect(claims.every(c => c.launchFingerprint === fingerprint || c.phase === 'RESULT')).toBe(true);
    expect(claims.every(c => c.submissionMode === 'live')).toBe(true);
    // Evidence carries no destination, only a hash.
    expect(claims.every(c => !JSON.stringify(c).includes('5557770011'))).toBe(true);
    expect(claims.find(c => c.phase === 'RESULT')?.status).toBe('accepted');

    const delivery = await db.campaignDelivery.findFirstOrThrow({ where: { tenantId: t.id, campaignId: campaign.id } });
    expect(delivery.status).toBe('accepted');   // acceptance, never delivery
    expect(delivery.deliveredAt).toBeNull();
    expect(delivery.destinationMasked).not.toContain('5557770011');
  });
});
