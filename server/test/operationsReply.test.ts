import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Control the real comms provider so we can assert HONEST delivery semantics:
// provider acceptance remains pending until a separate delivery receipt exists.
const { sendMessageMock } = vi.hoisted(() => ({ sendMessageMock: vi.fn() }));

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

vi.mock('../lib/commsProvider', async importActual => {
  const actual = await importActual<typeof import('../lib/commsProvider')>();
  return { ...actual, sendMessage: sendMessageMock };
});

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { recomputeEntitlements } = await import('../lib/entitlements');
const { PLANS } = await import('../modules/subscriptions/catalog');

let app: FastifyInstance;
const tenants: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `ops-${id.slice(0, 6)}`, slug: `ops-${id.slice(0, 8)}` } });
  tenants.push(id);
  const definition = PLANS.find(plan => plan.key === 'enterprise');
  if (!definition) throw new Error('Enterprise subscription fixture is unavailable');
  const plan = await db.subscriptionPlan.upsert({
    where: { key: definition.key },
    update: { name: definition.name, description: definition.description, tier: definition.tier, active: true },
    create: { key: definition.key, name: definition.name, description: definition.description, tier: definition.tier, active: true },
  });
  await Promise.all(definition.features.map(feature => db.subscriptionPlanFeature.upsert({
    where: { planId_featureKey: { planId: plan.id, featureKey: feature.featureKey } },
    update: { included: true, limitValue: feature.limitValue ?? null, note: feature.note ?? null },
    create: { planId: plan.id, featureKey: feature.featureKey, included: true, limitValue: feature.limitValue ?? null, note: feature.note ?? null },
  })));
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Ient', phone: '+15551230000', email: 'p@x.test', lifecycleStage: 'NEW' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `a-${id.slice(0, 8)}@ops.test`, displayName: 'Admin' } });
  return { id, branchId: branch.id, patientId: patient.id, adminId: admin.id };
}

async function makeConversation(t: { id: string; branchId: string; patientId: string | null }, channel = 'CALL', status = 'unread') {
  return db.conversation.create({ data: { tenantId: t.id, branchId: t.branchId, patientId: t.patientId, channel: channel as never, status, latestMessage: 'missed call', estimatedValue: 120 } });
}

const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': '203.0.113.9' });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenants) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});
beforeEach(() => sendMessageMock.mockReset());

describe('GET /v1/conversations — governed reply readiness', () => {
  it('returns masked, source-attributed readiness and fails closed after an opt-out', async () => {
    const t = await makeTenant();
    const linked = await makeConversation(t, 'CALL');
    const unlinked = await makeConversation({ ...t, patientId: null }, 'CALL');
    const token = tok(t.id, t.adminId);

    const initial = await app.inject({ method: 'GET', url: '/v1/conversations?limit=10', headers: auth(token) });
    expect(initial.statusCode).toBe(200);
    expect(initial.body).not.toContain('+15551230000');
    expect(initial.body).not.toContain('p@x.test');
    const initialRows = JSON.parse(initial.body) as Array<{ id: string; replyReadiness: Record<string, unknown> }>;
    const linkedReadiness = initialRows.find(row => row.id === linked.id)?.replyReadiness;
    expect(linkedReadiness).toMatchObject({
      channel: 'sms',
      destinationMasked: '***0000',
      identityStatus: 'patient_linked',
      destinationSource: 'linked_patient_record',
      destinationVerificationStatus: 'format_verified',
      authorizationBasis: 'recorded_inbound_conversation_reply',
      explicitConsentStatus: 'not_recorded',
      consentSource: null,
      suppressionStatus: 'not_suppressed',
      ready: true,
      readinessReason: 'ready_for_server_recheck',
      draftSource: 'rule_based_staff_review_draft',
    });
    expect(initialRows.find(row => row.id === unlinked.id)?.replyReadiness).toMatchObject({
      identityStatus: 'not_linked',
      destinationMasked: null,
      suppressionStatus: 'not_checked_no_destination',
      ready: false,
      readinessReason: 'patient_identity_not_linked',
    });

    await db.communicationConsent.create({
      data: { tenantId: t.id, patientId: t.patientId, channel: 'sms', status: 'opted_out', source: 'patient_request' },
    });
    const optedOut = await app.inject({ method: 'GET', url: '/v1/conversations?limit=10', headers: auth(token) });
    expect(optedOut.statusCode).toBe(200);
    const optedOutRows = JSON.parse(optedOut.body) as Array<{ id: string; replyReadiness: Record<string, unknown> }>;
    expect(optedOutRows.find(row => row.id === linked.id)?.replyReadiness).toMatchObject({
      explicitConsentStatus: 'opted_out',
      consentSource: 'patient_request',
      suppressionStatus: 'suppressed',
      ready: false,
      readinessReason: 'recipient_suppressed',
    });
  });
});

