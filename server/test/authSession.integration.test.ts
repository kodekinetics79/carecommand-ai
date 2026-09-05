import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { generatePasswordHash, hashRefreshToken } = await import('../lib/security');
const { env } = await import('../config/env');
const { TENANT_LOGIN_DUMMY_HASH, verifyTenantLoginPassword } = await import('../modules/auth/routes');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeLoginUser(options: { email?: string; password?: string; status?: string; role?: 'ADMIN' | 'PROVIDER' | 'FRONT_DESK' | 'MANAGER' } = {}) {
  const id = randomUUID();
  const slug = `auth-${id.slice(0, 8)}`;
  await db.tenant.create({ data: { id, name: `Auth ${id.slice(0, 6)}`, slug, status: options.status ?? 'active' } });
  createdTenantIds.push(id);
  const email = options.email ?? `user-${id.slice(0, 8)}@auth.test`;
  const password = options.password ?? 'CorrectHorseBattery9!';
  const user = await db.user.create({
    data: {
      tenantId: id,
      email,
      displayName: 'Auth User',
      role: options.role ?? 'ADMIN',
      passwordHash: await generatePasswordHash(password),
      passwordChangedAt: new Date(),
    },
  });
  return { tenantId: id, slug, email, password, userId: user.id };
}

function setCookieHeaders(response: { headers: Record<string, string | string[] | number | undefined> }) {
  const value = response.headers['set-cookie'];
  if (!value) return [];
  return Array.isArray(value) ? value : [String(value)];
}

function cookieValue(headers: string[], name: string) {
  const header = headers.find(value => value.startsWith(`${name}=`));
  return header?.match(new RegExp(`^${name}=([^;]+)`))?.[1] ?? null;
}

