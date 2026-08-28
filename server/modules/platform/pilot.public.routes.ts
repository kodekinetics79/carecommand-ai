import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { buildPilotChecklist, hashPilotShareToken } from '../../lib/pilotStatus';

const tokenParam = z.object({ token: z.string().min(12).max(120) });

export const pilotPublicRoutes: FastifyPluginAsync = async app => {
  app.get('/share/:token', async (request, reply) => {
    const { token } = tokenParam.parse(request.params);
    const tokenHash = hashPilotShareToken(token);
    const share = await db.pilotStatusShare.findFirst({ where: { tokenHash }, include: { tenant: { select: { id: true, name: true, slug: true } } } });
    if (!share || share.expiresAt.getTime() < Date.now()) return reply.code(404).send({ error: 'not_found', message: 'This pilot link is invalid or has expired.' });

    const checklist = await buildPilotChecklist(share.tenantId);
    if (!checklist) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });

    await db.pilotStatusShare.update({ where: { id: share.id }, data: { lastViewedAt: new Date() } });
    await db.platformAuditEvent.create({
      data: {
        action: 'pilot.status_link.viewed',
        targetType: 'tenant',
        targetId: share.tenantId,
        tenantId: share.tenantId,
        metadata: { shareId: share.id, label: share.label, expiresAt: share.expiresAt.toISOString() },
      },
    }).catch(() => {});

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
