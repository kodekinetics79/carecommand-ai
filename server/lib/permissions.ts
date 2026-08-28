import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '../generated/prisma/enums';
import { db } from './db';

// ===========================================================================
// Permission / action RBAC.
//
// The auth layer assigns each user a coarse `UserRole` enum. This module adds a
// fine-grained, action-level permission layer ON TOP of that enum so access can
// be reasoned about (and customised per tenant) as `resource:action` grants
// rather than role labels alone.
//
// Source of truth + safe default: ROLE_PERMISSIONS (code). A tenant MAY override
// the grant set for a given role by setting RoleDefinition.permissions (a JSON
// string[]). When that column is a non-empty array it REPLACES the code defaults
// for that role in that tenant — this is what makes the per-tenant role editor an
// actual enforcement control and not a cosmetic catalogue. When it is null/empty,
// the code defaults apply (fail-safe).
//
// Enforcement is always server-side via requirePermission(); never frontend-only.
// ===========================================================================

export const PERMISSIONS = [
  'patient:read',
  'patient:write',
  // Full PHI export for a patient (HIPAA right-of-access / data-subject request)
  // — more sensitive than read, so least-privilege by default (owner/admin/
  // compliance only).
  'patient:export',
  'appointment:read',
  'appointment:write',
  // Manage a provider's recurring availability + time-off (distinct from booking).
  'schedule:manage',
  'billing:read',
  'billing:write',
  'staff:read',
  'staff:write',
  'settings:read',
  'settings:write',
  'compliance:read',
  'compliance:manage',
  'audit:read',
  // Tenant administration: manage users, roles, sessions, security posture.
  'admin:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

/**
 * Default grant matrix. These defaults are calibrated to exactly reproduce the
 * historical `requireRoles(...)` membership on every route converted to
 * requirePermission(), so behaviour (and existing security tests) are preserved:
 *   - patient:write  → OWNER, ADMIN, MANAGER, FRONT_DESK  (matches patient create)
 *   - settings:write → OWNER, ADMIN, MANAGER              (matches settings writeRoles)
 *   - admin:manage   → OWNER, ADMIN                       (matches ownerAdminRoles)
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  OWNER: ALL,
  ADMIN: ALL,
  MANAGER: [
    'patient:read', 'patient:write',
    'appointment:read', 'appointment:write', 'schedule:manage',
    'billing:read',
    'staff:read', 'staff:write',
    'settings:read', 'settings:write',
  ],
  BILLING: ['billing:read', 'billing:write', 'settings:read', 'patient:read'],
  PROVIDER: ['patient:read', 'appointment:read', 'appointment:write', 'schedule:manage', 'staff:read', 'settings:read'],
  FRONT_DESK: ['patient:read', 'patient:write', 'appointment:read', 'appointment:write', 'staff:read'],
  ANALYST: ['patient:read', 'appointment:read', 'billing:read', 'staff:read', 'settings:read', 'audit:read'],
  COMPLIANCE_OFFICER: ['compliance:read', 'compliance:manage', 'audit:read', 'patient:export'],
  AUDITOR: ['compliance:read', 'audit:read'],
};

// RoleDefinition rows are keyed by a human name; map enum <-> catalogue name so a
// tenant's per-role override can be located. Mirrors ROLE_MAP in settings routes.
export const ROLE_ENUM_TO_NAME: Record<UserRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Branch Manager',
  BILLING: 'Billing',
  PROVIDER: 'Provider',
  FRONT_DESK: 'Front Desk',
  ANALYST: 'Analyst',
  COMPLIANCE_OFFICER: 'Compliance Officer',
  AUDITOR: 'Auditor',
};

const PERMISSION_SET = new Set<string>(PERMISSIONS);

/** Validate + dedupe a caller-supplied permission list against the vocabulary. */
export function sanitizePermissions(input: unknown): Permission[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<Permission>();
  for (const value of input) {
    if (typeof value === 'string' && PERMISSION_SET.has(value)) out.add(value as Permission);
  }
  return [...out];
}

/**
 * Resolve the effective permission set for a (tenant, role): the tenant's
 * RoleDefinition override if present and non-empty, otherwise the code defaults.
 */
export async function resolvePermissions(tenantId: string, role: UserRole): Promise<Set<Permission>> {
  const defaults = ROLE_PERMISSIONS[role] ?? [];
  const name = ROLE_ENUM_TO_NAME[role];
  if (name) {
    const definition = await db.roleDefinition.findFirst({
      where: { tenantId, name },
      select: { permissions: true },
    });
    const override = sanitizePermissions(definition?.permissions);
    if (override.length > 0) return new Set(override);
  }
  return new Set(defaults);
}

/** Effective permissions for the current request, memoised on the request. */
export async function getRequestPermissions(request: FastifyRequest): Promise<Set<Permission>> {
  const req = request as FastifyRequest & { _permissionCache?: Set<Permission> };
  if (req._permissionCache) return req._permissionCache;
  const set = await resolvePermissions(request.auth.tenantId, request.auth.role);
  req._permissionCache = set;
  return set;
}

/**
 * preHandler guard: requires ALL listed permissions. Returns 403
 * `insufficient_permission` (with the missing permission) when any is absent —
 * enforcement is at the API, never frontend-only.
 */
export function requirePermission(...required: Permission[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const granted = await getRequestPermissions(request);
    const missing = required.find(perm => !granted.has(perm));
    if (missing) {
      return reply.code(403).send({
        error: 'insufficient_permission',
        permission: missing,
        message: `Your role does not have the required permission (${missing}) for this action.`,
      });
    }
  };
}
