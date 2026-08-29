import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requirePermission } from '../../lib/permissions';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { runWithTenantContext } from '../../lib/tenantContext';

// Provider identities are workforce master data, distinct from maintaining a
// clinician's calendar. Reading requires staff-directory access; onboarding and
// reassignment require tenant administration so a clinician cannot create or
// rewrite provider identities merely because they can maintain a schedule.
const canReadProviders = requirePermission('staff:read');
const canManageProviders = requirePermission('admin:manage');
const CLINICIAN_CAPABLE_ROLES = ['PROVIDER', 'OWNER', 'ADMIN'] as const;

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
  // Deactivation retires a clinician from the booking schedule without deleting
  // the identity their existing appointments point at. Enforced in the slot
  // engine (resolveProviderSchedulingContext), not only in the UI.
  active: z.boolean().optional(),
}).refine(input => input.branchId !== undefined || input.specialty !== undefined || input.active !== undefined, {
  message: 'At least one field (branchId, specialty, active) must be provided',
});

export const providerRoutes: FastifyPluginAsync = async app => {
  app.get('/overview', { preHandler: canReadProviders }, async request => {
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
        // A provider with no working hours has no open slots, so every booking
        // surface needs to tell "not on the schedule yet" apart from "fully
        // booked today". Counting the recurring windows here is what lets the
        // front desk see that difference without a second request per provider.
        _count: { select: { availability: { where: { active: true } } } },
      },
    });

    return cursorPage(rows, query.limit);
  });

  // ----- Users who may be given a provider identity ---------------------------
  // The create route below requires a clinician-capable, branch-entitled user.
  // Without this, a console could only offer a free-text user id and would fail
  // at submit; with it the picker offers exactly the users POST / will accept.
  app.get('/candidates', { preHandler: canManageProviders }, async request => {
    const query = z.object({ branchId: z.string().uuid().optional() }).parse(request.query);
    if (query.branchId) assertBranchAccess(request, query.branchId);
    const branchId = request.auth.branchId ?? query.branchId;
    const users = await db.user.findMany({
      where: {
        tenantId: request.auth.tenantId,
        active: true,
        role: { in: [...CLINICIAN_CAPABLE_ROLES] },
        ...(branchId ? { OR: [{ branchId }, { clinicAccesses: { some: { branchId } } }] } : {}),
      },
      select: {
        id: true, displayName: true, email: true, role: true, branchId: true,
        providerProfile: { select: { id: true, active: true } },
        clinicAccesses: { select: { branchId: true } },
      },
      orderBy: [{ displayName: 'asc' }],
      take: 100,
    });
    return users.map(user => ({
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      // Every branch this user may be given a provider identity in, so the
      // console cannot offer a branch the create route would reject.
      branchIds: [...new Set([user.branchId, ...user.clinicAccesses.map(access => access.branchId)].filter((id): id is string => Boolean(id)))],
      providerProfileId: user.providerProfile?.id ?? null,
      providerActive: user.providerProfile?.active ?? null,
    }));
  });

  // ----- Onboard a clinician (create a ProviderProfile for a tenant user) -----
  app.post('/', { preHandler: canManageProviders }, async (request, reply) => {
    const input = providerCreateInput.parse(request.body);
    assertBranchAccess(request, input.branchId);

    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      // Serialize by tenant/user so concurrent onboarding cannot leak a raw
      // uniqueness error or create an unaudited provider identity.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider:${request.auth.tenantId}:${input.userId}`}::text, 0))::text AS locked`;
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId, active: true }, select: { id: true } });
      if (!branch) return { kind: 'invalid_branch' as const };
      const user = await tx.user.findFirst({
        where: { id: input.userId, tenantId: request.auth.tenantId, active: true },
        select: { id: true, role: true, branchId: true, clinicAccesses: { where: { branchId: input.branchId }, select: { id: true } } },
      });
      if (!user) return { kind: 'invalid_user' as const };
      if (!CLINICIAN_CAPABLE_ROLES.includes(user.role as typeof CLINICIAN_CAPABLE_ROLES[number])) return { kind: 'invalid_role' as const };
      if (user.branchId !== input.branchId && user.clinicAccesses.length === 0) return { kind: 'invalid_access' as const };
      const existing = await tx.providerProfile.findUnique({ where: { userId: input.userId }, select: { id: true } });
      if (existing) return { kind: 'duplicate' as const };
      const provider = await tx.providerProfile.create({
        data: { tenantId: request.auth.tenantId, branchId: input.branchId, userId: input.userId, specialty: input.specialty },
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'provider.created', resource: 'providerProfile', resourceId: provider.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { branchId: provider.branchId, userId: provider.userId },
      } });
      return { kind: 'created' as const, provider };
    });
    if (result.kind === 'invalid_branch') throw app.httpErrors.badRequest('Branch does not belong to this tenant');
    if (result.kind === 'invalid_user') throw app.httpErrors.badRequest('Active user does not belong to this tenant');
    if (result.kind === 'invalid_role') throw app.httpErrors.badRequest('Provider profiles require a PROVIDER, OWNER, or ADMIN clinician identity');
    if (result.kind === 'invalid_access') throw app.httpErrors.badRequest('Provider user does not have access to the selected branch');
    if (result.kind === 'duplicate') throw app.httpErrors.conflict('This user already has a provider profile');
    return reply.code(201).send(result.provider);
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
      const branch = await db.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId, active: true }, select: { id: true } });
      if (!branch) throw app.httpErrors.badRequest('Branch does not belong to this tenant');
      const userAccess = await db.user.findFirst({
        where: { id: provider.userId, tenantId: request.auth.tenantId, active: true, role: { in: [...CLINICIAN_CAPABLE_ROLES] } },
        select: { branchId: true, clinicAccesses: { where: { branchId: input.branchId }, select: { id: true } } },
      });
      if (!userAccess || (userAccess.branchId !== input.branchId && userAccess.clinicAccesses.length === 0)) {
        throw app.httpErrors.badRequest('Provider user does not have access to the selected branch');
      }
    }

    // Taking a provider off (or back on) the schedule is a distinct operational
    // event from editing their specialty, and is recorded as one — the same way
    // admin.user.activated / admin.user.deactivated are recorded for accounts.
    const activationChanged = input.active !== undefined && input.active !== provider.active;
    const action = activationChanged
      ? (input.active ? 'provider.activated' : 'provider.deactivated')
      : 'provider.updated';

    const updated = await runWithTenantContext(request.auth.tenantId, async tx => {
      const row = await tx.providerProfile.update({
        where: { id: provider.id },
        data: { branchId: input.branchId ?? undefined, specialty: input.specialty ?? undefined, active: input.active ?? undefined },
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action, resource: 'providerProfile', resourceId: provider.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { fromBranchId: provider.branchId, toBranchId: row.branchId, specialtyChanged: input.specialty !== undefined, active: row.active },
      } });
      return row;
    });
    return updated;
  });
};
