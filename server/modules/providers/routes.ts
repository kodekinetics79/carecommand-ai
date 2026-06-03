import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { branchScope } from '../../lib/scope';

const providerQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
});

export const providerRoutes: FastifyPluginAsync = async app => {
  app.get('/overview', async request => {
    const query = providerQuery.parse(request.query);
    const rows = await db.providerProfile.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
      },
      orderBy: [{ revenueThisMonth: 'desc' }, { utilization: 'desc' }],
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
};
