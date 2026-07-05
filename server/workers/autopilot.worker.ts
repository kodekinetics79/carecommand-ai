import { Worker } from 'bullmq';
import { db } from '../lib/db';
import { captureException } from '../lib/observability';
import { observed } from './observedJob';
import { redisConnection, type AutopilotExecutionJob } from './queues';

// Consumer for the autopilot-execution queue: executes an APPROVED action and
// writes the audit trail. Exported as a factory so the unified worker runtime
// (server/workers/index.ts) can compose it with the other consumers; lifecycle
// (schedules, shutdown) is owned by that runtime, not this module.
export function createAutopilotWorker(): Worker<AutopilotExecutionJob> {
  const worker = new Worker<AutopilotExecutionJob>(
    'autopilot-execution',
    observed('autopilot-execution', async job => {
      const approval = await db.autopilotApproval.findFirst({
        where: { id: job.data.approvalId, tenantId: job.data.tenantId, status: 'APPROVED' },
      });
      if (!approval) return;

      await db.$transaction([
        db.autopilotApproval.update({
          where: { id: approval.id },
          data: { status: 'EXECUTED' },
        }),
        db.auditEvent.create({
          data: {
            tenantId: approval.tenantId,
            action: 'autopilot.approval.executed',
            resource: 'autopilotApproval',
            resourceId: approval.id,
            metadata: { jobId: job.id },
          },
        }),
      ]);
    }),
    { connection: redisConnection, concurrency: 5 },
  );

  worker.on('completed', job => console.info({ jobId: job.id }, 'autopilot job completed'));
  worker.on('failed', (job, error) => {
    captureException(error, { route: 'worker:autopilot-execution', requestId: job?.id });
  });

  return worker;
}
