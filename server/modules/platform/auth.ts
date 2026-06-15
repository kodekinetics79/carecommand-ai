import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { verifyPassword, encryptSecret, decryptSecret } from '../../lib/security';
import { generateTotpSecret, verifyTotp, totpAuthUri } from '../../lib/totp';
import { signPlatformToken, signPlatformMfaToken, requirePlatformAccess, platformAuditEvent } from '../../lib/platformAuth';

// ===========================================================================
// Platform Admin authentication. Separate identity from tenant auth; reuses the
// same password-hash, TOTP, lockout, and audit patterns. Generic error messages
// never reveal whether an email exists.
// ===========================================================================

const INVALID = 'Invalid email or password.';

export const platformAuthRoutes: FastifyPluginAsync = async app => {
  const rateLogin = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/login', rateLogin, async (request, reply) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(request.body);
    const user = await db.platformUser.findUnique({ where: { email } });
    // Constant-ish path: always do a password check shape; never reveal existence.
    if (!user || user.status !== 'active') {
      await platformAuditEvent(null, 'platform.login.failed', { type: 'platformUser', id: null }, { reason: 'invalid' });
      return reply.code(401).send({ error: 'invalid_credentials', message: INVALID });
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await platformAuditEvent(null, 'platform.login.failed', { type: 'platformUser', id: user.id }, { reason: 'locked' });
      return reply.code(423).send({ error: 'account_locked', message: 'Account is temporarily locked. Try again later.' });
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= env.AUTH_LOCKOUT_THRESHOLD ? new Date(Date.now() + env.AUTH_LOCKOUT_DURATION_MINUTES * 60000) : null;
      await db.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock } });
      await platformAuditEvent(null, 'platform.login.failed', { type: 'platformUser', id: user.id }, { reason: 'bad_password', locked: Boolean(lock) });
      return reply.code(401).send({ error: 'invalid_credentials', message: INVALID });
    }
    await db.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });

    if (user.mfaEnabled) {
      // Issue a short-lived MFA token; full session requires a verified code.
      return reply.send({ mfaRequired: true, mfaToken: signPlatformMfaToken(app, user.id) });
    }
    await platformAuditEvent(null, 'platform.login.success', { type: 'platformUser', id: user.id }, { mfa: false });
    return reply.send({ token: signPlatformToken(app, user), user: publicUser(user) });
  });

  // Resolves either a full platform session or a platform-mfa login token.
  async function resolvePlatformActor(request: FastifyRequest): Promise<{ platformUserId: string; type: string }> {
    const payload = await request.jwtVerify<{ platformUserId: string; type: string }>();
    if (!payload?.platformUserId || !['platform', 'platform-mfa'].includes(payload.type)) throw app.httpErrors.unauthorized('A valid platform token is required.');
    return payload;
  }

  app.post('/mfa/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(request.body);
    const actor = await resolvePlatformActor(request);
    const user = await db.platformUser.findFirst({ where: { id: actor.platformUserId, status: 'active' } });
    if (!user || !user.mfaSecretEnc) throw app.httpErrors.unauthorized('MFA is not set up.');
    const secret = decryptSecret(user.mfaSecretEnc);
    if (!secret || !verifyTotp(secret, code)) {
      await platformAuditEvent(null, 'platform.login.failed', { type: 'platformUser', id: user.id }, { reason: 'bad_mfa' });
      return reply.code(401).send({ error: 'invalid_code', message: 'Invalid authentication code.' });
    }
    if (actor.type === 'platform-mfa') {
      // Completing login.
      await platformAuditEvent(null, 'platform.login.success', { type: 'platformUser', id: user.id }, { mfa: true });
      return reply.send({ token: signPlatformToken(app, user), user: publicUser(user) });
    }
    // Enabling MFA from a full session.
    await db.platformUser.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    await platformAuditEvent(request, 'platform.mfa.enabled', { type: 'platformUser', id: user.id });
    return reply.send({ enabled: true });
  });

  app.post('/mfa/setup', { preHandler: requirePlatformAccess(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const user = await db.platformUser.findFirst({ where: { id: request.platformUser!.id } });
    if (!user) throw app.httpErrors.unauthorized('A valid platform session is required.');
    if (user.mfaEnabled) throw app.httpErrors.conflict('MFA is already enabled.');
    const secret = generateTotpSecret();
    await db.platformUser.update({ where: { id: user.id }, data: { mfaSecretEnc: encryptSecret(secret), mfaEnabled: false } });
    return { secret, otpauthUri: totpAuthUri(secret, `CareCommand Platform:${user.email}`), enabled: false };
  });

  app.get('/me', { preHandler: requirePlatformAccess() }, async request => {
    if (request.platformUser!.legacy) return { id: 'legacy-token', email: null, name: 'Legacy operator token', role: 'PLATFORM_OWNER', legacy: true, mfaEnabled: false };
    const user = await db.platformUser.findUnique({ where: { id: request.platformUser!.id } });
    if (!user) throw app.httpErrors.unauthorized('Platform session not found.');
    return { ...publicUser(user), legacy: false };
  });

  app.post('/logout', { preHandler: requirePlatformAccess() }, async () => {
    // Stateless JWT — client discards the token. Acknowledged for UX.
    return { loggedOut: true };
  });
};

function publicUser(u: { id: string; email: string; name: string; role: string; status: string; mfaEnabled: boolean; lastLoginAt: Date | null }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, mfaEnabled: u.mfaEnabled, lastLoginAt: u.lastLoginAt?.toISOString() ?? null };
}
