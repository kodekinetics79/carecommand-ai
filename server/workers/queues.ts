import { Queue, type ConnectionOptions } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { currentTraceCarrier, type TraceCarrier } from '../lib/traceContext';
import { createTenantJobEnvelope, tenantJobId, type TenantJobEnvelope } from '../lib/jobEnvelope';

export interface AutopilotExecutionJob {
  approvalId: string;
  tenantId: string;
  dispatchAttemptId: string;
  // W3C trace context captured at enqueue so the worker's span is a child of
  // the request that triggered it (one trace_id spans request → job → worker).
  _otel?: TraceCarrier;
}

export type EnqueueAutopilotExecutionResult = {
  state: 'queued' | 'disabled' | 'generation_conflict';
  jobId: string;
  dispatchAttemptId: string;
};

// Queues need Redis. On Redis-less deploys (serverless) set QUEUES_ENABLED=false:
// no connection is opened, the app boots, request routes all work, and background
// jobs are simply not enqueued (there is no worker to consume them anyway).
const QUEUES_ENABLED = env.QUEUES_ENABLED;
export const bullMqPrefix = `carecommand:${env.QUEUE_NAMESPACE}`;
const redisUrl = QUEUES_ENABLED ? new URL(env.REDIS_URL) : null;

export const redisConnection: ConnectionOptions = redisUrl ? {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
} : {};

// Typed no-op queue used when QUEUES_ENABLED=false (opens no Redis connection).
function disabledQueue<R, V, N extends string>(name: string): Queue<R, V, N> {
  return {
    name,
    client: Promise.resolve(undefined),
    add: async () => undefined,
    close: async () => undefined,
    upsertJobScheduler: async () => undefined,
    // Zeroed backlog so metrics sampling is a safe no-op when queues are disabled.
    getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 }),
  } as unknown as Queue<R, V, N>;
}

export const autopilotQueue: Queue<AutopilotExecutionJob, void, 'execute-approved-action'> = QUEUES_ENABLED
  ? new Queue('autopilot-execution', {
      connection: redisConnection,
      prefix: bullMqPrefix,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    })
  : disabledQueue('autopilot-execution');

export async function enqueueAutopilotExecution(input: {
  approvalId: string;
  tenantId: string;
  dispatchAttemptId?: string;
  _otel?: TraceCarrier;
}): Promise<EnqueueAutopilotExecutionResult> {
  const dispatchAttemptId = input.dispatchAttemptId ?? randomUUID();
  const data: AutopilotExecutionJob = {
    approvalId: input.approvalId,
    tenantId: input.tenantId,
    dispatchAttemptId,
    _otel: input._otel ?? currentTraceCarrier(),
  };
  const jobId = `autopilot-approval-${data.approvalId}`;
  const existing = await autopilotQueue.getJob(jobId);
  if (existing) {
    const existingState = await existing.getState();
    if (existingState === 'failed' || existingState === 'completed') {
      await existing.updateData(data);
      await existing.retry(existingState);
      return { state: 'queued', jobId, dispatchAttemptId };
    }
    if (existing.data.dispatchAttemptId !== dispatchAttemptId) {
      return { state: 'generation_conflict', jobId, dispatchAttemptId };
    }
    return { state: 'queued', jobId, dispatchAttemptId };
  }
  const job = await autopilotQueue.add(
    'execute-approved-action',
    { ...data },
    { jobId },
  );
  return job
    ? { state: 'queued', jobId: job.id ?? jobId, dispatchAttemptId }
    : { state: 'disabled', jobId, dispatchAttemptId };
}

// ---- Compliance maintenance queue -----------------------------------------
export type ComplianceJobName =
  | 'readiness-recalc'
  | 'evidence-expiry'
  | 'backup-placeholder'
  | 'access-review-reminder'
  | 'vendor-review-reminder'
  | 'security-scan-placeholder'
  | 'receptionist-confirmation-dispatch';

export type ScheduledTickData = { _otel?: TraceCarrier };
export type ScheduledQueueData = ScheduledTickData | TenantJobEnvelope;

// NameType is `string` so scheduler ids and job names can differ freely;
// ComplianceJobName still types the schedule config and worker dispatch.
export const complianceQueue: Queue<ScheduledQueueData, void, string> = QUEUES_ENABLED
  ? new Queue('compliance-maintenance', {
      connection: redisConnection,
      prefix: bullMqPrefix,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    })
  : disabledQueue('compliance-maintenance');

