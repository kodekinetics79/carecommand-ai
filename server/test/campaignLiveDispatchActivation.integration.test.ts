import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
const { LIVE_DISPATCH_FENCE_VERSION } = await import('../lib/campaigns');

type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'AUDITOR';

let app: FastifyInstance;
const tenantIds: string[] = [];

const ATTESTATION = 'I am authorized to activate live SMS delivery for this clinic and I accept responsibility for messages sent to real patients.';

const originalEnv = {
  NODE_ENV: env.NODE_ENV,
  TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: env.TWILIO_FROM_NUMBER,
  SMTP_HOST: env.SMTP_HOST,
  SMTP_USER: env.SMTP_USER,
  SMTP_PASS: env.SMTP_PASS,
  EMAIL_HTTP_API_URL: env.EMAIL_HTTP_API_URL,
  EMAIL_HTTP_API_KEY: env.EMAIL_HTTP_API_KEY,
  EMAIL_FROM_ADDRESS: env.EMAIL_FROM_ADDRESS,
};

/** Twilio configured with real-looking (non-"mock") credentials → live_supported. */
function setLiveSmsCreds() {
  const e = env as typeof env;
  e.NODE_ENV = 'development';
  e.TWILIO_ACCOUNT_SID = 'ACtestactivationsid';
  e.TWILIO_AUTH_TOKEN = 'live_token';
  e.TWILIO_FROM_NUMBER = '+15550000000';
}

/** Email deliberately has no live sender wired. */
function clearEmailProvider() {
  const e = env as typeof env;
  e.SMTP_HOST = undefined;
  e.SMTP_USER = undefined;
  e.SMTP_PASS = undefined;
  e.EMAIL_HTTP_API_URL = undefined;
  e.EMAIL_HTTP_API_KEY = undefined;
  e.EMAIL_FROM_ADDRESS = undefined;
}

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `activation-${id.slice(0, 6)}`, slug: `activation-${id.slice(0, 8)}` } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main clinic', location: 'Test' } });
  for (const featureKey of ['campaign_automation', 'patient_crm']) {
    await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey, enabled: true, source: 'test' } });
  }
  const users = {} as Record<Role, string>;
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'AUDITOR'] as const) {
    const user = await db.user.create({
      data: {
        tenantId: id, role, active: true,
        ...(role === 'MANAGER' ? { branchId: branch.id } : {}),
        email: `${role}-${id.slice(0, 8)}@activation.test`, displayName: role,
      },
    });
    users[role] = user.id;
  }
  return { id, users };
}

