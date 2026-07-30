import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { platformDb } from '../../lib/platformDb';
import { env } from '../../config/env';
import { verifyPassword, encryptSecret, decryptSecret } from '../../lib/security';
import { generateTotpSecret, verifyTotp, totpAuthUri } from '../../lib/totp';
import { signPlatformToken, signPlatformMfaToken, requirePlatformAccess, platformAuditEvent, runPlatformAuditedMutation, attachPlatformActorContext, platformSessionWasLoggedOut, platformSessionIdHash } from '../../lib/platformAuth';
import { runWithPlatformDatabaseRequest } from '../../lib/platformContextStore';

// ===========================================================================
// Platform Admin authentication. Separate identity from tenant auth; reuses the
// same password-hash, TOTP, lockout, and audit patterns. Generic error messages
// never reveal whether an email exists.
// ===========================================================================

const INVALID = 'Invalid email or password.';
const INVALID_RESPONSE = { error: 'invalid_credentials', message: INVALID } as const;

// Valid, fixed-cost scrypt material for unknown identities. The plaintext used
// to produce this hash is deliberately not an account credential. Keeping a
// valid hash here ensures the unknown-account path performs the same password
// derivation shape as a real PlatformUser.
export const PLATFORM_LOGIN_DUMMY_HASH = 'scrypt$5f61b7e563732ec9e637bd7918a83f12$585ece13e6d3bcc495ea16877b3c11224a5ebc3d317f689578cd0c40279344a480e2ed0a03532b1182c6793e8f59d66917feaf24ba6d6ab13c8bcf413794e7a0';

export const PLATFORM_AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute', skipOnError: false } as const;

type PasswordVerifier = (password: string, storedHash?: string | null) => Promise<boolean>;

export async function verifyPlatformLoginPassword(
  password: string,
  storedHash: string | null | undefined,
  verifier: PasswordVerifier = verifyPassword,
): Promise<boolean> {
  return verifier(password, storedHash ?? PLATFORM_LOGIN_DUMMY_HASH);
}

