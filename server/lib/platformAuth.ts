import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { platformDb } from './platformDb';
import { enterPlatformDatabaseContext } from './platformContextStore';
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

interface PlatformJwt {
  platformUserId: string;
  role: PlatformRole;
  type: 'platform';
  sessionIssuedAtMs: number;
}

export function signPlatformToken(app: FastifyInstance, user: { id: string; role: string }, expiresIn = '8h'): string {
  return app.jwt.sign({ platformUserId: user.id, role: user.role, type: 'platform', sessionIssuedAtMs: Date.now() } as PlatformJwt, { expiresIn });
}

export function signPlatformMfaToken(app: FastifyInstance, userId: string): string {
  return app.jwt.sign({ platformUserId: userId, role: 'PLATFORM_MFA' as PlatformRole, type: 'platform-mfa' } as never, { expiresIn: '10m' });
}

export async function platformSessionWasLoggedOut(platformUserId: string, sessionIssuedAtMs: number): Promise<boolean> {
  const receipt = await platformDb.platformAuditEvent.findFirst({
    where: {
      platformUserId,
      action: 'platform.logout',
      targetType: 'platformUser',
      targetId: platformUserId,
      metadata: { path: ['sessionIssuedAtMs'], equals: sessionIssuedAtMs },
    },
    select: { id: true },
  });
  return Boolean(receipt);
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

/** Bind a resolved database identity to request-level and database audit context. */
export function attachPlatformActorContext(
  request: FastifyRequest,
  user: { id: string; role: string; email?: string },
): PlatformActor {
  const actor: PlatformActor = { id: user.id, role: user.role as PlatformRole, legacy: false, email: user.email };
  request.platformUser = actor;
  enterPlatformDatabaseContext({ actorId: actor.id, actorRole: actor.role });
  return actor;
}

type PlatformAuditTarget = { type: string; id?: string | null; tenantId?: string | null };

function platformAuditData(
  request: FastifyRequest | null,
  action: string,
  target: PlatformAuditTarget,
  metadata?: Prisma.InputJsonObject,
): Prisma.PlatformAuditEventUncheckedCreateInput {
  return {
    platformUserId: request?.platformUser && !request.platformUser.legacy ? request.platformUser.id : undefined,
    action,
    targetType: target.type,
    targetId: target.id ?? undefined,
    tenantId: target.tenantId ?? undefined,
    ipHash: hashV(request?.ip),
    userAgentHash: hashV(typeof request?.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null),
    metadata,
  };
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
        const [pu, loggedOut] = await Promise.all([
          platformDb.platformUser.findFirst({
            where: { id: payload.platformUserId, status: 'active' },
            select: { id: true, role: true, email: true },
          }),
          Number.isFinite(payload.sessionIssuedAtMs)
            ? platformSessionWasLoggedOut(payload.platformUserId, payload.sessionIssuedAtMs)
            : Promise.resolve(true),
        ]);
        if (pu && !loggedOut) {
          actor = { id: pu.id, role: pu.role as PlatformRole, legacy: false, email: pu.email };
        }
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
    if (actor.legacy) request.platformUser = actor;
    else attachPlatformActorContext(request, actor);
  };
}

// --- Platform audit (no tenant scope required; no PHI/secrets) --------------
export async function createPlatformAuditEvent(
  client: Prisma.TransactionClient,
  request: FastifyRequest | null,
  action: string,
  target: PlatformAuditTarget,
  metadata?: Prisma.InputJsonObject,
) {
  return client.platformAuditEvent.create({ data: platformAuditData(request, action, target, metadata) });
}

/**
 * Persist a standalone platform security event. Audit failure is deliberately
 * propagated: callers must never acknowledge a privileged action without its
 * security evidence.
 */
export async function platformAuditEvent(request: FastifyRequest | null, action: string, target: PlatformAuditTarget, metadata?: Prisma.InputJsonObject) {
  return platformDb.platformAuditEvent.create({ data: platformAuditData(request, action, target, metadata) });
}

/** Execute a platform-plane mutation and its audit evidence on one connection. */
export function runPlatformAuditedMutation<T>(
  request: FastifyRequest,
  event: (result: T) => { action: string; target: PlatformAuditTarget; metadata?: Prisma.InputJsonObject },
  mutate: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T>;
export function runPlatformAuditedMutation<T>(
  request: FastifyRequest,
  event: { action: string; target: PlatformAuditTarget; metadata?: Prisma.InputJsonObject },
  mutate: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T>;
export async function runPlatformAuditedMutation<T>(
  request: FastifyRequest,
  event: { action: string; target: PlatformAuditTarget; metadata?: Prisma.InputJsonObject } | ((result: T) => { action: string; target: PlatformAuditTarget; metadata?: Prisma.InputJsonObject }),
  mutate: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return platformDb.$transaction(async tx => {
    const result = await mutate(tx);
    const resolved = typeof event === 'function' ? event(result) : event;
    await createPlatformAuditEvent(tx, request, resolved.action, resolved.target, resolved.metadata);
    return result;
  });
}

// --- First PLATFORM_OWNER seed (env-only; no weak default in production) ----
export async function ensurePlatformOwnerSeed(): Promise<{ seeded: boolean; reason: string }> {
  const email = env.PLATFORM_OWNER_EMAIL;
  const password = env.PLATFORM_OWNER_PASSWORD;
  const name = env.PLATFORM_OWNER_NAME ?? 'Platform Owner';
  if (!email || !password) return { seeded: false, reason: 'env_not_set' };
  const passwordHash = await generatePasswordHash(password);
  return platformDb.$transaction(async tx => {
    const existing = await tx.platformUser.findUnique({ where: { email } });
    if (existing) return { seeded: false, reason: 'already_exists' };
    const owner = await tx.platformUser.create({
      data: { email, name, passwordHash, role: 'PLATFORM_OWNER', status: 'active' },
    });
    await tx.platformAuditEvent.create({
      data: {
        platformUserId: owner.id,
        action: 'platform.owner.seeded',
        targetType: 'platformUser',
        targetId: owner.id,
        metadata: { source: 'environment' },
      },
    });
    return { seeded: true, reason: 'created' };
  });
}
