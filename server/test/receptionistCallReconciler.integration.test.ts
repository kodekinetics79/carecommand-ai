import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetPhoneCallResult, RetellCallSnapshot } from '../lib/retell';

// Only the provider read is faked. Everything else — RLS, the first-terminal
// trigger, the target ownership FKs — is the real database.
const providerCalls = new Map<string, GetPhoneCallResult>();
const getPhoneCallMock = vi.fn(async (callId: string): Promise<GetPhoneCallResult> =>
  providerCalls.get(callId) ?? { ok: false, error: 'retell_error_404' });

vi.mock('../lib/retell', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/retell')>()),
  getPhoneCall: getPhoneCallMock,
}));

const { reconcileStrandedCalls, providerTerminalOutcome, CALL_RECONCILIATION_ACTOR } =
  await import('../lib/receptionist/callReconciler');
const { runInTenantContext } = await import('../lib/tenantContext');
const { fixtureDb } = await import('./helpers/fixtureDb');

const tenantIds: string[] = [];

function snapshot(callId: string, over: Partial<RetellCallSnapshot> = {}): RetellCallSnapshot {
  return {
    callId,
    status: 'not_connected',
    agentId: null,
    agentVersion: null,
    direction: 'outbound',
    startTimestamp: null,
    endTimestamp: null,
    durationMs: 0,
    disconnectionReason: null,
    metadata: {},
    combinedCostNativeUnits: null,
    mock: false,
    ...over,
  };
}

/** Every id is per-run unique: the dev DB is shared and several unique indexes
 *  (clinic phone, target phone, provider call id) are global, not per-tenant. */
function uniqueSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

function uniquePhone(): string {
  const digits = (BigInt(`0x${uniqueSuffix()}`) % 9_000_000_000n) + 1_000_000_000n;
  return `+1${digits.toString().slice(-10)}`;
}

