import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requirePermission, PERMISSIONS, ROLE_PERMISSIONS, sanitizePermissions } from '../../lib/permissions';
import { runWithTenantContext } from '../../lib/tenantContext';
import { checkRlsRuntimeRole } from '../../lib/rlsGuard';
import { setUserActiveSafely, setUserRoleSafely } from '../../lib/adminSafety';

const uuid = z.string().uuid();
// Permission-gated (defaults preserve the prior role membership):
//   settings:write → OWNER/ADMIN/MANAGER · admin:manage → OWNER/ADMIN
const writeRoles = requirePermission('settings:write');
const ownerAdminRoles = requirePermission('admin:manage');
const idParam = z.object({ id: uuid });
const accessTokenTtlMinutes = 15;

const ROLE_ACCESS: Record<string, { scope: string; modules: string[] }> = {
  Owner: {
    scope: 'Tenant-wide, all clinics',
    modules: ['Dashboard', 'Advisory Room', 'CRM', 'Campaigner', 'Autopilot', 'Revenue', 'Patients', 'Scheduling', 'Staff', 'Integrations', 'Security/Admin', 'Settings'],
  },
  Admin: {
    scope: 'Tenant-wide, all clinics',
    modules: ['Dashboard', 'Advisory Room', 'CRM', 'Campaigner', 'Autopilot', 'Revenue', 'Patients', 'Scheduling', 'Staff', 'Integrations', 'Security/Admin', 'Settings'],
  },
  'Branch Manager': {
    scope: 'Assigned clinics',
    modules: ['Dashboard', 'Advisory Room', 'CRM', 'Campaigner', 'Autopilot', 'Revenue', 'Patients', 'Scheduling', 'Staff', 'Settings'],
  },
  Billing: {
    scope: 'Finance / payment workflows',
    modules: ['Revenue', 'Integrations', 'Settings'],
  },
  Provider: {
    scope: 'Primary clinic',
    modules: ['Dashboard', 'Advisory Room', 'Patients', 'Scheduling', 'Staff', 'Settings'],
  },
  'Front Desk': {
    scope: 'Assigned clinic',
    modules: ['Dashboard', 'Advisory Room', 'CRM', 'Campaigner', 'Autopilot', 'Patients', 'Scheduling', 'Staff'],
  },
  Analyst: {
    scope: 'Tenant-wide, read-only',
    modules: ['Dashboard', 'Advisory Room', 'Revenue', 'Patients', 'Scheduling', 'Staff', 'Settings'],
  },
  // Descriptive module guidance only (RoleDefinition is not the enforcement
  // layer). Actual access is enforced by route role checks in the compliance module.
  'Compliance Officer': {
    scope: 'Compliance module',
    modules: ['Compliance Readiness: manage', 'Evidence Vault: manage', 'Risks/Vendors/Incidents: manage', 'Reports/Audit Logs: view'],
  },
  Auditor: {
    scope: 'Compliance module, read-only',
    modules: ['Compliance Readiness: view', 'Evidence Vault: view', 'Reports/Audit Logs: view'],
  },
};

function roleAccess(name: string) {
  return ROLE_ACCESS[name] ?? { scope: 'Assigned clinic', modules: [] };
}

type AdminBranch = {
  id: string;
  name: string;
  location: string;
  active?: boolean;
};

type AdminClinicAccess = {
  id: string;
  branchId: string;
  isPrimary: boolean;
  branch: AdminBranch;
};

type AdminUserRecord = {
  id: string;
  displayName: string;
  email: string;
  role: string;
  branchId: string | null;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  branch: AdminBranch | null;
};

type AdminUserSource = AdminUserRecord & {
  clinicAccesses: AdminClinicAccess[];
};

type AdminRoleRecord = {
  id: string;
  name: string;
  description: string;
  accent: string;
};

type AdminRoleSource = AdminRoleRecord & {
  sortOrder: number;
  createdAt: Date;
};

type AdminAuditRecord = {
  id: string;
  action: string;
  resource: string;
  resourceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  occurredAt: Date;
  metadata: unknown;
  actorUser: { displayName: string | null; email: string | null; role: string | null } | null;
};

