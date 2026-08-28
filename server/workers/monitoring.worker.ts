import { Worker } from 'bullmq';
import { captureException } from '../lib/observability';
import { observed } from './observedJob';
import { bullMqPrefix, enqueueMonitoringTenantJob, redisConnection, type MonitoringJobName, type ScheduledQueueData } from './queues';
import { detectMissedReadings, detectOfflineDevices } from '../lib/connectedCare/safetyDetection';
import { assertSchedulerTick, validateTenantJobEnvelope } from '../lib/jobEnvelope';
import { resolveActiveJobTenantIds } from '../lib/jobTenantResolver';

// Consumer for the monitoring-safety queue — the proactive RPM safety net. Each
// repeatable job runs across all tenants (the detectors iterate tenants and scope
// every write by tenantId) and is idempotent, so retries/re-runs never duplicate
// an open alert. Exported as a factory; schedule registration + shutdown are
// owned by the worker runtime.
const MONITORING_SCHEDULERS: Record<MonitoringJobName, string> = {
  'missed-reading-scan': 'monitoring-missed-reading',
  'device-offline-scan': 'monitoring-device-offline',
};

function isMonitoringJobName(name: string): name is MonitoringJobName {
  return Object.hasOwn(MONITORING_SCHEDULERS, name);
}

export function createMonitoringWorker(): Worker<ScheduledQueueData, void, string> {
  const worker = new Worker<ScheduledQueueData, void, string>(
    'monitoring-safety',
    observed('monitoring-safety', async job => {
      if (isMonitoringJobName(job.name)) {
        assertSchedulerTick(job, { name: job.name, schedulerId: MONITORING_SCHEDULERS[job.name] });
        for (const tenantId of await resolveActiveJobTenantIds()) await enqueueMonitoringTenantJob(job.name, tenantId);
        return;
      }
      const suffix = '-tenant';
      const operation = job.name.endsWith(suffix) ? job.name.slice(0, -suffix.length) : '';
      if (!isMonitoringJobName(operation)) throw new Error(`Unknown monitoring job: ${job.name}`);
      if (!job.id) throw new Error('Signed tenant job is missing its BullMQ job ID');
      const envelope = validateTenantJobEnvelope(job.data, {
        queue: 'monitoring-safety', operation, jobId: job.id,
      });
      if (operation === 'missed-reading-scan') {
        const r = await detectMissedReadings(envelope.tenantId);
        console.info({ checked: r.checked, created: r.created }, 'missed-reading scan complete');
      } else {
        const r = await detectOfflineDevices(envelope.tenantId);
        console.info({ checked: r.checked, flipped: r.flipped, created: r.created }, 'device-offline scan complete');
      }
    }),
    { connection: redisConnection, prefix: bullMqPrefix, concurrency: 2 },
  );

  worker.on('completed', job => console.info({ jobId: job.id, name: job.name }, 'monitoring safety job completed'));
  worker.on('failed', (job, error) => {
    captureException(error, { route: `worker:monitoring:${job?.name ?? 'unknown'}`, requestId: job?.id });
  });

  return worker;
}
