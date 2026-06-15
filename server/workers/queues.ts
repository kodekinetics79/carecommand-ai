import { Queue, type ConnectionOptions } from 'bullmq';
import { env } from '../config/env';

export interface AutopilotExecutionJob {
  approvalId: string;
  tenantId: string;
}

const redisUrl = new URL(env.REDIS_URL);

export const redisConnection: ConnectionOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export const autopilotQueue = new Queue<AutopilotExecutionJob, void, 'execute-approved-action'>('autopilot-execution', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export async function enqueueAutopilotExecution(data: AutopilotExecutionJob) {
  await autopilotQueue.add('execute-approved-action', data, {
    jobId: `autopilot-approval-${data.approvalId}`,
  });
}

// ---- Compliance maintenance queue -----------------------------------------
export type ComplianceJobName =
  | 'readiness-recalc'
  | 'evidence-expiry'
  | 'backup-placeholder'
  | 'access-review-reminder'
  | 'vendor-review-reminder'
  | 'security-scan-placeholder';

// NameType is `string` so scheduler ids and job names can differ freely;
// ComplianceJobName still types the schedule config and worker dispatch.
export const complianceQueue = new Queue<Record<string, never>, void, string>('compliance-maintenance', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

// Cron schedules. upsertJobScheduler is idempotent on the scheduler id, so
// re-registering on every boot does NOT create duplicate schedules.
const COMPLIANCE_SCHEDULES: Array<{ id: string; name: ComplianceJobName; pattern: string }> = [
  { id: 'compliance-readiness-recalc', name: 'readiness-recalc', pattern: '0 2 * * *' },       // daily 02:00
  { id: 'compliance-evidence-expiry', name: 'evidence-expiry', pattern: '15 2 * * *' },        // daily 02:15
  { id: 'compliance-backup-placeholder', name: 'backup-placeholder', pattern: '30 2 * * *' },  // daily 02:30
  { id: 'compliance-access-review', name: 'access-review-reminder', pattern: '0 3 * * 1' },     // weekly Mon 03:00
  { id: 'compliance-vendor-review', name: 'vendor-review-reminder', pattern: '0 4 1 * *' },     // monthly 1st 04:00
  { id: 'compliance-security-scan', name: 'security-scan-placeholder', pattern: '45 2 * * *' }, // daily 02:45 (no-op unless data supplied)
];

export async function registerComplianceSchedules() {
  for (const schedule of COMPLIANCE_SCHEDULES) {
    await complianceQueue.upsertJobScheduler(schedule.id, { pattern: schedule.pattern }, { name: schedule.name, data: {} });
  }
}

// ---- CRM campaign scheduler queue -----------------------------------------
// Dispatches approved SCHEDULED campaigns whose scheduledAt has passed, honoring
// quiet hours. The job iterates tenants and is idempotent (delivery uniqueness +
// status transition to ACTIVE prevents re-dispatch).
export const campaignQueue = new Queue<Record<string, never>, void, string>('campaign-scheduler', {
  connection: redisConnection,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 },
});

export async function registerCampaignSchedules() {
  // Every 5 minutes — picks up due scheduled campaigns.
  await campaignQueue.upsertJobScheduler('campaign-dispatch', { pattern: '*/5 * * * *' }, { name: 'dispatch-scheduled', data: {} });
}
