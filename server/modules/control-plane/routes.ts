import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { generatePasswordHash, validatePassword } from '../../lib/security';
import { requireRoles } from '../../plugins/roles';
import { setUserActiveSafely, setUserPasswordSafely, setUserRoleSafely } from '../../lib/adminSafety';
import { autopilotQueue } from '../../workers/queues';
import {
  buildIntegrationRows,
  buildFinanceRails,
  insuranceRailCapability,
} from '../../lib/providerRails';
import { runWithTenantContext } from '../../lib/tenantContext';
import { Prisma } from '../../generated/prisma/client';
import { lockClinicAccessMutation } from '../../lib/clinicAccessSafety';

// Re-exported from its new home so the money-integrity suite keeps its import
// path: the rule ("only a credentialed adapter counts as configured") did not
// move, only the file it lives in.
export { insuranceRailCapability };

const ownerAdminRoles = requireRoles('OWNER', 'ADMIN');
const uuid = z.string().uuid();

const rolePermissionMatrix: Array<{ role: string; scope: string; modules: string[]; risk: 'low' | 'medium' | 'high' }> = [
  {
    role: 'OWNER',
    scope: 'Tenant-wide, all clinics',
    modules: ['Command Center', 'Growth', 'Revenue', 'Operations', 'Platform'],
    risk: 'high',
  },
  {
    role: 'ADMIN',
    scope: 'Tenant-wide, all clinics',
    modules: ['Command Center', 'Growth', 'Revenue', 'Operations', 'Platform'],
    risk: 'high',
  },
  {
    role: 'MANAGER',
    scope: 'Assigned clinics',
    modules: ['Command Center', 'Growth', 'Revenue', 'Operations'],
    risk: 'medium',
  },
  {
    role: 'BILLING',
    scope: 'Finance / payment workflows',
    modules: ['Revenue', 'Platform'],
    risk: 'medium',
  },
  {
    role: 'FRONT_DESK',
    scope: 'Assigned clinic',
    modules: ['Command Center', 'Growth', 'Operations'],
    risk: 'medium',
  },
  {
    role: 'PROVIDER',
    scope: 'Primary clinic',
    modules: ['Command Center', 'Operations'],
    risk: 'medium',
  },
  {
    role: 'ANALYST',
    scope: 'Tenant-wide, read-only',
    modules: ['Command Center', 'Revenue', 'Operations'],
    risk: 'low',
  },
  // Descriptive module guidance only — enforcement lives in the compliance
  // module's route role checks, not in this matrix.
  {
    role: 'COMPLIANCE_OFFICER',
    scope: 'Compliance module',
    modules: ['Compliance Readiness: manage', 'Evidence Vault: manage', 'Risks/Vendors/Incidents: manage', 'Reports/Audit Logs: view'],
    risk: 'medium',
  },
  {
    role: 'AUDITOR',
    scope: 'Compliance module, read-only',
    modules: ['Compliance Readiness: view', 'Evidence Vault: view', 'Reports/Audit Logs: view'],
    risk: 'low',
  },
];

const controlPlaneRoles: Record<string, { scope: string; modules: string[]; risk: 'low' | 'medium' | 'high' }> = Object.fromEntries(
  rolePermissionMatrix.map(entry => [entry.role, { scope: entry.scope, modules: entry.modules, risk: entry.risk }]),
);



function safeEmail(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object') return null;
  const email = (metadata as { email?: unknown }).email;
  return typeof email === 'string' ? email : null;
}

function sameDayRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}


async function loadUsers(tenantId: string) {
  const users = await db.user.findMany({
    where: { tenantId },
    orderBy: [{ active: 'desc' }, { displayName: 'asc' }],
    select: {
      id: true,
      displayName: true,
      email: true,
      role: true,
      active: true,
      branchId: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
      branch: { select: { id: true, name: true, location: true } },
      clinicAccesses: {
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          isPrimary: true,
          branch: { select: { id: true, name: true, location: true } },
        },
      },
    },
  });

  return users.map(user => ({
    ...user,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    sessionActive: Boolean(user.lastLoginAt && user.active),
    accessBranches: user.clinicAccesses.map(access => ({
      id: access.branch.id,
      name: access.branch.name,
      location: access.branch.location,
      isPrimary: access.isPrimary,
    })),
  }));
}

