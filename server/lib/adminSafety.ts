import type { FastifyRequest } from 'fastify';
import { db } from './db';
import { audit } from './audit';
import { runWithTenantContext } from './tenantContext';
import type { UserRole } from '../generated/prisma/enums';
import { lockClinicAccessMutation } from './clinicAccessSafety';

// ===========================================================================
// Admin role safety guards. Prevent a tenant from locking itself out of
// administrative access via role changes or deactivation. These are app-layer
// safety checks only — they do not change the tenant model or RoleDefinition
// (which remains descriptive). Blocked attempts are recorded in AuditEvent.
// ===========================================================================

const isAdminRole = (role: string) => role === 'OWNER' || role === 'ADMIN';
const requiresClinicAssignment = (role: string) => role === 'MANAGER' || role === 'PROVIDER' || role === 'FRONT_DESK' || role === 'BILLING';

async function activeAdminCount(tenantId: string, excludeUserId?: string) {
  return db.user.count({
    where: {
      tenantId,
      active: true,
      role: { in: ['OWNER', 'ADMIN'] },
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
  });
}

async function recordBlocked(request: FastifyRequest, targetId: string, metadata: Record<string, unknown>) {
  await audit(request, {
    action: 'admin.roleSafety.blocked',
    resource: 'user',
    resourceId: targetId,
    metadata: metadata as Parameters<typeof audit>[1]['metadata'],
  });
}

/**
 * Reject an unsafe role change. A change is unsafe when it removes the last
 * administrative access path:
 *  - self-demotion: an OWNER/ADMIN demoting *themselves* to a non-admin role
 *    (regardless of how many other admins exist — they must not lock themselves
 *    out; another admin can do it).
 *  - last admin: demoting the only remaining active OWNER/ADMIN of the tenant.
 * Promotions, lateral admin changes, and non-admin changes are always allowed.
 */
export async function assertRoleChangeSafe(request: FastifyRequest, target: { id: string; role: string }, newRole: string) {
  const demotingFromAdmin = isAdminRole(target.role) && !isAdminRole(newRole);
  if (!demotingFromAdmin) return;

  if (request.auth.userId === target.id) {
    await recordBlocked(request, target.id, { operation: 'roleChange', reason: 'self_demotion', fromRole: target.role, attemptedRole: newRole });
    throw request.server.httpErrors.conflict('You cannot remove your own administrative access. Ask another OWNER or ADMIN to change your role.');
  }

  if ((await activeAdminCount(request.auth.tenantId, target.id)) < 1) {
    await recordBlocked(request, target.id, { operation: 'roleChange', reason: 'last_admin', fromRole: target.role, attemptedRole: newRole });
    throw request.server.httpErrors.conflict('This is the last active administrator. Assign another OWNER or ADMIN before changing this role.');
  }
}

/**
 * Reject deactivating the last active OWNER/ADMIN of a tenant. Deactivating a
 * non-admin, or an admin while another active admin remains, is allowed.
 */
export async function assertDeactivateSafe(request: FastifyRequest, target: { id: string; role: string }) {
  if (!isAdminRole(target.role)) return;
  if ((await activeAdminCount(request.auth.tenantId, target.id)) < 1) {
    await recordBlocked(request, target.id, { operation: 'deactivate', reason: 'last_admin', role: target.role });
    throw request.server.httpErrors.conflict('This is the last active administrator and cannot be deactivated. Assign another OWNER or ADMIN first.');
  }
}

function auditData(request: FastifyRequest, action: string, targetId: string, metadata: Record<string, unknown>, resource = 'user') {
  return {
    tenantId: request.auth.tenantId,
    actorUserId: request.auth.userId,
    action,
    resource,
    resourceId: targetId,
    requestId: request.id,
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    metadata: metadata as never,
  };
}

/** Serialize the last-admin invariant with the mutation and its audit receipt. */
export async function setUserActiveSafely(request: FastifyRequest, targetId: string, active: boolean, action: string) {
  const result = await runWithTenantContext(request.auth.tenantId, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant.admin.guard:${request.auth.tenantId}`}::text, 0))::text AS locked`;
    await lockClinicAccessMutation(tx, request.auth.tenantId);
    const target = await tx.user.findFirst({ where: { id: targetId, tenantId: request.auth.tenantId } });
    if (!target) return { kind: 'not_found' as const };
    if (active && !target.active) {
      const access = await tx.userClinicAccess.findMany({ where: { tenantId: request.auth.tenantId, userId: target.id }, select: { branchId: true } });
      const assignedIds = [...new Set([target.branchId, ...access.map(row => row.branchId)].filter((id): id is string => Boolean(id)))];
      const activeBranches = assignedIds.length > 0
        ? await tx.branch.count({ where: { tenantId: request.auth.tenantId, id: { in: assignedIds }, active: true } })
        : 0;
      if (activeBranches !== assignedIds.length) {
        await tx.auditEvent.create({ data: auditData(request, 'admin.user.activationBlocked', target.id, { reason: 'inactive_clinic_assignment', branchIds: assignedIds }) });
        return { kind: 'inactive_clinic' as const, message: 'Reassign this user to active clinics before activation.' };
      }
    }
    if (!active && target.active && isAdminRole(target.role)) {
      const remaining = await tx.user.count({ where: { tenantId: request.auth.tenantId, active: true, role: { in: ['OWNER', 'ADMIN'] }, id: { not: target.id } } });
      if (remaining < 1) {
        await tx.auditEvent.create({ data: auditData(request, 'admin.roleSafety.blocked', target.id, { operation: 'deactivate', reason: 'last_admin', role: target.role }) });
        return { kind: 'blocked' as const, message: 'This is the last active administrator and cannot be deactivated. Assign another OWNER or ADMIN first.' };
      }
    }
    const updated = await tx.user.update({
      where: { id: target.id },
      data: { active, ...(active ? {} : { refreshTokenHash: null, refreshTokenExpiresAt: null }) },
    });
    if (!active) {
      await tx.passwordResetToken.updateMany({
        where: { tenantId: request.auth.tenantId, userId: target.id, usedAt: null },
        data: { usedAt: new Date() },
      });
    }
    await tx.auditEvent.create({ data: auditData(request, action, target.id, { active }) });
    return { kind: 'updated' as const, updated };
  });
  if (result.kind === 'not_found') throw request.server.httpErrors.notFound('User not found');
  if (result.kind === 'blocked') throw request.server.httpErrors.conflict(result.message);
  if (result.kind === 'inactive_clinic') throw request.server.httpErrors.conflict(result.message);
  return result.updated;
}

