import { Worker } from 'bullmq';
import { captureException } from '../lib/observability';
import { observed } from './observedJob';
import { redisConnection } from './queues';
import {
  runReadinessRecalc,
  runEvidenceExpiry,
  runBackupPlaceholder,
  runAccessReviewReminder,
  runVendorReviewReminder,
} from '../modules/compliance/jobs';

// Consumer for the compliance-maintenance queue. Each repeatable job runs across
// all tenants (the job functions iterate tenants and scope every write by
// tenantId). Retries/backoff come from the queue's defaultJobOptions. Exported as
// a factory; schedule registration + shutdown are owned by the worker runtime.
export function createComplianceWorker(): Worker<Record<string, never>, void, string> {
  const worker = new Worker<Record<string, never>, void, string>(
    'compliance-maintenance',
    observed('compliance-maintenance', async job => {
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
    }),
    { connection: redisConnection, concurrency: 3 },
  );

  worker.on('completed', job => console.info({ jobId: job.id, name: job.name }, 'compliance job completed'));
  worker.on('failed', (job, error) => {
    captureException(error, { route: `worker:compliance:${job?.name ?? 'unknown'}`, requestId: job?.id });
  });

  return worker;
}
