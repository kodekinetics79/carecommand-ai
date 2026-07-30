import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

type Role = 'OWNER' | 'MANAGER' | 'BILLING';
type TenantFixture = { id: string; users: Record<Role, string>; branchId: string };
const tenantIds: string[] = [];
let app: FastifyInstance;
const originalRetell = { apiKey: env.RETELL_API_KEY, baseUrl: env.RETELL_BASE_URL };
const migrationSql = readFileSync(new URL('../../prisma/migrations/20260730143000_receptionist_configuration_integrity/migration.sql', import.meta.url), 'utf8');
const migrationPreflight = migrationSql.match(/DO \$preflight\$[\s\S]*?\$preflight\$;/)?.[0];
const migrationCanonicalization = migrationSql.match(/UPDATE "ReceptionistClinic" c[\s\S]*?;(?=\n\nALTER TABLE "ReceptionistClinic")/)?.[0];

const phone = () => `+1${(BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

async function tenant(): Promise<TenantFixture> {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Receptionist config ${id.slice(0, 8)}`, slug: `receptionist-config-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const users = {} as Record<Role, string>;
  for (const role of ['OWNER', 'MANAGER', 'BILLING'] as const) {
    const row = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role.toLowerCase()}-${id.slice(0, 8)}@config.test`, displayName: role },
      select: { id: true },
    });
    users[role] = row.id;
  }
  const branch = await db.branch.create({
    data: { tenantId: id, name: 'Main scheduling branch', location: '1 Main Street', timezone: 'America/New_York', active: true },
    select: { id: true },
  });
  return { id, users, branchId: branch.id };
}

