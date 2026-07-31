import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signRetell } from './helpers/retellSignature';

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
const { env } = await import('../config/env');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { fingerprintJson } = await import('../modules/receptionist/intakeContract');
const { isWithinQuietHours, quietHoursConfigurationReason, setProviderBoundaryTestHookForTests } = await import('../modules/receptionist/outbound');
const { isDestinationOptedOut } = await import('../lib/campaigns');
const { runWithJobTenantContext } = await import('../lib/tenantContext');

type TenantFixture = Awaited<ReturnType<typeof makeTenant>>;

let app: FastifyInstance;
const tenantIds: string[] = [];
const originalRetell = {
  apiKey: env.RETELL_API_KEY,
  fromNumber: env.RETELL_FROM_NUMBER,
  baseUrl: env.RETELL_BASE_URL,
};

function phoneFor(seed: string, suffix = 0): string {
  const digits = BigInt(`0x${seed.replaceAll('-', '').slice(0, 14)}`) % 9_000_000_000n;
  return `+1${(digits + 1_000_000_000n + BigInt(suffix)).toString().slice(-10)}`;
}

function quietWindowOutsideNow(timezone = 'America/New_York'): { quietHoursStart: string; quietHoursEnd: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0);
  const now = hour * 60 + minute;
  const format = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return { quietHoursStart: format((now + 60) % 1440), quietHoursEnd: format((now + 61) % 1440) };
}

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Outbound ${id.slice(0, 6)}`, slug: `outbound-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({
    data: { tenantId: id, featureKey: 'ai_receptionist', enabled: true, source: 'test' },
  });
  const branch = await db.branch.create({
    data: { tenantId: id, name: 'Main branch', location: 'New York', timezone: 'America/New_York' },
  });
  const owner = await db.user.create({
    data: {
      tenantId: id,
      role: 'OWNER',
      active: true,
      branchId: branch.id,
      email: `owner-${id.slice(0, 8)}@outbound.test`,
      displayName: 'Owner',
    },
  });
  const manager = await db.user.create({
    data: {
      tenantId: id,
      role: 'MANAGER',
      active: true,
      branchId: branch.id,
      email: `manager-${id.slice(0, 8)}@outbound.test`,
      displayName: 'Manager',
    },
  });
  const clinic = await db.receptionistClinic.create({
    data: { tenantId: id, name: 'Main clinic', phone: phoneFor(id), timezone: 'America/New_York' },
  });
  const now = new Date();
  const providerAgentId = `agent_${id.replaceAll('-', '')}`;
  const providerResponseEngineId = `llm_${id.replaceAll('-', '')}`;
  const providerResponseEngineGraphFingerprint = 'a'.repeat(64);
  const providerBookToolSchema = { name: 'book_appointment', parameters: { type: 'object', properties: {} } };
  const providerBookToolFingerprint = fingerprintJson({
    tool: providerBookToolSchema,
    engine: {
      type: 'retell-llm',
      id: providerResponseEngineId,
      version: 1,
      graphFingerprint: providerResponseEngineGraphFingerprint,
    },
  });
  const agent = await db.receptionistAgent.create({
    data: {
      tenantId: id,
      clinicId: clinic.id,
      name: 'Verified outbound agent',
      providerAgentId,
      providerVersion: 1,
      providerVersionTag: 'prod',
      providerStatus: 'VERIFIED',
      providerPublished: true,
      providerAssignedTags: ['prod'],
      providerFingerprint: 'c'.repeat(64),
      providerConfigRevision: 1,
      providerVerifiedRevision: 1,
      providerWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`,
      providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
      providerDataStorageSetting: 'basic_attributes_only',
      providerSignedUrl: true,
      providerResponseEngineType: 'retell-llm',
      providerResponseEngineId,
      providerResponseEngineVersion: 1,
      providerResponseEngineGraphFingerprint,
      providerEffectiveDynamicVariables: {},
      providerBookToolSchema,
      providerBookToolFingerprint,
      providerToolCallStrictMode: true,
      providerVerifiedAt: now,
      providerVerificationExpiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
    },
  });
  const location = await db.receptionistLocation.create({
    data: {
      tenantId: id,
      clinicId: clinic.id,
      branchId: branch.id,
      name: 'Main clinic',
      address: '1 Main Street',
      active: true,
    },
  });
  return {
    id,
    ownerId: owner.id,
    managerId: manager.id,
    branchId: branch.id,
    clinicId: clinic.id,
    locationId: location.id,
    agentId: agent.id,
    providerAgentId,
    providerResponseEngineId,
    providerBookToolFingerprint,
  };
}

function auth(tenant: TenantFixture, role: 'OWNER' | 'MANAGER' = 'OWNER') {
  const userId = role === 'OWNER' ? tenant.ownerId : tenant.managerId;
  return {
    authorization: `Bearer ${app.jwt.sign({ userId, tenantId: tenant.id, role, type: 'access' })}`,
  };
}

async function createPatient(tenant: TenantFixture, suffix: number) {
  return db.patient.create({
    data: {
      tenantId: tenant.id,
      branchId: tenant.branchId,
      firstName: `Patient${suffix}`,
      lastName: 'Outbound',
      phone: phoneFor(tenant.id, suffix),
      tags: [],
    },
  });
}

async function createLead(tenant: TenantFixture, suffix: number) {
  return db.lead.create({
    data: {
      tenantId: tenant.id,
      name: `Lead ${suffix}`,
      phone: phoneFor(tenant.id, suffix),
      channel: 'CALL',
      service: 'General care',
      stage: 'NEW',
      source: 'test',
    },
  });
}

async function createCampaign(
  tenant: TenantFixture,
  options: {
    name?: string;
    status?: 'SCHEDULED' | 'RUNNING';
    maxRetryAttempts?: number;
    bookingMode?: 'APPOINTMENT_REQUEST_ONLY' | 'DIRECT_BOOKING_IF_SLOT_AVAILABLE';
    receptionistCampaignId?: string;
    purpose?: 'CARE_COORDINATION' | 'APPOINTMENT_REMINDER' | 'PATIENT_REACTIVATION';
    legalBasis?: 'EXPLICIT_CONSENT' | 'TREATMENT_OPERATIONS';
    policyVersion?: string;
    quietHoursStart?: string | null;
    quietHoursEnd?: string | null;
  } = {},
) {
  const defaultQuietHours = quietWindowOutsideNow();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/receptionist/outbound-campaigns',
    headers: auth(tenant),
    payload: {
      clinicId: tenant.clinicId,
      agentId: tenant.agentId,
      name: options.name ?? `Outbound ${randomUUID().slice(0, 8)}`,
      script: 'Call the patient about care coordination.',
      requiredFields: ['firstName', 'lastName', 'phone'],
      bookingMode: options.bookingMode ?? 'APPOINTMENT_REQUEST_ONLY',
      receptionistCampaignId: options.receptionistCampaignId,
      defaultBranchId: options.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' ? tenant.branchId : undefined,
      defaultService: options.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' ? 'Consultation' : undefined,
      purpose: options.purpose ?? 'CARE_COORDINATION',
      legalBasis: options.legalBasis ?? 'TREATMENT_OPERATIONS',
      policyVersion: options.policyVersion ?? 'OUTBOUND-TEST-1',
      quietHoursStart: options.quietHoursStart === undefined ? defaultQuietHours.quietHoursStart : options.quietHoursStart,
      quietHoursEnd: options.quietHoursEnd === undefined ? defaultQuietHours.quietHoursEnd : options.quietHoursEnd,
      maxRetryAttempts: options.maxRetryAttempts ?? 1,
    },
  });
  expect(response.statusCode).toBe(201);
  const campaignId = (response.json() as { id: string }).id;
  if (options.status) {
    const approval = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/approve`,
      headers: auth(tenant),
      payload: { approvalConfirmed: true, status: options.status },
    });
    expect(approval.statusCode).toBe(200);
  }
  return campaignId;
}

async function createDirectAuthority(tenant: TenantFixture) {
  const snapshot = { contract: 'outbound-direct-test', revision: 1 };
  return db.receptionistCampaign.create({
    data: {
      tenantId: tenant.id,
      clinicId: tenant.clinicId,
      agentId: tenant.agentId,
      name: 'Attested direct-booking authority',
      status: 'ACTIVE',
      offerTitle: 'Consultation',
      offerDescription: 'Schedule a consultation',
      offerScript: 'Offer a consultation from available slots.',
      appointmentType: 'Consultation',
      eligibleLocationIds: [tenant.locationId],
      intakeSchemaRevision: 1,
      intakeSchemaSnapshot: snapshot,
      intakeSchemaFingerprint: fingerprintJson(snapshot),
      intakeToolFingerprint: tenant.providerBookToolFingerprint,
      intakeSchemaAttestedRevision: 1,
      intakeSchemaAttestedAt: new Date(),
      intakeSchemaProviderAgentId: tenant.providerAgentId,
      intakeSchemaProviderVersion: 1,
      intakeSchemaResponseEngineId: tenant.providerResponseEngineId,
      intakeSchemaResponseEngineVersion: 1,
    },
  });
}

