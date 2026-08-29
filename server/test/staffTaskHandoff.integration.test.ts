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
const { fixtureDb: db } = await import('./helpers/fixtureDb');

// ===========================================================================
// Controls that tell a user work was handed to the front desk must actually
// file a StaffTask, exactly once, and that task must be assignable and
// completable. These suites cover the hand-off, its idempotency, and who is
// allowed to put a name on a task.
// ===========================================================================

let app: FastifyInstance;
const tenantIds: string[] = [];

interface Fixture {
  tenantId: string;
  branchA: string;
  branchB: string;
  owner: string;
  frontDesk: string;
  /** FRONT_DESK pinned to branch B, so cross-branch assignment can be tested. */
  frontDeskB: string;
  opportunityId: string;
}

async function makeFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await db.tenant.create({ data: { id: tenantId, name: `handoff-${tenantId.slice(0, 6)}`, slug: `handoff-${tenantId.slice(0, 8)}` } });
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId, name: 'Branch A', location: 'A' } }),
    db.branch.create({ data: { tenantId, name: 'Branch B', location: 'B' } }),
  ]);
  const mkUser = (role: string, branchId: string | null, tag: string) => db.user.create({
    data: { tenantId, role: role as never, active: true, branchId, email: `${tag}-${tenantId.slice(0, 8)}@handoff.test`, displayName: `${role} ${tag}` },
  });
  const [owner, frontDesk, frontDeskB] = await Promise.all([
    mkUser('OWNER', null, 'owner'),
    mkUser('FRONT_DESK', branchA.id, 'fd-a'),
    mkUser('FRONT_DESK', branchB.id, 'fd-b'),
  ]);
  const opportunity = await db.opportunity.create({ data: {
    tenantId, branchId: branchA.id, title: 'Uncontacted callers', source: 'receptionist_call_log',
    category: 'front-desk', trigger: 'calls_without_followup', automationSteps: { steps: [] },
    confidence: 60, effortLevel: 'low', urgency: 'high', status: 'pending',
    recommendedAction: 'Call the callers back.',
  } });
  return { tenantId, branchA: branchA.id, branchB: branchB.id, owner: owner.id, frontDesk: frontDesk.id, frontDeskB: frontDeskB.id, opportunityId: opportunity.id };
}