describe('POST /v1/conversations/:id/reply — honest send (no fabricated recovery)', () => {
  it('records provider acceptance as pending and does not claim delivery or recovery', async () => {
    sendMessageMock.mockResolvedValue({ ok: true, status: 'sent', providerMessageId: 'pm_1', mode: 'mock_dev' });
    const t = await makeTenant();
    const conv = await makeConversation(t, 'CALL');

    const res = await app.inject({
      method: 'POST', url: `/v1/conversations/${conv.id}/reply`, headers: auth(tok(t.id, t.adminId)),
      payload: { message: 'Sorry we missed your call — happy to help.', status: 'replied', clientAttemptKey: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBe(true);
    expect(body.delivered).toBe(false);
    expect(body.deliveryStatus).toBe('accepted');
    expect(body.message).toContain('No patient delivery occurred');

    // A real send actually happened: right channel, destination, tenant+patient context.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const callArgs = sendMessageMock.mock.calls[0];
    expect(callArgs[0]).toBe('sms'); // CALL recovery → SMS follow-up
    expect(callArgs[1]).toBe('+15551230000');
    expect(callArgs[2]).toBe('Message from b');
    expect(callArgs[3]).toContain('Sorry we missed your call');
    expect(callArgs[4]).toMatch(/^conv-reply-[0-9a-f-]+-[0-9a-f-]+-[0-9a-f-]+$/);
    expect(callArgs[5]).toMatchObject({ tenantId: t.id, patientId: t.patientId });

    const after = await db.conversation.findUnique({ where: { id: conv.id } });
    expect(after?.aiHandled).toBe(false);
    expect(after?.lastAgentMessage).toBe('Sorry we missed your call — happy to help.');
    expect(after?.status).toBe('pending');
    await expect(db.conversationReplyAttempt.findMany({
      where: { tenantId: t.id, conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
      select: { phase: true, status: true, destinationMasked: true, messageHash: true },
    })).resolves.toEqual([
      expect.objectContaining({ phase: 'INTENT', status: 'authorized', destinationMasked: '***0000', messageHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ phase: 'SUBMISSION_CLAIM', status: 'submission_claimed', destinationMasked: '***0000', messageHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ phase: 'RESULT', status: 'provider_accepted', destinationMasked: '***0000', messageHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
  });

  it('does NOT mark recovered when the recipient is suppressed / opted out', async () => {
    sendMessageMock.mockResolvedValue({ ok: false, status: 'suppressed', mode: 'suppressed', failureReason: 'suppressed_or_opted_out' });
    const t = await makeTenant();
    const conv = await makeConversation(t, 'CALL');

    const res = await app.inject({
      method: 'POST', url: `/v1/conversations/${conv.id}/reply`, headers: auth(tok(t.id, t.adminId)),
      payload: { message: 'Following up on your call.', status: 'replied', clientAttemptKey: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBe(false);
    expect(body.delivered).toBe(false);
    expect(body.deliveryStatus).toBe('suppressed');

    const after = await db.conversation.findUnique({ where: { id: conv.id } });
    expect(after?.aiHandled).toBe(false);
    expect(after?.lastAgentMessage).toBeNull();
    expect(after?.status).toBe('unread'); // untouched — nothing was sent
  });

  it('escalation sends nothing and never inflates recovery', async () => {
    const t = await makeTenant();
    const conv = await makeConversation(t, 'CALL');

    const res = await app.inject({
      method: 'POST', url: `/v1/conversations/${conv.id}/reply`, headers: auth(tok(t.id, t.adminId)),
      payload: { message: 'Escalating to manager.', status: 'escalated' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBeUndefined();
    expect(body.delivered).toBe(false);
    expect(body.deliveryStatus).toBe('escalated');
    expect(sendMessageMock).not.toHaveBeenCalled();

    const after = await db.conversation.findUnique({ where: { id: conv.id } });
    expect(after?.status).toBe('escalated');
    expect(after?.aiHandled).toBe(false);
    expect(after?.lastAgentMessage).toBeNull();
  });

  it('records no recovery when no real outbound channel/contact exists', async () => {
    const t = await makeTenant();
    const conv = await makeConversation(t, 'PUSH'); // no concrete sender wired

    const res = await app.inject({
      method: 'POST', url: `/v1/conversations/${conv.id}/reply`, headers: auth(tok(t.id, t.adminId)),
      payload: { message: 'Ping.', status: 'replied', clientAttemptKey: randomUUID() },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBe(false);
    expect(body.delivered).toBe(false);
    expect(body.deliveryStatus).toBe('no_contact');
    expect(sendMessageMock).not.toHaveBeenCalled();

    const after = await db.conversation.findUnique({ where: { id: conv.id } });
    expect(after?.aiHandled).toBe(false);
    expect(after?.lastAgentMessage).toBeNull();
  });

  it('replays a durable accepted result without a second provider submission', async () => {
    sendMessageMock.mockResolvedValue({ ok: true, status: 'sent', providerMessageId: 'pm_replay', mode: 'mock_dev' });
    const t = await makeTenant();
    const conv = await makeConversation(t, 'CALL');
    const clientAttemptKey = randomUUID();
    const request = {
      method: 'POST' as const,
      url: `/v1/conversations/${conv.id}/reply`,
      headers: auth(tok(t.id, t.adminId)),
      payload: { message: 'Reviewed operational reply.', status: 'replied', clientAttemptKey },
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({ accepted: true, delivered: false, deliveryStatus: 'accepted', replayed: true });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('records transport ambiguity and blocks every retry without claiming normal failure or delivery', async () => {
    sendMessageMock.mockResolvedValue({
      ok: false, status: 'failed', mode: 'live', failureReason: 'transport_ambiguous:connection reset',
    });
    const t = await makeTenant();
    const conv = await makeConversation(t, 'CALL');
    const token = tok(t.id, t.adminId);
    const first = await app.inject({
      method: 'POST', url: `/v1/conversations/${conv.id}/reply`, headers: auth(token),
      payload: { message: 'Reviewed operational reply.', status: 'replied', clientAttemptKey: randomUUID() },
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({
      accepted: false, delivered: false, deliveryStatus: 'submission_result_unknown',
      message: expect.stringContaining('Retrying is blocked'),
    });

    const retry = await app.inject({
      method: 'POST', url: `/v1/conversations/${conv.id}/reply`, headers: auth(token),
      payload: { message: 'Reviewed operational reply.', status: 'replied', clientAttemptKey: randomUUID() },
    });
    expect(retry.statusCode).toBe(409);
    expect(JSON.parse(retry.body)).toMatchObject({ delivered: false, deliveryStatus: 'submission_result_unknown' });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const readiness = await app.inject({ method: 'GET', url: '/v1/conversations?limit=10', headers: auth(token) });
    const rows = JSON.parse(readiness.body) as Array<{ id: string; replyReadiness: Record<string, unknown> }>;
    expect(rows.find(row => row.id === conv.id)?.replyReadiness).toMatchObject({
      submissionState: 'submission_result_unknown', ready: false, readinessReason: 'submission_result_unknown',
    });
  });
});
