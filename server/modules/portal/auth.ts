import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { issuePortalSession, createMagicToken, hashPortalToken, requirePortalAccess, portalAudit, portalConfig } from '../../lib/portalAuth';
import { enterTenantContext } from '../../lib/tenantContext';
import { resolveIngressTenant } from '../../lib/tenantIngressResolvers';
import { deliverPortalToken } from '../../lib/portalDelivery';

// Generic response used for every request-link outcome to prevent account
// enumeration (we never reveal whether an email/phone matched an account).
const GENERIC = { status: 'ok', message: 'If an account exists for that clinic, a sign-in link has been sent.' };
const GENERIC_SIGNUP = { status: 'ok', message: 'Thanks — if your details match a patient record we have sent a sign-in code. Otherwise your clinic will review your request shortly.' };
const PENDING_MAGIC_LOGIN = 'pending_magic_login';

// Production always requires a confirmed provider delivery. The explicit
// outbox is a local/E2E credential sink and follows the same pending->active
// state machine so a failed write can never leave a usable credential behind.
function tokenDeliveryRequired(): boolean {
  return env.NODE_ENV === 'production' || Boolean(env.PORTAL_TOKEN_OUTBOX_PATH);
}

export const portalAuthRoutes: FastifyPluginAsync = async app => {
  // --- Request a magic sign-in link --------------------------------------
  app.post('/request-link', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const body = z.object({
      clinicSlug: z.string().trim().min(2).max(80),
      email: z.string().email().trim().toLowerCase().optional(),
      phone: z.string().trim().max(40).optional(),
    }).refine(v => v.email || v.phone, { message: 'Provide an email or phone.' }).parse(request.body);

    const tenant = await resolveIngressTenant('tenant_slug', body.clinicSlug);
    if (!tenant) return GENERIC;
    enterTenantContext({ tenantId: tenant.tenantId, actorId: 'portal:request-link', actorRole: 'PUBLIC_PORTAL', source: 'portal', requestId: request.id });

    // Every supplied contact must match the same account. Using OR here allows
    // an attacker to pair a victim's phone with an attacker-controlled email,
    // match by phone, then have delivery selected as email.
    const account = await db.patientPortalAccount.findFirst({
      where: {
        tenantId: tenant.tenantId,
        status: { in: ['invited', 'active'] },
        ...(body.email ? { email: body.email } : {}),
        ...(body.phone ? { phone: body.phone } : {}),
      },
    });
    if (!account) return GENERIC;
    const activePatient = await db.patient.findFirst({ where: { id: account.patientId, tenantId: tenant.tenantId, deletedAt: null }, select: { id: true } });
    if (!activePatient) return GENERIC;

    // Idempotency: do not mint another credential during the cooldown. Raw
    // tokens are intentionally never persisted, so a recent token cannot be
    // re-sent; the earlier confirmed delivery remains the authoritative send.
    const recent = await db.patientPortalToken.findFirst({ where: { accountId: account.id, type: 'magic_login', usedAt: null, expiresAt: { gt: new Date() }, createdAt: { gt: new Date(Date.now() - portalConfig.RESEND_COOLDOWN_MS) } }, orderBy: { createdAt: 'desc' } });
    if (recent) {
      await portalAudit(tenant.tenantId, 'portal.login.requested', account.id, request, { channel: body.email ? 'email' : 'sms', reused: true });
      return GENERIC;
    }

    const t = createMagicToken();
    const deliveryRequired = tokenDeliveryRequired();
    await db.$transaction(async tx => {
      await tx.patientPortalToken.create({
        data: {
          tenantId: tenant.tenantId,
          accountId: account.id,
          tokenHash: t.hash,
          type: deliveryRequired ? PENDING_MAGIC_LOGIN : 'magic_login',
          expiresAt: new Date(Date.now() + portalConfig.MAGIC_TTL_MINUTES * 60_000),
        },
      });
      await portalAudit(tenant.tenantId, 'portal.login.requested', account.id, request, { channel: body.email ? 'email' : 'sms', reused: false }, { critical: true, tx });
    });

    if (deliveryRequired) {
      const delivery = await deliverPortalToken({ tenantId: tenant.tenantId, patientId: account.patientId, accountId: account.id, token: t.raw, email: account.email, phone: account.phone, purpose: 'request-link' });
      if (!delivery.ok) {
        await db.$transaction(async tx => {
          await tx.patientPortalToken.deleteMany({ where: { accountId: account.id, tokenHash: t.hash, type: PENDING_MAGIC_LOGIN, usedAt: null } });
          await portalAudit(tenant.tenantId, 'portal.login.delivery_failed', account.id, request, { mode: delivery.mode, status: delivery.status }, { critical: true, tx });
        });
        return GENERIC;
      }
      try {
        await db.$transaction(async tx => {
          const promoted = await tx.patientPortalToken.updateMany({ where: { accountId: account.id, tokenHash: t.hash, type: PENDING_MAGIC_LOGIN, usedAt: null }, data: { type: 'magic_login' } });
          if (promoted.count !== 1) throw new Error('portal pending credential promotion failed');
          await portalAudit(tenant.tenantId, 'portal.login.delivered', account.id, request, { mode: delivery.mode }, { critical: true, tx });
        });
      } catch (error) {
        // The credential remains pending (and therefore unverifiable) if the
        // final audit/activation transaction cannot commit.
        request.log.error({ err: error }, 'portal credential activation failed after delivery');
      }
      return GENERIC;
    }

    // Local development/test without a delivery sink surfaces the credential;
    // production can never enter this branch.
    return { ...GENERIC, devToken: t.raw, devNote: 'Dev/test only — no delivery sink configured.' };
  });

  // --- Self-signup (mobile app): clinic-scoped contact match → OTP -------
  // The app collects clinic + email/phone. We only ever bind a new account to
  // an EXISTING patient that uniquely matches that contact, then send an OTP to
  // that same contact (possession proves identity). Any other case (0 or >1
  // matches) is queued for staff review — never auto-granted. Anti-enumeration:
  // the response is identical regardless of outcome (devToken is dev-only).
  app.post('/signup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const body = z.object({
      clinicSlug: z.string().trim().min(2).max(80),
      email: z.string().email().trim().toLowerCase().optional(),
      phone: z.string().trim().max(40).optional(),
    }).refine(v => v.email || v.phone, { message: 'Provide an email or phone.' }).parse(request.body);

    const tenant = await resolveIngressTenant('tenant_slug', body.clinicSlug);
    if (!tenant) return GENERIC_SIGNUP;
    enterTenantContext({ tenantId: tenant.tenantId, actorId: 'portal:signup', actorRole: 'PUBLIC_PORTAL', source: 'portal', requestId: request.id });

    // Match all supplied identity attributes to one patient. This prevents a
    // valid phone for patient A being combined with an unrelated email that
    // would otherwise receive A's sign-in credential.
    const matches = await db.patient.findMany({
      where: {
        tenantId: tenant.tenantId,
        deletedAt: null,
        ...(body.email ? { email: body.email } : {}),
        ...(body.phone ? { phone: body.phone } : {}),
      },
      select: { id: true, dateOfBirth: true },
      take: 2,
    });

    const adultCutoff = new Date();
    adultCutoff.setUTCFullYear(adultCutoff.getUTCFullYear() - 18);
    const unambiguouslyAdult = matches.length === 1 && matches[0].dateOfBirth !== null && matches[0].dateOfBirth <= adultCutoff;
    if (unambiguouslyAdult) {
      const t = createMagicToken();
      const deliveryRequired = tokenDeliveryRequired();
      const issued = await db.$transaction(async tx => {
        const account = await tx.patientPortalAccount.upsert({
          where: { tenantId_patientId: { tenantId: tenant.tenantId, patientId: matches[0].id } },
          create: { tenantId: tenant.tenantId, patientId: matches[0].id, email: body.email ?? null, phone: body.phone ?? null, status: 'invited' },
          update: {},
        });
        if (account.status === 'disabled') return { account, created: false, disabled: true } as const;
        const recent = await tx.patientPortalToken.findFirst({ where: { accountId: account.id, type: 'magic_login', usedAt: null, expiresAt: { gt: new Date() }, createdAt: { gt: new Date(Date.now() - portalConfig.RESEND_COOLDOWN_MS) } }, orderBy: { createdAt: 'desc' } });
        if (!recent) {
          await tx.patientPortalToken.create({ data: { tenantId: tenant.tenantId, accountId: account.id, tokenHash: t.hash, type: deliveryRequired ? PENDING_MAGIC_LOGIN : 'magic_login', expiresAt: new Date(Date.now() + portalConfig.MAGIC_TTL_MINUTES * 60_000) } });
        }
        // Binding a signup to a patient and minting a credential is one audited
        // transaction. Audit failure rolls both operations back.
        await portalAudit(tenant.tenantId, 'portal.signup.matched', account.id, request, { channel: body.email ? 'email' : 'sms', reused: Boolean(recent) }, { critical: true, tx });
        return { account, created: !recent, disabled: false } as const;
      });
      if (issued.disabled || !issued.created) return GENERIC_SIGNUP;

      if (deliveryRequired) {
        const delivery = await deliverPortalToken({ tenantId: tenant.tenantId, patientId: issued.account.patientId, accountId: issued.account.id, token: t.raw, email: issued.account.email, phone: issued.account.phone, purpose: 'signup' });
        if (!delivery.ok) {
          await db.$transaction(async tx => {
            await tx.patientPortalToken.deleteMany({ where: { accountId: issued.account.id, tokenHash: t.hash, type: PENDING_MAGIC_LOGIN, usedAt: null } });
            await portalAudit(tenant.tenantId, 'portal.signup.delivery_failed', issued.account.id, request, { mode: delivery.mode, status: delivery.status }, { critical: true, tx });
          });
          return GENERIC_SIGNUP;
        }
        try {
          await db.$transaction(async tx => {
            const promoted = await tx.patientPortalToken.updateMany({ where: { accountId: issued.account.id, tokenHash: t.hash, type: PENDING_MAGIC_LOGIN, usedAt: null }, data: { type: 'magic_login' } });
            if (promoted.count !== 1) throw new Error('portal pending signup credential promotion failed');
            await portalAudit(tenant.tenantId, 'portal.signup.delivered', issued.account.id, request, { mode: delivery.mode }, { critical: true, tx });
          });
        } catch (error) {
          request.log.error({ err: error }, 'portal signup credential activation failed after delivery');
        }
        return GENERIC_SIGNUP;
      }
      return { ...GENERIC_SIGNUP, devToken: t.raw, devNote: 'Dev/test only — no delivery sink configured.' };
    }

    // 0 or >1 matches → queue for staff review (no PHI access granted).
    await db.$transaction(async tx => {
      const identityKey = body.email ?? body.phone!;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenant.tenantId}), hashtext(${identityKey}))`;
      let pending = await tx.portalAccessRequest.findFirst({
        where: { tenantId: tenant.tenantId, email: body.email ?? null, phone: body.phone ?? null, status: 'pending' },
        select: { id: true },
      });
      pending ??= await tx.portalAccessRequest.create({ data: { tenantId: tenant.tenantId, email: body.email ?? null, phone: body.phone ?? null, status: 'pending', matchCount: matches.length }, select: { id: true } });
      await portalAudit(tenant.tenantId, 'portal.signup.review_queued', pending.id, request, { matchCount: matches.length, reason: matches.length === 1 ? 'age_or_authority_review_required' : 'non_unique_contact' }, { critical: true, tx });
    });
    return GENERIC_SIGNUP;
  });

  // --- Verify a magic token → issue a session ----------------------------
  app.post('/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.body);
    const tokenHash = hashPortalToken(token);
    const resolved = await resolveIngressTenant('portal_token_hash', tokenHash);
    if (!resolved) return reply.code(401).send({ error: 'invalid_token', message: 'This sign-in link is invalid.' });
    enterTenantContext({ tenantId: resolved.tenantId, actorId: 'portal:verify', actorRole: 'PUBLIC_PORTAL', source: 'portal', requestId: request.id });
    const row = await db.patientPortalToken.findFirst({ where: { id: resolved.resourceId, tokenHash } });
    if (!row || row.type !== 'magic_login') return reply.code(401).send({ error: 'invalid_token', message: 'This sign-in link is invalid.' });
    if (row.usedAt) return reply.code(401).send({ error: 'token_used', message: 'This link has already been used.' });
    if (row.expiresAt < new Date()) return reply.code(401).send({ error: 'token_expired', message: 'This link has expired. Request a new one.' });
    enterTenantContext({ tenantId: row.tenantId, actorId: row.accountId, actorRole: 'PATIENT_PORTAL', source: 'portal', requestId: request.id });

    const now = new Date();
    const outcome = await db.$transaction(async tx => {
      // Re-read all authorization inputs inside the write transaction. The
      // conditional token consume, account activation, and critical audit are
      // indivisible: any failure rolls the credential back to unused.
      const currentToken = await tx.patientPortalToken.findFirst({ where: { id: row.id, tenantId: row.tenantId, accountId: row.accountId, tokenHash, type: 'magic_login' } });
      if (!currentToken || currentToken.usedAt) return { error: 'token_used' as const };
      if (currentToken.expiresAt <= now) return { error: 'token_expired' as const };
      const account = await tx.patientPortalAccount.findFirst({ where: { id: row.accountId, tenantId: row.tenantId } });
      if (!account || !['invited', 'active'].includes(account.status)) return { error: 'account_disabled' as const };
      if (account.lockedUntil && account.lockedUntil > now) return { error: 'account_locked' as const };
      const activePatient = await tx.patient.findFirst({ where: { id: account.patientId, tenantId: account.tenantId, deletedAt: null }, select: { id: true, firstName: true } });
      if (!activePatient) return { error: 'account_disabled' as const };

      const consumed = await tx.patientPortalToken.updateMany({
        where: { id: currentToken.id, tenantId: currentToken.tenantId, accountId: currentToken.accountId, tokenHash, type: 'magic_login', usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) return { error: 'token_used' as const };
      const activated = await tx.patientPortalAccount.updateMany({
        where: { id: account.id, tenantId: account.tenantId, patientId: account.patientId, status: { in: ['invited', 'active'] } },
        data: { status: 'active', lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
      });
      if (activated.count !== 1) return { error: 'account_disabled' as const };
      const sessionToken = await issuePortalSession(app, account, tx);
      await portalAudit(account.tenantId, 'portal.login.success', account.id, request, undefined, { critical: true, tx });
      return { account, displayName: activePatient.firstName, sessionToken } as const;
    });

    if ('error' in outcome) {
      await portalAudit(row.tenantId, 'portal.login.failed', row.accountId, request, { reason: outcome.error });
      if (outcome.error === 'account_disabled') return reply.code(403).send({ error: 'account_disabled', message: 'This account is disabled.' });
      if (outcome.error === 'account_locked') return reply.code(423).send({ error: 'account_locked', message: 'Account temporarily locked. Try again later.' });
      if (outcome.error === 'token_expired') return reply.code(401).send({ error: 'token_expired', message: 'This link has expired. Request a new one.' });
      return reply.code(401).send({ error: 'token_used', message: 'This link has already been used.' });
    }

    return { token: outcome.sessionToken, displayName: outcome.displayName, expiresInMinutes: portalConfig.SESSION_TTL_MINUTES };
  });

  // --- Current portal session --------------------------------------------
  app.get('/me', { preHandler: requirePortalAccess() }, async request => {
    const p = request.portal!;
    const [patient, tenant] = await Promise.all([
      db.patient.findFirst({ where: { id: p.patientId, tenantId: p.tenantId, deletedAt: null }, select: { firstName: true, lastName: true } }),
      db.tenant.findUnique({ where: { id: p.tenantId }, select: { name: true } }),
    ]);
    if (!patient) return app.httpErrors.unauthorized('This portal account is no longer active.');
    return { displayName: `${patient.firstName} ${patient.lastName}`.trim() || 'Patient', email: p.email, clinicName: tenant?.name ?? 'Your clinic' };
  });

  // --- Logout: revoke the server-side session before acknowledging --------
  app.post('/logout', { preHandler: requirePortalAccess() }, async request => {
    const p = request.portal!;
    await db.$transaction(async tx => {
      const revoked = await tx.patientPortalToken.updateMany({
        where: { tenantId: p.tenantId, accountId: p.accountId, tokenHash: p.sessionIdHash, type: 'session', usedAt: null },
        data: { usedAt: new Date() },
      });
      if (revoked.count !== 1) throw app.httpErrors.unauthorized('This session has already ended.');
      await portalAudit(p.tenantId, 'portal.logout', p.accountId, request, { reason: 'user-initiated' }, { critical: true, tx });
    });
    return { loggedOut: true };
  });
};
