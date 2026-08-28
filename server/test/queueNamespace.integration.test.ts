import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { bullMqPrefix, redisConnection } from '../workers/queues';

const queues: Queue[] = [];

afterAll(async () => {
  for (const queue of queues) {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  }
});

describe('BullMQ deployment namespace', () => {
  it('uses the authoritative configured prefix', () => {
    expect(bullMqPrefix).toMatch(/^carecommand:[A-Za-z0-9:_-]+$/);
  });

  it('isolates identical logical queue and job IDs across test namespaces', async () => {
    const suffix = randomUUID();
    const first = new Queue('namespace-isolation', { connection: redisConnection, prefix: `carecommand:test-a:${suffix}` });
    const second = new Queue('namespace-isolation', { connection: redisConnection, prefix: `carecommand:test-b:${suffix}` });
    queues.push(first, second);
    await first.add('probe', { owner: 'first' }, { jobId: 'same-job' });
    expect((await first.getJob('same-job'))?.data).toEqual({ owner: 'first' });
    expect(await second.getJob('same-job')).toBeUndefined();
  });
});
