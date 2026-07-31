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

const KEY = 'retell-first-inbound-bootstrap-key';
const originalKey = env.RETELL_API_KEY;
const tenantIds: string[] = [];
let app: FastifyInstance;
function randomE164() {
  const suffix = (Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 12), 16) % 10_000_000).toString().padStart(7, '0');
  return `+1212${suffix}`;
}

async function tenant(phone = randomE164(), entitled = true) {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `Inbound ${id.slice(0, 8)}`, slug: `inbound-${id.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId: id, featureKey: 'ai_receptionist', enabled: entitled, source: 'test' } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Trusted destination', phone, active: true } });
  await db.receptionistAgent.create({ data: { tenantId: id, clinicId: clinic.id, name: 'Avery', active: true } });
  return { id, clinicId: clinic.id, phone };
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
    const locked = await tenant(randomE164(), false);
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
        call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125552222' },
      }, mockKey);
      expect(response.statusCode).toBe(200);
      const call = await db.receptionistCallLog.findFirstOrThrow({ where: { tenantId: t.id, retellCallId: callId } });
      expect(call.recordingConsentStatus).toBe('REFUSED');
      const evidence = await db.receptionistRecordingConsentEvent.findFirstOrThrow({ where: { tenantId: t.id, callLogId: call.id } });
      expect(evidence).toMatchObject({ decision: 'REFUSED', source: 'retell_signed_consent_tool', providerStorageSetting: 'basic_attributes_only', jurisdiction: 'US-NY' });
      const clinic = await db.receptionistClinic.findUniqueOrThrow({ where: { id: t.clinicId }, select: { name: true, complianceDisclosure: true } });
      expect(evidence.disclosureTextHash).toBe(disclosureEvidenceHash(renderRecordingDisclosure({ agentName: 'Avery', clinicName: clinic.name, clinicDisclosure: clinic.complianceDisclosure })));

      const protectedTool = await signedInject('/v1/receptionist/webhooks/retell/fn', {
        name: 'verify_patient_identity', args: { date_of_birth: '1990-01-01' },
        call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125552222' },
      }, mockKey);
      expect(protectedTool.statusCode).toBe(200);
      expect(protectedTool.json()).toMatchObject({ allowed: false, needs_human: true });

      const regrant = await signedInject('/v1/receptionist/webhooks/retell/fn', {
        name: 'record_recording_preference', args: { recording_decision: 'GRANTED', jurisdiction: 'US-NY' },
        call: { call_id: callId, direction: 'inbound', to_number: t.phone, from_number: '+12125552222' },
      }, mockKey);
      expect(regrant.statusCode).toBe(200);
      expect(regrant.json()).toMatchObject({ recorded: false, decision: 'REFUSED', metadata_only: true });
      expect((await db.receptionistCallLog.findUniqueOrThrow({ where: { id: call.id } })).recordingConsentStatus).toBe('REFUSED');
    } finally {
      env.RETELL_API_KEY = KEY;
    }
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
    expect(replay.statusCode).toBe(200);
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
  });
});