function auth(t: TenantFixture, role: Role) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: t.users[role], tenantId: t.id, role, type: 'access' })}` };
}

async function createClinic(t: TenantFixture, input: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST', url: '/v1/receptionist/clinics', headers: auth(t, 'OWNER'),
    payload: { name: `Clinic ${randomUUID().slice(0, 8)}`, phone: phone(), ...input },
  });
}

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  vi.unstubAllGlobals();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app.close();
  await db.$disconnect();
});

describe('AI receptionist trusted configuration', () => {
  it('migration rejects alphabetic/extensions before canonicalization and safely normalizes formatting-only legacy values', async () => {
    expect(migrationPreflight).toBeTruthy();
    expect(migrationCanonicalization).toBeTruthy();
    const t = await tenant();
    for (const malformed of ['+1 (212) 555-0100 ext 4', '+1212ABC5550100']) {
      await expect(db.$transaction(async tx => {
        await tx.$executeRawUnsafe('ALTER TABLE "ReceptionistClinic" DROP CONSTRAINT "ReceptionistClinic_phone_e164_check"');
        await tx.receptionistClinic.create({ data: { tenantId: t.id, name: `Malformed ${randomUUID()}`, phone: malformed } });
        await tx.$executeRawUnsafe(migrationPreflight!);
      })).rejects.toThrow(/receptionist_destination_invalid_e164/);
    }

    const canonical = phone();
    const formatted = `+${canonical.slice(1, 2)} (${canonical.slice(2, 5)}) ${canonical.slice(5, 8)}-${canonical.slice(8)}`;
    await expect(db.$transaction(async tx => {
      await tx.$executeRawUnsafe('ALTER TABLE "ReceptionistClinic" DROP CONSTRAINT "ReceptionistClinic_phone_e164_check"');
      const row = await tx.receptionistClinic.create({ data: { tenantId: t.id, name: `Formatted ${randomUUID()}`, phone: formatted } });
      await tx.$executeRawUnsafe(migrationPreflight!);
      await tx.$executeRawUnsafe(migrationCanonicalization!);
      expect((await tx.receptionistClinic.findUniqueOrThrow({ where: { id: row.id } })).phone).toBe(canonical);
      throw new Error('ROLLBACK_FORMATTED_MIGRATION_PROBE');
    })).rejects.toThrow('ROLLBACK_FORMATTED_MIGRATION_PROBE');
  });

  it('enforces management RBAC and validates canonical phones, IANA timezones, and structured hours', async () => {
    const t = await tenant();
    const denied = await app.inject({
      method: 'POST', url: '/v1/receptionist/clinics', headers: auth(t, 'BILLING'),
      payload: { name: 'Denied clinic', phone: phone() },
    });
    expect(denied.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/receptionist/clinics', headers: auth(t, 'BILLING') })).statusCode).toBe(403);

    await db.roleDefinition.upsert({
      where: { tenantId_name: { tenantId: t.id, name: 'Billing' } },
      create: { tenantId: t.id, name: 'Billing', description: 'Test override', permissions: ['receptionist:manage'] },
      update: { permissions: ['receptionist:manage'] },
    });
    expect((await app.inject({ method: 'GET', url: '/v1/receptionist/clinics', headers: auth(t, 'BILLING') })).statusCode).toBe(200);
    await db.roleDefinition.update({ where: { tenantId_name: { tenantId: t.id, name: 'Billing' } }, data: { permissions: ['settings:read'] } });
    expect((await app.inject({ method: 'GET', url: '/v1/receptionist/clinics', headers: auth(t, 'BILLING') })).statusCode).toBe(403);

    const invalid = await createClinic(t, {
      timezone: 'Eastern Time',
      humanFallbackNumber: '555-123-4567',
      workingHours: { monday: { open: true, start: '17:00', end: '09:00' } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(await db.receptionistClinic.count({ where: { tenantId: t.id } })).toBe(0);

    const valid = await app.inject({
      method: 'POST', url: '/v1/receptionist/clinics', headers: auth(t, 'MANAGER'),
      payload: {
        name: 'Valid clinic', phone: '+1 (212) 555-0100', timezone: 'America/New_York',
        humanFallbackNumber: '+1 (212) 555-0199',
        workingHours: { monday: { open: true, start: '09:00', end: '17:00' }, sunday: { open: false } },
      },
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json()).toMatchObject({ phone: '+12125550100', humanFallbackNumber: '+12125550199' });
  });

  it('allows only one active inbound destination globally under concurrent cross-tenant creates and reactivation', async () => {
    const [a, b] = await Promise.all([tenant(), tenant()]);
    const destination = phone();
    const [ra, rb] = await Promise.all([
      createClinic(a, { name: 'Race A', phone: destination }),
      createClinic(b, { name: 'Race B', phone: destination }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([201, 409]);
    expect([ra, rb].find(response => response.statusCode === 409)?.json().message).toContain('already assigned');
    expect(await db.receptionistClinic.count({ where: { phone: destination, active: true } })).toBe(1);

    const winner = ra.statusCode === 201 ? a : b;
    const loser = winner.id === a.id ? b : a;
    const inactive = await createClinic(loser, { name: 'Inactive duplicate', phone: destination, active: false });
    expect(inactive.statusCode).toBe(201);
    const reactivated = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/clinics/${inactive.json().id}`, headers: auth(loser, 'OWNER'), payload: { active: true },
    });
    expect(reactivated.statusCode).toBe(409);
    expect(reactivated.json().message).toContain('already assigned');
  });

  it('requires an explicit active same-tenant scheduling branch and rejects malformed location settings', async () => {
    const [owner, foreign] = await Promise.all([tenant(), tenant()]);
    const clinicResponse = await createClinic(owner, { name: 'Mapped clinic' });
    const clinicId = clinicResponse.json().id as string;
    const base = { clinicId, name: 'Downtown', address: '1 Main Street', timezone: 'America/New_York' };

    const missing = await app.inject({ method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'OWNER'), payload: base });
    expect(missing.statusCode).toBe(400);
    const crossTenant = await app.inject({ method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'OWNER'), payload: { ...base, branchId: foreign.branchId } });
    expect(crossTenant.statusCode).toBe(400);

    const inactiveBranch = await db.branch.create({ data: { tenantId: owner.id, name: 'Closed', location: 'Closed', active: false } });
    const inactive = await app.inject({ method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'OWNER'), payload: { ...base, branchId: inactiveBranch.id } });
    expect(inactive.statusCode).toBe(400);

    const invalidHours = await app.inject({
      method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'OWNER'),
      payload: { ...base, branchId: owner.branchId, phone: '2125550100', workingHours: { monday: { open: true, start: '9am', end: '5pm' } } },
    });
    expect(invalidHours.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST', url: '/v1/receptionist/locations', headers: auth(owner, 'MANAGER'),
      payload: { ...base, branchId: owner.branchId, phone: '+1 212 555 0111', workingHours: { monday: { open: true, start: '09:00', end: '17:00' } } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ branchId: owner.branchId, phone: '+12125550111', active: true });

    const otherBranch = await db.branch.create({ data: { tenantId: owner.id, name: 'Other clinic branch', location: '2 Other Street', active: true } });
    const unmappedOutbound = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: auth(owner, 'OWNER'),
      payload: { clinicId, name: 'Unsafe branch campaign', script: 'Call the patient.', defaultBranchId: otherBranch.id },
    });
    expect(unmappedOutbound.statusCode).toBe(409);
    expect(unmappedOutbound.json().message).toContain('branch_not_mapped_to_clinic');
    const mappedOutbound = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: auth(owner, 'OWNER'),
      payload: { clinicId, name: 'Mapped branch campaign', script: 'Call the patient.', defaultBranchId: owner.branchId },
    });
    expect(mappedOutbound.statusCode).toBe(201);

    await expect(db.receptionistLocation.create({
      data: { tenantId: owner.id, clinicId, branchId: foreign.branchId, name: 'DB bypass', address: 'Foreign' },
    })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.receptionistClinic.create({
      data: { tenantId: owner.id, name: 'Invalid DB phone', phone: '2125550198' },
    })).rejects.toThrow();
    expect(await db.receptionistClinic.count({ where: { tenantId: owner.id, name: 'Invalid DB phone' } })).toBe(0);
  });

  it('rolls the configuration write back when its append-only audit insert fails', async () => {
    const t = await tenant();
    const actorId = t.users.OWNER;
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION receptionist_config_audit_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW."actorUserId" = '${actorId}'::uuid AND NEW.action = 'receptionistClinic.created' THEN
          RAISE EXCEPTION 'injected receptionist audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER receptionist_config_audit_failure_trigger
      BEFORE INSERT ON "AuditEvent"
      FOR EACH ROW EXECUTE FUNCTION receptionist_config_audit_failure();
    `);
    try {
      const response = await createClinic(t, { name: 'Must roll back' });
      expect(response.statusCode).toBe(500);
      expect(await db.receptionistClinic.count({ where: { tenantId: t.id, name: 'Must roll back' } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS receptionist_config_audit_failure_trigger ON "AuditEvent"; DROP FUNCTION IF EXISTS receptionist_config_audit_failure();');
    }
  });

  it('preserves clinic lineage instead of cascading away receptionist history', async () => {
    const t = await tenant();
    const clinicResponse = await createClinic(t, { name: 'History clinic' });
    const clinicId = clinicResponse.json().id as string;
    await db.receptionistAgent.create({ data: { tenantId: t.id, clinicId, name: 'Configured agent' } });
    const deleted = await app.inject({ method: 'DELETE', url: `/v1/receptionist/clinics/${clinicId}`, headers: auth(t, 'OWNER') });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().message).toContain('Deactivate');
    expect(await db.receptionistClinic.count({ where: { id: clinicId } })).toBe(1);
  });

  it('links and verifies one exact published provider deployment with durable safety evidence', async () => {
    const [owner, foreign] = await Promise.all([tenant(), tenant()]);
    const ownerClinic = (await createClinic(owner, { name: 'Provider-ready clinic' })).json().id as string;
    const foreignClinic = (await createClinic(foreign, { name: 'Foreign provider clinic' })).json().id as string;
    env.RETELL_API_KEY = 'real-provider-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';
    const providerPayload = {
      agent_id: 'agent_pilot_exact', version: 17, assigned_tags: ['prod', 'production'], is_published: true,
      voice_id: 'voice_safe', language: 'en-US',
      webhook_url: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
      webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
      data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true,
      response_engine: { type: 'retell-llm', llm_id: 'llm_safe', version: 3 },
      last_modification_timestamp: Date.now(),
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(providerPayload), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const created = await app.inject({
        method: 'POST', url: '/v1/receptionist/agents', headers: auth(owner, 'MANAGER'),
        payload: { clinicId: ownerClinic, name: 'Pilot Receptionist', providerAgentId: 'agent_pilot_exact', providerVersionTag: 'prod' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ providerStatus: 'UNVERIFIED', providerVersion: null });
      const agentId = created.json().id as string;

      const verified = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agentId}/verify-provider`, headers: auth(owner, 'OWNER') });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({
        providerStatus: 'VERIFIED', providerVersion: 17, providerPublished: true,
        providerVoiceId: 'voice_safe', providerLanguage: 'en-US', providerLastAttemptStatus: 'SUCCEEDED',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.retellai.com/get-agent/agent_pilot_exact?version=prod',
        expect.objectContaining({ headers: { Authorization: 'Bearer real-provider-key' } }),
      );
      const stored = await db.receptionistAgent.findUniqueOrThrow({ where: { id: agentId } });
      expect(stored.providerFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.providerVerifiedRevision).toBe(stored.providerConfigRevision);
      expect(stored.providerVerificationExpiresAt!.getTime()).toBeGreaterThan(stored.providerVerifiedAt!.getTime());

      const auditRows = await db.auditEvent.findMany({ where: { tenantId: owner.id, resourceId: agentId }, orderBy: { occurredAt: 'asc' } });
      expect(auditRows.map(row => row.action)).toEqual(['receptionistAgent.created', 'receptionistAgent.providerVerified']);
      expect(JSON.stringify(auditRows)).not.toContain('real-provider-key');

      const foreignAgent = await app.inject({
        method: 'POST', url: '/v1/receptionist/agents', headers: auth(foreign, 'OWNER'),
        payload: { clinicId: foreignClinic, name: 'Duplicate deployment', providerAgentId: 'agent_pilot_exact', providerVersionTag: 'production', active: false },
      });
      expect(foreignAgent.statusCode).toBe(201);
      const duplicateVerify = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${foreignAgent.json().id}/verify-provider`, headers: auth(foreign, 'OWNER') });
      expect(duplicateVerify.statusCode).toBe(200);
      const duplicateActivation = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/agents/${foreignAgent.json().id}`, headers: auth(foreign, 'OWNER'), payload: { active: true },
      });
      expect(duplicateActivation.statusCode).toBe(409);
      expect(duplicateActivation.json().message).toContain('already assigned');

      const crossTenantCampaign = await app.inject({
        method: 'POST', url: '/v1/receptionist/campaigns', headers: auth(owner, 'OWNER'),
        payload: {
          clinicId: ownerClinic, agentId: foreignAgent.json().id, name: 'Cross tenant campaign', status: 'ACTIVE',
          offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Would you like an appointment?', appointmentType: 'Consultation',
        },
      });
      expect(crossTenantCampaign.statusCode).toBe(409);

      await expect(db.receptionistCampaign.create({
        data: {
          tenantId: owner.id, clinicId: ownerClinic, agentId: foreignAgent.json().id,
          name: 'Database bypass', offerTitle: 'A', offerDescription: 'B', offerScript: 'C', appointmentType: 'D', eligibleLocationIds: [],
        },
      })).rejects.toMatchObject({ code: 'P2003' });

      const activeCampaign = await app.inject({
        method: 'POST', url: '/v1/receptionist/campaigns', headers: auth(owner, 'OWNER'),
        payload: {
          clinicId: ownerClinic, agentId, name: 'Verified deployment campaign', status: 'ACTIVE',
          offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Would you like an appointment?', appointmentType: 'Consultation',
        },
      });
      expect(activeCampaign.statusCode).toBe(201);
      const deactivateReferenced = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/agents/${agentId}`, headers: auth(owner, 'OWNER'), payload: { active: false },
      });
      expect(deactivateReferenced.statusCode).toBe(409);
      const deleteReferenced = await app.inject({ method: 'DELETE', url: `/v1/receptionist/agents/${agentId}`, headers: auth(owner, 'OWNER') });
      expect(deleteReferenced.statusCode).toBe(409);

      providerPayload.version = 18;
      const driftBlocked = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agentId}/verify-provider`, headers: auth(owner, 'OWNER') });
      expect(driftBlocked.statusCode).toBe(409);
      expect(driftBlocked.json().message).toContain('drift');
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: agentId } })).toMatchObject({
        providerVersion: 17,
        providerStatus: 'VERIFIED',
        providerLastAttemptStatus: 'FAILED',
        providerLastErrorCode: 'provider_deployment_drift',
      });
      expect(await db.auditEvent.count({
        where: { tenantId: owner.id, resourceId: agentId, action: 'receptionistAgent.providerDeploymentDriftDetected' },
      })).toBe(1);

      const paused = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/campaigns/${activeCampaign.json().id}`, headers: auth(owner, 'OWNER'), payload: { status: 'PAUSED' },
      });
      expect(paused.statusCode).toBe(200);
      const approvedUpdate = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agentId}/verify-provider`, headers: auth(owner, 'OWNER') });
      expect(approvedUpdate.statusCode).toBe(200);
      expect(approvedUpdate.json()).toMatchObject({ providerVersion: 18, providerStatus: 'VERIFIED' });
      expect(await db.auditEvent.count({ where: { tenantId: owner.id, resourceId: agentId, action: 'receptionistAgent.providerDeploymentUpdated' } })).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_BASE_URL = originalRetell.baseUrl;
    }
  });

  it('preserves a verified snapshot on transient probe failure and rejects stale concurrent verification', async () => {
    const t = await tenant();
    const clinicId = (await createClinic(t, { name: 'Concurrency clinic' })).json().id as string;
    const agent = await db.receptionistAgent.create({
      data: {
        tenantId: t.id, clinicId, name: 'Already verified', providerAgentId: 'agent_original', providerVersionTag: 'prod',
        providerVersion: 4, providerStatus: 'VERIFIED', providerPublished: true, providerAssignedTags: ['prod'],
        providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
        providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'], providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
        providerResponseEngineType: 'retell-llm', providerResponseEngineId: 'llm-original',
        providerFingerprint: 'a'.repeat(64), providerConfigRevision: 1, providerVerifiedRevision: 1,
        providerVerifiedAt: new Date(), providerVerificationExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    env.RETELL_API_KEY = 'real-provider-key';
    env.RETELL_BASE_URL = 'https://api.retellai.com';

    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('temporary provider outage', { status: 503 })));
      const unavailable = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agent.id}/verify-provider`, headers: auth(t, 'OWNER') });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ providerStatus: 'VERIFIED', providerVersion: 4, providerLastAttemptStatus: 'FAILED', providerLastErrorCode: 'provider_unavailable' });

      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      vi.stubGlobal('fetch', vi.fn(async () => {
        await pending;
        return new Response(JSON.stringify({
          agent_id: 'agent_original', version: 5, assigned_tags: ['prod'], is_published: true,
          voice_id: 'voice', language: 'en-US', webhook_url: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
          webhook_events: ['call_started', 'call_ended', 'call_analyzed'], data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true,
          response_engine: { type: 'retell-llm', llm_id: 'llm' },
        }), { status: 200 });
      }));
      const verifyRequest = app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agent.id}/verify-provider`, headers: auth(t, 'OWNER') });
      await new Promise(resolve => setTimeout(resolve, 20));
      const changed = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/agents/${agent.id}`, headers: auth(t, 'OWNER'),
        payload: { providerAgentId: 'agent_relinked' },
      });
      expect(changed.statusCode).toBe(200);
      release();
      const stale = await verifyRequest;
      expect(stale.statusCode).toBe(409);
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({
        providerAgentId: 'agent_relinked', providerStatus: 'UNVERIFIED', providerVersion: null, providerConfigRevision: 2,
      });
    } finally {
      vi.unstubAllGlobals();
      env.RETELL_API_KEY = originalRetell.apiKey;
      env.RETELL_BASE_URL = originalRetell.baseUrl;
    }
  });

  it('blocks Studio and outbound activation for unverified or stale agents', async () => {
    const t = await tenant();
    const clinicId = (await createClinic(t, { name: 'Activation guard clinic' })).json().id as string;
    const unverified = await db.receptionistAgent.create({
      data: { tenantId: t.id, clinicId, name: 'Unverified agent', providerAgentId: `agent_${randomUUID().replaceAll('-', '')}` },
    });
    const studio = await app.inject({
      method: 'POST', url: '/v1/receptionist/campaigns', headers: auth(t, 'OWNER'),
      payload: {
        clinicId, agentId: unverified.id, name: 'Unsafe Studio activation', status: 'ACTIVE',
        offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Schedule now', appointmentType: 'Consultation',
      },
    });
    expect(studio.statusCode).toBe(409);
    expect(studio.json().message).toContain('agent_unverified');

    const outbound = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: auth(t, 'OWNER'),
      payload: { clinicId, agentId: unverified.id, name: 'Unsafe outbound activation', script: 'Call the patient.' },
    });
    expect(outbound.statusCode).toBe(201);
    const run = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/outbound-campaigns/${outbound.json().id}`, headers: auth(t, 'OWNER'), payload: { status: 'RUNNING' },
    });
    expect(run.statusCode).toBe(409);
    expect(run.json().message).toContain('agent_unverified');

    const now = new Date();
    await db.receptionistAgent.update({ where: { id: unverified.id }, data: {
      providerVersion: 2, providerStatus: 'VERIFIED', providerPublished: true, providerAssignedTags: ['prod'],
      providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
      providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'], providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
      providerResponseEngineType: 'retell-llm', providerResponseEngineId: 'llm-stale',
      providerFingerprint: 'd'.repeat(64), providerVerifiedRevision: 1,
      providerVerifiedAt: new Date(now.getTime() - 48 * 60 * 60 * 1_000),
      providerVerificationExpiresAt: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
    } });
    const staleRun = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/outbound-campaigns/${outbound.json().id}`, headers: auth(t, 'OWNER'), payload: { status: 'RUNNING' },
    });
    expect(staleRun.statusCode).toBe(409);
    expect(staleRun.json().message).toContain('agent_verification_stale');
  });

  it('rolls provider verification state back when its mandatory audit insert fails', async () => {
    const t = await tenant();
    const clinicId = (await createClinic(t, { name: 'Provider audit clinic' })).json().id as string;
    const agent = await db.receptionistAgent.create({
      data: { tenantId: t.id, clinicId, name: 'Audit-bound agent', providerAgentId: 'agent_audit_bound', providerVersionTag: 'prod' },
    });
    const actorId = t.users.OWNER;
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION receptionist_agent_audit_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW."actorUserId" = '${actorId}'::uuid AND NEW.action = 'receptionistAgent.providerVerified' THEN
          RAISE EXCEPTION 'injected receptionist agent audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER receptionist_agent_audit_failure_trigger
      BEFORE INSERT ON "AuditEvent"
      FOR EACH ROW EXECUTE FUNCTION receptionist_agent_audit_failure();
    `);
    env.RETELL_API_KEY = 'real-provider-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      agent_id: 'agent_audit_bound', version: 8, assigned_tags: ['prod'], is_published: true,
      voice_id: 'voice', language: 'en-US',
      webhook_url: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
      webhook_events: ['call_started', 'call_ended', 'call_analyzed'], data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true,
      response_engine: { type: 'retell-llm', llm_id: 'llm' },
    }), { status: 200 })));
    try {
      const response = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agent.id}/verify-provider`, headers: auth(t, 'OWNER') });
      expect(response.statusCode).toBe(500);
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({
        providerStatus: 'UNVERIFIED', providerVersion: null, providerLastAttemptStatus: 'NEVER',
      });
      expect(await db.auditEvent.count({ where: { tenantId: t.id, resourceId: agent.id, action: 'receptionistAgent.providerVerified' } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS receptionist_agent_audit_failure_trigger ON "AuditEvent"; DROP FUNCTION IF EXISTS receptionist_agent_audit_failure();');
      vi.unstubAllGlobals();
      env.RETELL_API_KEY = originalRetell.apiKey;
    }
  });
});
