import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const { platformDb } = await import('../lib/platformDb');
const { encryptSecret, generatePasswordHash } = await import('../lib/security');
const { generateTotp, generateTotpSecret } = await import('../lib/totp');
const { hashV, signPlatformToken, platformSessionIdHash } = await import('../lib/platformAuth');
const {
  PLATFORM_AUTH_RATE_LIMIT,
  PLATFORM_LOGIN_DUMMY_HASH,
  verifyPlatformLoginPassword,
} = await import('../modules/platform/auth');
const { assertProductionRateLimitStore, skipRateLimitStoreErrors } = await import('../lib/rateLimitPolicy');

let app: FastifyInstance;
const userIds: string[] = [];

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  if (userIds.length) await platformDb.platformUser.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await app?.close();
  await platformDb.$disconnect();
});

async function platformUser(input: { email: string; password: string; status?: string; failedLoginCount?: number; lockedUntil?: Date | null; mfaEnabled?: boolean; mfaSecretEnc?: string }) {
  const row = await platformDb.platformUser.create({
    data: {
      email: input.email,
      name: 'Platform auth hardening fixture',
      passwordHash: await generatePasswordHash(input.password),
      role: 'PLATFORM_ADMIN',
      status: input.status ?? 'active',
      failedLoginCount: input.failedLoginCount ?? 0,
      lockedUntil: input.lockedUntil,
      mfaEnabled: input.mfaEnabled ?? false,
      mfaSecretEnc: input.mfaSecretEnc,
    },
  });
  userIds.push(row.id);
  return row;
}

