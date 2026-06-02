import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requireRoles } from '../../plugins/roles';
import { assertBranchAccess, branchScope } from '../../lib/scope';

const patientQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
  lifecycleStage: z.enum(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']).optional(),
});

const patientInput = z.object({
  branchId: z.string().uuid(),
  externalRef: z.string().trim().max(120).optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().email().optional(),
  phone: z.string().trim().max(40).optional(),
  lifecycleStage: z.enum(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']).default('NEW'),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
});

export const patientRoutes: FastifyPluginAsync = async app => {
  app.get('/', async request => {
    const query = patientQuery.parse(request.query);
    const rows = await db.patient.findMany({
      where: {
        tenantId: request.auth.tenantId,
        deletedAt: null,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
        lifecycleStage: query.lifecycleStage,
        OR: query.search ? [
          { firstName: { contains: query.search, mode: 'insensitive' } },
          { lastName: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
        ] : undefined,
      },
      orderBy: { id: 'asc' },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
    });
    return cursorPage(rows, query.limit);
  });

  app.get('/:id', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const patient = await db.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
      include: {
        appointments: { where: { deletedAt: null }, orderBy: { startsAt: 'desc' }, take: 20 },
        consentEvents: { orderBy: { occurredAt: 'desc' } },
      },
    });
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    return patient;
  });

  app.post('/', { preHandler: requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK') }, async (request, reply) => {
    const input = patientInput.parse(request.body);
    assertBranchAccess(request, input.branchId);
    const branch = await db.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId } });
    if (!branch) throw app.httpErrors.badRequest('Branch does not belong to this tenant');

    const patient = await db.patient.create({
      data: { tenantId: request.auth.tenantId, ...input },
    });
    await audit(request, { action: 'patient.created', resource: 'patient', resourceId: patient.id });
    return reply.code(201).send(patient);
  });

  app.post('/:id/consents', { preHandler: requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      purpose: z.enum(['SMS', 'WHATSAPP', 'EMAIL', 'MARKETING']),
      granted: z.boolean(),
      source: z.string().trim().min(2).max(120),
      metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    }).parse(request.body);
    const patient = await db.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    });
    if (!patient) throw app.httpErrors.notFound('Patient not found');

    const consent = await db.consentEvent.create({
      data: { tenantId: request.auth.tenantId, patientId: patient.id, ...input },
    });
    await audit(request, { action: 'patient.consent.recorded', resource: 'patient', resourceId: patient.id, metadata: { purpose: input.purpose, granted: input.granted } });
    return reply.code(201).send(consent);
  });
};
