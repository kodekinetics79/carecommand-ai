import { vi } from 'vitest';

const refreshDependencyGauges = vi.fn(async () => ({
  databaseOk: true,
  redisOk: true,
  queueRedisOk: true,
}));

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerReadinessRoute } from '../../server/modules/health/readinessRoute';

describe('health route with queues disabled', () => {
  it('reports the queue as disabled without awaiting a BullMQ client', async () => {
    const app = Fastify({ logger: false });
    const rateLimitRedis = { ping: async () => 'PONG' };
    await registerReadinessRoute(app, {
      rateLimitRedis,
      queuesEnabled: false,
      nodeEnv: 'production',
      proxyTrustOk: true,
      refreshDependencies: refreshDependencyGauges,
    });

    const response = await app.inject('/health/ready');
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: { database: 'ok', redis: 'ok', queueRedis: 'disabled', ingressProxy: 'ok' },
    });
    expect(refreshDependencyGauges).toHaveBeenCalledWith({
      rateLimitRedis,
      queuesEnabled: false,
      queueProbe: undefined,
    });
  });
});
