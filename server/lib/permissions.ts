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
// string[]). When that column is an array (including an empty array) it REPLACES the code defaults
// for that role in that tenant — this is what makes the per-tenant role editor an
// actual enforcement control and not a cosmetic catalogue. Only a null/missing
// override uses the code defaults; an explicit empty array is deny-all.
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
  // Intake PHI and consent records have a dedicated grant so users do not gain
  // access merely because they can view a patient directory or billing totals.
  'intake:read',
  'intake:write',
  'appointment:read',
  'appointment:write',
  // Manage a provider's recurring availability + time-off (distinct from booking).
  'schedule:manage',
  'billing:read',
  'billing:write',
  'insurance:reconcile',
  'staff:read',
  'staff:write',
  // Narrow operational grant: update an existing task's lifecycle without
  // gaining staff/profile administration.
  'staff:task-status',
  'settings:read',
  'settings:write',
  'compliance:read',
  'compliance:manage',
  'audit:read',
  // Cross-module operational surfaces are separated by data class so access to
  // one workflow never implies access to unrelated revenue, CRM, inventory, or
  // provider-configuration data.
  // Aggregate-sensitive briefing/signals permission. The briefing intentionally
  // combines appointment, revenue, receptionist, insurance, CRM, and intake
  // counts, so it is not a fallback for any narrower data-class permission.
  'operations:read',
  'operations:write',
  'crm:read',
  'crm:write',
  'campaign:read',
  'campaign:manage',
  // Campaign authority is scoped by campaign CLASS, not granted wholesale.
  // `campaign:manage` is the broad grant and covers every class, including this
  // one. This narrower grant covers ONLY the practice's own payment follow-up
  // campaigns (unpaid deposit, failed payment, insurance/coverage update, prior
  // authorization) — the class HIPAA treats as payment operations rather than
  // marketing. It deliberately does NOT reach reactivation or any other
  // marketing outreach, the live-dispatch activation switch, automation rules,
  // or the opportunity scan. The single mapping of campaign type -> required
  // grant is CAMPAIGN_CLASS_AUTHORITY in server/lib/campaigns.ts.
  'campaign:payment-followup:manage',
  'revenue:read',
  'revenue:write',
  'inventory:read',
  'inventory:write',
  'inventory:manage',
  'integrations:read',
  'integrations:manage',
  // Partner reports can contain clinical summaries. Reading, creating, and
  // marking one reviewed are deliberately independent grants; review defaults
  // only to OWNER/ADMIN/PROVIDER.
  'partner-report:read',
  'partner-report:write',
  'partner-report:review',
  // AI receptionist call metadata, summaries, and appointment-request artifacts.
  'receptionist:call-artifacts:read',
  // Provider-hosted call recordings may contain substantially more PHI than a
  // scheduling record and therefore require a separate, narrower grant.
  'receptionist:recordings:read',
  // Configure receptionist clinics/agents/campaigns and mutate their workflow.
  'receptionist:manage',
  // Read-only view of receptionist configuration (clinics, hours, knowledge,
  // locale packs, catalog): the read-only Studio and the Front Desk page.
  'receptionist:read',
  // Narrow front-desk operation: decide or reconcile an AI appointment request
  // against an already-created canonical scheduler appointment.
  'receptionist:booking-review',
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
    'intake:read', 'intake:write',
    'appointment:read', 'appointment:write', 'schedule:manage',
    'billing:read',
    'insurance:reconcile',
    'staff:read', 'staff:write', 'staff:task-status',
    'settings:read', 'settings:write',
    'operations:read', 'operations:write',
    'crm:read', 'crm:write',
    'campaign:read', 'campaign:manage',
    'revenue:read', 'revenue:write',
    'inventory:read', 'inventory:write', 'inventory:manage',
    'integrations:read', 'integrations:manage',
    'partner-report:read', 'partner-report:write',
    'receptionist:call-artifacts:read', 'receptionist:manage', 'receptionist:booking-review',
  ],
  BILLING: [
    'billing:read', 'billing:write', 'settings:read', 'patient:read', 'intake:read', 'intake:write',
    'insurance:reconcile',
    'revenue:read', 'revenue:write',
    // Revenue recovery, not marketing. Billing staff run the practice's own
    // payment follow-up (unpaid deposit / failed payment / coverage update /
    // prior auth) end to end. They still hold NEITHER 'campaign:manage' NOR
    // 'campaign:read', so a reactivation or any other marketing campaign — and
    // the campaign list that would disclose one — remains closed to them.
    'campaign:payment-followup:manage',
  ],
  PROVIDER: [
    'patient:read', 'intake:read', 'appointment:read', 'appointment:write', 'schedule:manage', 'staff:read', 'settings:read',
    'partner-report:read', 'partner-report:review',
  ],
  FRONT_DESK: [
    'patient:read', 'patient:write', 'intake:read', 'intake:write', 'appointment:read', 'appointment:write', 'billing:read', 'staff:read', 'staff:task-status',
    'crm:read', 'crm:write', 'campaign:read', 'inventory:read', 'inventory:write', 'partner-report:write',
    'receptionist:call-artifacts:read',
    'receptionist:booking-review',
    'receptionist:read',
  ],
  ANALYST: [
    'patient:read', 'appointment:read', 'billing:read', 'staff:read', 'settings:read', 'audit:read',
    'operations:read', 'crm:read', 'campaign:read', 'revenue:read', 'inventory:read',
  ],
  COMPLIANCE_OFFICER: [
    'compliance:read', 'compliance:manage', 'audit:read', 'patient:export',
    'receptionist:call-artifacts:read', 'receptionist:recordings:read',
  ],
  AUDITOR: [
    'compliance:read', 'audit:read',
    'receptionist:call-artifacts:read', 'receptionist:recordings:read', 'receptionist:read',
  ],
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
 * RoleDefinition override if present (including deny-all), otherwise the code defaults.
 */
