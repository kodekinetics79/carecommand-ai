import { Worker } from 'bullmq';
import { captureException } from '../lib/observability';
import { redisConnection } from './queues';
import { runScheduledCampaigns } from '../modules/campaigns/jobs';

// Consumer for the campaign-scheduler queue. The repeatable job dispatches
// approved SCHEDULED campaigns that are due, across all tenants (each write is
// scoped by tenantId). Idempotent — see runScheduledCampaigns. Exported as a
// factory; schedule registration + shutdown are owned by the worker runtime.
export function createCampaignWorker(): Worker<Record<string, never>, void, string> {
  const worker = new Worker<Record<string, never>, void, string>(
    'campaign-scheduler',
    async () => { await runScheduledCampaigns(); },
    { connection: redisConnection, concurrency: 1 },
  );

  worker.on('completed', job => console.info({ jobId: job.id, name: job.name }, 'campaign scheduler run completed'));
  worker.on('failed', (job, error) => {
    captureException(error, { route: 'worker:campaign-scheduler', requestId: job?.id });
  });

  return worker;
}
