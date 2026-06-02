import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requireRoles } from '../../plugins/roles';
import { branchScope } from '../../lib/scope';

const branchInput = z.object({
  name: z.string().trim().min(2).max(120),
  location: z.string().trim().min(2).max(240),
  timezone: z.string().trim().min(1).default('Europe/London'),
});

export const branchRoutes: FastifyPluginAsync = async app => {
  app.get('/', async request => {
    const query = paginationSchema.parse(request.query);
    const rows = await db.branch.findMany({
      where: { tenantId: request.auth.tenantId, ...branchScope(request) },
      orderBy: { id: 'asc' },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      include: { _count: { select: { patients: true } } },
    });
    return cursorPage(rows, query.limit);
  });

  app.post('/', { preHandler: requireRoles('OWNER', 'ADMIN') }, async (request, reply) => {
    const input = branchInput.parse(request.body);
    const branch = await db.branch.create({
      data: { tenantId: request.auth.tenantId, ...input },
    });
    await audit(request, { action: 'branch.created', resource: 'branch', resourceId: branch.id });
    return reply.code(201).send(branch);
  });
};
