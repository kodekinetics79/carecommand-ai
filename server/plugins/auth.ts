import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '../generated/prisma/enums';
import { env } from '../config/env';
import { db } from '../lib/db';

const authErrorMessage = 'Session expired. Please sign in again.';

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
    const payload = await request.jwtVerify<FastifyRequest['auth'] & { type?: 'access' }>();
    if (payload.type && payload.type !== 'access') {
      throw app.httpErrors.unauthorized(authErrorMessage);
    }
    const user = await db.user.findFirst({
      where: { id: payload.userId, tenantId: payload.tenantId, active: true },
      include: { tenant: { select: { status: true, tenantSecurityPolicy: { select: { sessionsRevokedAt: true } } } } },
    });
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    // Platform-controlled suspension/archival blocks all tenant access
    // (reactivation via the Platform Control Tower restores it).
    if (user.tenant.status === 'suspended' || user.tenant.status === 'archived') {
      throw app.httpErrors.forbidden('suspended_tenant');
    }
    // Platform "revoke all sessions": reject access tokens issued before the
    // revocation instant (JWT iat is in seconds).
    // JWT iat has second granularity, so compare at the same precision: reject
    // only tokens issued strictly before the revocation second (a token minted
    // in the same second as the revoke — e.g. an immediate re-login — survives).
    const revokedAt = user.tenant.tenantSecurityPolicy?.sessionsRevokedAt;
    const iat = (payload as { iat?: number }).iat;
    if (revokedAt && iat && iat < Math.floor(revokedAt.getTime() / 1000)) {
      throw app.httpErrors.unauthorized('session_revoked');
    }
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
