import { Worker } from 'bullmq';
import { env } from '../config/env';
import { assertSchedulerTick, validateTenantJobEnvelope } from '../lib/jobEnvelope';
import { resolveActiveJobTenantIds } from '../lib/jobTenantResolver';
import { scanEligibilityReconciliationWork } from '../lib/eligibilityExecution';
import { runWithJobTenantContext } from '../lib/tenantContext';
import { captureException } from '../lib/observability';
import { observed } from './observedJob';
import {
  bullMqPrefix,
  enqueueEligibilityReconciliationTenantJob,
  redisConnection,
  type ScheduledQueueData,
} from './queues';

export function createEligibilityReconciliationWorker(): Worker<ScheduledQueueData, void, string> {
  const worker = new Worker<ScheduledQueueData, void, string>(
    'eligibility-reconciliation',
    observed('eligibility-reconciliation', async job => {
      if (job.name === 'scan') {
        assertSchedulerTick(job, { name: 'scan', schedulerId: 'eligibility-reconciliation-scan' });
        for (const tenantId of await resolveActiveJobTenantIds()) {
          try {
            await enqueueEligibilityReconciliationTenantJob(tenantId);
          } catch (error) {
            captureException(error instanceof Error ? error : new Error(String(error)), { route: 'worker:eligibility-reconciliation-enqueue', tenantId });
          }
        }
        return;
      }
      if (job.name !== 'scan-tenant' || !job.id) throw new Error(`Unknown eligibility reconciliation job: ${job.name}`);
      const envelope = validateTenantJobEnvelope(job.data, { queue: 'eligibility-reconciliation', operation: 'scan', jobId: job.id });
      await runWithJobTenantContext(envelope.tenantId, async () => {
        const summary = await scanEligibilityReconciliationWork(envelope.tenantId);
        console.info({ tenantId: envelope.tenantId, scanned: summary.scanned, escalated: summary.escalated, errors: summary.errors }, 'eligibility reconciliation scan completed');
      }, 'worker:eligibility-reconciliation');
    }),
    { connection: redisConnection, prefix: bullMqPrefix, concurrency: env.ELIGIBILITY_RECONCILIATION_MAX_CONCURRENCY },
  );
  worker.on('failed', (job, error) => captureException(error, { route: 'worker:eligibility-reconciliation', requestId: job?.id }));
  return worker;
}
