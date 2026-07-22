import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { db } from './db';
import type { Prisma } from '../generated/prisma/client';

// ===========================================================================
// LEGACY / DEV-ONLY platform operator access. The production-grade path is the
// Platform Admin Console (PlatformUser identity + platform JWT, see
// server/lib/platformAuth.ts). This static `PLATFORM_API_TOKEN` is retained for
// backward compatibility and local dev only — `requirePlatformAccess` accepts it
// and maps it to a synthetic PLATFORM_OWNER. It is NOT a tenant role and tenant
// JWTs can never satisfy it. Do not expose this token in the UI; remove once all
// operators have migrated to PlatformUser accounts.
// ===========================================================================

const DEV_PLATFORM_TOKEN = 'dev-platform-operator-token';

export function effectivePlatformToken(): string | null {
  if (env.PLATFORM_API_TOKEN && (env.NODE_ENV !== 'production' || env.PLATFORM_LEGACY_TOKEN_ENABLED)) return env.PLATFORM_API_TOKEN;
  if (env.NODE_ENV !== 'production') return DEV_PLATFORM_TOKEN;
  return null; // production without an explicit legacy-token break-glass opt-in
}

export async function requirePlatformOperator(request: FastifyRequest, reply: FastifyReply) {
  const expected = effectivePlatformToken();
  if (!expected) {
    return reply.code(503).send({ error: 'platform_disabled', message: 'Platform operator access is not configured.' });
  }
  const headerToken = request.headers['x-platform-token'];
  const authHeader = request.headers.authorization;
  const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const providedRaw = headerToken ?? bearer;
  const provided = Array.isArray(providedRaw) ? providedRaw[0] : providedRaw;
  if (!provided) {
    return reply.code(401).send({ error: 'platform_unauthorized', message: 'Platform operator token required.' });
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return reply.code(401).send({ error: 'platform_unauthorized', message: 'Invalid platform operator token.' });
  }
}

// Platform actions have no tenant session, so audit directly (system actor).
export async function platformAudit(tenantId: string, action: string, resourceId: string | null, metadata?: Prisma.InputJsonObject) {
  await db.auditEvent.create({
    data: { tenantId, actorUserId: null, action, resource: 'platform', resourceId: resourceId ?? undefined, userAgent: 'platform-operator', metadata },
  });
}
