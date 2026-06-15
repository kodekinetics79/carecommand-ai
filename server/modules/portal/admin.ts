import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { createMagicToken, portalConfig } from '../../lib/portalAuth';

const uuid = z.string().uuid();
const onboardRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK');

// Staff-facing portal onboarding: review self-signup requests that did NOT
// uniquely match a patient, and invite/grant access by binding to a verified
// patient record. Tenant-scoped, RBAC'd, audited.
export const portalAdminRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', onboardRoles);

  // Pending (or resolved) portal access requests.
  app.get('/access-requests', async request => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }).parse(request.query);
    return db.portalAccessRequest.findMany({ where: { tenantId: request.auth.tenantId, status: q.status }, orderBy: { createdAt: 'desc' }, take: 100 });
  });

  // Approve → bind to a verified patient, create the invited account + OTP.
  app.post('/access-requests/:id/approve', async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { patientId } = z.object({ patientId: uuid }).parse(request.body);
    const tenantId = request.auth.tenantId;
    const req = await db.portalAccessRequest.findFirst({ where: { id, tenantId } });
    if (!req) throw app.httpErrors.notFound('Request not found');
    if (req.status !== 'pending') throw app.httpErrors.badRequest('Request already resolved');
    const patient = await db.patient.findFirst({ where: { id: patientId, tenantId, deletedAt: null }, select: { id: true, email: true, phone: true } });
    if (!patient) throw app.httpErrors.badRequest('Patient not found in this workspace');

    const account = await db.patientPortalAccount.upsert({
      where: { tenantId_patientId: { tenantId, patientId } },
      create: { tenantId, patientId, email: patient.email ?? req.email, phone: patient.phone ?? req.phone, status: 'invited' },
      update: {},
    });
    const t = createMagicToken();
    await db.patientPortalToken.create({ data: { tenantId, accountId: account.id, tokenHash: t.hash, type: 'magic_login', expiresAt: new Date(Date.now() + portalConfig.MAGIC_TTL_MINUTES * 60_000) } });
    await db.portalAccessRequest.update({ where: { id }, data: { status: 'approved', resolvedByUserId: request.auth.userId, resolvedAt: new Date() } });
    await audit(request, { action: 'portal.access_request.approved', resource: 'portalAccessRequest', resourceId: id, metadata: { patientId } });
    return reply.send({ accountId: account.id, status: account.status, ...(env.NODE_ENV !== 'production' ? { devToken: t.raw, devNote: 'Dev only — relay this code to the patient.' } : {}) });
  });

  // Reject → close the request with a reason.
  app.post('/access-requests/:id/reject', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).parse(request.body ?? {});
    const tenantId = request.auth.tenantId;
    const req = await db.portalAccessRequest.findFirst({ where: { id, tenantId } });
    if (!req) throw app.httpErrors.notFound('Request not found');
    const row = await db.portalAccessRequest.update({ where: { id }, data: { status: 'rejected', note: reason, resolvedByUserId: request.auth.userId, resolvedAt: new Date() }, select: { id: true, status: true } });
    await audit(request, { action: 'portal.access_request.rejected', resource: 'portalAccessRequest', resourceId: id });
    return row;
  });
};
