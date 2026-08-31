import { Worker } from 'bullmq';
import { env } from '../config/env';
import { assertSchedulerTick, validateTenantJobEnvelope } from '../lib/jobEnvelope';
import { resolveActiveJobTenantIds } from '../lib/jobTenantResolver';
import { CALL_RECONCILIATION_ACTOR, reconcileStrandedCalls } from '../lib/receptionist/callReconciler';
import { runInTenantContext } from '../lib/tenantContext';
import { captureException } from '../lib/observability';
import { observed } from './observedJob';
import {
  bullMqPrefix,
  enqueueReceptionistCallReconciliationTenantJob,
  redisConnection,
  type ScheduledQueueData,
} from './queues';

// Consumer for the receptionist-call-reconciliation queue. A signed tick fans
// out one signed per-tenant job; each pass closes the non-terminal call rows
// that are past their deadline. See lib/receptionist/callReconciler.ts for why
// this has to poll rather than wait for a webhook.
export function createReceptionistCallReconciliationWorker(): Worker<ScheduledQueueData, void, string> {
  const worker = new Worker<ScheduledQueueData, void, string>(
    'receptionist-call-reconciliation',
    observed('receptionist-call-reconciliation', async job => {
      if (job.name === 'scan') {
        assertSchedulerTick(job, { name: 'scan', schedulerId: 'receptionist-call-reconciliation-scan' });
        for (const tenantId of await resolveActiveJobTenantIds()) {
          try {
            await enqueueReceptionistCallReconciliationTenantJob(tenantId);
          } catch (error) {
            captureException(error instanceof Error ? error : new Error(String(error)), { route: 'worker:receptionist-call-reconciliation-enqueue', tenantId });
          }
        }
        return;
      }
      if (job.name !== 'scan-tenant' || !job.id) throw new Error(`Unknown receptionist call reconciliation job: ${job.name}`);
      const envelope = validateTenantJobEnvelope(job.data, { queue: 'receptionist-call-reconciliation', operation: 'scan', jobId: job.id });
      // Deliberately `runInTenantContext`, NOT `runWithJobTenantContext` — the
      // same reason `receptionist-agent-reverify` gives in compliance.worker.ts.
      // The latter wraps the whole job in ONE Prisma interactive transaction,
      // and this pass makes an HTTPS round trip to the provider per stranded
      // row, up to the batch size. Prisma's default interactive transaction
      // timeout is 5000 ms, so that shape aborts with P2028 and retries into
      // the same wall — a reconciler that never reconciles.
      //
      // The tenant fence is unchanged: AsyncLocalStorage carries the context,
      // and `db` opens a short transaction per operation with the RLS GUCs
      // applied (see lib/db.ts). `reconcileStrandedCalls` additionally asserts
      // the active context matches the tenant it was asked to reconcile.
      await runInTenantContext(
        { tenantId: envelope.tenantId, actorId: CALL_RECONCILIATION_ACTOR, actorRole: 'WORKER', source: 'worker' },
        async () => {
          const summary = await reconcileStrandedCalls(envelope.tenantId);
          if (summary.scanned > 0) {
            console.info({ tenantId: envelope.tenantId, ...summary }, 'receptionist call reconciliation pass completed');
          }
        },
      );
    }),
    { connection: redisConnection, prefix: bullMqPrefix, concurrency: env.RECEPTIONIST_CALL_RECONCILIATION_MAX_CONCURRENCY },
  );
  worker.on('failed', (job, error) => captureException(error, { route: 'worker:receptionist-call-reconciliation', requestId: job?.id }));
  return worker;
}
