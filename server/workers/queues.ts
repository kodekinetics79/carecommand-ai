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
