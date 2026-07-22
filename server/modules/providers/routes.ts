import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requirePermission } from '../../lib/permissions';
import { assertBranchAccess, branchScope } from '../../lib/scope';

// Provider (clinician) management. Reads are open to any authenticated user;
// create/edit are gated on `schedule:manage` — the same permission the scheduling
// module uses for all provider-scoped management (availability, time-off), so a
// tenant that can manage a provider's schedule can also onboard/edit the provider
// itself. Tenant isolation is application-level (findFirst by {id, tenantId}).
const canManageProviders = requirePermission('schedule:manage');

const providerQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
});

const providerCreateInput = z.object({
  userId: z.string().uuid(),
  branchId: z.string().uuid(),
  specialty: z.string().trim().min(1).max(160),
});

const providerUpdateInput = z.object({
  branchId: z.string().uuid().optional(),
  specialty: z.string().trim().min(1).max(160).optional(),
}).refine(input => input.branchId !== undefined || input.specialty !== undefined, {
  message: 'At least one field (branchId, specialty) must be provided',
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

  // ----- Onboard a clinician (create a ProviderProfile for a tenant user) -----
  app.post('/', { preHandler: canManageProviders }, async (request, reply) => {
    const input = providerCreateInput.parse(request.body);
    assertBranchAccess(request, input.branchId);

    // Branch and user must both belong to this tenant (no cross-tenant FK / IDOR).
    const branch = await db.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId }, select: { id: true } });
    if (!branch) throw app.httpErrors.badRequest('Branch does not belong to this tenant');
    const user = await db.user.findFirst({ where: { id: input.userId, tenantId: request.auth.tenantId }, select: { id: true } });
    if (!user) throw app.httpErrors.badRequest('User does not belong to this tenant');

    // A user has at most one provider profile (userId is unique); reject a dup up
    // front rather than surfacing a raw unique-constraint error.
    const existing = await db.providerProfile.findUnique({ where: { userId: input.userId }, select: { id: true } });
    if (existing) throw app.httpErrors.conflict('This user already has a provider profile');

    const provider = await db.providerProfile.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: input.branchId,
        userId: input.userId,
        specialty: input.specialty,
      },
    });
    await audit(request, { action: 'provider.created', resource: 'providerProfile', resourceId: provider.id, metadata: { branchId: provider.branchId, userId: provider.userId } });
    return reply.code(201).send(provider);
  });

  // ----- Edit a clinician's profile (specialty / branch) ----------------------
  app.patch('/:id', { preHandler: canManageProviders }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = providerUpdateInput.parse(request.body);
    const provider = await db.providerProfile.findFirst({
      where: { id, tenantId: request.auth.tenantId, ...branchScope(request) },
    });
    if (!provider) throw app.httpErrors.notFound('Provider not found');
    assertBranchAccess(request, provider.branchId);

    if (input.branchId && input.branchId !== provider.branchId) {
      assertBranchAccess(request, input.branchId);
      const branch = await db.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId }, select: { id: true } });
      if (!branch) throw app.httpErrors.badRequest('Branch does not belong to this tenant');
    }

    const updated = await db.providerProfile.update({
      where: { id: provider.id },
      data: {
        branchId: input.branchId ?? undefined,
        specialty: input.specialty ?? undefined,
      },
    });
    await audit(request, { action: 'provider.updated', resource: 'providerProfile', resourceId: provider.id });
    return updated;
  });
};
