import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '../generated/prisma/enums';
import { env } from '../config/env';
import { db } from '../lib/db';
import { enterTenantContext, initializeTenantContextScope } from '../lib/tenantContext';

const authErrorMessage = 'Session expired. Please sign in again.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // One mutable ALS scope spans the complete Fastify lifecycle. Authentication
  // fills it later; handlers and nested services then observe that exact scope.
  app.addHook('onRequest', (_request, _reply, done) => initializeTenantContextScope(done));

  app.decorateRequest('auth');

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const payload = await request.jwtVerify<FastifyRequest['auth'] & { type?: 'access' }>();
    if (payload.type && payload.type !== 'access') {
      throw app.httpErrors.unauthorized(authErrorMessage);
    }
    if (!UUID_RE.test(payload.tenantId ?? '') || !UUID_RE.test(payload.userId ?? '') || typeof payload.role !== 'string' || !payload.role) {
      throw app.httpErrors.unauthorized(authErrorMessage);
    }
    const rows = await db.$queryRaw<Array<{
      user_id: string;
      tenant_id: string;
      user_role: UserRole;
      branch_id: string | null;
      tenant_status: string;
      sessions_revoked_at: Date | null;
    }>>`
      SELECT * FROM app_resolve_access_session(${payload.userId}::uuid, ${payload.tenantId}::uuid)
    `;
    const user = rows[0];
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    if (user.tenant_status !== 'active') throw app.httpErrors.forbidden('suspended_tenant');

    const context = {
      tenantId: payload.tenantId,
      actorId: payload.userId,
      actorRole: user.user_role,
      source: 'request' as const,
      requestId: request.id,
    };
    // Platform "revoke all sessions": reject access tokens issued before the
    // revocation instant (JWT iat is in seconds).
    // JWT iat has second granularity, so compare at the same precision: reject
    // only tokens issued strictly before the revocation second (a token minted
    // in the same second as the revoke — e.g. an immediate re-login — survives).
    const revokedAt = user.sessions_revoked_at;
    const iat = (payload as { iat?: number }).iat;
    if (revokedAt && iat && iat < Math.floor(revokedAt.getTime() / 1000)) {
      throw app.httpErrors.unauthorized('session_revoked');
    }
    request.auth = {
      userId: user.user_id,
      tenantId: user.tenant_id,
      role: user.user_role,
      branchId: user.branch_id ?? undefined,
    };
    enterTenantContext(context);
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}
