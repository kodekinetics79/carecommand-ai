import { describe, expect, it } from 'vitest';
import { checkQueueRedis, checkRateLimitRedis } from '../../server/modules/health/redisChecks';

describe('Redis readiness ownership', () => {
  it('probes the API rate-limit Redis independently of disabled queues', async () => {
    await expect(checkRateLimitRedis({ ping: async () => 'PONG' })).resolves.toBe(true);
    await expect(checkQueueRedis({ enabled: false })).resolves.toBe(true);
  });

  it('fails readiness when the API rate-limit Redis is unavailable', async () => {
    await expect(checkRateLimitRedis({ ping: async () => { throw new Error('down'); } })).resolves.toBe(false);
  });

  it('probes queue Redis only when queues are enabled', async () => {
    await expect(checkQueueRedis({
      enabled: true,
      probe: async () => ({ waiting: 0 }),
    })).resolves.toBe(true);
    await expect(checkQueueRedis({ enabled: true })).resolves.toBe(false);
  });
});
