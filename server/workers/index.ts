// Service identity, then tracing — both before bullmq/ioredis/pg are imported —
// so worker spans carry service.name=carecommand-worker and link to the request
// that enqueued the job.
import './otelDefaults';
import { shutdownTracing } from '../lib/tracing';
import type { Worker } from 'bullmq';
import { env } from '../config/env';
import { db } from '../lib/db';
import { assertRlsRuntimeRole } from '../lib/rlsGuard';
import { registerSentry } from '../lib/observability';
import { sampleQueueDepths } from '../lib/metrics';
import { startWorkerMetricsServer } from './metricsServer';
import { captureException } from '../lib/observability';
import {
  autopilotQueue,
  campaignQueue,
  complianceQueue,
  monitoringQueue,
  registerCampaignSchedules,
  registerComplianceSchedules,
  registerMonitoringSchedules,
} from './queues';
import { createAutopilotWorker } from './autopilot.worker';
import { createCampaignWorker } from './campaign.worker';
import { createComplianceWorker } from './compliance.worker';
import { createMonitoringWorker } from './monitoring.worker';
import { reconcileStrandedAutopilotDispatches } from './autopilotRecovery';

// ===========================================================================
// Unified background-worker runtime.
//
// One always-on process that drains EVERY queue (autopilot execution, campaign
// scheduler, compliance maintenance) and registers the repeatable schedules.
// Serverless can't host long-running BullMQ consumers, so this runs on a small
// always-on host (Render/Fly/Railway) alongside the serverless API. Previously
// `worker:start` booted autopilot + compliance but NOT campaign, leaving the
// campaign-scheduler queue with nothing to consume; this composes all three.
// ===========================================================================

export interface WorkerRuntime {
  workers: Worker[];
  shutdown: () => Promise<void>;
}

/** Start all consumers and register schedules. Throws if queues are disabled. */
export async function startWorkers(): Promise<WorkerRuntime> {
  if (!env.QUEUES_ENABLED) {
    throw new Error('startWorkers: QUEUES_ENABLED=false — the worker process needs Redis. Enable queues or do not run the worker.');
  }

  // Durable error capture for background failures (no-op without SENTRY_DSN).
  await registerSentry();
  // Match the API boot contract: production always fails closed if the runtime
  // DB role can bypass RLS, and non-production can opt in via the env flag.
  await assertRlsRuntimeRole();

  const workers = [createAutopilotWorker(), createComplianceWorker(), createCampaignWorker(), createMonitoringWorker()];

  // Idempotent on every boot — upsertJobScheduler dedupes by scheduler id, so
  // restarts never create duplicate schedules.
  await registerComplianceSchedules();
  await registerCampaignSchedules();
  await registerMonitoringSchedules();

  const AUTOPILOT_RECOVERY_INTERVAL_MS = 60_000;
  let activeAutopilotRecoveryPass: Promise<void> | null = null;
  const runAutopilotRecoveryPass = async () => {
    if (activeAutopilotRecoveryPass) return activeAutopilotRecoveryPass;
    activeAutopilotRecoveryPass = (async () => {
      try {
        const summary = await reconcileStrandedAutopilotDispatches();
        if (summary.reconciled > 0 || summary.errors > 0) {
          console.info({ summary }, 'autopilot dispatch recovery pass completed');
        }
      } catch (error) {
        captureException(error instanceof Error ? error : new Error(String(error)), {
          route: 'worker:autopilot-dispatch-recovery-pass',
        });
      } finally {
        activeAutopilotRecoveryPass = null;
      }
    })();
    return activeAutopilotRecoveryPass;
  };
  await runAutopilotRecoveryPass();
  const autopilotRecoveryTimer = setInterval(() => { void runAutopilotRecoveryPass(); }, AUTOPILOT_RECOVERY_INTERVAL_MS);
  autopilotRecoveryTimer.unref?.();

  // Publish queue backlog to the metrics registry so alerts can fire on a
  // growing/stuck queue. The worker is the source of truth for depth; sampling
  // every 15s is negligible Redis load.
  const queues = [autopilotQueue, campaignQueue, complianceQueue, monitoringQueue];
  await sampleQueueDepths(queues);
  const depthTimer = setInterval(() => { void sampleQueueDepths(queues); }, 15_000);
  depthTimer.unref?.();

  // Job metrics (jobs_total, job_duration_seconds) only exist in THIS process;
  // serve them so Prometheus can scrape the worker directly.
  const metricsServer = startWorkerMetricsServer();

  const shutdown = async () => {
    clearInterval(depthTimer);
    clearInterval(autopilotRecoveryTimer);
    await Promise.allSettled(workers.map(worker => worker.close()));
    await Promise.allSettled([autopilotQueue.close(), complianceQueue.close(), campaignQueue.close(), monitoringQueue.close()]);
    if (metricsServer) await new Promise(resolve => metricsServer.close(() => resolve(null)));
    await db.$disconnect();
    // Last, so spans emitted while draining still flush to the exporter.
    await shutdownTracing();
  };

  return { workers, shutdown };
}

// CLI bootstrap (tsx server/workers/index.ts). Importing the module (e.g. tests)
// does not auto-start; only direct execution does.
const isDirectRun = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isDirectRun) {
  startWorkers()
    .then(({ workers, shutdown }) => {
      console.info(`[workers] runtime started — draining ${workers.length} queues (autopilot, compliance, campaign, monitoring-safety)`);
      let closing = false;
      const onSignal = async (signal: string) => {
        if (closing) return;
        closing = true;
        console.info(`[workers] ${signal} received — shutting down`);
        await shutdown();
        process.exit(0);
      };
      process.on('SIGINT', () => void onSignal('SIGINT'));
      process.on('SIGTERM', () => void onSignal('SIGTERM'));
    })
    .catch(error => {
      console.error('[workers] failed to start', error);
      process.exit(1);
    });
}