function cookieHeader(refresh: string, csrf: string) {
  return `cc_refresh=${refresh}; cc_csrf=${csrf}`;
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('tenant authentication session lifecycle', () => {
  it('fails closed when an operational account has no clinic assignment', async () => {
    const account = await makeLoginUser({ role: 'PROVIDER' });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: account.email, password: account.password } });
    expect(login.statusCode).toBe(403);
    expect(login.json().status).toBe('clinic_assignment_required');
    expect((await db.user.findUniqueOrThrow({ where: { id: account.userId } })).refreshTokenHash).toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: account.tenantId, actorUserId: account.userId, action: 'auth.login.denied' } })).toBe(1);

    const forged = app.jwt.sign({ userId: account.userId, tenantId: account.tenantId, role: 'PROVIDER', type: 'access', sessionIssuedAtMs: Date.now() });
    const protectedResponse = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${forged}` } });
    expect(protectedResponse.statusCode).toBe(403);
  });

  it('performs fixed-cost password verification for an unknown tenant identity', async () => {
    const verifier = vi.fn(async () => false);
    await expect(verifyTenantLoginPassword('unknown-password', undefined, verifier)).resolves.toBe(false);
    expect(verifier).toHaveBeenCalledExactlyOnceWith('unknown-password', TENANT_LOGIN_DUMMY_HASH);
  });

  it('serializes concurrent failed-login accounting and locks at the exact threshold', async () => {
    const account = await makeLoginUser();
    await db.tenantSecurityPolicy.upsert({
      where: { tenantId: account.tenantId },
      update: { failedLoginLockout: true },
      create: { tenantId: account.tenantId, failedLoginLockout: true },
    });

    const attempts = await Promise.all(Array.from({ length: env.AUTH_LOCKOUT_THRESHOLD }, (_, index) => app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': `198.51.100.${index + 10}` },
      payload: { email: account.email, password: 'Concurrent-Wrong-Password-2026!' },
    })));
    expect(attempts.every(response => response.statusCode === 401)).toBe(true);
    const locked = await db.user.findUniqueOrThrow({ where: { id: account.userId } });
    expect(locked.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(locked.failedLoginCount).toBe(0);
    expect(await db.auditEvent.count({
      where: { tenantId: account.tenantId, actorUserId: account.userId, action: 'auth.login.failed' },
    })).toBe(env.AUTH_LOCKOUT_THRESHOLD);
    expect(await db.auditEvent.count({
      where: { tenantId: account.tenantId, actorUserId: account.userId, action: 'auth.login.lockout' },
    })).toBe(1);
  });

  it('atomically consumes one reset token and immediately revokes the prior access session', async () => {
    const account = await makeLoginUser();
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: account.email, password: account.password } });
    expect(login.statusCode).toBe(200);
    const oldAuthorization = { authorization: `Bearer ${login.json().accessToken as string}` };
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: oldAuthorization })).statusCode).toBe(200);

    const requested = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: account.email } });
    const resetToken = requested.json().devToken as string;
    expect(resetToken).toBeTruthy();
    const confirmations = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token: resetToken, newPassword: 'Concurrent-Replacement-One-2026!' } }),
      app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token: resetToken, newPassword: 'Concurrent-Replacement-Two-2026!' } }),
    ]);
    expect(confirmations.map(response => response.statusCode).sort()).toEqual([200, 400]);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: oldAuthorization })).statusCode).toBe(401);
    expect(await db.passwordResetToken.count({ where: { userId: account.userId, usedAt: { not: null } } })).toBe(1);
    expect(await db.auditEvent.count({
      where: { tenantId: account.tenantId, actorUserId: account.userId, action: 'auth.session.revoked', resourceId: account.userId },
    })).toBe(1);
    expect(await db.auditEvent.count({
      where: { tenantId: account.tenantId, actorUserId: account.userId, action: 'auth.password.reset.completed' },
    })).toBe(1);
  });

  it('rejects revoked access and MFA-flow tokens at MFA enrollment boundaries', async () => {
    const accessAccount = await makeLoginUser();
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: accessAccount.email, password: accessAccount.password } });
    const authorization = { authorization: `Bearer ${login.json().accessToken as string}` };
    expect((await app.inject({ method: 'POST', url: `/v1/security/sessions/${accessAccount.userId}/revoke`, headers: authorization })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: authorization })).statusCode).toBe(401);

    const flowAccount = await makeLoginUser();
    await db.tenantSecurityPolicy.upsert({
      where: { tenantId: flowAccount.tenantId },
      update: { requireMfa: true },
      create: { tenantId: flowAccount.tenantId, requireMfa: true },
    });
    const flowLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: flowAccount.email, password: flowAccount.password } });
    expect(flowLogin.json().status).toBe('mfa_setup_required');
    const resetRequest = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: flowAccount.email } });
    expect((await app.inject({
      method: 'POST', url: '/v1/auth/password-reset/confirm',
      payload: { token: resetRequest.json().devToken as string, newPassword: 'Mfa-Flow-Replacement-2026!' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/v1/auth/mfa/setup',
      headers: { authorization: `Bearer ${flowLogin.json().mfaToken as string}` },
    })).statusCode).toBe(401);
  });

  it('invalidates a selected access token immediately and permits a fresh login after revocation', async () => {
    const account = await makeLoginUser();
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: account.email, password: account.password } });
    expect(login.statusCode).toBe(200);
    const token = login.json().accessToken as string;
    const headers = { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.51.100.210' };
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers })).statusCode).toBe(200);
    const revoked = await app.inject({ method: 'PATCH', url: `/v1/control-plane/sessions/${account.userId}/revoke`, headers });
    expect(revoked.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers })).statusCode).toBe(401);

    const fresh = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: account.email, password: account.password } });
    expect(fresh.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${fresh.json().accessToken as string}` } })).statusCode).toBe(200);
    expect(await db.auditEvent.count({ where: { tenantId: account.tenantId, action: 'controlPlane.session.revoked', resourceId: account.userId } })).toBe(1);
  });

  it('invalidates an access token through the tenant Security-page revocation endpoint', async () => {
    const account = await makeLoginUser();
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: account.email, password: account.password } });
    expect(login.statusCode).toBe(200);
    const headers = {
      authorization: `Bearer ${login.json().accessToken as string}`,
      'x-forwarded-for': '198.51.100.211',
    };

    const revoked = await app.inject({
      method: 'POST',
      url: `/v1/security/sessions/${account.userId}/revoke`,
      headers,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers })).statusCode).toBe(401);
    expect(await db.auditEvent.count({
      where: { tenantId: account.tenantId, action: 'auth.session.revoked', resourceId: account.userId },
    })).toBe(1);
  });

  it('sets correctly scoped cookies, rotates refresh+CSRF tokens, and revokes them on logout', async () => {
    const account = await makeLoginUser();
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: account.email, password: account.password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().csrfToken).toBeTruthy();

    const loginCookies = setCookieHeaders(login);
    const firstRefresh = cookieValue(loginCookies, 'cc_refresh');
    const firstCsrf = cookieValue(loginCookies, 'cc_csrf');
    expect(firstRefresh).toBeTruthy();
    expect(firstCsrf).toBeTruthy();
    expect(login.json().csrfToken).toBe(firstCsrf);
    expect(loginCookies.find(value => value.startsWith('cc_refresh='))).toContain('HttpOnly');
    expect(loginCookies.find(value => value.startsWith('cc_refresh='))).toContain('Path=/v1/auth');
    expect(loginCookies.find(value => value.startsWith('cc_csrf='))).not.toContain('HttpOnly');
    expect(loginCookies.find(value => value.startsWith('cc_csrf='))).toContain('Path=/');

    const refresh = await app.inject({
      method: 'POST', url: '/v1/auth/refresh',
      headers: { cookie: cookieHeader(firstRefresh!, firstCsrf!), 'x-csrf-token': firstCsrf! },
    });
    expect(refresh.statusCode).toBe(200);
    const rotatedCookies = setCookieHeaders(refresh);
    const rotatedRefresh = cookieValue(rotatedCookies, 'cc_refresh');
    const rotatedCsrf = cookieValue(rotatedCookies, 'cc_csrf');
    expect(rotatedRefresh).toBeTruthy();
    expect(rotatedCsrf).toBeTruthy();
    expect(refresh.json().csrfToken).toBe(rotatedCsrf);
    expect(rotatedRefresh).not.toBe(firstRefresh);
    expect(rotatedCsrf).not.toBe(firstCsrf);

    const replay = await app.inject({
      method: 'POST', url: '/v1/auth/refresh',
      headers: { cookie: cookieHeader(firstRefresh!, firstCsrf!), 'x-csrf-token': firstCsrf! },
    });
    expect(replay.statusCode).toBe(401);

    const logout = await app.inject({
      method: 'POST', url: '/v1/auth/logout',
      headers: { cookie: cookieHeader(rotatedRefresh!, rotatedCsrf!), 'x-csrf-token': rotatedCsrf! },
    });
    expect(logout.statusCode).toBe(204);
    const cleared = setCookieHeaders(logout);
    expect(cleared.find(value => value.startsWith('cc_refresh='))).toContain('Max-Age=0');
    expect(cleared.find(value => value.startsWith('cc_refresh='))).toContain('Path=/v1/auth');
    expect(cleared.find(value => value.startsWith('cc_csrf='))).toContain('Max-Age=0');
    expect(cleared.find(value => value.startsWith('cc_csrf='))).toContain('Path=/');

    const stored = await db.user.findUnique({ where: { id: account.userId }, select: { refreshTokenHash: true, refreshTokenExpiresAt: true } });
    expect(stored?.refreshTokenHash).toBeNull();
    expect(stored?.refreshTokenExpiresAt).toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: account.tenantId, actorUserId: account.userId, action: 'auth.logout' } })).toBe(1);
  });

  it('fails access and refresh closed when tenant policy starts requiring MFA', async () => {
    const account = await makeLoginUser();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: account.email, password: account.password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = setCookieHeaders(login);
    const refreshToken = cookieValue(cookies, 'cc_refresh')!;
    const csrfToken = cookieValue(cookies, 'cc_csrf')!;

    await db.tenantSecurityPolicy.upsert({
      where: { tenantId: account.tenantId },
      update: { requireMfa: true },
      create: { tenantId: account.tenantId, requireMfa: true },
    });

    const access = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${login.json().accessToken as string}` },
    });
    expect(access.statusCode).toBe(401);

    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie: cookieHeader(refreshToken, csrfToken), 'x-csrf-token': csrfToken },
    });
    expect(refresh.statusCode).toBe(403);
    expect(refresh.json().status).toBe('mfa_reauthentication_required');
    expect((await db.user.findUnique({ where: { id: account.userId }, select: { refreshTokenHash: true } }))?.refreshTokenHash).toBeNull();
  });

  it('supports a separate-origin SPA with API-returned in-memory CSRF values, including reload bootstrap', async () => {
    const account = await makeLoginUser();
    const spaOrigin = 'http://localhost:12000';
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login', headers: { origin: spaOrigin },
      payload: { email: account.email, password: account.password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['access-control-allow-origin']).toBe(spaOrigin);
    expect(login.headers['access-control-allow-credentials']).toBe('true');
    const loginCookies = setCookieHeaders(login);
    const firstRefresh = cookieValue(loginCookies, 'cc_refresh')!;
    const firstCsrfCookie = cookieValue(loginCookies, 'cc_csrf')!;
    const firstCsrfMemory = login.json().csrfToken as string;
    expect(firstCsrfMemory).toBe(firstCsrfCookie);

    const refresh = await app.inject({
      method: 'POST', url: '/v1/auth/refresh', headers: {
        origin: spaOrigin,
        cookie: cookieHeader(firstRefresh, firstCsrfCookie),
        'x-csrf-token': firstCsrfMemory,
      },
    });
    expect(refresh.statusCode).toBe(200);
    const rotatedCookies = setCookieHeaders(refresh);
    const rotatedRefresh = cookieValue(rotatedCookies, 'cc_refresh')!;

    // Simulate a page reload: JavaScript memory is gone and the SPA cannot
    // inspect an API-domain cookie. The allowlisted API returns a fresh value
    // while setting its matching cookie, without exposing the refresh token.
    const bootstrap = await app.inject({
      method: 'GET', url: '/v1/auth/csrf', headers: { origin: spaOrigin, cookie: `cc_refresh=${rotatedRefresh}` },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.headers['access-control-allow-origin']).toBe(spaOrigin);
    expect(bootstrap.body).not.toContain(rotatedRefresh);
    const bootCsrf = bootstrap.json().csrfToken as string;
    const bootCookie = cookieValue(setCookieHeaders(bootstrap), 'cc_csrf')!;
    expect(bootCsrf).toBe(bootCookie);

    const logout = await app.inject({
      method: 'POST', url: '/v1/auth/logout', headers: {
        origin: spaOrigin,
        cookie: cookieHeader(rotatedRefresh, bootCookie),
        'x-csrf-token': bootCsrf,
      },
    });
    expect(logout.statusCode).toBe(204);
    expect((await db.user.findUnique({ where: { id: account.userId }, select: { refreshTokenHash: true } }))?.refreshTokenHash).toBeNull();
  });

  it('does not reveal duplicate workspace membership without a valid password, then requires a tenant slug', async () => {
    const email = `duplicate-${randomUUID()}@auth.test`;
    const password = 'SharedValidPassword9!';
    const [a, b] = await Promise.all([
      makeLoginUser({ email, password }),
      makeLoginUser({ email, password }),
    ]);

    const invalid = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'NotThePassword9!' } });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().status).not.toBe('tenant_required');

    const ambiguous = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().status).toBe('tenant_required');
    expect(ambiguous.body).not.toContain(a.slug);
    expect(ambiguous.body).not.toContain(b.slug);

    const selected = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password, tenantSlug: b.slug } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().user.tenant.id).toBe(b.tenantId);
  });

  it.each(['suspended', 'archived'])('blocks %s tenants on login and refresh, revoking the stored refresh token', async status => {
    const loginBlocked = await makeLoginUser({ status });
    const deniedLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: loginBlocked.email, password: loginBlocked.password } });
    expect(deniedLogin.statusCode).toBe(403);

    const active = await makeLoginUser();
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: active.email, password: active.password } });
    const cookies = setCookieHeaders(login);
    const refreshToken = cookieValue(cookies, 'cc_refresh')!;
    const csrfToken = cookieValue(cookies, 'cc_csrf')!;
    expect((await db.user.findUnique({ where: { id: active.userId } }))?.refreshTokenHash).toBe(hashRefreshToken(refreshToken));

    await db.tenant.update({ where: { id: active.tenantId }, data: { status } });
    const deniedRefresh = await app.inject({
      method: 'POST', url: '/v1/auth/refresh',
      headers: { cookie: cookieHeader(refreshToken, csrfToken), 'x-csrf-token': csrfToken },
    });
    expect(deniedRefresh.statusCode).toBe(403);
    expect((await db.user.findUnique({ where: { id: active.userId } }))?.refreshTokenHash).toBeNull();
    expect(setCookieHeaders(deniedRefresh).find(value => value.startsWith('cc_csrf='))).toContain('Path=/');
  });
});
