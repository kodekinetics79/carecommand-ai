import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Function/DB-level suite (no HTTP app): it exercises the comms + campaign
// libraries directly against real Postgres. This keeps it independent of the
// cross-cutting audit()/AuditEvent RLS wiring owned by other modules, and it
// runs correctly whether or not the shared dev DB currently enforces RLS
// (tenant context is set either way).
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { env } = await import('../config/env');
const { sendMessage: sendMessageUnscoped } = await import('../lib/commsProvider');
const { dispatchCampaign: dispatchCampaignUnscoped } = await import('../lib/campaignDispatch');
const { isDestinationOptedOut: isDestinationOptedOutUnscoped, generateDraft } = await import('../lib/campaigns');
const { runWithJobTenantContext } = await import('../lib/tenantContext');

const sendMessage = (...args: Parameters<typeof sendMessageUnscoped>) =>
  runWithJobTenantContext(args[5].tenantId, () => sendMessageUnscoped(...args), 'worker:test-comms');
const dispatchCampaign = (tenantId: string, ...args: Parameters<typeof dispatchCampaignUnscoped> extends [string, ...infer Rest] ? Rest : never) =>
  runWithJobTenantContext(tenantId, () => dispatchCampaignUnscoped(tenantId, ...args), 'worker:test-comms');
const isDestinationOptedOut = (tenantId: string, ...args: Parameters<typeof isDestinationOptedOutUnscoped> extends [string, ...infer Rest] ? Rest : never) =>
  runWithJobTenantContext(tenantId, () => isDestinationOptedOutUnscoped(tenantId, ...args), 'worker:test-comms');

const tenantIds: string[] = [];

// ---- Local Twilio stub (real HTTP on an ephemeral port) --------------------
let twilioStub: http.Server;
let twilioBase = '';
let stubHits = 0;
let stubResponder: (form: URLSearchParams) => { code: number; body: unknown } =
  () => ({ code: 200, body: { sid: 'SM_default' } });

// Snapshot env fields we mutate so tests don't leak into each other.
const originalEnv = {
  NODE_ENV: env.NODE_ENV,
  TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: env.TWILIO_FROM_NUMBER,
  TWILIO_BASE_URL: env.TWILIO_BASE_URL,
  EMAIL_HTTP_API_URL: env.EMAIL_HTTP_API_URL,
};

function setMockCreds() {
  const e = env as typeof env;
  e.NODE_ENV = 'development';
  e.TWILIO_ACCOUNT_SID = 'mock_sid';
  e.TWILIO_AUTH_TOKEN = 'mock_token';
  e.TWILIO_FROM_NUMBER = '+15550000000';
}

function setLiveCreds() {
  const e = env as typeof env;
  e.NODE_ENV = 'development'; // not production, but creds do NOT start with "mock"
  e.TWILIO_ACCOUNT_SID = 'ACtestliveaccountsid';
  e.TWILIO_AUTH_TOKEN = 'live_token';
  e.TWILIO_FROM_NUMBER = '+15550000000';
  e.TWILIO_BASE_URL = twilioBase;
}

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `comm-${id.slice(0, 6)}`, slug: `comm-${id.slice(0, 8)}` } });
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'Main St', active: true } });
  return { id, branchId: branch.id };
}

// Patient is RLS-enrolled (app_rls); insert inside a tenant transaction so the
// GUC is set on the same connection — otherwise the write is rejected.
async function makeInactivePatient(tenantId: string, branchId: string, opts: { phone?: string | null; email?: string | null } = {}) {
  return runWithJobTenantContext(tenantId, tx => tx.patient.create({
    data: {
      tenantId, branchId, firstName: 'Inactive', lastName: 'Patient',
      phone: opts.phone ?? '+1 555 010 2030', email: opts.email ?? null,
      lifecycleStage: 'ACTIVE', lastVisitAt: new Date('2020-01-01T00:00:00Z'),
    },
    select: { id: true, phone: true, email: true },
  }), 'worker:test-comms');
}