async function addPatientTarget(tenant: TenantFixture, campaignId: string, suffix: number) {
  const patient = await createPatient(tenant, suffix);
  const response = await app.inject({
    method: 'POST',
    url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`,
    headers: auth(tenant),
    payload: { targets: [{ patientId: patient.id, phone: patient.phone, firstName: patient.firstName, lastName: patient.lastName }] },
  });
  expect(response.statusCode).toBe(201);
  return db.receptionistCallTarget.findFirstOrThrow({
    where: { tenantId: tenant.id, campaignId, patientId: patient.id },
  });
}

beforeAll(async () => {
  env.RETELL_API_KEY = 'real_outbound_test_key';
  env.RETELL_FROM_NUMBER = '+15550000001';
  env.RETELL_BASE_URL = 'https://retell.outbound.test';
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  env.RETELL_API_KEY = originalRetell.apiKey;
  env.RETELL_FROM_NUMBER = originalRetell.fromNumber;
  env.RETELL_BASE_URL = originalRetell.baseUrl;
  vi.unstubAllGlobals();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

afterEach(() => {
  setProviderBoundaryTestHookForTests(null);
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('AI receptionist persistent reconciliation evidence', () => {
  it('survives refresh with provider/local IDs, stays fail-closed, and disappears only after durable resolution', async () => {
    const tenant = await makeTenant();
    const foreignTenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const foreignCampaignId = await createCampaign(foreignTenant);
    const target = await addPatientTarget(tenant, campaignId, 990);
    const call = await db.receptionistCallLog.create({ data: {
      tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: campaignId,
      targetId: target.id, retellCallId: `provider-reconcile-${randomUUID()}`,
      callerPhone: target.phone, direction: 'outbound', outcome: 'ESCALATED', endedAt: new Date(),
    } });
    await db.receptionistCallTarget.update({
      where: { id: target.id },
      data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: call.id },
    });
    const signal = await db.operationalSignal.create({ data: {
      tenantId: tenant.id, signalType: 'receptionist_outbound_provider_acceptance_unknown',
      entityType: 'receptionistCallLog', entityId: call.id, severity: 'critical', score: 100,
      reason: 'Provider acceptance requires reconciliation.', status: 'open',
    } });
    const task = await db.staffTask.create({ data: {
      tenantId: tenant.id, title: 'Reconcile outbound provider call', priority: 'CRITICAL', status: 'OPEN',
      metadata: { workflow: 'receptionist_outbound_reconciliation', callLogId: call.id, providerCallId: call.retellCallId },
    } });

    const read = () => app.inject({
      method: 'GET', url: `/v1/receptionist/outbound-campaigns/${campaignId}/reconciliations`, headers: auth(tenant),
    });
    const first = await read();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual([expect.objectContaining({
      localCallLogId: call.id, providerCallId: call.retellCallId, targetId: target.id,
      triggerSources: ['RECONCILIATION_REQUIRED', 'RECONCILIATION_SIGNAL', 'RECONCILIATION_TASK'],
      signalIds: [signal.id], signalStatuses: ['open'],
      reviewTaskIds: [task.id], reviewTaskStatuses: ['OPEN'],
    })]);
    const afterNavigation = await read();
    expect(afterNavigation.json()).toEqual(first.json());
    const crossTenant = await app.inject({
      method: 'GET', url: `/v1/receptionist/outbound-campaigns/${foreignCampaignId}/reconciliations`, headers: auth(tenant),
    });
    expect(crossTenant.statusCode).toBe(404);

    await db.operationalSignal.update({ where: { id: signal.id }, data: { status: 'resolved' } });
    expect((await read()).json()).toHaveLength(1);
    await db.staffTask.update({ where: { id: task.id }, data: { status: 'COMPLETED' } });
    const resolved = await read();
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual([]);
    expect(await db.auditEvent.count({
      where: { tenantId: tenant.id, action: 'receptionist.outboundReconciliation.listRead', resourceId: campaignId },
    })).toBe(4);
  });

  it('does not mistake an ordinary escalation for provider-acceptance uncertainty', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const target = await addPatientTarget(tenant, campaignId, 991);
    await db.receptionistCallLog.create({ data: {
      tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: campaignId,
      targetId: target.id, retellCallId: `provider-handoff-${randomUUID()}`,
      callerPhone: target.phone, direction: 'outbound', outcome: 'ESCALATED', endedAt: new Date(),
    } });

    const response = await app.inject({
      method: 'GET', url: `/v1/receptionist/outbound-campaigns/${campaignId}/reconciliations`, headers: auth(tenant),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('keeps an older unresolved target visible after more than 100 newer call logs', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const target = await addPatientTarget(tenant, campaignId, 992);
    const oldCall = await db.receptionistCallLog.create({ data: {
      tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: campaignId,
      targetId: target.id, retellCallId: `provider-old-reconcile-${randomUUID()}`,
      callerPhone: target.phone, direction: 'outbound', outcome: 'ESCALATED',
      createdAt: new Date('2025-01-01T00:00:00.000Z'), endedAt: new Date('2025-01-01T00:01:00.000Z'),
    } });
    await db.receptionistCallTarget.update({
      where: { id: target.id },
      data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: oldCall.id },
    });
    await db.receptionistCallLog.createMany({
      data: Array.from({ length: 101 }, (_, index) => ({
        tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: campaignId,
        retellCallId: `provider-newer-${index}-${randomUUID()}`, callerPhone: `+1415555${String(index).padStart(4, '0')}`,
        direction: 'outbound', outcome: 'NO_ANSWER' as const, endedAt: new Date(),
      })),
    });

    const response = await app.inject({
      method: 'GET', url: `/v1/receptionist/outbound-campaigns/${campaignId}/reconciliations`, headers: auth(tenant),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({
      localCallLogId: oldCall.id, providerCallId: oldCall.retellCallId,
      triggerSources: ['RECONCILIATION_REQUIRED'],
    })]);
  });
});

describe('AI receptionist fail-closed quiet hours', () => {
  it.each([
    { start: null, end: null, timezone: 'America/New_York', required: true, reason: 'quiet_hours_missing' },
    { start: '21:00', end: null, timezone: 'America/New_York', required: true, reason: 'quiet_hours_incomplete' },
    { start: '9:00', end: '17:00', timezone: 'America/New_York', required: true, reason: 'quiet_hours_invalid' },
    { start: '21:00', end: '21:00', timezone: 'America/New_York', required: true, reason: 'quiet_hours_equal' },
    { start: '21:00', end: '08:00', timezone: 'Not/A_Timezone', required: true, reason: 'quiet_hours_timezone_invalid' },
  ])('rejects invalid deployment configuration: $reason', ({ start, end, timezone, required, reason }) => {
    expect(quietHoursConfigurationReason(start, end, timezone, required)).toBe(reason);
    expect(isWithinQuietHours(start, end, timezone)).toBe(true);
  });

  it('accepts an omitted draft window but requires it for approval', () => {
    expect(quietHoursConfigurationReason(null, null, 'America/New_York', false)).toBeNull();
    expect(quietHoursConfigurationReason('21:00', '08:00', 'America/New_York', true)).toBeNull();
  });

  it('normalizes the provider hour 24 to minute zero without failing open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T05:00:00.000Z'));
    try {
      expect(isWithinQuietHours('23:00', '01:00', 'America/New_York')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evaluates spring-forward DST using the clinic timezone wall clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T07:30:00.000Z'));
    try {
      expect(isWithinQuietHours('01:00', '04:00', 'America/New_York')).toBe(true);
      expect(isWithinQuietHours('04:00', '05:00', 'America/New_York')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AI receptionist DNC evidence and provider-boundary linearization', () => {
  it('atomically records and reason-revokes a manual DNC while preserving immutable evidence', async () => {
    const tenant = await makeTenant();
    const otherTenant = await makeTenant();
    const phone = phoneFor(tenant.id, 701);

    const missingReason = await app.inject({
      method: 'POST', url: '/v1/receptionist/opt-outs', headers: auth(tenant),
      payload: { contactPhone: phone, channel: 'VOICE' },
    });
    expect(missingReason.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST', url: '/v1/receptionist/opt-outs', headers: auth(tenant),
      payload: { contactPhone: phone, channel: 'VOICE', reason: 'Patient requested no outbound voice calls' },
    });
    expect(created.statusCode).toBe(201);
    const optOutId = (created.json() as { id: string }).id;
    expect(await runWithJobTenantContext(tenant.id, () => isDestinationOptedOut(tenant.id, phone, 'voice'))).toBe(true);
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, resourceId: optOutId, action: 'receptionistOptOut.created' } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: tenant.id, entityId: optOutId, eventType: 'receptionist.dnc.activated' } })).toBe(1);

    const managerRemoval = await app.inject({
      method: 'DELETE', url: `/v1/receptionist/opt-outs/${optOutId}`, headers: auth(tenant, 'MANAGER'),
      payload: { reason: 'Patient supplied a verified written reversal', acknowledgeReactivationRisk: true },
    });
    expect(managerRemoval.statusCode).toBe(403);
    const missingAcknowledgement = await app.inject({
      method: 'DELETE', url: `/v1/receptionist/opt-outs/${optOutId}`, headers: auth(tenant),
      payload: { reason: 'Patient supplied a verified written reversal' },
    });
    expect(missingAcknowledgement.statusCode).toBe(400);

    await expect(runWithJobTenantContext(tenant.id, tx => tx.$executeRaw`
      UPDATE "ReceptionistOptOut"
      SET "revokedAt" = NOW(), "revokedByUserId" = ${otherTenant.ownerId}::uuid, "revocationReason" = 'Cross tenant actor must fail'
      WHERE "id" = ${optOutId}::uuid AND "tenantId" = ${tenant.id}::uuid
    `)).rejects.toThrow();

    const removed = await app.inject({
      method: 'DELETE', url: `/v1/receptionist/opt-outs/${optOutId}`, headers: auth(tenant),
      payload: { reason: 'Patient supplied a verified written reversal', acknowledgeReactivationRisk: true },
    });
    expect(removed.statusCode).toBe(204);
    const durable = await db.receptionistOptOut.findUniqueOrThrow({ where: { id: optOutId } });
    expect(durable).toMatchObject({ revokedByUserId: tenant.ownerId, revocationReason: 'Patient supplied a verified written reversal' });
    expect(durable.revokedAt).toBeInstanceOf(Date);
    expect(await runWithJobTenantContext(tenant.id, () => isDestinationOptedOut(tenant.id, phone, 'voice'))).toBe(false);
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, resourceId: optOutId, action: 'receptionistOptOut.revoked' } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: tenant.id, entityId: optOutId, eventType: 'receptionist.dnc.revoked' } })).toBe(1);

    await expect(runWithJobTenantContext(tenant.id, tx => tx.$executeRaw`
      DELETE FROM "ReceptionistOptOut" WHERE "id" = ${optOutId}::uuid AND "tenantId" = ${tenant.id}::uuid
    `)).rejects.toThrow();
    await expect(runWithJobTenantContext(tenant.id, tx => tx.$executeRaw`
      UPDATE "ReceptionistOptOut" SET "reason" = 'Rewritten evidence'
      WHERE "id" = ${optOutId}::uuid AND "tenantId" = ${tenant.id}::uuid
    `)).rejects.toThrow();
    await expect(runWithJobTenantContext(tenant.id, tx => tx.$executeRaw`
      UPDATE "ReceptionistOptOut" SET "revocationReason" = 'Second rewritten revocation'
      WHERE "id" = ${optOutId}::uuid AND "tenantId" = ${tenant.id}::uuid
    `)).rejects.toThrow();
  }, 30_000);

  it('permits only a provider-id-backed FAILED to ESCALATED late-acceptance safety upgrade', async () => {
    const tenant = await makeTenant();
    const call = await db.receptionistCallLog.create({ data: {
      tenantId: tenant.id, clinicId: tenant.clinicId, callerPhone: phoneFor(tenant.id, 705),
      direction: 'outbound', outcome: 'FAILED', endedAt: new Date(),
    } });
    const upgraded = await db.receptionistCallLog.update({
      where: { id: call.id }, data: { outcome: 'ESCALATED', retellCallId: 'late_provider_acceptance_evidence' },
    });
    expect(upgraded).toMatchObject({ outcome: 'ESCALATED', retellCallId: 'late_provider_acceptance_evidence' });
    await expect(db.receptionistCallLog.update({ where: { id: call.id }, data: { outcome: 'FAILED' } })).rejects.toThrow();

    const noProviderEvidence = await db.receptionistCallLog.create({ data: {
      tenantId: tenant.id, clinicId: tenant.clinicId, callerPhone: phoneFor(tenant.id, 706),
      direction: 'outbound', outcome: 'FAILED', endedAt: new Date(),
    } });
    await expect(db.receptionistCallLog.update({
      where: { id: noProviderEvidence.id }, data: { outcome: 'ESCALATED' },
    })).rejects.toThrow();
  });

  it('makes a DNC that obtains the fence first suppress the provider call deterministically', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 711);
    const beforeFence = deferred();
    const release = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'before_suppression_fence') {
        beforeFence.resolve();
        await release.promise;
      }
    });
    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await beforeFence.promise;
    const dnc = await app.inject({
      method: 'POST', url: '/v1/receptionist/opt-outs', headers: auth(tenant),
      payload: { contactPhone: target.phone, channel: 'VOICE', reason: 'Patient opted out during dispatch preparation' },
    });
    expect(dnc.statusCode).toBe(201);
    release.resolve();

    const response = await call;
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: 'blocked', reason: 'shared_suppression_gate' });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await db.auditEvent.count({ where: { tenantId: tenant.id, action: 'receptionist.outbound.providerIntent.authorized', resourceId: response.json().callLogId } })).toBe(0);
  }, 30_000);

  it('makes a CommunicationConsent opt-out that obtains the identity fence first suppress Retell', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 716);
    const beforeFence = deferred();
    const release = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'before_suppression_fence') {
        beforeFence.resolve();
        await release.promise;
      }
    });
    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await beforeFence.promise;
    await db.communicationConsent.create({ data: {
      tenantId: tenant.id, patientId: target.patientId, channel: 'voice', status: 'opted_out',
      source: 'deterministic_race_test', revokedAt: new Date(),
    } });
    release.resolve();

    const response = await call;
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: 'blocked', reason: 'shared_suppression_gate' });
    expect(providerFetch).not.toHaveBeenCalled();
  }, 30_000);

  it('orders a later DNC after a durable provider intent and preserves evidence for the one authorized call', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 721);
    const intentCommitted = deferred();
    const release = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'provider_intent_committed') {
        intentCommitted.resolve();
        await release.promise;
      }
    });
    const providerFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      call_id: 'retell_linearized_call', agent_id: tenant.providerAgentId, agent_version: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await intentCommitted.promise;
    const dnc = await app.inject({
      method: 'POST', url: '/v1/receptionist/opt-outs', headers: auth(tenant),
      payload: { contactPhone: target.phone, channel: 'VOICE', reason: 'Patient opted out after this call was authorized' },
    });
    expect(dnc.statusCode).toBe(201);
    release.resolve();

    const response = await call;
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'launched', callId: 'retell_linearized_call' });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(await runWithJobTenantContext(tenant.id, () => isDestinationOptedOut(tenant.id, target.phone, 'voice'))).toBe(true);
    const intent = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: tenant.id, action: 'receptionist.outbound.providerIntent.authorized', resourceId: response.json().callLogId },
    });
    const optOut = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: tenant.id, action: 'receptionistOptOut.created', occurredAt: { gte: intent.occurredAt } },
      orderBy: { occurredAt: 'desc' },
    });
    expect(optOut.occurredAt.getTime()).toBeGreaterThanOrEqual(intent.occurredAt.getTime());
  }, 30_000);

  it('recovers the provider-acceptance crash window from signed intent metadata and rejects cross-call replay', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 722);
    const beforeBinding = deferred();
    const releaseBinding = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'before_provider_binding_lock') {
        beforeBinding.resolve();
        await releaseBinding.promise;
      }
    });
    const providerCallId = `retell_recovered_${randomUUID()}`;
    let providerMetadata: Record<string, unknown> | null = null;
    const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'POST' && typeof init.body === 'string' && init.body.includes('retell_llm_dynamic_variables')) {
        providerMetadata = (JSON.parse(init.body) as { metadata: Record<string, unknown> }).metadata;
        return new Response(JSON.stringify({
          call_id: providerCallId,
          agent_id: tenant.providerAgentId,
          agent_version: 1,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (String(_url).includes('/v2/stop-call/')) return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', providerFetch);

    const launch = app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
      headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await beforeBinding.promise;
    expect(providerMetadata).not.toBeNull();
    const rawStarted = JSON.stringify({
      event: 'call_started',
      call: {
        call_id: providerCallId,
        agent_id: tenant.providerAgentId,
        agent_version: 1,
        direction: 'outbound',
        to_number: target.phone,
        metadata: providerMetadata,
      },
    });
    const recovered = await app.inject({
      method: 'POST',
      url: '/v1/receptionist/webhooks/retell',
      headers: {
        'content-type': 'application/json',
        'x-retell-signature': signRetell(rawStarted, env.RETELL_API_KEY!),
      },
      payload: rawStarted,
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    const recoveredCall = await db.receptionistCallLog.findFirstOrThrow({
      where: { tenantId: tenant.id, retellCallId: providerCallId },
    });
    expect(recoveredCall).toMatchObject({ outcome: 'IN_PROGRESS', targetId: target.id });

    releaseBinding.resolve();
    const launchResponse = await launch;
    expect(launchResponse.statusCode, launchResponse.body).toBe(201);
    expect(launchResponse.json()).toMatchObject({ status: 'launched', callId: providerCallId, callLogId: recoveredCall.id });

    const replayCallId = `retell_replay_${randomUUID()}`;
    const rawReplay = JSON.stringify({
      event: 'call_started',
      call: {
        call_id: replayCallId,
        agent_id: tenant.providerAgentId,
        agent_version: 1,
        direction: 'outbound',
        to_number: target.phone,
        metadata: providerMetadata,
      },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/receptionist/webhooks/retell',
      headers: {
        'content-type': 'application/json',
        'x-retell-signature': signRetell(rawReplay, env.RETELL_API_KEY!),
      },
      payload: rawReplay,
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({
      reason: 'provider_intent_quarantined',
      providerStopApplied: true,
    });
    expect(await db.receptionistCallLog.count({ where: { tenantId: tenant.id, retellCallId: replayCallId } })).toBe(0);
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: recoveredCall.id } })).toMatchObject({
      retellCallId: providerCallId,
      outcome: 'IN_PROGRESS',
    });
  }, 30_000);

  it.each([
    ['missing agent id', { agent_version: 1 }],
    ['missing agent version', { agent_id: 'expected' }],
  ])('quarantines crash recovery with %s instead of admitting an unattested deployment', async (_label, attestation) => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 'agent_id' in attestation ? 724 : 723);
    const beforeBinding = deferred();
    const releaseBinding = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'before_provider_binding_lock') {
        beforeBinding.resolve();
        await releaseBinding.promise;
      }
    });
    const providerCallId = `retell_unattested_${randomUUID()}`;
    let providerMetadata: Record<string, unknown> | null = null;
    const providerFetch = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST' && typeof init.body === 'string' && init.body.includes('retell_llm_dynamic_variables')) {
        providerMetadata = (JSON.parse(init.body) as { metadata: Record<string, unknown> }).metadata;
        return new Response(JSON.stringify({
          call_id: providerCallId,
          agent_id: tenant.providerAgentId,
          agent_version: 1,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('/v2/stop-call/')) return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', providerFetch);

    const launch = app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
      headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await beforeBinding.promise;
    const raw = JSON.stringify({
      event: 'call_started',
      call: {
        call_id: providerCallId,
        direction: 'outbound',
        to_number: target.phone,
        metadata: providerMetadata,
        ...('agent_id' in attestation
          ? { agent_id: tenant.providerAgentId }
          : { agent_version: attestation.agent_version }),
      },
    });
    const callback = await app.inject({
      method: 'POST',
      url: '/v1/receptionist/webhooks/retell',
      headers: {
        'content-type': 'application/json',
        'x-retell-signature': signRetell(raw, env.RETELL_API_KEY!),
      },
      payload: raw,
    });
    expect(callback.statusCode, callback.body).toBe(202);
    expect(callback.json()).toMatchObject({
      reason: 'provider_intent_quarantined',
      providerStopApplied: true,
    });
    expect(await db.receptionistCallLog.findFirstOrThrow({
      where: { tenantId: tenant.id, retellCallId: providerCallId },
    })).toMatchObject({ outcome: 'ESCALATED' });

    releaseBinding.resolve();
    await launch;
  }, 30_000);

  it('launches explicit reactivation only with exact immutable grant evidence bound to provider intent', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, {
      status: 'RUNNING',
      purpose: 'PATIENT_REACTIVATION',
      legalBasis: 'EXPLICIT_CONSENT',
      policyVersion: 'REACTIVATION-2026-2',
    });
    const target = await addPatientTarget(tenant, campaignId, 723);
    const grant = await db.receptionistVoiceConsentEvent.create({ data: {
      tenantId: tenant.id,
      patientId: target.patientId,
      purpose: 'PATIENT_REACTIVATION',
      granted: true,
      policyVersion: 'REACTIVATION-2026-2',
      disclosureTextHash: 'b'.repeat(64),
      evidenceReference: 'reactivation-written-grant-723',
      captureMethod: 'written',
      source: 'patient_written',
      jurisdiction: 'NY',
    } });
    const providerFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      call_id: 'retell_immutable_consent_call', agent_id: tenant.providerAgentId, agent_version: 1,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', providerFetch);
    const response = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    expect(response.statusCode).toBe(201);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(await db.receptionistOutboundProviderIntent.findFirstOrThrow({
      where: { tenantId: tenant.id, callLogId: response.json().callLogId },
    })).toMatchObject({
      outboundCampaignId: campaignId,
      targetId: target.id,
      voiceConsentEventId: grant.id,
      purpose: 'PATIENT_REACTIVATION',
      policyVersion: 'REACTIVATION-2026-2',
    });
  }, 30_000);

  it.each(['ReceptionistOutboundProviderIntent', 'AuditEvent', 'BusinessEvent'] as const)(
    'cleans the reservation and makes zero provider calls when final %s evidence fails',
    async table => {
      const tenant = await makeTenant();
      const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
      const target = await addPatientTarget(tenant, campaignId, table === 'AuditEvent' ? 725 : table === 'BusinessEvent' ? 726 : 727);
      const providerFetch = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', providerFetch);
      const functionName = `outbound_intent_${table.toLowerCase()}_${tenant.id.replaceAll('-', '')}`;
      try {
        await db.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
          BEGIN
            IF NEW."tenantId" = '${tenant.id}'::uuid THEN
              ${table === 'AuditEvent'
                ? "IF NEW.\"action\" = 'receptionist.outbound.providerIntent.authorized' THEN RAISE EXCEPTION 'injected final AuditEvent failure'; END IF;"
                : table === 'BusinessEvent'
                  ? "IF NEW.\"eventType\" = 'receptionist.outbound.provider_intent_authorized' THEN RAISE EXCEPTION 'injected final BusinessEvent failure'; END IF;"
                  : "RAISE EXCEPTION 'injected final ProviderIntent failure';"}
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER "${functionName}_trigger"
          BEFORE INSERT ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
        `);
        const response = await app.inject({
          method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
          payload: { targetId: target.id, phone: target.phone },
        });
        expect(response.statusCode, JSON.stringify(response.json())).toBe(503);
        expect(response.json()).toMatchObject({
          status: 'blocked', reason: 'provider_intent_evidence_failed',
          trackingDegraded: true,
          cleanupAuditRecorded: true,
        });
        expect(providerFetch).not.toHaveBeenCalled();
        expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: response.json().callLogId } })).toMatchObject({ outcome: 'FAILED' });
        expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
          status: 'PENDING', attempts: 0, lastOutcome: 'PROVIDER_INTENT_EVIDENCE_FAILED',
        });
        const durableIntentCount = await db.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count FROM "ReceptionistOutboundProviderIntent"
          WHERE "tenantId" = ${tenant.id}::uuid AND "callLogId" = ${response.json().callLogId}::uuid
        `.catch(() => [{ count: 0n }]);
        expect(durableIntentCount[0]?.count ?? 0n).toBe(0n);
      } finally {
        await db.$executeRawUnsafe(`
          DROP TRIGGER IF EXISTS "${functionName}_trigger" ON "${table}";
          DROP FUNCTION IF EXISTS "${functionName}"();
        `);
      }
    },
    30_000,
  );

  it('cancels a committed provider intent when the kill switch wins before Retell dispatch', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 731);
    const intentCommitted = deferred();
    const release = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'provider_intent_committed') {
        intentCommitted.resolve();
        await release.promise;
      }
    });
    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await intentCommitted.promise;
    const stopped = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-control', headers: auth(tenant),
      payload: { stopped: true, reason: 'Emergency stop after provider intent commit' },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({
      stopped: true,
      activeCancellation: { unboundIntentsQuarantined: 1 },
    });
    release.resolve();

    const response = await call;
    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({ status: 'cancelled', reason: 'outbound_stopped' });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: response.json().callLogId } })).toMatchObject({ outcome: 'ESCALATED' });
  }, 30_000);

  it('releases target and attempt when campaign pauses after intent but before provider submission', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 733);
    const intentCommitted = deferred();
    const release = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'provider_intent_committed') {
        intentCommitted.resolve();
        await release.promise;
      }
    });
    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', providerFetch);
    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await intentCommitted.promise;
    const paused = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/outbound-campaigns/${campaignId}`, headers: auth(tenant), payload: { status: 'PAUSED' },
    });
    expect(paused.statusCode).toBe(200);
    release.resolve();

    const response = await call;
    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({ status: 'cancelled', reason: 'provider_intent_cancelled' });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'PENDING', attempts: 0, lastOutcome: 'PROVIDER_INTENT_CANCELLED',
    });
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: response.json().callLogId } })).toMatchObject({ outcome: 'FAILED' });
  }, 30_000);

  it('stops an accepted provider call when the kill switch wins while Retell is in flight', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 741);
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const providerCallId = 'retell_kill_race_call';
    const providerFetch = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/v2/create-phone-call')) {
        providerStarted.resolve();
        await releaseProvider.promise;
        return new Response(JSON.stringify({
          call_id: providerCallId, agent_id: tenant.providerAgentId, agent_version: 1,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes(`/v2/stop-call/${providerCallId}`)) return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await providerStarted.promise;
    const stopped = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-control', headers: auth(tenant),
      payload: { stopped: true, reason: 'Emergency stop while provider submission is in flight' },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ activeCancellation: { unboundIntentsQuarantined: 1 } });
    releaseProvider.resolve();

    const response = await call;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'cancelled', reason: 'outbound_stopped', callId: providerCallId, providerStopApplied: true,
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(providerFetch).toHaveBeenLastCalledWith(
      `${env.RETELL_BASE_URL}/v2/stop-call/${providerCallId}`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'FAILED', lastOutcome: 'OUTBOUND_STOPPED',
    });
  }, 30_000);

  it('quarantines a late provider acceptance and creates critical review evidence when stop is unconfirmed', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 744);
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const providerCallId = 'retell_unconfirmed_stop_call';
    const providerFetch = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/v2/create-phone-call')) {
        providerStarted.resolve();
        await releaseProvider.promise;
        return new Response(JSON.stringify({
          call_id: providerCallId, agent_id: tenant.providerAgentId, agent_version: 1,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'stop not confirmed' }), { status: 503, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await providerStarted.promise;
    const stopped = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-control', headers: auth(tenant),
      payload: { stopped: true, reason: 'Emergency stop with provider acceptance uncertainty' },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ activeCancellation: { unboundIntentsQuarantined: 1 } });
    releaseProvider.resolve();

    const response = await call;
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: 'reconciliation_required', providerStopApplied: false, error: 'retell_error_503', reviewRecorded: true,
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: response.json().callLogId } })).toMatchObject({
      retellCallId: providerCallId, outcome: 'ESCALATED',
    });
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
    });
    expect(await db.operationalSignal.findUniqueOrThrow({ where: { id: response.json().signalId } })).toMatchObject({
      signalType: 'receptionist_outbound_stop_unconfirmed_after_acceptance', severity: 'critical', status: 'open',
    });
    expect(await db.staffTask.findUniqueOrThrow({ where: { id: response.json().reviewTaskId } })).toMatchObject({
      priority: 'CRITICAL', metadata: expect.objectContaining({ workflow: 'receptionist_outbound_stop_reconciliation', providerStopApplied: false }),
    });
    const providerCalls = providerFetch.mock.calls.length;
    const retry = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    expect(retry.statusCode).toBe(423);
    expect(providerFetch).toHaveBeenCalledTimes(providerCalls);
  }, 30_000);

  it.each([
    { label: 'signal', tables: ['OperationalSignal'], expected: { signalRecorded: false, reviewRecorded: true, auditRecorded: true, businessEventRecorded: true } },
    { label: 'task', tables: ['StaffTask'], expected: { signalRecorded: true, reviewRecorded: false, auditRecorded: true, businessEventRecorded: true } },
    { label: 'audit', tables: ['AuditEvent'], expected: { signalRecorded: true, reviewRecorded: true, auditRecorded: false, businessEventRecorded: true } },
    { label: 'business event', tables: ['BusinessEvent'], expected: { signalRecorded: true, reviewRecorded: true, auditRecorded: true, businessEventRecorded: false } },
    { label: 'all review plumbing', tables: ['OperationalSignal', 'StaffTask', 'AuditEvent', 'BusinessEvent'], expected: { signalRecorded: false, reviewRecorded: false, auditRecorded: false, businessEventRecorded: false } },
  ])('preserves primary quarantine when $label persistence fails', async ({ tables, expected }) => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 745);
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const providerCallId = `retell_degraded_review_${randomUUID()}`;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/v2/create-phone-call')) {
        providerStarted.resolve();
        await releaseProvider.promise;
        return new Response(JSON.stringify({
          call_id: providerCallId, agent_id: tenant.providerAgentId, agent_version: 1,
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 503 });
    }));

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await providerStarted.promise;
    const stopped = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-control', headers: auth(tenant),
      payload: { stopped: true, reason: 'Emergency stop before degraded review persistence test' },
    });
    expect(stopped.statusCode).toBe(200);

    const triggerNames = tables.map(table => `receptionist_degraded_${table.toLowerCase()}_${tenant.id.replaceAll('-', '')}`);
    try {
      for (let index = 0; index < tables.length; index += 1) {
        const table = tables[index];
        const triggerName = triggerNames[index];
        await db.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION "${triggerName}"() RETURNS trigger AS $$
          BEGIN
            IF NEW."tenantId" = '${tenant.id}'::uuid THEN
              RAISE EXCEPTION 'injected ${table} persistence failure';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
          CREATE TRIGGER "${triggerName}_trigger"
          BEFORE INSERT OR UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "${triggerName}"();
        `);
      }
      releaseProvider.resolve();
      const response = await call;
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ status: 'reconciliation_required', providerStopApplied: false, ...expected });
      expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: response.json().callLogId } })).toMatchObject({
        retellCallId: providerCallId, outcome: 'ESCALATED',
      });
      expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
        status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
      });
    } finally {
      releaseProvider.resolve();
      for (let index = 0; index < tables.length; index += 1) {
        const table = tables[index];
        const triggerName = triggerNames[index];
        await db.$executeRawUnsafe(`
          DROP TRIGGER IF EXISTS "${triggerName}_trigger" ON "${table}";
          DROP FUNCTION IF EXISTS "${triggerName}"();
        `);
      }
    }
  }, 30_000);

  it('lets the stop snapshot observe and stop a provider ID when atomic binding wins first', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 746);
    const bindingCommitted = deferred();
    const release = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'provider_binding_committed') {
        bindingCommitted.resolve();
        await release.promise;
      }
    });
    const providerCallId = 'retell_binding_wins_call';
    const providerFetch = vi.fn<typeof fetch>(async url => String(url).includes('/v2/create-phone-call')
      ? new Response(JSON.stringify({ call_id: providerCallId, agent_id: tenant.providerAgentId, agent_version: 1 }), {
        status: 201, headers: { 'content-type': 'application/json' },
      })
      : new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await bindingCommitted.promise;
    const stopped = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-control', headers: auth(tenant),
      payload: { stopped: true, reason: 'Emergency stop after provider ID binding' },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({
      activeCancellation: { requested: 1, confirmed: 1, unboundIntentsQuarantined: 0 },
    });
    release.resolve();

    const response = await call;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'cancelled', providerStopApplied: true, callId: providerCallId });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(providerFetch).toHaveBeenLastCalledWith(
      `${env.RETELL_BASE_URL}/v2/stop-call/${providerCallId}`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: response.json().callLogId } })).toMatchObject({
      retellCallId: providerCallId, outcome: 'FAILED',
    });
  }, 30_000);

  it.each([
    { label: 'with durable target stop evidence', targetEvidence: true, expectedCode: 200, expectedApplied: true, expectedOutcome: 'OUTBOUND_STOPPED' },
    { label: 'without durable target stop evidence', targetEvidence: false, expectedCode: 202, expectedApplied: false, expectedOutcome: 'RECONCILIATION_REQUIRED' },
  ])('handles a concurrent duplicate provider stop failure $label', async ({ targetEvidence, expectedCode, expectedApplied, expectedOutcome }) => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 747);
    const bindingCommitted = deferred();
    const releaseBinding = deferred();
    const firstStopStarted = deferred();
    const releaseFirstStop = deferred();
    const secondStopStarted = deferred();
    const releaseSecondStop = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'provider_binding_committed') {
        bindingCommitted.resolve();
        await releaseBinding.promise;
      }
    });
    const providerCallId = `retell_contradictory_double_stop_${targetEvidence ? 'evidenced' : 'unevidenced'}`;
    let stopRequests = 0;
    const providerFetch = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/v2/create-phone-call')) return new Response(JSON.stringify({
        call_id: providerCallId, agent_id: tenant.providerAgentId, agent_version: 1,
      }), { status: 201, headers: { 'content-type': 'application/json' } });
      stopRequests += 1;
      if (stopRequests === 1) {
        firstStopStarted.resolve();
        await releaseFirstStop.promise;
        return new Response(null, { status: 204 });
      }
      secondStopStarted.resolve();
      await releaseSecondStop.promise;
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await bindingCommitted.promise;
    if (!targetEvidence) {
      await db.receptionistCallTarget.update({
        where: { id: target.id }, data: { status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED' },
      });
    }
    const stop = app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-control', headers: auth(tenant),
      payload: { stopped: true, reason: 'Concurrent contradictory provider stop test' },
    });
    await firstStopStarted.promise;
    releaseBinding.resolve();
    await secondStopStarted.promise;
    releaseFirstStop.resolve();
    const stopResponse = await stop;
    expect(stopResponse.statusCode).toBe(200);
    expect(stopResponse.json()).toMatchObject({ activeCancellation: { confirmed: 1, failed: 0 } });
    releaseSecondStop.resolve();

    const response = await call;
    expect(response.statusCode).toBe(expectedCode);
    expect(response.json()).toMatchObject({
      status: expectedApplied ? 'cancelled' : 'reconciliation_required', providerStopApplied: expectedApplied, callId: providerCallId,
    });
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: response.json().callLogId } })).toMatchObject({
      retellCallId: providerCallId, outcome: 'FAILED',
    });
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'FAILED', lastOutcome: expectedOutcome,
    });
  }, 30_000);

  it('preserves handler-confirmed cancellation when the endpoint provider stop fails later', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 749);
    const bindingCommitted = deferred();
    const releaseBinding = deferred();
    const endpointStopStarted = deferred();
    const releaseEndpointStop = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'provider_binding_committed') {
        bindingCommitted.resolve();
        await releaseBinding.promise;
      }
    });
    const providerCallId = 'retell_opposite_contradictory_stop';
    let stopRequests = 0;
    const providerFetch = vi.fn<typeof fetch>(async url => {
      if (String(url).includes('/v2/create-phone-call')) return new Response(JSON.stringify({
        call_id: providerCallId, agent_id: tenant.providerAgentId, agent_version: 1,
      }), { status: 201, headers: { 'content-type': 'application/json' } });
      stopRequests += 1;
      if (stopRequests === 1) {
        endpointStopStarted.resolve();
        await releaseEndpointStop.promise;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await bindingCommitted.promise;
    const stop = app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-control', headers: auth(tenant),
      payload: { stopped: true, reason: 'Opposite contradictory provider stop ordering' },
    });
    await endpointStopStarted.promise;
    releaseBinding.resolve();
    const response = await call;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'cancelled', providerStopApplied: true });
    releaseEndpointStop.resolve();
    const stopResponse = await stop;
    expect(stopResponse.statusCode).toBe(200);
    expect(stopResponse.json()).toMatchObject({
      activeCancellation: { failed: 1, reconciliationRequired: 0, signalRecorded: 0, reviewRecorded: 0 },
    });
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: response.json().callLogId } })).toMatchObject({
      retellCallId: providerCallId, outcome: 'FAILED',
    });
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'FAILED', lastOutcome: 'OUTBOUND_STOPPED',
    });
  }, 30_000);

  it('quarantines a bound call in the stop endpoint itself when provider stop fails', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 748);
    const bindingCommitted = deferred();
    const release = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'provider_binding_committed') {
        bindingCommitted.resolve();
        await release.promise;
      }
    });
    const providerCallId = 'retell_bound_stop_failure_call';
    const providerFetch = vi.fn<typeof fetch>(async url => String(url).includes('/v2/create-phone-call')
      ? new Response(JSON.stringify({ call_id: providerCallId, agent_id: tenant.providerAgentId, agent_version: 1 }), {
        status: 201, headers: { 'content-type': 'application/json' },
      })
      : new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await bindingCommitted.promise;
    const stopped = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-control', headers: auth(tenant),
      payload: { stopped: true, reason: 'Emergency stop with a bound provider cancellation failure' },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ activeCancellation: {
      requested: 1, failed: 1, reconciliationRequired: 1, signalRecorded: 1, reviewRecorded: 1,
    } });
    const quarantined = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: tenant.id, targetId: target.id } });
    expect(quarantined).toMatchObject({ retellCallId: providerCallId, outcome: 'ESCALATED' });
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'FAILED', lastOutcome: 'RECONCILIATION_REQUIRED',
    });
    release.resolve();

    const response = await call;
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'reconciliation_required', providerStopApplied: false });
    expect(providerFetch).toHaveBeenCalledTimes(3);
  }, 30_000);
});

describe('AI receptionist outbound authority and target integrity', () => {
  it('requires strict deployable quiet hours and fails closed on invalid clinic timezone at dispatch', async () => {
    const tenant = await makeTenant();
    const basePayload = {
      clinicId: tenant.clinicId,
      agentId: tenant.agentId,
      name: `Quiet ${randomUUID().slice(0, 8)}`,
      script: 'Call the patient about care coordination.',
      purpose: 'CARE_COORDINATION',
      legalBasis: 'TREATMENT_OPERATIONS',
      policyVersion: 'OUTBOUND-TEST-1',
    };
    const invalidSyntax = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: auth(tenant),
      payload: { ...basePayload, quietHoursStart: '9:00', quietHoursEnd: '17:00' },
    });
    expect(invalidSyntax.statusCode).toBe(400);

    const equalWindow = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: auth(tenant),
      payload: { ...basePayload, name: `${basePayload.name} equal`, quietHoursStart: '21:00', quietHoursEnd: '21:00' },
    });
    expect(equalWindow.statusCode).toBe(409);
    expect(equalWindow.json()).toMatchObject({ message: expect.stringContaining('quiet_hours_equal') });

    const missingWindow = await app.inject({
      method: 'POST', url: '/v1/receptionist/outbound-campaigns', headers: auth(tenant), payload: basePayload,
    });
    expect(missingWindow.statusCode).toBe(201);
    const missingApproval = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${missingWindow.json().id}/approve`, headers: auth(tenant),
      payload: { approvalConfirmed: true, status: 'RUNNING' },
    });
    expect(missingApproval.statusCode).toBe(409);
    expect(missingApproval.json()).toMatchObject({ message: expect.stringContaining('quiet_hours_missing') });

    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 799);
    await db.receptionistClinic.update({ where: { id: tenant.clinicId }, data: { timezone: 'Not/A_Timezone' } });
    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', providerFetch);
    const blocked = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ status: 'blocked', reason: 'quiet_hours_timezone_invalid' });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('requires OWNER/ADMIN attestation and freezes approved request-only authority', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);

    const managerApproval = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/approve`,
      headers: auth(tenant, 'MANAGER'),
      payload: { approvalConfirmed: true, status: 'SCHEDULED' },
    });
    expect(managerApproval.statusCode).toBe(403);

    const approval = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/approve`,
      headers: auth(tenant),
      payload: { approvalConfirmed: true, status: 'SCHEDULED' },
    });
    expect(approval.statusCode).toBe(200);
    expect(approval.json()).toMatchObject({
      status: 'SCHEDULED',
      authorityApprovedById: tenant.ownerId,
      policyVersion: 'OUTBOUND-TEST-1',
    });
    expect((approval.json() as { authorityFingerprint: string }).authorityFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const mutated = await app.inject({
      method: 'PATCH',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}`,
      headers: auth(tenant),
      payload: { script: 'A materially different dial script.' },
    });
    expect(mutated.statusCode).toBe(409);
    expect(mutated.json()).toMatchObject({ message: expect.stringContaining('outbound_authority_immutable') });
  });

  it('freezes attested direct-booking authority after approval', async () => {
    const tenant = await makeTenant();
    const authority = await createDirectAuthority(tenant);
    const campaignId = await createCampaign(tenant, {
      bookingMode: 'DIRECT_BOOKING_IF_SLOT_AVAILABLE',
      receptionistCampaignId: authority.id,
      status: 'RUNNING',
    });

    const mutated = await app.inject({
      method: 'PATCH',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}`,
      headers: auth(tenant),
      payload: { defaultService: 'Another service' },
    });
    expect(mutated.statusCode).toBe(409);
    expect(mutated.json()).toMatchObject({ message: expect.stringContaining('outbound_authority_immutable') });
  });

  it('serializes Studio pause ahead of final provider intent and releases the reserved target', async () => {
    const tenant = await makeTenant();
    const authority = await createDirectAuthority(tenant);
    const campaignId = await createCampaign(tenant, {
      bookingMode: 'DIRECT_BOOKING_IF_SLOT_AVAILABLE',
      receptionistCampaignId: authority.id,
      status: 'RUNNING',
    });
    const target = await addPatientTarget(tenant, campaignId, 801);
    const beforeFinalLocks = deferred();
    const release = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'before_suppression_fence') {
        beforeFinalLocks.resolve();
        await release.promise;
      }
    });
    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', providerFetch);

    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    await beforeFinalLocks.promise;
    const paused = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/campaigns/${authority.id}`, headers: auth(tenant),
      payload: { status: 'PAUSED' },
    });
    expect(paused.statusCode).toBe(200);
    release.resolve();

    const response = await call;
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: 'blocked', reason: 'direct_booking_authority_inactive_or_foreign' });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: response.json().callLogId } })).toMatchObject({ outcome: 'FAILED' });
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'PENDING', attempts: 0, lastOutcome: 'BLOCKED',
    });
  }, 30_000);

  it('calculates target voice authorization from exact immutable purpose/policy evidence and latest revocation', async () => {
    const tenant = await makeTenant();
    const patient = await createPatient(tenant, 802);
    const campaignId = await createCampaign(tenant, {
      purpose: 'PATIENT_REACTIVATION',
      legalBasis: 'EXPLICIT_CONSENT',
      policyVersion: 'REACTIVATION-2026-1',
    });
    const getCandidates = () => app.inject({
      method: 'GET',
      url: `/v1/receptionist/outbound-target-candidates?campaignId=${campaignId}&q=${encodeURIComponent(patient.phone ?? '')}`,
      headers: auth(tenant),
    });
    const missing = await getCandidates();
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual([expect.objectContaining({
      id: patient.id,
      voiceAuthorizationReady: false,
      voiceAuthorizationReason: 'consent_missing_or_incompatible',
    })]);

    const grant = await db.receptionistVoiceConsentEvent.create({ data: {
      tenantId: tenant.id,
      patientId: patient.id,
      purpose: 'PATIENT_REACTIVATION',
      granted: true,
      policyVersion: 'REACTIVATION-2026-1',
      disclosureTextHash: 'a'.repeat(64),
      evidenceReference: 'written-consent-802',
      captureMethod: 'written',
      source: 'patient_written',
      jurisdiction: 'NY',
    } });
    const ready = await getCandidates();
    expect(ready.json()).toEqual([expect.objectContaining({
      id: patient.id,
      voiceAuthorizationReady: true,
      voiceAuthorizationReason: 'compatible_immutable_consent',
    })]);

    await db.receptionistVoiceConsentEvent.create({ data: {
      tenantId: tenant.id,
      patientId: patient.id,
      purpose: 'PATIENT_REACTIVATION',
      granted: false,
      policyVersion: 'REACTIVATION-2026-1',
      disclosureTextHash: 'a'.repeat(64),
      evidenceReference: `revocation-of-${grant.id}`,
      captureMethod: 'written',
      source: 'patient_written',
      jurisdiction: 'NY',
    } });
    const revoked = await getCandidates();
    expect(revoked.json()).toEqual([expect.objectContaining({
      id: patient.id,
      voiceAuthorizationReady: false,
      voiceAuthorizationReason: 'consent_missing_or_incompatible',
    })]);
    await expect(db.receptionistVoiceConsentEvent.update({
      where: { id: grant.id }, data: { policyVersion: 'REWRITTEN' },
    })).rejects.toThrow();
  });

  it('enforces exactly one tenant-owned identity and a canonical identity phone at the API and database', async () => {
    const tenant = await makeTenant();
    const otherTenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const patient = await createPatient(tenant, 11);
    const lead = await createLead(tenant, 12);
    const foreignPatient = await createPatient(otherTenant, 13);

    for (const target of [
      { phone: patient.phone },
      { phone: patient.phone, patientId: patient.id, leadId: lead.id },
      { phone: patient.phone, patientId: foreignPatient.id },
      { phone: phoneFor(tenant.id, 99), patientId: patient.id },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`,
        headers: auth(tenant),
        payload: { targets: [target] },
      });
      expect(response.statusCode).toBe(409);
    }

    await expect(db.$executeRaw`
      INSERT INTO "ReceptionistCallTarget" ("id", "tenantId", "campaignId", "phone", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${tenant.id}::uuid, ${campaignId}::uuid, ${phoneFor(tenant.id, 201)}, NOW())
    `).rejects.toThrow();
    await expect(db.$executeRaw`
      INSERT INTO "ReceptionistCallTarget" ("id", "tenantId", "campaignId", "patientId", "leadId", "phone", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${tenant.id}::uuid, ${campaignId}::uuid, ${patient.id}::uuid, ${lead.id}::uuid, ${patient.phone!}, NOW())
    `).rejects.toThrow();
    await expect(db.$executeRaw`
      INSERT INTO "ReceptionistCallTarget" ("id", "tenantId", "campaignId", "patientId", "phone", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${tenant.id}::uuid, ${campaignId}::uuid, ${foreignPatient.id}::uuid, ${foreignPatient.phone!}, NOW())
    `).rejects.toThrow();
  });

  it('rejects duplicate destinations both within a batch and against an existing campaign target', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const patient = await createPatient(tenant, 21);
    const lead = await createLead(tenant, 21);

    const duplicateBatch = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`,
      headers: auth(tenant),
      payload: { targets: [
        { patientId: patient.id, phone: patient.phone },
        { leadId: lead.id, phone: lead.phone },
      ] },
    });
    expect(duplicateBatch.statusCode).toBe(409);
    expect(await db.receptionistCallTarget.count({ where: { tenantId: tenant.id, campaignId } })).toBe(0);

    const first = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`,
      headers: auth(tenant),
      payload: { targets: [{ patientId: patient.id, phone: patient.phone }] },
    });
    expect(first.statusCode).toBe(201);
    const duplicate = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`,
      headers: auth(tenant),
      payload: { targets: [{ leadId: lead.id, phone: lead.phone }] },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(await db.receptionistCallTarget.count({ where: { tenantId: tenant.id, campaignId } })).toBe(1);
  });

  it('does not disclose or mutate campaigns and targets across tenants', async () => {
    const tenant = await makeTenant();
    const otherTenant = await makeTenant();
    const campaignId = await createCampaign(tenant);
    const patient = await createPatient(tenant, 31);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}`,
      headers: auth(otherTenant),
    });
    expect(read.statusCode).toBe(404);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`,
      headers: auth(otherTenant),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
    const add = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/targets`,
      headers: auth(otherTenant),
      payload: { targets: [{ patientId: patient.id, phone: patient.phone }] },
    });
    expect(add.statusCode).toBe(404);
    expect(await db.receptionistCallTarget.count({ where: { tenantId: tenant.id, campaignId } })).toBe(0);
  });
});

