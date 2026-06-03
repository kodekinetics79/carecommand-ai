import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { createCsrfToken, createRefreshToken, hashRefreshToken, verifyPassword } from '../../lib/security';

const loginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(8).max(200),
});

const refreshCookieName = 'cc_refresh';
const csrfCookieName = 'cc_csrf';
const refreshCookiePath = '/v1/auth';
const refreshTokenTtlSeconds = 60 * 60 * 24 * 30;
const accessTokenTtl = '15m';
const accessTokenTtlMinutes = 15;
const authErrorMessage = 'Session expired. Please sign in again.';
const loginErrorMessage = 'Invalid credentials';
const csrfErrorMessage = 'Invalid request token';

function isProduction() {
  return env.NODE_ENV === 'production';
}

function cookieFlags(httpOnly: boolean, maxAgeSeconds: number, value: string) {
  const attributes = [
    `${httpOnly ? refreshCookieName : csrfCookieName}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAgeSeconds}`,
    httpOnly ? 'HttpOnly' : undefined,
    `Path=${refreshCookiePath}`,
    'SameSite=Lax',
    isProduction() ? 'Secure' : undefined,
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
    `${refreshCookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=${refreshCookiePath}; SameSite=Lax${isProduction() ? '; Secure' : ''}`,
    `${csrfCookieName}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${refreshCookiePath}; SameSite=Lax${isProduction() ? '; Secure' : ''}`,
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
  if (!cookieToken || !headerToken) {
    return false;
  }
  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(headerToken);
  if (cookieBuffer.length !== headerBuffer.length) return false;
  return timingSafeEqual(cookieBuffer, headerBuffer);
}

function buildSession(app: FastifyInstance, user: {
  id: string;
  tenantId: string;
  role: string;
  branchId: string | null;
}) {
  return app.jwt.sign({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    branchId: user.branchId ?? undefined,
    type: 'access',
  }, { expiresIn: accessTokenTtl });
}

async function issueSession(app: FastifyInstance, user: {
  id: string;
  tenantId: string;
  role: string;
  branchId: string | null;
}) {
  const refreshToken = createRefreshToken();
  const csrfToken = createCsrfToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const refreshTokenExpiresAt = new Date(Date.now() + 1000 * refreshTokenTtlSeconds);

  await db.user.update({
    where: { id: user.id },
    data: {
      refreshTokenHash,
      refreshTokenExpiresAt,
      lastLoginAt: new Date(),
    },
  });

  return {
    accessToken: buildSession(app, user),
    refreshToken,
    csrfToken,
  };
}

async function resolveSessionUser(userId: string) {
  return db.user.findFirst({
    where: { id: userId, active: true },
    include: {
      tenant: { select: { id: true, name: true, slug: true } },
      branch: { select: { id: true, name: true, location: true } },
    },
  });
}

function serializeUser(user: NonNullable<Awaited<ReturnType<typeof resolveSessionUser>>>) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    branchId: user.branchId,
    branch: user.branch,
    tenant: user.tenant,
    active: user.active,
  };
}

export const authRoutes: FastifyPluginAsync = async app => {
  app.post('/dev-token', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (_request, reply) => {
    if (env.NODE_ENV === 'production') {
      return reply.code(404).send({ message: 'Not found' });
    }

    return {
      token: app.jwt.sign({
        userId: env.DEV_USER_ID,
        tenantId: env.DEV_TENANT_ID,
        role: 'OWNER',
        type: 'access',
      }, { expiresIn: accessTokenTtl }),
    };
  });

  app.post('/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await db.user.findFirst({
      where: { email: input.email, active: true },
      include: {
        tenant: { select: { id: true, name: true, slug: true } },
        branch: { select: { id: true, name: true, location: true } },
      },
    });
    if (!user || !user.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
      if (user) {
        await db.auditEvent.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: user.id,
            action: 'auth.login.failed',
            resource: 'session',
            requestId: request.id,
            ipAddress: request.ip,
            userAgent: request.headers['user-agent'],
            metadata: { email: input.email, reason: 'invalid-credentials' },
          },
        });
      }
      throw app.httpErrors.unauthorized(loginErrorMessage);
    }

    const session = await issueSession(app, user);
    setAuthCookies(reply, session.refreshToken, session.csrfToken);
    await db.auditEvent.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: 'auth.login.success',
        resource: 'session',
        requestId: request.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { email: user.email },
      },
    });
    return {
      accessToken: session.accessToken,
      user: serializeUser(user),
    };
  });

  app.post('/refresh', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    if (!verifyCsrf(request)) {
      throw app.httpErrors.unauthorized(csrfErrorMessage);
    }
    const refreshToken = readCookieValue(request, refreshCookieName);
    if (!refreshToken) {
      throw app.httpErrors.unauthorized(authErrorMessage);
    }
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const user = await db.user.findFirst({
      where: {
        refreshTokenHash,
        refreshTokenExpiresAt: { gt: new Date() },
        active: true,
      },
      include: {
        tenant: { select: { id: true, name: true, slug: true } },
        branch: { select: { id: true, name: true, location: true } },
      },
    });
    if (!user) {
      throw app.httpErrors.unauthorized(authErrorMessage);
    }

    const session = await issueSession(app, user);
    setAuthCookies(reply, session.refreshToken, session.csrfToken);
    return {
      accessToken: session.accessToken,
      user: serializeUser(user),
    };
  });

  app.post('/logout', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    if (!verifyCsrf(request)) {
      clearAuthCookies(reply);
      return reply.code(204).send();
    }
    const refreshToken = readCookieValue(request, refreshCookieName);
    if (refreshToken) {
      const refreshTokenHash = hashRefreshToken(refreshToken);
      await db.user.updateMany({
        where: { refreshTokenHash },
        data: {
          refreshTokenHash: null,
          refreshTokenExpiresAt: null,
        },
      });
    }
    if (request.auth?.userId) {
      await db.auditEvent.create({
        data: {
          tenantId: request.auth.tenantId,
          actorUserId: request.auth.userId,
          action: 'auth.logout',
          resource: 'session',
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { reason: 'user-initiated' },
        },
      });
    }
    clearAuthCookies(reply);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: app.authenticate }, async request => {
    const user = await resolveSessionUser(request.auth.userId);
    if (!user) {
      throw app.httpErrors.unauthorized(authErrorMessage);
    }
    return {
      user: serializeUser(user),
      access: {
        tenantId: user.tenantId,
        branchId: user.branchId,
        role: user.role,
      },
    };
  });

  app.get('/session-info', { preHandler: app.authenticate }, async () => ({
    accessTokenTtlMinutes,
    refreshTokenTtlDays: Math.round(refreshTokenTtlSeconds / 86400),
    csrfEnabled: true,
    cookiePath: refreshCookiePath,
    sameSite: 'Lax',
    secure: isProduction(),
    httpOnlyRefreshCookie: true,
    devTokenEnabled: env.NODE_ENV !== 'production',
    productionHttpsRequired: isProduction(),
    rbacEnabled: true,
    auditLoggingEnabled: true,
  }));
};
