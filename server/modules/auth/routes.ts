import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import {
  createCsrfToken, createRefreshToken, hashRefreshToken, verifyPassword,
  validatePassword, createResetToken, hashResetToken, generatePasswordHash,
  encryptSecret, decryptSecret,
} from '../../lib/security';
import { generateTotpSecret, verifyTotp, totpAuthUri } from '../../lib/totp';

const loginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1).max(200),
});

const refreshCookieName = 'cc_refresh';
const csrfCookieName = 'cc_csrf';
const refreshCookiePath = '/v1/auth';
const refreshTokenTtlSeconds = 60 * 60 * 24 * 30;
const accessTokenTtl = '15m';
const accessTokenTtlMinutes = 15;
const authErrorMessage = 'Session expired. Please sign in again.';
const csrfErrorMessage = 'Invalid request token';
// Identical generic response for invalid creds AND lockout, so probes cannot
// tell whether an account exists or is locked.
const genericAuthError = 'Invalid credentials or account temporarily unavailable.';

function isProduction() {
  return env.NODE_ENV === 'production';
}

// SameSite policy (env.COOKIE_SAMESITE): 'lax' for same-origin; 'none' for a
// cross-site frontend (e.g. Vercel UI + Render API). 'none' requires Secure.
const sameSiteAttr = `SameSite=${env.COOKIE_SAMESITE.charAt(0).toUpperCase()}${env.COOKIE_SAMESITE.slice(1)}`;
function cookieSecure() { return isProduction() || env.COOKIE_SAMESITE === 'none'; }

function cookieFlags(httpOnly: boolean, maxAgeSeconds: number, value: string) {
  const attributes = [
    `${httpOnly ? refreshCookieName : csrfCookieName}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAgeSeconds}`,
    httpOnly ? 'HttpOnly' : undefined,
    `Path=${refreshCookiePath}`,
    sameSiteAttr,
    cookieSecure() ? 'Secure' : undefined,
  ].filter(Boolean);
  return attributes.join('; ');
}

function setAuthCookies(reply: FastifyReply, refreshToken: string, csrfToken: string) {
  reply.raw.setHeader('Set-Cookie', [
    cookieFlags(true, refreshTokenTtlSeconds, refreshToken),
    cookieFlags(false, refreshTokenTtlSeconds, csrfToken),
  ]);
}

