import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { db } from './db';
import { env } from '../config/env';
import { effectivePlatformToken } from './platform';
import { safeEqual, generatePasswordHash } from './security';
import type { Prisma } from '../generated/prisma/client';

// ===========================================================================
// Platform Admin identity + RBAC. Separate from tenant auth: platform JWTs use
// type:'platform' and are never accepted as tenant sessions (the tenant auth
// plugin rejects any token whose type !== 'access'). The legacy static
// PLATFORM_API_TOKEN remains accepted only in non-production or explicit
// break-glass mode and maps to a synthetic PLATFORM_OWNER for backward
// compatibility.
// ===========================================================================

export const PLATFORM_ROLES = ['PLATFORM_OWNER', 'PLATFORM_ADMIN', 'PLATFORM_BILLING', 'PLATFORM_SUPPORT', 'PLATFORM_AUDITOR'] as const;
export type PlatformRole = typeof PLATFORM_ROLES[number];

export interface PlatformActor { id: string; role: PlatformRole; legacy: boolean; email?: string }

declare module 'fastify' {
  interface FastifyRequest { platformUser?: PlatformActor }
}

interface PlatformJwt { platformUserId: string; role: PlatformRole; type: 'platform' }

export function signPlatformToken(app: FastifyInstance, user: { id: string; role: string }, expiresIn = '8h'): string {
  return app.jwt.sign({ platformUserId: user.id, role: user.role, type: 'platform' } as PlatformJwt, { expiresIn });
}

export function signPlatformMfaToken(app: FastifyInstance, userId: string): string {
  return app.jwt.sign({ platformUserId: userId, role: 'PLATFORM_MFA' as PlatformRole, type: 'platform-mfa' } as never, { expiresIn: '10m' });
}

// PLATFORM_OWNER always passes; otherwise the role must be in the allowed list.
export function platformRoleAllowed(role: PlatformRole, allowed: PlatformRole[]): boolean {
  if (role === 'PLATFORM_OWNER') return true;
  return allowed.length === 0 || allowed.includes(role);
}

export function hashV(value?: string | null): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

// preHandler: requires a platform JWT, or a legacy static token only when
// explicitly enabled by effectivePlatformToken(). Optional role gate.
export function requirePlatformAccess(...allowedRoles: PlatformRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let actor: PlatformActor | null = null;

    // 1) Platform JWT (Authorization: Bearer <platform jwt>).
    try {
      const payload = await request.jwtVerify<PlatformJwt>();
      if (payload?.type === 'platform' && payload.platformUserId) {
        const pu = await db.platformUser.findFirst({ where: { id: payload.platformUserId, status: 'active' }, select: { id: true, role: true, email: true } });
        if (pu) actor = { id: pu.id, role: pu.role as PlatformRole, legacy: false, email: pu.email };
      }
    } catch { /* not a platform JWT — try legacy token */ }

    // 2) Legacy static platform token (dev/legacy) → synthetic PLATFORM_OWNER.
    if (!actor) {
      const expected = effectivePlatformToken();
      const headerToken = request.headers['x-platform-token'];
      const authHeader = request.headers.authorization;
      const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      const providedRaw = headerToken ?? bearer;
      const provided = Array.isArray(providedRaw) ? providedRaw[0] : providedRaw;
      if (expected && provided && safeEqual(provided, expected)) actor = { id: 'legacy-token', role: 'PLATFORM_OWNER', legacy: true };
    }

    if (!actor) return reply.code(401).send({ error: 'platform_unauthorized', message: 'Platform authentication required.' });
    if (allowedRoles.length && !platformRoleAllowed(actor.role, allowedRoles)) {
      return reply.code(403).send({ error: 'platform_forbidden', message: 'Your platform role cannot perform this action.' });
    }
    request.platformUser = actor;
  };
}

// --- Platform audit (no tenant scope required; no PHI/secrets) --------------
export async function platformAuditEvent(request: FastifyRequest | null, action: string, target: { type: string; id?: string | null; tenantId?: string | null }, metadata?: Prisma.InputJsonObject) {
  await db.platformAuditEvent.create({
    data: {
      platformUserId: request?.platformUser && !request.platformUser.legacy ? request.platformUser.id : undefined,
      action, targetType: target.type, targetId: target.id ?? undefined, tenantId: target.tenantId ?? undefined,
      ipHash: hashV(request?.ip), userAgentHash: hashV(typeof request?.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null),
      metadata,
    },
  }).catch(() => {});
}

// --- First PLATFORM_OWNER seed (env-only; no weak default in production) ----
export async function ensurePlatformOwnerSeed(): Promise<{ seeded: boolean; reason: string }> {
  const email = env.PLATFORM_OWNER_EMAIL;
  const password = env.PLATFORM_OWNER_PASSWORD;
  const name = env.PLATFORM_OWNER_NAME ?? 'Platform Owner';
  if (!email || !password) return { seeded: false, reason: 'env_not_set' };
  const existing = await db.platformUser.findUnique({ where: { email } });
  if (existing) return { seeded: false, reason: 'already_exists' };
  await db.platformUser.create({ data: { email, name, passwordHash: await generatePasswordHash(password), role: 'PLATFORM_OWNER', status: 'active' } });
  return { seeded: true, reason: 'created' };
}
