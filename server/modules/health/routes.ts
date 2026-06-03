import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../lib/db';

export const healthRoutes: FastifyPluginAsync = async app => {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready' });
    }
  });
};