/** Serialize self-demotion/last-admin checks with the role change and audit. */
export async function setUserRoleSafely(request: FastifyRequest, targetId: string, role: UserRole, action: string) {
  const result = await runWithTenantContext(request.auth.tenantId, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant.admin.guard:${request.auth.tenantId}`}::text, 0))::text AS locked`;
    await lockClinicAccessMutation(tx, request.auth.tenantId);
    const target = await tx.user.findFirst({ where: { id: targetId, tenantId: request.auth.tenantId } });
    if (!target) return { kind: 'not_found' as const };
    const demotingFromAdmin = isAdminRole(target.role) && !isAdminRole(role);
    if (demotingFromAdmin && request.auth.userId === target.id) {
      await tx.auditEvent.create({ data: auditData(request, 'admin.roleSafety.blocked', target.id, { operation: 'roleChange', reason: 'self_demotion', fromRole: target.role, attemptedRole: role }) });
      return { kind: 'blocked' as const, message: 'You cannot remove your own administrative access. Ask another OWNER or ADMIN to change your role.' };
    }
    if (demotingFromAdmin && target.active) {
      const remaining = await tx.user.count({ where: { tenantId: request.auth.tenantId, active: true, role: { in: ['OWNER', 'ADMIN'] }, id: { not: target.id } } });
      if (remaining < 1) {
        await tx.auditEvent.create({ data: auditData(request, 'admin.roleSafety.blocked', target.id, { operation: 'roleChange', reason: 'last_admin', fromRole: target.role, attemptedRole: role }) });
        return { kind: 'blocked' as const, message: 'This is the last active administrator. Assign another OWNER or ADMIN before changing this role.' };
      }
    }
    if (requiresClinicAssignment(role)) {
      const activeAssignments = await tx.userClinicAccess.count({
        where: { tenantId: request.auth.tenantId, userId: target.id, branch: { active: true } },
      });
      if (activeAssignments === 0) {
        await tx.auditEvent.create({ data: auditData(request, 'admin.roleSafety.blocked', target.id, { operation: 'roleChange', reason: 'missing_clinic_scope', fromRole: target.role, attemptedRole: role }) });
        return { kind: 'blocked' as const, message: 'Assign at least one active clinic before changing this account to an operational role.' };
      }
    }
    const updated = await tx.user.update({ where: { id: target.id }, data: { role } });
    await tx.auditEvent.create({ data: auditData(request, action, target.id, { fromRole: target.role, toRole: role }) });
    return { kind: 'updated' as const, updated };
  });
  if (result.kind === 'not_found') throw request.server.httpErrors.notFound('User not found');
  if (result.kind === 'blocked') throw request.server.httpErrors.conflict(result.message);
  return result.updated;
}

