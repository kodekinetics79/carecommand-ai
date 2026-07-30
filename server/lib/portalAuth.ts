import { randomBytes, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Prisma } from '../generated/prisma/client';
import { db } from './db';
import { env } from '../config/env';
import { isFeatureEnabled } from './entitlements';
import { captureException } from './observability';
import { enterTenantContext, runWithTrustedTenantContext } from './tenantContext';

// Portal identity is separate from staff User. A portal JWT carries type:'portal'
// so it is rejected by the staff authenticate hook (type must be 'access') and
// vice-versa. Every portal request is scoped to one (tenantId, patientId).
export interface PortalActor { accountId: string; patientId: string; tenantId: string; email: string | null; sessionIdHash: string }
interface PortalJwt { portalAccountId: string; patientId: string; tenantId: string; type: 'portal'; jti: string }

declare module 'fastify' {
  interface FastifyRequest { portal?: PortalActor }
}

export const PORTAL_FEATURE_KEY = 'patient_crm'; // MVP gate (no separate patient_portal key yet)
const MAGIC_TTL_MINUTES = 15;
const SESSION_TTL_MINUTES = 30;
const RESEND_COOLDOWN_MS = 60_000; // idempotent request-link within 60s
const LOCKOUT_THRESHOLD = env.AUTH_LOCKOUT_THRESHOLD;
const LOCKOUT_MINUTES = env.AUTH_LOCKOUT_DURATION_MINUTES;

export async function issuePortalSession(
  app: FastifyInstance,
  account: { id: string; patientId: string; tenantId: string },
  client: Prisma.TransactionClient | typeof db = db,
): Promise<string> {
  const sessionId = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000);
  await client.patientPortalToken.create({
    data: {
      tenantId: account.tenantId,
      accountId: account.id,
      tokenHash: hashPortalSessionId(sessionId),
      type: 'session',
      expiresAt,
    },
  });
  return app.jwt.sign(
    { portalAccountId: account.id, patientId: account.patientId, tenantId: account.tenantId, type: 'portal', jti: sessionId } as PortalJwt,
    { expiresIn: SESSION_TTL_MINUTES * 60 },
  );
}

// Raw magic token (returned/sent) + its stored HMAC. Raw is never persisted.
export function createMagicToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashPortalToken(raw) };
}
export function hashPortalToken(raw: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`portal:${raw}`).digest('hex');
}
export function hashPortalSessionId(raw: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`portal-session:${raw}`).digest('hex');
}

export const portalConfig = { MAGIC_TTL_MINUTES, SESSION_TTL_MINUTES, RESEND_COOLDOWN_MS, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES };

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
    if (payload?.type !== 'portal' || !payload.portalAccountId || !payload.jti) {
      return reply.code(401).send({ error: 'portal_unauthorized', message: 'Sign in to continue.' });
    }
    const context = {
      tenantId: payload.tenantId,
      actorId: payload.portalAccountId,
      actorRole: 'PATIENT_PORTAL',
      source: 'portal' as const,
      requestId: request.id,
    };
    const sessionIdHash = hashPortalSessionId(payload.jti);
    const state = await runWithTrustedTenantContext(context, async tx => {
      const [account, session] = await Promise.all([
        tx.patientPortalAccount.findFirst({
          where: { id: payload.portalAccountId, tenantId: payload.tenantId, patientId: payload.patientId },
        }),
        tx.patientPortalToken.findFirst({
          where: {
            tenantId: payload.tenantId,
            accountId: payload.portalAccountId,
            tokenHash: sessionIdHash,
            type: 'session',
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        }),
      ]);
      return { account, session };
    });
    const account = state.account;
    if (!account || account.status !== 'active' || !state.session) {
      return reply.code(401).send({ error: 'portal_unauthorized', message: 'This account is not active.' });
    }
    enterTenantContext(context);
    // Suspended/archived tenants block portal access (payment links remain via the
    // separate public payment-token route, not the authenticated portal).
    const tenant = await db.tenant.findUnique({ where: { id: account.tenantId }, select: { status: true } });
    if (!tenant || tenant.status === 'suspended' || tenant.status === 'archived') {
      return reply.code(403).send({ error: 'portal_unavailable', message: 'The portal is temporarily unavailable.' });
    }
    request.portal = { accountId: account.id, patientId: account.patientId, tenantId: account.tenantId, email: account.email, sessionIdHash };
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
//
// Audit-loss policy:
//   critical: true  — the action grants access or touches PHI/payment. The write
//                     is awaited and a failure THROWS, so the portal action fails
//                     (500 via the error plugin, which also captures it) rather
//                     than proceeding unaudited.
//   default         — never blocks the portal action, but the failure is REPORTED
//                     through the observability seam with id-only context (never
//                     swallowed silently).
export interface PortalAuditOptions {
  critical?: boolean;
  /**
   * Critical portal mutations pass their transaction client here so the
   * regulated state change and its audit evidence commit or roll back as one
   * unit. Callers must not pass a transaction client that outlives its callback.
   */
  tx?: Prisma.TransactionClient;
}

export async function portalAudit(tenantId: string, action: string, resourceId: string | null, request: FastifyRequest | null, metadata?: Prisma.InputJsonObject, options?: PortalAuditOptions) {
  try {
    const client = options?.tx ?? db;
    await client.auditEvent.create({
      data: {
        tenantId, actorUserId: null, action, resource: 'portal', resourceId,
        requestId: request?.id ?? null,
        userAgent: hashUa(request?.headers['user-agent']),
        metadata: metadata ?? undefined,
      },
    });
  } catch (cause) {
    // Id-only wrapper: action names and ids are not PHI; the DB error stays in `cause`.
    const error = new Error(`portal audit write failed (action=${action})`, { cause });
    if (options?.critical) throw error; // regulated action must not proceed unaudited
    captureException(error, { requestId: request?.id, tenantId }, request?.log);
  }
}
function hashUa(ua: string | string[] | undefined): string | null {
  const v = Array.isArray(ua) ? ua[0] : ua;
  if (!v) return null;
  return createHmac('sha256', env.JWT_SECRET).update(`ua:${v}`).digest('hex').slice(0, 24);
}
