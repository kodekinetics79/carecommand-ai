import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '../generated/prisma/enums';
import { env } from '../config/env';
import { db } from '../lib/db';
import { enterTenantContext, initializeTenantContextScope } from '../lib/tenantContext';

const authErrorMessage = 'Session expired. Please sign in again.';
const sessionRevokedMessage = 'Your session is no longer active. Please sign in again.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clinicScopedRoles = new Set<UserRole>(['MANAGER', 'PROVIDER', 'FRONT_DESK', 'BILLING']);
const tenantWideRoles = new Set<UserRole>(['OWNER', 'ADMIN']);
const clinicSelectionHeader = 'x-carecommand-clinic-id';

declare module 'fastify' {
  interface FastifyRequest {
    auth: {
      userId: string;
      tenantId: string;
      role: UserRole;
      branchId?: string;
      /** Every clinic this operational user may select in the current tenant. */
      branchIds: string[];
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
    if (user.tenant_status !== 'active') throw app.httpErrors.forbidden('This clinic workspace is not active. Contact your administrator.');
    const context = {
      tenantId: payload.tenantId,
      actorId: payload.userId,
      actorRole: user.user_role,
      source: 'request' as const,
      requestId: request.id,
    };
    // Establish the already-resolved tenant boundary before reading the
    // tenant-scoped assignment table. UserClinicAccess, not the JWT and not the
    // legacy primary User.branchId column, is the authority for shared staff.
    enterTenantContext(context);
    const requestedClinicHeader = request.headers[clinicSelectionHeader];
    const requestedClinicId = Array.isArray(requestedClinicHeader) ? requestedClinicHeader[0] : requestedClinicHeader;
    if (requestedClinicId && !UUID_RE.test(requestedClinicId)) {
      throw app.httpErrors.badRequest('The selected clinic identifier is invalid.');
    }
    const assignedClinics = await db.userClinicAccess.findMany({
      where: { tenantId: user.tenant_id, userId: user.user_id, branch: { active: true } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { branchId: true, isPrimary: true },
    });
    // Backward-compatible fallback for pre-UserClinicAccess accounts. New and
    // edited accounts always write the assignment table, but an older primary
    // branch remains a single-clinic restriction—not tenant-wide authority.
    const assignedBranchIds = [...new Set([
      ...assignedClinics.map(row => row.branchId),
      ...(assignedClinics.length === 0 && user.branch_id ? [user.branch_id] : []),
    ])];
    if (clinicScopedRoles.has(user.user_role) && assignedBranchIds.length === 0) {
      throw app.httpErrors.forbidden('This operational account has no active clinic assignment. Contact your administrator.');
    }
    if (requestedClinicId && clinicScopedRoles.has(user.user_role) && !assignedBranchIds.includes(requestedClinicId)) {
      throw app.httpErrors.forbidden('The selected clinic is not assigned to your account.');
    }
    // Owners/admins remain tenant-wide by default. A clinic selection narrows
    // a request for any tenant-wide or multi-clinic user; it never broadens it.
    const selectedBranchId = requestedClinicId
      ?? (clinicScopedRoles.has(user.user_role) ? assignedBranchIds[0] : undefined);
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
      throw app.httpErrors.unauthorized(sessionRevokedMessage);
    }
    request.auth = {
      userId: user.user_id,
      tenantId: user.tenant_id,
      role: user.user_role,
      branchId: selectedBranchId,
      branchIds: tenantWideRoles.has(user.user_role) ? [] : assignedBranchIds,
    };
    // A user-specific control-plane revocation must invalidate the short-lived
    // access token too, not merely its refresh token. The append-only audit
    // receipt is the durable revocation epoch and carries no PHI.
    const [latestUserRevocation, activeBranch, securityPolicy, assuranceUser] = await Promise.all([
      db.auditEvent.findFirst({
        where: {
          tenantId: user.tenant_id,
          action: { in: ['controlPlane.session.revoked', 'auth.session.revoked'] },
          resource: 'session',
          resourceId: user.user_id,
        },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
      selectedBranchId
        ? db.branch.findFirst({ where: { id: selectedBranchId, tenantId: user.tenant_id, active: true }, select: { id: true } })
        : Promise.resolve({ id: 'tenant-wide' }),
      db.tenantSecurityPolicy.findUnique({ where: { tenantId: user.tenant_id }, select: { requireMfa: true } }),
      db.user.findFirst({ where: { id: user.user_id, tenantId: user.tenant_id }, select: { mfaEnabled: true } }),
    ]);
    if (!activeBranch) throw app.httpErrors.forbidden('Your assigned clinic location is not active. Contact your administrator.');
    if (securityPolicy?.requireMfa && !assuranceUser?.mfaEnabled) {
      throw app.httpErrors.unauthorized('Multi-factor authentication is required. Sign in again to complete setup.');
    }
    if (latestUserRevocation && latestUserRevocation.occurredAt.getTime() >= issuedAtMs) {
      throw app.httpErrors.unauthorized(sessionRevokedMessage);
    }
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}
