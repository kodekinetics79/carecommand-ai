import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { getAutopilotDispatchCapability, reconcileAutopilotDispatchFailure, recordAutopilotDispatchQueued } from './dispatch';
import { enqueueAutopilotExecution } from '../../workers/queues';

function payloadRecord(payload: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, Prisma.JsonValue>
    : {};
}

function withDispatchState(payload: Prisma.JsonValue, state: 'pending_dispatch' | 'queued', detail?: Record<string, Prisma.JsonValue>) {
  return {
    ...payloadRecord(payload),
    dispatch: {
      state,
      recordedAt: new Date().toISOString(),
      ...detail,
    },
  } as Prisma.InputJsonValue;
}

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
    const dispatchAttemptId = randomUUID();
    const approval = await db.$transaction(async transaction => {
      const existing = await transaction.autopilotApproval.findFirst({
        where: { id, tenantId: request.auth.tenantId, status: 'PENDING' },
      });
      if (!existing) throw app.httpErrors.conflict('Approval is no longer pending');

      return transaction.autopilotApproval.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedById: request.auth.userId,
          reviewedAt: new Date(),
          payload: withDispatchState(existing.payload, 'pending_dispatch', { attemptId: dispatchAttemptId }),
        },
      });
    });
    const capability = getAutopilotDispatchCapability();
    const enqueue = await enqueueAutopilotExecution({ approvalId: approval.id, tenantId: request.auth.tenantId, dispatchAttemptId });
    let postedQueued = false;
    if (enqueue.state === 'queued') {
      const marked = await recordAutopilotDispatchQueued({
        approvalId: approval.id,
        tenantId: request.auth.tenantId,
        jobId: enqueue.jobId,
        dispatchAttemptId: enqueue.dispatchAttemptId,
      });
      postedQueued = marked.outcome === 'recorded' || marked.outcome === 'already_recorded';
    } else if (!capability.available) {
      // Queueing is intentionally unavailable in this runtime; keep the durable
      // row in a retryable "pending dispatch" state instead of fabricating a
      // terminal failure.
      postedQueued = true;
    }

    if (!postedQueued) {
      const reconciled = await reconcileAutopilotDispatchFailure({
        approvalId: approval.id,
        tenantId: request.auth.tenantId,
        code: 'enqueue_failed',
        dispatchAttemptId,
        jobId: enqueue.jobId,
      });
      void reconciled;
    }

    const refreshed = await db.autopilotApproval.findUniqueOrThrow({
      where: { id },
    });
    await audit(request, {
      action: 'autopilot.approval.approved',
      resource: 'autopilotApproval',
      resourceId: approval.id,
      metadata: {
        dispatchAttemptId,
        enqueueState: enqueue.state,
        dispatchQueued: postedQueued,
      },
    });
    const payloadDispatchState = payloadRecord(refreshed.payload).dispatch;
    const dispatchState = payloadDispatchState && typeof payloadDispatchState === 'object' && !Array.isArray(payloadDispatchState)
      ? (payloadDispatchState as Record<string, Prisma.JsonValue>).state
      : null;
    return {
      ...refreshed,
      dispatch: {
        capability,
        state: dispatchState === 'queued' ? 'queued'
          : dispatchState === 'dispatch_failed' ? 'dispatch_failed'
            : dispatchState === 'pending_dispatch' ? 'pending_dispatch'
              : 'pending_dispatch',
      },
    };
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
