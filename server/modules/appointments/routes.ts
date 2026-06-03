import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requireRoles } from '../../plugins/roles';
import { assertBranchAccess, branchScope } from '../../lib/scope';

const appointmentQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(['CONFIRMED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'COMPLETED', 'WAITLIST']).optional(),
});

const appointmentInput = z.object({
  branchId: z.string().uuid(),
  patientId: z.string().uuid(),
  providerRef: z.string().trim().max(120).optional(),
  service: z.string().trim().min(2).max(160),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  status: z.enum(['CONFIRMED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'COMPLETED', 'WAITLIST']).default('CONFIRMED'),
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']),
  value: z.coerce.number().min(0).max(1_000_000).default(0),
  notes: z.string().trim().max(2000).optional(),
}).refine(input => input.endsAt > input.startsAt, {
  message: 'endsAt must be after startsAt',
  path: ['endsAt'],
});

export const appointmentRoutes: FastifyPluginAsync = async app => {
  app.get('/', async request => {
    const query = appointmentQuery.parse(request.query);
    const rows = await db.appointment.findMany({
      where: {
        tenantId: request.auth.tenantId,
        deletedAt: null,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
        patientId: query.patientId,
        status: query.status,
        startsAt: query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
      },
      orderBy: { id: 'asc' },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
    });
    return cursorPage(rows, query.limit);
  });

  app.post('/', { preHandler: requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK') }, async (request, reply) => {
    const input = appointmentInput.parse(request.body);
    assertBranchAccess(request, input.branchId);
    const patient = await db.patient.findFirst({
      where: { id: input.patientId, branchId: input.branchId, tenantId: request.auth.tenantId, deletedAt: null },
    });
    if (!patient) throw app.httpErrors.badRequest('Patient and branch must belong to this tenant');

    const appointment = await db.appointment.create({
      data: { tenantId: request.auth.tenantId, ...input },
    });
    await audit(request, { action: 'appointment.created', resource: 'appointment', resourceId: appointment.id });
    return reply.code(201).send(appointment);
  });
};
