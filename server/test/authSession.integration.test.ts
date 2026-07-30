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

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeLoginUser(options: { email?: string; password?: string; status?: string } = {}) {
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
      role: 'ADMIN',
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
