import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { platformDb } from '../../lib/platformDb';
import { buildPilotChecklist, hashPilotShareToken } from '../../lib/pilotStatus';
import { hashV } from '../../lib/platformAuth';
import { enterTenantContext } from '../../lib/tenantContext';
import { resolveIngressTenant } from '../../lib/tenantIngressResolvers';

const tokenParam = z.object({ token: z.string().min(12).max(120) });

export const pilotPublicRoutes: FastifyPluginAsync = async app => {
  app.get('/share/:token', async (request, reply) => {
    const { token } = tokenParam.parse(request.params);
    const tokenHash = hashPilotShareToken(token);
    const resolved = await resolveIngressTenant('pilot_share_hash', tokenHash);
    if (!resolved) return reply.code(404).send({ error: 'not_found', message: 'This pilot link is invalid or has expired.' });
    enterTenantContext({ tenantId: resolved.tenantId, actorId: resolved.resourceId, actorRole: 'PILOT_SHARE', source: 'portal', requestId: request.id });
    const share = await db.pilotStatusShare.findFirst({ where: { id: resolved.resourceId, tokenHash }, include: { tenant: { select: { id: true, name: true, slug: true } } } });
    if (!share || share.expiresAt.getTime() < Date.now()) return reply.code(404).send({ error: 'not_found', message: 'This pilot link is invalid or has expired.' });

    const checklist = await buildPilotChecklist(share.tenantId);
    if (!checklist) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });

    const auditMetadata = { shareId: share.id, label: share.label, expiresAt: share.expiresAt.toISOString() };
    await platformDb.platformAuditEvent.create({
      data: {
        action: 'pilot.status_link.view.requested',
        targetType: 'tenant',
        targetId: share.tenantId,
        tenantId: share.tenantId,
        ipHash: hashV(request.ip),
        userAgentHash: hashV(typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null),
        metadata: auditMetadata,
      },
    });
    await db.$transaction(async tx => {
      await tx.pilotStatusShare.update({ where: { id: share.id }, data: { lastViewedAt: new Date() } });
      await tx.auditEvent.create({
        data: {
          tenantId: share.tenantId,
          actorUserId: null,
          action: 'pilot.status_link.viewed',
          resource: 'pilotStatusShare',
          resourceId: share.id,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: auditMetadata,
        },
      });
    });

    return {
      link: {
        label: share.label,
        expiresAt: share.expiresAt.toISOString(),
        active: true,
      },
      clinic: {
        id: share.tenant.id,
        name: share.tenant.name,
        slug: share.tenant.slug,
      },
      checklist,
    };
  });
};