const auth = (f: Fixture, userId: string, role: string) => ({
  authorization: `Bearer ${app.jwt.sign({ userId, tenantId: f.tenantId, role, type: 'access' })}`,
});

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('opportunity hand-off files real work', () => {
  it('creates one branch-scoped StaffTask, and repeating the action does not duplicate it', async () => {
    const f = await makeFixture();
    const send = () => app.inject({
      method: 'POST', url: `/v1/opportunities/${f.opportunityId}/handoff`,
      headers: auth(f, f.owner, 'OWNER'), payload: { verb: 'send_front_desk' },
    });

    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(first.json().taskCreated).toBe(true);
    const taskId = first.json().task.id;

    const second = await send();
    expect(second.statusCode).toBe(200);
    expect(second.json().taskCreated).toBe(false);
    expect(second.json().task.id).toBe(taskId);
    expect(second.json().message).toMatch(/already exists/i);

    const tasks = await db.staffTask.findMany({ where: { tenantId: f.tenantId } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ branchId: f.branchA, status: 'OPEN', assignedToId: null });
    expect(tasks[0].metadata).toMatchObject({
      workflow: 'opportunity_handoff', entityType: 'opportunity', entityId: f.opportunityId, verb: 'send_front_desk',
    });

    // The opportunity status moves in the same transaction as the task.
    expect((await db.opportunity.findUniqueOrThrow({ where: { id: f.opportunityId } })).status).toBe('assigned');
    expect(await db.auditEvent.count({ where: { tenantId: f.tenantId, action: 'opportunity.handoff' } })).toBe(2);
  });

  it('keeps the two hand-off verbs as separate pieces of work', async () => {
    const f = await makeFixture();
    for (const verb of ['send_front_desk', 'assign_callback'] as const) {
      const res = await app.inject({
        method: 'POST', url: `/v1/opportunities/${f.opportunityId}/handoff`,
        headers: auth(f, f.owner, 'OWNER'), payload: { verb },
      });
      expect(res.json().taskCreated).toBe(true);
    }
    expect(await db.staffTask.count({ where: { tenantId: f.tenantId } })).toBe(2);
  });

  it('allows a fresh hand-off once the previous task is closed', async () => {
    const f = await makeFixture();
    const first = await app.inject({
      method: 'POST', url: `/v1/opportunities/${f.opportunityId}/handoff`,
      headers: auth(f, f.owner, 'OWNER'), payload: { verb: 'send_front_desk' },
    });
    const taskId = first.json().task.id;
    await db.staffTask.update({ where: { id: taskId }, data: { status: 'COMPLETED' } });

    const again = await app.inject({
      method: 'POST', url: `/v1/opportunities/${f.opportunityId}/handoff`,
      headers: auth(f, f.owner, 'OWNER'), payload: { verb: 'send_front_desk' },
    });
    expect(again.json().taskCreated).toBe(true);
    expect(again.json().task.id).not.toBe(taskId);
  });

  it('refuses another tenant\'s opportunity and files nothing', async () => {
    const [f, other] = await Promise.all([makeFixture(), makeFixture()]);
    const res = await app.inject({
      method: 'POST', url: `/v1/opportunities/${other.opportunityId}/handoff`,
      headers: auth(f, f.owner, 'OWNER'), payload: { verb: 'send_front_desk' },
    });
    expect(res.statusCode).toBe(404);
    expect(await db.staffTask.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect(await db.staffTask.count({ where: { tenantId: other.tenantId } })).toBe(0);
  });
});

describe('conversation escalation hands the work to a person', () => {
  async function makeConversation(f: Fixture) {
    return db.conversation.create({ data: {
      tenantId: f.tenantId, branchId: f.branchA, channel: 'SMS', status: 'open',
      latestMessage: 'Please call me back about my appointment.',
    } });
  }

  it('creates exactly one escalation task however many times it is escalated', async () => {
    const f = await makeFixture();
    const conversation = await makeConversation(f);
    const escalate = () => app.inject({
      method: 'POST', url: `/v1/conversations/${conversation.id}/reply`,
      headers: auth(f, f.owner, 'OWNER'), payload: { message: 'Front desk to call back.', status: 'escalated' },
    });

    const first = await escalate();
    expect(first.statusCode).toBe(200);
    expect(first.json().deliveryStatus).toBe('escalated');
    expect(first.json().taskCreated).toBe(true);
    expect(first.json().message).toMatch(/task was created in Staff Tasks/i);

    const second = await escalate();
    expect(second.json().taskCreated).toBe(false);
    expect(second.json().task.id).toBe(first.json().task.id);

    const tasks = await db.staffTask.findMany({ where: { tenantId: f.tenantId } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ branchId: f.branchA, status: 'OPEN' });
    expect(tasks[0].metadata).toMatchObject({ workflow: 'conversation_escalation', entityId: conversation.id });
    // Escalation is internal: the patient is never messaged.
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).lastAgentMessage).toBeNull();
  });
});

