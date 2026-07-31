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
const { env } = await import('../config/env');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { authorizeOutboundProviderIntentTx } = await import('../lib/receptionist/dncFence');
const { sendAuthorizedAppointmentConfirmation } = await import('../lib/commsProvider');
const { runWithJobTenantContext } = await import('../lib/tenantContext');

const describeDisposable = process.env.RLS_DISPOSABLE_DB ? describe : describe.skip;
const DISCLOSURE_HASH = 'a'.repeat(64);

type Fixture = Awaited<ReturnType<typeof fixture>>;
let app: FastifyInstance;

function phoneFor(seed: string, suffix = 0): string {
  const digits = BigInt(`0x${seed.replaceAll('-', '').slice(0, 14)}`) % 9_000_000_000n;
  return `+1${(digits + 1_000_000_000n + BigInt(suffix)).toString().slice(-10)}`;
}

async function fixture() {
  const tenantId = randomUUID();
  await db.tenant.create({ data: { id: tenantId, name: `Integrity ${tenantId.slice(0, 8)}`, slug: `integrity-${tenantId.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId, featureKey: 'campaign_automation', enabled: true, source: 'test' } });
  const branch = await db.branch.create({ data: { tenantId, name: 'Integrity branch', location: 'Test', timezone: 'UTC' } });
  const users = Object.fromEntries(await Promise.all((['OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'BILLING'] as const).map(async role => {
    const user = await db.user.create({ data: {
      tenantId, branchId: branch.id, role, active: true,
      email: `${role.toLowerCase()}-${tenantId.slice(0, 8)}@integrity.test`, displayName: `${role} user`,
    } });
    return [role, user] as const;
  }))) as unknown as Record<'OWNER' | 'ADMIN' | 'MANAGER' | 'FRONT_DESK' | 'BILLING', { id: string }>;
  const clinic = await db.receptionistClinic.create({ data: {
    tenantId, name: 'Integrity clinic', phone: phoneFor(tenantId), timezone: 'UTC',
  } });
  const patient = await db.patient.create({ data: {
    tenantId, branchId: branch.id, firstName: 'Consent', lastName: 'Patient',
    phone: phoneFor(tenantId, 1), lifecycleStage: 'ACTIVE',
  } });
  return { tenantId, branch, users, clinic, patient };
}

function auth(item: Fixture, role: keyof Fixture['users']) {
  return { authorization: `Bearer ${app.jwt.sign({
    userId: item.users[role].id, tenantId: item.tenantId, role, type: 'access',
  })}` };
}

function staffVoicePayload(item: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    patientId: item.patient.id, channel: 'voice', status: 'opted_in',
    purpose: 'PATIENT_REACTIVATION', policyVersion: 'voice-policy-v1',
    disclosureTextHash: DISCLOSURE_HASH, evidenceReference: `recording:${randomUUID()}`,
    captureMethod: 'staff_attestation', evidenceSource: 'staff_attested', jurisdiction: 'US-NY',
    ...overrides,
  };
}

async function outboundFixture(item: Fixture, patientId = item.patient.id, phone = item.patient.phone!) {
  const campaign = await db.receptionistOutboundCampaign.create({ data: {
    tenantId: item.tenantId, clinicId: item.clinic.id, name: `Campaign ${randomUUID()}`,
    script: 'Approved script', requiredFields: [], status: 'RUNNING',
    purpose: 'PATIENT_REACTIVATION', legalBasis: 'EXPLICIT_CONSENT', policyVersion: 'voice-policy-v1',
    authorityApprovedAt: new Date(), authorityApprovedById: item.users.OWNER.id,
    authorityFingerprint: 'f'.repeat(64), defaultBranchId: item.branch.id,
  } });
  const target = await db.receptionistCallTarget.create({ data: {
    tenantId: item.tenantId, campaignId: campaign.id, patientId, phone, status: 'CALLING', attempts: 1,
  } });
  const call = await db.receptionistCallLog.create({ data: {
    tenantId: item.tenantId, clinicId: item.clinic.id, outboundCampaignId: campaign.id,
    targetId: target.id, callerPhone: phone, direction: 'outbound', outcome: 'IN_PROGRESS', startedAt: new Date(),
  } });
  return { campaign, target, call };
}

describeDisposable('receptionist delivery/consent database integrity', () => {
  beforeAll(async () => { app = await buildApp(); await app.ready(); });
  afterAll(async () => { await app.close(); await db.$disconnect(); });

  it('authorizes staff evidence by role/method and atomically persists event + audit + business evidence', async () => {
    const item = await fixture();
    const billing = await app.inject({ method: 'POST', url: '/v1/crm/consent', headers: auth(item, 'BILLING'), payload: staffVoicePayload(item) });
    expect(billing.statusCode).toBe(403);
    const managerImport = await app.inject({ method: 'POST', url: '/v1/crm/consent', headers: auth(item, 'MANAGER'), payload: staffVoicePayload(item, {
      captureMethod: 'import_verified', evidenceSource: 'verified_import',
    }) });
    expect(managerImport.statusCode).toBe(403);
    const forgedSource = await app.inject({ method: 'POST', url: '/v1/crm/consent', headers: auth(item, 'OWNER'), payload: staffVoicePayload(item, {
      captureMethod: 'written', evidenceSource: 'staff_attested',
    }) });
    expect(forgedSource.statusCode).toBe(400);

    const granted = await app.inject({ method: 'POST', url: '/v1/crm/consent', headers: auth(item, 'FRONT_DESK'), payload: staffVoicePayload(item) });
    expect(granted.statusCode).toBe(201);
    const eventId = granted.json().voiceEvent.id as string;
    await expect(db.receptionistVoiceConsentEvent.findUniqueOrThrow({ where: { id: eventId } })).resolves.toMatchObject({
      tenantId: item.tenantId, patientId: item.patient.id, granted: true,
      purpose: 'PATIENT_REACTIVATION', policyVersion: 'voice-policy-v1', source: 'staff_attested',
      actorUserId: item.users.FRONT_DESK.id,
    });
    expect(await db.auditEvent.count({ where: { tenantId: item.tenantId, resourceId: eventId, action: 'receptionist.voiceConsent.granted' } })).toBe(1);
    expect(await db.businessEvent.count({ where: { tenantId: item.tenantId, entityId: eventId, eventType: 'receptionist.voice_consent.granted' } })).toBe(1);
  });

  it('rolls back voice evidence when mandatory business evidence fails', async () => {
    const item = await fixture();
    const evidenceReference = `rollback:${randomUUID()}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION test_fail_voice_business_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."eventType" LIKE 'receptionist.voice_consent.%' THEN RAISE EXCEPTION 'injected business evidence failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_voice_business_event_trg BEFORE INSERT ON "BusinessEvent"
      FOR EACH ROW EXECUTE FUNCTION test_fail_voice_business_event();
    `);
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/crm/consent', headers: auth(item, 'OWNER'), payload: staffVoicePayload(item, { evidenceReference }) });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(await db.receptionistVoiceConsentEvent.count({ where: { tenantId: item.tenantId, evidenceReference } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_voice_business_event_trg ON "BusinessEvent"; DROP FUNCTION IF EXISTS test_fail_voice_business_event();');
    }
  });

  it('enforces immutable exact voice evidence and rejects forged method/source, actor, tenant, and identity shapes in raw SQL', async () => {
    const item = await fixture();
    const other = await fixture();
    const base = {
      tenantId: item.tenantId, patientId: item.patient.id, purpose: 'PATIENT_REACTIVATION', granted: true,
      policyVersion: 'voice-policy-v1', disclosureTextHash: DISCLOSURE_HASH,
      evidenceReference: `written:${randomUUID()}`, captureMethod: 'written', source: 'patient_written', jurisdiction: 'US-NY',
    } as const;
    const event = await db.receptionistVoiceConsentEvent.create({ data: base });
    await expect(db.receptionistVoiceConsentEvent.update({ where: { id: event.id }, data: { granted: false } })).rejects.toThrow(/append-only/i);
    await expect(db.receptionistVoiceConsentEvent.delete({ where: { id: event.id } })).rejects.toThrow(/append-only/i);
    await expect(db.receptionistVoiceConsentEvent.create({ data: { ...base, id: randomUUID(), evidenceReference: `bad:${randomUUID()}`, captureMethod: 'staff_attestation', source: 'staff_attested' } })).rejects.toThrow(/actor/i);
    await expect(db.receptionistVoiceConsentEvent.create({ data: { ...base, id: randomUUID(), evidenceReference: `bad:${randomUUID()}`, captureMethod: 'written', source: 'staff_attested' } })).rejects.toThrow(/method_source|check constraint/i);
    await expect(db.receptionistVoiceConsentEvent.create({ data: { ...base, id: randomUUID(), tenantId: other.tenantId, evidenceReference: `cross:${randomUUID()}` } })).rejects.toThrow(/foreign key/i);
    await expect(db.receptionistVoiceConsentEvent.create({ data: { ...base, id: randomUUID(), leadId: randomUUID(), evidenceReference: `both:${randomUUID()}` } })).rejects.toThrow(/check constraint/i);
  });

  it('requires the latest unexpired exact-purpose/policy grant and preserves revocation precedence', async () => {
    const item = await fixture();
    const outbound = await outboundFixture(item);
    const grant = await db.receptionistVoiceConsentEvent.create({ data: {
      tenantId: item.tenantId, patientId: item.patient.id, purpose: 'PATIENT_REACTIVATION', granted: true,
      policyVersion: 'voice-policy-v1', disclosureTextHash: DISCLOSURE_HASH,
      evidenceReference: `grant:${randomUUID()}`, captureMethod: 'staff_attestation', source: 'staff_attested',
      actorUserId: item.users.OWNER.id, jurisdiction: 'US-NY', occurredAt: new Date(Date.now() - 2_000),
    } });
    const intent = await db.$transaction(tx => authorizeOutboundProviderIntentTx(tx, {
      tenantId: item.tenantId, callLogId: outbound.call.id, outboundCampaignId: outbound.campaign.id,
      targetId: outbound.target.id, destination: item.patient.phone!, purpose: 'PATIENT_REACTIVATION',
      policyVersion: 'voice-policy-v1', legalBasis: 'EXPLICIT_CONSENT',
    }));
    expect(intent.voiceConsentEventId).toBe(grant.id);

    await db.receptionistVoiceConsentEvent.create({ data: {
      tenantId: item.tenantId, patientId: item.patient.id, purpose: 'PATIENT_REACTIVATION', granted: false,
      policyVersion: 'voice-policy-v1', disclosureTextHash: DISCLOSURE_HASH,
      evidenceReference: `revoke:${randomUUID()}`, captureMethod: 'staff_attestation', source: 'staff_attested',
      actorUserId: item.users.OWNER.id, jurisdiction: 'US-NY', occurredAt: new Date(),
    } });
    const next = await db.receptionistCallLog.create({ data: {
      tenantId: item.tenantId, clinicId: item.clinic.id, outboundCampaignId: outbound.campaign.id,
      targetId: outbound.target.id, callerPhone: item.patient.phone, direction: 'outbound', outcome: 'IN_PROGRESS', startedAt: new Date(),
    } });
    await expect(db.$transaction(tx => authorizeOutboundProviderIntentTx(tx, {
      tenantId: item.tenantId, callLogId: next.id, outboundCampaignId: outbound.campaign.id,
      targetId: outbound.target.id, destination: item.patient.phone!, purpose: 'PATIENT_REACTIVATION',
      policyVersion: 'voice-policy-v1', legalBasis: 'EXPLICIT_CONSENT',
    }))).rejects.toThrow(/consent_missing/i);

    const wrongPolicy = await outboundFixture(item, item.patient.id, item.patient.phone!);
    await expect(db.$transaction(tx => authorizeOutboundProviderIntentTx(tx, {
      tenantId: item.tenantId, callLogId: wrongPolicy.call.id, outboundCampaignId: wrongPolicy.campaign.id,
      targetId: wrongPolicy.target.id, destination: item.patient.phone!, purpose: 'PATIENT_REACTIVATION',
      policyVersion: 'voice-policy-v2', legalBasis: 'EXPLICIT_CONSENT',
    }))).rejects.toThrow(/consent_missing|campaign authority/i);

    const expiredPatient = await db.patient.create({ data: {
      tenantId: item.tenantId, branchId: item.branch.id, firstName: 'Expired', lastName: 'Consent',
      phone: phoneFor(item.tenantId, 20), lifecycleStage: 'ACTIVE',
    } });
    const expiredOutbound = await outboundFixture(item, expiredPatient.id, expiredPatient.phone!);
    await db.receptionistVoiceConsentEvent.create({ data: {
      tenantId: item.tenantId, patientId: expiredPatient.id, purpose: 'PATIENT_REACTIVATION', granted: true,
      policyVersion: 'voice-policy-v1', disclosureTextHash: DISCLOSURE_HASH,
      evidenceReference: `expired:${randomUUID()}`, captureMethod: 'staff_attestation', source: 'staff_attested',
      actorUserId: item.users.OWNER.id, jurisdiction: 'US-NY',
      occurredAt: new Date(Date.now() - 48 * 60 * 60_000), expiresAt: new Date(Date.now() - 24 * 60 * 60_000),
    } });
    await expect(db.$transaction(tx => authorizeOutboundProviderIntentTx(tx, {
      tenantId: item.tenantId, callLogId: expiredOutbound.call.id, outboundCampaignId: expiredOutbound.campaign.id,
      targetId: expiredOutbound.target.id, destination: expiredPatient.phone!, purpose: 'PATIENT_REACTIVATION',
      policyVersion: 'voice-policy-v1', legalBasis: 'EXPLICIT_CONSENT',
    }))).rejects.toThrow(/consent_missing/i);

    const tiedPatient = await db.patient.create({ data: {
      tenantId: item.tenantId, branchId: item.branch.id, firstName: 'Tied', lastName: 'Consent',
      phone: phoneFor(item.tenantId, 21), lifecycleStage: 'ACTIVE',
    } });
    const tiedOutbound = await outboundFixture(item, tiedPatient.id, tiedPatient.phone!);
    const tiedAt = new Date(Date.now() - 1_000);
    await db.receptionistVoiceConsentEvent.createMany({ data: [
      {
        tenantId: item.tenantId, patientId: tiedPatient.id, purpose: 'PATIENT_REACTIVATION', granted: true,
        policyVersion: 'voice-policy-v1', disclosureTextHash: DISCLOSURE_HASH,
        evidenceReference: `tie-grant:${randomUUID()}`, captureMethod: 'staff_attestation', source: 'staff_attested',
        actorUserId: item.users.OWNER.id, jurisdiction: 'US-NY', occurredAt: tiedAt,
      },
      {
        tenantId: item.tenantId, patientId: tiedPatient.id, purpose: 'PATIENT_REACTIVATION', granted: false,
        policyVersion: 'voice-policy-v1', disclosureTextHash: DISCLOSURE_HASH,
        evidenceReference: `tie-revoke:${randomUUID()}`, captureMethod: 'staff_attestation', source: 'staff_attested',
        actorUserId: item.users.OWNER.id, jurisdiction: 'US-NY', occurredAt: tiedAt,
      },
    ] });
    await expect(db.$transaction(tx => authorizeOutboundProviderIntentTx(tx, {
      tenantId: item.tenantId, callLogId: tiedOutbound.call.id, outboundCampaignId: tiedOutbound.campaign.id,
      targetId: tiedOutbound.target.id, destination: tiedPatient.phone!, purpose: 'PATIENT_REACTIVATION',
      policyVersion: 'voice-policy-v1', legalBasis: 'EXPLICIT_CONSENT',
    }))).rejects.toThrow(/consent_missing/i);
  });

  it('enforces default-branch and exact campaign/target/call tenant ownership before provider intent', async () => {
    const item = await fixture();
    const other = await fixture();
    await expect(db.receptionistOutboundCampaign.create({ data: {
      tenantId: item.tenantId, clinicId: item.clinic.id, name: `Cross branch ${randomUUID()}`,
      script: 'No', requiredFields: [], defaultBranchId: other.branch.id,
    } })).rejects.toThrow(/foreign key/i);

    const first = await outboundFixture(item);
    const second = await outboundFixture(item);
    await expect(db.receptionistCallLog.create({ data: {
      tenantId: item.tenantId, clinicId: item.clinic.id, outboundCampaignId: first.campaign.id,
      targetId: second.target.id, callerPhone: item.patient.phone, direction: 'outbound', outcome: 'IN_PROGRESS',
    } })).rejects.toThrow(/foreign key/i);
    await expect(db.receptionistCallTarget.create({ data: {
      tenantId: other.tenantId, campaignId: first.campaign.id, patientId: other.patient.id,
      phone: other.patient.phone!, status: 'CALLING',
    } })).rejects.toThrow(/foreign key/i);
  });

  it('orders DNC before/after provider intent and blocks every future intent after opt-out', async () => {
    const item = await fixture();
    const outbound = await outboundFixture(item);
    await db.receptionistVoiceConsentEvent.create({ data: {
      tenantId: item.tenantId, patientId: item.patient.id, purpose: 'PATIENT_REACTIVATION', granted: true,
      policyVersion: 'voice-policy-v1', disclosureTextHash: DISCLOSURE_HASH,
      evidenceReference: `grant:${randomUUID()}`, captureMethod: 'staff_attestation', source: 'staff_attested',
      actorUserId: item.users.OWNER.id, jurisdiction: 'US-NY',
    } });
    await db.receptionistOptOut.create({ data: {
      tenantId: item.tenantId, contactPhone: item.patient.phone, channel: 'VOICE', reason: 'DNC committed first',
    } });
    await expect(db.$transaction(tx => authorizeOutboundProviderIntentTx(tx, {
      tenantId: item.tenantId, callLogId: outbound.call.id, outboundCampaignId: outbound.campaign.id,
      targetId: outbound.target.id, destination: item.patient.phone!, purpose: 'PATIENT_REACTIVATION',
      policyVersion: 'voice-policy-v1', legalBasis: 'EXPLICIT_CONSENT',
    }))).rejects.toThrow(/suppressed/i);

    const secondPatient = await db.patient.create({ data: {
      tenantId: item.tenantId, branchId: item.branch.id, firstName: 'Second', lastName: 'Patient',
      phone: phoneFor(item.tenantId, 2), lifecycleStage: 'ACTIVE',
    } });
    const second = await outboundFixture(item, secondPatient.id, secondPatient.phone!);
    await db.receptionistVoiceConsentEvent.create({ data: {
      tenantId: item.tenantId, patientId: secondPatient.id, purpose: 'PATIENT_REACTIVATION', granted: true,
      policyVersion: 'voice-policy-v1', disclosureTextHash: DISCLOSURE_HASH,
      evidenceReference: `grant:${randomUUID()}`, captureMethod: 'staff_attestation', source: 'staff_attested',
      actorUserId: item.users.OWNER.id, jurisdiction: 'US-NY',
    } });
    await expect(db.$transaction(tx => authorizeOutboundProviderIntentTx(tx, {
      tenantId: item.tenantId, callLogId: second.call.id, outboundCampaignId: second.campaign.id,
      targetId: second.target.id, destination: secondPatient.phone!, purpose: 'PATIENT_REACTIVATION',
      policyVersion: 'voice-policy-v1', legalBasis: 'EXPLICIT_CONSENT',
    }))).resolves.toMatchObject({ callLogId: second.call.id });
    await expect(db.receptionistOptOut.create({ data: {
      tenantId: item.tenantId, contactPhone: secondPatient.phone, channel: 'VOICE', reason: 'DNC ordered after intent',
    } })).resolves.toMatchObject({ tenantId: item.tenantId });
    const future = await db.receptionistCallLog.create({ data: {
      tenantId: item.tenantId, clinicId: item.clinic.id, outboundCampaignId: second.campaign.id,
      targetId: second.target.id, callerPhone: secondPatient.phone, direction: 'outbound', outcome: 'IN_PROGRESS', startedAt: new Date(),
    } });
    await expect(db.$transaction(tx => authorizeOutboundProviderIntentTx(tx, {
      tenantId: item.tenantId, callLogId: future.id, outboundCampaignId: second.campaign.id,
      targetId: second.target.id, destination: secondPatient.phone!, purpose: 'PATIENT_REACTIVATION',
      policyVersion: 'voice-policy-v1', legalBasis: 'EXPLICIT_CONSENT',
    }))).rejects.toThrow(/suppressed/i);
  });

  it('allows the suppression-free provider path only for an exact live confirmation intent with no result', async () => {
    const item = await fixture();
    const startsAt = new Date(Date.now() + 60 * 60_000);
    const appointment = await db.appointment.create({ data: {
      tenantId: item.tenantId, branchId: item.branch.id, patientId: item.patient.id,
      service: 'Confirmation authorization', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: 'CONFIRMED', channel: 'CALL',
    } });
    const event = await db.notificationEvent.create({ data: {
      tenantId: item.tenantId, appointmentId: appointment.id, patientId: item.patient.id,
      recipientType: 'patient', channel: 'sms', status: 'queued', source: 'receptionist.appointment_confirmation',
      idempotencyKey: `${appointment.id}:sms`, consentResult: 'not_recorded_transactional',
    } });
    await db.notificationDeliveryAttempt.create({ data: {
      tenantId: item.tenantId, notificationEventId: event.id, attemptNumber: 1, phase: 'INTENT', status: 'started',
    } });
    await db.notificationEvent.update({ where: { id: event.id }, data: { status: 'retrying', attempts: 1, nextAttemptAt: null } });
    await db.notificationDeliveryAttempt.create({ data: {
      tenantId: item.tenantId, notificationEventId: event.id, attemptNumber: 1,
      phase: 'PROVIDER_INTENT', status: 'provider_intent_committed', completedAt: new Date(),
    } });
    await db.receptionistOptOut.create({ data: {
      tenantId: item.tenantId, contactPhone: item.patient.phone, channel: 'SMS', reason: 'DNC ordered after confirmation intent',
    } });

    const previous = {
      sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM_NUMBER,
    };
    env.TWILIO_ACCOUNT_SID = 'mock_confirmation_authorization';
    env.TWILIO_AUTH_TOKEN = 'mock_confirmation_authorization';
    env.TWILIO_FROM_NUMBER = '+15555550199';
    try {
      const authorizedSend = (destination: string, body: string) => runWithJobTenantContext(
        item.tenantId,
        () => sendAuthorizedAppointmentConfirmation(
          'sms', destination, 'Confirmed', body, `${appointment.id}:sms`,
          { tenantId: item.tenantId, eventId: event.id, attemptNumber: 1 },
        ),
        'worker:test-authorized-confirmation',
      );
      await expect(authorizedSend(item.patient.phone!, 'Exact authorized body')).resolves.toMatchObject({ status: 'sent', mode: 'mock_dev' });
      await expect(authorizedSend('+15555550198', 'Wrong destination')).resolves.toMatchObject({ status: 'failed', failureReason: 'durable_authorization_invalid' });

      await db.notificationDeliveryAttempt.create({ data: {
        tenantId: item.tenantId, notificationEventId: event.id, attemptNumber: 1,
        phase: 'RESULT', status: 'failed', provider: 'configured_pending',
        failureCode: 'provider_not_submitted', completedAt: new Date(),
      } });
      await expect(authorizedSend(item.patient.phone!, 'Already finalized')).resolves.toMatchObject({ status: 'failed', failureReason: 'durable_authorization_invalid' });
    } finally {
      env.TWILIO_ACCOUNT_SID = previous.sid;
      env.TWILIO_AUTH_TOKEN = previous.token;
      env.TWILIO_FROM_NUMBER = previous.from;
    }
  });
});