type AdminBranchAccessRecord = {
  id: string;
  user: {
    id: string;
    displayName: string;
    email: string;
    role: string;
  };
  branch: AdminBranch;
  isPrimary: boolean;
};

type AdminData = {
  tenant: {
    id: string;
    name: string;
    slug: string;
    createdAt: Date;
    updatedAt: Date;
  };
  branches: AdminBranch[];
  users: Array<{
    id: string;
    displayName: string;
    email: string;
    role: string;
    active: boolean;
    branchId: string | null;
    branch: AdminBranch | null;
    accessBranches: Array<{ id: string; name: string; location: string; isPrimary: boolean }>;
    lastLoginAt: string | null;
    createdAt: string;
    updatedAt: string;
    sessionActive: boolean;
  }>;
  roles: Array<AdminRoleRecord & {
    enumValue: string;
    userCount: number;
    moduleAccess: string[];
    clinicScope: string;
  }>;
  permissionMatrix: Array<{ role: string; scope: string; modules: string[] }>;
  auditEvents: Array<{
    id: string;
    action: string;
    resource: string;
    resourceId: string | null;
    actor: string;
    ipAddress: string | null;
    userAgent: string | null;
    occurredAt: string;
    metadata: unknown;
  }>;
  branchAccess: Array<{
    id: string;
    userId: string;
    userName: string;
    userEmail: string;
    userRole: string;
    branchId: string;
    branchName: string;
    branchLocation: string;
    isPrimary: boolean;
  }>;
};

function safeEmail(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object') return null;
  const email = (metadata as { email?: unknown }).email;
  return typeof email === 'string' ? email : null;
}

async function loadAdminData(tenantId: string): Promise<AdminData> {
  const [tenant, branches, users, roles, auditEvents, accessRows] = await Promise.all([
    db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
    }),
    db.branch.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, location: true, active: true },
    }),
    db.user.findMany({
      where: { tenantId },
      orderBy: [{ active: 'desc' }, { displayName: 'asc' }],
      select: {
        id: true,
        displayName: true,
        email: true,
        role: true,
        branchId: true,
        active: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        branch: { select: { id: true, name: true, location: true } },
        clinicAccesses: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            branchId: true,
            isPrimary: true,
            branch: { select: { id: true, name: true, location: true } },
          },
        },
      },
    }),
    db.roleDefinition.findMany({
      where: { tenantId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    db.auditEvent.findMany({
      where: { tenantId },
      orderBy: { occurredAt: 'desc' },
      take: 24,
      include: { actorUser: { select: { displayName: true, email: true } } },
    }),
    db.userClinicAccess.findMany({
      where: { tenantId },
      include: { branch: { select: { id: true, name: true, location: true } }, user: { select: { id: true, displayName: true, email: true, role: true } } },
    }),
  ]) as [
    AdminData['tenant'] | null,
    AdminBranch[],
    AdminUserSource[],
    AdminRoleSource[],
    AdminAuditRecord[],
    AdminBranchAccessRecord[],
  ];

  if (!tenant) throw new Error('Tenant not found');

  const userCountByRole = new Map<string, number>();
  for (const user of users) {
    userCountByRole.set(user.role, (userCountByRole.get(user.role) ?? 0) + 1);
  }

  return {
    tenant,
    branches,
    users: users.map((user: AdminUserSource) => {
      const accessBranches = user.clinicAccesses.length > 0
        ? user.clinicAccesses.map((access: AdminClinicAccess) => ({
            id: access.branch.id,
            name: access.branch.name,
            location: access.branch.location,
            isPrimary: access.isPrimary,
          }))
        : user.branch
          ? [{ id: user.branch.id, name: user.branch.name, location: user.branch.location, isPrimary: true }]
          : [];

      return {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        active: user.active,
        branchId: user.branchId,
        branch: user.branch,
        accessBranches,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        sessionActive: Boolean(user.lastLoginAt && user.active),
      };
    }),
    roles: roles.map((role: AdminRoleSource) => {
      const access = roleAccess(role.name);
      const roleKey = role.name === 'Owner'
        ? 'OWNER'
        : role.name === 'Branch Manager'
          ? 'MANAGER'
          : role.name === 'Billing'
            ? 'BILLING'
          : role.name === 'Provider'
            ? 'PROVIDER'
            : role.name === 'Front Desk'
              ? 'FRONT_DESK'
              : role.name === 'Admin'
                ? 'ADMIN'
                : 'ANALYST';
      return {
        id: role.id,
        name: role.name,
        enumValue: roleKey,
        description: role.description,
        accent: role.accent,
        userCount: userCountByRole.get(roleKey) ?? 0,
        moduleAccess: access.modules,
        clinicScope: access.scope,
      };
    }),
    permissionMatrix: Object.entries(ROLE_ACCESS).map(([role, access]) => ({
      role,
      scope: access.scope,
      modules: access.modules,
    })),
    auditEvents: auditEvents.map((event: AdminAuditRecord) => ({
      id: event.id,
      action: event.action,
      resource: event.resource,
      resourceId: event.resourceId,
      actor: event.actorUser?.displayName ?? event.actorUser?.email ?? 'System',
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      occurredAt: event.occurredAt.toISOString(),
      metadata: event.metadata ?? null,
    })),
    branchAccess: accessRows.map((access: AdminBranchAccessRecord) => ({
      id: access.id,
      userId: access.user.id,
      userName: access.user.displayName,
      userEmail: access.user.email,
      userRole: access.user.role,
      branchId: access.branch.id,
      branchName: access.branch.name,
      branchLocation: access.branch.location,
      isPrimary: access.isPrimary,
    })),
  };
}

