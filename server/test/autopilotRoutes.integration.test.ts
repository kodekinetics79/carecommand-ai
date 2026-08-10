import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const queueMocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (data: { dispatchAttemptId?: string }) => ({
    state: 'queued' as 'queued' | 'disabled',
    jobId: 'autopilot-test-job',
    dispatchAttemptId: data.dispatchAttemptId,
  })),
  enqueueResult: 'queued' as 'queued' | 'disabled',
  capabilityAvailable: true,
}));

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: queueMocks.enqueue,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

vi.mock('../modules/autopilot/dispatch', async () => {
  const actual = await vi.importActual<typeof import('../modules/autopilot/dispatch')>('../modules/autopilot/dispatch');
  return {
    ...actual,
    getAutopilotDispatchCapability: () => queueMocks.capabilityAvailable
      ? { available: true, mode: 'background_queue', reason: null }
      : { available: false, mode: 'manual_retry_required', reason: 'Background execution is disabled for this deployment.' },
  };
});

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');

let app: FastifyInstance;
const tenantIds: string[] = [];

type TestUser = { tenantId: string; userId: string };

async function fixture() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await db.tenant.create({ data: { id: tenantId, name: `apr-${tenantId.slice(0, 6)}`, slug: `apr-${tenantId.slice(0, 8)}` } });
  const admin = await db.user.create({
    data: { tenantId, email: `owner-${tenantId}@apr.test`, displayName: 'Owner', role: 'OWNER', active: true },
  });
  const manager = await db.user.create({
    data: { tenantId, email: `manager-${tenantId}@apr.test`, displayName: 'Manager', role: 'MANAGER', active: true },
  });
  const provider = await db.user.create({
    data: { tenantId, email: `provider-${tenantId}@apr.test`, displayName: 'Provider', role: 'PROVIDER', active: true },
  });
  const playbook = await db.autopilotPlaybook.create({
    data: { tenantId, key: `staff-task-${tenantId.slice(0, 8)}`, name: 'Staff task', description: 'queue test', config: {} },
  });
  const approval = await db.autopilotApproval.create({
    data: {
      tenantId, playbookId: playbook.id, title: 'Review task', reason: 'queue test',
      status: 'PENDING', confidence: 90, payload: { actionType: 'CREATE_STAFF_TASK', task: { title: 'Call patient', priority: 'HIGH' } },
    },
  });
  return {
    tenantId,
    approval,
    owner: { tenantId, userId: admin.id, role: 'OWNER' as const },
    manager: { tenantId, userId: manager.id, role: 'MANAGER' as const },
    provider: { tenantId, userId: provider.id, role: 'PROVIDER' as const },
  };
}

function headers(t: TestUser, role: 'OWNER' | 'MANAGER' | 'PROVIDER') {
  return { authorization: `Bearer ${app.jwt.sign({ tenantId: t.tenantId, userId: t.userId, role, type: 'access' })}` };
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

beforeEach(() => {
  queueMocks.capabilityAvailable = true;
  queueMocks.enqueue.mockReset();
  queueMocks.enqueue.mockImplementation(async data => ({
    state: queueMocks.enqueueResult,
    jobId: 'autopilot-test-job',
    dispatchAttemptId: data.dispatchAttemptId,
  }));
  queueMocks.enqueueResult = 'queued';
});

afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('Autopilot approval dispatch execution behavior', () => {
  it('approves a pending approval, records queue state, and enqueues one dispatch attempt', async () => {
    const t = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/autopilot/approvals/${t.approval.id}/approve`,
      headers: headers(t.owner, 'OWNER'),
    });
    expect(response.statusCode).toBe(200);
    expect(queueMocks.enqueue).toHaveBeenCalledWith({
      approvalId: t.approval.id,
      tenantId: t.tenantId,
      dispatchAttemptId: expect.any(String),
    });
    expect(response.json()).toMatchObject({
      id: t.approval.id,
      status: 'APPROVED',
      dispatch: {
        state: 'queued',
        capability: { available: true, mode: 'background_queue' },
      },
    });
    expect((await db.autopilotApproval.findUniqueOrThrow({ where: { id: t.approval.id } })).payload).toMatchObject({
      dispatch: {
        state: 'queued',
        attemptId: expect.any(String),
        jobId: 'autopilot-test-job',
      },
    });
    expect(await db.auditEvent.count({
      where: { tenantId: t.tenantId, action: 'autopilot.approval.approved', resourceId: t.approval.id },
    })).toBe(1);
  });

  it('is idempotent and rejects duplicate approvals once state is no longer pending', async () => {
    const t = await fixture();
    const first = await app.inject({
      method: 'POST',
      url: `/v1/autopilot/approvals/${t.approval.id}/approve`,
      headers: headers(t.owner, 'OWNER'),
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/autopilot/approvals/${t.approval.id}/approve`,
      headers: headers(t.owner, 'OWNER'),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toMatch(/no longer pending/i);
  });

  it('does not execute a queue when the role is disallowed and returns 403', async () => {
    const t = await fixture();
    const denied = await app.inject({
      method: 'POST',
      url: `/v1/autopilot/approvals/${t.approval.id}/approve`,
      headers: headers(t.provider, 'PROVIDER'),
    });
    expect(denied.statusCode).toBe(403);
    expect(await db.auditEvent.count({ where: {
      tenantId: t.tenantId,
      action: 'autopilot.approval.approved',
      resourceId: t.approval.id,
    } })).toBe(0);
  });

  it('transitions to a durable retry-required state if enqueue is unavailable but queues are enabled', async () => {
    const t = await fixture();
    queueMocks.enqueueResult = 'disabled';
    const response = await app.inject({
      method: 'POST',
      url: `/v1/autopilot/approvals/${t.approval.id}/approve`,
      headers: headers(t.manager, 'MANAGER'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'APPROVED',
      dispatch: {
        state: 'dispatch_failed',
        capability: { available: true, mode: 'background_queue' },
      },
    });
    expect(await db.auditEvent.count({
      where: {
        tenantId: t.tenantId,
        action: 'autopilot.approval.dispatchFailed',
        resourceId: t.approval.id,
      },
    })).toBe(1);
  });

  it('holds pending-dispatch when environment disables queueing', async () => {
    const t = await fixture();
    queueMocks.capabilityAvailable = false;
    queueMocks.enqueueResult = 'disabled';
    const response = await app.inject({
      method: 'POST',
      url: `/v1/autopilot/approvals/${t.approval.id}/approve`,
      headers: headers(t.owner, 'OWNER'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'APPROVED',
      dispatch: {
        state: 'pending_dispatch',
        capability: { available: false, mode: 'manual_retry_required' },
      },
    });
    expect(await db.auditEvent.count({
      where: {
        tenantId: t.tenantId,
        action: 'autopilot.approval.dispatchFailed',
        resourceId: t.approval.id,
      },
    })).toBe(0);
  });
});
