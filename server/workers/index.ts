import type { Worker } from 'bullmq';
import { env } from '../config/env';
import { db } from '../lib/db';
import {
  autopilotQueue,
  campaignQueue,
  complianceQueue,
  registerCampaignSchedules,
  registerComplianceSchedules,
} from './queues';
import { createAutopilotWorker } from './autopilot.worker';
import { createCampaignWorker } from './campaign.worker';
import { createComplianceWorker } from './compliance.worker';

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

  const workers = [createAutopilotWorker(), createComplianceWorker(), createCampaignWorker()];

  // Idempotent on every boot — upsertJobScheduler dedupes by scheduler id, so
  // restarts never create duplicate schedules.
  await registerComplianceSchedules();
  await registerCampaignSchedules();

  const shutdown = async () => {
    await Promise.allSettled(workers.map(worker => worker.close()));
    await Promise.allSettled([autopilotQueue.close(), complianceQueue.close(), campaignQueue.close()]);
    await db.$disconnect();
  };

  return { workers, shutdown };
}

// CLI bootstrap (tsx server/workers/index.ts). Importing the module (e.g. tests)
// does not auto-start; only direct execution does.
const isDirectRun = process.argv[1] ? import.meta.url === `file://${process.argv[1]}` : false;
if (isDirectRun) {
  startWorkers()
    .then(({ workers, shutdown }) => {
      console.info(`[workers] runtime started — draining ${workers.length} queues (autopilot, compliance, campaign)`);
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
