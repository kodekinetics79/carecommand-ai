import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '../generated/prisma/enums';
import { env } from '../config/env';
import { db } from '../lib/db';

declare module 'fastify' {
  interface FastifyRequest {
    auth: {
      userId: string;
      tenantId: string;
      role: UserRole;
      branchId?: string;
    };
  }
}

export const authPlugin = fp(async app => {
  await app.register(jwt, { secret: env.JWT_SECRET });

  app.decorateRequest('auth');

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const payload = await request.jwtVerify<FastifyRequest['auth']>();
    const user = await db.user.findFirst({
      where: { id: payload.userId, tenantId: payload.tenantId, active: true },
    });
    if (!user) throw app.httpErrors.unauthorized('User is inactive or no longer belongs to this tenant');
    request.auth = {
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      branchId: user.branchId ?? undefined,
    };
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}