/**
 * Serialize an administrator-set password with the revocations it must carry.
 *
 * Administrators retain an assisted-recovery fallback in addition to the
 * tenant user's emailed reset link. The reset is only honest if the old
 * credential material stops working with it, so the
 * outstanding reset tokens, the refresh token, and (via the
 * `controlPlane.session.revoked` receipt the auth plugin reads as the
 * revocation epoch) already-issued access tokens are all invalidated in the
 * same transaction as the password write. The plaintext is hashed by the caller
 * before this transaction opens and never reaches an audit record.
 *
 * The caller's own account is refused: this path verifies no current password,
 * and a signed-in user changes their own via POST /v1/auth/password-change.
 */
export async function setUserPasswordSafely(request: FastifyRequest, targetId: string, passwordHash: string, action: string) {
  const result = await runWithTenantContext(request.auth.tenantId, async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant-auth:${request.auth.tenantId}:${targetId}`}::text, 0))::text AS locked`;
    const target = await tx.user.findFirst({ where: { id: targetId, tenantId: request.auth.tenantId } });
    if (!target) return { kind: 'not_found' as const };
    if (target.id === request.auth.userId) {
      await tx.auditEvent.create({ data: auditData(request, 'admin.user.passwordResetBlocked', target.id, { operation: 'passwordReset', reason: 'self_target' }) });
      return { kind: 'blocked' as const, message: 'Change your own password in Settings → Security, where your current password is required.' };
    }
    const changedAt = new Date();
    await tx.passwordResetToken.updateMany({ where: { tenantId: request.auth.tenantId, userId: target.id, usedAt: null }, data: { usedAt: changedAt } });
    const updated = await tx.user.update({
      where: { id: target.id },
      data: { passwordHash, passwordChangedAt: changedAt, failedLoginCount: 0, lockedUntil: null, refreshTokenHash: null, refreshTokenExpiresAt: null },
    });
    await tx.auditEvent.create({ data: auditData(request, 'controlPlane.session.revoked', target.id, { reason: 'password_reset' }, 'session') });
    await tx.auditEvent.create({ data: auditData(request, action, target.id, { role: target.role, sessionsRevoked: true }) });
    return { kind: 'updated' as const, updated, changedAt };
  });
  if (result.kind === 'not_found') throw request.server.httpErrors.notFound('User not found');
  if (result.kind === 'blocked') throw request.server.httpErrors.conflict(result.message);
  return { id: result.updated.id, passwordChangedAt: result.changedAt };
}
