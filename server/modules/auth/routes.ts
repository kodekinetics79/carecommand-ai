import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { enterTenantContext } from '../../lib/tenantContext';
import {
  resolveAuthLoginCandidates,
  resolveIngressTenant,
  resolvePasswordResetIngress,
  revokeInactiveRefreshToken,
  type AuthLoginCandidate,
} from '../../lib/tenantIngressResolvers';
import {
  createCsrfToken, createRefreshToken, hashRefreshToken, verifyPassword,
  validatePassword, createResetToken, hashResetToken, generatePasswordHash,
  encryptSecret, decryptSecret,
} from '../../lib/security';
import { generateTotpSecret, verifyTotp, totpAuthUri } from '../../lib/totp';
import { getRequestPermissions } from '../../lib/permissions';
import { deliverPasswordReset } from '../../lib/passwordResetDelivery';

const loginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1).max(200),
  tenantSlug: z.string().trim().toLowerCase().min(2).max(80).optional(),
});

const refreshCookieName = 'cc_refresh';
const csrfCookieName = 'cc_csrf';
const refreshCookiePath = '/v1/auth';
const csrfCookiePath = '/';
const refreshTokenTtlSeconds = 60 * 60 * 24 * 30;
const clinicScopedRoles = new Set(['MANAGER', 'PROVIDER', 'FRONT_DESK', 'BILLING']);

function missingRequiredClinicScope(user: { role: string; branchId: string | null }) {
  return clinicScopedRoles.has(user.role) && !user.branchId;
}
const accessTokenTtl = '15m';
const accessTokenTtlMinutes = 15;
const authErrorMessage = 'Session expired. Please sign in again.';
const csrfErrorMessage = 'Invalid request token';
// Identical generic response for invalid creds AND lockout, so probes cannot
// tell whether an account exists or is locked.
const genericAuthError = 'Invalid credentials or account temporarily unavailable.';

// Valid fixed-cost scrypt material for identities with no stored password. The
// plaintext used to create it is not an application credential. Authentication
// still returns false for an absent user, but performs the same KDF work first.
export const TENANT_LOGIN_DUMMY_HASH = 'scrypt$5f61b7e563732ec9e637bd7918a83f12$585ece13e6d3bcc495ea16877b3c11224a5ebc3d317f689578cd0c40279344a480e2ed0a03532b1182c6793e8f59d66917feaf24ba6d6ab13c8bcf413794e7a0';

type PasswordVerifier = (password: string, storedHash?: string | null) => Promise<boolean>;

export async function verifyTenantLoginPassword(
  password: string,
  storedHash: string | null | undefined,
  verifier: PasswordVerifier = verifyPassword,
): Promise<boolean> {
  return verifier(password, storedHash ?? TENANT_LOGIN_DUMMY_HASH);
}

function isProduction() {
  return env.NODE_ENV === 'production';
}

// SameSite policy (env.COOKIE_SAMESITE): 'lax' for same-origin; 'none' for a
// cross-site frontend (e.g. Vercel UI + Render API). 'none' requires Secure.
const sameSiteAttr = `SameSite=${env.COOKIE_SAMESITE.charAt(0).toUpperCase()}${env.COOKIE_SAMESITE.slice(1)}`;
function cookieSecure() { return isProduction() || env.COOKIE_SAMESITE === 'none'; }

