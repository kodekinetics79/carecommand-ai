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
let tenantId = '';
let adminId = '';
let frontDeskId = '';
let callId = '';
const auditFaultCleanup: Array<() => Promise<void>> = [];
const phoneFor = (id: string) => `+1${(BigInt(`0x${id.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0')}`;

const token = (userId: string, role: 'ADMIN' | 'FRONT_DESK') => app.jwt.sign({ userId, tenantId, role, type: 'access' });
const auth = (userId: string, role: 'ADMIN' | 'FRONT_DESK') => ({ authorization: `Bearer ${token(userId, role)}` });
const reviewBody = (operation: 'SAVE_DRAFT' | 'MARK_REVIEWED' | 'SIGN_OFF', expectedRevision: number, acknowledgeUnresolvedActions?: true) => ({
  operation,
  expectedRevision,
  operationalNotes: {
    summary: 'Staff verified the scheduling request.',
    correction: 'No clinical advice was requested or provided.',
    callerIntent: 'Routine appointment',
    actionsTaken: ['Checked the appointment request queue'],
    followUpNotes: 'Confirm the preferred provider.',
  },
  unresolvedActionItems: ['Confirm preferred provider'],
  ...(acknowledgeUnresolvedActions ? { acknowledgeUnresolvedActions } : {}),
});

async function installAuditFault(action: string) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_receptionist_review_audit_fault_fn_${suffix}`;
  const triggerName = `test_receptionist_review_audit_fault_trg_${suffix}`;
  await db.$executeRawUnsafe(`
    CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW."tenantId" = '${tenantId}'::uuid AND NEW.action = '${action}' THEN
        RAISE EXCEPTION 'injected receptionist review audit failure';
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await db.$executeRawUnsafe(`
    CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."AuditEvent"
    FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
  `);
  let active = true;
  const remove = async () => {
    if (!active) return;
    active = false;
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."AuditEvent"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
  };
  auditFaultCleanup.push(remove);
  return remove;
}

