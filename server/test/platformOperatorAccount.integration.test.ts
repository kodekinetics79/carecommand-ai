import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { signPlatformToken } = await import('../lib/platformAuth');
const { generatePasswordHash, encryptSecret } = await import('../lib/security');
const { generateTotpSecret, generateTotp } = await import('../lib/totp');

/**
 * Operator account self-service.
 *
 * An operator could not change their own password from the console at all - the
 * only path was a database write - and MFA was unconditional, hardcoded rather
 * than owned by the platform owner.
 */
describe('platform operator account', () => {
  let app: FastifyInstance;
  const userId = randomUUID();
  const email = `account-${userId.slice(0, 8)}@carecommand.test`;
  const ORIGINAL = 'Operator-original-password-2026!';
  const REPLACEMENT = 'Operator-replacement-password-2026!';
  let totpSecret: string;

  const auth = (token?: string) => ({
    authorization: `Bearer ${token ?? signPlatformToken(app, { id: userId, role: 'PLATFORM_ADMIN' })}`,
    'content-type': 'application/json',
  });

  beforeAll(async () => {
    app = await buildApp();
    totpSecret = generateTotpSecret();
    await db.platformUser.create({
      data: {
        id: userId, email, name: 'Account Operator',
        passwordHash: await generatePasswordHash(ORIGINAL),
        role: 'PLATFORM_ADMIN', status: 'active',
        mfaEnabled: true, mfaSecretEnc: encryptSecret(totpSecret),
      },
    });
  }, 90_000);

  beforeEach(async () => {
    await db.platformConfig.upsert({ where: { id: 'singleton' }, update: { requireOperatorMfa: true }, create: { id: 'singleton', requireOperatorMfa: true } });
    // sessionEpoch back to 0 as well: a password-change test increments it, and
    // the hand-signed tokens below are minted at epoch 0. That coupling is the
    // point - a token whose epoch does not match the account is refused.
    await db.platformUser.update({
      where: { id: userId },
      data: {
        passwordHash: await generatePasswordHash(ORIGINAL), sessionsRevokedAt: null, sessionEpoch: 0,
        mfaEnabled: true, mfaSecretEnc: encryptSecret(totpSecret),
      },
    });
  });

  afterAll(async () => {
    await db.platformAuditEvent.deleteMany({ where: { platformUserId: userId } });
    await db.platformUser.deleteMany({ where: { id: userId } });
    await db.platformConfig.updateMany({ where: { id: 'singleton' }, data: { requireOperatorMfa: true } });
    await app.close();
  });

  describe('changing your own password', () => {
    it('refuses without the current password, and does not change anything', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/platform/auth/password', headers: auth(),
        payload: { currentPassword: 'not-my-password', newPassword: REPLACEMENT },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_current_password');
      const login = await app.inject({ method: 'POST', url: '/v1/platform/auth/login', payload: { email, password: ORIGINAL } });
      expect(login.statusCode).toBe(200);
    });

    it('refuses a password that does not meet policy', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/platform/auth/password', headers: auth(),
        payload: { currentPassword: ORIGINAL, newPassword: 'short' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('weak_password');
    });

    it('refuses reusing the current password', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/platform/auth/password', headers: auth(),
        payload: { currentPassword: ORIGINAL, newPassword: ORIGINAL },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('password_unchanged');
    });

    it('changes the password, keeps the caller signed in, and kills every other session', async () => {
      const otherSession = signPlatformToken(app, { id: userId, role: 'PLATFORM_ADMIN' });
      // The other session works before the change.
      expect((await app.inject({ method: 'GET', url: '/v1/platform/auth/me', headers: auth(otherSession) })).statusCode).toBe(200);

      const res = await app.inject({
        method: 'POST', url: '/v1/platform/auth/password', headers: auth(),
        payload: { currentPassword: ORIGINAL, newPassword: REPLACEMENT },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.changed).toBe(true);

      // The caller is handed a fresh token and stays signed in.
      expect((await app.inject({ method: 'GET', url: '/v1/platform/auth/me', headers: auth(body.token) })).statusCode).toBe(200);
      // Every other session is gone.
      expect((await app.inject({ method: 'GET', url: '/v1/platform/auth/me', headers: auth(otherSession) })).statusCode).toBe(401);

      // The new credential is the one that works.
      const oldLogin = await app.inject({ method: 'POST', url: '/v1/platform/auth/login', payload: { email, password: ORIGINAL } });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await app.inject({ method: 'POST', url: '/v1/platform/auth/login', payload: { email, password: REPLACEMENT } });
      expect(newLogin.statusCode).toBe(200);
    }, 30_000);

    it('records that the password changed, and never records the password', async () => {
      await app.inject({
        method: 'POST', url: '/v1/platform/auth/password', headers: auth(),
        payload: { currentPassword: ORIGINAL, newPassword: REPLACEMENT },
      });
      const events = await db.platformAuditEvent.findMany({ where: { platformUserId: userId, action: 'platform.password.changed' } });
      expect(events.length).toBeGreaterThan(0);
      const serialised = JSON.stringify(events);
      expect(serialised).not.toContain(ORIGINAL);
      expect(serialised).not.toContain(REPLACEMENT);
    }, 30_000);
  });

  describe('MFA is the platform owner’s choice, not a hardcoded rule', () => {
    it('refuses to let an operator turn MFA off while the platform requires it', async () => {
      const res = await app.inject({
        method: 'POST', url: '/v1/platform/auth/mfa/disable', headers: auth(),
        payload: { password: ORIGINAL, code: generateTotp(totpSecret) },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('operator_mfa_required');
      expect((await db.platformUser.findUniqueOrThrow({ where: { id: userId } })).mfaEnabled).toBe(true);
    });

    it('lets an operator turn it off once the owner has, but only with both factors', async () => {
      await db.platformConfig.update({ where: { id: 'singleton' }, data: { requireOperatorMfa: false } });

      const wrongCode = await app.inject({
        method: 'POST', url: '/v1/platform/auth/mfa/disable', headers: auth(),
        payload: { password: ORIGINAL, code: '000000' },
      });
      expect(wrongCode.statusCode).toBe(400);
      expect((await db.platformUser.findUniqueOrThrow({ where: { id: userId } })).mfaEnabled).toBe(true);

      const wrongPassword = await app.inject({
        method: 'POST', url: '/v1/platform/auth/mfa/disable', headers: auth(),
        payload: { password: 'not-my-password', code: generateTotp(totpSecret) },
      });
      expect(wrongPassword.statusCode).toBe(400);
      expect((await db.platformUser.findUniqueOrThrow({ where: { id: userId } })).mfaEnabled).toBe(true);

      const ok = await app.inject({
        method: 'POST', url: '/v1/platform/auth/mfa/disable', headers: auth(),
        payload: { password: ORIGINAL, code: generateTotp(totpSecret) },
      });
      expect(ok.statusCode).toBe(200);
      expect((await db.platformUser.findUniqueOrThrow({ where: { id: userId } })).mfaEnabled).toBe(false);
    }, 30_000);

    it('signs a non-enrolled operator straight in when the platform no longer requires MFA', async () => {
      await db.platformConfig.update({ where: { id: 'singleton' }, data: { requireOperatorMfa: false } });
      await db.platformUser.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecretEnc: null } });

      const login = await app.inject({ method: 'POST', url: '/v1/platform/auth/login', payload: { email, password: ORIGINAL } });
      expect(login.statusCode).toBe(200);
      expect(login.json().token).toBeTruthy();
      expect(login.json().mfaSetupRequired).toBeUndefined();
    }, 30_000);

    it('still asks an ENROLLED operator for their code after the policy is relaxed', async () => {
      await db.platformConfig.update({ where: { id: 'singleton' }, data: { requireOperatorMfa: false } });
      // Turning the policy off must not silently weaken an account that chose
      // to be stronger than the policy.
      const login = await app.inject({ method: 'POST', url: '/v1/platform/auth/login', payload: { email, password: ORIGINAL } });
      expect(login.statusCode).toBe(200);
      expect(login.json().mfaRequired).toBe(true);
      expect(login.json().token).toBeUndefined();
    }, 30_000);

    it('tells the console whose decision MFA is', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/platform/auth/me', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json().mfaRequired).toBe(true);
    });
  });
});
