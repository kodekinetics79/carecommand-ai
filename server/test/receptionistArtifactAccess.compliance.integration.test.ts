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

let app: FastifyInstance;
const tenantIds: string[] = [];
const phoneFor = (id: string) => `+1${(BigInt(`0x${id.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

type Role = 'ADMIN' | 'MANAGER' | 'BILLING' | 'FRONT_DESK';

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `receptionist-rbac-${id.slice(0, 6)}`, slug: `rrbac-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({
    data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' },
  });
  const users = {} as Record<Role, string>;
  for (const role of ['ADMIN', 'MANAGER', 'BILLING', 'FRONT_DESK'] as const) {
    const user = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role}-${id.slice(0, 8)}@receptionist-rbac.test`, displayName: role },
    });
    users[role] = user.id;
  }
  const clinic = await db.receptionistClinic.create({
    data: { tenantId: id, name: 'Least Privilege Clinic', phone: phoneFor(id) },
  });
  const call = await db.receptionistCallLog.create({
    data: {
      tenantId: id,
      clinicId: clinic.id,
      callerPhone: '+15555550123',
      transcriptSummary: 'Caller requested a routine appointment.',
      recordingUrl: 'https://recordings.example.test/protected-object',
      outcome: 'BOOKED',
    },
  });
  const outboundCampaign = await db.receptionistOutboundCampaign.create({
    data: {
      tenantId: id,
      clinicId: clinic.id,
      name: 'Protected outbound campaign',
      script: 'Schedule a routine visit.',
    },
  });
  const outboundCall = await db.receptionistCallLog.create({
    data: {
      tenantId: id,
      clinicId: clinic.id,
      outboundCampaignId: outboundCampaign.id,
      callerPhone: '+15555550999',
      transcriptSummary: 'Outbound call reached the patient.',
      recordingUrl: 'https://recordings.example.test/protected-outbound-object',
      outcome: 'BOOKED',
    },
  });
  return {
    id,
    users,
    clinicId: clinic.id,
    callId: call.id,
    outboundCampaignId: outboundCampaign.id,
    outboundCallId: outboundCall.id,
  };
}

const token = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
const auth = (tenantId: string, userId: string) => ({ authorization: `Bearer ${token(tenantId, userId)}` });

