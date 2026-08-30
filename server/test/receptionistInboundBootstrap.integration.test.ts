import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { env } = await import('../config/env');
const { disclosureEvidenceHash, renderRecordingDisclosure } = await import('../lib/receptionist/privacyLifecycle');
const { MAX_TENANT_ACTIVE_CALLS } = await import('../modules/receptionist/outbound');
const { DEGRADED_SAFE_TOOLS } = await import('../lib/receptionist/agentReadiness');
const { platformLocalePack } = await import('../lib/receptionist/localePacks/defaults');
const { renderPackMessage } = await import('../lib/receptionist/localePacks/render');

const KEY = 'retell-first-inbound-bootstrap-key';
const originalKey = env.RETELL_API_KEY;
const tenantIds: string[] = [];
let app: FastifyInstance;
function randomE164() {
  const suffix = (Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 12), 16) % 10_000_000).toString().padStart(7, '0');
  return `+1212${suffix}`;
}

interface TenantOptions {
  entitled?: boolean;
  /** Clinic jurisdiction. Drives which locale pack a live caller is spoken to from. */
  locale?: { country: string; language: string; timezone: string };
  /** How stale the agent's verification is, in hours. 0 keeps it verified. */
  verificationAgeHours?: number;
}

async function tenant(phone = randomE164(), options: TenantOptions | boolean = {}) {
  const opts: TenantOptions = typeof options === 'boolean' ? { entitled: options } : options;
  const entitled = opts.entitled ?? true;
  const locale = opts.locale ?? { country: 'US', language: 'en-US', timezone: 'America/New_York' };
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Inbound ${id.slice(0, 8)}`, slug: `inbound-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: entitled, source: 'test' } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Trusted destination', phone, active: true, country: locale.country, timezone: locale.timezone, defaultLanguage: locale.language } });
  const providerAgentId = `agent_${id.replaceAll('-', '')}`;
  const providerAgentVersion = 3;
  const providerFingerprint = 'a'.repeat(64);
  const ageMs = (opts.verificationAgeHours ?? 0) * 3_600_000;
  const verifiedAt = new Date(Date.now() - ageMs);
  await db.receptionistAgent.create({ data: {
    tenantId: id, clinicId: clinic.id, name: 'Avery', active: true,
    providerAgentId, providerVersionTag: 'prod', providerVersion: providerAgentVersion, providerStatus: 'VERIFIED',
    providerPublished: true, providerAssignedTags: ['prod'],
    providerWebhookUrl: 'https://api.example.test/v1/receptionist/webhooks/retell',
    providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
    providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
    providerResponseEngineType: 'retell-llm', providerResponseEngineId: `llm_${id.replaceAll('-', '')}`,
    providerResponseEngineVersion: 1,
    providerFingerprint, providerConfigRevision: 1, providerVerifiedRevision: 1,
    providerVerifiedAt: verifiedAt,
    // The 24h TTL the hourly re-verify worker is supposed to renew.
    providerVerificationExpiresAt: new Date(verifiedAt.getTime() + 24 * 3_600_000),
  } });
  return { id, clinicId: clinic.id, phone, providerAgentId, providerAgentVersion, providerFingerprint };
}

function signedInject(url: string, payload: unknown, key = KEY) {
  const raw = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(raw, key) },
    payload: raw,
  });
}

beforeAll(async () => {
  env.RETELL_API_KEY = KEY;
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  env.RETELL_API_KEY = originalKey;
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app.close();
  await db.$disconnect();
});

