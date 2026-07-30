import type { FastifyRequest } from 'fastify';
import type { Prisma } from '../generated/prisma/client';
import { runWithTenantContext } from './tenantContext';

interface AuditInput {
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Prisma.InputJsonObject;
}

export async function audit(request: FastifyRequest, input: AuditInput) {
  await runWithTenantContext(request.auth.tenantId, tx => tx.auditEvent.create({
    data: {
      tenantId: request.auth.tenantId,
      actorUserId: request.auth.userId,
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId,
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: input.metadata,
    },
  }));
}