function headers(tenant: { id: string; users: Record<Role, string> }, role: Role) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: tenant.users[role], tenantId: tenant.id, role, type: 'access' })}` };
}

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  Object.assign(env as typeof env, originalEnv);
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('live campaign dispatch activation endpoint', () => {
  it('reports the truthful default-off state for a fully provider-configured tenant', async () => {
    setLiveSmsCreds();
    const tenant = await makeTenant();
    const status = await app.inject({ method: 'GET', url: '/v1/crm/provider-status', headers: headers(tenant, 'OWNER') });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    // Truthful, not a literal: the provider IS wired, the fence IS present, and
    // the one missing condition is named.
    expect(body.smsConfigured).toBe(true);
    expect(body.providerMode.sms).toBe('live_supported');
    expect(body.liveDispatchFenceImplemented).toBe(true);
    expect(body.liveDispatchFenceVersion).toBe(LIVE_DISPATCH_FENCE_VERSION);
    expect(body.liveProviderChannels).toContain('sms');
    expect(body.liveSendingSupported).toBe(false);
    expect(body.liveCampaignDispatchActivated).toBe(false);
    expect(body.channelActivation.sms.blockingReasons).toEqual(['tenant_activation_missing']);
    expect(body.activationNotice).toContain('no OWNER or ADMIN has recorded an activation attestation');
    // No secret values are ever echoed.
    expect(JSON.stringify(body)).not.toContain('live_token');
    expect(JSON.stringify(body)).not.toContain('ACtestactivationsid');
  });

  it('refuses a role that is not OWNER or ADMIN, even with campaign:manage', async () => {
    setLiveSmsCreds();
    const tenant = await makeTenant();
    // MANAGER holds campaign:manage, so the permission layer lets it through —
    // and the explicit accountability gate still refuses.
    const denied = await app.inject({
      method: 'POST', url: '/v1/crm/live-dispatch-activation', headers: headers(tenant, 'MANAGER'),
      payload: { channel: 'sms', attestation: ATTESTATION, confirmLiveSubmissionToRealRecipients: true, fenceVersion: LIVE_DISPATCH_FENCE_VERSION },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'owner_or_admin_required' });
    expect(await db.campaignLiveDispatchActivation.count({ where: { tenantId: tenant.id } })).toBe(0);

    // A role without campaign:manage is refused earlier, by the permission layer.
    const auditor = await app.inject({
      method: 'POST', url: '/v1/crm/live-dispatch-activation', headers: headers(tenant, 'AUDITOR'),
      payload: { channel: 'sms', attestation: ATTESTATION, confirmLiveSubmissionToRealRecipients: true, fenceVersion: LIVE_DISPATCH_FENCE_VERSION },
    });
    expect(auditor.statusCode).toBe(403);
    expect(auditor.json()).toMatchObject({ error: 'insufficient_permission', permission: 'campaign:manage' });
    expect(await db.campaignLiveDispatchActivation.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('refuses activation when the provider for that channel is not configured', async () => {
    setLiveSmsCreds();
    clearEmailProvider();
    const tenant = await makeTenant();
    const refused = await app.inject({
      method: 'POST', url: '/v1/crm/live-dispatch-activation', headers: headers(tenant, 'OWNER'),
      payload: { channel: 'email', attestation: ATTESTATION, confirmLiveSubmissionToRealRecipients: true, fenceVersion: LIVE_DISPATCH_FENCE_VERSION },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'provider_not_configured', channel: 'email' });
    // The refusal states HOW FAR from ready we are — a count of the two keys
    // this test just cleared — and names none of them. Naming them would put
    // CareCommand's sending supplier and its server variables on a clinic's
    // screen, where nobody can act on either (8af601d). The operator-only
    // detail stays in the Control Tower.
    expect(refused.json().missingConfigCount).toBe(2);
    expect(refused.json().missing).toBeUndefined();
    for (const leak of ['EMAIL_HTTP_API_URL', 'EMAIL_HTTP_API_KEY', 'http-email']) {
      expect(JSON.stringify(refused.json())).not.toContain(leak);
    }
    expect(await db.campaignLiveDispatchActivation.count({ where: { tenantId: tenant.id } })).toBe(0);
    // The refusal itself is evidence.
    const audits = await db.auditEvent.findMany({ where: { tenantId: tenant.id, action: 'campaign.live_dispatch.activation_refused' } });
    expect(audits).toHaveLength(1);
  });

  it('requires an explicit attestation, an explicit acknowledgement, and the current fence version', async () => {
    setLiveSmsCreds();
    const tenant = await makeTenant();
    const bad = [
      { channel: 'sms', attestation: 'ok', confirmLiveSubmissionToRealRecipients: true, fenceVersion: LIVE_DISPATCH_FENCE_VERSION },
      { channel: 'sms', attestation: ATTESTATION, fenceVersion: LIVE_DISPATCH_FENCE_VERSION },
      { channel: 'sms', attestation: ATTESTATION, confirmLiveSubmissionToRealRecipients: false, fenceVersion: LIVE_DISPATCH_FENCE_VERSION },
      { channel: 'sms', attestation: ATTESTATION, confirmLiveSubmissionToRealRecipients: true, fenceVersion: 'campaign-submission-claim.v0' },
      { channel: 'voice', attestation: ATTESTATION, confirmLiveSubmissionToRealRecipients: true, fenceVersion: LIVE_DISPATCH_FENCE_VERSION },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/v1/crm/live-dispatch-activation', headers: headers(tenant, 'OWNER'), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await db.campaignLiveDispatchActivation.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('activates one channel for one tenant, audited, and nothing else', async () => {
    setLiveSmsCreds();
    const tenant = await makeTenant();
    const other = await makeTenant();

    const created = await app.inject({
      method: 'POST', url: '/v1/crm/live-dispatch-activation', headers: headers(tenant, 'ADMIN'),
      payload: { channel: 'sms', attestation: ATTESTATION, confirmLiveSubmissionToRealRecipients: true, fenceVersion: LIVE_DISPATCH_FENCE_VERSION },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ channel: 'sms', fenceVersion: LIVE_DISPATCH_FENCE_VERSION });
    expect(created.json().activatedByUserId).toBe(tenant.users.ADMIN);
    expect(created.json().state.liveDispatchActivated).toBe(true);
    // The attestation is stored and echoed back verbatim (plus its hash) so an
    // operator can read exactly what is in force. It is operator-typed
    // accountability text, never PHI and never a secret value.
    expect(created.json().attestationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.json().state.attestation).toBe(ATTESTATION);

    const row = await db.campaignLiveDispatchActivation.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(row.attestation).toBe(ATTESTATION);
    expect(row.revokedAt).toBeNull();

    const audits = await db.auditEvent.findMany({ where: { tenantId: tenant.id, action: 'campaign.live_dispatch.activated' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBe(tenant.users.ADMIN);
    expect(audits[0].resourceId).toBe(row.id);
    expect(audits[0].metadata).toMatchObject({ channel: 'sms', fenceVersion: LIVE_DISPATCH_FENCE_VERSION });

    // Activation is per tenant AND per channel: nothing else moved.
    const status = await app.inject({ method: 'GET', url: '/v1/crm/provider-status', headers: headers(tenant, 'OWNER') });
    expect(status.json().activatedChannels).toEqual(['sms']);
    expect(status.json().liveCampaignDispatchActivated).toBe(true);
    expect(status.json().channelActivation.whatsapp.tenantActivated).toBe(false);

    const neighbour = await app.inject({ method: 'GET', url: '/v1/crm/provider-status', headers: headers(other, 'OWNER') });
    expect(neighbour.json().liveCampaignDispatchActivated).toBe(false);
    expect(neighbour.json().channelActivation.sms.blockingReasons).toEqual(['tenant_activation_missing']);
  });

  it('deactivates on request, audited, and only for OWNER/ADMIN', async () => {
    setLiveSmsCreds();
    const tenant = await makeTenant();
    await app.inject({
      method: 'POST', url: '/v1/crm/live-dispatch-activation', headers: headers(tenant, 'OWNER'),
      payload: { channel: 'sms', attestation: ATTESTATION, confirmLiveSubmissionToRealRecipients: true, fenceVersion: LIVE_DISPATCH_FENCE_VERSION },
    });

    const denied = await app.inject({ method: 'DELETE', url: '/v1/crm/live-dispatch-activation/sms', headers: headers(tenant, 'MANAGER') });
    expect(denied.statusCode).toBe(403);

    const revoked = await app.inject({
      method: 'DELETE', url: '/v1/crm/live-dispatch-activation/sms', headers: headers(tenant, 'OWNER'),
      payload: { reason: 'pausing outreach' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ channel: 'sms', revoked: true, alreadyInactive: false });

    const status = await app.inject({ method: 'GET', url: '/v1/crm/provider-status', headers: headers(tenant, 'OWNER') });
    expect(status.json().liveCampaignDispatchActivated).toBe(false);
    expect(status.json().channelActivation.sms.blockingReasons).toEqual(['tenant_activation_revoked']);

    const audits = await db.auditEvent.findMany({ where: { tenantId: tenant.id, action: 'campaign.live_dispatch.deactivated' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ channel: 'sms', reason: 'pausing outreach' });
  });

  it('exposes the per-channel activation state to a campaign:read caller', async () => {
    setLiveSmsCreds();
    const tenant = await makeTenant();
    const res = await app.inject({ method: 'GET', url: '/v1/crm/live-dispatch-activation', headers: headers(tenant, 'OWNER') });
    expect(res.statusCode).toBe(200);
    expect(res.json().fenceVersion).toBe(LIVE_DISPATCH_FENCE_VERSION);
    expect(res.json().eligibleChannels).toEqual(['sms', 'email', 'whatsapp']);
    expect(res.json().channels.every((c: { liveDispatchActivated: boolean }) => c.liveDispatchActivated === false)).toBe(true);

    const auditor = await app.inject({ method: 'GET', url: '/v1/crm/live-dispatch-activation', headers: headers(tenant, 'AUDITOR') });
    expect(auditor.statusCode).toBe(403);
    expect(auditor.json()).toMatchObject({ error: 'insufficient_permission', permission: 'campaign:read' });
  });
});
