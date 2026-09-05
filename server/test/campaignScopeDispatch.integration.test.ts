import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// Campaign branch scope.
//
// An earlier increment branch-scoped the audience PREVIEW and left DISPATCH
// tenant-wide, because `Campaign` had nowhere to record the scope a campaign
// was created under. A branch-restricted MANAGER at Clinic B therefore
// previewed only their own patients and then launched to the whole tenant.
//
// `Campaign.branchId` is that missing column. These tests hold the property
// that closes the gap: the preview, the launch fingerprint, and the rows
// handed to the provider all resolve the SAME audience from that ONE column,
// so scope cannot change between approval and dispatch undetected.
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
const { computeCampaignLaunchFingerprint, buildCampaignLaunchPreview } = await import('../lib/campaignIntegrity');
const { dispatchCampaign } = await import('../lib/campaignDispatch');
const { runCampaignAttribution } = await import('../lib/campaignAttribution');
const { runScheduledCampaigns } = await import('../modules/campaigns/jobs');
const { runWithJobTenantContext } = await import('../lib/tenantContext');

type Role = 'ADMIN' | 'MANAGER';
type TenantFixture = { id: string; branchA: string; branchB: string; users: Record<Role, string> };

let app: FastifyInstance;
const tenantIds: string[] = [];

const originalEnv = {
  TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: env.TWILIO_FROM_NUMBER,
};

/** A clearly-mock provider outside production: a real, synthetic acceptance. */
function useMockSms() {
  const e = env as typeof env;
  e.TWILIO_ACCOUNT_SID = 'mock_sid';
  e.TWILIO_AUTH_TOKEN = 'mock_tok';
  e.TWILIO_FROM_NUMBER = '+15550000000';
}

async function makeTenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `scope-${id.slice(0, 6)}`, slug: `scope-${id.slice(0, 8)}` } });
  for (const featureKey of ['campaign_automation', 'patient_crm', 'payments_deposits']) {
    await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey, enabled: true, source: 'test' } });
  }
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId: id, name: 'Clinic A', location: 'A' } }),
    db.branch.create({ data: { tenantId: id, name: 'Clinic B', location: 'B' } }),
  ]);
  const admin = await db.user.create({
    data: { tenantId: id, role: 'ADMIN', active: true, email: `admin-${id.slice(0, 8)}@scope.test`, displayName: 'Admin' },
  });
  // The branch-restricted operator at the heart of the defect.
  const manager = await db.user.create({
    data: { tenantId: id, role: 'MANAGER', active: true, branchId: branchA.id, email: `mgr-${id.slice(0, 8)}@scope.test`, displayName: 'Manager' },
  });
  return { id, branchA: branchA.id, branchB: branchB.id, users: { ADMIN: admin.id, MANAGER: manager.id } };
}

const STALE = new Date(Date.now() - 400 * 86400000);

async function makeInactivePatient(tenant: TenantFixture, branchId: string, lastName: string, phone: string) {
  return db.patient.create({
    data: { tenantId: tenant.id, branchId, firstName: 'Scoped', lastName, phone, lastVisitAt: STALE, lifecycleStage: 'AT_RISK' },
    select: { id: true },
  });
}

