import { Worker } from 'bullmq';
import { env } from '../config/env';
import { assertSchedulerTick, validateTenantJobEnvelope } from '../lib/jobEnvelope';
import { resolveActiveJobTenantIds } from '../lib/jobTenantResolver';
import { OUTBOUND_DIAL_ACTOR, runOutboundDialPass } from '../lib/receptionist/outboundDialer';
import { runInTenantContext } from '../lib/tenantContext';
import { captureException } from '../lib/observability';
import { observed } from './observedJob';
import {
  bullMqPrefix,
  enqueueReceptionistOutboundDialTenantJob,
  redisConnection,
  type ScheduledQueueData,
} from './queues';

// Consumer for the receptionist-outbound-dial queue. A signed tick fans out one
// signed per-tenant job; each pass walks that tenant's RUNNING, dialler-enabled
// campaigns and dials their PENDING targets through `launchOutboundCall` — the
// same function the HTTP route calls, so an automated dial passes through every
// fence a manual one does. See lib/receptionist/outboundDialer.ts for why the
// pass asks about quiet hours and the kill switch itself: pacing, not policy.
export function createReceptionistOutboundDialWorker(): Worker<ScheduledQueueData, void, string> {
  const worker = new Worker<ScheduledQueueData, void, string>(
    'receptionist-outbound-dial',
    observed('receptionist-outbound-dial', async job => {
      if (job.name === 'scan') {
        assertSchedulerTick(job, { name: 'scan', schedulerId: 'receptionist-outbound-dial-scan' });
        for (const tenantId of await resolveActiveJobTenantIds()) {
          try {
            await enqueueReceptionistOutboundDialTenantJob(tenantId);
          } catch (error) {
            captureException(error instanceof Error ? error : new Error(String(error)), { route: 'worker:receptionist-outbound-dial-enqueue', tenantId });
          }
        }
        return;
      }
      if (job.name !== 'dial-tenant' || !job.id) throw new Error(`Unknown receptionist outbound dial job: ${job.name}`);
      const envelope = validateTenantJobEnvelope(job.data, { queue: 'receptionist-outbound-dial', operation: 'dial', jobId: job.id });
      // Deliberately `runInTenantContext`, NOT `runWithJobTenantContext`, for
      // the same reason the call reconciler gives: the latter wraps the whole
      // job in ONE Prisma interactive transaction, and this pass makes an
      // HTTPS round trip to the provider per dial. Prisma's default interactive
      // transaction timeout is 5000 ms, so that shape aborts with P2028 and
      // BullMQ retries into the same wall — a dialler that never dials, and
      // worse, one that might have already submitted a call before the abort.
      //
      // The tenant fence is unchanged: AsyncLocalStorage carries the context,
      // `db` opens a short transaction per operation with the RLS GUCs applied,
      // and both `runOutboundDialPass` and `launchOutboundCall` assert that the
      // active context matches the tenant they were asked to dial for.
      await runInTenantContext(
        { tenantId: envelope.tenantId, actorId: OUTBOUND_DIAL_ACTOR, actorRole: 'WORKER', source: 'worker' },
        async () => {
          const summary = await runOutboundDialPass(envelope.tenantId, {
            // The BullMQ job id is the correlation written to
            // `AuditEvent.requestId`; the envelope nonce is the run, so every
            // audit row from one pass shares a `dialer.runId`.
            jobId: job.id!,
            runId: envelope.nonce,
          });
          if (summary.launched > 0 || summary.blocked > 0 || summary.stoppedByKillSwitch) {
            console.info({ tenantId: envelope.tenantId, ...summary }, 'receptionist outbound dial pass completed');
          }
        },
      );
    }),
    { connection: redisConnection, prefix: bullMqPrefix, concurrency: env.RECEPTIONIST_OUTBOUND_DIAL_MAX_CONCURRENCY },
  );
  worker.on('failed', (job, error) => captureException(error, { route: 'worker:receptionist-outbound-dial', requestId: job?.id }));
  return worker;
}
