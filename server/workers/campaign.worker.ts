import { Worker } from 'bullmq';
import { captureException } from '../lib/observability';
import { observed } from './observedJob';
import { bullMqPrefix, enqueueCampaignTenantJob, redisConnection, type ScheduledQueueData } from './queues';
import { runScheduledCampaigns } from '../modules/campaigns/jobs';
import { assertSchedulerTick, validateTenantJobEnvelope } from '../lib/jobEnvelope';
import { resolveActiveJobTenantIds } from '../lib/jobTenantResolver';

// Consumer for the campaign-scheduler queue. The repeatable job dispatches
// approved SCHEDULED campaigns that are due, across all tenants (each write is
// scoped by tenantId). Idempotent — see runScheduledCampaigns. Exported as a
// factory; schedule registration + shutdown are owned by the worker runtime.
export function createCampaignWorker(): Worker<ScheduledQueueData, void, string> {
  const worker = new Worker<ScheduledQueueData, void, string>(
    'campaign-scheduler',
    observed('campaign-scheduler', async job => {
      if (job.name === 'dispatch-scheduled') {
        assertSchedulerTick(job, { name: 'dispatch-scheduled', schedulerId: 'campaign-dispatch' });
        for (const tenantId of await resolveActiveJobTenantIds()) await enqueueCampaignTenantJob(tenantId);
        return;
      }
      if (job.name === 'dispatch-scheduled-tenant') {
        if (!job.id) throw new Error('Signed tenant job is missing its BullMQ job ID');
        const envelope = validateTenantJobEnvelope(job.data, {
          queue: 'campaign-scheduler', operation: 'dispatch-scheduled', jobId: job.id,
        });
        await runScheduledCampaigns(new Date(), envelope.tenantId);
        return;
      }
      throw new Error(`Unknown campaign scheduler job: ${job.name}`);
    }),
    { connection: redisConnection, prefix: bullMqPrefix, concurrency: 1 },
  );

  worker.on('completed', job => console.info({ jobId: job.id, name: job.name }, 'campaign scheduler run completed'));
  worker.on('failed', (job, error) => {
    captureException(error, { route: 'worker:campaign-scheduler', requestId: job?.id });
  });

  return worker;
}
