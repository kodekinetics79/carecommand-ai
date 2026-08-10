import type { Prisma } from '../generated/prisma/client';
import { captureException } from '../lib/observability';
import { resolveActiveJobTenantIds } from '../lib/jobTenantResolver';
import { runWithJobTenantContext } from '../lib/tenantContext';
import { reconcileAutopilotDispatchFailure } from '../modules/autopilot/dispatch';
import { autopilotQueue } from './queues';

const RECOVERY_PAGE_SIZE = 100;

export type QueuedAutopilotDispatch = {
  approvalId: string;
  tenantId: string;
  dispatchAttemptId?: string;
};

export type AutopilotRecoverySummary = {
  scanned: number;
  reconciled: number;
  healthy: number;
  stale: number;
  errors: number;
};

function payloadRecord(payload: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, Prisma.JsonValue>
    : {};
}

function queuedDispatch(payload: Prisma.JsonValue): { attemptId?: string } | null {
  const dispatch = payloadRecord(payload).dispatch;
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) return null;
  const record = dispatch as Record<string, Prisma.JsonValue>;
  if (record.state !== 'queued') return null;
  return { attemptId: typeof record.attemptId === 'string' ? record.attemptId : undefined };
}

async function readQueuedPage(tenantId: string, afterId?: string): Promise<{
  rows: QueuedAutopilotDispatch[];
  lastId?: string;
  sourceCount: number;
}> {
  return runWithJobTenantContext(tenantId, async tx => {
    const approvals = await tx.autopilotApproval.findMany({
      where: {
        tenantId,
        status: 'APPROVED',
        payload: { path: ['dispatch', 'state'], equals: 'queued' },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: RECOVERY_PAGE_SIZE,
      select: { id: true, payload: true },
    });
    return {
      rows: approvals.flatMap(approval => {
        const dispatch = queuedDispatch(approval.payload);
        return dispatch ? [{
          approvalId: approval.id,
          tenantId,
          dispatchAttemptId: dispatch.attemptId,
        }] : [];
      }),
      lastId: approvals.at(-1)?.id,
      // Pagination follows source row count, not parsed queue candidates.
      sourceCount: approvals.length,
    };
  }, 'worker:autopilot-dispatch-recovery-scan');
}

/**
 * Reconcile one persisted queued snapshot against its deterministic BullMQ job.
 * The database transition remains attempt-fenced, so a snapshot that races a
 * newer dispatch generation, execution, or domain rejection becomes a no-op.
 */
export async function reconcileQueuedAutopilotDispatch(candidate: QueuedAutopilotDispatch) {
  const expectedJobId = `autopilot-approval-${candidate.approvalId}`;
  const job = await autopilotQueue.getJob(expectedJobId);
  if (!job) {
    return reconcileAutopilotDispatchFailure({
      approvalId: candidate.approvalId,
      tenantId: candidate.tenantId,
      code: 'queue_job_missing',
      jobId: expectedJobId,
      dispatchAttemptId: candidate.dispatchAttemptId,
    });
  }

  const state = await job.getState();
  const jobAttemptId = typeof job.data?.dispatchAttemptId === 'string'
    ? job.data.dispatchAttemptId
    : undefined;

  if (jobAttemptId !== candidate.dispatchAttemptId) {
    return reconcileAutopilotDispatchFailure({
      approvalId: candidate.approvalId,
      tenantId: candidate.tenantId,
      code: 'queue_job_missing',
      jobId: expectedJobId,
      dispatchAttemptId: candidate.dispatchAttemptId,
    });
  }

  if (state === 'failed') {
    return reconcileAutopilotDispatchFailure({
      approvalId: candidate.approvalId,
      tenantId: candidate.tenantId,
      code: 'worker_terminal_failure',
      jobId: expectedJobId,
      dispatchAttemptId: candidate.dispatchAttemptId,
      attempts: job.attemptsMade,
    });
  }
  if (state === 'completed') {
    return reconcileAutopilotDispatchFailure({
      approvalId: candidate.approvalId,
      tenantId: candidate.tenantId,
      code: 'worker_completed_without_execution',
      jobId: expectedJobId,
      dispatchAttemptId: candidate.dispatchAttemptId,
      attempts: job.attemptsMade,
    });
  }
  if (state === 'unknown') {
    return reconcileAutopilotDispatchFailure({
      approvalId: candidate.approvalId,
      tenantId: candidate.tenantId,
      code: 'queue_job_missing',
      jobId: expectedJobId,
      dispatchAttemptId: candidate.dispatchAttemptId,
    });
  }
  return { outcome: 'healthy' as const, state };
}

/**
 * Startup/periodic repair pass. Redis terminal state is not the authority for
 * execution, but it is sufficient evidence that an APPROVED+queued row needs a
 * retry-required transition. Each transition and its mandatory audit receipt
 * commit atomically in reconcileAutopilotDispatchFailure().
 */
export async function reconcileStrandedAutopilotDispatches(options?: {
  tenantIds?: string[];
}): Promise<AutopilotRecoverySummary> {
  const summary: AutopilotRecoverySummary = {
    scanned: 0,
    reconciled: 0,
    healthy: 0,
    stale: 0,
    errors: 0,
  };
  const tenantIds = options?.tenantIds ?? await resolveActiveJobTenantIds();

  for (const tenantId of tenantIds) {
    let afterId: string | undefined;
    for (;;) {
      const page = await readQueuedPage(tenantId, afterId);
      for (const candidate of page.rows) {
        summary.scanned += 1;
        try {
          const result = await reconcileQueuedAutopilotDispatch(candidate);
          if (result.outcome === 'reconciled' || result.outcome === 'already_reconciled') summary.reconciled += 1;
          else if (result.outcome === 'healthy') summary.healthy += 1;
          else summary.stale += 1;
        } catch (error) {
          summary.errors += 1;
          captureException(error instanceof Error ? error : new Error(String(error)), {
            route: 'worker:autopilot-dispatch-recovery-scan',
            requestId: `autopilot-approval-${candidate.approvalId}`,
            tenantId,
          });
        }
      }
      if (!page.lastId || page.sourceCount < RECOVERY_PAGE_SIZE) break;
      afterId = page.lastId;
    }
  }
  return summary;
}