function headers(tenant: TenantFixture, role: Role) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: tenant.users[role], tenantId: tenant.id, role, type: 'access' })}` };
}

type PreviewBody = { fingerprint: string; branchScope: string | null; audience: { total: number; eligible: number } };

const inject = (tenant: TenantFixture, role: Role, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(tenant, role), ...(payload === undefined ? {} : { payload: payload as object }) });

async function preview(tenant: TenantFixture, role: Role, campaignId: string): Promise<PreviewBody> {
  const response = await inject(tenant, role, 'GET', `/v1/crm/campaigns/${campaignId}/launch-preview`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as PreviewBody;
}

/** Create -> review the exact server preview -> approve -> launch, as the UI does. */
async function createApproveLaunch(tenant: TenantFixture, role: Role, body: Record<string, unknown>) {
  const created = await inject(tenant, role, 'POST', '/v1/crm/campaigns', body);
  expect(created.statusCode, created.body).toBe(201);
  const campaign = created.json() as { id: string; branchId: string | null };
  const approvalPreview = await preview(tenant, role, campaign.id);
  const approved = await inject(tenant, role, 'POST', `/v1/crm/campaigns/${campaign.id}/approve`, {
    previewFingerprint: approvalPreview.fingerprint, confirmExactAudienceTemplateProvider: true,
  });
  expect(approved.statusCode, approved.body).toBe(200);
  const launchPreview = await preview(tenant, role, campaign.id);
  const launched = await inject(tenant, role, 'POST', `/v1/crm/campaigns/${campaign.id}/launch`, {
    previewFingerprint: launchPreview.fingerprint, confirmExactAudienceTemplateProvider: true,
  });
  return { campaign, approvalPreview, launchPreview, launched };
}

async function deliveredPatientIds(tenantId: string, campaignId: string): Promise<string[]> {
  const rows = await db.campaignDelivery.findMany({ where: { tenantId, campaignId }, select: { patientId: true, status: true } });
  return rows.filter(row => row.status === 'accepted').flatMap(row => row.patientId ? [row.patientId] : []).sort();
}

beforeAll(async () => {
  app = await buildApp();
  useMockSms();
}, 60_000);

afterAll(async () => {
  Object.assign(env as typeof env, originalEnv);
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('campaign dispatch is branch-scoped', () => {
  it('keeps advisory campaign evidence and revenue inside a restricted manager\'s branch', async () => {
    const tenant = await makeTenant();
    const [campaignA, campaignB] = await Promise.all([
      db.campaign.create({
        data: {
          tenantId: tenant.id, branchId: tenant.branchA, name: 'Clinic A recovery', goal: 'inactive_patient_reactivation',
          status: 'ACTIVE', channels: [], campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients',
          campaignChannel: 'sms', audienceSize: 8, createdByUserId: tenant.users.MANAGER,
        },
      }),
      db.campaign.create({
        data: {
          tenantId: tenant.id, branchId: tenant.branchB, name: 'Clinic B private campaign', goal: 'inactive_patient_reactivation',
          status: 'ACTIVE', channels: [], campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients',
          campaignChannel: 'sms', audienceSize: 99, createdByUserId: tenant.users.ADMIN,
        },
      }),
    ]);

    // Revenue is a protected rollup. Produce it from accepted delivery,
    // completed appointment, and succeeded payment evidence rather than
    // mutating the aggregate column directly.
    const acceptedAt = new Date(Date.now() - 5 * 86400000);
    for (const [campaign, branchId, amount] of [
      [campaignA, tenant.branchA, 125],
      [campaignB, tenant.branchB, 9_999],
    ] as const) {
      const patient = await db.patient.create({
        data: { tenantId: tenant.id, branchId, firstName: 'Attributed', lastName: campaign.name, lifecycleStage: 'ACTIVE' },
      });
      await db.campaignDelivery.create({
        data: {
          tenantId: tenant.id, campaignId: campaign.id, patientId: patient.id, channel: 'sms',
          status: 'accepted', provider: 'twilio', sentAt: acceptedAt,
          providerAcceptedAt: acceptedAt, statusUpdatedAt: acceptedAt,
        },
      });
      const appointment = await db.appointment.create({
        data: {
          tenantId: tenant.id, branchId, patientId: patient.id, service: 'Follow-up',
          startsAt: new Date(acceptedAt.getTime() + 2 * 86400000),
          endsAt: new Date(acceptedAt.getTime() + 2 * 86400000 + 1800000),
          status: 'COMPLETED', channel: 'SMS', value: amount,
          createdAt: new Date(acceptedAt.getTime() + 86400000),
        },
      });
      await db.paymentTransaction.create({
        data: {
          tenantId: tenant.id, branchId, patientId: patient.id, appointmentId: appointment.id,
          amount, currency: 'USD', status: 'succeeded', mode: 'test',
          receivedAt: new Date(acceptedAt.getTime() + 3 * 86400000),
        },
      });
    }
    await runCampaignAttribution(new Date(), tenant.id);

    const response = await inject(tenant, 'MANAGER', 'GET', '/v1/advisory/brief');
    expect(response.statusCode, response.body).toBe(200);
    const growth = response.json().advisors.find((row: { advisorType: string }) => row.advisorType === 'growth');
    expect(growth.evidence.join(' ')).toContain('Clinic A recovery');
    expect(growth.evidence.join(' ')).toContain('$125');
    expect(growth.evidence.join(' ')).not.toContain('Clinic B private campaign');
    expect(growth.evidence.join(' ')).not.toContain('$10,124');
  });

  it('a branch-scoped MANAGER reaches only their own branch, and an ADMIN tenant-wide campaign still reaches everyone', async () => {
    const tenant = await makeTenant();
    const [a1, a2, b1, b2] = await Promise.all([
      makeInactivePatient(tenant, tenant.branchA, 'Alpha', '+15551200001'),
      makeInactivePatient(tenant, tenant.branchA, 'Alto', '+15551200002'),
      makeInactivePatient(tenant, tenant.branchB, 'Bravo', '+15551200003'),
      makeInactivePatient(tenant, tenant.branchB, 'Basso', '+15551200004'),
    ]);

    // --- the branch-restricted operator ---------------------------------
    const scoped = await createApproveLaunch(tenant, 'MANAGER', {
      name: 'Clinic A winback', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms',
    });
    // Their own branch is stamped on the campaign; they never chose it.
    expect(scoped.campaign.branchId).toBe(tenant.branchA);
    // The preview they authorized was already only their branch...
    expect(scoped.launchPreview.branchScope).toBe(tenant.branchA);
    expect(scoped.launchPreview.audience.total).toBe(2);
    // ...and so is what actually crossed the provider boundary.
    expect(scoped.launched.statusCode, scoped.launched.body).toBe(200);
    expect(scoped.launched.json()).toMatchObject({ summary: { total: 2, accepted: 2 } });
    expect(await deliveredPatientIds(tenant.id, scoped.campaign.id)).toEqual([a1.id, a2.id].sort());
    // The defect, stated as an assertion: Clinic B was never contacted.
    const scopedDeliveries = await db.campaignDelivery.findMany({ where: { tenantId: tenant.id, campaignId: scoped.campaign.id }, select: { patientId: true } });
    expect(scopedDeliveries.map(row => row.patientId)).not.toContain(b1.id);
    expect(scopedDeliveries.map(row => row.patientId)).not.toContain(b2.id);

    // --- the unrestricted operator: additive, nothing lost ---------------
    const wide = await createApproveLaunch(tenant, 'ADMIN', {
      name: 'Tenant winback', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms',
    });
    expect(wide.campaign.branchId).toBeNull();
    expect(wide.launchPreview.branchScope).toBeNull();
    expect(wide.launchPreview.audience.total).toBe(4);
    expect(wide.launched.statusCode, wide.launched.body).toBe(200);
    expect(wide.launched.json()).toMatchObject({ summary: { total: 4, accepted: 4 } });
    expect(await deliveredPatientIds(tenant.id, wide.campaign.id)).toEqual([a1.id, a2.id, b1.id, b2.id].sort());
  }, 120_000);

  it('refuses to let a branch-scoped operator create, open or launch a tenant-wide campaign', async () => {
    const tenant = await makeTenant();
    await makeInactivePatient(tenant, tenant.branchA, 'Alpha', '+15551210001');
    await makeInactivePatient(tenant, tenant.branchB, 'Bravo', '+15551210002');

    // A branch-restricted caller cannot name someone else's branch...
    const foreign = await inject(tenant, 'MANAGER', 'POST', '/v1/crm/campaigns', {
      name: 'Cross branch', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', branchId: tenant.branchB,
    });
    expect(foreign.statusCode).toBe(403);

    // ...and cannot opt out of scope by omitting it: their branch is stamped.
    const own = await inject(tenant, 'MANAGER', 'POST', '/v1/crm/campaigns', {
      name: 'Own branch', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients',
    });
    expect((own.json() as { branchId: string | null }).branchId).toBe(tenant.branchA);

    // An ADMIN's tenant-wide campaign is out of scope for them entirely — a
    // NULL-branch row fails CLOSED, exactly like branchScope() everywhere else.
    // Otherwise the fix would be cosmetic: they could simply launch someone
    // else's tenant-wide campaign instead of their own.
    const wide = await inject(tenant, 'ADMIN', 'POST', '/v1/crm/campaigns', {
      name: 'Admin tenant-wide', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients',
    });
    const wideId = (wide.json() as { id: string }).id;
    for (const [method, url] of [
      ['GET', `/v1/crm/campaigns/${wideId}`],
      ['GET', `/v1/crm/campaigns/${wideId}/launch-preview`],
      ['GET', `/v1/crm/campaigns/${wideId}/deliveries`],
      ['POST', `/v1/crm/campaigns/${wideId}/pause`],
      ['POST', `/v1/crm/campaigns/${wideId}/cancel`],
    ] as const) {
      expect((await inject(tenant, 'MANAGER', method, url)).statusCode, `${method} ${url}`).toBe(404);
    }
    const stolenLaunch = await inject(tenant, 'MANAGER', 'POST', `/v1/crm/campaigns/${wideId}/launch`, {
      previewFingerprint: '0'.repeat(64), confirmExactAudienceTemplateProvider: true,
    });
    expect(stolenLaunch.statusCode).toBe(404);
    expect(await db.campaignDelivery.count({ where: { tenantId: tenant.id, campaignId: wideId } })).toBe(0);

    // And their own campaign is not hidden from them.
    const list = await inject(tenant, 'MANAGER', 'GET', '/v1/crm/campaigns');
    const ids = (list.json() as Array<{ id: string }>).map(row => row.id);
    expect(ids).toContain((own.json() as { id: string }).id);
    expect(ids).not.toContain(wideId);
  }, 120_000);
});

describe('branch scope reaches the launch fingerprint', () => {
  // The fingerprint exists to catch drift between what an operator authorized
  // and what dispatch would actually do. If scope were not in the material, a
  // scope change whose audience rows happen to be identical would slip through.
  const material = {
    campaignId: 'campaign-1',
    campaignType: 'inactive_patient_reactivation',
    audienceType: 'inactive_patients',
    channel: 'sms' as const,
    scheduledAt: null,
    templateRevision: 'template-v1',
    subjectHash: 'subject-v1',
    templateHash: 'body-v1',
    provider: 'twilio',
    providerMode: 'mock_dev' as const,
    clinicNameHash: 'clinic-v1',
    audienceRows: [{ identity: 'patient:1', destinationHash: 'destination-1', eligibility: 'eligible', renderInputHash: 'render-v1' }],
  };

  it('changes the fingerprint when only the scope changes, and leaves tenant-wide campaigns byte-identical', () => {
    const tenantWide = computeCampaignLaunchFingerprint(material);
    // Additive: a campaign created before Campaign.branchId existed still
    // hashes exactly as it did, so no already-authorized campaign is forced
    // back into re-approval by this change.
    expect(computeCampaignLaunchFingerprint({ ...material, branchScope: undefined })).toBe(tenantWide);
    // Identical audience rows, different authority: different fingerprint.
    const branchA = computeCampaignLaunchFingerprint({ ...material, branchScope: 'branch-a' });
    const branchB = computeCampaignLaunchFingerprint({ ...material, branchScope: 'branch-b' });
    expect(branchA).not.toBe(tenantWide);
    expect(branchB).not.toBe(branchA);
  });

  it('catches a scope change between approval and dispatch even when the audience is unchanged', async () => {
    const tenant = await makeTenant();
    // Every patient lives in branch A, so branch-A scope and tenant-wide scope
    // resolve the SAME people. Only the authority differs — which is precisely
    // the case a fingerprint over audience rows alone would miss.
    await makeInactivePatient(tenant, tenant.branchA, 'Alpha', '+15551220001');
    await makeInactivePatient(tenant, tenant.branchA, 'Alto', '+15551220002');

    const created = await inject(tenant, 'ADMIN', 'POST', '/v1/crm/campaigns', {
      name: 'Scope drift', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms',
    });
    const campaignId = (created.json() as { id: string }).id;
    const authorized = await preview(tenant, 'ADMIN', campaignId);
    expect(authorized.branchScope).toBeNull();
    const approved = await inject(tenant, 'ADMIN', 'POST', `/v1/crm/campaigns/${campaignId}/approve`, {
      previewFingerprint: authorized.fingerprint, confirmExactAudienceTemplateProvider: true,
    });
    expect(approved.statusCode, approved.body).toBe(200);

    // The scope changes after the operator authorized it.
    await db.campaign.update({ where: { id: campaignId }, data: { branchId: tenant.branchA } });

    const afterScopeChange = await preview(tenant, 'ADMIN', campaignId);
    // Same people, same counts...
    expect(afterScopeChange.audience).toEqual(authorized.audience);
    // ...but the authorization no longer matches.
    expect(afterScopeChange.branchScope).toBe(tenant.branchA);
    expect(afterScopeChange.fingerprint).not.toBe(authorized.fingerprint);

    // The route refuses the stale operator authority...
    const stale = await inject(tenant, 'ADMIN', 'POST', `/v1/crm/campaigns/${campaignId}/launch`, {
      previewFingerprint: authorized.fingerprint, confirmExactAudienceTemplateProvider: true,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'LAUNCH_PREVIEW_STALE' });

    // ...and so does dispatch itself, which is the boundary a worker crosses.
    await expect(
      runWithJobTenantContext(tenant.id, () => dispatchCampaign(tenant.id, campaignId), 'worker:test-campaign-scope'),
    ).rejects.toThrow('CAMPAIGN_DISPATCH_AUTHORIZATION_STALE');
    expect(await db.campaignDelivery.count({ where: { tenantId: tenant.id, campaignId } })).toBe(0);
  }, 120_000);
});

describe('the scheduler dispatches a branch-scoped campaign at its own scope', () => {
  it('reaches only the campaign branch with no request context in play', async () => {
    const tenant = await makeTenant();
    const inA = await makeInactivePatient(tenant, tenant.branchA, 'Alpha', '+15551230001');
    const inB = await makeInactivePatient(tenant, tenant.branchB, 'Bravo', '+15551230002');

    const created = await inject(tenant, 'MANAGER', 'POST', '/v1/crm/campaigns', {
      name: 'Scheduled clinic A', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms',
    });
    const campaignId = (created.json() as { id: string }).id;
    await db.campaign.update({ where: { id: campaignId }, data: { scheduledAt: new Date(Date.now() - 60_000) } });

    const authorized = await preview(tenant, 'MANAGER', campaignId);
    expect(authorized.branchScope).toBe(tenant.branchA);
    const approved = await inject(tenant, 'MANAGER', 'POST', `/v1/crm/campaigns/${campaignId}/approve`, {
      previewFingerprint: authorized.fingerprint, confirmExactAudienceTemplateProvider: true,
    });
    expect(approved.statusCode, approved.body).toBe(200);

    // Scoped to this tenant only: the shared dev database holds other tenants.
    const run = await runScheduledCampaigns(new Date(), tenant.id);
    expect(run.dispatched).toBe(1);
    // The worker has no branchId of its own; it resolves Campaign.branchId.
    expect(await deliveredPatientIds(tenant.id, campaignId)).toEqual([inA.id]);
    const rows = await db.campaignDelivery.findMany({ where: { tenantId: tenant.id, campaignId }, select: { patientId: true } });
    expect(rows.map(row => row.patientId)).not.toContain(inB.id);
  }, 120_000);

  it('exports the same preview the scheduler compares against', async () => {
    // buildCampaignLaunchPreview is the single producer of the fingerprint the
    // route persists and the scheduler re-derives; both read Campaign.branchId.
    const tenant = await makeTenant();
    await makeInactivePatient(tenant, tenant.branchA, 'Alpha', '+15551240001');
    await makeInactivePatient(tenant, tenant.branchB, 'Bravo', '+15551240002');
    const campaign = await db.campaign.create({
      data: {
        tenantId: tenant.id, name: 'Direct', goal: 'inactive_patient_reactivation', status: 'SCHEDULED', channels: [],
        branchId: tenant.branchA, campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients',
        campaignChannel: 'sms', messageTemplate: 'Hi {{firstName}}.', requiresApproval: true, draftSource: 'rule_based',
      },
    });
    const scopedPreview = await runWithJobTenantContext(
      tenant.id, () => buildCampaignLaunchPreview(tenant.id, campaign), 'worker:test-campaign-scope',
    );
    expect(scopedPreview.branchScope).toBe(tenant.branchA);
    expect(scopedPreview.audience.total).toBe(1);
  }, 120_000);
});