describe('platform authentication enumeration resistance', () => {
  it('revokes only the invoking high-privilege JWT even when two sessions are issued in the same millisecond', async () => {
    const suffix = randomUUID();
    const user = await platformUser({ email: `logout-${suffix}@platform.test`, password: 'Correct-Logout-Password!' });
    const frozenNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(frozenNow);
    const tokenA = signPlatformToken(app, user);
    const tokenB = signPlatformToken(app, user);
    now.mockRestore();
    expect(tokenA).not.toBe(tokenB);
    const headersA = { authorization: `Bearer ${tokenA}`, 'x-forwarded-for': '203.0.113.120' };
    const headersB = { authorization: `Bearer ${tokenB}`, 'x-forwarded-for': '203.0.113.121' };
    expect((await app.inject({ method: 'GET', url: '/v1/platform/auth/me', headers: headersA })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/auth/me', headers: headersB })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/auth/logout', headers: headersA })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/auth/me', headers: headersA })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/auth/me', headers: headersB })).statusCode).toBe(200);
    expect(await platformDb.platformAuditEvent.count({ where: { platformUserId: user.id, action: 'platform.logout', targetId: user.id } })).toBe(1);
    const receipt = await platformDb.platformAuditEvent.findFirstOrThrow({ where: { platformUserId: user.id, action: 'platform.logout', targetId: user.id } });
    const payloadA = app.jwt.decode<{ sessionId: string }>(tokenA);
    if (!payloadA) throw new Error('synthetic platform token did not decode');
    expect(receipt.metadata).toEqual({ sessionIdHash: platformSessionIdHash(payloadA.sessionId) });
    expect(JSON.stringify(receipt.metadata)).not.toContain(payloadA.sessionId);
  });

  it('always invokes one verifier with valid scrypt work, including the unknown-account path', async () => {
    const verifier = vi.fn(async () => false);
    await expect(verifyPlatformLoginPassword('submitted-password', undefined, verifier)).resolves.toBe(false);
    expect(verifier).toHaveBeenCalledOnce();
    expect(verifier).toHaveBeenCalledWith('submitted-password', PLATFORM_LOGIN_DUMMY_HASH);
    expect(PLATFORM_LOGIN_DUMMY_HASH).toMatch(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    await expect(verifyPlatformLoginPassword('arbitrary-unknown-account-password', undefined)).resolves.toBe(false);

    verifier.mockClear();
    await expect(verifyPlatformLoginPassword('submitted-password', 'scrypt$stored$hash', verifier)).resolves.toBe(false);
    expect(verifier).toHaveBeenCalledOnce();
    expect(verifier).toHaveBeenCalledWith('submitted-password', 'scrypt$stored$hash');
  });

  it('returns one generic response for unknown, inactive, locked, and wrong-password accounts without mutating locked/inactive state', async () => {
    const suffix = randomUUID();
    const inactive = await platformUser({ email: `inactive-${suffix}@platform.test`, password: 'Correct-Inactive-Password!', status: 'inactive', failedLoginCount: 2 });
    const lockedUntil = new Date(Date.now() + 15 * 60_000);
    const locked = await platformUser({ email: `locked-${suffix}@platform.test`, password: 'Correct-Locked-Password!', failedLoginCount: 3, lockedUntil });
    const wrong = await platformUser({ email: `wrong-${suffix}@platform.test`, password: 'Correct-Active-Password!' });
    const startedAt = new Date();

    const attempts = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: { 'x-forwarded-for': '203.0.113.101', 'user-agent': `platform-auth-unknown-${suffix}` }, payload: { email: `unknown-${suffix}@platform.test`, password: 'Submitted-Password!' } }),
      app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: { 'x-forwarded-for': '203.0.113.102', 'user-agent': `platform-auth-inactive-${suffix}` }, payload: { email: inactive.email, password: 'Correct-Inactive-Password!' } }),
      app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: { 'x-forwarded-for': '203.0.113.103', 'user-agent': `platform-auth-locked-${suffix}` }, payload: { email: locked.email, password: 'Correct-Locked-Password!' } }),
      app.inject({ method: 'POST', url: '/v1/platform/auth/login', headers: { 'x-forwarded-for': '203.0.113.104', 'user-agent': `platform-auth-wrong-${suffix}` }, payload: { email: wrong.email, password: 'Submitted-Password!' } }),
    ]);

    const expected = { error: 'invalid_credentials', message: 'Invalid email or password.' };
    for (const response of attempts) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(expected);
    }

    const [inactiveAfter, lockedAfter, wrongAfter] = await Promise.all([
      platformDb.platformUser.findUniqueOrThrow({ where: { id: inactive.id } }),
      platformDb.platformUser.findUniqueOrThrow({ where: { id: locked.id } }),
      platformDb.platformUser.findUniqueOrThrow({ where: { id: wrong.id } }),
    ]);
    expect(inactiveAfter).toMatchObject({ failedLoginCount: 2, lockedUntil: null, lastLoginAt: null });
    expect(lockedAfter.failedLoginCount).toBe(3);
    expect(lockedAfter.lockedUntil?.toISOString()).toBe(lockedUntil.toISOString());
    expect(lockedAfter.lastLoginAt).toBeNull();
    expect(wrongAfter.failedLoginCount).toBe(1);
    expect(wrongAfter.lastLoginAt).toBeNull();

    const auditRows = await platformDb.platformAuditEvent.findMany({
      where: { action: 'platform.login.failed', createdAt: { gte: startedAt } },
      select: { platformUserId: true, targetId: true, ipHash: true, userAgentHash: true, metadata: true },
    });
    const reasons = auditRows.flatMap(row => {
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : null;
      return typeof metadata?.reason === 'string' ? [metadata.reason] : [];
    });
    expect(reasons).toEqual(expect.arrayContaining(['unknown_account', 'inactive', 'locked', 'bad_password']));

    const byReason = (reason: string) => auditRows.find(row => {
      const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : null;
      return metadata?.reason === reason;
    });
    expect(byReason('unknown_account')).toMatchObject({
      platformUserId: null,
      targetId: null,
      ipHash: hashV('203.0.113.101'),
      userAgentHash: hashV(`platform-auth-unknown-${suffix}`),
    });
    expect(byReason('inactive')).toMatchObject({
      platformUserId: inactive.id,
      targetId: inactive.id,
      ipHash: hashV('203.0.113.102'),
      userAgentHash: hashV(`platform-auth-inactive-${suffix}`),
    });
    expect(byReason('locked')).toMatchObject({
      platformUserId: locked.id,
      targetId: locked.id,
      ipHash: hashV('203.0.113.103'),
      userAgentHash: hashV(`platform-auth-locked-${suffix}`),
    });
    expect(byReason('bad_password')).toMatchObject({
      platformUserId: wrong.id,
      targetId: wrong.id,
      ipHash: hashV('203.0.113.104'),
      userAgentHash: hashV(`platform-auth-wrong-${suffix}`),
    });
  });

  it('preserves actor and request metadata through MFA password, failure, and success audits', async () => {
    const suffix = randomUUID();
    const secret = generateTotpSecret();
    const expiredLock = new Date(Date.now() - 60_000);
    const user = await platformUser({
      email: `mfa-audit-${suffix}@platform.test`,
      password: 'Correct-MFA-Password!',
      mfaEnabled: true,
      mfaSecretEnc: encryptSecret(secret),
      failedLoginCount: 3,
      lockedUntil: expiredLock,
    });

    const passwordResponse = await app.inject({
      method: 'POST',
      url: '/v1/platform/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.111', 'user-agent': `platform-mfa-password-${suffix}` },
      payload: { email: user.email, password: 'Correct-MFA-Password!' },
    });
    expect(passwordResponse.statusCode).toBe(200);
    const mfaToken = passwordResponse.json().mfaToken as string;
    const afterPassword = await platformDb.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(afterPassword.failedLoginCount).toBe(3);
    expect(afterPassword.lockedUntil?.toISOString()).toBe(expiredLock.toISOString());
    expect(afterPassword.lastLoginAt).toBeNull();

    const failedResponse = await app.inject({
      method: 'POST',
      url: '/v1/platform/auth/mfa/verify',
      headers: { authorization: `Bearer ${mfaToken}`, 'x-forwarded-for': '203.0.113.112', 'user-agent': `platform-mfa-failed-${suffix}` },
      payload: { code: 'xxxxxx' },
    });
    expect(failedResponse.statusCode).toBe(401);
    const afterFailedMfa = await platformDb.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(afterFailedMfa.failedLoginCount).toBe(3);
    expect(afterFailedMfa.lockedUntil?.toISOString()).toBe(expiredLock.toISOString());
    expect(afterFailedMfa.lastLoginAt).toBeNull();

    const successResponse = await app.inject({
      method: 'POST',
      url: '/v1/platform/auth/mfa/verify',
      headers: { authorization: `Bearer ${mfaToken}`, 'x-forwarded-for': '203.0.113.113', 'user-agent': `platform-mfa-success-${suffix}` },
      payload: { code: generateTotp(secret) },
    });
    expect(successResponse.statusCode).toBe(200);
    expect(successResponse.json().token).toEqual(expect.any(String));
    expect(successResponse.json().user.lastLoginAt).toEqual(expect.any(String));
    const afterSuccessfulMfa = await platformDb.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(afterSuccessfulMfa.failedLoginCount).toBe(0);
    expect(afterSuccessfulMfa.lockedUntil).toBeNull();
    expect(afterSuccessfulMfa.lastLoginAt).not.toBeNull();

    const events = await platformDb.platformAuditEvent.findMany({
      where: { platformUserId: user.id, targetId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    const passwordEvent = events.find(event => event.action === 'platform.login.password_verified');
    const failedEvent = events.find(event => event.action === 'platform.login.failed');
    const successEvent = events.find(event => event.action === 'platform.login.success');
    expect(passwordEvent).toMatchObject({
      ipHash: hashV('203.0.113.111'),
      userAgentHash: hashV(`platform-mfa-password-${suffix}`),
      metadata: { mfa: false, mfaRequired: true },
    });
    expect(failedEvent).toMatchObject({
      ipHash: hashV('203.0.113.112'),
      userAgentHash: hashV(`platform-mfa-failed-${suffix}`),
      metadata: { reason: 'bad_mfa' },
    });
    expect(successEvent).toMatchObject({
      ipHash: hashV('203.0.113.113'),
      userAgentHash: hashV(`platform-mfa-success-${suffix}`),
      metadata: { mfa: true },
    });
  });
});

describe('production rate-limit fail-closed policy', () => {
  it('requires a distributed store in production and permits local fallback only outside production', () => {
    expect(() => assertProductionRateLimitStore('production', undefined)).toThrow('distributed store is required in production');
    expect(() => assertProductionRateLimitStore('development', undefined)).not.toThrow();
    expect(skipRateLimitStoreErrors('production')).toBe(false);
    expect(skipRateLimitStoreErrors('development')).toBe(true);
  });

  it('rejects privileged platform authentication when the configured store errors', async () => {
    let handlerCalled = false;
    class FailingStore {
      incr(_key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void) {
        callback(new Error('synthetic distributed rate-limit store outage'));
      }
      child() { return this; }
    }

    const isolated = Fastify({ logger: false });
    await isolated.register(rateLimit, { global: false, store: FailingStore, skipOnError: true });
    isolated.post('/v1/platform/auth/login', { config: { rateLimit: PLATFORM_AUTH_RATE_LIMIT } }, async () => {
      handlerCalled = true;
      return { authenticated: true };
    });

    const response = await isolated.inject({ method: 'POST', url: '/v1/platform/auth/login' });
    expect(response.statusCode).toBe(500);
    expect(handlerCalled).toBe(false);
    await isolated.close();
  });
});