async function replaceUserClinicAccess(request: FastifyRequest, userId: string, branchIds: string[], primaryBranchId?: string) {
  const tenantId = request.auth.tenantId;
  const orderedBranchIds = primaryBranchId
    ? [primaryBranchId, ...branchIds.filter(id => id !== primaryBranchId)]
    : branchIds;
  await runWithTenantContext(tenantId, async tx => {
    await tx.userClinicAccess.deleteMany({ where: { tenantId, userId } });
    if (orderedBranchIds.length > 0) {
      await tx.userClinicAccess.createMany({
        data: orderedBranchIds.map((branchId, index) => ({ tenantId, userId, branchId, isPrimary: index === 0 })),
      });
    }
    await tx.user.update({ where: { id: userId }, data: { branchId: orderedBranchIds[0] ?? null } });
    await tx.auditEvent.create({ data: {
      tenantId,
      actorUserId: request.auth.userId,
      action: 'admin.user.branchAccessUpdated',
      resource: 'user',
      resourceId: userId,
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { branchIds: orderedBranchIds },
    } });
  });
}

export const settingsRoutes: FastifyPluginAsync = async app => {
  // ---- Notification templates ----------------------------------------------
  const templateCreate = z.object({
    name: z.string().trim().min(2).max(160),
    channel: z.string().trim().min(2).max(80),
    status: z.enum(['ACTIVE', 'PAUSED']).default('ACTIVE'),
  });
  const templateUpdate = templateCreate.partial();

  // RLS pilot: NotificationTemplate is tenant-isolated at the DB. All reads/
  // writes run inside runWithTenantContext so app.current_tenant_id is set on
  // the same connection (tx) the query uses.
  app.get('/notification-templates', async request => {
    return runWithTenantContext(request.auth.tenantId, tx =>
      tx.notificationTemplate.findMany({
        where: { tenantId: request.auth.tenantId },
        orderBy: { createdAt: 'asc' },
      }));
  });

  app.post('/notification-templates', { preHandler: writeRoles }, async (request, reply) => {
    const input = templateCreate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, tx =>
      tx.notificationTemplate.create({ data: { tenantId: request.auth.tenantId, ...input } }));
    await audit(request, { action: 'notificationTemplate.created', resource: 'notificationTemplate', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/notification-templates/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = templateUpdate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.notificationTemplate.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Template not found');
      return tx.notificationTemplate.update({ where: { id }, data: input });
    });
    await audit(request, { action: 'notificationTemplate.updated', resource: 'notificationTemplate', resourceId: id });
    return row;
  });

  app.delete('/notification-templates/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.notificationTemplate.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Template not found');
      await tx.notificationTemplate.delete({ where: { id } });
    });
    await audit(request, { action: 'notificationTemplate.deleted', resource: 'notificationTemplate', resourceId: id });
    return reply.code(204).send();
  });

  // ---- AI guardrails --------------------------------------------------------
  const guardrailCreate = z.object({
    rule: z.string().trim().min(4).max(500),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  });
  const guardrailUpdate = guardrailCreate.partial();

  // RLS pilot: AiGuardrail is tenant-isolated at the DB.
  app.get('/guardrails', async request => {
    return runWithTenantContext(request.auth.tenantId, tx =>
      tx.aiGuardrail.findMany({
        where: { tenantId: request.auth.tenantId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }));
  });

  app.post('/guardrails', { preHandler: writeRoles }, async (request, reply) => {
    const input = guardrailCreate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, tx =>
      tx.aiGuardrail.create({ data: { tenantId: request.auth.tenantId, ...input } }));
    await audit(request, { action: 'guardrail.created', resource: 'aiGuardrail', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/guardrails/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = guardrailUpdate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.aiGuardrail.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Guardrail not found');
      return tx.aiGuardrail.update({ where: { id }, data: input });
    });
    await audit(request, { action: 'guardrail.updated', resource: 'aiGuardrail', resourceId: id });
    return row;
  });

  app.delete('/guardrails/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.aiGuardrail.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Guardrail not found');
      await tx.aiGuardrail.delete({ where: { id } });
    });
    await audit(request, { action: 'guardrail.deleted', resource: 'aiGuardrail', resourceId: id });
    return reply.code(204).send();
  });

  // ---- Customer communication preferences -----------------------------------
  const preferenceCreate = z.object({
    label: z.string().trim().min(2).max(160),
    description: z.string().trim().min(2).max(500),
    enabled: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  });
  const preferenceUpdate = preferenceCreate.partial();

  // RLS pilot: CustomerPreference is tenant-isolated at the DB.
  app.get('/preferences', async request => {
    return runWithTenantContext(request.auth.tenantId, tx =>
      tx.customerPreference.findMany({
        where: { tenantId: request.auth.tenantId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }));
  });

  app.post('/preferences', { preHandler: writeRoles }, async (request, reply) => {
    const input = preferenceCreate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, tx =>
      tx.customerPreference.create({ data: { tenantId: request.auth.tenantId, ...input } }));
    await audit(request, { action: 'preference.created', resource: 'customerPreference', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/preferences/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = preferenceUpdate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.customerPreference.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Preference not found');
      return tx.customerPreference.update({ where: { id }, data: input });
    });
    await audit(request, { action: 'preference.updated', resource: 'customerPreference', resourceId: id });
    return row;
  });

  app.delete('/preferences/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.customerPreference.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Preference not found');
      await tx.customerPreference.delete({ where: { id } });
    });
    await audit(request, { action: 'preference.deleted', resource: 'customerPreference', resourceId: id });
    return reply.code(204).send();
  });

  // ---- Role definitions -----------------------------------------------------
  // Descriptive role catalogue for display/editing. The live user count is
  // computed from User.role; this does not alter the auth UserRole enum.
  const ROLE_MAP: Record<string, string> = {
    Owner: 'OWNER',
    'Branch Manager': 'MANAGER',
    Billing: 'BILLING',
    Provider: 'PROVIDER',
    'Front Desk': 'FRONT_DESK',
    Admin: 'ADMIN',
    Analyst: 'ANALYST',
    'Compliance Officer': 'COMPLIANCE_OFFICER',
    Auditor: 'AUDITOR',
  };
  const roleCreate = z.object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().min(2).max(500),
    accent: z.string().trim().min(2).max(20).default('blue'),
    sortOrder: z.number().int().min(0).default(0),
    // Optional per-tenant permission override. Sanitised against the vocabulary
    // before persistence; null/omitted leaves the code-default matrix in effect.
    permissions: z.array(z.string()).max(PERMISSIONS.length).optional(),
  });
  const roleUpdate = roleCreate.partial();

  // Read-only catalogue so an admin UI can build a real permission editor:
  // the full vocabulary + the default grant matrix the override replaces.
  app.get('/permissions/catalog', { preHandler: ownerAdminRoles }, async () => ({
    permissions: PERMISSIONS,
    defaultMatrix: ROLE_PERMISSIONS,
  }));

  app.get('/roles', async request => {
    const [roles, counts] = await Promise.all([
      db.roleDefinition.findMany({
        where: { tenantId: request.auth.tenantId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      db.user.groupBy({ by: ['role'], where: { tenantId: request.auth.tenantId }, _count: { _all: true } }),
    ]);
    const countByRole = new Map(counts.map((entry: { role: string; _count: { _all: number } }) => [entry.role, entry._count._all]));
    return roles.map((role: AdminRoleRecord) => {
      const roleKey = ROLE_MAP[role.name] ?? 'ANALYST';
      return {
        ...role,
        userCount: countByRole.get(roleKey) ?? 0,
      };
    });
  });

  app.post('/roles', { preHandler: writeRoles }, async (request, reply) => {
    const { permissions, ...input } = roleCreate.parse(request.body);
    const row = await db.roleDefinition.create({
      data: {
        tenantId: request.auth.tenantId,
        ...input,
        ...(permissions !== undefined ? { permissions: sanitizePermissions(permissions) } : {}),
      },
    });
    await audit(request, { action: 'role.created', resource: 'roleDefinition', resourceId: row.id, metadata: permissions !== undefined ? { permissions: sanitizePermissions(permissions) } : undefined });
    return reply.code(201).send(row);
  });

  app.patch('/roles/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const { permissions, ...input } = roleUpdate.parse(request.body);
    const existing = await db.roleDefinition.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Role not found');
    const row = await db.roleDefinition.update({
      where: { id },
      data: {
        ...input,
        ...(permissions !== undefined ? { permissions: sanitizePermissions(permissions) } : {}),
      },
    });
    await audit(request, { action: 'role.updated', resource: 'roleDefinition', resourceId: id, metadata: permissions !== undefined ? { permissions: sanitizePermissions(permissions) } : undefined });
    return row;
  });

  app.delete('/roles/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.roleDefinition.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Role not found');
    await db.roleDefinition.delete({ where: { id } });
    await audit(request, { action: 'role.deleted', resource: 'roleDefinition', resourceId: id });
    return reply.code(204).send();
  });

  app.get('/admin/overview', { preHandler: ownerAdminRoles }, async request => {
    const data = await loadAdminData(request.auth.tenantId);
    return {
      summary: {
        totalUsers: data.users.length,
        activeUsers: data.users.filter(user => user.active).length,
        totalRoles: data.roles.length,
        activeBranches: data.branches.filter(branch => branch.active).length,
        recentAuditEvents: data.auditEvents.length,
      },
      users: data.users,
      roles: data.roles,
      permissionMatrix: data.permissionMatrix,
      auditEvents: data.auditEvents,
    };
  });
};