describe('Retell first-ever inbound trusted destination bootstrap', () => {
  it('verifies the exact raw body before resolving a valid destination', async () => {
    const t = await tenant();
    const callId = `invalid-signature-${randomUUID()}`;
    const response = await signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_started',
      call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125559999' },
    }, 'wrong-key');
    expect(response.statusCode).toBe(401);
    expect(await db.receptionistCallLog.count({ where: { retellCallId: callId } })).toBe(0);
    expect(await db.operationalSignal.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('creates one clinic-linked call mapping and remains idempotent on replay', async () => {
    const t = await tenant();
    const callId = `first-inbound-${randomUUID()}`;
    const payload = {
      event: 'call_started',
      call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125558888' },
    };
    expect((await signedInject('/v1/receptionist/webhooks/retell', payload)).statusCode).toBe(200);
    expect((await signedInject('/v1/receptionist/webhooks/retell', payload)).statusCode).toBe(200);
    const calls = await db.receptionistCallLog.findMany({ where: { tenantId: t.id, retellCallId: callId } });
    expect(calls).toHaveLength(1);
    expect(calls[0].clinicId).toBe(t.clinicId);
    expect(calls[0].direction).toBe('inbound');
  });

  it('does not let URL selectors redirect signed destination authority', async () => {
    const trusted = await tenant();
    const attacker = await tenant();
    const callId = `selector-${randomUUID()}`;
    const response = await signedInject(`/v1/receptionist/webhooks/retell?clinicId=${attacker.clinicId}`, {
      event: 'call_started',
      call: { call_id: callId, direction: 'inbound', to_number: trusted.phone, from_number: '+12125557777' },
    });
    expect(response.statusCode).toBe(202);
    expect(await db.receptionistCallLog.count({ where: { retellCallId: callId } })).toBe(0);
    expect(await db.operationalSignal.count({ where: { tenantId: trusted.id, signalType: 'RECEPTIONIST_INGRESS_REVIEW' } })).toBe(1);
    expect(await db.operationalSignal.count({ where: { tenantId: attacker.id } })).toBe(0);
  });

  it('fails closed for an unknown active destination', async () => {
    const unknownCall = `unknown-${randomUUID()}`;
    const unknown = await signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_started', call: { call_id: unknownCall, direction: 'inbound', to_number: randomE164() },
    });
    expect(unknown.statusCode).toBe(202);
    expect(await db.receptionistCallLog.count({ where: { retellCallId: unknownCall } })).toBe(0);
  });

  it('bootstraps a tool-first inbound call once before invoking the live tool', async () => {
    const t = await tenant();
    const callId = `tool-first-${randomUUID()}`;
    const payload = {
      name: 'check_availability',
      args: { appointment_date: '2030-01-02' },
      call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125556666' },
    };
    const response = await signedInject('/v1/receptionist/webhooks/retell/fn', payload);
    expect(response.statusCode).toBe(200);
    const calls = await db.receptionistCallLog.findMany({ where: { tenantId: t.id, retellCallId: callId } });
    expect(calls).toHaveLength(1);
    expect(calls[0].clinicId).toBe(t.clinicId);
  });

  it('persists a safe denial signal when entitlement or the tenant kill switch blocks inbound tools', async () => {
    const locked = await tenant(randomE164(), { entitled: false });
    const lockedCall = `feature-locked-${randomUUID()}`;
    const lockedResponse = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'check_availability', args: { appointment_date: '2030-01-02', service: 'Consultation' },
      call: { call_id: lockedCall, direction: 'inbound', to_number: locked.phone, from_number: '+12125554444' },
    });
    expect(lockedResponse.statusCode).toBe(202);
    expect(await db.receptionistCallLog.count({ where: { tenantId: locked.id, retellCallId: lockedCall } })).toBe(0);
    expect(await db.operationalSignal.count({ where: { tenantId: locked.id, signalType: 'RECEPTIONIST_INGRESS_REVIEW' } })).toBe(1);

    const stopped = await tenant();
    await db.tenantAiUsage.create({ data: { tenantId: stopped.id, killSwitch: true, killSwitchReason: 'test' } });
    const stoppedCall = `kill-switch-${randomUUID()}`;
    const stoppedResponse = await signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_started',
      call: { call_id: stoppedCall, direction: 'inbound', to_number: stopped.phone, from_number: '+12125553333' },
    });
    expect(stoppedResponse.statusCode).toBe(202);
    expect(await db.receptionistCallLog.count({ where: { tenantId: stopped.id, retellCallId: stoppedCall } })).toBe(0);
    expect(await db.operationalSignal.count({ where: { tenantId: stopped.id, signalType: 'RECEPTIONIST_INGRESS_REVIEW' } })).toBe(1);
  });

  it('accepts consent evidence only through the signed in-call preference tool', async () => {
    const t = await tenant();
    const callId = `consent-tool-${randomUUID()}`;
    const mockKey = 'mock-consent-tool-key';
    env.RETELL_API_KEY = mockKey;
    try {
      const response = await signedInject('/v1/receptionist/webhooks/retell/fn', {
        name: 'record_recording_preference',
        args: { recording_decision: 'REFUSED', jurisdiction: 'US-NY' },
        call: { call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion, direction: 'inbound', to_number: t.phone, from_number: '+12125552222' },
      }, mockKey);
      expect(response.statusCode).toBe(200);
      const call = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
      expect(call.recordingConsentStatus).toBe('REFUSED');
      expect(call).toMatchObject({
        boundProviderAgentId: t.providerAgentId,
        boundProviderAgentVersion: t.providerAgentVersion,
        boundProviderConfigRevision: 1,
        boundProviderFingerprint: t.providerFingerprint,
      });
      const evidence = await db.receptionistRecordingConsentEvent.findFirstOrThrow({ where: { tenantId: t.id, callLogId: call.id } });
      expect(evidence).toMatchObject({ decision: 'REFUSED', source: 'retell_signed_consent_tool', providerStorageSetting: 'basic_attributes_only', jurisdiction: 'US-NY' });
      const clinic = await db.receptionistClinic.findUniqueOrThrow({ where: { id: t.clinicId }, select: { name: true, complianceDisclosure: true } });
      expect(evidence.disclosureTextHash).toBe(disclosureEvidenceHash(renderRecordingDisclosure({ agentName: 'Avery', clinicName: clinic.name, clinicDisclosure: clinic.complianceDisclosure })));

      const protectedTool = await signedInject('/v1/receptionist/webhooks/retell/fn', {
        name: 'verify_patient_identity', args: { date_of_birth: '1990-01-01' },
        call: { call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion, direction: 'inbound', to_number: t.phone, from_number: '+12125552222' },
      }, mockKey);
      expect(protectedTool.statusCode).toBe(200);
      expect(protectedTool.json()).toMatchObject({ allowed: false, needs_human: true });

      const regrant = await signedInject('/v1/receptionist/webhooks/retell/fn', {
        name: 'record_recording_preference', args: { recording_decision: 'GRANTED', jurisdiction: 'US-NY' },
        call: { call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion, direction: 'inbound', to_number: t.phone, from_number: '+12125552222' },
      }, mockKey);
      expect(regrant.statusCode).toBe(200);
      expect(regrant.json()).toMatchObject({ recorded: false, decision: 'REFUSED', metadata_only: true });
      expect((await db.receptionistCallLog.findUniqueOrThrow({ where: { id: call.id } })).recordingConsentStatus).toBe('REFUSED');
    } finally {
      env.RETELL_API_KEY = KEY;
    }
  });

  // C6 — a lapsed, missing or drifted deployment used to call stopPhoneCall and
  // drop the patient, while `take_message` was itself deployment-bound so they
  // could not even leave a message. Verification lapses after 24h and is renewed
  // by an hourly worker, so a worker outage past ~18h silenced every clinic at
  // once. Patient-data tools are still refused; the call is not.
  it('degrades to the safe tools instead of hanging up when deployment evidence is missing or drifted', async () => {
    const t = await tenant();
    const missingCallId = `missing-deployment-${randomUUID()}`;
    const missing = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'record_recording_preference', args: { recording_decision: 'GRANTED' },
      call: { call_id: missingCallId, direction: 'inbound', to_number: t.phone, from_number: '+12125550021' },
    });
    expect(missing.statusCode).toBe(202);
    expect(missing.json()).toMatchObject({ allowed: false, needs_human: true, degraded: true, providerStopApplied: false });
    // The caller is told something, in words from the pack, and is offered a
    // message and a person. Silence is never an acceptable answer.
    const missingBody = missing.json() as { message: string; allowed_tools: string[] };
    expect(missingBody.message).toMatch(/take a message|put you through/i);
    expect(missingBody.allowed_tools).toEqual([...DEGRADED_SAFE_TOOLS]);
    expect(await db.receptionistRecordingConsentEvent.count({ where: { tenantId: t.id } })).toBe(0);

    const callId = `deployment-drift-${randomUUID()}`;
    const granted = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'record_recording_preference', args: { recording_decision: 'GRANTED', jurisdiction: 'test' },
      call: {
        call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion,
        direction: 'inbound', to_number: t.phone, from_number: '+12125550022',
      },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({ recorded: true, metadata_only: true });

    const alternateId = `agent_alt_${randomUUID().replaceAll('-', '')}`;
    const verifiedAt = new Date();
    await db.receptionistAgent.create({ data: {
      tenantId: t.id, clinicId: t.clinicId, name: 'Alternate', active: true,
      providerAgentId: alternateId, providerVersionTag: 'prod', providerVersion: 8, providerStatus: 'VERIFIED',
      providerPublished: true, providerAssignedTags: ['prod'],
      providerWebhookUrl: 'https://api.example.test/v1/receptionist/webhooks/retell',
      providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
      providerDataStorageSetting: 'basic_attributes_only', providerSignedUrl: true,
      providerResponseEngineType: 'retell-llm', providerResponseEngineId: `llm_alt_${t.id.replaceAll('-', '')}`,
      providerResponseEngineVersion: 1,
      providerFingerprint: 'b'.repeat(64), providerConfigRevision: 1, providerVerifiedRevision: 1,
      providerVerifiedAt: verifiedAt, providerVerificationExpiresAt: new Date(verifiedAt.getTime() + 60 * 60_000),
    } });
    // A patient-data tool on drifted evidence is still refused — but as a
    // degrade, with words and with the safe tools named, not as a hang-up.
    const drifted = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'verify_patient_identity', args: { date_of_birth: '1990-01-01' },
      call: {
        call_id: callId, agent_id: alternateId, agent_version: 8,
        direction: 'inbound', to_number: t.phone, from_number: '+12125550022',
      },
    });
    expect(drifted.statusCode).toBe(202);
    expect(drifted.json()).toMatchObject({ allowed: false, needs_human: true, degraded: true, providerStopApplied: false });
    expect((drifted.json() as { allowed_tools: string[] }).allowed_tools).toContain('take_message');

    // ...and this is the whole point: the caller can still leave a message on
    // the very same drifted call. `take_message` touches no patient record and
    // is no longer deployment-bound, so the receptionist has a floor to degrade
    // to instead of a dial tone.
    const message = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'take_message', args: { message: 'Please call me back.', caller_name: 'Sam', callback_phone: '+12125550022' },
      call: {
        call_id: callId, agent_id: alternateId, agent_version: 8,
        direction: 'inbound', to_number: t.phone, from_number: '+12125550022',
      },
    });
    expect(message.statusCode).toBe(200);
    expect(message.json()).toMatchObject({ message_recorded: true });
    expect(await db.staffTask.count({ where: { tenantId: t.id } })).toBe(1);

    // The staleness raises its own alarm from the live call path, because the
    // worker that would otherwise raise it is the usual thing that has failed.
    expect(await db.businessEvent.count({
      where: { tenantId: t.id, eventType: 'receptionist.agent.degraded' },
    })).toBeGreaterThanOrEqual(1);
    expect(await db.operationalSignal.count({
      where: { tenantId: t.id, signalType: 'receptionist_agent_degraded', status: 'open' },
    })).toBe(1);
    expect(await db.operationalSignal.count({
      where: { tenantId: t.id, signalType: 'RECEPTIONIST_INGRESS_REVIEW' },
    })).toBe(2);
  });

  // C6 — THE scenario. Verification lapses after 24h and is renewed by the
  // hourly worker; a worker outage past ~18h therefore used to take every
  // clinic off the air at once, with the alarm raised by the same dead worker.
  // A patient calling into that window must still be able to leave a message.
  it('leaves a stale verification with a callable message path instead of a hang-up', async () => {
    // 30 hours since the last successful verification: expired, exactly as an
    // overnight worker outage leaves it.
    const t = await tenant(randomE164(), { verificationAgeHours: 30 });
    const callId = `stale-verification-${randomUUID()}`;
    const call = {
      call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion,
      direction: 'inbound', to_number: t.phone, from_number: '+12125550033',
    };

    // A patient-data tool is still refused — but the caller is told so, in
    // words, and is told what they can do instead.
    const booking = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'verify_patient_identity', args: { date_of_birth: '1988-04-02' }, call,
    });
    expect(booking.statusCode).toBe(202);
    const degraded = booking.json() as { degraded: boolean; degrade_reason: string; message: string; allowed_tools: string[]; providerStopApplied: boolean };
    expect(degraded.degraded).toBe(true);
    expect(degraded.degrade_reason).toBe('provider_deployment_unverified_or_stale');
    // The old behaviour: stopPhoneCall. The whole point of C6 is that this is
    // false, and that the caller is still on the line to hear the next line.
    expect(degraded.providerStopApplied).toBe(false);
    expect(degraded.message.length).toBeGreaterThan(0);
    expect(degraded.allowed_tools).toContain('take_message');

    // And the message actually goes through, on the same stale call.
    const message = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'take_message',
      args: { message: 'My crown came off, please call me.', caller_name: 'Alex', callback_phone: '+12125550033' },
      call,
    });
    expect(message.statusCode).toBe(200);
    expect(message.json()).toMatchObject({ message_recorded: true });
    expect(await db.staffTask.count({ where: { tenantId: t.id } })).toBe(1);

    // A human hears about the outage from us, not from a patient.
    expect(await db.businessEvent.count({ where: { tenantId: t.id, eventType: 'receptionist.agent.degraded' } })).toBe(1);
    const signal = await db.operationalSignal.findFirstOrThrow({
      where: { tenantId: t.id, signalType: 'receptionist_agent_degraded' },
    });
    expect(signal).toMatchObject({ status: 'open', severity: 'high', entityId: t.clinicId });
  });

  // C10 — the consent artefact must record the words the caller actually
  // heard. An en-GB pack says "quality and training purposes"; the evidence
  // template says "quality and documentation". Hashing the template recorded
  // wording that caller was never read.
  it('hashes the disclosure the caller actually heard, in their own locale', async () => {
    const t = await tenant(randomE164(), { locale: { country: 'GB', language: 'en-GB', timezone: 'Europe/London' } });
    const callId = `gb-consent-${randomUUID()}`;
    const granted = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'record_recording_preference', args: { recording_decision: 'GRANTED' },
      call: {
        call_id: callId, agent_id: t.providerAgentId, agent_version: t.providerAgentVersion,
        direction: 'inbound', to_number: t.phone, from_number: '+442071234567',
      },
    });
    expect(granted.statusCode).toBe(200);

    const clinic = await db.receptionistClinic.findUniqueOrThrow({ where: { id: t.clinicId }, select: { name: true, complianceDisclosure: true } });
    const gbPack = platformLocalePack('en-GB', 'GB')!;
    const spoken = renderPackMessage(gbPack.strings, 'disclosure.recording', {
      agent_name: 'Avery',
      clinic_name: clinic.name,
      clinic_disclosure: clinic.complianceDisclosure?.trim() ? ` ${clinic.complianceDisclosure.trim()}` : '',
    });
    const evidence = await db.receptionistRecordingConsentEvent.findFirstOrThrow({
      where: { tenantId: t.id }, orderBy: { createdAt: 'desc' },
    });
    expect(spoken).toContain('quality and training purposes');
    expect(evidence.disclosureTextHash).toBe(disclosureEvidenceHash(spoken));
    // The pre-C10 behaviour hashed the en-US template, which this caller was
    // never read. That hash must NOT be what we stored.
    expect(evidence.disclosureTextHash).not.toBe(disclosureEvidenceHash(renderRecordingDisclosure({
      agentName: 'Avery', clinicName: clinic.name, clinicDisclosure: clinic.complianceDisclosure,
    })));
  });

  it('expires stale in-progress call leases before reserving new inbound capacity', async () => {
    const t = await tenant();
    const staleCall = await db.receptionistCallLog.create({
      data: {
        tenantId: t.id,
        clinicId: t.clinicId,
        retellCallId: `stale-${randomUUID()}`,
        direction: 'inbound',
        outcome: 'IN_PROGRESS',
        startedAt: new Date(Date.now() - 5 * 60 * 60 * 1_000),
      },
    });
    const newCallId = `after-stale-${randomUUID()}`;
    const response = await signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_started',
      call: { call_id: newCallId, direction: 'inbound', to_number: t.phone, from_number: '+12125551111' },
    });
    expect(response.statusCode).toBe(200);
    expect(await db.receptionistCallLog.findUniqueOrThrow({ where: { id: staleCall.id } })).toMatchObject({ outcome: 'FAILED' });
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'receptionist.call_lease.expired' } })).toBe(1);
    expect(await db.receptionistCallLog.count({ where: { tenantId: t.id, retellCallId: newCallId, outcome: 'IN_PROGRESS' } })).toBe(1);
  });

  it('atomically admits only one of two inbound calls at the final capacity slot', async () => {
    const t = await tenant();
    await db.receptionistCallLog.createMany({
      data: Array.from({ length: MAX_TENANT_ACTIVE_CALLS - 1 }, (_, index) => ({
        tenantId: t.id,
        clinicId: t.clinicId,
        retellCallId: `capacity-existing-${index}-${randomUUID()}`,
        direction: 'inbound',
        outcome: 'IN_PROGRESS' as const,
        startedAt: new Date(),
      })),
    });
    const calls = [`capacity-a-${randomUUID()}`, `capacity-b-${randomUUID()}`];
    const responses = await Promise.all(calls.map(callId => signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_started', call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125550001' },
    })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 202]);
    expect(await db.receptionistCallLog.count({ where: { tenantId: t.id, outcome: 'IN_PROGRESS', endedAt: null } })).toBe(MAX_TENANT_ACTIVE_CALLS);
    expect(await db.operationalSignal.count({ where: { tenantId: t.id, signalType: 'RECEPTIONIST_INGRESS_REVIEW' } })).toBe(1);
  });

  it('rejects signed tool replay after call end and preserves a terminal outcome on weaker redelivery', async () => {
    const t = await tenant();
    const callId = `terminal-${randomUUID()}`;
    expect((await signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_started', call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125550002' },
    })).statusCode).toBe(200);
    expect((await signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_analyzed',
      call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125550002', call_analysis: { custom_analysis_data: { outcome: 'ESCALATED' } } },
    })).statusCode).toBe(200);
    expect((await signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_ended', call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125550002' },
    })).statusCode).toBe(200);
    expect((await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } })).outcome).toBe('ESCALATED');

    const replay = await signedInject('/v1/receptionist/webhooks/retell/fn', {
      name: 'record_recording_preference', args: { recording_decision: 'GRANTED' },
      call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125550002' },
    });
    // A terminal call cannot reacquire patient-data authority, and a replay
    // without the exact signed agent deployment is quarantined for review.
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ allowed: false, needs_human: true });
  });

  it('routes an unproven provider BOOKED analysis to pending review without a canonical appointment', async () => {
    const t = await tenant();
    const callId = `unproven-booked-${randomUUID()}`;
    expect((await signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_started', call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125550003' },
    })).statusCode).toBe(200);
    expect((await signedInject('/v1/receptionist/webhooks/retell', {
      event: 'call_analyzed',
      call: {
        call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125550003',
        call_analysis: { custom_analysis_data: { outcome: 'BOOKED', first_name: 'Synthetic', appointment_date: '2030-01-02', appointment_time: '10:00' } },
      },
    })).statusCode).toBe(200);
    expect((await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } })).outcome).toBe('ESCALATED');
    expect(await db.appointment.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.appointmentRequest.count({ where: { tenantId: t.id, status: 'PENDING_REVIEW', source: 'retell_analysis_review_only' } })).toBe(1);
    const review = await db.appointmentRequest.findFirstOrThrow({ where: { tenantId: t.id, source: 'retell_analysis_review_only' } });
    expect(review).toMatchObject({ collectedName: null, collectedPhone: null, collectedEmail: null, requestedService: null });
    expect(review.rawCollectedFields).toEqual({ issue_codes: ['provider_claimed_booking_without_canonical_evidence', 'consent_not_granted_phi_omitted'] });
    expect(JSON.stringify(review.rawCollectedFields)).not.toContain('Synthetic');
  });
});
