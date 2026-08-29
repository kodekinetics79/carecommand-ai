import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// Campaign authority is scoped by campaign CLASS, not granted wholesale.
//
// Migrating the Growth module from raw role lists to requirePermission
// necessarily narrowed campaign write to `campaign:manage` = {OWNER, ADMIN,
// MANAGER}, and BILLING lost it. Granting BILLING `campaign:manage` back would
// have been wrong: a practice chasing its own unpaid deposit is HIPAA payment
// operations, while a reactivation offer to the whole patient base is
// marketing — a different consent class entirely.
//
// So authority follows the campaign type, through ONE declared table
// (CAMPAIGN_CLASS_AUTHORITY in server/lib/campaigns.ts). These tests hold both
// halves of that: what BILLING gained, and everything it did NOT gain.
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
const { ROLE_PERMISSIONS } = await import('../lib/permissions');
const {
  CAMPAIGN_TYPES, AUDIENCE_TYPES, CAMPAIGN_CLASS_AUTHORITY, campaignAuthorityClass,
} = await import('../lib/campaigns');

type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'BILLING' | 'PROVIDER' | 'FRONT_DESK' | 'ANALYST' | 'COMPLIANCE_OFFICER' | 'AUDITOR';
const ALL_ROLES: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR'];

type TenantFixture = { id: string; branchId: string; users: Record<Role, string>; patientId: string };

let app: FastifyInstance;
const tenantIds: string[] = [];

const originalEnv = {
  TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: env.TWILIO_FROM_NUMBER,
};

async function makeTenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `class-${id.slice(0, 6)}`, slug: `class-${id.slice(0, 8)}` } });
  for (const featureKey of ['campaign_automation', 'patient_crm', 'payments_deposits']) {
    await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey, enabled: true, source: 'test' } });
  }
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'Main St' } });
  const users = {} as Record<Role, string>;
  for (const role of ALL_ROLES) {
    const user = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role}-${id.slice(0, 8)}@class.test`, displayName: role },
    });
    users[role] = user.id;
  }
  // One patient who is BOTH an unpaid-deposit candidate and an inactive-patient
  // candidate, so the only thing separating the two campaigns is their class.
  const patient = await db.patient.create({
    data: {
      tenantId: id, branchId: branch.id, firstName: 'Owing', lastName: 'Patient', phone: '+15551300001',
      lastVisitAt: new Date(Date.now() - 400 * 86400000), lifecycleStage: 'AT_RISK',
    },
  });
  await db.depositRequirement.create({
    data: { tenantId: id, branchId: branch.id, patientId: patient.id, status: 'required', requiredAmount: 50, reason: 'deposit', mode: 'mock' },
  });
  return { id, branchId: branch.id, users, patientId: patient.id };
}

function headers(tenant: TenantFixture, role: Role) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: tenant.users[role], tenantId: tenant.id, role, type: 'access' })}` };
}

const inject = (tenant: TenantFixture, role: Role, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(tenant, role), ...(payload === undefined ? {} : { payload: payload as object }) });