function cookieFlags(name: string, path: string, httpOnly: boolean, maxAgeSeconds: number, value: string) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAgeSeconds}`,
    httpOnly ? 'HttpOnly' : undefined,
    `Path=${path}`,
    sameSiteAttr,
    cookieSecure() ? 'Secure' : undefined,
  ].filter(Boolean);
  return attributes.join('; ');
}

function setAuthCookies(reply: FastifyReply, refreshToken: string, csrfToken: string) {
  reply.raw.setHeader('Set-Cookie', [
    cookieFlags(refreshCookieName, refreshCookiePath, true, refreshTokenTtlSeconds, refreshToken),
    cookieFlags(csrfCookieName, csrfCookiePath, false, refreshTokenTtlSeconds, csrfToken),
  ]);
}

function setCsrfCookie(reply: FastifyReply, csrfToken: string) {
  reply.header('Cache-Control', 'no-store');
  reply.raw.setHeader('Set-Cookie', cookieFlags(csrfCookieName, csrfCookiePath, false, refreshTokenTtlSeconds, csrfToken));
}

function clearAuthCookies(reply: FastifyReply) {
  reply.raw.setHeader('Set-Cookie', [
    `${refreshCookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=${refreshCookiePath}; ${sameSiteAttr}${cookieSecure() ? '; Secure' : ''}`,
    `${csrfCookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${csrfCookiePath}; ${sameSiteAttr}${cookieSecure() ? '; Secure' : ''}`,
  ]);
}

function readCookieValue(request: FastifyRequest, cookieName: string) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  const cookie = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
  if (!cookie) return null;
  return decodeURIComponent(cookie.slice(cookieName.length + 1));
}

function readCsrfHeader(request: FastifyRequest) {
  const header = request.headers['x-csrf-token'];
  return Array.isArray(header) ? header[0] : header;
}

function verifyCsrf(request: FastifyRequest) {
  const cookieToken = readCookieValue(request, csrfCookieName);
  const headerToken = readCsrfHeader(request);
  if (!cookieToken || !headerToken) return false;
  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(headerToken);
  if (cookieBuffer.length !== headerBuffer.length) return false;
  return timingSafeEqual(cookieBuffer, headerBuffer);
}

type SessionUserShape = { id: string; tenantId: string; role: string; branchId: string | null };
type SessionResolvedUser = NonNullable<Awaited<ReturnType<typeof resolveSessionUser>>>;
type LoginUser = AuthLoginCandidate;

function tenantBlocksSessions(status: string) {
  return status !== 'active';
}

async function tenantPolicy(tenantId: string) {
  return db.tenantSecurityPolicy.findUnique({ where: { tenantId } });
}

async function lockUserAuthState(client: Prisma.TransactionClient | typeof db, tenantId: string, userId: string) {
  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant-auth:${tenantId}:${userId}`}::text, 0))::text AS locked`;
}

async function latestUserSessionRevocation(
  client: Prisma.TransactionClient | typeof db,
  tenantId: string,
  userId: string,
) {
  return client.auditEvent.findFirst({
    where: {
      tenantId,
      action: { in: ['controlPlane.session.revoked', 'auth.session.revoked'] },
      resource: 'session',
      resourceId: userId,
    },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true },
  });
}

// Access-token TTL honours the tenant's sessionTimeoutMinutes (clamped), while
// the secure 30-day refresh token is unchanged.
function accessTtlSeconds(sessionTimeoutMinutes?: number | null) {
  const minutes = Math.min(Math.max(sessionTimeoutMinutes ?? accessTokenTtlMinutes, 5), 1440);
  return minutes * 60;
}

function buildSession(app: FastifyInstance, user: SessionUserShape, ttlSeconds: number, revokedAt?: Date | null) {
  const sessionIssuedAtMs = Math.max(Date.now(), (revokedAt?.getTime() ?? 0) + 1);
  return app.jwt.sign(
    { userId: user.id, tenantId: user.tenantId, role: user.role, branchId: user.branchId ?? undefined, type: 'access', sessionIssuedAtMs },
    { expiresIn: ttlSeconds },
  );
}

async function issueSession(
  app: FastifyInstance,
  user: SessionUserShape,
  ttlSeconds: number,
  revokedAt?: Date | null,
  client: Prisma.TransactionClient | typeof db = db,
) {
  await lockUserAuthState(client, user.tenantId, user.id);
  const userRevocation = await latestUserSessionRevocation(client, user.tenantId, user.id);
  const effectiveRevocation = userRevocation && (!revokedAt || userRevocation.occurredAt > revokedAt)
    ? userRevocation.occurredAt
    : revokedAt;
  const refreshToken = createRefreshToken();
  const csrfToken = createCsrfToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const refreshTokenExpiresAt = new Date(Date.now() + 1000 * refreshTokenTtlSeconds);
  await client.user.update({
    where: { id: user.id },
    data: { refreshTokenHash, refreshTokenExpiresAt, lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });
  return { accessToken: buildSession(app, user, ttlSeconds, effectiveRevocation), refreshToken, csrfToken };
}

async function issueMfaFlowToken(
  app: FastifyInstance,
  user: Pick<SessionUserShape, 'id' | 'tenantId'>,
  type: 'mfa-setup' | 'mfa-challenge',
  expiresIn: string,
  tenantRevokedAt: Date | null | undefined,
  client: Prisma.TransactionClient,
) {
  const userRevocation = await latestUserSessionRevocation(client, user.tenantId, user.id);
  const effectiveRevocation = userRevocation && (!tenantRevokedAt || userRevocation.occurredAt > tenantRevokedAt)
    ? userRevocation.occurredAt
    : tenantRevokedAt;
  const sessionIssuedAtMs = Math.max(Date.now(), (effectiveRevocation?.getTime() ?? 0) + 1);
  return app.jwt.sign({ userId: user.id, tenantId: user.tenantId, type, sessionIssuedAtMs }, { expiresIn });
}

async function resolveSessionUser(userId: string) {
  return db.user.findFirst({
    where: { id: userId, active: true },
    include: {
      tenant: { select: { id: true, name: true, slug: true, status: true } },
      branch: { select: { id: true, name: true, location: true } },
      clinicAccesses: {
        where: { branch: { active: true } },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: { isPrimary: true, branch: { select: { id: true, name: true, location: true } } },
      },
    },
  });
}

function serializeUser(user: SessionResolvedUser | LoginUser) {
  const tenantWide = user.role === 'OWNER' || user.role === 'ADMIN';
  const clinicAccesses = !tenantWide && 'clinicAccesses' in user
    ? user.clinicAccesses.map(access => ({ ...access.branch, isPrimary: access.isPrimary }))
    : undefined;
  return {
    id: user.id, email: user.email, displayName: user.displayName, role: user.role,
    branchId: tenantWide ? null : user.branchId,
    branch: tenantWide ? null : user.branch,
    ...(clinicAccesses ? { clinicAccesses } : {}),
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
    active: user.active,
    mfaEnabled: user.mfaEnabled,
  };
}

async function loginCandidates(email: string, tenantSlug?: string): Promise<LoginUser[]> {
  return resolveAuthLoginCandidates(email, tenantSlug);
}

async function auditAuth(
  request: FastifyRequest,
  tenantId: string,
  userId: string | null,
  action: string,
  metadata?: Record<string, unknown>,
  client: Prisma.TransactionClient | typeof db = db,
) {
  await client.auditEvent.create({
    data: {
      tenantId, actorUserId: userId ?? undefined, action, resource: 'session',
      resourceId: userId ?? undefined,
      requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      metadata: metadata as never,
    },
  });
}

async function auditPasswordRecoveryRequest(
  request: FastifyRequest,
  tenantId: string,
  subjectUserId: string,
  action: string,
  metadata: Record<string, unknown>,
  client: Prisma.TransactionClient | typeof db = db,
) {
  await client.auditEvent.create({
    data: {
      tenantId,
      // The public requester has not authenticated as the affected user. Keep
      // actor attribution empty and represent that user only as the subject.
      actorUserId: undefined,
      action,
      resource: 'password_reset',
      resourceId: subjectUserId,
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: metadata as never,
    },
  });
}

export const authRoutes: FastifyPluginAsync = async app => {
  // The real-backend browser certification intentionally performs more than
  // ten sequential synthetic role logins from one loopback IP. Production
  // retains the strict limit; only the explicit E2E harness receives headroom.
  const rateLogin = { config: { rateLimit: { max: env.E2E_TEST_MODE ? 100 : 10, timeWindow: '1 minute' } } };
  const rateSensitive = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/dev-token', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (_request, reply) => {
    if (env.NODE_ENV === 'production' || !env.DEV_USER_ID || !env.DEV_TENANT_ID) {
      return reply.code(404).send({ message: 'Not found' });
    }
    return {
      token: app.jwt.sign({ userId: env.DEV_USER_ID, tenantId: env.DEV_TENANT_ID, role: 'OWNER', type: 'access' }, { expiresIn: accessTokenTtl }),
    };
  });

  // The SPA may be hosted on a different origin from the API. JavaScript on
  // that origin cannot read an API-domain CSRF cookie, so expose the matching
  // double-submit value through an allowlisted CORS response and keep it out of
  // persistent browser storage. This endpoint never exposes session state.
  app.get('/csrf', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const csrfToken = createCsrfToken();
    setCsrfCookie(reply, csrfToken);
    return { csrfToken };
  });

  // ===== Login (lockout + expiry + MFA gating) =============================
  app.post('/login', rateLogin, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const now = new Date();
    const candidates = await loginCandidates(input.email, input.tenantSlug);

    // Do not reveal duplicate workspace membership to an unauthenticated email
    // probe. Only a caller who has supplied a valid password for at least one of
    // the duplicate accounts receives the neutral tenant-selector challenge;
    // tenant names and slugs are never enumerated by this response.
    if (!input.tenantSlug && candidates.length > 1) {
      const passwordMatches = await Promise.all(candidates.map(candidate =>
        verifyTenantLoginPassword(input.password, candidate.passwordHash),
      ));
      if (!passwordMatches.some((matches, index) => Boolean(candidates[index].passwordHash) && matches)) {
        throw app.httpErrors.unauthorized(genericAuthError);
      }
      return reply.code(409).send({
        status: 'tenant_required',
        message: 'This email is linked to more than one workspace. Enter your clinic workspace identifier.',
      });
    }

    const user = candidates[0] ?? null;
    const passwordMatches = await verifyTenantLoginPassword(input.password, user?.passwordHash);
    const passwordOk = Boolean(user?.passwordHash && passwordMatches);

    // A tenant context can be activated only after the bounded credential
    // resolver identifies a candidate. Inactive tenants fail before scoped DB
    // work because the RLS context validator intentionally accepts only active
    // tenants.
    if (user && tenantBlocksSessions(user.tenant.status)) {
      if (passwordOk) {
        return reply.code(403).send({ status: 'suspended_tenant', message: 'This account is suspended. Please contact support.' });
      }
      throw app.httpErrors.unauthorized(genericAuthError);
    }
    if (user) {
      enterTenantContext({
        tenantId: user.tenantId,
        actorId: user.id,
        actorRole: user.role,
        source: 'request',
        requestId: request.id,
      });
    }
    const policy = user ? await tenantPolicy(user.tenantId) : null;

    // Locked account → generic error (no existence/lock leak), still audited.
    if (user && user.lockedUntil && user.lockedUntil > now) {
      await auditAuth(request, user.tenantId, user.id, 'auth.login.failed', { reason: 'locked' });
      throw app.httpErrors.unauthorized(genericAuthError);
    }

    if (!user || !passwordOk) {
      if (user) {
        const lockoutEnabled = policy?.failedLoginLockout ?? false;
        // Commit the state and failure evidence before raising the HTTP error.
        // Throwing inside this transaction would roll both back and erase the
        // very audit trail/lockout state this rejected attempt must preserve.
        await db.$transaction(async tx => {
          await lockUserAuthState(tx, user.tenantId, user.id);
          const current = await tx.user.findFirst({
            where: { id: user.id, tenantId: user.tenantId, active: true },
            select: { failedLoginCount: true, lockedUntil: true },
          });
          if (!current) return;
          const transitionAt = new Date();
          if (current.lockedUntil && current.lockedUntil > transitionAt) {
            await auditAuth(request, user.tenantId, user.id, 'auth.login.failed', { reason: 'locked' }, tx);
            return;
          }
          const nextCount = current.failedLoginCount + 1;
          const shouldLock = lockoutEnabled && nextCount >= env.AUTH_LOCKOUT_THRESHOLD;
          await tx.user.update({
            where: { id: user.id },
            data: shouldLock
              ? { failedLoginCount: 0, lockedUntil: new Date(transitionAt.getTime() + env.AUTH_LOCKOUT_DURATION_MINUTES * 60000) }
              : { failedLoginCount: nextCount },
          });
          await auditAuth(request, user.tenantId, user.id, 'auth.login.failed', { reason: 'invalid-credentials', attempt: nextCount }, tx);
          if (shouldLock) {
            await auditAuth(request, user.tenantId, user.id, 'auth.login.lockout', {
              threshold: env.AUTH_LOCKOUT_THRESHOLD,
              durationMinutes: env.AUTH_LOCKOUT_DURATION_MINUTES,
            }, tx);
          }
        });
      }
      throw app.httpErrors.unauthorized(genericAuthError);
    }

    if (missingRequiredClinicScope(user)) {
      await auditAuth(request, user.tenantId, user.id, 'auth.login.denied', { reason: 'missing_clinic_scope' });
      return reply.code(403).send({
        status: 'clinic_assignment_required',
        message: 'This operational account has no clinic assignment. Contact your administrator before signing in.',
      });
    }

    // Password expiry → require reset (no session issued).
    if (policy?.passwordExpiryDays && policy.passwordExpiryDays > 0 && user.passwordChangedAt) {
      const expiresAt = new Date(user.passwordChangedAt.getTime() + policy.passwordExpiryDays * 86400000);
      if (expiresAt < now) {
        await db.$transaction(async tx => {
          await lockUserAuthState(tx, user.tenantId, user.id);
          await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
          await auditAuth(request, user.tenantId, user.id, 'auth.password.expired', undefined, tx);
        });
        return reply.send({ status: 'password_expired', message: 'Your password has expired. Please reset it before signing in.' });
      }
    }

    // MFA challenge (user has verified MFA).
    if (user.mfaEnabled) {
      const mfaToken = await db.$transaction(async tx => {
        await lockUserAuthState(tx, user.tenantId, user.id);
        await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
        await auditAuth(request, user.tenantId, user.id, 'auth.login.mfaChallenge', undefined, tx);
        return issueMfaFlowToken(app, user, 'mfa-challenge', '5m', policy?.sessionsRevokedAt, tx);
      });
      return reply.send({ status: 'mfa_required', mfaToken });
    }
    // MFA required by policy but not yet set up.
    if (policy?.requireMfa && !user.mfaEnabled) {
      const mfaToken = await db.$transaction(async tx => {
        await lockUserAuthState(tx, user.tenantId, user.id);
        await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
        await auditAuth(request, user.tenantId, user.id, 'auth.login.mfaSetupRequired', undefined, tx);
        return issueMfaFlowToken(app, user, 'mfa-setup', '10m', policy.sessionsRevokedAt, tx);
      });
      return reply.send({ status: 'mfa_setup_required', mfaToken });
    }

    const session = await db.$transaction(async tx => {
      const issued = await issueSession(app, user, accessTtlSeconds(policy?.sessionTimeoutMinutes), policy?.sessionsRevokedAt, tx);
      await auditAuth(request, user.tenantId, user.id, 'auth.login.success', { email: user.email }, tx);
      return issued;
    });
    setAuthCookies(reply, session.refreshToken, session.csrfToken);
    return { accessToken: session.accessToken, csrfToken: session.csrfToken, user: serializeUser(user) };
  });

  // ===== Refresh / logout / me / session-info =============================
  app.post('/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!verifyCsrf(request)) throw app.httpErrors.unauthorized(csrfErrorMessage);
    const refreshToken = readCookieValue(request, refreshCookieName);
    if (!refreshToken) throw app.httpErrors.unauthorized(authErrorMessage);
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const resolved = await resolveIngressTenant('refresh_token_hash', refreshTokenHash);
    if (!resolved) {
      const revoked = await revokeInactiveRefreshToken(refreshTokenHash);
      clearAuthCookies(reply);
      if (revoked) {
        return reply.code(403).send({ status: 'suspended_tenant', message: 'This account is suspended. Please contact support.' });
      }
      return reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: authErrorMessage });
    }
    enterTenantContext({
      tenantId: resolved.tenantId,
      actorId: resolved.resourceId,
      actorRole: 'SESSION_REFRESH',
      source: 'request',
      requestId: request.id,
    });
    const user = await db.user.findFirst({
      where: { id: resolved.resourceId, refreshTokenHash, refreshTokenExpiresAt: { gt: new Date() }, active: true },
      include: {
        tenant: { select: { id: true, name: true, slug: true, status: true } },
        branch: { select: { id: true, name: true, location: true } },
        clinicAccesses: {
          where: { branch: { active: true } },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: { isPrimary: true, branch: { select: { id: true, name: true, location: true } } },
        },
      },
    });
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    if (tenantBlocksSessions(user.tenant.status)) {
      await db.$transaction(async tx => {
        await tx.user.update({ where: { id: user.id }, data: { refreshTokenHash: null, refreshTokenExpiresAt: null } });
        await auditAuth(request, user.tenantId, user.id, 'auth.refresh.denied', { reason: `${user.tenant.status}_tenant` }, tx);
      });
      clearAuthCookies(reply);
      return reply.code(403).send({ status: 'suspended_tenant', message: 'This account is suspended. Please contact support.' });
    }
    if (missingRequiredClinicScope(user)) {
      await db.$transaction(async tx => {
        await tx.user.update({ where: { id: user.id }, data: { refreshTokenHash: null, refreshTokenExpiresAt: null } });
        await auditAuth(request, user.tenantId, user.id, 'auth.refresh.denied', { reason: 'missing_clinic_scope' }, tx);
      });
      clearAuthCookies(reply);
      return reply.code(403).send({
        status: 'clinic_assignment_required',
        message: 'This operational account has no clinic assignment. Contact your administrator before signing in.',
      });
    }
    const policy = await tenantPolicy(user.tenantId);
    if (policy?.requireMfa && !user.mfaEnabled) {
      await db.$transaction(async tx => {
        await tx.user.update({ where: { id: user.id }, data: { refreshTokenHash: null, refreshTokenExpiresAt: null } });
        await auditAuth(request, user.tenantId, user.id, 'auth.refresh.denied', { reason: 'mfa_reauthentication_required' }, tx);
      });
      clearAuthCookies(reply);
      return reply.code(403).send({
        status: 'mfa_reauthentication_required',
        message: 'MFA is required. Sign in with your password to complete setup or verification.',
      });
    }
    const session = await db.$transaction(async tx => {
      const issued = await issueSession(app, user, accessTtlSeconds(policy?.sessionTimeoutMinutes), policy?.sessionsRevokedAt, tx);
      await auditAuth(request, user.tenantId, user.id, 'auth.refresh.success', undefined, tx);
      return issued;
    });
    setAuthCookies(reply, session.refreshToken, session.csrfToken);
    return { accessToken: session.accessToken, csrfToken: session.csrfToken, user: serializeUser(user) };
  });

  app.post('/logout', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!verifyCsrf(request)) { clearAuthCookies(reply); return reply.code(204).send(); }
    const refreshToken = readCookieValue(request, refreshCookieName);
    if (refreshToken) {
      const refreshTokenHash = hashRefreshToken(refreshToken);
      const resolved = await resolveIngressTenant('refresh_token_hash', refreshTokenHash);
      if (resolved) {
        enterTenantContext({
          tenantId: resolved.tenantId,
          actorId: resolved.resourceId,
          actorRole: 'SESSION_LOGOUT',
          source: 'request',
          requestId: request.id,
        });
        await db.$transaction(async tx => {
          const user = await tx.user.findFirst({ where: { id: resolved.resourceId, refreshTokenHash }, select: { id: true, tenantId: true } });
          await tx.user.updateMany({ where: { id: resolved.resourceId, refreshTokenHash }, data: { refreshTokenHash: null, refreshTokenExpiresAt: null } });
          if (user) await auditAuth(request, user.tenantId, user.id, 'auth.logout', { reason: 'user-initiated' }, tx);
        });
      }
    }
    clearAuthCookies(reply);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: app.authenticate }, async request => {
    const user = await resolveSessionUser(request.auth.userId);
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    const permissions = [...await getRequestPermissions(request)].sort();
    return {
      user: serializeUser(user),
      access: {
        tenantId: user.tenantId,
        branchId: request.auth.branchId ?? null,
        branchIds: request.auth.branchIds,
        role: user.role,
        permissions,
      },
    };
  });

  app.get('/session-info', { preHandler: app.authenticate }, async request => {
    const policy = await tenantPolicy(request.auth.tenantId);
    return {
      accessTokenTtlMinutes: Math.round(accessTtlSeconds(policy?.sessionTimeoutMinutes) / 60),
      refreshTokenTtlDays: Math.round(refreshTokenTtlSeconds / 86400),
      csrfEnabled: true, cookiePath: refreshCookiePath, csrfCookiePath, sameSite: env.COOKIE_SAMESITE, secure: cookieSecure(),
      httpOnlyRefreshCookie: true, devTokenEnabled: env.NODE_ENV !== 'production', productionHttpsRequired: isProduction(),
      rbacEnabled: true, auditLoggingEnabled: true,
      accountLockoutEnabled: policy?.failedLoginLockout ?? false,
      requireMfa: policy?.requireMfa ?? false,
    };
  });

  // ===== Password reset ===================================================
  app.post('/password-reset/request', rateSensitive, async (request, reply) => {
    const responseStartedAt = Date.now();
    const { email, tenantSlug } = z.object({
      email: z.string().email().trim().toLowerCase(),
      tenantSlug: z.string().trim().toLowerCase().min(2).max(80).optional(),
    }).parse(request.body);
    // Every outcome is deliberately identical. This response must not reveal
    // account existence, tenant status, workspace ambiguity, provider setup,
    // delivery success, or the resend cooldown.
    const generic = {
      status: 'ok',
      message: `If an active account matches, we’ll email a reset link. It expires in ${env.PASSWORD_RESET_TTL_MINUTES} minutes.`,
    } as Record<string, unknown>;
    reply.header('Cache-Control', 'no-store');
    const finish = async (body: Record<string, unknown> = generic) => {
      // The provider call is capped below this floor. Matching public response
      // timing prevents a remote probe from distinguishing known accounts from
      // unknown, inactive, ambiguous, or globally unconfigured outcomes.
      if (isProduction()) {
        const remaining = 3000 - (Date.now() - responseStartedAt);
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      }
      return reply.send(body);
    };

    const candidates = await resolveAuthLoginCandidates(email, tenantSlug);
    // An email may legitimately exist in several customer workspaces. Require
    // the optional workspace selector rather than choosing an arbitrary tenant.
    if (candidates.length !== 1 || tenantBlocksSessions(candidates[0].tenant.status)) return finish();
    const candidate = candidates[0];
    enterTenantContext({
      tenantId: candidate.tenantId,
      actorId: candidate.id,
      actorRole: 'PASSWORD_RESET',
      source: 'request',
      requestId: request.id,
    });
    const user = await db.user.findFirst({ where: { id: candidate.id, email, active: true } });
    if (!user) return finish();

    const rawToken = createResetToken();
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60000);
    const passwordVersionAtIssuance = user.passwordChangedAt?.getTime() ?? null;
    // Serialize issuance per user. A short resend cooldown prevents email
    // bombing and guarantees concurrent clicks do not send several valid links.
    const issued = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-password-reset-user:${user.id}`}::text, 0))::text AS locked`;
      const recent = await tx.passwordResetToken.findFirst({
        where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() }, createdAt: { gt: new Date(Date.now() - 120_000) } },
        select: { id: true },
      });
      if (recent) {
        await auditPasswordRecoveryRequest(request, user.tenantId, user.id, 'auth.password.reset.requested', { reused: true }, tx);
        return null;
      }
      const token = await tx.passwordResetToken.create({
        data: { tenantId: user.tenantId, userId: user.id, tokenHash, expiresAt, activatedAt: isProduction() ? null : new Date() },
        select: { id: true },
      });
      await auditPasswordRecoveryRequest(request, user.tenantId, user.id, 'auth.password.reset.requested', { ttlMinutes: env.PASSWORD_RESET_TTL_MINUTES, reused: false }, tx);
      return token;
    });
    if (!issued) return finish();

    // Local/test keeps the existing one-time echo for deterministic automated
    // coverage. Production never returns or logs the raw credential.
    if (env.NODE_ENV === 'test' || env.E2E_TEST_MODE) {
      request.log.info({ userId: user.id }, 'password reset token issued (dev-only echo)');
      return finish({ ...generic, devToken: rawToken });
    }

    const delivery = await deliverPasswordReset({ email: user.email, tenantName: candidate.tenant.name, token: rawToken, deliveryId: issued.id });
    if (!delivery.ok) {
      await db.$transaction(async tx => {
        await tx.passwordResetToken.deleteMany({ where: { id: issued.id, userId: user.id, activatedAt: null } });
        await auditPasswordRecoveryRequest(request, user.tenantId, user.id, 'auth.password.reset.delivery_failed', { mode: delivery.mode, status: delivery.status }, tx);
      }).catch(error => request.log.error({ err: error, tenantId: user.tenantId, userId: user.id }, 'password reset failure cleanup failed'));
      request.log.warn({ tenantId: user.tenantId, userId: user.id, mode: delivery.mode, status: delivery.status }, 'password reset delivery failed');
      return finish();
    }

    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-password-reset-user:${user.id}`}::text, 0))::text AS locked`;
      const currentUser = await tx.user.findFirst({ where: { id: user.id, tenantId: user.tenantId, active: true }, select: { passwordChangedAt: true } });
      const currentPasswordVersion = currentUser?.passwordChangedAt?.getTime() ?? null;
      if (!currentUser || currentPasswordVersion !== passwordVersionAtIssuance) {
        await tx.passwordResetToken.deleteMany({ where: { id: issued.id, activatedAt: null } });
        return false;
      }
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, id: { not: issued.id }, usedAt: null },
        data: { usedAt: new Date() },
      });
      const activated = await tx.passwordResetToken.updateMany({
        where: { id: issued.id, userId: user.id, activatedAt: null, usedAt: null, expiresAt: { gt: new Date() } },
        data: { activatedAt: new Date() },
      });
      if (activated.count !== 1) return false;
      await auditPasswordRecoveryRequest(request, user.tenantId, user.id, 'auth.password.reset.delivered', { mode: delivery.mode }, tx);
      return true;
    }).then(activated => {
      if (!activated) request.log.error({ tenantId: user.tenantId, userId: user.id }, 'password reset credential was delivered but not activated');
    }).catch(error => request.log.error({ err: error, tenantId: user.tenantId, userId: user.id }, 'password reset credential activation failed'));
    return finish();
  });

  app.post('/password-reset/confirm', rateSensitive, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { token, newPassword } = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), newPassword: z.string().min(1).max(200) }).parse(request.body);
    const policyCheck = validatePassword(newPassword);
    if (!policyCheck.ok) throw app.httpErrors.badRequest(policyCheck.message ?? 'Password does not meet policy.');

    const tokenHash = hashResetToken(token);
    const resolved = await resolvePasswordResetIngress(tokenHash);
    if (!resolved) throw app.httpErrors.badRequest('This reset link is invalid or has expired.');
    enterTenantContext({
      tenantId: resolved.tenantId,
      actorId: resolved.userId,
      actorRole: 'PASSWORD_RESET',
      source: 'request',
      requestId: request.id,
    });
    const passwordHash = await generatePasswordHash(newPassword);
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-password-reset-user:${resolved.userId}`}::text, 0))::text AS locked`;
      const transitionAt = new Date();
      const record = await tx.passwordResetToken.findFirst({
        where: { id: resolved.tokenId, tenantId: resolved.tenantId, userId: resolved.userId, tokenHash, activatedAt: { not: null }, usedAt: null, expiresAt: { gt: transitionAt } },
        select: { id: true, tenantId: true, userId: true },
      });
      if (!record) throw app.httpErrors.badRequest('This reset link is invalid or has expired.');
      const consumed = await tx.passwordResetToken.updateMany({
        where: { tenantId: record.tenantId, userId: record.userId, usedAt: null },
        data: { usedAt: transitionAt },
      });
      if (consumed.count < 1) throw app.httpErrors.badRequest('This reset link is invalid or has expired.');
      await lockUserAuthState(tx, record.tenantId, record.userId);
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash, passwordChangedAt: transitionAt, failedLoginCount: 0, lockedUntil: null, refreshTokenHash: null, refreshTokenExpiresAt: null } });
      await auditAuth(request, record.tenantId, record.userId, 'auth.session.revoked', { reason: 'password_reset' }, tx);
      await auditAuth(request, record.tenantId, record.userId, 'auth.password.reset.completed', undefined, tx);
    });
    return reply.send({ status: 'ok', message: 'Your password has been reset. Please sign in.' });
  });

  // Self-service change for a signed-in user. Possession of the current
  // password is the proof, and it is verified before anything is written.
  app.post('/password-change', { preHandler: app.authenticate, ...rateSensitive }, async (request, reply) => {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1).max(200),
      newPassword: z.string().min(1).max(200),
    }).parse(request.body);
    const policyCheck = validatePassword(newPassword);
    if (!policyCheck.ok) throw app.httpErrors.badRequest(policyCheck.message ?? 'Password does not meet policy.');

    const user = await db.user.findFirst({
      where: { id: request.auth.userId, tenantId: request.auth.tenantId, active: true },
      select: { id: true, tenantId: true, passwordHash: true },
    });
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    // A failed confirmation is a bad request, not a 401: the caller's session is
    // valid, and the shared API client answers 401 by refreshing and replaying
    // the request, which would record every attempt twice.
    if (!user.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
      await auditAuth(request, user.tenantId, user.id, 'auth.password.change.failed', { reason: 'invalid_current_password' });
      throw app.httpErrors.badRequest('Password confirmation failed.');
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw app.httpErrors.badRequest('Choose a new password that is different from your current one.');
    }

    const passwordHash = await generatePasswordHash(newPassword);
    await db.$transaction(async tx => {
      await lockUserAuthState(tx, user.tenantId, user.id);
      const transitionAt = new Date();
      // Outstanding reset tokens are older recovery material for this same
      // account and must not survive the password they were issued against.
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: transitionAt } });
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: transitionAt, failedLoginCount: 0, lockedUntil: null, refreshTokenHash: null, refreshTokenExpiresAt: null } });
      await auditAuth(request, user.tenantId, user.id, 'auth.session.revoked', { reason: 'password_changed' }, tx);
      await auditAuth(request, user.tenantId, user.id, 'auth.password.changed', undefined, tx);
    });
    clearAuthCookies(reply);
    return reply.send({ status: 'ok', message: 'Your password has been updated. Please sign in again.' });
  });

  // ===== MFA (TOTP) =======================================================
  // Manual token resolution so these endpoints accept a full session token OR a
  // short-lived login-flow mfa token (setup/challenge).
  async function resolveMfaActor(request: FastifyRequest, reply: FastifyReply): Promise<{ userId: string; tenantId: string; type: 'access' | 'mfa-setup' | 'mfa-challenge' }> {
    const payload = await request.jwtVerify<{ userId: string; tenantId: string; type?: string; iat?: number; sessionIssuedAtMs?: number }>();
    const type = payload.type ?? 'access';
    if (!['access', 'mfa-setup', 'mfa-challenge'].includes(type)) throw app.httpErrors.unauthorized(authErrorMessage);
    if (type === 'access') {
      await app.authenticate(request, reply);
      return { userId: request.auth.userId, tenantId: request.auth.tenantId, type: 'access' };
    }
    const actor = { userId: payload.userId, tenantId: payload.tenantId, type: type as 'mfa-setup' | 'mfa-challenge' };
    enterTenantContext({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorRole: 'MFA_CHALLENGE',
      source: 'request',
      requestId: request.id,
    });
    const issuedAtMs = Number.isFinite(payload.sessionIssuedAtMs)
      ? payload.sessionIssuedAtMs!
      : Number.isFinite(payload.iat) ? payload.iat! * 1000 : 0;
    if (!issuedAtMs) throw app.httpErrors.unauthorized(authErrorMessage);
    const [user, policy, latestRevocation] = await Promise.all([
      db.user.findFirst({
        where: { id: actor.userId, tenantId: actor.tenantId, active: true },
        select: { mfaEnabled: true, tenant: { select: { status: true } } },
      }),
      tenantPolicy(actor.tenantId),
      latestUserSessionRevocation(db, actor.tenantId, actor.userId),
    ]);
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    if (tenantBlocksSessions(user.tenant.status)) throw app.httpErrors.forbidden('suspended_tenant');
    const tenantRevokedAt = policy?.sessionsRevokedAt;
    if ((tenantRevokedAt && issuedAtMs <= tenantRevokedAt.getTime())
      || (latestRevocation && latestRevocation.occurredAt.getTime() >= issuedAtMs)) {
      throw app.httpErrors.unauthorized('Your session is no longer active. Please sign in again.');
    }
    if (actor.type === 'mfa-setup' && (!policy?.requireMfa || user.mfaEnabled)) {
      throw app.httpErrors.unauthorized(authErrorMessage);
    }
    if (actor.type === 'mfa-challenge' && !user.mfaEnabled) {
      throw app.httpErrors.unauthorized(authErrorMessage);
    }
    return actor;
  }

  app.get('/mfa/status', async (request, reply) => {
    const actor = await resolveMfaActor(request, reply);
    const [user, policy] = await Promise.all([
      db.user.findFirst({ where: { id: actor.userId, active: true }, select: { mfaEnabled: true, mfaEnrolledAt: true } }),
      tenantPolicy(actor.tenantId),
    ]);
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    return { enabled: user.mfaEnabled, enrolledAt: user.mfaEnrolledAt?.toISOString() ?? null, requireMfa: policy?.requireMfa ?? false };
  });

  app.post('/mfa/setup', rateSensitive, async (request, reply) => {
    const actor = await resolveMfaActor(request, reply);
    if (!['access', 'mfa-setup'].includes(actor.type)) throw app.httpErrors.unauthorized('A valid session is required to set up MFA.');
    const user = await db.user.findFirst({ where: { id: actor.userId, active: true }, select: { id: true, email: true, mfaEnabled: true } });
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    if (user.mfaEnabled) throw app.httpErrors.conflict('MFA is already enabled. Disable it first to re-enroll.');

    const secret = generateTotpSecret();
    await db.$transaction(async tx => {
      await tx.user.update({ where: { id: user.id }, data: { mfaSecretEnc: encryptSecret(secret), mfaEnabled: false } });
      await auditAuth(request, actor.tenantId, user.id, 'auth.mfa.setup', undefined, tx);
    });
    // Secret + URI are shown once to the user for authenticator enrollment.
    return { secret, otpauthUri: totpAuthUri(secret, user.email), enabled: false };
  });

  app.post('/mfa/verify', rateSensitive, async (request, reply) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(request.body);
    const actor = await resolveMfaActor(request, reply);
    const user = await db.user.findFirst({
      where: { id: actor.userId, active: true },
      include: { tenant: { select: { id: true, name: true, slug: true, status: true } }, branch: { select: { id: true, name: true, location: true } } },
    });
    if (!user || !user.mfaSecretEnc) throw app.httpErrors.badRequest('MFA is not set up for this account.');
    if (tenantBlocksSessions(user.tenant.status)) throw app.httpErrors.forbidden('suspended_tenant');
    const secret = decryptSecret(user.mfaSecretEnc);
    if (!secret || !verifyTotp(secret, code)) {
      await auditAuth(request, actor.tenantId, user.id, 'auth.mfa.verify.failed');
      throw app.httpErrors.unauthorized('Invalid verification code.');
    }

    // First successful verify enables MFA. Any session issuance and all
    // mandatory success evidence commit with that enrollment state.
    const justEnabled = !user.mfaEnabled;
    const completesLogin = actor.type === 'mfa-challenge' || actor.type === 'mfa-setup';
    const enrolledAt = justEnabled ? new Date() : user.mfaEnrolledAt;
    const session = await db.$transaction(async tx => {
      if (justEnabled) {
        await tx.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaEnrolledAt: enrolledAt } });
        await auditAuth(request, actor.tenantId, user.id, 'auth.mfa.enabled', undefined, tx);
      } else {
        await auditAuth(request, actor.tenantId, user.id, 'auth.mfa.verify.success', undefined, tx);
      }
      if (!completesLogin) return null;
      const policy = await tx.tenantSecurityPolicy.findUnique({ where: { tenantId: user.tenantId } });
      const issued = await issueSession(app, user, accessTtlSeconds(policy?.sessionTimeoutMinutes), policy?.sessionsRevokedAt, tx);
      await auditAuth(request, user.tenantId, user.id, 'auth.login.success', { email: user.email, mfa: true }, tx);
      return issued;
    });

    // Login-flow tokens complete the sign-in by issuing a real session.
    if (session) {
      setAuthCookies(reply, session.refreshToken, session.csrfToken);
      const sessionUser = await resolveSessionUser(user.id);
      if (!sessionUser) throw app.httpErrors.unauthorized(authErrorMessage);
      return { status: 'ok', accessToken: session.accessToken, csrfToken: session.csrfToken, user: serializeUser(sessionUser) };
    }
    return { status: 'ok', enabled: true };
  });

  app.post('/mfa/disable', { preHandler: app.authenticate, ...rateSensitive }, async request => {
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
    const user = await db.user.findFirst({ where: { id: request.auth.userId, active: true }, select: { id: true, passwordHash: true } });
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    if (!user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      throw app.httpErrors.unauthorized('Password confirmation failed.');
    }
    await db.$transaction(async tx => {
      await tx.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaEnrolledAt: null } });
      await auditAuth(request, request.auth.tenantId, user.id, 'auth.mfa.disabled', undefined, tx);
    });
    return { status: 'ok', enabled: false };
  });
};
