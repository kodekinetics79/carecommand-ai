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
const { compileIntakeContract } = await import('../modules/receptionist/intakeContract');

type Role = 'OWNER' | 'MANAGER' | 'BILLING';
type TenantFixture = { id: string; users: Record<Role, string>; branchId: string };
const tenantIds: string[] = [];
let app: FastifyInstance;
const originalRetell = { apiKey: env.RETELL_API_KEY, baseUrl: env.RETELL_BASE_URL };
const migrationSql = readFileSync(new URL('../../prisma/migrations/20260730143000_receptionist_configuration_integrity/migration.sql', import.meta.url), 'utf8');
const migrationPreflight = migrationSql.match(/DO \$preflight\$[\s\S]*?\$preflight\$;/)?.[0];
const migrationCanonicalization = migrationSql.match(/UPDATE "ReceptionistClinic" c[\s\S]*?;(?=\n\nALTER TABLE "ReceptionistClinic")/)?.[0];
const intakeMigrationSql = readFileSync(new URL('../../prisma/migrations/20260730200000_receptionist_intake_contract/migration.sql', import.meta.url), 'utf8');
const intakeLegacyPause = intakeMigrationSql.match(/WITH paused AS \([\s\S]*?FROM paused;/)?.[0];

const phone = () => `+1${(BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

function quietWindowOutsideNow(timezone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const now = (Number(parts.find(part => part.type === 'hour')?.value ?? 0) % 24) * 60
    + Number(parts.find(part => part.type === 'minute')?.value ?? 0);
  const format = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return { quietHoursStart: format((now + 60) % 1440), quietHoursEnd: format((now + 61) % 1440) };
}

function listedRetellAgent(agentId: string, version: number, tags: string[] = ['prod']) {
  return {
    has_more: false,
    items: [{
      agent_id: agentId, agent_name: 'Fixture agent', channel: 'voice', user_modified_timestamp: Date.now(),
      tags: Object.fromEntries(tags.map(tag => [tag, { version, dynamic_variables: {} }])),
    }],
  };
}

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

  it('invalidates draft location semantics and blocks active location or intake-parent drift', async () => {
    const t = await tenant();
    const clinicId = (await createClinic(t, { name: 'Location-bound clinic' })).json().id as string;
    const draft = await app.inject({
      method: 'POST', url: '/v1/receptionist/campaigns', headers: auth(t, 'OWNER'),
      payload: {
        clinicId, name: 'Location-bound campaign', status: 'DRAFT', offerTitle: 'Appointment',
        offerDescription: 'Schedule care', offerScript: 'Schedule now', appointmentType: 'Consultation',
      },
    });
    expect(draft.statusCode).toBe(201);
    const location = await app.inject({
      method: 'POST', url: '/v1/receptionist/locations', headers: auth(t, 'OWNER'),
      payload: { clinicId, branchId: t.branchId, name: 'North office', address: '10 North Street' },
    });
    expect(location.statusCode).toBe(201);
    expect((await db.receptionistCampaign.findUniqueOrThrow({ where: { id: draft.json().id } })).intakeSchemaRevision).toBe(2);

    const field = await app.inject({
      method: 'POST', url: '/v1/receptionist/intake-fields', headers: auth(t, 'OWNER'),
      payload: {
        campaignId: draft.json().id, fieldType: 'CUSTOM_TEXT', label: 'Accessibility',
        aiQuestion: 'Do you need an accessibility accommodation?', required: false,
      },
    });
    expect(field.statusCode).toBe(201);
    const otherDraft = await app.inject({
      method: 'POST', url: '/v1/receptionist/campaigns', headers: auth(t, 'OWNER'),
      payload: {
        clinicId, name: 'Other draft', status: 'DRAFT', offerTitle: 'Appointment', offerDescription: 'Schedule care',
        offerScript: 'Schedule now', appointmentType: 'Consultation',
      },
    });
    await expect(db.$executeRaw`UPDATE "ReceptionistIntakeField" SET "campaignId" = ${otherDraft.json().id}::uuid WHERE id = ${field.json().id}::uuid`)
      .rejects.toThrow(/receptionist_intake_field_parent_immutable/);

    const current = await db.receptionistCampaign.findUniqueOrThrow({ where: { id: draft.json().id } });
    await db.receptionistCampaign.update({ where: { id: current.id }, data: {
      status: 'ACTIVE', intakeSchemaSnapshot: { testFixture: true }, intakeSchemaFingerprint: 'a'.repeat(64),
      intakeToolFingerprint: 'b'.repeat(64), intakeSchemaAttestedRevision: current.intakeSchemaRevision,
      intakeSchemaAttestedAt: new Date(), intakeSchemaProviderAgentId: 'agent_location_fixture', intakeSchemaProviderVersion: 1,
      intakeSchemaResponseEngineId: 'llm_location_fixture', intakeSchemaResponseEngineVersion: 1,
    } });
    const activeLocationDrift = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/locations/${location.json().id}`, headers: auth(t, 'OWNER'),
      payload: { name: 'Renamed active office' },
    });
    expect(activeLocationDrift.statusCode).toBe(409);
    expect(activeLocationDrift.json().message).toMatch(/Pause active campaigns/i);
    expect((await db.receptionistLocation.findUniqueOrThrow({ where: { id: location.json().id } })).name).toBe('North office');
  });

  it('rejects every partial provider and campaign attestation bundle through raw SQL', async () => {
    const t = await tenant();
    const clinicId = (await createClinic(t, { name: 'Attestation constraint clinic' })).json().id as string;
    const agent = await db.receptionistAgent.create({
      data: { tenantId: t.id, clinicId, name: 'Partial bundle probe' },
    });
    const campaign = await db.receptionistCampaign.create({
      data: {
        tenantId: t.id, clinicId, name: 'Partial attestation probe', offerTitle: 'Appointment',
        offerDescription: 'Schedule care', offerScript: 'Schedule now', appointmentType: 'Consultation',
        eligibleLocationIds: [],
      },
    });
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    const agentUpdates = [
      `"providerBookToolSchema" = '{}'::jsonb`,
      `"providerBookToolFingerprint" = '${hashA}'`,
      `"providerToolCallStrictMode" = true`,
      `"providerBookToolSchema" = '{}'::jsonb, "providerBookToolFingerprint" = '${hashA}', "providerToolCallStrictMode" = true, "providerResponseEngineType" = 'retell-llm', "providerResponseEngineId" = 'llm_partial', "providerResponseEngineVersion" = 1`,
      `"providerBookToolSchema" = '{}'::jsonb, "providerBookToolFingerprint" = '${hashA}', "providerToolCallStrictMode" = true, "providerResponseEngineType" = 'retell-llm', "providerResponseEngineId" = 'llm_partial', "providerResponseEngineVersion" = 1, "providerResponseEngineGraphFingerprint" = '${hashB}'`,
      `"providerBookToolSchema" = '{}'::jsonb, "providerEffectiveDynamicVariables" = 'null'::jsonb, "providerBookToolFingerprint" = '${hashA}', "providerToolCallStrictMode" = true, "providerResponseEngineType" = 'retell-llm', "providerResponseEngineId" = 'llm_partial', "providerResponseEngineVersion" = 1, "providerResponseEngineGraphFingerprint" = '${hashB}'`,
      `"providerBookToolSchema" = 'null'::jsonb, "providerBookToolFingerprint" = '${hashA}', "providerToolCallStrictMode" = true, "providerResponseEngineType" = 'retell-llm', "providerResponseEngineId" = 'llm_partial', "providerResponseEngineVersion" = 1, "providerResponseEngineGraphFingerprint" = '${hashB}'`,
      `"providerBookToolSchema" = '{}'::jsonb, "providerBookToolFingerprint" = '${hashA}', "providerToolCallStrictMode" = true, "providerResponseEngineId" = 'llm_partial', "providerResponseEngineVersion" = 1, "providerResponseEngineGraphFingerprint" = '${hashB}'`,
    ];
    for (const update of agentUpdates) {
      await expect(db.$executeRawUnsafe(`UPDATE "ReceptionistAgent" SET ${update} WHERE id = '${agent.id}'::uuid`))
        .rejects.toThrow(/ReceptionistAgent_provider_book_tool_shape_check/);
    }

    const completeCampaignFields = `
      "intakeSchemaFingerprint" = '${hashA}', "intakeToolFingerprint" = '${hashB}',
      "intakeSchemaAttestedRevision" = 1, "intakeSchemaAttestedAt" = '2026-07-30T00:00:00Z',
      "intakeSchemaProviderAgentId" = 'agent_partial', "intakeSchemaProviderVersion" = 1,
      "intakeSchemaResponseEngineId" = 'llm_partial'`;
    const campaignUpdates = [
      `"intakeSchemaSnapshot" = '{}'::jsonb`,
      `"intakeSchemaFingerprint" = '${hashA}'`,
      `"intakeSchemaProviderVersion" = 1`,
      `"intakeSchemaSnapshot" = '{}'::jsonb, ${completeCampaignFields}`,
      `"intakeSchemaSnapshot" = 'null'::jsonb, ${completeCampaignFields}, "intakeSchemaResponseEngineVersion" = 1`,
      `"intakeSchemaSnapshot" = '{}'::jsonb, "intakeSchemaFingerprint" = '${hashA}', "intakeToolFingerprint" = '${hashB}', "intakeSchemaAttestedRevision" = 2, "intakeSchemaAttestedAt" = '2026-07-30T00:00:00Z', "intakeSchemaProviderAgentId" = 'agent_partial', "intakeSchemaProviderVersion" = 1, "intakeSchemaResponseEngineId" = 'llm_partial', "intakeSchemaResponseEngineVersion" = 1`,
    ];
    for (const update of campaignUpdates) {
      await expect(db.$executeRawUnsafe(`UPDATE "ReceptionistCampaign" SET ${update} WHERE id = '${campaign.id}'::uuid`))
        .rejects.toThrow(/ReceptionistCampaign_intake_attestation_shape_check/);
    }
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
    let providerBookingTool = compileIntakeContract({
      campaignId: 'provider-contract', revision: 1, appointmentType: 'Consultation', eligibleLocations: [], fields: [],
      toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${ownerClinic}`,
    }).snapshot.bookAppointmentToolContract;
    const fetchMock = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? {
        llm_id: 'llm_safe', version: 3, is_published: true, tool_call_strict_mode: true,
        general_tools: [providerBookingTool],
      }
      : String(url).includes('list-agents') ? listedRetellAgent('agent_pilot_exact', providerPayload.version as number, ['prod', 'production'])
        : providerPayload), { status: 200 }));
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
      expect(stored.providerResponseEngineGraphFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.providerBookToolFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.providerToolCallStrictMode).toBe(true);
      expect(stored.providerEffectiveDynamicVariables).toEqual({});
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

      const campaignDraft = await app.inject({
        method: 'POST', url: '/v1/receptionist/campaigns', headers: auth(owner, 'OWNER'),
        payload: {
          clinicId: ownerClinic, agentId, name: 'Verified deployment campaign', status: 'DRAFT',
          offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Would you like an appointment?', appointmentType: 'Consultation',
        },
      });
      expect(campaignDraft.statusCode).toBe(201);
      await expect(db.$executeRaw`UPDATE "ReceptionistCampaign" SET status = 'ACTIVE' WHERE id = ${campaignDraft.json().id}::uuid`)
        .rejects.toThrow(/ReceptionistCampaign_active_intake_attestation_check/);
      providerBookingTool = compileIntakeContract({
        campaignId: campaignDraft.json().id, revision: campaignDraft.json().intakeSchemaRevision,
        appointmentType: 'Consultation', eligibleLocations: [], fields: [],
        toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${ownerClinic}`,
      }).snapshot.bookAppointmentToolContract;
      const schemaVerified = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agentId}/verify-provider`, headers: auth(owner, 'OWNER') });
      expect(schemaVerified.statusCode).toBe(200);
      const activeCampaign = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/campaigns/${campaignDraft.json().id}`, headers: auth(owner, 'OWNER'), payload: { status: 'ACTIVE' },
      });
      expect(activeCampaign.statusCode).toBe(200);
      expect(activeCampaign.json()).toMatchObject({
        status: 'ACTIVE', intakeSchemaAttestedRevision: campaignDraft.json().intakeSchemaRevision,
        intakeSchemaProviderAgentId: 'agent_pilot_exact', intakeSchemaProviderVersion: 17,
      });
      expect(activeCampaign.json().intakeSchemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const duplicateActiveDeployment = await db.receptionistCampaign.create({
        data: {
          tenantId: owner.id, clinicId: ownerClinic, agentId, name: 'Ambiguous deployment duplicate',
          offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Schedule now',
          appointmentType: 'Consultation', eligibleLocationIds: [],
          intakeSchemaRevision: activeCampaign.json().intakeSchemaRevision,
          intakeSchemaSnapshot: activeCampaign.json().intakeSchemaSnapshot,
          intakeSchemaFingerprint: activeCampaign.json().intakeSchemaFingerprint,
          intakeToolFingerprint: activeCampaign.json().intakeToolFingerprint,
          intakeSchemaAttestedRevision: activeCampaign.json().intakeSchemaAttestedRevision,
          intakeSchemaAttestedAt: new Date(activeCampaign.json().intakeSchemaAttestedAt),
          intakeSchemaProviderAgentId: activeCampaign.json().intakeSchemaProviderAgentId,
          intakeSchemaProviderVersion: activeCampaign.json().intakeSchemaProviderVersion,
          intakeSchemaResponseEngineId: activeCampaign.json().intakeSchemaResponseEngineId,
          intakeSchemaResponseEngineVersion: activeCampaign.json().intakeSchemaResponseEngineVersion,
        },
      });
      await expect(db.receptionistCampaign.update({ where: { id: duplicateActiveDeployment.id }, data: { status: 'ACTIVE' } }))
        .rejects.toMatchObject({ code: 'P2002' });
      expect(intakeLegacyPause).toBeTruthy();
      await expect(db.$transaction(async tx => {
        await tx.$executeRawUnsafe(intakeLegacyPause!);
        expect(await tx.receptionistCampaign.findUniqueOrThrow({ where: { id: activeCampaign.json().id } })).toMatchObject({ status: 'PAUSED' });
        expect(await tx.auditEvent.count({
          where: { tenantId: owner.id, resourceId: activeCampaign.json().id, action: 'receptionistCampaign.intakeAttestationMigrationPaused' },
        })).toBe(1);
        throw new Error('ROLLBACK_INTAKE_LEGACY_PAUSE_PROBE');
      })).rejects.toThrow('ROLLBACK_INTAKE_LEGACY_PAUSE_PROBE');

      const activeFieldMutation = await app.inject({
        method: 'POST', url: '/v1/receptionist/intake-fields', headers: auth(owner, 'OWNER'),
        payload: {
          campaignId: activeCampaign.json().id, fieldType: 'CUSTOM_TEXT', label: 'Accessibility',
          aiQuestion: 'Do you need an accessibility accommodation?', required: false,
        },
      });
      expect(activeFieldMutation.statusCode).toBe(409);
      const deactivateReferenced = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/agents/${agentId}`, headers: auth(owner, 'OWNER'), payload: { active: false },
      });
      expect(deactivateReferenced.statusCode).toBe(409);
      const deleteReferenced = await app.inject({ method: 'DELETE', url: `/v1/receptionist/agents/${agentId}`, headers: auth(owner, 'OWNER') });
      expect(deleteReferenced.statusCode).toBe(409);

      const attestedProviderBookingTool = providerBookingTool;
      providerBookingTool = compileIntakeContract({
        campaignId: campaignDraft.json().id, revision: campaignDraft.json().intakeSchemaRevision,
        appointmentType: 'Drifted provider service', eligibleLocations: [], fields: [],
        toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${ownerClinic}`,
      }).snapshot.bookAppointmentToolContract;
      const graphDriftBlocked = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agentId}/verify-provider`, headers: auth(owner, 'OWNER') });
      expect(graphDriftBlocked.statusCode).toBe(409);
      expect(graphDriftBlocked.json().message).toContain('drift');
      providerBookingTool = attestedProviderBookingTool;

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
      })).toBe(2);

      const paused = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/campaigns/${activeCampaign.json().id}`, headers: auth(owner, 'OWNER'), payload: { status: 'PAUSED' },
      });
      expect(paused.statusCode).toBe(200);
      const impossibleLocation = await app.inject({
        method: 'POST', url: '/v1/receptionist/intake-fields', headers: auth(owner, 'OWNER'),
        payload: {
          campaignId: activeCampaign.json().id, fieldType: 'PREFERRED_LOCATION', label: 'Preferred clinic',
          aiQuestion: 'Which clinic location do you prefer?', required: true,
        },
      });
      expect(impossibleLocation.statusCode).toBe(400);
      expect(impossibleLocation.json().message).toMatch(/eligible active mapped location/i);
      const semanticChange = await app.inject({
        method: 'POST', url: '/v1/receptionist/intake-fields', headers: auth(owner, 'OWNER'),
        payload: {
          campaignId: activeCampaign.json().id, fieldType: 'CUSTOM_TEXT', label: 'Accessibility',
          aiQuestion: 'Do you need an accessibility accommodation?', validationRule: 'brief', required: false,
        },
      });
      expect(semanticChange.statusCode).toBe(201);
      const invalidated = await db.receptionistCampaign.findUniqueOrThrow({ where: { id: activeCampaign.json().id } });
      expect(invalidated.intakeSchemaRevision).toBeGreaterThan(activeCampaign.json().intakeSchemaRevision);
      expect(invalidated).toMatchObject({ intakeSchemaSnapshot: null, intakeSchemaFingerprint: null, intakeSchemaAttestedRevision: null });
      const staleSchemaActivation = await app.inject({
        method: 'PATCH', url: `/v1/receptionist/campaigns/${activeCampaign.json().id}`, headers: auth(owner, 'OWNER'), payload: { status: 'ACTIVE' },
      });
      expect(staleSchemaActivation.statusCode).toBe(409);
      expect(staleSchemaActivation.json().message).toContain('intake_schema_mismatch');
      const approvedUpdate = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agentId}/verify-provider`, headers: auth(owner, 'OWNER') });
      expect(approvedUpdate.statusCode).toBe(200);
      expect(approvedUpdate.json()).toMatchObject({ providerVersion: 18, providerStatus: 'VERIFIED' });
      expect(await db.auditEvent.count({ where: { tenantId: owner.id, resourceId: agentId, action: 'receptionistAgent.providerDeploymentUpdated' } })).toBe(2);
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
        providerResponseEngineType: 'retell-llm', providerResponseEngineId: 'llm-original', providerResponseEngineVersion: 2,
        providerResponseEngineGraphFingerprint: 'b'.repeat(64), providerBookToolSchema: { fixture: true },
        providerEffectiveDynamicVariables: {},
        providerBookToolFingerprint: 'c'.repeat(64), providerToolCallStrictMode: true,
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

      vi.stubGlobal('fetch', vi.fn(async url => new Response(
        String(url).includes('/get-retell-llm/')
          ? 'response engine temporarily unavailable'
          : String(url).includes('list-agents')
            ? JSON.stringify(listedRetellAgent('agent_original', 5))
          : JSON.stringify({
            agent_id: 'agent_original', version: 5, assigned_tags: ['prod'], is_published: true,
            voice_id: 'voice', language: 'en-US', webhook_url: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
            webhook_events: ['call_started', 'call_ended', 'call_analyzed'], data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true,
            response_engine: { type: 'retell-llm', llm_id: 'llm-new', version: 9 },
          }),
        { status: String(url).includes('/get-retell-llm/') ? 503 : 200 },
      )));
      const unresolvedNewEngine = await app.inject({ method: 'POST', url: `/v1/receptionist/agents/${agent.id}/verify-provider`, headers: auth(t, 'OWNER') });
      expect(unresolvedNewEngine.statusCode).toBe(503);
      expect(unresolvedNewEngine.json()).toMatchObject({
        providerStatus: 'INVALID', providerVersion: 4, providerResponseEngineId: 'llm-original',
        providerBookToolFingerprint: 'c'.repeat(64), providerLastAttemptStatus: 'FAILED',
        providerLastErrorCode: 'provider_response_engine_unavailable',
      });
      const blockedActivation = await app.inject({
        method: 'POST', url: '/v1/receptionist/campaigns', headers: auth(t, 'OWNER'),
        payload: {
          clinicId, agentId: agent.id, name: 'Unresolved engine campaign', status: 'ACTIVE',
          offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Schedule now', appointmentType: 'Consultation',
        },
      });
      expect(blockedActivation.statusCode).toBe(409);
      expect(blockedActivation.json().message).toContain('agent_unverified');

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
      payload: {
        clinicId, agentId: unverified.id, name: 'Unsafe outbound activation', script: 'Call the patient.',
        purpose: 'CARE_COORDINATION', legalBasis: 'TREATMENT_OPERATIONS', policyVersion: 'CONFIG-READINESS-1',
        ...quietWindowOutsideNow(),
      },
    });
    expect(outbound.statusCode).toBe(201);
    const patchActivation = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/outbound-campaigns/${outbound.json().id}`, headers: auth(t, 'OWNER'), payload: { status: 'RUNNING' },
    });
    expect(patchActivation.statusCode).toBe(409);
    expect(patchActivation.json().message).toContain('outbound_authority_approval_required');
    const run = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${outbound.json().id}/approve`, headers: auth(t, 'OWNER'),
      payload: { approvalConfirmed: true, status: 'RUNNING' },
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
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${outbound.json().id}/approve`, headers: auth(t, 'OWNER'),
      payload: { approvalConfirmed: true, status: 'RUNNING' },
    });
    expect(staleRun.statusCode).toBe(409);
    expect(staleRun.json().message).toContain('agent_verification_stale');

    await db.receptionistAgent.update({ where: { id: unverified.id }, data: {
      providerVerifiedAt: new Date(), providerVerificationExpiresAt: new Date(Date.now() + 60_000),
      providerResponseEngineVersion: 1,
    } });
    const unattestedStudio = await app.inject({
      method: 'POST', url: '/v1/receptionist/campaigns', headers: auth(t, 'OWNER'),
      payload: {
        clinicId, agentId: unverified.id, name: 'Legacy verified Studio activation', status: 'ACTIVE',
        offerTitle: 'Appointment', offerDescription: 'Schedule care', offerScript: 'Schedule now', appointmentType: 'Consultation',
      },
    });
    expect(unattestedStudio.statusCode).toBe(409);
    expect(unattestedStudio.json().message).toContain('intake_schema_unattested');
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
    const auditTool = compileIntakeContract({
      campaignId: 'audit-contract', revision: 1, appointmentType: 'Consultation', eligibleLocations: [], fields: [],
      toolUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell/fn?clinicId=${clinicId}`,
    }).snapshot.bookAppointmentToolContract;
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(String(url).includes('/get-retell-llm/')
      ? { llm_id: 'llm', version: 1, is_published: true, tool_call_strict_mode: true, general_tools: [auditTool] }
      : String(url).includes('list-agents') ? listedRetellAgent('agent_audit_bound', 8)
      : {
        agent_id: 'agent_audit_bound', version: 8, assigned_tags: ['prod'], is_published: true,
        voice_id: 'voice', language: 'en-US',
        webhook_url: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
        webhook_events: ['call_started', 'call_ended', 'call_analyzed'], data_storage_setting: 'basic_attributes_only', opt_in_signed_url: true,
        response_engine: { type: 'retell-llm', llm_id: 'llm', version: 1 },
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
