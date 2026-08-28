import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { fixtureDb } from './helpers/fixtureDb';
import { requireQueueRedis } from './helpers/requireQueueRedis';
import { createEligibilityReconciliationWorker } from '../workers/eligibilityReconciliation.worker';
import {
  autopilotQueue,
  bullMqPrefix,
  campaignQueue,
  complianceQueue,
  eligibilityReconciliationQueue,
  enqueueEligibilityReconciliationTenantJob,
  monitoringQueue,
  redisConnection,
  registerEligibilityReconciliationSchedule,
  type ScheduledQueueData,
} from '../workers/queues';

const worker = createEligibilityReconciliationWorker();
const sentinelPrefix = `carecommand:sdet-sentinel:${randomUUID()}`;
const sentinel = new Queue('eligibility-reconciliation-sentinel', { connection: redisConnection, prefix: sentinelPrefix });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
let cleaned = false;
const tenantIds: string[] = [];

async function waitForState(jobId: string, expected: 'completed' | 'failed') {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await eligibilityReconciliationQueue.getJob(jobId);
    if (job && await job.getState() === expected) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for eligibility reconciliation job ${jobId} to become ${expected}`);
}

async function keys(pattern: string): Promise<string[]> {
  let cursor = '0';
  const found: string[] = [];
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await worker.close();
  await eligibilityReconciliationQueue.removeJobScheduler('eligibility-reconciliation-scan').catch(() => false);
  await Promise.allSettled([
    autopilotQueue.obliterate({ force: true }), campaignQueue.obliterate({ force: true }),
    complianceQueue.obliterate({ force: true }), monitoringQueue.obliterate({ force: true }),
    eligibilityReconciliationQueue.obliterate({ force: true }),
  ]);
  await Promise.allSettled([
    autopilotQueue.close(), campaignQueue.close(), complianceQueue.close(), monitoringQueue.close(), eligibilityReconciliationQueue.close(),
  ]);
}

beforeAll(requireQueueRedis);

afterAll(async () => {
  await cleanup();
  for (const tenantId of tenantIds) await fixtureDb.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await fixtureDb.$disconnect();
  await sentinel.obliterate({ force: true }).catch(() => undefined);
  await sentinel.close();
  await redis.quit();
});

describe('eligibility reconciliation queue lifecycle', () => {
  it('upserts the enabled bounded scheduler and enqueues a signed tenant job that drains cleanly', async () => {
    await registerEligibilityReconciliationSchedule();
    const schedulers = await eligibilityReconciliationQueue.getJobSchedulers(0, 20, true);
    expect(schedulers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'eligibility-reconciliation-scan' }),
    ]));

    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await fixtureDb.tenant.create({ data: { id: tenantId, name: `queue-${tenantId.slice(0, 8)}`, slug: `queue-${tenantId.slice(0, 8)}` } });
    await enqueueEligibilityReconciliationTenantJob(tenantId);
    const jobs = await eligibilityReconciliationQueue.getJobs(['waiting', 'active', 'completed']);
    const tenantJob = jobs.find(job => 'tenantId' in job.data && job.data.tenantId === tenantId);
    expect(tenantJob?.id).toBeTypeOf('string');
    await waitForState(tenantJob!.id!, 'completed');
  });

  it('terminalizes malformed work without preventing a clean worker close', async () => {
    const malformed = await eligibilityReconciliationQueue.add('scan-tenant', { forged: true } as unknown as ScheduledQueueData, {
      jobId: `malformed-${randomUUID()}`, attempts: 1, removeOnFail: false,
    });
    await waitForState(malformed.id!, 'failed');
    expect((await eligibilityReconciliationQueue.getJob(malformed.id!))?.failedReason).toMatch(/invalid|expected|received/i);
  });

  it('removes every key in its own namespace while leaving another namespace untouched', async () => {
    await sentinel.add('sentinel', { retain: true }, { jobId: 'must-survive-other-cleanup' });
    expect((await keys(`${sentinelPrefix}:*`)).length).toBeGreaterThan(0);

    await cleanup();

    expect(await keys(`${bullMqPrefix}:*`)).toEqual([]);
    expect((await keys(`${sentinelPrefix}:*`)).length).toBeGreaterThan(0);
    expect((await sentinel.getJob('must-survive-other-cleanup'))?.data).toEqual({ retain: true });
  });
});