describe('AI receptionist outbound provider acceptance safety', () => {
  it('fences a cleared client attempt before dispatch and rejects every late submission', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 680);
    const token = randomUUID();
    const registered = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/launch-attempts`,
      headers: auth(tenant), payload: { token },
    });
    expect(registered.statusCode).toBe(200);
    const cleared = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/launch-attempts/${token}/verify-clear`,
      headers: auth(tenant),
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ cleared: true, proof: 'non_submission_fenced' });

    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', providerFetch);
    const late = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone, clientAttemptToken: token },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ status: 'blocked', reason: 'client_attempt_not_claimable' });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await db.receptionistCallLog.count({ where: { tenantId: tenant.id, outboundCampaignId: campaignId } })).toBe(0);
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('keeps verify-clear blocked when dispatch claims the attempt first, then clears a definitive rejection', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 681);
    const token = randomUUID();
    expect((await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/launch-attempts`,
      headers: auth(tenant), payload: { token },
    })).statusCode).toBe(200);

    const intentCommitted = deferred();
    const release = deferred();
    setProviderBoundaryTestHookForTests(async stage => {
      if (stage === 'provider_intent_committed') {
        intentCommitted.resolve();
        await release.promise;
      }
    });
    const providerFetch = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ message: 'definitive validation rejection' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', providerFetch);
    const call = app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`, headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone, clientAttemptToken: token },
    });
    await intentCommitted.promise;
    const inFlight = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/launch-attempts/${token}/verify-clear`,
      headers: auth(tenant),
    });
    expect(inFlight.statusCode).toBe(200);
    expect(inFlight.json()).toMatchObject({ cleared: false, proof: 'call_not_terminal', callLogId: expect.any(String) });

    release.resolve();
    const response = await call;
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ status: 'failed', error: 'retell_error_422' });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const afterDefinitiveRejection = await app.inject({
      method: 'POST', url: `/v1/receptionist/outbound-campaigns/${campaignId}/launch-attempts/${token}/verify-clear`,
      headers: auth(tenant),
    });
    expect(afterDefinitiveRejection.statusCode).toBe(200);
    expect(afterDefinitiveRejection.json()).toMatchObject({
      cleared: true, proof: 'durable_terminal_reconciliation', callLogId: expect.any(String),
    });
    const reconciliation = await app.inject({
      method: 'GET', url: `/v1/receptionist/outbound-campaigns/${campaignId}/reconciliations`,
      headers: auth(tenant),
    });
    expect(reconciliation.statusCode).toBe(200);
    expect(reconciliation.json()).toEqual([]);
  }, 30_000);

  it.each([408, 409, 425, 429, 500, 503])(
    'treats provider HTTP %i as ambiguous, requires reconciliation, and makes the target non-dialable',
    async statusCode => {
      const tenant = await makeTenant();
      const campaignId = await createCampaign(tenant, { status: 'RUNNING', maxRetryAttempts: 3 });
      const target = await addPatientTarget(tenant, campaignId, statusCode);
      const providerFetch = vi.fn<typeof fetch>(async () => new Response(
        JSON.stringify({ message: 'provider did not give a definitive rejection' }),
        { status: statusCode, headers: { 'content-type': 'application/json' } },
      ));
      vi.stubGlobal('fetch', providerFetch);

      const first = await app.inject({
        method: 'POST',
        url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
        headers: auth(tenant),
        payload: { targetId: target.id, phone: target.phone },
      });
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({
        status: 'reconciliation_required',
        error: `retell_error_${statusCode}`,
        reviewRecorded: true,
        signalRecorded: true,
      });
      expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        lastOutcome: 'RECONCILIATION_REQUIRED',
      });
      expect(await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: tenant.id, targetId: target.id } })).toMatchObject({
        outcome: 'ESCALATED',
      });

      const providerCalls = providerFetch.mock.calls.length;
      const retry = await app.inject({
        method: 'POST',
        url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
        headers: auth(tenant),
        payload: { targetId: target.id, phone: target.phone },
      });
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toMatchObject({ status: 'blocked', reason: 'target_not_dialable' });
      expect(providerFetch).toHaveBeenCalledTimes(providerCalls);
      vi.unstubAllGlobals();
    },
    30_000,
  );

  it.each([400, 401, 403, 404, 422])(
    'treats provider HTTP %i as a definitive rejection and retains bounded retry semantics',
    async statusCode => {
      const tenant = await makeTenant();
      const campaignId = await createCampaign(tenant, { status: 'RUNNING', maxRetryAttempts: 1 });
      const target = await addPatientTarget(tenant, campaignId, 100 + statusCode);
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
        JSON.stringify({ message: 'request rejected' }),
        { status: statusCode, headers: { 'content-type': 'application/json' } },
      )));

      const response = await app.inject({
        method: 'POST',
        url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
        headers: auth(tenant),
        payload: { targetId: target.id, phone: target.phone },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ status: 'failed', error: `retell_error_${statusCode}` });
      expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastOutcome: 'FAILED',
      });
      expect(await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: tenant.id, targetId: target.id } })).toMatchObject({
        outcome: 'FAILED',
      });
      vi.unstubAllGlobals();
    },
    30_000,
  );
});

describe('AI receptionist outbound regression safety controls', () => {
  it('enforces tenant concurrency and voice-minute capacity before claiming a target', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 701);
    await db.receptionistCallLog.createMany({
      data: [1, 2, 3].map(suffix => ({
        tenantId: tenant.id,
        clinicId: tenant.clinicId,
        outboundCampaignId: campaignId,
        callerPhone: phoneFor(tenant.id, 710 + suffix),
        direction: 'outbound',
        outcome: 'IN_PROGRESS',
      })),
    });

    const atCapacity = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
      headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    expect(atCapacity.statusCode).toBe(429);
    expect(atCapacity.json()).toMatchObject({ status: 'blocked', reason: 'concurrency_limit_reached' });
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'PENDING', attempts: 0,
    });

    await db.receptionistCallLog.updateMany({
      where: { tenantId: tenant.id, outcome: 'IN_PROGRESS' },
      data: { outcome: 'FAILED', endedAt: new Date() },
    });
    await db.tenantUsageLimit.upsert({
      where: { tenantId_key: { tenantId: tenant.id, key: 'voice_minutes' } },
      update: { used: 1, limitValue: 1 },
      create: { tenantId: tenant.id, key: 'voice_minutes', used: 1, limitValue: 1 },
    });
    const minutesExhausted = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
      headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    expect(minutesExhausted.statusCode).toBe(402);
    expect(minutesExhausted.json()).toMatchObject({ status: 'blocked', reason: 'voice_minutes_limit_reached' });
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'PENDING', attempts: 0,
    });
  });

  it('applies the emergency stop, attempts active-call cancellation, and blocks new calls', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING' });
    const target = await addPatientTarget(tenant, campaignId, 721);
    await db.receptionistCallLog.create({
      data: {
        tenantId: tenant.id,
        clinicId: tenant.clinicId,
        outboundCampaignId: campaignId,
        callerPhone: target.phone,
        direction: 'outbound',
        retellCallId: `mock-active-${randomUUID()}`,
        outcome: 'IN_PROGRESS',
      },
    });
    const currentKey = env.RETELL_API_KEY;
    env.RETELL_API_KEY = 'mock_stop_control';
    try {
      const stopped = await app.inject({
        method: 'POST',
        url: '/v1/receptionist/outbound-control',
        headers: auth(tenant),
        payload: { stopped: true, reason: 'Pilot emergency stop regression test' },
      });
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json()).toMatchObject({
        stopped: true,
        activeCancellation: { requested: 1, confirmed: 0, failed: 0, unconfirmed: 1 },
      });

      const blocked = await app.inject({
        method: 'POST',
        url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
        headers: auth(tenant),
        payload: { targetId: target.id, phone: target.phone },
      });
      expect(blocked.statusCode).toBe(423);
      expect(blocked.json()).toMatchObject({ status: 'blocked', reason: 'outbound_stopped' });

      const tenantResume = await app.inject({
        method: 'POST',
        url: '/v1/receptionist/outbound-control',
        headers: auth(tenant),
        payload: { stopped: false, reason: 'Tenant must not clear the global stop' },
      });
      expect(tenantResume.statusCode).toBe(400);
    } finally {
      env.RETELL_API_KEY = currentKey;
      await db.tenantAiUsage.update({
        where: { tenantId: tenant.id },
        data: { killSwitch: false, killSwitchReason: null },
      });
    }
  });

  it('trips the deployment circuit, pauses same-agent campaigns, and records review evidence', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING', maxRetryAttempts: 0 });
    const relatedScheduledId = await createCampaign(tenant, { status: 'SCHEDULED' });
    const relatedDraftId = await createCampaign(tenant);
    const studioAuthority = await createDirectAuthority(tenant);
    const target = await addPatientTarget(tenant, campaignId, 741);
    const providerCallId = `provider-mismatch-${randomUUID()}`;
    const providerFetch = vi.fn<typeof fetch>(async url => String(url).includes('/v2/create-phone-call')
      ? new Response(JSON.stringify({ call_id: providerCallId, agent_id: 'agent_wrong', agent_version: 1 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
      : new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', providerFetch);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
      headers: auth(tenant),
      payload: { targetId: target.id, phone: target.phone },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      status: 'failed', error: 'retell_deployment_mismatch', reviewRecorded: true, signalRecorded: true,
    });
    expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: tenant.agentId } })).toMatchObject({
      providerStatus: 'INVALID', providerLastErrorCode: 'provider_deployment_mismatch',
    });
    expect(await db.receptionistOutboundCampaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ status: 'PAUSED' });
    expect(await db.receptionistOutboundCampaign.findUniqueOrThrow({ where: { id: relatedScheduledId } })).toMatchObject({ status: 'PAUSED' });
    expect(await db.receptionistOutboundCampaign.findUniqueOrThrow({ where: { id: relatedDraftId } })).toMatchObject({ status: 'DRAFT' });
    expect(await db.receptionistCampaign.findUniqueOrThrow({ where: { id: studioAuthority.id } })).toMatchObject({ status: 'PAUSED' });
    expect(await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: tenant.id, targetId: target.id } })).toMatchObject({
      retellCallId: providerCallId, outcome: 'FAILED',
    });
    expect(await db.receptionistCallTarget.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: 'FAILED' });
    expect(await db.staffTask.findUniqueOrThrow({ where: { id: response.json().reviewTaskId } })).toMatchObject({
      priority: 'CRITICAL',
      metadata: expect.objectContaining({ requiresAcknowledgement: true, providerStopApplied: true }),
    });
    expect(await db.operationalSignal.findUniqueOrThrow({ where: { id: response.json().signalId } })).toMatchObject({
      signalType: 'receptionist_provider_deployment_mismatch', severity: 'critical', status: 'open',
    });
    expect(providerFetch).toHaveBeenLastCalledWith(
      `${env.RETELL_BASE_URL}/v2/stop-call/${providerCallId}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps the circuit fail-closed and writes truthful fallback review evidence when audit persistence fails', async () => {
    const tenant = await makeTenant();
    const campaignId = await createCampaign(tenant, { status: 'RUNNING', maxRetryAttempts: 0 });
    const target = await addPatientTarget(tenant, campaignId, 751);
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION receptionist_outbound_audit_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW."tenantId" = '${tenant.id}'::uuid
          AND NEW."action" = 'receptionist.agentDeploymentSafetyCircuitTripped' THEN
          RAISE EXCEPTION 'injected outbound audit persistence failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER receptionist_outbound_audit_failure_trigger
      BEFORE INSERT ON "AuditEvent"
      FOR EACH ROW EXECUTE FUNCTION receptionist_outbound_audit_failure();
    `);
    const providerCallId = `provider-degraded-${randomUUID()}`;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => String(url).includes('/v2/create-phone-call')
      ? new Response(JSON.stringify({ call_id: providerCallId, agent_id: 'agent_wrong', agent_version: 1 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
      : new Response(null, { status: 204 })));

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/receptionist/outbound-campaigns/${campaignId}/call`,
        headers: auth(tenant),
        payload: { targetId: target.id, phone: target.phone },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        error: 'retell_deployment_mismatch', reviewRecorded: true, signalRecorded: true,
      });
      expect(await db.receptionistAgent.findUniqueOrThrow({ where: { id: tenant.agentId } })).toMatchObject({
        providerStatus: 'INVALID', providerLastErrorCode: 'provider_deployment_mismatch',
      });
      expect(await db.receptionistOutboundCampaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ status: 'PAUSED' });
      expect(await db.staffTask.findUniqueOrThrow({ where: { id: response.json().reviewTaskId } })).toMatchObject({
        metadata: expect.objectContaining({ reviewPersistenceDegraded: true, signalPersistencePending: false }),
      });
    } finally {
      await db.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS receptionist_outbound_audit_failure_trigger ON "AuditEvent";
        DROP FUNCTION IF EXISTS receptionist_outbound_audit_failure();
      `);
    }
  });

  it('accounts outbound voice minutes once on replay and opts out the destination, not the clinic line', async () => {
    const tenant = await makeTenant();
    const callId = `outbound-usage-${randomUUID()}`;
    const destination = phoneFor(tenant.id, 771);
    await db.receptionistCallLog.create({
      data: {
        tenantId: tenant.id,
        clinicId: tenant.clinicId,
        retellCallId: callId,
        callerPhone: destination,
        direction: 'outbound',
        outcome: 'IN_PROGRESS',
        durationSeconds: 0,
      },
    });
    const currentKey = env.RETELL_API_KEY;
    env.RETELL_API_KEY = 'retell_outbound_usage_secret';
    try {
      const raw = JSON.stringify({
        event: 'call_ended',
        call: {
          call_id: callId,
          direction: 'outbound',
          from_number: '+15550000001',
          to_number: destination,
          duration_ms: 61_000,
          call_analysis: { custom_analysis_data: { outcome: 'OPTED_OUT' } },
        },
      });
      const signature = signRetell(raw, env.RETELL_API_KEY);
      const send = () => app.inject({
        method: 'POST',
        url: `/v1/receptionist/webhooks/retell?clinicId=${tenant.clinicId}`,
        headers: { 'content-type': 'application/json', 'x-retell-signature': signature },
        payload: raw,
      });
      expect((await send()).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(200);
      expect(await db.tenantAiUsage.findUniqueOrThrow({ where: { tenantId: tenant.id } })).toMatchObject({ receptionistMinutes: 2 });
      expect(await db.tenantUsageLimit.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: tenant.id, key: 'voice_minutes' } },
      })).toMatchObject({ used: 2 });
      expect(await db.receptionistOptOut.findFirstOrThrow({ where: { tenantId: tenant.id } })).toMatchObject({
        contactPhone: destination, channel: 'ALL',
      });
      expect(await db.receptionistOptOut.count({ where: { tenantId: tenant.id, contactPhone: '+15550000001' } })).toBe(0);
    } finally {
      env.RETELL_API_KEY = currentKey;
    }
  });
});