function clearAuthCookies(reply: FastifyReply) {
  reply.raw.setHeader('Set-Cookie', [
    `${refreshCookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=${refreshCookiePath}; ${sameSiteAttr}${cookieSecure() ? '; Secure' : ''}`,
    `${csrfCookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${refreshCookiePath}; ${sameSiteAttr}${cookieSecure() ? '; Secure' : ''}`,
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

async function tenantPolicy(tenantId: string) {
  return db.tenantSecurityPolicy.findUnique({ where: { tenantId } });
}

// Access-token TTL honours the tenant's sessionTimeoutMinutes (clamped), while
// the secure 30-day refresh token is unchanged.
function accessTtlSeconds(sessionTimeoutMinutes?: number | null) {
  const minutes = Math.min(Math.max(sessionTimeoutMinutes ?? accessTokenTtlMinutes, 5), 1440);
  return minutes * 60;
}

function buildSession(app: FastifyInstance, user: SessionUserShape, ttlSeconds: number) {
  return app.jwt.sign(
    { userId: user.id, tenantId: user.tenantId, role: user.role, branchId: user.branchId ?? undefined, type: 'access' },
    { expiresIn: ttlSeconds },
  );
}

async function issueSession(app: FastifyInstance, user: SessionUserShape, ttlSeconds: number) {
  const refreshToken = createRefreshToken();
  const csrfToken = createCsrfToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const refreshTokenExpiresAt = new Date(Date.now() + 1000 * refreshTokenTtlSeconds);
  await db.user.update({
    where: { id: user.id },
    data: { refreshTokenHash, refreshTokenExpiresAt, lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });
  return { accessToken: buildSession(app, user, ttlSeconds), refreshToken, csrfToken };
}

async function resolveSessionUser(userId: string) {
  return db.user.findFirst({
    where: { id: userId, active: true },
    include: { tenant: { select: { id: true, name: true, slug: true } }, branch: { select: { id: true, name: true, location: true } } },
  });
}

function serializeUser(user: NonNullable<Awaited<ReturnType<typeof resolveSessionUser>>>) {
  return {
    id: user.id, email: user.email, displayName: user.displayName, role: user.role,
    branchId: user.branchId, branch: user.branch, tenant: user.tenant, active: user.active,
    mfaEnabled: user.mfaEnabled,
  };
}

async function auditAuth(request: FastifyRequest, tenantId: string, userId: string | null, action: string, metadata?: Record<string, unknown>) {
  await db.auditEvent.create({
    data: {
      tenantId, actorUserId: userId ?? undefined, action, resource: 'session',
      requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      metadata: metadata as never,
    },
  });
}

export const authRoutes: FastifyPluginAsync = async app => {
  const rateLogin = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const rateSensitive = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/dev-token', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (_request, reply) => {
    if (env.NODE_ENV === 'production') return reply.code(404).send({ message: 'Not found' });
    return {
      token: app.jwt.sign({ userId: env.DEV_USER_ID, tenantId: env.DEV_TENANT_ID, role: 'OWNER', type: 'access' }, { expiresIn: accessTokenTtl }),
    };
  });

  // ===== Login (lockout + expiry + MFA gating) =============================
  app.post('/login', rateLogin, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const now = new Date();
    const user = await db.user.findFirst({
      where: { email: input.email, active: true },
      include: { tenant: { select: { id: true, name: true, slug: true } }, branch: { select: { id: true, name: true, location: true } } },
    });
    const policy = user ? await tenantPolicy(user.tenantId) : null;

    // Locked account → generic error (no existence/lock leak), still audited.
    if (user && user.lockedUntil && user.lockedUntil > now) {
      await auditAuth(request, user.tenantId, user.id, 'auth.login.failed', { reason: 'locked' });
      throw app.httpErrors.unauthorized(genericAuthError);
    }

    const passwordOk = Boolean(user && user.passwordHash && await verifyPassword(input.password, user.passwordHash));
    if (!user || !passwordOk) {
      if (user) {
        const lockoutEnabled = policy?.failedLoginLockout ?? false;
        const nextCount = user.failedLoginCount + 1;
        const shouldLock = lockoutEnabled && nextCount >= env.AUTH_LOCKOUT_THRESHOLD;
        await db.user.update({
          where: { id: user.id },
          data: shouldLock
            ? { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + env.AUTH_LOCKOUT_DURATION_MINUTES * 60000) }
            : { failedLoginCount: nextCount },
        });
        await auditAuth(request, user.tenantId, user.id, 'auth.login.failed', { reason: 'invalid-credentials', attempt: nextCount });
        if (shouldLock) await auditAuth(request, user.tenantId, user.id, 'auth.login.lockout', { threshold: env.AUTH_LOCKOUT_THRESHOLD, durationMinutes: env.AUTH_LOCKOUT_DURATION_MINUTES });
      }
      throw app.httpErrors.unauthorized(genericAuthError);
    }

    // Password verified — clear failed counters.
    await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });

    // Platform-controlled suspension blocks tenant login (reactivate via Platform Admin).
    const tenantStatus = await db.tenant.findUnique({ where: { id: user.tenantId }, select: { status: true } });
    if (tenantStatus?.status === 'suspended') {
      await auditAuth(request, user.tenantId, user.id, 'auth.login.failed', { reason: 'suspended_tenant' });
      return reply.code(403).send({ status: 'suspended_tenant', message: 'This account is suspended. Please contact support.' });
    }

    // Password expiry → require reset (no session issued).
    if (policy?.passwordExpiryDays && policy.passwordExpiryDays > 0 && user.passwordChangedAt) {
      const expiresAt = new Date(user.passwordChangedAt.getTime() + policy.passwordExpiryDays * 86400000);
      if (expiresAt < now) {
        await auditAuth(request, user.tenantId, user.id, 'auth.password.expired');
        return reply.send({ status: 'password_expired', message: 'Your password has expired. Please reset it before signing in.' });
      }
    }

    // MFA challenge (user has verified MFA).
    if (user.mfaEnabled) {
      const mfaToken = app.jwt.sign({ userId: user.id, tenantId: user.tenantId, type: 'mfa-challenge' }, { expiresIn: '5m' });
      await auditAuth(request, user.tenantId, user.id, 'auth.login.mfaChallenge');
      return reply.send({ status: 'mfa_required', mfaToken });
    }
    // MFA required by policy but not yet set up.
    if (policy?.requireMfa && !user.mfaEnabled) {
      const mfaToken = app.jwt.sign({ userId: user.id, tenantId: user.tenantId, type: 'mfa-setup' }, { expiresIn: '10m' });
      await auditAuth(request, user.tenantId, user.id, 'auth.login.mfaSetupRequired');
      return reply.send({ status: 'mfa_setup_required', mfaToken });
    }

    const session = await issueSession(app, user, accessTtlSeconds(policy?.sessionTimeoutMinutes));
    setAuthCookies(reply, session.refreshToken, session.csrfToken);
    await auditAuth(request, user.tenantId, user.id, 'auth.login.success', { email: user.email });
    return { accessToken: session.accessToken, user: serializeUser(user) };
  });

  // ===== Refresh / logout / me / session-info =============================
  app.post('/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!verifyCsrf(request)) throw app.httpErrors.unauthorized(csrfErrorMessage);
    const refreshToken = readCookieValue(request, refreshCookieName);
    if (!refreshToken) throw app.httpErrors.unauthorized(authErrorMessage);
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const user = await db.user.findFirst({
      where: { refreshTokenHash, refreshTokenExpiresAt: { gt: new Date() }, active: true },
      include: { tenant: { select: { id: true, name: true, slug: true } }, branch: { select: { id: true, name: true, location: true } } },
    });
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    const policy = await tenantPolicy(user.tenantId);
    const session = await issueSession(app, user, accessTtlSeconds(policy?.sessionTimeoutMinutes));
    setAuthCookies(reply, session.refreshToken, session.csrfToken);
    return { accessToken: session.accessToken, user: serializeUser(user) };
  });

  app.post('/logout', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!verifyCsrf(request)) { clearAuthCookies(reply); return reply.code(204).send(); }
    const refreshToken = readCookieValue(request, refreshCookieName);
    if (refreshToken) {
      await db.user.updateMany({ where: { refreshTokenHash: hashRefreshToken(refreshToken) }, data: { refreshTokenHash: null, refreshTokenExpiresAt: null } });
    }
    if (request.auth?.userId) {
      await auditAuth(request, request.auth.tenantId, request.auth.userId, 'auth.logout', { reason: 'user-initiated' });
    }
    clearAuthCookies(reply);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: app.authenticate }, async request => {
    const user = await resolveSessionUser(request.auth.userId);
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    return { user: serializeUser(user), access: { tenantId: user.tenantId, branchId: user.branchId, role: user.role } };
  });

  app.get('/session-info', { preHandler: app.authenticate }, async request => {
    const policy = await tenantPolicy(request.auth.tenantId);
    return {
      accessTokenTtlMinutes: Math.round(accessTtlSeconds(policy?.sessionTimeoutMinutes) / 60),
      refreshTokenTtlDays: Math.round(refreshTokenTtlSeconds / 86400),
      csrfEnabled: true, cookiePath: refreshCookiePath, sameSite: 'Lax', secure: isProduction(),
      httpOnlyRefreshCookie: true, devTokenEnabled: env.NODE_ENV !== 'production', productionHttpsRequired: isProduction(),
      rbacEnabled: true, auditLoggingEnabled: true,
      accountLockoutEnabled: policy?.failedLoginLockout ?? false,
      requireMfa: policy?.requireMfa ?? false,
    };
  });

  // ===== Password reset ===================================================
  app.post('/password-reset/request', rateSensitive, async request => {
    const { email } = z.object({ email: z.string().email().trim().toLowerCase() }).parse(request.body);
    const user = await db.user.findFirst({ where: { email, active: true } });
    // Always return a generic response (no account-existence leak).
    const generic = { status: 'ok', message: 'If an account exists for that email, a password reset has been initiated.' } as Record<string, unknown>;
    if (!user) return generic;

    const rawToken = createResetToken();
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60000);
    // Invalidate any prior unused tokens for this user, then issue one.
    await db.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await db.passwordResetToken.create({ data: { tenantId: user.tenantId, userId: user.id, tokenHash, expiresAt } });
    await auditAuth(request, user.tenantId, user.id, 'auth.password.reset.requested', { ttlMinutes: env.PASSWORD_RESET_TTL_MINUTES });

    // No email provider is integrated. In non-production we return the token so
    // the flow is testable; in production the raw token is NEVER exposed.
    if (!isProduction()) {
      request.log.info({ userId: user.id }, 'password reset token issued (dev-only echo)');
      return { ...generic, devToken: rawToken, emailDelivered: false, note: 'Dev mode: token returned for testing only. No email provider integrated.' };
    }
    return generic;
  });

  app.post('/password-reset/confirm', rateSensitive, async (request, reply) => {
    const { token, newPassword } = z.object({ token: z.string().min(10).max(200), newPassword: z.string().min(1).max(200) }).parse(request.body);
    const policyCheck = validatePassword(newPassword);
    if (!policyCheck.ok) throw app.httpErrors.badRequest(policyCheck.message ?? 'Password does not meet policy.');

    const record = await db.passwordResetToken.findFirst({ where: { tokenHash: hashResetToken(token), usedAt: null, expiresAt: { gt: new Date() } } });
    if (!record) throw app.httpErrors.badRequest('This reset link is invalid or has expired.');

    const passwordHash = await generatePasswordHash(newPassword);
    await db.$transaction([
      db.user.update({ where: { id: record.userId }, data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, refreshTokenHash: null, refreshTokenExpiresAt: null } }),
      db.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    await auditAuth(request, record.tenantId, record.userId, 'auth.password.reset.completed');
    return reply.send({ status: 'ok', message: 'Your password has been reset. Please sign in.' });
  });

  // ===== MFA (TOTP) =======================================================
  // Manual token resolution so these endpoints accept a full session token OR a
  // short-lived login-flow mfa token (setup/challenge).
  async function resolveMfaActor(request: FastifyRequest): Promise<{ userId: string; tenantId: string; type: string }> {
    const payload = await request.jwtVerify<{ userId: string; tenantId: string; type?: string }>();
    return { userId: payload.userId, tenantId: payload.tenantId, type: payload.type ?? 'access' };
  }

  app.get('/mfa/status', async request => {
    const actor = await resolveMfaActor(request);
    const [user, policy] = await Promise.all([
      db.user.findFirst({ where: { id: actor.userId, active: true }, select: { mfaEnabled: true, mfaEnrolledAt: true } }),
      tenantPolicy(actor.tenantId),
    ]);
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    return { enabled: user.mfaEnabled, enrolledAt: user.mfaEnrolledAt?.toISOString() ?? null, requireMfa: policy?.requireMfa ?? false };
  });

  app.post('/mfa/setup', rateSensitive, async request => {
    const actor = await resolveMfaActor(request);
    if (!['access', 'mfa-setup'].includes(actor.type)) throw app.httpErrors.unauthorized('A valid session is required to set up MFA.');
    const user = await db.user.findFirst({ where: { id: actor.userId, active: true }, select: { id: true, email: true, mfaEnabled: true } });
    if (!user) throw app.httpErrors.unauthorized(authErrorMessage);
    if (user.mfaEnabled) throw app.httpErrors.conflict('MFA is already enabled. Disable it first to re-enroll.');

    const secret = generateTotpSecret();
    await db.user.update({ where: { id: user.id }, data: { mfaSecretEnc: encryptSecret(secret), mfaEnabled: false } });
    await auditAuth(request, actor.tenantId, user.id, 'auth.mfa.setup');
    // Secret + URI are shown once to the user for authenticator enrollment.
    return { secret, otpauthUri: totpAuthUri(secret, user.email), enabled: false };
  });

  app.post('/mfa/verify', rateSensitive, async (request, reply) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(request.body);
    const actor = await resolveMfaActor(request);
    const user = await db.user.findFirst({
      where: { id: actor.userId, active: true },
      include: { tenant: { select: { id: true, name: true, slug: true } }, branch: { select: { id: true, name: true, location: true } } },
    });
    if (!user || !user.mfaSecretEnc) throw app.httpErrors.badRequest('MFA is not set up for this account.');
    const secret = decryptSecret(user.mfaSecretEnc);
    if (!secret || !verifyTotp(secret, code)) {
      await auditAuth(request, actor.tenantId, user.id, 'auth.mfa.verify.failed');
      throw app.httpErrors.unauthorized('Invalid verification code.');
    }

    // First successful verify enables MFA.
    const justEnabled = !user.mfaEnabled;
    if (justEnabled) {
      await db.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaEnrolledAt: new Date() } });
      await auditAuth(request, actor.tenantId, user.id, 'auth.mfa.enabled');
    } else {
      await auditAuth(request, actor.tenantId, user.id, 'auth.mfa.verify.success');
    }

    // Login-flow tokens complete the sign-in by issuing a real session.
    if (actor.type === 'mfa-challenge' || actor.type === 'mfa-setup') {
      const policy = await tenantPolicy(user.tenantId);
      const session = await issueSession(app, user, accessTtlSeconds(policy?.sessionTimeoutMinutes));
      setAuthCookies(reply, session.refreshToken, session.csrfToken);
      await auditAuth(request, user.tenantId, user.id, 'auth.login.success', { email: user.email, mfa: true });
      return { status: 'ok', accessToken: session.accessToken, user: serializeUser(user) };
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
    await db.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaEnrolledAt: null } });
    await auditAuth(request, request.auth.tenantId, user.id, 'auth.mfa.disabled');
    return { status: 'ok', enabled: false };
  });
};
