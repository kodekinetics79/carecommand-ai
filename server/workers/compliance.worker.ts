import { Worker } from 'bullmq';
import { redisConnection, registerComplianceSchedules } from './queues';
import {
  runReadinessRecalc,
  runEvidenceExpiry,
  runBackupPlaceholder,
  runAccessReviewReminder,
  runVendorReviewReminder,
} from '../modules/compliance/jobs';

// Processes the compliance-maintenance queue. Each repeatable job runs across
// all tenants (the job functions iterate tenants and scope every write by
// tenantId). Retries/backoff come from the queue's defaultJobOptions.
const worker = new Worker<Record<string, never>, void, string>(
  'compliance-maintenance',
  async job => {
    switch (job.name) {
      case 'readiness-recalc': await runReadinessRecalc(); break;
      case 'evidence-expiry': await runEvidenceExpiry(); break;
      case 'backup-placeholder': await runBackupPlaceholder(); break;
      case 'access-review-reminder': await runAccessReviewReminder(); break;
      case 'vendor-review-reminder': await runVendorReviewReminder(); break;
      // No-op until a real scanner is integrated — never fabricates results.
      case 'security-scan-placeholder':
        console.info('[compliance-job] security scanner not integrated; awaiting supplied scan data');
        break;
    }
  },
  { connection: redisConnection, concurrency: 3 },
);

worker.on('completed', job => console.info({ jobId: job.id, name: job.name }, 'compliance job completed'));
worker.on('failed', (job, error) => console.error({ jobId: job?.id, name: job?.name, error }, 'compliance job failed'));

// Idempotent on every boot — upsertJobScheduler dedupes by scheduler id.
void registerComplianceSchedules().catch(err => console.error({ err }, 'failed to register compliance schedules'));

async function shutdown() {
  await worker.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
