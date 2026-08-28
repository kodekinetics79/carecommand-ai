import { randomBytes, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '../generated/prisma/client';
import { db } from './db';
import { env } from '../config/env';
import { isFeatureEnabled } from './entitlements';

// Portal identity is separate from staff User. A portal JWT carries type:'portal'
// so it is rejected by the staff authenticate hook (type must be 'access') and
// vice-versa. Every portal request is scoped to one (tenantId, patientId).
export interface PortalActor { accountId: string; patientId: string; tenantId: string; email: string | null }
interface PortalJwt { portalAccountId: string; patientId: string; tenantId: string; type: 'portal' }

declare module 'fastify' {
  interface FastifyRequest { portal?: PortalActor }
}

export const PORTAL_FEATURE_KEY = 'patient_crm'; // MVP gate (no separate patient_portal key yet)
const MAGIC_TTL_MINUTES = 15;
const SESSION_TTL = '12h';
const RESEND_COOLDOWN_MS = 60_000; // idempotent request-link within 60s
const LOCKOUT_THRESHOLD = env.AUTH_LOCKOUT_THRESHOLD;
const LOCKOUT_MINUTES = env.AUTH_LOCKOUT_DURATION_MINUTES;

export function signPortalSession(app: FastifyInstance, account: { id: string; patientId: string; tenantId: string }): string {
  return app.jwt.sign({ portalAccountId: account.id, patientId: account.patientId, tenantId: account.tenantId, type: 'portal' } as PortalJwt, { expiresIn: SESSION_TTL });
}

// Raw magic token (returned/sent) + its stored HMAC. Raw is never persisted.
export function createMagicToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashPortalToken(raw) };
}
export function hashPortalToken(raw: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`portal:${raw}`).digest('hex');
}

export const portalConfig = { MAGIC_TTL_MINUTES, RESEND_COOLDOWN_MS, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES };

// preHandler: require a valid portal session JWT. Loads the account (must be
// active) and a non-suspended tenant, then scopes the request to that patient.
export function requirePortalAccess() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    let payload: PortalJwt;
    try {
      payload = await request.jwtVerify<PortalJwt>();
    } catch {
      return reply.code(401).send({ error: 'portal_unauthorized', message: 'Sign in to continue.' });
    }
    if (payload?.type !== 'portal' || !payload.portalAccountId) {
      return reply.code(401).send({ error: 'portal_unauthorized', message: 'Sign in to continue.' });
    }
    const account = await db.patientPortalAccount.findFirst({ where: { id: payload.portalAccountId, tenantId: payload.tenantId, patientId: payload.patientId } });
    if (!account || account.status !== 'active') {
      return reply.code(401).send({ error: 'portal_unauthorized', message: 'This account is not active.' });
    }
    // Suspended/archived tenants block portal access (payment links remain via the
    // separate public payment-token route, not the authenticated portal).
    const tenant = await db.tenant.findUnique({ where: { id: account.tenantId }, select: { status: true } });
    if (!tenant || tenant.status === 'suspended' || tenant.status === 'archived') {
      return reply.code(403).send({ error: 'portal_unavailable', message: 'The portal is temporarily unavailable.' });
    }
    request.portal = { accountId: account.id, patientId: account.patientId, tenantId: account.tenantId, email: account.email };
  };
}

// Entitlement gate — portal availability follows the tenant subscription.
export function requirePortalFeature() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.portal?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'portal_unauthorized' });
    if (!(await isFeatureEnabled(tenantId, PORTAL_FEATURE_KEY))) {
      return reply.code(403).send({ error: 'feature_locked', feature: PORTAL_FEATURE_KEY, message: 'The patient portal is not enabled for this clinic.' });
    }
  };
}

// Tenant-scoped audit (no PHI bodies, no secrets). Writes to the tenant AuditEvent
// log with a portal.* action; actorUserId stays null (patient, not staff).
export async function portalAudit(tenantId: string, action: string, resourceId: string | null, request: FastifyRequest | null, metadata?: Prisma.InputJsonObject) {
  await db.auditEvent.create({
    data: {
      tenantId, actorUserId: null, action, resource: 'portal', resourceId,
      requestId: request?.id ?? null,
      userAgent: hashUa(request?.headers['user-agent']),
      metadata: metadata ?? undefined,
    },
  }).catch(() => { /* never block a portal action on audit write */ });
}
function hashUa(ua: string | string[] | undefined): string | null {
  const v = Array.isArray(ua) ? ua[0] : ua;
  if (!v) return null;
  return createHmac('sha256', env.JWT_SECRET).update(`ua:${v}`).digest('hex').slice(0, 24);
}
