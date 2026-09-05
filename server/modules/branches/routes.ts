import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { runWithTenantContext } from '../../lib/tenantContext';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requireRoles } from '../../plugins/roles';
import { branchScope } from '../../lib/scope';
import { validateIanaTimezone } from '../../lib/scheduling';

const timezoneInput = z.string().trim().min(1).max(80).refine(value => {
  try { validateIanaTimezone(value); return true; } catch { return false; }
}, { message: 'timezone must be a valid IANA timezone identifier' });

const branchInput = z.object({
  name: z.string().trim().min(2).max(120),
  location: z.string().trim().min(2).max(240),
  timezone: timezoneInput.default('America/New_York'),
});

export const branchRoutes: FastifyPluginAsync = async app => {
  app.get('/', async request => {
    const query = paginationSchema.parse(request.query);
    const scope = branchScope(request);
    const assignedBranchIds = request.auth.branchIds;
    const rows = await db.branch.findMany({
      // The branch directory is also the clinic switcher's source. Shared
      // operational users must see every assigned clinic here, while all other
      // data routes remain narrowed to the explicitly selected clinic.
      where: {
        tenantId: request.auth.tenantId,
        ...(assignedBranchIds.length > 0
          ? { id: { in: assignedBranchIds } }
          : scope.branchId ? { id: scope.branchId } : {}),
      },
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
    const branch = await runWithTenantContext(request.auth.tenantId, async tx => {
      // Serialize tenant provisioning so stale tabs/retries cannot create the
      // same named location twice. Keep the row and audit in one transaction.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`branch.create:${request.auth.tenantId}`}::text, 0))::text AS locked`;
      const existing = await tx.branch.findFirst({ where: { tenantId: request.auth.tenantId, name: { equals: input.name, mode: 'insensitive' } }, select: { id: true } });
      if (existing) throw app.httpErrors.conflict('A clinic with this name already exists. Refresh the clinic list before trying again.');
      const created = await tx.branch.create({ data: { tenantId: request.auth.tenantId, ...input } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'branch.created', resource: 'branch', resourceId: created.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      } });
      return created;
    });
    return reply.code(201).send(branch);
  });
};
