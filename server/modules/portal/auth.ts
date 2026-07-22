import type { FastifyPluginAsync } from 'fastify';
import { appendFile } from 'node:fs/promises';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { signPortalSession, createMagicToken, hashPortalToken, requirePortalAccess, portalAudit, portalConfig } from '../../lib/portalAuth';

// Generic response used for every request-link outcome to prevent account
// enumeration (we never reveal whether an email/phone matched an account).
const GENERIC = { status: 'ok', message: 'If an account exists for that clinic, a sign-in link has been sent.' };
const GENERIC_SIGNUP = { status: 'ok', message: 'Thanks — if your details match a patient record we have sent a sign-in code. Otherwise your clinic will review your request shortly.' };

async function writePortalTokenOutbox(event: { tenantId: string; accountId: string; token: string; channel: 'email' | 'sms'; purpose: 'request-link' | 'signup' }) {
  if (!env.PORTAL_TOKEN_OUTBOX_PATH) return;
  await appendFile(env.PORTAL_TOKEN_OUTBOX_PATH, `${JSON.stringify({ ...event, createdAt: new Date().toISOString() })}\n`, { encoding: 'utf8' });
}

export const portalAuthRoutes: FastifyPluginAsync = async app => {
  // --- Request a magic sign-in link --------------------------------------
  app.post('/request-link', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const body = z.object({
      clinicSlug: z.string().trim().min(2).max(80),
      email: z.string().email().trim().toLowerCase().optional(),
      phone: z.string().trim().max(40).optional(),
    }).refine(v => v.email || v.phone, { message: 'Provide an email or phone.' }).parse(request.body);

    const tenant = await db.tenant.findUnique({ where: { slug: body.clinicSlug }, select: { id: true, status: true } });
    if (!tenant || tenant.status !== 'active') return GENERIC;

    const account = await db.patientPortalAccount.findFirst({
      where: { tenantId: tenant.id, status: { in: ['invited', 'active'] }, OR: [body.email ? { email: body.email } : {}, body.phone ? { phone: body.phone } : {}].filter(o => Object.keys(o).length) },
    });
    if (!account) return GENERIC;

    // Idempotency: reuse a fresh, unused token issued within the cooldown window.
    const recent = await db.patientPortalToken.findFirst({ where: { accountId: account.id, type: 'magic_login', usedAt: null, expiresAt: { gt: new Date() }, createdAt: { gt: new Date(Date.now() - portalConfig.RESEND_COOLDOWN_MS) } }, orderBy: { createdAt: 'desc' } });
    let raw: string | null = null;
    if (!recent) {
      const t = createMagicToken();
      raw = t.raw;
      await db.patientPortalToken.create({ data: { tenantId: tenant.id, accountId: account.id, tokenHash: t.hash, type: 'magic_login', expiresAt: new Date(Date.now() + portalConfig.MAGIC_TTL_MINUTES * 60_000) } });
    }
    await portalAudit(tenant.id, 'portal.login.requested', account.id, request, { channel: body.email ? 'email' : 'sms', reused: !!recent });
    if (raw) await writePortalTokenOutbox({ tenantId: tenant.id, accountId: account.id, token: raw, channel: body.email ? 'email' : 'sms', purpose: 'request-link' });

    // No portal comms provider is configured, so we never fake delivery. In dev/
    // test only (matching the existing dev-token pattern), surface the raw token
    // so the flow is testable. In production the token is NEVER returned.
    if (env.NODE_ENV !== 'production' && raw) return { ...GENERIC, devToken: raw, devNote: 'Dev only — delivery provider not configured.' };
    return GENERIC;
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

    const tenant = await db.tenant.findUnique({ where: { slug: body.clinicSlug }, select: { id: true, status: true } });
    if (!tenant || tenant.status !== 'active') return GENERIC_SIGNUP;

    const orFilters = [body.email ? { email: body.email } : {}, body.phone ? { phone: body.phone } : {}].filter(o => Object.keys(o).length);
    const matches = await db.patient.findMany({ where: { tenantId: tenant.id, deletedAt: null, OR: orFilters }, select: { id: true }, take: 2 });

    if (matches.length === 1) {
      const account = await db.patientPortalAccount.upsert({
        where: { tenantId_patientId: { tenantId: tenant.id, patientId: matches[0].id } },
        create: { tenantId: tenant.id, patientId: matches[0].id, email: body.email ?? null, phone: body.phone ?? null, status: 'invited' },
        update: {},
      });
      if (account.status === 'disabled') return GENERIC_SIGNUP; // never silently re-enable
      const recent = await db.patientPortalToken.findFirst({ where: { accountId: account.id, type: 'magic_login', usedAt: null, expiresAt: { gt: new Date() }, createdAt: { gt: new Date(Date.now() - portalConfig.RESEND_COOLDOWN_MS) } }, orderBy: { createdAt: 'desc' } });
      let raw: string | null = null;
      if (!recent) {
        const t = createMagicToken();
        raw = t.raw;
        await db.patientPortalToken.create({ data: { tenantId: tenant.id, accountId: account.id, tokenHash: t.hash, type: 'magic_login', expiresAt: new Date(Date.now() + portalConfig.MAGIC_TTL_MINUTES * 60_000) } });
      }
      // Critical: matching a signup to a patient record starts an access grant.
      await portalAudit(tenant.id, 'portal.signup.matched', account.id, request, { channel: body.email ? 'email' : 'sms' }, { critical: true });
      if (raw) await writePortalTokenOutbox({ tenantId: tenant.id, accountId: account.id, token: raw, channel: body.email ? 'email' : 'sms', purpose: 'signup' });
      if (env.NODE_ENV !== 'production' && raw) return { ...GENERIC_SIGNUP, devToken: raw, devNote: 'Dev only — delivery provider not configured.' };
      return GENERIC_SIGNUP;
    }

    // 0 or >1 matches → queue for staff review (no PHI access granted).
    await db.portalAccessRequest.create({ data: { tenantId: tenant.id, email: body.email ?? null, phone: body.phone ?? null, status: 'pending', matchCount: matches.length } });
    await portalAudit(tenant.id, 'portal.signup.unmatched', null, request, { matchCount: matches.length });
    return GENERIC_SIGNUP;
  });

  // --- Verify a magic token → issue a session ----------------------------
  app.post('/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.body);
    const row = await db.patientPortalToken.findUnique({ where: { tokenHash: hashPortalToken(token) } });
    if (!row || row.type !== 'magic_login') return reply.code(401).send({ error: 'invalid_token', message: 'This sign-in link is invalid.' });
    if (row.usedAt) return reply.code(401).send({ error: 'token_used', message: 'This link has already been used.' });
    if (row.expiresAt < new Date()) return reply.code(401).send({ error: 'token_expired', message: 'This link has expired. Request a new one.' });

    const account = await db.patientPortalAccount.findUnique({ where: { id: row.accountId } });
    if (!account || account.status === 'disabled') { await portalAudit(row.tenantId, 'portal.login.failed', row.accountId, request, { reason: 'disabled' }); return reply.code(403).send({ error: 'account_disabled', message: 'This account is disabled.' }); }
    if (account.lockedUntil && account.lockedUntil > new Date()) { await portalAudit(row.tenantId, 'portal.login.failed', account.id, request, { reason: 'locked' }); return reply.code(423).send({ error: 'account_locked', message: 'Account temporarily locked. Try again later.' }); }

    // Single-use: consume the token ATOMICALLY. The conditional updateMany only
    // flips usedAt when it is still NULL, so of N concurrent verifies exactly one
    // wins (count === 1); every racer that lost the compare-and-set gets 401.
    const consumed = await db.patientPortalToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) return reply.code(401).send({ error: 'token_used', message: 'This link has already been used.' });
    await db.patientPortalAccount.update({ where: { id: account.id }, data: { status: 'active', lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null } });
    // Critical: a session grant must never proceed unaudited.
    await portalAudit(account.tenantId, 'portal.login.success', account.id, request, undefined, { critical: true });

    const sessionToken = signPortalSession(app, account);
    const patient = await db.patient.findUnique({ where: { id: account.patientId }, select: { firstName: true } });
    return { token: sessionToken, displayName: patient?.firstName ?? 'there' };
  });

  // --- Current portal session --------------------------------------------
  app.get('/me', { preHandler: requirePortalAccess() }, async request => {
    const p = request.portal!;
    const [patient, tenant] = await Promise.all([
      db.patient.findUnique({ where: { id: p.patientId }, select: { firstName: true, lastName: true } }),
      db.tenant.findUnique({ where: { id: p.tenantId }, select: { name: true } }),
    ]);
    return { displayName: `${patient?.firstName ?? ''} ${patient?.lastName ?? ''}`.trim() || 'Patient', email: p.email, clinicName: tenant?.name ?? 'Your clinic' };
  });

  // --- Logout (stateless JWT; client discards the token) -----------------
  app.post('/logout', { preHandler: requirePortalAccess() }, async () => ({ loggedOut: true }));
};
