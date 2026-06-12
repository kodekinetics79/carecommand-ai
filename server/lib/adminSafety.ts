import type { FastifyRequest } from 'fastify';
import { db } from './db';
import { audit } from './audit';

// ===========================================================================
// Admin role safety guards. Prevent a tenant from locking itself out of
// administrative access via role changes or deactivation. These are app-layer
// safety checks only — they do not change the tenant model or RoleDefinition
// (which remains descriptive). Blocked attempts are recorded in AuditEvent.
// ===========================================================================

const isAdminRole = (role: string) => role === 'OWNER' || role === 'ADMIN';

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
