import { env } from '../../config/env';
import type { Prisma } from '../../generated/prisma/client';
import { runWithJobTenantContext } from '../../lib/tenantContext';

export type AutopilotDispatchCapability = {
  available: boolean;
  mode: 'background_queue' | 'manual_retry_required';
  reason: string | null;
};

export function getAutopilotDispatchCapability(): AutopilotDispatchCapability {
  return env.QUEUES_ENABLED
    ? { available: true, mode: 'background_queue', reason: null }
    : {
        available: false,
        mode: 'manual_retry_required',
        reason: 'Background execution is disabled. The approved action is retained for later dispatch.',
      };
}

function payloadRecord(payload: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, Prisma.JsonValue>
    : {};
}

function dispatchRecord(payload: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  const dispatch = payloadRecord(payload).dispatch;
  return dispatch && typeof dispatch === 'object' && !Array.isArray(dispatch)
    ? dispatch as Record<string, Prisma.JsonValue>
    : {};
}

function matchesAttempt(payload: Prisma.JsonValue, attemptId: string | undefined) {
  const current = dispatchRecord(payload).attemptId;
  return attemptId ? current === attemptId : typeof current !== 'string';
}

export async function recordAutopilotDispatchQueued(input: {
  approvalId: string;
  tenantId: string;
  jobId: string;
  dispatchAttemptId?: string;
}) {
  return runWithJobTenantContext(input.tenantId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'autopilot:' + input.approvalId}, 0))`;
    const approval = await tx.autopilotApproval.findFirst({
      where: { id: input.approvalId, tenantId: input.tenantId, status: 'APPROVED' },
      select: { id: true, payload: true },
    });
    if (!approval || !matchesAttempt(approval.payload, input.dispatchAttemptId)) return { outcome: 'stale' as const };
    const currentState = dispatchRecord(approval.payload).state;
    if (currentState === 'dispatch_failed') return { outcome: 'stale' as const };
    if (currentState === 'queued') return { outcome: 'already_recorded' as const };
    await tx.autopilotApproval.update({
      where: { id: approval.id },
      data: {
        payload: {
          ...payloadRecord(approval.payload),
          dispatch: {
            state: 'queued',
            attemptId: input.dispatchAttemptId ?? null,
            jobId: input.jobId.slice(0, 180),
            recordedAt: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
    });
    return { outcome: 'recorded' as const };
  }, 'worker:autopilot-dispatch-queued');
}

export async function reconcileAutopilotDispatchFailure(input: {
  approvalId: string;
  tenantId: string;
  code:
    | 'enqueue_failed'
    | 'worker_terminal_failure'
    | 'queue_job_missing'
    | 'worker_completed_without_execution';
  jobId?: string;
  dispatchAttemptId?: string;
  attempts?: number;
}) {
  return runWithJobTenantContext(input.tenantId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'autopilot:' + input.approvalId}, 0))`;
    const approval = await tx.autopilotApproval.findFirst({
      where: { id: input.approvalId, tenantId: input.tenantId, status: 'APPROVED' },
      select: { id: true, tenantId: true, reviewedById: true, payload: true },
    });
    if (!approval) return { outcome: 'noop' as const };

    if (!matchesAttempt(approval.payload, input.dispatchAttemptId)) return { outcome: 'stale' as const };
    const existingDispatch = dispatchRecord(approval.payload);
    if (
      existingDispatch.state === 'dispatch_failed'
      && existingDispatch.failureCode === input.code
      && existingDispatch.jobId === (input.jobId?.slice(0, 180) ?? null)
    ) return { outcome: 'already_reconciled' as const };

    const recordedAt = new Date().toISOString();
    const attempts = Math.max(0, Math.min(100, Math.trunc(input.attempts ?? 0)));
    const jobId = input.jobId?.slice(0, 180) ?? null;
    const updated = await tx.autopilotApproval.updateMany({
      where: { id: approval.id, tenantId: approval.tenantId, status: 'APPROVED' },
      data: {
        payload: {
          ...payloadRecord(approval.payload),
          dispatch: {
            state: 'dispatch_failed',
            attemptId: input.dispatchAttemptId ?? null,
            failureCode: input.code,
            recordedAt,
            jobId,
            attempts,
          },
        } as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 0) return { outcome: 'noop' as const };
    await tx.auditEvent.create({ data: {
      tenantId: approval.tenantId,
      actorUserId: approval.reviewedById,
      action: 'autopilot.approval.dispatchFailed',
      resource: 'autopilotApproval',
      resourceId: approval.id,
      metadata: { failureCode: input.code, jobId, dispatchAttemptId: input.dispatchAttemptId ?? null, attempts },
    } });
    return { outcome: 'reconciled' as const };
  }, 'worker:autopilot-dispatch-reconciliation');
}
