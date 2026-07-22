import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Control the real comms provider so we can assert HONEST delivery semantics:
// only a genuinely-sent reply may mark a conversation AI-handled / recovered.
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
const { db } = await import('../lib/db');
const { recomputeEntitlements } = await import('../lib/entitlements');

let app: FastifyInstance;
const tenants: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `ops-${id.slice(0, 6)}`, slug: `ops-${id.slice(0, 8)}` } });
  tenants.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Ient', phone: '+15551230000', email: 'p@x.test', lifecycleStage: 'NEW' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `a-${id.slice(0, 8)}@ops.test`, displayName: 'Admin' } });
  return { id, branchId: branch.id, patientId: patient.id, adminId: admin.id };
}

async function makeConversation(t: { id: string; branchId: string; patientId: string | null }, channel = 'CALL', status = 'unread') {
  return db.conversation.create({ data: { tenantId: t.id, branchId: t.branchId, patientId: t.patientId, channel: channel as never, status, latestMessage: 'missed call', estimatedValue: 120 } });
}

const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, type: 'access' });
const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': '203.0.113.9' });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenants) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});
beforeEach(() => sendMessageMock.mockReset());

describe('POST /v1/conversations/:id/reply — honest send (no fabricated recovery)', () => {
  it('delivers via the comms provider and only then marks the conversation recovered', async () => {
    sendMessageMock.mockResolvedValue({ ok: true, status: 'sent', providerMessageId: 'pm_1', mode: 'mock_dev' });
    const t = await makeTenant();
    const conv = await makeConversation(t, 'CALL');

    const res = await app.inject({
      method: 'POST', url: `/v1/conversations/${conv.id}/reply`, headers: auth(tok(t.id, t.adminId)),
      payload: { message: 'Sorry we missed your call — happy to help.', status: 'replied' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.delivered).toBe(true);
    expect(body.deliveryStatus).toBe('sent');

    // A real send actually happened: right channel, destination, tenant+patient context.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const callArgs = sendMessageMock.mock.calls[0];
    expect(callArgs[0]).toBe('sms'); // CALL recovery → SMS follow-up
    expect(callArgs[1]).toBe('+15551230000');
    expect(callArgs[3]).toContain('Sorry we missed your call');
    expect(callArgs[5]).toMatchObject({ tenantId: t.id, patientId: t.patientId });

    const after = await db.conversation.findUnique({ where: { id: conv.id } });
    expect(after?.aiHandled).toBe(true);
    expect(after?.lastAgentMessage).toBe('Sorry we missed your call — happy to help.');
    expect(after?.status).toBe('replied');
  });

  it('does NOT mark recovered when the recipient is suppressed / opted out', async () => {
    sendMessageMock.mockResolvedValue({ ok: false, status: 'suppressed', mode: 'suppressed', failureReason: 'suppressed_or_opted_out' });
    const t = await makeTenant();
    const conv = await makeConversation(t, 'CALL');

    const res = await app.inject({
      method: 'POST', url: `/v1/conversations/${conv.id}/reply`, headers: auth(tok(t.id, t.adminId)),
      payload: { message: 'Following up on your call.', status: 'replied' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
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
      payload: { message: 'Ping.', status: 'replied' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.delivered).toBe(false);
    expect(body.deliveryStatus).toBe('no_contact');
    expect(sendMessageMock).not.toHaveBeenCalled();

    const after = await db.conversation.findUnique({ where: { id: conv.id } });
    expect(after?.aiHandled).toBe(false);
    expect(after?.lastAgentMessage).toBeNull();
  });
});