async function fixture() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  const suffix = uniqueSuffix();
  await fixtureDb.tenant.create({ data: { id: tenantId, name: `call-recon-${suffix}`, slug: `call-recon-${suffix}` } });
  const branch = await fixtureDb.branch.create({ data: { tenantId, name: 'Reconciler Front Desk', location: 'Test' } });
  const clinic = await fixtureDb.receptionistClinic.create({ data: {
    tenantId, name: `Reconciler Clinic ${suffix}`, phone: uniquePhone(),
    timezone: 'UTC', country: 'US', defaultLanguage: 'en-US',
  } });
  const approver = await fixtureDb.user.create({ data: {
    tenantId, branchId: branch.id, role: 'ADMIN', active: true,
    email: `recon-admin-${suffix}@reconciler.test`, displayName: 'Reconciler Admin',
  } });
  // A RUNNING campaign, because that is the only state a stranded outbound call
  // can have been dispatched from; the DB requires its authority fields.
  const campaign = await fixtureDb.receptionistOutboundCampaign.create({ data: {
    tenantId, clinicId: clinic.id, name: `Reconciler campaign ${suffix}`,
    script: 'Synthetic reconciliation script.', requiredFields: [],
    defaultBranchId: branch.id, maxRetryAttempts: 2, status: 'RUNNING',
    purpose: 'APPOINTMENT_REMINDER', legalBasis: 'TREATMENT_OPERATIONS',
    policyVersion: 'test-v1', authorityApprovedAt: new Date(),
    authorityApprovedById: approver.id, authorityFingerprint: 'a'.repeat(64),
  } });
  return { tenantId, branchId: branch.id, clinicId: clinic.id, campaignId: campaign.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A call that was dispatched and then stranded: the target is held in CALLING
 * by this call log, exactly as `POST /outbound-campaigns/:id/dial` leaves it.
 */
async function strandedCall(f: Fixture, input: { retellCallId: string | null; deadlineAt: Date; startedAt?: Date }) {
  const phone = uniquePhone();
  // A target must name exactly one identity (DB check), same as a real dial.
  const patient = await fixtureDb.patient.create({ data: {
    tenantId: f.tenantId, branchId: f.branchId, firstName: 'Stranded', lastName: 'Caller', phone,
  } });
  const target = await fixtureDb.receptionistCallTarget.create({ data: {
    tenantId: f.tenantId, campaignId: f.campaignId, phone, patientId: patient.id,
    status: 'PENDING', attempts: 1,
  } });
  const callLog = await fixtureDb.receptionistCallLog.create({ data: {
    tenantId: f.tenantId, clinicId: f.clinicId, outboundCampaignId: f.campaignId, targetId: target.id,
    direction: 'outbound', outcome: 'IN_PROGRESS', endedAt: null,
    retellCallId: input.retellCallId,
    startedAt: input.startedAt ?? null,
    deadlineAt: input.deadlineAt,
  } });
  await fixtureDb.receptionistCallTarget.update({
    where: { id: target.id },
    data: { status: 'CALLING', lastCallLogId: callLog.id },
  });
  return { targetId: target.id, callLogId: callLog.id };
}

function tick(tenantId: string, now = new Date()) {
  return runInTenantContext(
    { tenantId, actorId: CALL_RECONCILIATION_ACTOR, actorRole: 'WORKER', source: 'worker' },
    () => reconcileStrandedCalls(tenantId, now),
  );
}

beforeEach(() => {
  providerCalls.clear();
  getPhoneCallMock.mockClear();
});

afterAll(async () => {
  for (const tenantId of tenantIds) await fixtureDb.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await fixtureDb.$disconnect();
});

describe('provider status to terminal outcome', () => {
  it('maps a call that never reached a person to NO_ANSWER and never to a business outcome', () => {
    expect(providerTerminalOutcome({ status: 'not_connected', disconnectionReason: null })).toBe('NO_ANSWER');
    expect(providerTerminalOutcome({ status: 'ended', disconnectionReason: 'user_declined' })).toBe('NO_ANSWER');
    expect(providerTerminalOutcome({ status: 'ended', disconnectionReason: 'dial_no_answer' })).toBe('NO_ANSWER');
    expect(providerTerminalOutcome({ status: 'not_connected', disconnectionReason: 'voicemail_reached' })).toBe('VOICEMAIL');
    expect(providerTerminalOutcome({ status: 'error', disconnectionReason: null })).toBe('FAILED');
    // Ended, but nothing here says what was agreed: a person decides.
    expect(providerTerminalOutcome({ status: 'ended', disconnectionReason: 'agent_hangup' })).toBe('ESCALATED');
  });

  it('refuses to call a live call terminal', () => {
    expect(providerTerminalOutcome({ status: 'ongoing', disconnectionReason: null })).toBeNull();
    expect(providerTerminalOutcome({ status: 'registered', disconnectionReason: null })).toBeNull();
    expect(providerTerminalOutcome({ status: 'unknown', disconnectionReason: null })).toBeNull();
  });
});

describe('stranded receptionist call reconciliation', () => {
  it('closes a stranded call the provider never connected and releases its target', async () => {
    const f = await fixture();
    const retellCallId = `call_${uniqueSuffix()}`;
    const { callLogId, targetId } = await strandedCall(f, {
      retellCallId,
      deadlineAt: new Date(Date.now() - 10 * 60_000),
      startedAt: new Date(Date.now() - 20 * 60_000),
    });
    providerCalls.set(retellCallId, { ok: true, call: snapshot(retellCallId, {
      status: 'not_connected', disconnectionReason: 'dial_no_answer',
    }) });

    const summary = await tick(f.tenantId);

    expect(summary).toMatchObject({ scanned: 1, closed: 1, closedWithoutProviderId: 0, stillActive: 0, errors: 0 });
    const call = await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } });
    expect(call.outcome).toBe('NO_ANSWER');
    expect(call.endedAt).not.toBeNull();
    // A call nobody answered can never have produced an agreement.
    expect(call.recordingConsentStatus).toBe('UNDETERMINED');
    expect(call.transcriptSummary).toBeNull();

    // maxRetryAttempts is 2 and this was attempt 1, so the target becomes
    // dialable again rather than being burned.
    const target = await fixtureDb.receptionistCallTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.status).toBe('PENDING');
    expect(target.status).not.toBe('CALLING');
    expect(target.lastOutcome).toBe('NO_ANSWER');

    const audits = await fixtureDb.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: 'receptionist.call.reconciled', resourceId: callLogId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ reason: 'provider_terminal', outcome: 'NO_ANSWER', targetStatus: 'PENDING' });
  });

  it('closes a call that never reached the provider as FAILED without asking the provider', async () => {
    const f = await fixture();
    const { callLogId, targetId } = await strandedCall(f, {
      retellCallId: null,
      deadlineAt: new Date(Date.now() - 10 * 60_000),
    });

    const summary = await tick(f.tenantId);

    expect(summary).toMatchObject({ scanned: 1, closed: 1, closedWithoutProviderId: 1, errors: 0 });
    expect(getPhoneCallMock).not.toHaveBeenCalled();
    const call = await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } });
    expect(call.outcome).toBe('FAILED');
    expect(call.endedAt).not.toBeNull();
    const target = await fixtureDb.receptionistCallTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(target.status).not.toBe('CALLING');
    expect(target.lastOutcome).toBe('FAILED');
  });

  it('leaves a call that has not reached its deadline alone', async () => {
    const f = await fixture();
    const retellCallId = `call_${uniqueSuffix()}`;
    const { callLogId, targetId } = await strandedCall(f, {
      retellCallId,
      deadlineAt: new Date(Date.now() + 10 * 60_000),
    });
    providerCalls.set(retellCallId, { ok: true, call: snapshot(retellCallId, { status: 'error' }) });

    const summary = await tick(f.tenantId);

    expect(summary).toMatchObject({ scanned: 0, closed: 0 });
    expect(getPhoneCallMock).not.toHaveBeenCalled();
    const call = await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } });
    expect(call.outcome).toBe('IN_PROGRESS');
    expect(call.endedAt).toBeNull();
    expect((await fixtureDb.receptionistCallTarget.findUniqueOrThrow({ where: { id: targetId } })).status).toBe('CALLING');
  });

  it('leaves a call the provider still reports as ongoing alone', async () => {
    const f = await fixture();
    const retellCallId = `call_${uniqueSuffix()}`;
    const { callLogId, targetId } = await strandedCall(f, {
      retellCallId,
      deadlineAt: new Date(Date.now() - 10 * 60_000),
    });
    providerCalls.set(retellCallId, { ok: true, call: snapshot(retellCallId, { status: 'ongoing' }) });

    const summary = await tick(f.tenantId);

    expect(summary).toMatchObject({ scanned: 1, closed: 0, stillActive: 1, errors: 0 });
    const call = await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } });
    expect(call.outcome).toBe('IN_PROGRESS');
    expect(call.endedAt).toBeNull();
    expect((await fixtureDb.receptionistCallTarget.findUniqueOrThrow({ where: { id: targetId } })).status).toBe('CALLING');
  });

  it('writes nothing the second time: the first terminal outcome is the only one', async () => {
    const f = await fixture();
    const retellCallId = `call_${uniqueSuffix()}`;
    const { callLogId, targetId } = await strandedCall(f, {
      retellCallId,
      deadlineAt: new Date(Date.now() - 10 * 60_000),
    });
    // Six minutes of provider-reported audio, so the pass also records minutes
    // and the second pass has something it could double-count.
    providerCalls.set(retellCallId, { ok: true, call: snapshot(retellCallId, {
      status: 'ended', disconnectionReason: 'user_declined', durationMs: 6 * 60_000,
    }) });

    const first = await tick(f.tenantId);
    expect(first).toMatchObject({ scanned: 1, closed: 1 });

    const afterFirst = await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } });
    const targetAfterFirst = await fixtureDb.receptionistCallTarget.findUniqueOrThrow({ where: { id: targetId } });
    const usageAfterFirst = await fixtureDb.usageEvent.findMany({ where: { tenantId: f.tenantId, metric: 'voice_minute' } });
    const limitAfterFirst = await fixtureDb.tenantUsageLimit.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: f.tenantId, key: 'voice_minutes' } },
    });
    expect(usageAfterFirst).toHaveLength(1);
    expect(usageAfterFirst[0].quantity).toBe(6);
    expect(limitAfterFirst.used).toBe(6);

    // The row is terminal now, so it is no longer selected at all.
    const second = await tick(f.tenantId);
    expect(second).toMatchObject({ scanned: 0, closed: 0, errors: 0 });

    expect(await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } })).toEqual(afterFirst);
    expect(await fixtureDb.receptionistCallTarget.findUniqueOrThrow({ where: { id: targetId } })).toEqual(targetAfterFirst);
    expect(await fixtureDb.usageEvent.count({ where: { tenantId: f.tenantId, metric: 'voice_minute' } })).toBe(1);
    expect((await fixtureDb.tenantUsageLimit.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: f.tenantId, key: 'voice_minutes' } },
    })).used).toBe(6);
    expect(await fixtureDb.auditEvent.count({
      where: { tenantId: f.tenantId, action: 'receptionist.call.reconciled', resourceId: callLogId },
    })).toBe(1);
  });

  it('hands an ended call with no signed analysis to a person instead of inventing a result', async () => {
    const f = await fixture();
    const retellCallId = `call_${uniqueSuffix()}`;
    const { callLogId } = await strandedCall(f, {
      retellCallId,
      deadlineAt: new Date(Date.now() - 10 * 60_000),
    });
    providerCalls.set(retellCallId, { ok: true, call: snapshot(retellCallId, {
      status: 'ended', disconnectionReason: 'agent_hangup', durationMs: 90_000,
    }) });

    await tick(f.tenantId);

    const call = await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } });
    expect(call.outcome).toBe('ESCALATED');
    // Nothing the patient supposedly agreed to was written.
    expect(call.recordingConsentStatus).toBe('UNDETERMINED');
    const tasks = await fixtureDb.staffTask.findMany({
      where: { tenantId: f.tenantId, metadata: { path: ['callLogId'], equals: callLogId } },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].metadata).toMatchObject({
      workflow: 'receptionist_call_reconciliation',
      reason: 'provider_ended_without_signed_analysis',
    });

    // Re-running must not raise a second task.
    await tick(f.tenantId);
    expect(await fixtureDb.staffTask.count({
      where: { tenantId: f.tenantId, metadata: { path: ['callLogId'], equals: callLogId } },
    })).toBe(1);
  });

  it('leaves the row due when the provider cannot be reached, so the next tick tries again', async () => {
    const f = await fixture();
    const retellCallId = `call_${uniqueSuffix()}`;
    const { callLogId } = await strandedCall(f, {
      retellCallId,
      deadlineAt: new Date(Date.now() - 10 * 60_000),
    });
    providerCalls.set(retellCallId, { ok: false, error: 'retell_error_503' });

    const first = await tick(f.tenantId);
    expect(first).toMatchObject({ scanned: 1, closed: 0, errors: 1 });
    expect((await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } })).outcome).toBe('IN_PROGRESS');

    providerCalls.set(retellCallId, { ok: true, call: snapshot(retellCallId, { status: 'not_connected' }) });
    const second = await tick(f.tenantId);
    expect(second).toMatchObject({ scanned: 1, closed: 1, errors: 0 });
    expect((await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } })).outcome).toBe('NO_ANSWER');
  });

  it('never writes a provider snapshot that names a different tenant', async () => {
    const f = await fixture();
    const retellCallId = `call_${uniqueSuffix()}`;
    const { callLogId, targetId } = await strandedCall(f, {
      retellCallId,
      deadlineAt: new Date(Date.now() - 10 * 60_000),
    });
    providerCalls.set(retellCallId, { ok: true, call: snapshot(retellCallId, {
      status: 'ended', disconnectionReason: 'user_hangup', metadata: { tenantId: randomUUID() },
    }) });

    const summary = await tick(f.tenantId);

    expect(summary).toMatchObject({ scanned: 1, closed: 0, quarantined: 1 });
    expect((await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: callLogId } })).outcome).toBe('IN_PROGRESS');
    expect((await fixtureDb.receptionistCallTarget.findUniqueOrThrow({ where: { id: targetId } })).status).toBe('CALLING');
  });

  it('reconciles only the tenant it is scoped to', async () => {
    const mine = await fixture();
    const theirs = await fixture();
    const mineCall = await strandedCall(mine, { retellCallId: null, deadlineAt: new Date(Date.now() - 10 * 60_000) });
    const theirsCall = await strandedCall(theirs, { retellCallId: null, deadlineAt: new Date(Date.now() - 10 * 60_000) });

    const summary = await tick(mine.tenantId);

    expect(summary).toMatchObject({ scanned: 1, closed: 1 });
    expect((await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: mineCall.callLogId } })).outcome).toBe('FAILED');
    expect((await fixtureDb.receptionistCallLog.findUniqueOrThrow({ where: { id: theirsCall.callLogId } })).outcome).toBe('IN_PROGRESS');
  });

  it('fails closed when the active tenant context is not the tenant being reconciled', async () => {
    const mine = await fixture();
    const theirs = await fixture();
    await expect(runInTenantContext(
      { tenantId: mine.tenantId, actorId: CALL_RECONCILIATION_ACTOR, actorRole: 'WORKER', source: 'worker' },
      () => reconcileStrandedCalls(theirs.tenantId),
    )).rejects.toThrow(/does not match the tenant being reconciled/);
  });
});