export const adminRoutes: FastifyPluginAsync = async app => {
  const adminUserQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    search: z.string().trim().optional(),
    role: z.enum(['OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']).optional(),
    active: z.enum(['active', 'inactive', 'all']).default('all'),
    branchId: uuid.optional(),
  });

  const auditQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    userId: uuid.optional(),
    action: z.string().trim().optional(),
    module: z.string().trim().optional(),
    from: z.string().trim().optional(),
    to: z.string().trim().optional(),
  });

  const branchAccessBody = z.object({
    branchIds: z.array(uuid).default([]),
    primaryBranchId: uuid.optional(),
  });

  const roleBody = z.object({
    role: z.enum(['OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'PROVIDER', 'FRONT_DESK', 'ANALYST', 'COMPLIANCE_OFFICER', 'AUDITOR']),
  });

  const statusBody = z.object({
    active: z.boolean(),
  });

  app.get('/overview', { preHandler: ownerAdminRoles }, async request => {
    const data = await loadAdminData(request.auth.tenantId);
    return {
      summary: {
        totalUsers: data.users.length,
        activeUsers: data.users.filter(user => user.active).length,
        totalRoles: data.roles.length,
        activeBranches: data.branches.filter(branch => branch.active).length,
        recentAuditEvents: data.auditEvents.length,
      },
      tenant: data.tenant,
      branches: data.branches,
      users: data.users,
      roles: data.roles,
      permissionMatrix: data.permissionMatrix,
      auditEvents: data.auditEvents,
      branchAccess: data.branchAccess,
    };
  });

  app.get('/users', { preHandler: ownerAdminRoles }, async request => {
    const query = adminUserQuery.parse(request.query);
    const data = await loadAdminData(request.auth.tenantId);
    const users = data.users.filter(user => {
      const matchesSearch = !query.search
        || user.displayName.toLowerCase().includes(query.search.toLowerCase())
        || user.email.toLowerCase().includes(query.search.toLowerCase());
      const matchesRole = !query.role || user.role === query.role;
      const matchesActive = query.active === 'all' || (query.active === 'active' ? user.active : !user.active);
      const matchesBranch = !query.branchId || user.accessBranches.some(branch => branch.id === query.branchId);
      return matchesSearch && matchesRole && matchesActive && matchesBranch;
    }).slice(0, query.limit);

    return {
      tenant: data.tenant,
      branches: data.branches,
      summary: {
        totalUsers: data.users.length,
        activeUsers: data.users.filter(user => user.active).length,
        inactiveUsers: data.users.filter(user => !user.active).length,
        activeBranches: data.branches.filter(branch => branch.active).length,
      },
      users,
    };
  });

  app.patch('/users/:id/status', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = statusBody.parse(request.body);
    const updated = await setUserActiveSafely(request, id, input.active, input.active ? 'admin.user.activated' : 'admin.user.deactivated');
    return reply.send({
      id: updated.id,
      active: updated.active,
    });
  });

  app.patch('/users/:id/role', { preHandler: ownerAdminRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = roleBody.parse(request.body);
    const updated = await setUserRoleSafely(request, id, input.role, 'admin.user.roleChanged');
    return { id: updated.id, role: updated.role };
  });

  app.patch('/users/:id/branches', { preHandler: ownerAdminRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = branchAccessBody.parse(request.body);
    const existing = await db.user.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('User not found');

    const branchIds = [...new Set(input.branchIds)];
    if (input.primaryBranchId && !branchIds.includes(input.primaryBranchId)) {
      throw app.httpErrors.badRequest('Primary branch must be included in selected clinic access');
    }
    if (branchIds.length === 0 && existing.role !== 'OWNER' && existing.role !== 'ADMIN') {
      throw app.httpErrors.badRequest('At least one clinic access entry is required');
    }

    const validBranches = branchIds.length > 0
      ? await db.branch.findMany({
          where: { tenantId: request.auth.tenantId, active: true, id: { in: branchIds } },
          select: { id: true },
        })
      : [];
    if (validBranches.length !== branchIds.length) {
      throw app.httpErrors.badRequest('Every selected clinic must be active and belong to this tenant');
    }
    const primaryBranchId = input.primaryBranchId ?? branchIds[0];
    await replaceUserClinicAccess(request, id, branchIds, primaryBranchId);

    const refreshed = await db.user.findFirst({
      where: { id, tenantId: request.auth.tenantId },
      include: {
        branch: { select: { id: true, name: true, location: true } },
        clinicAccesses: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include: { branch: { select: { id: true, name: true, location: true } } },
        },
      },
    });
    return {
      id: refreshed?.id ?? id,
      accessBranches: (refreshed?.clinicAccesses ?? []).map((access: { branch: { id: string; name: string; location: string }; isPrimary: boolean }) => ({
        id: access.branch.id,
        name: access.branch.name,
        location: access.branch.location,
        isPrimary: access.isPrimary,
      })),
      primaryBranchId: refreshed?.branchId ?? null,
    };
  });

  app.get('/roles', { preHandler: ownerAdminRoles }, async request => {
    const data = await loadAdminData(request.auth.tenantId);
    return {
      roles: data.roles,
      permissionMatrix: data.permissionMatrix,
    };
  });

  app.get('/audit-logs', { preHandler: ownerAdminRoles }, async request => {
    const query = auditQuery.parse(request.query);
    const where = {
      tenantId: request.auth.tenantId,
      ...(query.userId ? { actorUserId: query.userId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.module ? { resource: query.module } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    } as const;

    const logs = await db.auditEvent.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: query.limit,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });

    return logs.map(event => ({
      id: event.id,
      action: event.action,
      resource: event.resource,
      resourceId: event.resourceId,
      actor: event.actorUser?.displayName ?? event.actorUser?.email ?? 'System',
      role: event.actorUser?.role ?? null,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      occurredAt: event.occurredAt.toISOString(),
      metadata: event.metadata ?? null,
    }));
  });
};

