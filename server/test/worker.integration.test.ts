import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { fixtureDb as db } from './helpers/fixtureDb';
import { createAutopilotWorker, executeAutopilotApprovedAction } from '../workers/autopilot.worker';
import { enqueueAutopilotExecution } from '../workers/queues';

// Proves the background worker actually CONSUMES an enqueued job end-to-end
// (real Redis + Postgres, no queue mock): an exactly fenced APPROVED action
// creates its allowlisted domain side effect, durable receipt, status, and
// audit trail after it is enqueued and the worker runs.

let worker: Worker;
const tenantIds: string[] = [];

beforeAll(() => {
  worker = createAutopilotWorker();
});

afterAll(async () => {
  await worker.close();
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await db.$disconnect();
});

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for worker to process the job');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

describe('worker runtime — queues are actually drained', () => {
  async function fixture(dispatchAttemptId = randomUUID()) {
    const tenantId = randomUUID();
    await db.tenant.create({ data: { id: tenantId, name: `wk-${tenantId.slice(0, 6)}`, slug: `wk-${tenantId.slice(0, 8)}` } });
    tenantIds.push(tenantId);
    const playbook = await db.autopilotPlaybook.create({ data: { tenantId, key: 'recall', name: 'Recall', description: 'demo', config: {} } });
    const approval = await db.autopilotApproval.create({
      data: {
        tenantId, playbookId: playbook.id, title: 'Send recall', reason: 'overdue', confidence: 90, status: 'APPROVED',
        payload: {
          actionType: 'CREATE_STAFF_TASK',
          task: { title: 'Call patient about overdue recall', priority: 'HIGH' },
          dispatch: {
            state: 'queued', attemptId: dispatchAttemptId,
            jobId: `autopilot-approval-pending-${approvalSequence++}`,
            recordedAt: new Date().toISOString(),
          },
        },
      },
    });
    return { tenantId, approval, dispatchAttemptId };
  }

  let approvalSequence = 0;

  it('executes the allowlisted domain action and stores its receipt atomically', async () => {
    const t = await fixture();

    await enqueueAutopilotExecution({ approvalId: t.approval.id, tenantId: t.tenantId, dispatchAttemptId: t.dispatchAttemptId });

    const executed = await waitFor(async () => {
      const row = await db.autopilotApproval.findUnique({ where: { id: t.approval.id }, select: { status: true, payload: true } });
      return row?.status === 'EXECUTED' ? row : null;
    });
    expect(executed.status).toBe('EXECUTED');
    expect(executed.payload).toMatchObject({
      dispatch: { state: 'dispatch_completed', attemptId: t.dispatchAttemptId },
      execution: {
        state: 'executed', actionType: 'CREATE_STAFF_TASK', attemptId: t.dispatchAttemptId,
        resource: 'staffTask', resourceId: expect.any(String),
      },
    });

    const task = await db.staffTask.findFirstOrThrow({ where: {
      tenantId: t.tenantId,
      metadata: { path: ['approvalId'], equals: t.approval.id },
    } });
    expect(task).toMatchObject({ title: 'Call patient about overdue recall', priority: 'high', status: 'OPEN' });
    expect(await db.auditEvent.count({
      where: { tenantId: t.tenantId, action: 'autopilot.approval.executed', resourceId: t.approval.id },
    })).toBe(1);
  }, 40_000);

  it('denies a stale dispatch attempt without creating a side effect', async () => {
    const t = await fixture();
    const result = await executeAutopilotApprovedAction({
      approvalId: t.approval.id, tenantId: t.tenantId,
      dispatchAttemptId: randomUUID(), jobId: 'stale-job',
    });
    expect(result).toEqual({ outcome: 'stale' });
    expect(await db.staffTask.count({ where: { tenantId: t.tenantId } })).toBe(0);
    expect((await db.autopilotApproval.findUniqueOrThrow({ where: { id: t.approval.id } })).status).toBe('APPROVED');
  });

  it('fails closed for an action outside the explicit allowlist', async () => {
    const t = await fixture();
    await db.autopilotApproval.update({
      where: { id: t.approval.id },
      data: { payload: {
        actionType: 'SEND_MESSAGE',
        task: { title: 'Must not execute', priority: 'HIGH' },
        dispatch: {
          state: 'queued', attemptId: t.dispatchAttemptId,
          jobId: 'unsupported-job', recordedAt: new Date().toISOString(),
        },
      } },
    });
    await expect(executeAutopilotApprovedAction({
      approvalId: t.approval.id, tenantId: t.tenantId,
      dispatchAttemptId: t.dispatchAttemptId, jobId: 'unsupported-job',
    })).rejects.toThrow(/unsupported_autopilot_payload/);
    expect(await db.staffTask.count({ where: { tenantId: t.tenantId } })).toBe(0);
    expect((await db.autopilotApproval.findUniqueOrThrow({ where: { id: t.approval.id } })).status).toBe('APPROVED');
  });

  it('returns the durable receipt on retry without duplicating the side effect or audit', async () => {
    const t = await fixture();
    const input = {
      approvalId: t.approval.id, tenantId: t.tenantId,
      dispatchAttemptId: t.dispatchAttemptId, jobId: 'idempotency-job',
    };
    const first = await executeAutopilotApprovedAction(input);
    const retry = await executeAutopilotApprovedAction(input);
    expect(first).toMatchObject({ outcome: 'executed', resource: 'staffTask' });
    if (first.outcome !== 'executed') throw new Error(`expected execution, received ${first.outcome}`);
    expect(retry).toEqual({ outcome: 'already_executed', resource: 'staffTask', resourceId: first.resourceId });
    expect(await db.staffTask.count({ where: { tenantId: t.tenantId } })).toBe(1);
    expect(await db.auditEvent.count({
      where: { tenantId: t.tenantId, action: 'autopilot.approval.executed', resourceId: t.approval.id },
    })).toBe(1);
  });
});