export async function resolvePermissions(tenantId: string, role: UserRole): Promise<Set<Permission>> {
  const defaults = ROLE_PERMISSIONS[role] ?? [];
  const name = ROLE_ENUM_TO_NAME[role];
  if (name) {
    const definition = await db.roleDefinition.findFirst({
      where: { tenantId, name },
      select: { permissions: true },
    });
    if (definition && Array.isArray(definition.permissions)) {
      return new Set(sanitizePermissions(definition.permissions));
    }
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

/** True when the current request's effective grants include `permission`. */
export async function hasPermission(request: FastifyRequest, permission: Permission): Promise<boolean> {
  return (await getRequestPermissions(request)).has(permission);
}

/**
 * The single 403 shape for a permission refusal. `permission` names the grant
 * the caller would need; when several grants are accepted it names the broad
 * one, because that is the grant an administrator would actually assign.
 */
export function denyPermission(reply: FastifyReply, permission: Permission) {
  return reply.code(403).send({
    error: 'insufficient_permission',
    permission,
    message: `Your role does not have the required permission (${permission}) for this action.`,
  });
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
    if (missing) return denyPermission(reply, missing);
  };
}

/**
 * preHandler guard for a resource whose exact required grant depends on the
 * resource itself (see CAMPAIGN_CLASS_AUTHORITY in server/lib/campaigns.ts):
 * requires ANY ONE of `accepted`, so a caller holding none of them is refused
 * BEFORE the route reads the record, and the narrower per-record check then
 * runs inside the handler once the record's class is known. `accepted[0]` is
 * the broad grant and is what a refusal reports.
 */
export function requireAnyPermission(...accepted: [Permission, ...Permission[]]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const granted = await getRequestPermissions(request);
    if (accepted.some(perm => granted.has(perm))) return;
    return denyPermission(reply, accepted[0]);
  };
}