describe('putting a name on a task', () => {
  async function openTask(f: Fixture, branchId: string = f.branchA) {
    return db.staffTask.create({ data: { tenantId: f.tenantId, branchId, title: 'Call the patient', priority: 'high' } });
  }

  it('lets a front desk take a task itself but not hand it to somebody else', async () => {
    const f = await makeFixture();
    const task = await openTask(f);

    const claim = await app.inject({
      method: 'PATCH', url: `/v1/staff/tasks/${task.id}/assignment`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { assignedToId: f.frontDesk },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().assignedToId).toBe(f.frontDesk);

    const push = await app.inject({
      method: 'PATCH', url: `/v1/staff/tasks/${task.id}/assignment`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { assignedToId: f.owner },
    });
    expect(push.statusCode).toBe(403);
    expect((await db.staffTask.findUniqueOrThrow({ where: { id: task.id } })).assignedToId).toBe(f.frontDesk);

    // Giving their own task back is theirs to do.
    const release = await app.inject({
      method: 'PATCH', url: `/v1/staff/tasks/${task.id}/assignment`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { assignedToId: null },
    });
    expect(release.statusCode).toBe(200);
    expect(release.json().assignedToId).toBeNull();
  });

  it('lets staff:write assign to a colleague and records who moved it', async () => {
    const f = await makeFixture();
    const task = await openTask(f);
    const res = await app.inject({
      method: 'PATCH', url: `/v1/staff/tasks/${task.id}/assignment`,
      headers: auth(f, f.owner, 'OWNER'), payload: { assignedToId: f.frontDesk },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assignedTo.displayName).toBe('FRONT_DESK fd-a');
    expect(await db.auditEvent.count({ where: {
      tenantId: f.tenantId, action: 'task.assignment.updated', resourceId: task.id,
    } })).toBe(1);
  });

  it('refuses an assignee whose branch would hide the task from them', async () => {
    const f = await makeFixture();
    const task = await openTask(f, f.branchA);
    const res = await app.inject({
      method: 'PATCH', url: `/v1/staff/tasks/${task.id}/assignment`,
      headers: auth(f, f.owner, 'OWNER'), payload: { assignedToId: f.frontDeskB },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/different branch/i);
    expect((await db.staffTask.findUniqueOrThrow({ where: { id: task.id } })).assignedToId).toBeNull();
  });

  it('refuses to reassign a finished task', async () => {
    const f = await makeFixture();
    const task = await openTask(f);
    await db.staffTask.update({ where: { id: task.id }, data: { status: 'COMPLETED' } });
    const res = await app.inject({
      method: 'PATCH', url: `/v1/staff/tasks/${task.id}/assignment`,
      headers: auth(f, f.owner, 'OWNER'), payload: { assignedToId: f.frontDesk },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses an assignee from another tenant', async () => {
    const [f, other] = await Promise.all([makeFixture(), makeFixture()]);
    const task = await openTask(f);
    const res = await app.inject({
      method: 'PATCH', url: `/v1/staff/tasks/${task.id}/assignment`,
      headers: auth(f, f.owner, 'OWNER'), payload: { assignedToId: other.frontDesk },
    });
    expect(res.statusCode).toBe(400);
    expect((await db.staffTask.findUniqueOrThrow({ where: { id: task.id } })).assignedToId).toBeNull();
  });

  it('runs the whole queue loop: hand-off, take, start, complete', async () => {
    const f = await makeFixture();
    const handoff = await app.inject({
      method: 'POST', url: `/v1/opportunities/${f.opportunityId}/handoff`,
      headers: auth(f, f.owner, 'OWNER'), payload: { verb: 'send_front_desk' },
    });
    const taskId = handoff.json().task.id;

    const listed = await app.inject({ method: 'GET', url: '/v1/tasks?limit=100', headers: auth(f, f.frontDesk, 'FRONT_DESK') });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((t: { id: string }) => t.id)).toContain(taskId);

    for (const [url, payload] of [
      [`/v1/staff/tasks/${taskId}/assignment`, { assignedToId: f.frontDesk }],
      [`/v1/staff/tasks/${taskId}/status`, { status: 'IN_PROGRESS' }],
      [`/v1/staff/tasks/${taskId}/status`, { status: 'COMPLETED' }],
    ] as const) {
      const res = await app.inject({ method: 'PATCH', url, headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload });
      expect(res.statusCode, url).toBe(200);
    }

    expect(await db.staffTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      status: 'COMPLETED', assignedToId: f.frontDesk,
    });
  });

  it('only offers the assignee roster to a caller who may assign', async () => {
    const f = await makeFixture();
    const denied = await app.inject({ method: 'GET', url: '/v1/staff/assignees', headers: auth(f, f.frontDesk, 'FRONT_DESK') });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({ method: 'GET', url: '/v1/staff/assignees', headers: auth(f, f.owner, 'OWNER') });
    expect(allowed.statusCode).toBe(200);
    const ids = allowed.json().map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([f.owner, f.frontDesk, f.frontDeskB]));
  });
});