async function replaceClinicAccess(tx: Prisma.TransactionClient, tenantId: string, userId: string, branchIds: string[], primaryBranchId?: string) {
  const uniqueBranchIds = [...new Set(branchIds)];
  if (primaryBranchId && !uniqueBranchIds.includes(primaryBranchId)) {
    throw new Error('primary_branch_must_be_selected');
  }
  const orderedBranchIds = primaryBranchId
    ? [primaryBranchId, ...uniqueBranchIds.filter(id => id !== primaryBranchId)]
    : uniqueBranchIds;
  await tx.userClinicAccess.deleteMany({ where: { tenantId, userId } });
  if (orderedBranchIds.length > 0) {
    await tx.userClinicAccess.createMany({
      data: orderedBranchIds.map((branchId, index) => ({ tenantId, userId, branchId, isPrimary: index === 0 })),
    });
  }
  await tx.user.update({ where: { id: userId }, data: { branchId: orderedBranchIds[0] ?? null } });
}

async function buildSystemHealth(tenantId: string) {
  const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

  // Real runtime checks (no hardcoded statuses).
  let databaseStatus: string;
  let dbLatencyMs: number | null = null;
  try {
    const t0 = Date.now();
    await withTimeout(db.$queryRaw`SELECT 1`, 2000);
    dbLatencyMs = Date.now() - t0;
    databaseStatus = 'healthy';
  } catch { databaseStatus = 'down'; }

  let backgroundJobs: string;
  try {
    const client = (await withTimeout(Promise.resolve(autopilotQueue.client), 1000)) as unknown as { ping(): Promise<string> };
    backgroundJobs = (await withTimeout(client.ping(), 1000)) === 'PONG' ? 'available' : 'unavailable';
  } catch { backgroundJobs = 'unavailable'; }

  const [auditCount, integrationCount, rpEntitlement, migrationRows, latestMigrationRows] = await Promise.all([
    db.auditEvent.count({ where: { tenantId } }),
    db.integration.count({ where: { tenantId } }),
    db.tenantFeatureEntitlement.findUnique({ where: { tenantId_featureKey: { tenantId, featureKey: 'revenue_protection' } } }).catch(() => null),
    db.$queryRawUnsafe<Array<{ count: number }>>('SELECT COUNT(*)::int AS count FROM "_prisma_migrations"').catch(() => [] as Array<{ count: number }>),
    db.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>('SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 1').catch(() => [] as Array<{ migration_name: string; finished_at: Date | null }>),
  ]);

  return {
    apiStatus: 'healthy', // reaching this handler means the API is serving requests
    databaseStatus,
    dbLatencyMs,
    migrationStatus: migrationRows[0]?.count ? 'applied' : 'unknown',
    latestMigration: latestMigrationRows[0]?.migration_name ?? null,
    authStatus: env.JWT_SECRET && env.JWT_REFRESH_SECRET ? 'configured' : 'missing-secrets',
    revenueProtectionStatus: rpEntitlement?.enabled ? 'available' : 'not-entitled',
    integrationStatus: integrationCount > 0 ? 'available' : 'not-configured',
    backgroundJobs,
    environmentMode: env.NODE_ENV,
    buildVersion: process.env.npm_package_version ?? null,
    auditEventCount: auditCount,
  };
}