async function makeInactiveCampaign(tenantId: string) {
  return db.campaign.create({
    data: {
      tenantId, name: 'Reactivation', goal: 'inactive_patient_reactivation', status: 'SCHEDULED', channels: [],
      campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', campaignChannel: 'sms',
      messageTemplate: 'Hi {{firstName}}, it has been a while since your visit to {{clinicName}}.',
      requiresApproval: true, approvedAt: new Date(), draftSource: 'rule_based',
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  twilioStub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      stubHits++;
      const { code, body } = stubResponder(new URLSearchParams(raw));
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => twilioStub.listen(0, '127.0.0.1', resolve));
  twilioBase = `http://127.0.0.1:${(twilioStub.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  Object.assign(env as typeof env, originalEnv);
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await new Promise<void>(resolve => twilioStub?.close(() => resolve()));
  await db.$disconnect();
});

// ===========================================================================
// 1. Truthful delivery — commsProvider.sendMessage against the real provider
//    abstraction (dev mock + a local Twilio stub on an ephemeral port).
// ===========================================================================
describe('commsProvider.sendMessage — truthful delivery', () => {
  it('dev mock returns mock_dev with a deterministic id that is stable across a retry', async () => {
    const t = await makeTenant();
    setMockCreds();
    const key = `idem-${randomUUID()}`;
    const first = await sendMessage('sms', '+15551234567', 'S', 'B', key, { tenantId: t.id });
    const retry = await sendMessage('sms', '+15551234567', 'S', 'B', key, { tenantId: t.id });
    expect(first.status).toBe('sent');
    expect(first.mode).toBe('mock_dev');
    expect(first.providerMessageId).toBe(retry.providerMessageId);
    expect(first.providerMessageId).toMatch(/^mock_/);
  });

  it('live provider success ({sid}) → sent with providerMessageId', async () => {
    const t = await makeTenant();
    setLiveCreds();
    stubResponder = () => ({ code: 201, body: { sid: 'SM_success_123' } });
    const before = stubHits;
    const res = await sendMessage('sms', '+15551230000', 'S', 'B', `k-${randomUUID()}`, { tenantId: t.id });
    expect(stubHits).toBe(before + 1);
    expect(res.status).toBe('sent');
    expect(res.mode).toBe('live');
    expect(res.providerMessageId).toBe('SM_success_123');
  });

  it('live provider 4xx → failed with the provider failureReason', async () => {
    const t = await makeTenant();
    setLiveCreds();
    stubResponder = () => ({ code: 400, body: { message: 'The To number is not a valid phone number' } });
    const res = await sendMessage('sms', '+15551230001', 'S', 'B', `k-${randomUUID()}`, { tenantId: t.id });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.failureReason).toBe('The To number is not a valid phone number');
  });

  it('live provider 5xx → failed (truthful, never "sent")', async () => {
    const t = await makeTenant();
    setLiveCreds();
    stubResponder = () => ({ code: 500, body: {} });
    const res = await sendMessage('sms', '+15551230002', 'S', 'B', `k-${randomUUID()}`, { tenantId: t.id });
    expect(res.status).toBe('failed');
    expect(res.failureReason).toBe('twilio_error_500');
  });

  it('malformed destination is rejected by the E.164 gate BEFORE any provider call', async () => {
    const t = await makeTenant();
    setLiveCreds();
    stubResponder = () => ({ code: 201, body: { sid: 'should_not_be_used' } });
    const before = stubHits;
    const res = await sendMessage('sms', 'not-a-phone', 'S', 'B', `k-${randomUUID()}`, { tenantId: t.id });
    expect(res.status).toBe('failed');
    expect(res.failureReason).toBe('invalid_destination');
    expect(stubHits).toBe(before); // provider never contacted
  });

  it('provider network failure → failed with a failureReason (same catch path as an 8s timeout)', async () => {
    const t = await makeTenant();
    setLiveCreds();
    (env as typeof env).TWILIO_BASE_URL = 'http://127.0.0.1:1'; // nothing listening → connection refused
    const res = await sendMessage('sms', '+15551230003', 'S', 'B', `k-${randomUUID()}`, { tenantId: t.id });
    expect(res.status).toBe('failed');
    expect(res.mode).toBe('live');
    expect(typeof res.failureReason).toBe('string');
    (env as typeof env).TWILIO_BASE_URL = twilioBase;
  });
});

// ===========================================================================
// 2. Consent / suppression enforced end-to-end by the campaign engine — a
//    suppressed contact is NEVER handed to the provider.
// ===========================================================================
describe('campaign engine — consent/suppression is enforced before send', () => {
  it('an opted-out patient is recorded suppressed (not sent) and never reaches the provider', async () => {
    const t = await makeTenant();
    setMockCreds();
    const optedOut = await makeInactivePatient(t.id, t.branchId, { phone: '+15551110001' });
    const sendable = await makeInactivePatient(t.id, t.branchId, { phone: '+15551110002' });
    await db.communicationConsent.create({ data: { tenantId: t.id, patientId: optedOut.id, channel: 'sms', status: 'opted_out' } });

    const campaign = await makeInactiveCampaign(t.id);
    const summary = await dispatchCampaign(t.id, campaign.id, {});

    expect(summary.suppressed).toBeGreaterThanOrEqual(1);
    expect(summary.sent).toBeGreaterThanOrEqual(1);
    const rows = await db.campaignDelivery.findMany({ where: { tenantId: t.id, campaignId: campaign.id } });
    const byPatient = new Map(rows.map(r => [r.patientId, r]));
    expect(byPatient.get(optedOut.id)?.status).toBe('suppressed');
    expect(byPatient.get(optedOut.id)?.providerMessageId).toBeNull();
    expect(byPatient.get(sendable.id)?.status).toBe('sent');
  });
});

// ===========================================================================
// 3. CROSS-MODULE GAP HUNT — an opt-out captured during an AI receptionist
//    call (ReceptionistOptOut, channel ALL) must suppress other send paths.
// ===========================================================================
describe('cross-module: AI receptionist opt-out (ReceptionistOptOut, channel ALL)', () => {
  it('(a) is honored by SMS campaign sends (end-to-end dispatch)', async () => {
    const t = await makeTenant();
    setMockCreds();
    const phone = '+15552220001';
    const patient = await makeInactivePatient(t.id, t.branchId, { phone });
    // As written by the Retell webhook on an OPTED_OUT call outcome.
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: phone, channel: 'ALL', reason: 'Requested during AI call' } });

    const campaign = await makeInactiveCampaign(t.id);
    const summary = await dispatchCampaign(t.id, campaign.id, {});
    const row = await db.campaignDelivery.findFirst({ where: { tenantId: t.id, campaignId: campaign.id, patientId: patient.id } });
    expect(row?.status).toBe('suppressed');
    expect(summary.sent).toBe(0);
  });

  it('(a2) is honored even when the phone is stored in a different format (E.164 normalization)', async () => {
    const t = await makeTenant();
    setMockCreds();
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: '+15553330009', channel: 'ALL', reason: 'AI call' } });
    const res = await sendMessage('sms', '+1 (555) 333-0009', 'S', 'B', `k-${randomUUID()}`, { tenantId: t.id });
    expect(res.status).toBe('suppressed');
    expect(res.providerMessageId).toBeUndefined();
  });

  it('(b) is honored by CRM sends (sendMessage with a leadId context → suppressed, no provider call)', async () => {
    const t = await makeTenant();
    setMockCreds();
    const phone = '+15552220003';
    const lead = await db.lead.create({ data: { tenantId: t.id, name: 'Lead', phone, channel: 'SMS', service: 'Consult', stage: 'NEW', source: 'test' }, select: { id: true } });
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: phone, channel: 'ALL', reason: 'AI call' } });
    const res = await sendMessage('sms', phone, 'S', 'B', `k-${randomUUID()}`, { tenantId: t.id, leadId: lead.id });
    expect(res.status).toBe('suppressed');
    // The /v1/crm/leads/:id/send route calls this same gate (and pre-checks
    // isSuppressed with the destination), so it returns a 409 "blocked".
  });

  it('(c) GAP: receptionist OUTBOUND targets are NOT filtered by ReceptionistOptOut (receptionist-owned; reported, not fixed here)', async () => {
    const t = await makeTenant();
    const phone = '+15552220004';
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: phone, channel: 'ALL', reason: 'AI call' } });
    const clinic = await db.receptionistClinic.create({ data: { tenantId: t.id, name: 'Main clinic', phone: '+15550000000' }, select: { id: true } });
    const campaign = await db.receptionistOutboundCampaign.create({ data: { tenantId: t.id, clinicId: clinic.id, name: 'Outbound', script: 'Call the patient.', requiredFields: ['firstName', 'lastName', 'phone'] }, select: { id: true } });
    // outbound.ts adds targets with no suppression filter — the opted-out contact
    // lands in the call queue. This documents the gap (fix belongs in the
    // receptionist module's target selection / call-launch path).
    const target = await db.receptionistCallTarget.create({ data: { tenantId: t.id, campaignId: campaign.id, phone, firstName: 'Opted', lastName: 'Out' }, select: { id: true, status: true } });
    expect(target.status).toBe('PENDING'); // queued to be called despite the opt-out
    expect(await isDestinationOptedOut(t.id, phone, 'voice')).toBe(true); // the data to suppress it exists and is queryable
  });
});

// ===========================================================================
// 4. Opt-out precedence & scoping.
// ===========================================================================
describe('opt-out scoping & channel semantics', () => {
  it('is tenant-scoped: tenant A opt-out does not suppress tenant B with the same phone', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    setMockCreds();
    const phone = '+15554440001';
    await db.receptionistOptOut.create({ data: { tenantId: a.id, contactPhone: phone, channel: 'ALL', reason: 'AI call' } });

    const inA = await sendMessage('sms', phone, 'S', 'B', `k-${randomUUID()}`, { tenantId: a.id });
    const inB = await sendMessage('sms', phone, 'S', 'B', `k-${randomUUID()}`, { tenantId: b.id });
    expect(inA.status).toBe('suppressed');
    expect(inB.status).toBe('sent'); // different tenant, same phone → not suppressed
  });

  it('channel ALL suppresses sms + whatsapp + email', async () => {
    const t = await makeTenant();
    setMockCreds();
    const phone = '+15554440002';
    const email = 'optout@patient.test';
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: phone, contactEmail: email, channel: 'ALL', reason: 'AI call' } });

    expect((await sendMessage('sms', phone, 'S', 'B', `k-${randomUUID()}`, { tenantId: t.id })).status).toBe('suppressed');
    expect((await sendMessage('whatsapp', phone, 'S', 'B', `k-${randomUUID()}`, { tenantId: t.id })).status).toBe('suppressed');
    expect(await isDestinationOptedOut(t.id, email, 'email')).toBe(true);
  });

  it('a SMS-only receptionist opt-out does not suppress email to the same person', async () => {
    const t = await makeTenant();
    const phone = '+15554440003';
    const email = 'still-emailable@patient.test';
    await db.receptionistOptOut.create({ data: { tenantId: t.id, contactPhone: phone, contactEmail: email, channel: 'SMS', reason: 'AI call' } });
    expect(await isDestinationOptedOut(t.id, phone, 'sms')).toBe(true);
    expect(await isDestinationOptedOut(t.id, email, 'email')).toBe(false); // SMS opt-out ≠ email opt-out
  });
});

// ===========================================================================
// 5. PHI hygiene — appointment/reactivation templates carry no clinical detail.
// ===========================================================================
describe('PHI hygiene — no diagnosis / clinical detail in outreach templates', () => {
  const CLINICAL = /\b(diagnos|prescription|medication|dosage|symptom|condition|treatment|lab result|test result|icd|cpt)\b/i;

  it('rule-based drafts contain no clinical terms and carry a no-clinical-advice warning', () => {
    const types = ['appointment_reminder', 'appointment_confirmation', 'no_show_recovery', 'inactive_patient_reactivation', 'failed_payment_recovery', 'insurance_update_request'] as const;
    for (const ty of types) {
      const draft = generateDraft(ty, 'sms', 'inactive_patients');
      expect(draft.body).not.toMatch(CLINICAL);
      expect(draft.subject).not.toMatch(CLINICAL);
      expect(draft.warnings.some(w => /clinical advice/i.test(w))).toBe(true);
      // Only the safe {{firstName}}/{{clinicName}} tokens are ever interpolated.
      const leftover = draft.body.match(/\{\{(\w+)\}\}/g) ?? [];
      expect(leftover.every(tok => tok === '{{firstName}}' || tok === '{{clinicName}}')).toBe(true);
    }
  });

  it('a rendered campaign message on the delivery log exposes no PHI (destination is masked)', async () => {
    const t = await makeTenant();
    setMockCreds();
    const patient = await makeInactivePatient(t.id, t.branchId, { phone: '+15556660001' });
    const campaign = await makeInactiveCampaign(t.id);
    await dispatchCampaign(t.id, campaign.id, {});
    const row = await db.campaignDelivery.findFirst({ where: { tenantId: t.id, campaignId: campaign.id, patientId: patient.id } });
    expect(row?.destinationMasked).toMatch(/\*\*\*/); // masked, not the raw number
    expect(row?.destinationMasked).not.toContain('5556660001');
  });
});
