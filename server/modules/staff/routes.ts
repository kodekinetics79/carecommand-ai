import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { branchScope, assertBranchAccess } from '../../lib/scope';
import { getRequestPermissions, requirePermission } from '../../lib/permissions';
import { runWithTenantContext } from '../../lib/tenantContext';

const staffQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
});

const taskStatusInput = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELED']),
});

const taskAssignmentInput = z.object({
  assignedToId: z.string().uuid().nullable(),
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
      // Same shape on every path so the queue can replace a row from any reply.
      const taskInclude = { branch: { select: { name: true } }, assignedTo: { select: { displayName: true } } } as const;
      if (existing.status === input.status) {
        const unchanged = await tx.staffTask.findFirstOrThrow({ where: { id: existing.id, tenantId: request.auth.tenantId }, include: taskInclude });
        return { kind: 'updated' as const, task: unchanged };
      }
      const task = await tx.staffTask.update({ where: { id: existing.id }, data: { status: input.status }, include: taskInclude });
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

  // People a task can actually be handed to. Gated on staff:write because only a
  // caller who may assign to someone else needs the roster; a caller who can
  // only take work themselves never sees it.
  app.get('/assignees', { preHandler: requirePermission('staff:write') }, async request => {
    const rows = await db.user.findMany({
      where: {
        tenantId: request.auth.tenantId,
        active: true,
        // A branch-restricted caller may only hand work to someone who can see
        // that branch: their own branch, or a tenant-wide (unscoped) user.
        ...(request.auth.branchId ? { OR: [{ branchId: request.auth.branchId }, { branchId: null }] } : {}),
      },
      orderBy: [{ displayName: 'asc' }],
      take: 200,
      select: { id: true, displayName: true, role: true, branchId: true },
    });
    return rows;
  });

  // Assignment. Until now nothing in the product could put a name on a task, so
  // every row read "Unassigned" forever. Taking a task yourself needs only the
  // grant that already lets you move its status; handing work to someone else is
  // a different act and needs staff:write.
  app.patch('/tasks/:id/assignment', { preHandler: requirePermission('staff:task-status') }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = taskAssignmentInput.parse(request.body);
    const permissions = await getRequestPermissions(request);
    const canAssignOthers = permissions.has('staff:write');

    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-task:${request.auth.tenantId}:${params.id}`}::text, 0))::text AS locked`;
      const existing = await tx.staffTask.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
      if (!existing) return { kind: 'not_found' as const };
      if (existing.branchId) assertBranchAccess(request, existing.branchId);
      if (existing.status === 'COMPLETED' || existing.status === 'CANCELED') return { kind: 'terminal' as const };

      const claimingSelf = input.assignedToId === request.auth.userId;
      const releasingOwn = input.assignedToId === null && existing.assignedToId === request.auth.userId;
      if (!canAssignOthers && !claimingSelf && !releasingOwn) return { kind: 'forbidden' as const };

      if (input.assignedToId) {
        const assignee = await tx.user.findFirst({
          where: { id: input.assignedToId, tenantId: request.auth.tenantId, active: true },
          select: { id: true, branchId: true },
        });
        if (!assignee) return { kind: 'invalid_assignee' as const };
        // A branch-scoped user's own queue filters to their branch, so assigning
        // them another branch's task would file work they can never see.
        if (assignee.branchId && existing.branchId && assignee.branchId !== existing.branchId) {
          return { kind: 'branch_mismatch' as const };
        }
      }

      if (existing.assignedToId === input.assignedToId) {
        const unchanged = await tx.staffTask.findFirstOrThrow({
          where: { id: existing.id, tenantId: request.auth.tenantId },
          include: { branch: { select: { name: true } }, assignedTo: { select: { displayName: true } } },
        });
        return { kind: 'updated' as const, task: unchanged };
      }

      const task = await tx.staffTask.update({
        where: { id: existing.id },
        data: { assignedToId: input.assignedToId },
        include: { branch: { select: { name: true } }, assignedTo: { select: { displayName: true } } },
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'task.assignment.updated', resource: 'staffTask', resourceId: task.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { fromAssignedToId: existing.assignedToId, toAssignedToId: input.assignedToId, selfClaim: claimingSelf },
      } });
      return { kind: 'updated' as const, task };
    });

    if (result.kind === 'not_found') throw app.httpErrors.notFound('Task not found');
    if (result.kind === 'terminal') throw app.httpErrors.conflict('Completed or canceled tasks are final and cannot be reassigned');
    if (result.kind === 'forbidden') throw app.httpErrors.forbidden('Your role can take a task itself but cannot assign work to another person');
    if (result.kind === 'invalid_assignee') throw app.httpErrors.badRequest('Assignee must be an active user in the authenticated tenant');
    if (result.kind === 'branch_mismatch') throw app.httpErrors.badRequest('Assignee is restricted to a different branch and would not see this task');
    return reply.send(result.task);
  });
};