function productionReadinessScore(overview: {
  auth: boolean;
  https: boolean;
  secrets: boolean;
  integrations: number;
  insurance: number;
  payments: number;
  rbac: boolean;
  audit: boolean;
}) {
  const checks = [
    overview.auth,
    overview.https,
    overview.secrets,
    overview.integrations > 0,
    overview.insurance > 0,
    overview.payments > 0,
    overview.rbac,
    overview.audit,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function buildSecurityPosture(_tenantId: string, integrationRows: Array<{ health: string; configured: boolean; category: string; mode: string; modeLabel: string; name: string; key: string }>, paymentRows: Array<{ configured: boolean; mode: string; modeLabel: string; name: string; provider: string }>, auditCount: number) {
  const mockIntegrations = integrationRows.filter(row => row.mode === 'mock').length;
  const sandboxIntegrations = integrationRows.filter(row => row.mode === 'sandbox').length;
  const liveIntegrations = integrationRows.filter(row => row.mode === 'live').length;
  const securityAlerts = [
    env.NODE_ENV === 'production' ? null : {
      severity: 'info',
      title: 'Dev-token available in development',
      message: 'Dev-token bootstrap remains restricted to development.',
    },
    !env.JWT_SECRET ? {
      severity: 'high',
      title: 'JWT secret missing',
      message: 'JWT_SECRET must be configured for production access tokens.',
    } : null,
    !env.JWT_REFRESH_SECRET ? {
      severity: 'high',
      title: 'Refresh secret missing',
      message: 'JWT_REFRESH_SECRET must be configured for refresh token hashing.',
    } : null,
    env.NODE_ENV === 'production' ? null : {
      severity: 'medium',
      title: 'HTTPS required in production',
      message: 'Production must terminate HTTPS for secure refresh cookies.',
    },
    // Capability, not plumbing. The four alerts that used to sit here named a
    // clearinghouse, a card processor, an LLM vendor and an environment
    // variable — none of which a practice manager can act on. The clinic is
    // still told, on the screen where it matters, that the capability is not
    // set up and that the next step is us; see `tenantCapabilities` in
    // server/lib/providerRails.ts. The supplier detail is on the platform
    // console.
    env.INSURANCE_PROVIDER === 'mock' ? {
      severity: 'medium',
      title: 'Insurance eligibility checks are not set up',
      message: 'Coverage cannot be confirmed from this workspace. Contact CareCommand support to switch it on.',
    } : null,
    env.PAYMENT_PROVIDER === 'mock' ? {
      severity: 'medium',
      title: 'Card payments are not set up',
      message: 'No payment link can be sent from this workspace. Contact CareCommand support to switch it on.',
    } : null,
  ].filter(Boolean);

  const riskLabel = securityAlerts.some(alert => alert && (alert as { severity: string }).severity === 'high') ? 'High' : securityAlerts.length > 0 ? 'Medium' : 'Low';
  const readinessScore = productionReadinessScore({
    auth: Boolean(env.JWT_SECRET && env.JWT_REFRESH_SECRET),
    https: env.NODE_ENV === 'production',
    secrets: Boolean(env.JWT_SECRET && env.JWT_REFRESH_SECRET),
    integrations: liveIntegrations + sandboxIntegrations + mockIntegrations,
    insurance: integrationRows.some(row => row.category === 'Insurance') ? 1 : 0,
    payments: paymentRows.length,
    rbac: true,
    audit: auditCount > 0,
  });

  return {
    authMode: env.NODE_ENV === 'production' ? 'password+refresh-cookie' : 'password+refresh-cookie with explicit dev-token fallback',
    passwordLoginEnabled: true,
    devTokenEnabled: env.NODE_ENV !== 'production',
    refreshCookieHttpOnly: true,
    csrfEnabled: true,
    accessTokenTtlMinutes: 15,
    refreshRotationEnabled: true,
    rbacEnabled: true,
    adminRouteProtected: true,
    tenantIsolationEnabled: true,
    clinicScopingEnabled: true,
    httpsRequired: env.NODE_ENV === 'production',
    jwtSecretsConfigured: Boolean(env.JWT_SECRET),
    refreshSecretConfigured: Boolean(env.JWT_REFRESH_SECRET),
    rateLimitingEnabled: true,
    corsMode: env.CORS_ORIGINS.includes('*') ? 'open' : 'restricted',
    environmentMode: env.NODE_ENV,
    alerts: securityAlerts,
    riskLabel,
    readinessScore,
  };
}

export const controlPlaneRoutes: FastifyPluginAsync = async app => {
  const userStatusBody = z.object({ active: z.boolean() });
  const userRoleEnum = z.enum(['OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']);
  const userRoleBody = z.object({ role: userRoleEnum });
  const clinicAccessBody = z.object({
    branchIds: z.array(uuid).default([]),
    primaryBranchId: uuid.optional(),
  });
  const userCreateBody = z.object({
    email: z.string().email().trim().toLowerCase(),
    name: z.string().trim().min(2).max(120),
    password: z.string().min(8).max(200),
    role: userRoleEnum,
    branchIds: z.array(uuid).default([]),
    primaryBranchId: uuid.optional(),
  });
  const userPasswordResetBody = z.object({ password: z.string().min(8).max(200) });
  const clinicStatusBody = z.object({ active: z.boolean() });

  // The tenant's own governance view: who has access, what was audited, how the
  // workspace is secured.
  //
  // It used to also carry `integrations`, `insuranceRails` and `financeRails` —
  // three arrays of supplier names, operating modes and per-vendor health — plus
  // four counters built from them. Those are the clinic's suppliers only in the
  // sense that we pay them; the clinic cannot open one, cannot fix one, and
  // should never have been asked to read one. They now answer the platform JWT
  // at /v1/platform/tenants/:tenantId/providers and nothing else.
  //
  // The security posture is still COMPUTED from the rails, because the
  // production-readiness score genuinely depends on whether a payment and an
  // eligibility rail exist. It is not EMITTED from them.
  app.get('/overview', { preHandler: ownerAdminRoles }, async request => {
    const [users, branches, tenant, integrations, securityLogs, financeRails, auditCount] = await Promise.all([
      loadUsers(request.auth.tenantId),
      db.branch.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { name: 'asc' }, select: { id: true, name: true, location: true, active: true } }),
      db.tenant.findUnique({ where: { id: request.auth.tenantId }, select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true } }),
      buildIntegrationRows(db, request.auth.tenantId),
      db.auditEvent.findMany({
        where: {
          tenantId: request.auth.tenantId,
          occurredAt: {
            gte: sameDayRange().start,
            lt: sameDayRange().end,
          },
        },
        orderBy: { occurredAt: 'desc' },
        take: 25,
      }),
      buildFinanceRails(db, request.auth.tenantId),
      db.auditEvent.count({ where: { tenantId: request.auth.tenantId } }),
    ]);
    const securityPosture = buildSecurityPosture(request.auth.tenantId, integrations, financeRails, auditCount);

    const activeUsers = users.filter(user => user.active).length;
    const adminUsers = users.filter(user => ['OWNER', 'ADMIN'].includes(user.role)).length;
    const inactiveUsers = users.length - activeUsers;
    const auditEventsToday = await db.auditEvent.count({
      where: {
        tenantId: request.auth.tenantId,
        occurredAt: {
          gte: sameDayRange().start,
          lt: sameDayRange().end,
        },
      },
    });
    const securityAlerts = securityPosture.alerts.length;

    return {
      tenant,
      summary: {
        totalUsers: users.length,
        activeUsers,
        adminUsers,
        inactiveUsers,
        clinics: branches.length,
        auditEventsToday,
        securityAlerts,
        productionReadinessScore: securityPosture.readinessScore,
      },
      branches,
      securityPosture,
      systemHealth: await buildSystemHealth(request.auth.tenantId),
      auditEventsToday: securityLogs.map(event => ({ id: event.id, action: event.action, occurredAt: event.occurredAt.toISOString() })),
    };
  });

  app.get('/users', { preHandler: ownerAdminRoles }, async request => {
    const users = await loadUsers(request.auth.tenantId);
    const branches = await db.branch.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { name: 'asc' }, select: { id: true, name: true, location: true, active: true } });
    return {
      tenant: await db.tenant.findUnique({ where: { id: request.auth.tenantId }, select: { id: true, name: true, slug: true } }),
      branches,
      summary: {
        totalUsers: users.length,
        activeUsers: users.filter(user => user.active).length,
        inactiveUsers: users.filter(user => !user.active).length,
        activeBranches: branches.filter(branch => branch.active).length,
      },
      users,
    };
  });

  app.post('/users', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const body = userCreateBody.parse(request.body);
    const policy = validatePassword(body.password);
    if (!policy.ok) throw app.httpErrors.badRequest(policy.message ?? 'Weak password');

    const requestedBranchIds = [...new Set(body.branchIds)];
    // PRIVILEGE ESCALATION GUARD. replaceClinicAccess writes
    // `branchId: orderedBranchIds[0] ?? null`, and a null branchId is how this
    // codebase represents "not restricted to a branch": branchScope() returns
    // {} (no filter, every branch) and assertBranchAccess() permits any branch.
    // So clearing every clinic for a departing user silently granted them
    // tenant-wide access to all branches while the console displayed
    // "No access configured". Removing all access is a deactivation, not a
    // grant, so refuse it here and make the admin say what they mean.
    if (requestedBranchIds.length === 0) {
      throw app.httpErrors.badRequest('Select at least one clinic. To remove this user\u2019s access entirely, deactivate the account instead.');
    }
    if (body.primaryBranchId && !requestedBranchIds.includes(body.primaryBranchId)) {
      throw app.httpErrors.badRequest('Primary branch must be included in selected branch access');
    }
    const passwordHash = await generatePasswordHash(body.password);
    try {
      const result = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockClinicAccessMutation(tx, request.auth.tenantId);
        const emailLockKey = `control-plane-user-email:${request.auth.tenantId}:${body.email}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${emailLockKey}::text, 0))::text AS locked`;
        const existing = await tx.user.findFirst({
          where: { tenantId: request.auth.tenantId, email: { equals: body.email, mode: 'insensitive' } },
          select: { id: true },
        });
        if (existing) throw app.httpErrors.conflict('User email already exists');
        const validBranchRows = requestedBranchIds.length > 0
          ? await tx.branch.findMany({ where: { tenantId: request.auth.tenantId, active: true, id: { in: requestedBranchIds } }, select: { id: true } })
          : [];
        let validBranchIds = validBranchRows.map(branch => branch.id);
        if (validBranchIds.length !== requestedBranchIds.length) throw app.httpErrors.badRequest('Every selected branch must be active and belong to this tenant');
        if (validBranchIds.length === 0) {
          const fallbackBranch = await tx.branch.findFirst({ where: { tenantId: request.auth.tenantId, active: true }, orderBy: { name: 'asc' }, select: { id: true } });
          if (fallbackBranch) validBranchIds = [fallbackBranch.id];
        }
        const primaryBranchId = body.primaryBranchId && validBranchIds.includes(body.primaryBranchId) ? body.primaryBranchId : validBranchIds[0] ?? null;
        const user = await tx.user.create({ data: {
          tenantId: request.auth.tenantId,
          email: body.email,
          displayName: body.name,
          role: body.role,
          passwordHash,
          branchId: primaryBranchId,
        } });
        if (validBranchIds.length > 0) await replaceClinicAccess(tx, request.auth.tenantId, user.id, validBranchIds, primaryBranchId ?? undefined);
        await tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId,
          actorUserId: request.auth.userId,
          action: 'controlPlane.user.created',
          resource: 'user',
          resourceId: user.id,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { email: user.email, role: user.role, branchIds: validBranchIds },
        } });
        return { user, validBranchIds, primaryBranchId };
      });
      return reply.code(201).send({
        id: result.user.id,
        email: result.user.email,
        name: result.user.displayName,
        role: result.user.role,
        status: result.user.active ? 'active' : 'inactive',
        branchIds: result.validBranchIds,
        primaryBranchId: result.primaryBranchId,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw app.httpErrors.conflict('User email already exists');
      }
      throw error;
    }
  });

  app.patch('/users/:id/status', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { active } = userStatusBody.parse(request.body);
    const updated = await setUserActiveSafely(request, id, active, active ? 'controlPlane.user.activated' : 'controlPlane.user.deactivated');
    return reply.send({ id: updated.id, active: updated.active });
  });

  app.patch('/users/:id/role', { preHandler: ownerAdminRoles }, async (request) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { role } = userRoleBody.parse(request.body);
    const updated = await setUserRoleSafely(request, id, role, 'controlPlane.user.roleChanged');
    return { id: updated.id, role: updated.role };
  });

  // ADMIN-INITIATED RECOVERY. A password is otherwise only ever set at user
  // creation, so a clinic user who forgets theirs has no way back in: no email
  // delivery adapter is integrated, and inventing one would be a control that
  // claims to have sent something it never sent. Recovery is therefore an
  // administrator setting a temporary password and handing it over directly,
  // exactly as at creation. The value is never echoed by this route and never
  // appears in GET /users — the administrator typed it, and returning it would
  // put a live credential in response bodies and logs.
  app.post('/users/:id/password-reset', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { password } = userPasswordResetBody.parse(request.body);
    const policy = validatePassword(password);
    if (!policy.ok) throw app.httpErrors.badRequest(policy.message ?? 'Weak password');
    const passwordHash = await generatePasswordHash(password);
    const updated = await setUserPasswordSafely(request, id, passwordHash, 'controlPlane.user.passwordReset');
    return reply.send({ id: updated.id, passwordChangedAt: updated.passwordChangedAt.toISOString(), sessionsRevoked: true });
  });

  app.patch('/users/:id/clinic-access', { preHandler: ownerAdminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = clinicAccessBody.parse(request.body);
    const requestedBranchIds = [...new Set(body.branchIds)];
    if (body.primaryBranchId && !requestedBranchIds.includes(body.primaryBranchId)) {
      throw app.httpErrors.badRequest('Primary branch must be included in selected branch access');
    }
    await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockClinicAccessMutation(tx, request.auth.tenantId);
      const existing = await tx.user.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { id: true } });
      if (!existing) throw app.httpErrors.notFound('User not found');
      const validBranches = await tx.branch.findMany({ where: { tenantId: request.auth.tenantId, active: true, id: { in: requestedBranchIds } }, select: { id: true } });
      if (validBranches.length !== requestedBranchIds.length) throw app.httpErrors.badRequest('Every selected branch must be active and belong to this tenant');
      await replaceClinicAccess(tx, request.auth.tenantId, id, requestedBranchIds, body.primaryBranchId);
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: 'controlPlane.user.clinicAccessUpdated',
        resource: 'user',
        resourceId: id,
        requestId: request.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { branchIds: requestedBranchIds },
      } });
    });
    return { id, branchIds: requestedBranchIds, primaryBranchId: body.primaryBranchId ?? requestedBranchIds[0] ?? null };
  });

  app.get('/users/:id/audit-trail', { preHandler: ownerAdminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const logs = await db.auditEvent.findMany({
      where: {
        tenantId: request.auth.tenantId,
        OR: [{ actorUserId: id }, { resourceId: id }],
      },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    return logs.map(event => ({
      id: event.id,
      action: event.action,
      resource: event.resource,
      resourceId: event.resourceId,
      actor: event.actorUser?.displayName ?? safeEmail(event.metadata) ?? 'System',
      role: event.actorUser?.role ?? null,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      occurredAt: event.occurredAt.toISOString(),
      metadata: event.metadata ?? null,
    }));
  });

  app.get('/roles', { preHandler: ownerAdminRoles }, async request => {
    const roles = await db.roleDefinition.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    const users = await db.user.groupBy({ by: ['role'], where: { tenantId: request.auth.tenantId }, _count: { _all: true } });
    const counts = new Map(users.map(row => [row.role, row._count._all]));
    return {
      roles: [
        ...rolePermissionMatrix.map(permission => ({
          id: permission.role,
          name: permission.role,
          enumValue: permission.role,
          description: controlPlaneRoles[permission.role]?.scope ?? 'Assigned access',
          accent: permission.risk === 'high' ? 'red' : permission.risk === 'medium' ? 'amber' : 'blue',
          userCount: counts.get(permission.role as never) ?? 0,
          moduleAccess: permission.modules,
          clinicScope: permission.scope,
          risk: permission.risk,
        })),
        ...roles.map(role => ({
          id: role.id,
          name: role.name,
          enumValue: role.name.toUpperCase().replace(/\s+/g, '_'),
          description: role.description,
          accent: role.accent,
          userCount: counts.get(role.name.toUpperCase().replace(/\s+/g, '_') as never) ?? 0,
          moduleAccess: controlPlaneRoles.OWNER.modules,
          clinicScope: 'Tenant-wide',
          risk: 'low' as const,
        })),
      ],
      permissionMatrix: rolePermissionMatrix,
      moduleSummary: [
        { module: 'Command Center', permissions: ['view_dashboard', 'view_opportunities'] },
        { module: 'Growth', permissions: ['view_crm', 'manage_crm', 'view_campaigns', 'manage_campaigns', 'launch_campaigns'] },
        { module: 'Revenue', permissions: ['view_revenue_leaks', 'manage_revenue_leaks', 'view_revenue_protection', 'manage_revenue_protection', 'manage_payments', 'manage_insurance'] },
        { module: 'Operations', permissions: ['view_patients', 'manage_patients', 'view_schedule', 'manage_schedule', 'view_staff', 'manage_staff'] },
        { module: 'Platform', permissions: ['view_integrations', 'manage_integrations', 'view_security', 'manage_security', 'view_audit_logs', 'manage_users', 'manage_roles'] },
      ],
    };
  });

  app.get('/tenants', { preHandler: ownerAdminRoles }, async request => {
    const tenant = await db.tenant.findUnique({
      where: { id: request.auth.tenantId },
      include: {
        branches: { select: { id: true, name: true, location: true, active: true } },
        integrations: { select: { id: true, key: true, status: true, lastSyncAt: true } },
        revenueProtectionAlerts: { select: { id: true, severity: true, status: true } },
      },
    });
    return { tenants: tenant ? [tenant] : [] };
  });

  app.get('/clinics', { preHandler: ownerAdminRoles }, async request => {
    const clinics = await db.branch.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        location: true,
        active: true,
        users: { select: { id: true } },
        integrationRunLogs: { select: { id: true, status: true, createdAt: true } },
        revenueProtectionAlerts: { select: { id: true, severity: true, status: true } },
      },
    });
    return clinics.map(clinic => ({
      ...clinic,
      userCount: clinic.users.length,
      integrationCount: clinic.integrationRunLogs.length,
      securityAlerts: clinic.revenueProtectionAlerts.length,
    }));
  });

  app.patch('/clinics/:id/status', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { active } = clinicStatusBody.parse(request.body);
    const updated = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockClinicAccessMutation(tx, request.auth.tenantId);
      const clinic = await tx.branch.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!clinic) throw app.httpErrors.notFound('Clinic not found');
      if (!active) {
        const assignedActiveUsers = await tx.user.count({ where: { tenantId: request.auth.tenantId, active: true, OR: [{ branchId: id }, { clinicAccesses: { some: { branchId: id } } }] } });
        if (assignedActiveUsers > 0) throw app.httpErrors.conflict('Reassign or deactivate active clinic users before deactivating this clinic');
      }
      const branch = await tx.branch.update({ where: { id }, data: { active } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'controlPlane.clinic.statusUpdated', resource: 'branch', resourceId: id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], metadata: { active },
      } });
      return branch;
    });
    return reply.send({ id: updated.id, active: updated.active });
  });

  app.get('/audit-logs', { preHandler: ownerAdminRoles }, async request => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      userId: uuid.optional(),
      module: z.string().trim().optional(),
      action: z.string().trim().optional(),
      from: z.string().trim().optional(),
      to: z.string().trim().optional(),
      result: z.enum(['success', 'failed', 'all']).default('all'),
    }).parse(request.query);

    const logs = await db.auditEvent.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...(query.userId ? { actorUserId: query.userId } : {}),
        ...(query.module ? { resource: query.module } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.from || query.to ? {
          occurredAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: query.limit,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    return logs.map(event => ({
      id: event.id,
      action: event.action,
      module: event.resource,
      resource: event.resourceId,
      actor: event.actorUser?.displayName ?? safeEmail(event.metadata) ?? 'System',
      role: event.actorUser?.role ?? null,
      tenantId: request.auth.tenantId,
      clinicId: null,
      result: event.action.includes('failed') ? 'failed' : 'success',
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      details: event.metadata ?? null,
      occurredAt: event.occurredAt.toISOString(),
    }));
  });

  app.get('/audit-logs/export.csv', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const query = z.object({
      userId: uuid.optional(),
      module: z.string().trim().optional(),
      action: z.string().trim().optional(),
      from: z.string().trim().optional(),
      to: z.string().trim().optional(),
    }).parse(request.query);
    const logs = await db.auditEvent.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...(query.userId ? { actorUserId: query.userId } : {}),
        ...(query.module ? { resource: query.module } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.from || query.to ? {
          occurredAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: 500,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    const escapeCsv = (value: unknown) => {
      const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [
      ['occurredAt', 'actor', 'role', 'action', 'module', 'resource', 'result', 'details'],
      ...logs.map(event => [
        event.occurredAt.toISOString(),
        event.actorUser?.displayName ?? safeEmail(event.metadata) ?? 'System',
        event.actorUser?.role ?? '',
        event.action,
        event.resource,
        event.resourceId ?? '',
        event.action.includes('failed') ? 'failed' : 'success',
        event.metadata ?? '',
      ]),
    ];
    const csv = rows.map(row => row.map(escapeCsv).join(',')).join('\n');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="control-plane-audit.csv"')
      .send(csv);
  });

  app.get('/security-posture', { preHandler: ownerAdminRoles }, async request => {
    const integrationRows = await buildIntegrationRows(db, request.auth.tenantId);
    const paymentRows = await buildFinanceRails(db, request.auth.tenantId);
    const auditCount = await db.auditEvent.count({ where: { tenantId: request.auth.tenantId } });
    return buildSecurityPosture(request.auth.tenantId, integrationRows, paymentRows, auditCount);
  });

  app.get('/security-events', { preHandler: ownerAdminRoles }, async request => {
    const events = await db.auditEvent.findMany({
      where: { tenantId: request.auth.tenantId, action: { startsWith: 'auth.' } },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    return events.map(event => ({
      id: event.id,
      action: event.action,
      actor: event.actorUser?.displayName ?? safeEmail(event.metadata) ?? 'System',
      role: event.actorUser?.role ?? null,
      status: event.action.endsWith('failed') ? 'failed' : 'success',
      occurredAt: event.occurredAt.toISOString(),
      details: event.metadata ?? null,
    }));
  });

  app.get('/sessions', { preHandler: ownerAdminRoles }, async request => {
    const users = await db.user.findMany({
      where: {
        tenantId: request.auth.tenantId,
        refreshTokenHash: { not: null },
        refreshTokenExpiresAt: { gt: new Date() },
      },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
      include: {
        branch: { select: { id: true, name: true, location: true } },
        clinicAccesses: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include: { branch: { select: { id: true, name: true, location: true } } },
        },
      },
    });
    const loginEvents = await db.auditEvent.findMany({
      where: { tenantId: request.auth.tenantId, action: 'auth.login.success' },
      orderBy: { occurredAt: 'desc' },
      take: 100,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    return users.map(user => {
      const lastLogin = loginEvents.find(event => event.actorUserId === user.id);
      return {
        id: user.id,
        user: {
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          role: user.role,
          branch: user.branch ? { id: user.branch.id, name: user.branch.name, location: user.branch.location } : null,
        },
        issuedAt: user.lastLoginAt?.toISOString() ?? null,
        expiresAt: user.refreshTokenExpiresAt?.toISOString() ?? null,
        revoked: !user.refreshTokenHash,
        lastActivityAt: user.lastLoginAt?.toISOString() ?? null,
        lastLoginAudit: lastLogin ? {
          occurredAt: lastLogin.occurredAt.toISOString(),
          ipAddress: lastLogin.ipAddress,
          userAgent: lastLogin.userAgent,
        } : null,
        accessBranches: user.clinicAccesses.map(access => ({
          id: access.branch.id,
          name: access.branch.name,
          location: access.branch.location,
          isPrimary: access.isPrimary,
        })),
      };
    });
  });

  app.patch('/sessions/:id/revoke', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const existing = await db.user.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Session not found');
    await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.user.update({ where: { id }, data: { refreshTokenHash: null, refreshTokenExpiresAt: null } });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: 'controlPlane.session.revoked',
        resource: 'session',
        resourceId: id,
        requestId: request.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { reason: 'owner-admin-revoked' },
      } });
    });
    return reply.code(204).send();
  });

  app.get('/system-health', { preHandler: ownerAdminRoles }, async request => buildSystemHealth(request.auth.tenantId));
};
