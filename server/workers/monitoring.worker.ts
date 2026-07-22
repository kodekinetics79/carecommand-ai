import { Worker } from 'bullmq';
import { captureException } from '../lib/observability';
import { observed } from './observedJob';
import { redisConnection } from './queues';
import { detectMissedReadings, detectOfflineDevices } from '../lib/connectedCare/safetyDetection';

// Consumer for the monitoring-safety queue — the proactive RPM safety net. Each
// repeatable job runs across all tenants (the detectors iterate tenants and scope
// every write by tenantId) and is idempotent, so retries/re-runs never duplicate
// an open alert. Exported as a factory; schedule registration + shutdown are
// owned by the worker runtime.
export function createMonitoringWorker(): Worker<Record<string, never>, void, string> {
  const worker = new Worker<Record<string, never>, void, string>(
    'monitoring-safety',
    observed('monitoring-safety', async job => {
      switch (job.name) {
        case 'missed-reading-scan': {
          const r = await detectMissedReadings();
          console.info({ checked: r.checked, created: r.created }, 'missed-reading scan complete');
          break;
        }
        case 'device-offline-scan': {
          const r = await detectOfflineDevices();
          console.info({ checked: r.checked, flipped: r.flipped, created: r.created }, 'device-offline scan complete');
          break;
        }
      }
    }),
    { connection: redisConnection, concurrency: 2 },
  );

  worker.on('completed', job => console.info({ jobId: job.id, name: job.name }, 'monitoring safety job completed'));
  worker.on('failed', (job, error) => {
    captureException(error, { route: `worker:monitoring:${job?.name ?? 'unknown'}`, requestId: job?.id });
  });

  return worker;
}
