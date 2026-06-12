import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { autopilotQueue } from '../../workers/queues';

async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function checkDatabase(): Promise<boolean> {
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, 2000);
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    const client = (await withTimeout(Promise.resolve(autopilotQueue.client), 1000)) as unknown as { ping(): Promise<string> };
    const pong = await withTimeout(client.ping(), 1000);
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export const healthRoutes: FastifyPluginAsync = async app => {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    const [databaseOk, redisOk] = await Promise.all([checkDatabase(), checkRedis()]);
    // Redis backs rate limiting and the job queue, so it is required in
    // production. In other environments we report its state without failing.
    const redisRequired = env.NODE_ENV === 'production';
    const ready = databaseOk && (!redisRequired || redisOk);
    const body = {
      status: ready ? 'ready' : 'not-ready',
      checks: {
        database: databaseOk ? 'ok' : 'down',
        redis: redisOk ? 'ok' : redisRequired ? 'down' : 'degraded',
      },
    };
    return ready ? body : reply.code(503).send(body);
  });
};
