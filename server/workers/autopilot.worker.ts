import { UnrecoverableError, Worker } from 'bullmq';
import { z } from 'zod';
import { env } from '../config/env';
import { captureException } from '../lib/observability';
import type { Prisma } from '../generated/prisma/client';
import { runWithJobTenantContext } from '../lib/tenantContext';
import { reconcileAutopilotDispatchFailure } from '../modules/autopilot/dispatch';
import { observed } from './observedJob';
import { bullMqPrefix, redisConnection, type AutopilotExecutionJob } from './queues';

function payloadRecord(payload: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, Prisma.JsonValue>
    : {};
}

const createStaffTaskPayload = z.object({
  actionType: z.literal('CREATE_STAFF_TASK'),
  task: z.object({
    title: z.string().trim().min(2).max(240),
    priority: z.enum(['HIGH', 'NORMAL', 'LOW']),
  }).strict(),
  dispatch: z.object({
    state: z.literal('queued'),
    attemptId: z.string().uuid(),
    jobId: z.string().min(1).max(180),
    recordedAt: z.string().datetime(),
  }).strict(),
}).strict();

const taskPriority = {
  HIGH: 'high',
  NORMAL: 'medium',
  LOW: 'low',
} as const;

export type AutopilotExecutionOutcome =
  | { outcome: 'executed'; resource: 'staffTask'; resourceId: string }
  | { outcome: 'already_executed'; resource: string | null; resourceId: string | null }
  | { outcome: 'stale' };

export function isFinalAutopilotAttempt(attemptsMade: number, configuredAttempts: number | undefined): boolean {
  return attemptsMade + 1 >= Math.max(1, Math.trunc(configuredAttempts ?? 1));
}

let executionTestHook: ((attemptsMade: number) => Promise<void>) | undefined;
export function setAutopilotExecutionTestHook(hook?: (attemptsMade: number) => Promise<void>) {
  if (env.NODE_ENV !== 'test') throw new Error('autopilot execution test hook is test-only');
  executionTestHook = hook;
}

/**
 * Executes the currently supported autopilot action behind an exact persisted
 * dispatch-attempt fence. The domain side effect, durable receipt, approval
 * transition, and audit event commit in one PostgreSQL transaction.
 */
export async function executeAutopilotApprovedAction(input: {
  approvalId: string;
  tenantId: string;
  dispatchAttemptId: string;
  jobId: string | undefined;
  attemptsMade?: number;
}): Promise<AutopilotExecutionOutcome> {
  return runWithJobTenantContext(input.tenantId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'autopilot:' + input.approvalId}, 0))`;
    const approval = await tx.autopilotApproval.findFirst({
      where: { id: input.approvalId, tenantId: input.tenantId },
      select: { id: true, tenantId: true, reviewedById: true, status: true, payload: true },
    });
    if (!approval) return { outcome: 'stale' as const };

    const storedPayload = payloadRecord(approval.payload);
    const storedExecution = payloadRecord(storedPayload.execution);
    if (approval.status === 'EXECUTED' && storedExecution.attemptId === input.dispatchAttemptId) {
      return {
        outcome: 'already_executed' as const,
        resource: typeof storedExecution.resource === 'string' ? storedExecution.resource : null,
        resourceId: typeof storedExecution.resourceId === 'string' ? storedExecution.resourceId : null,
      };
    }
    if (approval.status !== 'APPROVED') return { outcome: 'stale' as const };

    const parsed = createStaffTaskPayload.safeParse(approval.payload);
    if (!parsed.success) throw new UnrecoverableError(`unsupported_autopilot_payload:${z.prettifyError(parsed.error)}`);
    if (parsed.data.dispatch.attemptId !== input.dispatchAttemptId) return { outcome: 'stale' as const };

    const task = await tx.staffTask.create({
      data: {
        tenantId: approval.tenantId,
        title: parsed.data.task.title,
        priority: taskPriority[parsed.data.task.priority],
        metadata: {
          source: 'autopilot',
          approvalId: approval.id,
          dispatchAttemptId: input.dispatchAttemptId,
        },
      },
      select: { id: true },
    });
    const attempts = Math.max(0, Math.min(100, Math.trunc(input.attemptsMade ?? 0)));
    const completedAt = new Date().toISOString();
    const updated = await tx.autopilotApproval.updateMany({
      where: { id: approval.id, tenantId: approval.tenantId, status: 'APPROVED' },
      data: {
        status: 'EXECUTED',
        payload: {
          ...storedPayload,
          dispatch: {
            ...parsed.data.dispatch,
            state: 'dispatch_completed',
            attempts,
            completedAt,
          },
          execution: {
            state: 'executed',
            actionType: parsed.data.actionType,
            attemptId: input.dispatchAttemptId,
            resource: 'staffTask',
            resourceId: task.id,
            executedAt: completedAt,
          },
        } as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) throw new Error('autopilot_execution_claim_lost');
    await tx.auditEvent.create({
      data: {
        tenantId: approval.tenantId,
        actorUserId: approval.reviewedById,
        action: 'autopilot.approval.executed',
        resource: 'autopilotApproval',
        resourceId: approval.id,
        metadata: {
          jobId: input.jobId ?? null,
          dispatchAttemptId: input.dispatchAttemptId,
          actionType: parsed.data.actionType,
          resultResource: 'staffTask',
          resultResourceId: task.id,
        },
      },
    });
    return { outcome: 'executed' as const, resource: 'staffTask' as const, resourceId: task.id };
  }, 'worker:autopilot-execution');
}

// Consumer for the autopilot-execution queue: executes an APPROVED action and
// writes the audit trail. Exported as a factory so the unified worker runtime
// (server/workers/index.ts) can compose it with the other consumers; lifecycle
// (schedules, shutdown) is owned by that runtime, not this module.
export function createAutopilotWorker(): Worker<AutopilotExecutionJob> {
  const worker = new Worker<AutopilotExecutionJob>(
    'autopilot-execution',
    observed('autopilot-execution', async job => {
      try {
        await executionTestHook?.(job.attemptsMade);
        await executeAutopilotApprovedAction({
          approvalId: job.data.approvalId,
          tenantId: job.data.tenantId,
          dispatchAttemptId: job.data.dispatchAttemptId,
          jobId: job.id,
          attemptsMade: job.attemptsMade,
        });
      } catch (error) {
        if (error instanceof UnrecoverableError || isFinalAutopilotAttempt(job.attemptsMade, job.opts.attempts)) {
          await reconcileAutopilotDispatchFailure({
            approvalId: job.data.approvalId,
            tenantId: job.data.tenantId,
            code: 'worker_terminal_failure',
            jobId: job.id,
            dispatchAttemptId: job.data.dispatchAttemptId,
            attempts: job.attemptsMade + 1,
          });
        }
        throw error;
      }
    }),
    { connection: redisConnection, prefix: bullMqPrefix, concurrency: 5 },
  );

  worker.on('completed', job => console.info({ jobId: job.id }, 'autopilot job completed'));
  worker.on('failed', (job, error) => {
    if (!job) return;
    captureException(error, { route: 'worker:autopilot-execution', requestId: job.id });
  });

  return worker;
}
