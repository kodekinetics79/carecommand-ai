import { Worker } from 'bullmq';
import { db } from '../lib/db';
import { redisConnection, type AutopilotExecutionJob } from './queues';

const worker = new Worker<AutopilotExecutionJob>(
  'autopilot-execution',
  async job => {
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
  },
  { connection: redisConnection, concurrency: 5 },
);

worker.on('completed', job => {
  console.info({ jobId: job.id }, 'autopilot job completed');
});

worker.on('failed', (job, error) => {
  console.error({ jobId: job?.id, error }, 'autopilot job failed');
});

async function shutdown() {
  await worker.close();
  await db.$disconnect();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
