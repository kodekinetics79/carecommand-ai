import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env';

export const authRoutes: FastifyPluginAsync = async app => {
  app.post('/dev-token', async (_request, reply) => {
    if (env.NODE_ENV === 'production') {
      return reply.code(404).send({ message: 'Not found' });
    }

    return {
      token: app.jwt.sign({
        userId: env.DEV_USER_ID,
        tenantId: env.DEV_TENANT_ID,
        role: 'OWNER',
      }),
    };
  });
};
