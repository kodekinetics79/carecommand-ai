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
    const payload = await request.jwtVerify<FastifyRequest['auth'] & { type?: 'access'; iat?: number; sessionIssuedAtMs?: number }>();
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
    // Platform "revoke all sessions": use the millisecond claim for newly
    // issued sessions and retain second-precision compatibility for old tokens.
    const revokedAt = user.sessions_revoked_at;
    const issuedAtMs = Number.isFinite(payload.sessionIssuedAtMs)
      ? payload.sessionIssuedAtMs!
      : Number.isFinite(payload.iat) ? payload.iat! * 1000 : 0;
    if (revokedAt && (
      payload.sessionIssuedAtMs
        ? issuedAtMs <= revokedAt.getTime()
        : payload.iat && payload.iat < Math.floor(revokedAt.getTime() / 1000)
    )) {
      throw app.httpErrors.unauthorized('session_revoked');
    }
    request.auth = {
      userId: user.user_id,
      tenantId: user.tenant_id,
      role: user.user_role,
      branchId: user.branch_id ?? undefined,
    };
    enterTenantContext(context);
    // A user-specific control-plane revocation must invalidate the short-lived
    // access token too, not merely its refresh token. The append-only audit
    // receipt is the durable revocation epoch and carries no PHI.
    const [latestUserRevocation, activeBranch] = await Promise.all([
      db.auditEvent.findFirst({
        where: {
          tenantId: user.tenant_id,
          action: 'controlPlane.session.revoked',
          resource: 'session',
          resourceId: user.user_id,
        },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
      user.branch_id
        ? db.branch.findFirst({ where: { id: user.branch_id, tenantId: user.tenant_id, active: true }, select: { id: true } })
        : Promise.resolve({ id: 'tenant-wide' }),
    ]);
    if (!activeBranch) throw app.httpErrors.forbidden('clinic_inactive');
    if (latestUserRevocation && latestUserRevocation.occurredAt.getTime() >= issuedAtMs) {
      throw app.httpErrors.unauthorized('session_revoked');
    }
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}