// Cron schedules. upsertJobScheduler is idempotent on the scheduler id, so
// re-registering on every boot does NOT create duplicate schedules.
const COMPLIANCE_SCHEDULES: Array<{ id: string; name: ComplianceJobName; pattern: string }> = [
  { id: 'compliance-readiness-recalc', name: 'readiness-recalc', pattern: '0 2 * * *' },       // daily 02:00
  { id: 'compliance-evidence-expiry', name: 'evidence-expiry', pattern: '15 2 * * *' },        // daily 02:15
  { id: 'compliance-backup-placeholder', name: 'backup-placeholder', pattern: '30 2 * * *' },  // daily 02:30
  { id: 'compliance-access-review', name: 'access-review-reminder', pattern: '0 3 * * 1' },     // weekly Mon 03:00
  { id: 'compliance-vendor-review', name: 'vendor-review-reminder', pattern: '0 4 1 * *' },     // monthly 1st 04:00
  { id: 'compliance-security-scan', name: 'security-scan-placeholder', pattern: '45 2 * * *' }, // daily 02:45 (no-op unless data supplied)
  { id: 'receptionist-confirmation-dispatch', name: 'receptionist-confirmation-dispatch', pattern: '* * * * *' }, // every minute
];

export async function registerComplianceSchedules() {
  for (const schedule of COMPLIANCE_SCHEDULES) {
    await complianceQueue.upsertJobScheduler(schedule.id, { pattern: schedule.pattern }, { name: schedule.name, data: {} });
  }
}

export async function enqueueComplianceTenantJob(operation: ComplianceJobName, tenantId: string) {
  const data = createTenantJobEnvelope({ queue: 'compliance-maintenance', operation, tenantId, _otel: currentTraceCarrier() });
  await complianceQueue.add(`${operation}-tenant`, data, { jobId: tenantJobId(data) });
}

// ---- CRM campaign scheduler queue -----------------------------------------
// Dispatches approved SCHEDULED campaigns whose scheduledAt has passed, honoring
// quiet hours. The job iterates tenants and is idempotent (delivery uniqueness +
// status transition to ACTIVE prevents re-dispatch).
export const campaignQueue: Queue<ScheduledQueueData, void, string> = QUEUES_ENABLED
  ? new Queue('campaign-scheduler', {
      connection: redisConnection,
      prefix: bullMqPrefix,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 },
    })
  : disabledQueue('campaign-scheduler');

export async function registerCampaignSchedules() {
  // Every 5 minutes — picks up due scheduled campaigns.
  await campaignQueue.upsertJobScheduler('campaign-dispatch', { pattern: '*/5 * * * *' }, { name: 'dispatch-scheduled', data: {} });
}


export async function enqueueCampaignTenantJob(tenantId: string) {
  const data = createTenantJobEnvelope({ queue: 'campaign-scheduler', operation: 'dispatch-scheduled', tenantId, _otel: currentTraceCarrier() });
  await campaignQueue.add('dispatch-scheduled-tenant', data, { jobId: tenantJobId(data) });
}

// ---- Monitoring safety-net queue ------------------------------------------
// Proactive RPM safety detectors: missed-reading + device-offline. The job
// functions iterate tenants and scope every write by tenantId, and are
// idempotent (never duplicate an already-open alert), so re-runs are safe.
export type MonitoringJobName = 'missed-reading-scan' | 'device-offline-scan';

export const monitoringQueue: Queue<ScheduledQueueData, void, string> = QUEUES_ENABLED
  ? new Queue('monitoring-safety', {
      connection: redisConnection,
      prefix: bullMqPrefix,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 },
    })
  : disabledQueue('monitoring-safety');

const MONITORING_SCHEDULES: Array<{ id: string; name: MonitoringJobName; pattern: string }> = [
  { id: 'monitoring-missed-reading', name: 'missed-reading-scan', pattern: '*/15 * * * *' },  // every 15 min
  { id: 'monitoring-device-offline', name: 'device-offline-scan', pattern: '*/15 * * * *' },  // every 15 min
];

export async function registerMonitoringSchedules() {
  for (const schedule of MONITORING_SCHEDULES) {
    await monitoringQueue.upsertJobScheduler(schedule.id, { pattern: schedule.pattern }, { name: schedule.name, data: {} });
  }
}


export async function enqueueMonitoringTenantJob(operation: MonitoringJobName, tenantId: string) {
  const data = createTenantJobEnvelope({ queue: 'monitoring-safety', operation, tenantId, _otel: currentTraceCarrier() });
  await monitoringQueue.add(`${operation}-tenant`, data, { jobId: tenantJobId(data) });
}
