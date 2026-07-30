import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { branchScope, assertBranchAccess } from '../../lib/scope';
import { requirePermission } from '../../lib/permissions';
import { runWithTenantContext } from '../../lib/tenantContext';

const staffQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
});

const taskStatusInput = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELED']),
});

export const staffRoutes: FastifyPluginAsync = async app => {
  app.get('/overview', { preHandler: requirePermission('staff:read') }, async request => {
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

  app.patch('/tasks/:id/status', { preHandler: requirePermission('staff:task-status') }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = taskStatusInput.parse(request.body);
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-task:${request.auth.tenantId}:${params.id}`}::text, 0))::text AS locked`;
      const existing = await tx.staffTask.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
      if (!existing) return { kind: 'not_found' as const };
      if (existing.branchId) assertBranchAccess(request, existing.branchId);
      if ((existing.status === 'COMPLETED' || existing.status === 'CANCELED') && existing.status !== input.status) {
        return { kind: 'terminal' as const };
      }
      if (existing.status === input.status) return { kind: 'updated' as const, task: existing };
      const task = await tx.staffTask.update({ where: { id: existing.id }, data: { status: input.status } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'task.status.updated', resource: 'staffTask', resourceId: task.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { fromStatus: existing.status, toStatus: input.status },
      } });
      return { kind: 'updated' as const, task };
    });
    if (result.kind === 'not_found') throw app.httpErrors.notFound('Task not found');
    if (result.kind === 'terminal') throw app.httpErrors.conflict('Completed or canceled tasks are final and cannot be reopened');
    return reply.send(result.task);
  });
};
