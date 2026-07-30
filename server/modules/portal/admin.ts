import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { requireRoles } from '../../plugins/roles';
import { createMagicToken, portalConfig } from '../../lib/portalAuth';
import { deliverPortalToken } from '../../lib/portalDelivery';

const uuid = z.string().uuid();
const onboardRoles = requireRoles('OWNER', 'ADMIN');
const PENDING_MAGIC_LOGIN = 'pending_magic_login';

// Staff-facing portal onboarding: review self-signup requests that did NOT
// uniquely match a patient, and invite/grant access by binding to a verified
// patient record. Tenant-scoped, RBAC'd, audited.
export const portalAdminRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', async request => {
    await onboardRoles(request);
    // Portal identity approval spans all patients in a tenant and must not be
    // exposed to a branch-restricted identity. This is intentionally stricter
    // than simply adding a patient branch filter: unmatched requests have no
    // trustworthy branch until an authorized reviewer resolves identity.
    if (request.auth.branchId) throw app.httpErrors.forbidden('Portal access review requires tenant-wide administrative access');
  });

  // Pending (or resolved) portal access requests.
  app.get('/access-requests', async request => {
    const q = z.object({ status: z.enum(['pending', 'delivery_pending', 'approved', 'rejected']).default('pending') }).parse(request.query);
    return db.portalAccessRequest.findMany({ where: { tenantId: request.auth.tenantId, status: q.status }, orderBy: { createdAt: 'desc' }, take: 100 });
  });

  // Approve → bind to a verified patient, create the invited account + OTP.
  app.post('/access-requests/:id/approve', async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { patientId, authority, authorityConfirmed } = z.object({
      patientId: uuid,
      authority: z.enum(['self', 'guardian']),
      authorityConfirmed: z.literal(true),
    }).parse(request.body);
    const tenantId = request.auth.tenantId;
    const req = await db.portalAccessRequest.findFirst({ where: { id, tenantId } });
    if (!req) throw app.httpErrors.notFound('Request not found');
    if (req.status !== 'pending') throw app.httpErrors.badRequest('Request already resolved');
    const patient = await db.patient.findFirst({ where: { id: patientId, tenantId, deletedAt: null }, select: { id: true, email: true, phone: true, dateOfBirth: true } });
    if (!patient) throw app.httpErrors.badRequest('Patient not found in this workspace');
    const adultCutoff = new Date();
    adultCutoff.setUTCFullYear(adultCutoff.getUTCFullYear() - 18);
    const knownAdult = patient.dateOfBirth !== null && patient.dateOfBirth <= adultCutoff;
    // Proxy/guardian identities are not represented by PatientPortalAccount.
    // Never turn an asserted guardian checkbox into a patient-self credential:
    // keep the request pending until a real, scoped proxy-authority model exists.
    if (!knownAdult || authority === 'guardian') {
      await db.auditEvent.create({ data: {
        tenantId, actorUserId: request.auth.userId, action: 'portal.access_request.proxy_blocked',
        resource: 'portalAccessRequest', resourceId: id, requestId: request.id,
        ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { patientId, authority, reason: 'proxy_access_not_supported', requestPreserved: true },
      } });
      return reply.code(409).send({
        error: 'proxy_access_not_supported',
        message: 'Guardian or proxy portal access is not supported yet. This request remains pending for staff follow-up; no patient portal credential was created.',
        requestStatus: 'pending',
      });
    }

    const t = createMagicToken();
    const deliveryRequired = env.NODE_ENV === 'production' || Boolean(env.PORTAL_TOKEN_OUTBOX_PATH);
    const account = await db.$transaction(async tx => {
      // Compare-and-set ensures concurrent reviewers cannot both approve and
      // mint credentials. Account, token, request state, and audit are atomic.
      const claimed = await tx.portalAccessRequest.updateMany({
        where: { id, tenantId, status: 'pending' },
        data: { status: deliveryRequired ? 'delivery_pending' : 'approved', resolvedByUserId: request.auth.userId, resolvedAt: deliveryRequired ? null : new Date() },
      });
      if (claimed.count !== 1) throw app.httpErrors.conflict('Request was already resolved by another reviewer');
      const portalAccount = await tx.patientPortalAccount.upsert({
        where: { tenantId_patientId: { tenantId, patientId } },
        create: { tenantId, patientId, email: patient.email ?? req.email, phone: patient.phone ?? req.phone, status: 'invited' },
        update: { email: patient.email ?? req.email, phone: patient.phone ?? req.phone },
      });
      if (portalAccount.status === 'disabled') throw app.httpErrors.conflict('The patient portal account is disabled and requires separate review');
      if (!portalAccount.email && !portalAccount.phone) throw app.httpErrors.unprocessableEntity('A verified delivery destination is required before portal access can be granted');
      await tx.patientPortalToken.create({ data: { tenantId, accountId: portalAccount.id, tokenHash: t.hash, type: deliveryRequired ? PENDING_MAGIC_LOGIN : 'magic_login', expiresAt: new Date(Date.now() + portalConfig.MAGIC_TTL_MINUTES * 60_000) } });
      await tx.auditEvent.create({ data: {
        tenantId, actorUserId: request.auth.userId, action: deliveryRequired ? 'portal.access_request.delivery_started' : 'portal.access_request.approved',
        resource: 'portalAccessRequest', resourceId: id, requestId: request.id,
        ipAddress: request.ip, userAgent: request.headers['user-agent'], metadata: { patientId, authority, authorityConfirmed },
      } });
      return portalAccount;
    });
    if (deliveryRequired) {
      const delivery = await deliverPortalToken({ tenantId, patientId, accountId: account.id, token: t.raw, email: account.email, phone: account.phone, purpose: 'staff-approval' });
      if (!delivery.ok) {
        await db.$transaction(async tx => {
          await tx.patientPortalToken.deleteMany({ where: { accountId: account.id, tokenHash: t.hash, type: PENDING_MAGIC_LOGIN, usedAt: null } });
          await tx.portalAccessRequest.updateMany({ where: { id, tenantId, status: 'delivery_pending' }, data: { status: 'pending', resolvedByUserId: null, resolvedAt: null, note: 'Credential delivery failed; retry approval after provider recovery.' } });
          await tx.auditEvent.create({ data: { tenantId, actorUserId: request.auth.userId, action: 'portal.access_request.delivery_failed', resource: 'portalAccessRequest', resourceId: id, requestId: request.id, metadata: { mode: delivery.mode, status: delivery.status } } });
        });
        return reply.code(503).send({ error: 'delivery_unavailable', message: 'Portal credential delivery is unavailable; the request remains pending.' });
      }
      try {
        await db.$transaction(async tx => {
          const promoted = await tx.patientPortalToken.updateMany({ where: { accountId: account.id, tokenHash: t.hash, type: PENDING_MAGIC_LOGIN, usedAt: null }, data: { type: 'magic_login' } });
          const approved = await tx.portalAccessRequest.updateMany({ where: { id, tenantId, status: 'delivery_pending', resolvedByUserId: request.auth.userId }, data: { status: 'approved', resolvedAt: new Date(), note: null } });
          if (promoted.count !== 1 || approved.count !== 1) throw new Error('portal approval delivery finalization failed');
          await tx.auditEvent.create({ data: { tenantId, actorUserId: request.auth.userId, action: 'portal.access_request.approved', resource: 'portalAccessRequest', resourceId: id, requestId: request.id, metadata: { patientId, authority, authorityConfirmed, deliveryMode: delivery.mode } } });
        });
      } catch (error) {
        request.log.error({ err: error }, 'portal approval activation failed after confirmed delivery');
        return reply.code(503).send({ error: 'approval_pending', message: 'Delivery was confirmed but access activation is pending administrative recovery.' });
      }
    }
    return reply.send({ accountId: account.id, status: account.status, ...(!deliveryRequired ? { devToken: t.raw, devNote: 'Dev/test only — relay this code through the approved local test flow.' } : {}) });
  });

  // Reject → close the request with a reason.
  app.post('/access-requests/:id/reject', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).parse(request.body ?? {});
    const tenantId = request.auth.tenantId;
    const req = await db.portalAccessRequest.findFirst({ where: { id, tenantId } });
    if (!req) throw app.httpErrors.notFound('Request not found');
    if (req.status !== 'pending') throw app.httpErrors.conflict('Request was already resolved');
    return db.$transaction(async tx => {
      const changed = await tx.portalAccessRequest.updateMany({ where: { id, tenantId, status: 'pending' }, data: { status: 'rejected', note: reason, resolvedByUserId: request.auth.userId, resolvedAt: new Date() } });
      if (changed.count !== 1) throw app.httpErrors.conflict('Request was already resolved by another reviewer');
      await tx.auditEvent.create({ data: {
        tenantId, actorUserId: request.auth.userId, action: 'portal.access_request.rejected',
        resource: 'portalAccessRequest', resourceId: id, requestId: request.id,
        ipAddress: request.ip, userAgent: request.headers['user-agent'],
      } });
      return { id, status: 'rejected' };
    });
  });
};
