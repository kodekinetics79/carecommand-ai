import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { enqueueAutopilotExecution } from '../../workers/queues';

export const autopilotRoutes: FastifyPluginAsync = async app => {
  app.get('/playbooks', async request => {
    return db.autopilotPlaybook.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { name: 'asc' },
    });
  });

  app.get('/approvals', async request => {
    const query = z.object({
      status: z.enum(['PENDING', 'APPROVED', 'DISMISSED', 'EXECUTED', 'FAILED']).default('PENDING'),
    }).parse(request.query);
    return db.autopilotApproval.findMany({
      where: { tenantId: request.auth.tenantId, status: query.status },
      orderBy: { createdAt: 'desc' },
      include: { playbook: { select: { key: true, name: true } } },
    });
  });

  app.post('/approvals/:id/approve', { preHandler: requireRoles('OWNER', 'ADMIN', 'MANAGER') }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const approval = await db.$transaction(async transaction => {
      const existing = await transaction.autopilotApproval.findFirst({
        where: { id, tenantId: request.auth.tenantId, status: 'PENDING' },
      });
      if (!existing) throw app.httpErrors.conflict('Approval is no longer pending');

      return transaction.autopilotApproval.update({
        where: { id },
        data: { status: 'APPROVED', reviewedById: request.auth.userId, reviewedAt: new Date() },
      });
    });
    await enqueueAutopilotExecution({ approvalId: approval.id, tenantId: request.auth.tenantId });
    await audit(request, { action: 'autopilot.approval.approved', resource: 'autopilotApproval', resourceId: approval.id });
    return approval;
  });

  app.post('/approvals/:id/dismiss', { preHandler: requireRoles('OWNER', 'ADMIN', 'MANAGER') }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const approval = await db.autopilotApproval.updateMany({
      where: { id, tenantId: request.auth.tenantId, status: 'PENDING' },
      data: { status: 'DISMISSED', reviewedById: request.auth.userId, reviewedAt: new Date() },
    });
    if (approval.count === 0) throw app.httpErrors.conflict('Approval is no longer pending');
    await audit(request, { action: 'autopilot.approval.dismissed', resource: 'autopilotApproval', resourceId: id });
    return { id, status: 'DISMISSED' };
  });
};