export const platformAuthRoutes: FastifyPluginAsync = async app => {
  const rateLogin = { config: { rateLimit: PLATFORM_AUTH_RATE_LIMIT } };
  app.addHook('onRequest', (_request, _reply, done) => runWithPlatformDatabaseRequest(done));

  app.post('/login', rateLogin, async (request, reply) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).parse(request.body);
    const user = await platformDb.platformUser.findUnique({ where: { email } });
    // Always perform one valid scrypt verification before evaluating account
    // state. Unknown, inactive, locked, and bad-password attempts therefore
    // expose the same external response and comparable password-hash work.
    const passwordOk = await verifyPlatformLoginPassword(password, user?.passwordHash);
    if (user) attachPlatformActorContext(request, user);
    const accountActive = user?.status === 'active';
    const accountLocked = Boolean(accountActive && user.lockedUntil && user.lockedUntil.getTime() > Date.now());
    if (!user || !accountActive || accountLocked || !passwordOk) {
      let reason: 'unknown_account' | 'inactive' | 'locked' | 'bad_password';
      if (!user) reason = 'unknown_account';
      else if (!accountActive) reason = 'inactive';
      else if (accountLocked) reason = 'locked';
      else reason = 'bad_password';

      // Only an active, unlocked account with a bad password advances lockout.
      // Locked/inactive identities remain externally indistinguishable and are
      // not mutated by probes against their known email address.
      if (user && accountActive && !accountLocked && !passwordOk) {
        const failed = user.failedLoginCount + 1;
        const lock = failed >= env.AUTH_LOCKOUT_THRESHOLD ? new Date(Date.now() + env.AUTH_LOCKOUT_DURATION_MINUTES * 60000) : null;
        await runPlatformAuditedMutation(request, {
          action: 'platform.login.failed', target: { type: 'platformUser', id: user.id }, metadata: { reason, locked: Boolean(lock) },
        }, tx => tx.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock } }));
      } else {
        await platformAuditEvent(request, 'platform.login.failed', { type: 'platformUser', id: user?.id ?? null }, { reason });
      }
      return reply.code(401).send(INVALID_RESPONSE);
    }
    if (user.mfaEnabled) {
      // Password verification is not a successful login. Preserve lockout
      // state and lastLoginAt until MFA completion and its audit both commit.
      await platformAuditEvent(request, 'platform.login.password_verified', { type: 'platformUser', id: user.id }, { mfa: false, mfaRequired: true });
      return reply.send({ mfaRequired: true, mfaToken: signPlatformMfaToken(app, user.id) });
    }
    const authenticated = await runPlatformAuditedMutation(request, {
      action: 'platform.login.success',
      target: { type: 'platformUser', id: user.id }, metadata: { mfa: false, mfaRequired: false },
    }, tx => tx.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } }));
    return reply.send({ token: signPlatformToken(app, authenticated), user: publicUser(authenticated) });
  });

  // Resolves either a full platform session or a platform-mfa login token.
  async function resolvePlatformActor(request: FastifyRequest): Promise<{ platformUserId: string; type: string; sessionId?: string }> {
    const payload = await request.jwtVerify<{ platformUserId: string; type: string; sessionId?: string }>();
    if (!payload?.platformUserId || !['platform', 'platform-mfa'].includes(payload.type)) throw app.httpErrors.unauthorized('A valid platform token is required.');
    return payload;
  }

  app.post('/mfa/verify', { config: { rateLimit: PLATFORM_AUTH_RATE_LIMIT } }, async (request, reply) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(request.body);
    const actor = await resolvePlatformActor(request);
    const user = await platformDb.platformUser.findFirst({ where: { id: actor.platformUserId, status: 'active' } });
    if (!user || !user.mfaSecretEnc) throw app.httpErrors.unauthorized('MFA is not set up.');
    if (actor.type === 'platform' && (typeof actor.sessionId !== 'string' || await platformSessionWasLoggedOut(user.id, actor.sessionId))) {
      throw app.httpErrors.unauthorized('Platform session expired. Please sign in again.');
    }
    attachPlatformActorContext(request, user);
    const secret = decryptSecret(user.mfaSecretEnc);
    if (!secret || !verifyTotp(secret, code)) {
      await platformAuditEvent(request, 'platform.login.failed', { type: 'platformUser', id: user.id }, { reason: 'bad_mfa' });
      return reply.code(401).send({ error: 'invalid_code', message: 'Invalid authentication code.' });
    }
    if (actor.type === 'platform-mfa') {
      const authenticated = await runPlatformAuditedMutation(request, {
        action: 'platform.login.success', target: { type: 'platformUser', id: user.id }, metadata: { mfa: true },
      }, tx => tx.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } }));
      return reply.send({ token: signPlatformToken(app, authenticated), user: publicUser(authenticated) });
    }
    // Enabling MFA from a full session.
    await runPlatformAuditedMutation(request, {
      action: 'platform.mfa.enabled', target: { type: 'platformUser', id: user.id },
    }, tx => tx.platformUser.update({ where: { id: user.id }, data: { mfaEnabled: true } }));
    return reply.send({ enabled: true });
  });

  app.post('/mfa/setup', { preHandler: requirePlatformAccess(), config: { rateLimit: PLATFORM_AUTH_RATE_LIMIT } }, async request => {
    const user = await platformDb.platformUser.findFirst({ where: { id: request.platformUser!.id } });
    if (!user) throw app.httpErrors.unauthorized('A valid platform session is required.');
    if (user.mfaEnabled) throw app.httpErrors.conflict('MFA is already enabled.');
    const secret = generateTotpSecret();
    await runPlatformAuditedMutation(request, {
      action: 'platform.mfa.setup.started', target: { type: 'platformUser', id: user.id },
    }, tx => tx.platformUser.update({ where: { id: user.id }, data: { mfaSecretEnc: encryptSecret(secret), mfaEnabled: false } }));
    return { secret, otpauthUri: totpAuthUri(secret, `CareCommand Platform:${user.email}`), enabled: false };
  });

  app.get('/me', { preHandler: requirePlatformAccess() }, async request => {
    if (request.platformUser!.legacy) return { id: 'legacy-token', email: null, name: 'Legacy operator token', role: 'PLATFORM_OWNER', legacy: true, mfaEnabled: false };
    const user = await platformDb.platformUser.findUnique({ where: { id: request.platformUser!.id } });
    if (!user) throw app.httpErrors.unauthorized('Platform session not found.');
    return { ...publicUser(user), legacy: false };
  });

  app.post('/logout', { preHandler: requirePlatformAccess() }, async request => {
    if (!request.platformUser!.legacy) {
      const token = await request.jwtVerify<{ sessionId?: string }>();
      if (!token.sessionId) throw app.httpErrors.unauthorized('Platform session expired. Please sign in again.');
      await runPlatformAuditedMutation(request, {
        action: 'platform.logout', target: { type: 'platformUser', id: request.platformUser!.id }, metadata: { sessionIdHash: platformSessionIdHash(token.sessionId) },
      }, tx => tx.platformUser.findUniqueOrThrow({ where: { id: request.platformUser!.id } }));
    }
    // The client also discards its token; the server-side session epoch makes
    // replay of that token fail immediately.
    return { loggedOut: true };
  });
};

function publicUser(u: { id: string; email: string; name: string; role: string; status: string; mfaEnabled: boolean; lastLoginAt: Date | null }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, mfaEnabled: u.mfaEnabled, lastLoginAt: u.lastLoginAt?.toISOString() ?? null };
}
