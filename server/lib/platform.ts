import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { db } from './db';
import type { Prisma } from '../generated/prisma/client';

// ===========================================================================
// Platform operator access — DELIBERATELY separate from tenant UserRole.
// Operators authenticate with a static platform token (env PLATFORM_API_TOKEN)
// presented as `X-Platform-Token` (or Bearer). This is NOT a tenant role and
// tenant JWTs can never satisfy it. In production the token MUST be set; in
// dev a clearly-marked default is allowed for local operator testing.
// ===========================================================================

const DEV_PLATFORM_TOKEN = 'dev-platform-operator-token';

export function effectivePlatformToken(): string | null {
  if (env.PLATFORM_API_TOKEN) return env.PLATFORM_API_TOKEN;
  if (env.NODE_ENV !== 'production') return DEV_PLATFORM_TOKEN;
  return null; // production without a configured token → platform disabled
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
