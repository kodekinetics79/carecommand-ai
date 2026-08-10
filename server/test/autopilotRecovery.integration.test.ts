import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../generated/prisma/client';
import { fixtureDb as db } from './helpers/fixtureDb';
import {
  reconcileQueuedAutopilotDispatch,
  reconcileStrandedAutopilotDispatches,
  type QueuedAutopilotDispatch,
} from '../workers/autopilotRecovery';
import { autopilotQueue } from '../workers/queues';

const tenantIds: string[] = [];

async function queuedApproval() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await db.tenant.create({ data: {
    id: tenantId, name: `ar-${tenantId.slice(0, 6)}`, slug: `ar-${tenantId.slice(0, 8)}`,
  } });
  const reviewer = await db.user.create({ data: {
    tenantId, email: `reviewer-${tenantId.slice(0, 8)}@scanner.test`, displayName: 'Reviewer', role: 'ADMIN', active: true,
  } });
  const playbook = await db.autopilotPlaybook.create({ data: {
    tenantId, key: 'staff-task', name: 'Staff task', description: 'scanner test', config: {},
  } });
  const dispatchAttemptId = randomUUID();
  const approval = await db.autopilotApproval.create({
    data: {
      tenantId, playbookId: playbook.id, title: 'Recover queued action', reason: 'test', confidence: 90,
      status: 'APPROVED', reviewedById: reviewer.id, reviewedAt: new Date(),
      payload: {
        actionType: 'CREATE_STAFF_TASK', task: { title: 'Recover queued action', priority: 'HIGH' },
        dispatch: { state: 'queued', attemptId: dispatchAttemptId, recordedAt: new Date().toISOString() },
      },
    },
  });
  return { tenantId, approval, dispatchAttemptId };
}

afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await db.$disconnect();
});

describe('Autopilot startup/periodic dispatch recovery', () => {
  it('marks queued rows failed when their deterministic BullMQ job is missing', async () => {
    const t = await queuedApproval();
    const jobId = `autopilot-approval-${t.approval.id}`;
    await (await autopilotQueue.getJob(jobId))?.remove();

    const summary = await reconcileStrandedAutopilotDispatches({ tenantIds: [t.tenantId] });
    expect(summary).toMatchObject({ scanned: 1, reconciled: 1, errors: 0 });

    const stored = await db.autopilotApproval.findUniqueOrThrow({ where: { id: t.approval.id } });
    expect(stored).toMatchObject({
      status: 'APPROVED',
      payload: {
        dispatch: {
          state: 'dispatch_failed',
          attemptId: t.dispatchAttemptId,
          failureCode: 'queue_job_missing',
          jobId,
        },
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

  it('continues through more than one full page of queued candidates', async () => {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await db.tenant.create({ data: {
      id: tenantId, name: `ap-${tenantId.slice(0, 6)}`, slug: `ap-${tenantId.slice(0, 8)}`,
    } });
    const reviewer = await db.user.create({ data: {
      tenantId, email: `reviewer-${tenantId.slice(0, 8)}@paging.test`, displayName: 'Reviewer', role: 'ADMIN', active: true,
    } });
    const playbook = await db.autopilotPlaybook.create({ data: {
      tenantId, key: 'staff-task', name: 'Staff task', description: 'paging test', config: {},
    } });
    const queuedApprovals = Array.from({ length: 100 }, (_, index) => ({
      id: randomUUID(),
      tenantId,
      playbookId: playbook.id,
      title: `Queued ${index}`,
      reason: 'pagination recovery candidate',
      confidence: 50,
      status: 'APPROVED' as Prisma.AutopilotApprovalCreateManyInput['status'],
      reviewedById: reviewer.id,
      reviewedAt: new Date(),
      payload: {
        actionType: 'CREATE_STAFF_TASK',
        task: { title: `Queued ${index}`, priority: 'NORMAL' },
        dispatch: { state: 'queued', attemptId: randomUUID(), recordedAt: new Date().toISOString() },
      },
    }));
    await db.autopilotApproval.createMany({ data: queuedApprovals });
    const dispatchAttemptId = randomUUID();
    const targetId = randomUUID();
    const target = await db.autopilotApproval.create({
      data: {
        id: targetId,
        tenantId,
        playbookId: playbook.id,
        title: 'Second page target',
        reason: 'test',
        confidence: 90,
        status: 'APPROVED',
        reviewedById: reviewer.id,
        reviewedAt: new Date(),
        payload: {
          actionType: 'CREATE_STAFF_TASK',
          task: { title: 'Second page target', priority: 'HIGH' },
          dispatch: { state: 'queued', attemptId: dispatchAttemptId, recordedAt: new Date().toISOString() },
        },
      },
    });

    const summary = await reconcileStrandedAutopilotDispatches({ tenantIds: [tenantId] });
    expect(summary).toMatchObject({ scanned: 101, reconciled: 101, errors: 0 });
    expect(await db.autopilotApproval.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      payload: {
        dispatch: {
          state: 'dispatch_failed',
          failureCode: 'queue_job_missing',
        },
      },
    });
  });

  it.each([
    ['newer pending generation', 'APPROVED', 'pending_dispatch'],
    ['newer queued generation', 'APPROVED', 'queued'],
    ['executed evidence', 'EXECUTED', 'queued'],
    ['domain failure evidence', 'FAILED', 'queued'],
  ] as const)('does not overwrite %s', async (_label, status, dispatchState) => {
    const t = await queuedApproval();
    const stale: QueuedAutopilotDispatch = {
      approvalId: t.approval.id,
      tenantId: t.tenantId,
      dispatchAttemptId: t.dispatchAttemptId,
    };
    const newerAttemptId = randomUUID();
    const payload = {
      actionType: 'CREATE_STAFF_TASK',
      task: { title: 'Recover queued action', priority: 'HIGH' },
      dispatch: { state: dispatchState, attemptId: newerAttemptId, recordedAt: new Date().toISOString() },
      ...(status === 'EXECUTED' ? { execution: { state: 'executed', resource: 'staffTask', resourceId: randomUUID() } } : {}),
      ...(status === 'FAILED' ? { execution: { state: 'failed', code: 'authorization_changed' } } : {}),
    } as Prisma.InputJsonValue;
    await db.autopilotApproval.update({
      where: { id: t.approval.id },
      data: { status, payload },
    });

    const result = await reconcileQueuedAutopilotDispatch(stale);
    expect(['stale', 'already_reconciled', 'noop']).toContain(result.outcome);
    const preserved = await db.autopilotApproval.findUniqueOrThrow({ where: { id: t.approval.id } });
    expect(preserved).toMatchObject({
      status,
      payload: {
        dispatch: {
          state: dispatchState,
          attemptId: newerAttemptId,
        },
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