const PAYMENT_CAMPAIGN = { name: 'Deposit follow-up', campaignType: 'unpaid_deposit_followup', audienceType: 'unpaid_deposit_followup', channel: 'sms' };
const MARKETING_CAMPAIGN = { name: 'Winback', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms' };

beforeAll(async () => {
  app = await buildApp();
  const e = env as typeof env;
  e.TWILIO_ACCOUNT_SID = 'mock_sid';
  e.TWILIO_AUTH_TOKEN = 'mock_tok';
  e.TWILIO_FROM_NUMBER = '+15550000000';
}, 60_000);

afterAll(async () => {
  Object.assign(env as typeof env, originalEnv);
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('the campaign class table', () => {
  it('classifies every campaign type and audience type exactly once', () => {
    for (const campaignType of CAMPAIGN_TYPES) {
      expect(['payment_followup', 'marketing_outreach'], campaignType).toContain(campaignAuthorityClass({ campaignType, audienceType: campaignType }));
    }
    for (const audienceType of AUDIENCE_TYPES) {
      expect(campaignAuthorityClass({ campaignType: audienceType, audienceType }), audienceType).toBeTruthy();
    }
  });

  it('fails closed when a payment label is pointed at a marketing audience', () => {
    // The obvious bypass: label a campaign as deposit follow-up and aim it at
    // the whole inactive-patient base. Both halves must be payment-class.
    expect(campaignAuthorityClass({ campaignType: 'unpaid_deposit_followup', audienceType: 'unpaid_deposit_followup' })).toBe('payment_followup');
    expect(campaignAuthorityClass({ campaignType: 'unpaid_deposit_followup', audienceType: 'inactive_patients' })).toBe('marketing_outreach');
    expect(campaignAuthorityClass({ campaignType: 'unpaid_deposit_followup', audienceType: null })).toBe('marketing_outreach');
    expect(campaignAuthorityClass({ campaignType: null, audienceType: 'unpaid_deposit_followup' })).toBe('marketing_outreach');
    expect(campaignAuthorityClass({ campaignType: 'not_a_real_type', audienceType: 'unpaid_deposit_followup' })).toBe('marketing_outreach');
  });

  it('keeps campaign:manage sufficient for every class, so no role loses reach', () => {
    for (const authority of Object.values(CAMPAIGN_CLASS_AUTHORITY)) {
      expect(authority.manage).toContain('campaign:manage');
      expect(authority.read).toContain('campaign:read');
    }
  });
});

describe('the permission delta is exactly one grant, on exactly one role', () => {
  it('gives BILLING campaign:payment-followup:manage and nothing else', () => {
    expect(ROLE_PERMISSIONS.BILLING).toContain('campaign:payment-followup:manage');
    // Not blanket campaign authority, and not the campaign list either.
    for (const notGranted of ['campaign:manage', 'campaign:read', 'crm:read', 'crm:write', 'operations:read'] as const) {
      expect(ROLE_PERMISSIONS.BILLING, notGranted).not.toContain(notGranted);
    }
  });

  it('gives the new grant to no other non-administrative role', () => {
    // OWNER/ADMIN hold the whole catalogue by definition; nobody else gains it.
    for (const role of ['MANAGER', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR'] as const) {
      expect(ROLE_PERMISSIONS[role], role).not.toContain('campaign:payment-followup:manage');
    }
    // FRONT_DESK was in the pre-migration role list too, and deliberately does
    // NOT get campaign write back — only the payment class was reopened.
    expect(ROLE_PERMISSIONS.FRONT_DESK).not.toContain('campaign:manage');
  });
});

describe('BILLING manages a payment follow-up campaign end to end', () => {
  it('creates, drafts, approves and launches an unpaid-deposit campaign', async () => {
    const tenant = await makeTenant();

    const created = await inject(tenant, 'BILLING', 'POST', '/v1/crm/campaigns', PAYMENT_CAMPAIGN);
    expect(created.statusCode, created.body).toBe(201);
    const campaignId = (created.json() as { id: string }).id;

    const drafted = await inject(tenant, 'BILLING', 'POST', `/v1/crm/campaigns/${campaignId}/draft`);
    expect(drafted.statusCode, drafted.body).toBe(200);

    const renamed = await inject(tenant, 'BILLING', 'PATCH', `/v1/crm/campaigns/${campaignId}`, { name: 'Deposit follow-up v2' });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const approvalPreview = await inject(tenant, 'BILLING', 'GET', `/v1/crm/campaigns/${campaignId}/launch-preview`);
    expect(approvalPreview.statusCode, approvalPreview.body).toBe(200);
    const approved = await inject(tenant, 'BILLING', 'POST', `/v1/crm/campaigns/${campaignId}/approve`, {
      previewFingerprint: (approvalPreview.json() as { fingerprint: string }).fingerprint,
      confirmExactAudienceTemplateProvider: true,
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const launchPreview = await inject(tenant, 'BILLING', 'GET', `/v1/crm/campaigns/${campaignId}/launch-preview`);
    const launched = await inject(tenant, 'BILLING', 'POST', `/v1/crm/campaigns/${campaignId}/launch`, {
      previewFingerprint: (launchPreview.json() as { fingerprint: string }).fingerprint,
      confirmExactAudienceTemplateProvider: true,
    });
    expect(launched.statusCode, launched.body).toBe(200);
    expect(launched.json()).toMatchObject({ summary: { accepted: 1 } });

    // The evidence surfaces for their own campaign class stay readable.
    expect((await inject(tenant, 'BILLING', 'GET', `/v1/crm/campaigns/${campaignId}`)).statusCode).toBe(200);
    expect((await inject(tenant, 'BILLING', 'GET', `/v1/crm/campaigns/${campaignId}/deliveries`)).statusCode).toBe(200);
    expect((await inject(tenant, 'BILLING', 'POST', `/v1/crm/campaigns/${campaignId}/pause`)).statusCode).toBe(200);
    expect((await inject(tenant, 'BILLING', 'POST', `/v1/crm/campaigns/${campaignId}/cancel`)).statusCode).toBe(200);
    expect((await inject(tenant, 'BILLING', 'DELETE', `/v1/crm/campaigns/${campaignId}`)).statusCode).toBe(200);
  }, 120_000);

  it('does not take payment-class authority away from anyone who already had it', async () => {
    const tenant = await makeTenant();
    for (const role of ['OWNER', 'ADMIN', 'MANAGER'] as const) {
      const created = await inject(tenant, role, 'POST', '/v1/crm/campaigns', { ...PAYMENT_CAMPAIGN, name: `Deposit ${role}` });
      expect(created.statusCode, `${role}: ${created.body}`).toBe(201);
      const marketing = await inject(tenant, role, 'POST', '/v1/crm/campaigns', { ...MARKETING_CAMPAIGN, name: `Winback ${role}` });
      expect(marketing.statusCode, `${role}: ${marketing.body}`).toBe(201);
    }
  }, 120_000);
});

describe('BILLING cannot manage or launch a marketing campaign', () => {
  it('refuses to create one, including one mislabelled as payment follow-up', async () => {
    const tenant = await makeTenant();
    const reactivation = await inject(tenant, 'BILLING', 'POST', '/v1/crm/campaigns', MARKETING_CAMPAIGN);
    expect(reactivation.statusCode).toBe(403);
    expect(reactivation.json()).toMatchObject({ error: 'insufficient_permission', permission: 'campaign:manage' });

    // The mislabel bypass: a payment campaignType aimed at the marketing audience.
    const mislabelled = await inject(tenant, 'BILLING', 'POST', '/v1/crm/campaigns', {
      name: 'Deposit shaped winback', campaignType: 'unpaid_deposit_followup', audienceType: 'inactive_patients', channel: 'sms',
    });
    expect(mislabelled.statusCode).toBe(403);
    expect(mislabelled.json()).toMatchObject({ permission: 'campaign:manage' });
    expect(await db.campaign.count({ where: { tenantId: tenant.id, audienceType: 'inactive_patients' } })).toBe(0);
  }, 120_000);

  it('refuses every surface of an existing reactivation campaign, and never launches it', async () => {
    const tenant = await makeTenant();
    const created = await inject(tenant, 'ADMIN', 'POST', '/v1/crm/campaigns', MARKETING_CAMPAIGN);
    const campaignId = (created.json() as { id: string }).id;
    const approvalPreview = await inject(tenant, 'ADMIN', 'GET', `/v1/crm/campaigns/${campaignId}/launch-preview`);
    const fingerprint = (approvalPreview.json() as { fingerprint: string }).fingerprint;
    await inject(tenant, 'ADMIN', 'POST', `/v1/crm/campaigns/${campaignId}/approve`, {
      previewFingerprint: fingerprint, confirmExactAudienceTemplateProvider: true,
    });

    const refusals: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, string, unknown?]> = [
      ['GET', `/v1/crm/campaigns/${campaignId}`, 'campaign:read'],
      ['GET', `/v1/crm/campaigns/${campaignId}/deliveries`, 'campaign:read'],
      ['PATCH', `/v1/crm/campaigns/${campaignId}`, 'campaign:manage', { name: 'Renamed by billing' }],
      ['POST', `/v1/crm/campaigns/${campaignId}/draft`, 'campaign:manage'],
      ['GET', `/v1/crm/campaigns/${campaignId}/launch-preview`, 'campaign:manage'],
      ['POST', `/v1/crm/campaigns/${campaignId}/approve`, 'campaign:manage'],
      ['POST', `/v1/crm/campaigns/${campaignId}/pause`, 'campaign:manage'],
      ['POST', `/v1/crm/campaigns/${campaignId}/cancel`, 'campaign:manage'],
      ['DELETE', `/v1/crm/campaigns/${campaignId}`, 'campaign:manage'],
      ['POST', `/v1/crm/campaigns/${campaignId}/launch`, 'campaign:manage', { previewFingerprint: fingerprint, confirmExactAudienceTemplateProvider: true }],
    ];
    for (const [method, url, permission, payload] of refusals) {
      const response = await inject(tenant, 'BILLING', method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json(), `${method} ${url}`).toMatchObject({ error: 'insufficient_permission', permission });
    }
    // Nothing was handed to any provider on the marketing campaign.
    expect(await db.campaignDelivery.count({ where: { tenantId: tenant.id, campaignId } })).toBe(0);

    // The campaign list narrows to the class BILLING can act on, rather than
    // disclosing that a reactivation campaign exists at all.
    const payment = await inject(tenant, 'BILLING', 'POST', '/v1/crm/campaigns', PAYMENT_CAMPAIGN);
    const billingList = await inject(tenant, 'BILLING', 'GET', '/v1/crm/campaigns');
    expect(billingList.statusCode).toBe(200);
    const visible = (billingList.json() as Array<{ id: string }>).map(row => row.id);
    expect(visible).toContain((payment.json() as { id: string }).id);
    expect(visible).not.toContain(campaignId);
    expect(billingList.body).not.toContain('Winback');

    // An ADMIN still sees both.
    const adminList = await inject(tenant, 'ADMIN', 'GET', '/v1/crm/campaigns');
    expect((adminList.json() as Array<{ id: string }>).map(row => row.id)).toContain(campaignId);
  }, 120_000);

  it('gains no reach beyond the payment campaign class', async () => {
    const tenant = await makeTenant();
    // Tenant-wide campaign machinery: the live-dispatch activation switch,
    // automation rules, and the opportunity scan keep the broad grant.
    const notWidened: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, string, unknown?]> = [
      ['POST', '/v1/crm/live-dispatch-activation', 'campaign:manage', { channel: 'sms', attestation: 'x'.repeat(40) }],
      ['DELETE', '/v1/crm/live-dispatch-activation/sms', 'campaign:manage'],
      ['POST', '/v1/crm/automation-rules', 'campaign:manage', { templateKey: 'hot_lead_not_booked' }],
      ['POST', '/v1/crm/opportunities/scan', 'campaign:manage'],
      ['GET', '/v1/crm/automation-rules', 'campaign:read'],
      ['GET', '/v1/crm/provider-status', 'campaign:read'],
      // Patient CRM data classes are unchanged: BILLING is still refused the
      // audience preview (real patient names), consent and suppression records.
      ['GET', '/v1/crm/audiences/unpaid_deposit_followup/preview?channel=sms', 'crm:read'],
      ['GET', '/v1/crm/consent', 'crm:read'],
      ['GET', '/v1/crm/suppressions', 'crm:read'],
      ['GET', '/v1/leads', 'crm:read'],
      // And the separate analytics campaign module is untouched by this change.
      ['POST', '/v1/campaigns', 'campaign:manage', {}],
      ['GET', '/v1/campaigns', 'campaign:read'],
    ];
    for (const [method, url, permission, payload] of notWidened) {
      const response = await inject(tenant, 'BILLING', method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json(), `${method} ${url}`).toMatchObject({ error: 'insufficient_permission', permission });
    }
  }, 120_000);

  it('still refuses a role that holds no campaign authority at all, before reading the campaign', async () => {
    const tenant = await makeTenant();
    const created = await inject(tenant, 'ADMIN', 'POST', '/v1/crm/campaigns', PAYMENT_CAMPAIGN);
    const campaignId = (created.json() as { id: string }).id;
    for (const role of ['PROVIDER', 'AUDITOR', 'COMPLIANCE_OFFICER'] as const) {
      const denied = await inject(tenant, role, 'POST', `/v1/crm/campaigns/${campaignId}/launch`, {
        previewFingerprint: '0'.repeat(64), confirmExactAudienceTemplateProvider: true,
      });
      expect(denied.statusCode, role).toBe(403);
      expect(denied.json(), role).toMatchObject({ error: 'insufficient_permission', permission: 'campaign:manage' });
    }
  }, 120_000);

  it('honours a tenant RoleDefinition override of the new grant', async () => {
    const [tenantA, tenantB] = [await makeTenant(), await makeTenant()];
    expect((await inject(tenantB, 'BILLING', 'POST', '/v1/crm/campaigns', PAYMENT_CAMPAIGN)).statusCode).toBe(201);
    // A tenant that revokes the grant revokes the access, and only for itself.
    await db.roleDefinition.create({ data: {
      tenantId: tenantA.id, name: 'Billing', description: 'No campaign authority', permissions: ['billing:read'],
    } });
    const revoked = await inject(tenantA, 'BILLING', 'POST', '/v1/crm/campaigns', PAYMENT_CAMPAIGN);
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json()).toMatchObject({ error: 'insufficient_permission', permission: 'campaign:manage' });
    expect((await inject(tenantB, 'BILLING', 'POST', '/v1/crm/campaigns', PAYMENT_CAMPAIGN)).statusCode).toBe(201);
  }, 120_000);
});