beforeAll(async () => {
  app = await buildApp();
  tenantId = randomUUID();
  await db.tenant.create({ data: { id: tenantId, name: 'Operator review tenant', slug: `operator-review-${tenantId.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.create({ data: { tenantId, featureKey: 'ai_receptionist', enabled: true, source: 'test' } });
  const [admin, frontDesk, providerUser, branch] = await Promise.all([
    db.user.create({ data: { tenantId, email: `admin-${tenantId}@test.invalid`, displayName: 'Review Admin', role: 'ADMIN' } }),
    db.user.create({ data: { tenantId, email: `front-${tenantId}@test.invalid`, displayName: 'Front Desk Reviewer', role: 'FRONT_DESK' } }),
    db.user.create({ data: { tenantId, email: `provider-${tenantId}@test.invalid`, displayName: 'Review Provider', role: 'PROVIDER' } }),
    db.branch.create({ data: { tenantId, name: 'Review Branch', location: 'Synthetic location', timezone: 'America/New_York' } }),
  ]);
  adminId = admin.id;
  frontDeskId = frontDesk.id;
  const provider = await db.providerProfile.create({
    data: { tenantId, branchId: branch.id, userId: providerUser.id, specialty: 'Primary Care' },
  });
  const clinic = await db.receptionistClinic.create({ data: { tenantId, name: 'Review Clinic', phone: phoneFor(tenantId), country: 'US', timezone: 'America/New_York', defaultLanguage: 'en-US' } });
  const call = await db.receptionistCallLog.create({
    data: {
      tenantId,
      clinicId: clinic.id,
      retellCallId: `synthetic-call-${tenantId}`,
      transcriptSummary: 'Provider-derived synthetic summary.',
      recordingUrl: 'https://recordings.example.test/synthetic-call',
      outcome: 'BOOKED',
    },
  });
  callId = call.id;
  const patient = await db.patient.create({
    data: { tenantId, branchId: branch.id, firstName: 'Synthetic', lastName: 'Patient', lifecycleStage: 'NEW' },
  });
  const appointment = await db.appointment.create({
    data: {
      tenantId,
      branchId: branch.id,
      patientId: patient.id,
      service: 'Routine visit',
      startsAt: new Date('2030-01-02T15:00:00.000Z'),
      endsAt: new Date('2030-01-02T15:30:00.000Z'),
      status: 'CONFIRMED',
      channel: 'CALL',
      providerProfileId: provider.id,
      receptionistCallLogId: call.id,
    },
  });
  await db.appointmentRequest.create({
    data: {
      tenantId,
      branchId: branch.id,
      patientId: patient.id,
      callLogId: call.id,
      requestedService: 'Routine visit',
      status: 'BOOKED',
      source: 'ai_receptionist',
      missingFields: [],
      bookedAppointmentId: appointment.id,
    },
  });
  await db.staffTask.create({
    data: {
      tenantId,
      branchId: branch.id,
      title: 'AI receptionist human handoff requested',
      priority: 'high',
      metadata: { workflow: 'receptionist_safety', kind: 'human_handoff', callId: call.retellCallId },
    },
  });
}, 60_000);

afterAll(async () => {
  for (const remove of auditFaultCleanup.reverse()) await remove().catch(() => undefined);
  if (tenantId) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('AI receptionist operator review workflow', () => {
  it('returns permission-aware media state, attributed provider analysis, and linked operational references', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/receptionist/call-logs/${callId}`, headers: auth(frontDeskId, 'FRONT_DESK') });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      recordingAvailable: true,
      recordingAccess: 'restricted',
      recordingUrl: null,
      providerSummary: { text: 'Provider-derived synthetic summary.', source: 'PROVIDER_CALL_ANALYSIS' },
      reviewCapabilities: { canEdit: true, canSignOff: false },
      appointments: [{ service: 'Routine visit', status: 'CONFIRMED' }],
      appointmentRequests: [{ requestedService: 'Routine visit', status: 'BOOKED' }],
      handoffReferences: [{ title: 'AI receptionist human handoff requested', status: 'OPEN' }],
    });
  });

  it('attributes staff notes, rejects stale writes, enforces manager sign-off, and makes sign-off terminal', async () => {
    const removeFault = await installAuditFault('receptionistCallLog.operatorReview.save_draft');
    const failedDraft = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callId}/operator-review`,
      headers: auth(frontDeskId, 'FRONT_DESK'), payload: reviewBody('SAVE_DRAFT', 0),
    });
    expect(failedDraft.statusCode).toBe(500);
    expect(await db.receptionistCallLog.findUnique({
      where: { id: callId }, select: { reviewStatus: true, reviewRevision: true, operationalNotes: true },
    })).toEqual({ reviewStatus: 'UNREVIEWED', reviewRevision: 0, operationalNotes: null });
    await removeFault();

    const draft = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callId}/operator-review`,
      headers: auth(frontDeskId, 'FRONT_DESK'), payload: reviewBody('SAVE_DRAFT', 0),
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({
      reviewStatus: 'DRAFT', reviewRevision: 1,
      operationalNotes: { source: 'STAFF_ENTERED', actorUserId: frontDeskId },
      unresolvedActionItems: ['Confirm preferred provider'],
    });

    const stale = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callId}/operator-review`,
      headers: auth(frontDeskId, 'FRONT_DESK'), payload: reviewBody('MARK_REVIEWED', 0),
    });
    expect(stale.statusCode).toBe(409);

    const reviewed = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callId}/operator-review`,
      headers: auth(frontDeskId, 'FRONT_DESK'), payload: reviewBody('MARK_REVIEWED', 1),
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json()).toMatchObject({ reviewStatus: 'REVIEWED', reviewRevision: 2, reviewedByUserId: frontDeskId });

    const frontDeskSignoff = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callId}/operator-review`,
      headers: auth(frontDeskId, 'FRONT_DESK'), payload: reviewBody('SIGN_OFF', 2, true),
    });
    expect(frontDeskSignoff.statusCode).toBe(403);
    expect(frontDeskSignoff.json().permission).toBe('receptionist:manage');

    const unacknowledged = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callId}/operator-review`,
      headers: auth(adminId, 'ADMIN'), payload: reviewBody('SIGN_OFF', 2),
    });
    expect(unacknowledged.statusCode).toBe(400);

    const editedSignoffBody = reviewBody('SIGN_OFF', 2, true);
    editedSignoffBody.operationalNotes.summary = 'Unsaved manager edit must not be signed.';
    const editedSignoff = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callId}/operator-review`,
      headers: auth(adminId, 'ADMIN'), payload: editedSignoffBody,
    });
    expect(editedSignoff.statusCode).toBe(409);

    const signed = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callId}/operator-review`,
      headers: auth(adminId, 'ADMIN'), payload: reviewBody('SIGN_OFF', 2, true),
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toMatchObject({ reviewStatus: 'SIGNED_OFF', reviewRevision: 3, signedOffByUserId: adminId });

    const overwrite = await app.inject({
      method: 'PATCH', url: `/v1/receptionist/call-logs/${callId}/operator-review`,
      headers: auth(adminId, 'ADMIN'), payload: reviewBody('SIGN_OFF', 3, true),
    });
    expect(overwrite.statusCode).toBe(409);

    const events = await db.auditEvent.findMany({
      where: { tenantId, resource: 'receptionistCallLog', resourceId: callId, action: { startsWith: 'receptionistCallLog.operatorReview.' } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map(event => event.action)).toEqual([
      'receptionistCallLog.operatorReview.save_draft',
      'receptionistCallLog.operatorReview.mark_reviewed',
      'receptionistCallLog.operatorReview.sign_off',
    ]);
  });
});
