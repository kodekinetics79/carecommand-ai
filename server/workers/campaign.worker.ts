import { Worker } from 'bullmq';
import { redisConnection, registerCampaignSchedules } from './queues';
import { runScheduledCampaigns } from '../modules/campaigns/jobs';

// Processes the campaign-scheduler queue. The repeatable job dispatches approved
// SCHEDULED campaigns that are due, across all tenants (the job scopes every
// write by tenantId). Idempotent — see runScheduledCampaigns.
const worker = new Worker<Record<string, never>, void, string>(
  'campaign-scheduler',
  async () => { await runScheduledCampaigns(); },
  { connection: redisConnection, concurrency: 1 },
);

worker.on('completed', job => console.info({ jobId: job.id, name: job.name }, 'campaign scheduler run completed'));
worker.on('failed', (job, error) => console.error({ jobId: job?.id, name: job?.name, error }, 'campaign scheduler run failed'));

void registerCampaignSchedules().catch(err => console.error({ err }, 'failed to register campaign schedules'));

async function shutdown() {
  await worker.close();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
