import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { branchScope, assertBranchAccess } from '../../lib/scope';
import { requireRoles } from '../../plugins/roles';
import { audit } from '../../lib/audit';

const staffQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
});

const taskStatusInput = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELED']),
});

export const staffRoutes: FastifyPluginAsync = async app => {
  app.get('/overview', async request => {
    const query = staffQuery.parse(request.query);
    const rows = await db.staffProfile.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
      },
      orderBy: [{ bookingConversionRate: 'desc' }, { responseTime: 'asc' }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      include: {
        branch: { select: { name: true } },
        user: { select: { displayName: true } },
      },
    });

    return cursorPage(rows, query.limit);
  });

  app.patch('/tasks/:id/status', { preHandler: requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK') }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = taskStatusInput.parse(request.body);
    const existing = await db.staffTask.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
    });
    if (!existing) throw app.httpErrors.notFound('Task not found');
    if (existing.branchId) assertBranchAccess(request, existing.branchId);

    const task = await db.staffTask.update({
      where: { id: params.id },
      data: { status: input.status },
    });
    await audit(request, { action: 'task.status.updated', resource: 'staffTask', resourceId: task.id, metadata: { status: input.status } });
    return reply.send(task);
  });
};
