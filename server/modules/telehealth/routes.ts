import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { requirePermission } from '../../lib/permissions';
import { branchScope } from '../../lib/scope';

const sessionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  branchId: z.string().uuid().optional(),
});

export const telehealthRoutes: FastifyPluginAsync = async app => {
  // Virtual visits are appointments booked on the VIDEO channel.
  app.get('/sessions', { preHandler: requirePermission('appointment:read') }, async request => {
    const query = sessionQuery.parse(request.query);
    const rows = await db.appointment.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
        channel: 'VIDEO',
        deletedAt: null,
      },
      orderBy: { startsAt: 'asc' },
      take: query.limit,
      include: {
        patient: { select: { firstName: true, lastName: true } },
        branch: { select: { name: true } },
      },
    });

    return rows.map(row => ({
      id: row.id,
      patientName: `${row.patient.firstName} ${row.patient.lastName}`,
      service: row.service,
      startsAt: row.startsAt.toISOString(),
      status: row.status,
      provider: row.providerRef ?? 'Assigned provider',
      branchName: row.branch.name,
      value: row.value.toString(),
      noShowRisk: row.noShowRisk,
      // No dedicated intake table yet: treat confirmed/arrived/completed visits as intake-complete.
      intakeComplete: ['CONFIRMED', 'ARRIVED', 'COMPLETED'].includes(row.status),
    }));
  });
};