export const securityRoutes: FastifyPluginAsync = async app => {
  const sessionQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  const loginHistoryQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    userId: uuid.optional(),
  });

  app.get('/posture', { preHandler: ownerAdminRoles }, async request => {
    const [integrationRows, paymentRows, auditCount, loginCount, rlsRole] = await Promise.all([
      db.integration.findMany({ where: { tenantId: request.auth.tenantId } }),
      db.paymentProviderConnection.findMany({ where: { tenantId: request.auth.tenantId } }),
      db.auditEvent.count({ where: { tenantId: request.auth.tenantId } }),
      db.auditEvent.count({
        where: {
          tenantId: request.auth.tenantId,
          action: { startsWith: 'auth.login' },
        },
      }),
      checkRlsRuntimeRole(),
    ]);

    const alerts = [
      rlsRole.bypassesRls
        ? {
            severity: env.NODE_ENV === 'production' ? 'high' : 'low',
            title: 'Database role bypasses row-level security',
            message: `Runtime role "${rlsRole.role}" can bypass RLS (${rlsRole.isSuperuser ? 'superuser' : 'rolbypassrls'}); tenant RLS policies are not enforced at the DB. Use the restricted app_rls role for the runtime DATABASE_URL.`,
          }
        : null,
      env.NODE_ENV === 'production'
        ? null
        : {
            severity: 'info',
            title: 'Dev token available in development',
            message: 'Dev-token bootstrap is only enabled outside production.',
          },
      !env.JWT_SECRET
        ? {
            severity: 'high',
            title: 'JWT secret missing',
            message: 'JWT_SECRET must be configured for access token signing.',
          }
        : null,
      !env.JWT_REFRESH_SECRET
        ? {
            severity: 'high',
            title: 'Refresh secret missing',
            message: 'JWT_REFRESH_SECRET must be configured for refresh token hashing.',
          }
        : null,
      env.NODE_ENV === 'production'
        ? null
        : {
            severity: 'medium',
            title: 'HTTPS required in production',
            message: 'Refresh cookies are secure in production, but production must serve over HTTPS.',
          },
      env.INSURANCE_PROVIDER === 'mock'
        ? {
            severity: 'medium',
            title: 'Insurance provider in mock mode',
            message: 'Mock eligibility is active until a sandbox or live provider is configured.',
          }
        : null,
      env.PAYMENT_PROVIDER === 'mock'
        ? {
            severity: 'medium',
            title: 'Payment provider in mock mode',
            message: 'Mock payments are active until a sandbox or live payment provider is configured.',
          }
        : null,
      env.AI_PROVIDER === 'mock'
        ? {
            severity: 'low',
            title: 'AI provider in mock mode',
            message: 'The advisory layer is using mock responses until an Ollama, OpenAI, or Claude provider is configured.',
          }
        : null,
      !env.STRIPE_WEBHOOK_SECRET && env.PAYMENT_PROVIDER === 'stripe'
        ? {
            severity: 'medium',
            title: 'Stripe webhook not configured',
            message: 'Set STRIPE_WEBHOOK_SECRET to validate payment webhooks safely.',
          }
        : null,
      integrationRows.some(integration => integration.status !== 'CONNECTED')
        ? {
            severity: 'low',
            title: 'Some integrations are not connected',
            message: 'One or more integration records are disconnected or awaiting configuration.',
          }
        : null,
      integrationRows.length === 0
        ? {
            severity: 'low',
            title: 'No connected integrations',
            message: 'Integration statuses are available, but nothing is connected yet.',
          }
        : null,
    ].filter(Boolean);

    return {
      authMode: env.NODE_ENV === 'production' ? 'password+refresh-cookie' : 'password+refresh-cookie with explicit dev-token fallback',
      refreshCookie: {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/v1/auth',
      },
      csrf: {
        enabled: true,
        strategy: 'double-submit cookie/header',
      },
      rbacEnabled: true,
      rlsRuntimeRole: {
        role: rlsRole.role,
        bypassesRls: rlsRole.bypassesRls,
        enforced: !rlsRole.bypassesRls,
      },
      auditLoggingEnabled: true,
      rateLimitingEnabled: true,
      devTokenDisabledInProduction: env.NODE_ENV === 'production',
      httpsRequired: env.NODE_ENV === 'production',
      secrets: {
        jwtSecretConfigured: Boolean(env.JWT_SECRET),
        jwtRefreshSecretConfigured: Boolean(env.JWT_REFRESH_SECRET),
      },
      accessTokenTtlMinutes,
      auditEventCount: auditCount,
      loginEventCount: loginCount,
      integrations: integrationRows.map(integration => ({
        key: integration.key,
        name: integration.name,
        status: integration.status,
        lastSyncAt: integration.lastSyncAt?.toISOString() ?? null,
      })),
      paymentProviders: paymentRows.map(provider => ({
        key: provider.providerKey,
        displayName: provider.displayName,
        mode: provider.mode,
        status: provider.status,
      })),
      alerts,
    };
  });

  app.get('/sessions', { preHandler: ownerAdminRoles }, async request => {
    const query = sessionQuery.parse(request.query);
    const users = await db.user.findMany({
      where: {
        tenantId: request.auth.tenantId,
        refreshTokenHash: { not: null },
        refreshTokenExpiresAt: { gt: new Date() },
      },
      orderBy: [{ lastLoginAt: 'desc' }, { updatedAt: 'desc' }],
      take: query.limit,
      include: {
        branch: { select: { id: true, name: true, location: true } },
        clinicAccesses: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include: { branch: { select: { id: true, name: true, location: true } } },
        },
      },
    });

    const loginEvents = await db.auditEvent.findMany({
      where: {
        tenantId: request.auth.tenantId,
        action: 'auth.login.success',
      },
      orderBy: { occurredAt: 'desc' },
      take: 100,
      include: {
        actorUser: { select: { displayName: true, email: true, role: true } },
      },
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

  app.post('/sessions/:userId/revoke', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const { userId } = z.object({ userId: uuid }).parse(request.params);
    const existing = await db.user.findFirst({ where: { id: userId, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Session not found');
    await db.user.update({
      where: { id: userId },
      data: {
        refreshTokenHash: null,
        refreshTokenExpiresAt: null,
      },
    });
    await audit(request, {
      action: 'auth.session.revoked',
      resource: 'session',
      resourceId: userId,
      metadata: { reason: 'admin-revoked' },
    });
    return reply.code(204).send();
  });

  app.get('/login-history', { preHandler: ownerAdminRoles }, async request => {
    const query = loginHistoryQuery.parse(request.query);
    const logs = await db.auditEvent.findMany({
      where: {
        tenantId: request.auth.tenantId,
        action: { in: ['auth.login.success', 'auth.login.failed', 'auth.logout', 'auth.session.revoked'] },
        ...(query.userId ? { actorUserId: query.userId } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: query.limit,
      include: {
        actorUser: { select: { displayName: true, email: true, role: true } },
      },
    });

    return logs.map((event: AdminAuditRecord) => ({
      id: event.id,
      status: event.action.endsWith('failed') ? 'failed' : 'success',
      action: event.action,
      user: event.actorUser?.displayName ?? safeEmail(event.metadata) ?? 'Unknown',
      email: event.actorUser?.email ?? safeEmail(event.metadata),
      role: event.actorUser?.role ?? null,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      occurredAt: event.occurredAt.toISOString(),
      metadata: event.metadata ?? null,
    }));
  });
};
