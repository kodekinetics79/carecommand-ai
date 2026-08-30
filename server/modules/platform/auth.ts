import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { platformDb } from '../../lib/platformDb';
import { env } from '../../config/env';
import { verifyPassword, encryptSecret, decryptSecret, generatePasswordHash, validatePassword } from '../../lib/security';
import { generateTotpSecret, verifyTotp, totpAuthUri } from '../../lib/totp';
import { signPlatformToken, signPlatformMfaToken, requirePlatformAccess, platformAuditEvent, runPlatformAuditedMutation, attachPlatformActorContext, platformSessionWasLoggedOut, platformSessionIdHash, createPlatformAuditEvent, type PlatformMfaPurpose } from '../../lib/platformAuth';
import { runWithPlatformDatabaseRequest } from '../../lib/platformContextStore';

// ===========================================================================
// Platform Admin authentication. Separate identity from tenant auth; reuses the
// same password-hash, TOTP, lockout, and audit patterns. Generic error messages
// never reveal whether an email exists.
// ===========================================================================

/**
 * Whether the platform's OWN staff must use MFA. Defaults to required: these
 * accounts reach every tenant's commercial record. The owner can turn it off in
 * Platform Settings, and that decision is audited like any other.
 */
async function operatorMfaRequired(): Promise<boolean> {
  const cfg = await platformDb.platformConfig.findUnique({ where: { id: 'singleton' }, select: { requireOperatorMfa: true } });
  return cfg?.requireOperatorMfa ?? true;
}

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
    // Password verification alone never creates a privileged platform session.
    // Unenrolled operators receive only a short-lived MFA-enrollment token.
    const mfaRequired = await operatorMfaRequired();
    await platformAuditEvent(request, 'platform.login.password_verified', { type: 'platformUser', id: user.id }, {
      mfa: false,
      mfaRequired,
      enrollmentRequired: mfaRequired && !user.mfaEnabled,
    });
    // An enrolled operator always completes their second factor, even if policy
    // no longer demands one: turning the policy off must not silently weaken
    // an account that chose to be stronger than it.
    if (user.mfaEnabled) return reply.send({ mfaRequired: true, mfaToken: signPlatformMfaToken(app, user.id, 'challenge') });
    if (mfaRequired) return reply.send({ mfaSetupRequired: true, mfaToken: signPlatformMfaToken(app, user.id, 'enrollment') });

    const authenticated = await runPlatformAuditedMutation(request, {
      action: 'platform.login.succeeded', target: { type: 'platformUser', id: user.id }, metadata: { mfa: false, mfaRequired: false },
    }, tx => tx.platformUser.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    }));
    return reply.send({ token: signPlatformToken(app, authenticated), user: publicUser(authenticated) });
  });

  // Resolves either a full platform session or a platform-mfa login token.
  async function resolvePlatformActor(request: FastifyRequest): Promise<{ platformUserId: string; type: string; purpose?: PlatformMfaPurpose; sessionId?: string }> {
    const payload = await request.jwtVerify<{ platformUserId: string; type: string; purpose?: PlatformMfaPurpose; sessionId?: string }>();
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
    if (actor.type === 'platform-mfa' && actor.purpose === 'enrollment') {
      if (user.mfaEnabled) throw app.httpErrors.conflict('MFA is already enabled. Sign in again.');
      const authenticated = await platformDb.$transaction(async tx => {
        const updated = await tx.platformUser.update({
          where: { id: user.id },
          data: { mfaEnabled: true, failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
        });
        await createPlatformAuditEvent(tx, request, 'platform.mfa.enabled', { type: 'platformUser', id: user.id }, { enrollment: true });
        await createPlatformAuditEvent(tx, request, 'platform.login.success', { type: 'platformUser', id: user.id }, { mfa: true, enrolled: true });
        return updated;
      });
      return reply.send({ token: signPlatformToken(app, authenticated), user: publicUser(authenticated) });
    }
    if (actor.type === 'platform-mfa') {
      if (actor.purpose !== 'challenge' || !user.mfaEnabled) throw app.httpErrors.unauthorized('A valid MFA challenge is required.');
      const authenticated = await runPlatformAuditedMutation(request, {
        action: 'platform.login.success', target: { type: 'platformUser', id: user.id }, metadata: { mfa: true },
      }, tx => tx.platformUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } }));
      return reply.send({ token: signPlatformToken(app, authenticated), user: publicUser(authenticated) });
    }
    throw app.httpErrors.badRequest('MFA verification must use a short-lived challenge token.');
  });

  app.post('/mfa/setup', { config: { rateLimit: PLATFORM_AUTH_RATE_LIMIT } }, async request => {
    const actor = await resolvePlatformActor(request);
    if (actor.type !== 'platform-mfa' || actor.purpose !== 'enrollment') throw app.httpErrors.unauthorized('A valid MFA enrollment token is required.');
    const user = await platformDb.platformUser.findFirst({ where: { id: actor.platformUserId, status: 'active' } });
    if (!user) throw app.httpErrors.unauthorized('A valid platform account is required.');
    attachPlatformActorContext(request, user);
    if (user.mfaEnabled) throw app.httpErrors.conflict('MFA is already enabled.');
    const secret = generateTotpSecret();
    await runPlatformAuditedMutation(request, {
      action: 'platform.mfa.setup.started', target: { type: 'platformUser', id: user.id },
    }, tx => tx.platformUser.update({ where: { id: user.id }, data: { mfaSecretEnc: encryptSecret(secret), mfaEnabled: false } }));
    return { secret, otpauthUri: totpAuthUri(secret, `CareCommand Platform:${user.email}`), enabled: false };
  });

  app.get('/me', { preHandler: requirePlatformAccess() }, async request => {
    const mfaRequired = await operatorMfaRequired();
    if (request.platformUser!.legacy) return { id: 'legacy-token', email: null, name: 'Legacy operator token', role: 'PLATFORM_OWNER', legacy: true, mfaEnabled: false, mfaRequired };
    const user = await platformDb.platformUser.findUnique({ where: { id: request.platformUser!.id } });
    if (!user) throw app.httpErrors.unauthorized('Platform session not found.');
    // The console needs to know whether MFA is the operator's choice here.
    return { ...publicUser(user), legacy: false, mfaRequired };
  });

  /**
   * Change your own password.
   *
   * There was no way to do this from the console at all: rotating an operator
   * credential meant a database write. Requires the current password (so a
   * borrowed session cannot take the account over), enforces the same policy as
   * everywhere else, and revokes every OTHER session - the caller gets a fresh
   * token so they are not signed out of the tab they are working in.
   */
  app.post('/password', { preHandler: requirePlatformAccess(), config: { rateLimit: PLATFORM_AUTH_RATE_LIMIT } }, async (request, reply) => {
    if (request.platformUser!.legacy) throw app.httpErrors.forbidden('The legacy operator token has no password to change.');
    const body = z.object({
      currentPassword: z.string().min(1).max(200),
      newPassword: z.string().min(1).max(200),
    }).parse(request.body);

    const user = await platformDb.platformUser.findUnique({ where: { id: request.platformUser!.id } });
    if (!user) throw app.httpErrors.unauthorized('Platform session not found.');

    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      await platformAuditEvent(request, 'platform.password.change_failed', { type: 'platformUser', id: user.id }, { reason: 'bad_current_password' });
      return reply.code(400).send({ error: 'invalid_current_password', message: 'That is not your current password.' });
    }
    if (body.currentPassword === body.newPassword) {
      return reply.code(400).send({ error: 'password_unchanged', message: 'The new password must be different from the current one.' });
    }
    const policy = validatePassword(body.newPassword);
    if (!policy.ok) return reply.code(400).send({ error: 'weak_password', message: policy.message ?? 'That password does not meet the policy.' });

    const passwordHash = await generatePasswordHash(body.newPassword);
    const now = new Date();
    const updated = await runPlatformAuditedMutation(request, {
      // Never the password, never a hash - only that it changed and when.
      action: 'platform.password.changed', target: { type: 'platformUser', id: user.id }, metadata: { self: true },
    }, tx => tx.platformUser.update({
      where: { id: user.id },
      // Incrementing the epoch is what actually invalidates the other sessions;
      // sessionsRevokedAt is the human-readable record of when.
      data: {
        passwordHash, passwordChangedAt: now, sessionsRevokedAt: now,
        sessionEpoch: { increment: 1 }, failedLoginCount: 0, lockedUntil: null,
      },
    }));

    return reply.send({
      changed: true,
      otherSessionsRevoked: true,
      token: signPlatformToken(app, updated),
      user: publicUser(updated),
    });
  });

  /**
   * Turn your own MFA off.
   *
   * Refused while the platform requires operator MFA, so this is the owner's
   * decision in Platform Settings rather than each operator's. Proving both
   * factors first means a stolen session cannot remove the factor protecting
   * the account.
   */
  app.post('/mfa/disable', { preHandler: requirePlatformAccess(), config: { rateLimit: PLATFORM_AUTH_RATE_LIMIT } }, async (request, reply) => {
    if (request.platformUser!.legacy) throw app.httpErrors.forbidden('The legacy operator token has no MFA to disable.');
    const body = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(10) }).parse(request.body);

    if (await operatorMfaRequired()) {
      return reply.code(403).send({
        error: 'operator_mfa_required',
        message: 'This platform requires MFA for operators. Turn that off in Platform Settings first - it applies to every operator, not just you.',
      });
    }

    const user = await platformDb.platformUser.findUnique({ where: { id: request.platformUser!.id } });
    if (!user) throw app.httpErrors.unauthorized('Platform session not found.');
    if (!user.mfaEnabled || !user.mfaSecretEnc) return reply.send({ mfaEnabled: false, alreadyDisabled: true });

    if (!(await verifyPassword(body.password, user.passwordHash))) {
      await platformAuditEvent(request, 'platform.mfa.disable_failed', { type: 'platformUser', id: user.id }, { reason: 'bad_password' });
      return reply.code(400).send({ error: 'invalid_password', message: 'That is not your current password.' });
    }
    const secret = decryptSecret(user.mfaSecretEnc);
    if (!secret || !verifyTotp(secret, body.code)) {
      await platformAuditEvent(request, 'platform.mfa.disable_failed', { type: 'platformUser', id: user.id }, { reason: 'bad_code' });
      return reply.code(400).send({ error: 'invalid_code', message: 'That code did not match. Try the current one from your authenticator.' });
    }

    const updated = await runPlatformAuditedMutation(request, {
      action: 'platform.mfa.disabled', target: { type: 'platformUser', id: user.id }, metadata: { self: true },
    }, tx => tx.platformUser.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretEnc: null } }));
    return reply.send({ mfaEnabled: false, user: publicUser(updated) });
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