async function override(tenantId: string, name: string, permissions: string[]) {
  await db.roleDefinition.upsert({
    where: { tenantId_name: { tenantId, name } },
    update: { permissions },
    create: { tenantId, name, description: `${name} test override`, permissions },
  });
}

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('AI receptionist call-artifact least privilege', () => {
  it('allows front desk to read call artifacts but redacts provider recording URLs', async () => {
    const tenant = await makeTenant();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/receptionist/call-logs',
      headers: auth(tenant.id, tenant.users.FRONT_DESK),
    });
    expect(response.statusCode).toBe(200);
    const row = (response.json().data as Array<Record<string, unknown>>).find(item => item.id === tenant.callId);
    expect(row?.transcriptSummary).toBe('Caller requested a routine appointment.');
    expect(row?.recordingAvailable).toBe(true);
    expect(row?.recordingUrl).toBeNull();
  });

  it('discloses recording URLs only to a role with the separate recording permission and audits the read', async () => {
    const tenant = await makeTenant();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/receptionist/call-logs/${tenant.callId}`,
      headers: auth(tenant.id, tenant.users.ADMIN),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().recordingUrl).toBe('https://recordings.example.test/protected-object');
    const event = await db.auditEvent.findFirst({
      where: { tenantId: tenant.id, actorUserId: tenant.users.ADMIN, action: 'receptionistCallLog.read', resourceId: tenant.callId },
    });
    expect(event).not.toBeNull();
    expect(event?.metadata).toMatchObject({ recordingDisclosed: true });
  });

  it('denies roles without call-artifact access and records a PHI-free security audit event', async () => {
    const tenant = await makeTenant();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/receptionist/call-logs',
      headers: auth(tenant.id, tenant.users.BILLING),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().permission).toBe('receptionist:call-artifacts:read');
    const event = await db.auditEvent.findFirst({
      where: { tenantId: tenant.id, actorUserId: tenant.users.BILLING, action: 'receptionist.access.denied' },
    });
    expect(event).not.toBeNull();
    expect(JSON.stringify(event?.metadata)).not.toContain('+1555');
    expect(JSON.stringify(event?.metadata)).not.toContain('recordings.example.test');
  });

  it('honors tenant RoleDefinition grants and revocations for receptionist-specific permissions', async () => {
    const tenant = await makeTenant();
    await override(tenant.id, 'Billing', ['receptionist:call-artifacts:read', 'receptionist:recordings:read']);
    const granted = await app.inject({
      method: 'GET',
      url: `/v1/receptionist/call-logs/${tenant.callId}`,
      headers: auth(tenant.id, tenant.users.BILLING),
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().recordingUrl).toBe('https://recordings.example.test/protected-object');

    await override(tenant.id, 'Admin', ['receptionist:call-artifacts:read']);
    const redacted = await app.inject({
      method: 'GET',
      url: `/v1/receptionist/call-logs/${tenant.callId}`,
      headers: auth(tenant.id, tenant.users.ADMIN),
    });
    expect(redacted.statusCode).toBe(200);
    expect(redacted.json().recordingUrl).toBeNull();

    const mutation = await app.inject({
      method: 'PATCH',
      url: `/v1/receptionist/clinics/${tenant.clinicId}`,
      headers: auth(tenant.id, tenant.users.ADMIN),
      payload: { name: 'Renamed by a read-only role' },
    });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json().permission).toBe('receptionist:manage');
  });

  it('preserves tenant isolation on call detail lookup', async () => {
    const owner = await makeTenant();
    const other = await makeTenant();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/receptionist/call-logs/${owner.callId}`,
      headers: auth(other.id, other.users.ADMIN),
    });
    expect(response.statusCode).toBe(404);
  });

  it('applies the same permission, recording redaction, and audit policy to outbound campaign call history', async () => {
    const tenant = await makeTenant();
    const frontDesk = await app.inject({
      method: 'GET',
      url: `/v1/receptionist/outbound-campaigns/${tenant.outboundCampaignId}/call-logs`,
      headers: auth(tenant.id, tenant.users.FRONT_DESK),
    });
    expect(frontDesk.statusCode).toBe(200);
    const redacted = (frontDesk.json() as Array<Record<string, unknown>>).find(row => row.id === tenant.outboundCallId);
    expect(redacted?.recordingAvailable).toBe(true);
    expect(redacted?.recordingUrl).toBeNull();

    const admin = await app.inject({
      method: 'GET',
      url: `/v1/receptionist/outbound-campaigns/${tenant.outboundCampaignId}/call-logs`,
      headers: auth(tenant.id, tenant.users.ADMIN),
    });
    expect(admin.statusCode).toBe(200);
    const disclosed = (admin.json() as Array<Record<string, unknown>>).find(row => row.id === tenant.outboundCallId);
    expect(disclosed?.recordingUrl).toBe('https://recordings.example.test/protected-outbound-object');

    const denied = await app.inject({
      method: 'GET',
      url: `/v1/receptionist/outbound-campaigns/${tenant.outboundCampaignId}/call-logs`,
      headers: auth(tenant.id, tenant.users.BILLING),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().permission).toBe('receptionist:call-artifacts:read');

    const readAudit = await db.auditEvent.findFirst({
      where: {
        tenantId: tenant.id,
        actorUserId: tenant.users.ADMIN,
        action: 'receptionistCallLog.outboundListRead',
        resourceId: tenant.outboundCampaignId,
      },
    });
    expect(readAudit?.metadata).toMatchObject({ recordingsDisclosed: true });
  });

  it('guards every outbound read surface that can return contact or collected patient data', async () => {
    const tenant = await makeTenant();
    const protectedUrls = [
      `/v1/receptionist/outbound-campaigns/${tenant.outboundCampaignId}`,
      `/v1/receptionist/outbound-campaigns/${tenant.outboundCampaignId}/targets`,
      '/v1/receptionist/booking-requests',
      '/v1/receptionist/opt-outs',
    ];

    for (const url of protectedUrls) {
      const denied = await app.inject({
        method: 'GET',
        url,
        headers: auth(tenant.id, tenant.users.BILLING),
      });
      expect(denied.statusCode, url).toBe(403);
      expect(denied.json().permission, url).toBe('receptionist:call-artifacts:read');

      const allowed = await app.inject({
        method: 'GET',
        url,
        headers: auth(tenant.id, tenant.users.FRONT_DESK),
      });
      expect(allowed.statusCode, url).toBe(200);
    }
  });
});
