import { COMPLIANCE_READ_ROLES } from './compliance';
import type { SessionUser } from './session';

// ===========================================================================
// Route access registry — what each destination actually requires.
//
// Every entry below mirrors the guard the destination's own endpoints run
// (`requirePermission(...)` / `requireRoles(...)` in server/modules/*/routes.ts).
// Navigation reads this so the app stops offering doors the API will close.
// The API is still the only enforcement point and is unchanged by this file:
// a user who edits their session, or whose grants change mid-session, gets the
// same 403 they always did.
//
// This is NOT the subscription padlock. `useEntitlements` gates what the TENANT
// has bought and routes to /subscription with a lock icon; that stays. This
// gates what the SIGNED-IN USER is allowed to do, and an entry they lack is
// hidden outright — a padlocked upsell for something no upgrade can unlock
// would be a lie.
//
// Permissions come from the session (`/v1/auth/me` -> access.permissions), which
// is the server-resolved grant set INCLUDING a tenant's RoleDefinition override,
// so a tenant that narrows a role narrows its navigation too.
// ===========================================================================

/**
 * The subset of the server permission vocabulary that navigation and in-page
 * controls gate on. Source of truth: PERMISSIONS in server/lib/permissions.ts.
 * Gating here only hides a control the caller cannot use; the server re-checks
 * every one of these on the route itself.
 */
export type Permission =
  | 'admin:manage'
  | 'appointment:read'
  | 'billing:read'
  | 'campaign:read'
  | 'crm:read'
  | 'integrations:read'
  | 'intake:read'
  | 'inventory:read'
  | 'operations:read'
  | 'partner-report:read'
  | 'patient:read'
  | 'receptionist:manage'
  | 'revenue:read'
  | 'staff:read'
  | 'staff:task-status'
  | 'staff:write';

export interface RouteDefinition {
  /** Human name of the destination — breadcrumb, and the access notice. */
  label: string;
  /**
   * Permission(s) its endpoints enforce via requirePermission(). A list means
   * the destination calls endpoints guarded by DIFFERENT grants and needs all
   * of them: offering it to a user holding only one produces a page that half
   * loads and half 403s, which is the shape this registry exists to stop.
   */
  permission?: Permission | readonly Permission[];
  /** Roles its endpoints enforce via requireRoles(). */
  roles?: readonly string[];
}

const OWNER_ADMIN = ['OWNER', 'ADMIN'] as const;
// The campaign workspace reads two data classes: the campaigns themselves and
// the patient contact evidence (audience preview, suppressions) it must show
// before anyone can authorize an audience.
const CAMPAIGN_WORKSPACE_GRANTS = ['campaign:read', 'crm:read'] as const;
// Module-level preHandler on monitoring + connected-care routes.
const CLINICAL_LEADERSHIP = ['OWNER', 'ADMIN', 'MANAGER', 'PROVIDER'] as const;

/**
 * Every in-app destination, with the access its primary endpoints enforce.
 * An entry with neither `permission` nor `roles` is reachable by any signed-in
 * user because its endpoints guard nothing beyond authentication.
 */
export const ROUTES = {
  // GET /v1/dashboard/summary — authenticated only. Also the fallback landing
  // page, so it must stay reachable for every role.
  '/': { label: 'Command Center' },
  // GET /v1/advisory/brief — authenticated only.
  '/advisory': { label: 'Advisory Room' },
  // GET /v1/opportunities, /v1/revenue-leaks — requirePermission('revenue:read')
  '/opportunities': { label: 'Opportunity Center', permission: 'revenue:read' },

  // GET /v1/patients, /v1/patients/summary — requirePermission('patient:read')
  '/patients': { label: 'Patients', permission: 'patient:read' },
  // GET /v1/appointments — requirePermission('appointment:read')
  '/scheduling': { label: 'Scheduling', permission: 'appointment:read' },
  // GET /v1/intake/queue — requirePermission('intake:read')
  '/patient-intake': { label: 'Patient Intake', permission: 'intake:read' },
  // GET /v1/conversations — requirePermission('crm:read')
  '/ai-receptionist': { label: 'AI Receptionist', permission: 'crm:read' },
  // GET /v1/receptionist/clinics, /campaigns — receptionist:manage
  '/receptionist-studio': { label: 'Receptionist Studio', permission: 'receptionist:manage' },
  // GET /v1/staff/overview, /v1/tasks — requirePermission('staff:read')
  '/staff': { label: 'Staff Tasks', permission: 'staff:read' },

  // GET /v1/leads — requirePermission('crm:read')
  '/crm': { label: 'CRM', permission: 'crm:read' },
  // The one campaign workspace. GET /v1/crm/campaigns is guarded by the campaign
  // read grants; the audience preview and suppression records it shows are
  // patient contact evidence and take crm:read, the same grant as GET /v1/leads.
  // A user with only one of the two reaches a page that cannot do its job.
  '/campaigns': { label: 'Campaigns', permission: CAMPAIGN_WORKSPACE_GRANTS },
  // Retired paths. Both redirect to /campaigns, so they must state the SAME
  // requirement — a door that opens only to bounce the user into a section they
  // cannot read would be worse than not offering it.
  '/campaigner': { label: 'Campaigns', permission: CAMPAIGN_WORKSPACE_GRANTS },
  '/reactivation': { label: 'Campaigns', permission: CAMPAIGN_WORKSPACE_GRANTS },
  // GET /v1/autopilot/playbooks, /approvals — authenticated only.
  '/autopilot': { label: 'Autopilot' },
  // GET /v1/reviews, /v1/reputation — requirePermission('crm:read')
  '/reviews': { label: 'Reviews', permission: 'crm:read' },
  // GET /v1/competitors/radar — requirePermission('operations:read')
  '/clinic-radar': { label: 'ClinicRadar', permission: 'operations:read' },
  '/benchmarking': { label: 'Multi-Clinic Benchmarking', permission: 'operations:read' },

  // GET /v1/revenue-snapshots — requirePermission('revenue:read')
  '/revenue': { label: 'Revenue Leaks', permission: 'revenue:read' },
  // GET /v1/revenue-protection/overview — requirePermission('billing:read')
  '/revenue-protection': { label: 'Revenue Protection', permission: 'billing:read' },
  // GET /v1/insurance/overview — requirePermission('billing:read')
  '/insurance': { label: 'Insurance', permission: 'billing:read' },
  // GET /v1/insurance/eligibility/history — requirePermission('billing:read')
  '/insurance-eligibility': { label: 'Insurance Eligibility', permission: 'billing:read' },
  // GET /v1/providers/overview — requirePermission('staff:read')
  '/doctor-workspace': { label: 'Provider Performance', permission: 'staff:read' },

  // /v1/monitoring/* — module preHandler requireRoles(OWNER, ADMIN, MANAGER, PROVIDER)
  '/monitoring': { label: 'Remote Monitoring', roles: CLINICAL_LEADERSHIP },
  // GET /v1/devices/overview — entitlement only (device_integration).
  '/devices': { label: 'Device Integration' },
  // /v1/connected-care/* — module preHandler requireRoles(OWNER, ADMIN, MANAGER, PROVIDER)
  '/enrollments': { label: 'Device Enrollments', roles: CLINICAL_LEADERSHIP },
  '/rpm-readiness': { label: 'RPM Billing Readiness', roles: CLINICAL_LEADERSHIP },
  '/sync-logs': { label: 'Provider Sync Logs', roles: CLINICAL_LEADERSHIP },
  // GET /v1/insurance/providers, /v1/devices/providers — entitlement only.
  '/integration-setup': { label: 'Integration Setup' },

  // /v1/compliance/* center — requireRoles(OWNER, ADMIN, COMPLIANCE_OFFICER, AUDITOR)
  '/compliance': { label: 'Compliance Readiness', roles: COMPLIANCE_READ_ROLES },
  // /v1/control-plane/* — requireRoles(OWNER, ADMIN)
  '/control-plane': { label: 'Control Plane', roles: OWNER_ADMIN },
  '/admin': { label: 'Control Plane', roles: OWNER_ADMIN },
  // GET /v1/integrations/status — requirePermission('integrations:read')
  '/integrations': { label: 'Integrations', permission: 'integrations:read' },
  // GET /v1/subscriptions/current, /plans, /features — authenticated only.
  '/subscription': { label: 'Subscription' },
  // GET /v1/settings/roles, /notification-templates — authenticated only. Also
  // the account page every user reaches from their own avatar.
  '/settings': { label: 'Settings' },

  // Routed but not in the sidebar; still deep-linkable.
  // GET /v1/inventory — requirePermission('inventory:read')
  '/inventory': { label: 'Inventory', permission: 'inventory:read' },
  // GET /v1/partner-reports — requirePermission('partner-report:read')
  '/labs': { label: 'Partner Reports', permission: 'partner-report:read' },
  // GET /v1/telehealth/sessions — requirePermission('appointment:read')
  '/telehealth': { label: 'Telehealth', permission: 'appointment:read' },
} as const satisfies Record<string, RouteDefinition>;

/** Declared destinations. A path outside this union has no declared access. */
export type RoutePath = keyof typeof ROUTES;

/**
 * Longest segment-aware match, so '/revenue' never shadows
 * '/revenue-protection' and '/patients/:id' inherits '/patients'. An
 * undeclared path falls back to '/', which requires nothing — the API is
 * still the enforcement point.
 */
export function matchRoute(pathname: string): { path: RoutePath; route: RouteDefinition } {
  let best: RoutePath = '/';
  for (const key of Object.keys(ROUTES) as RoutePath[]) {
    if (key === '/') continue;
    if ((pathname === key || pathname.startsWith(key + '/')) && key.length > best.length) best = key;
  }
  return { path: best, route: ROUTES[best] };
}

/**
 * Whether this user satisfies a destination's requirement. Unknown grants mean
 * "not yet known", which fails closed: the entry is not offered until
 * /v1/auth/me has resolved the session's permissions.
 */
export function hasRouteAccess(user: SessionUser | null | undefined, route: RouteDefinition): boolean {
  if (!route.permission && !route.roles) return true;
  if (!user) return false;
  if (route.roles && !route.roles.includes(user.role)) return false;
  if (route.permission) {
    const required = typeof route.permission === 'string' ? [route.permission] : route.permission;
    const held = user.effectivePermissions ?? [];
    // Every listed grant is required: they gate different endpoints on the
    // same page, so holding one of two is not access to the destination.
    if (!required.every(permission => held.includes(permission))) return false;
  }
  return true;
}

/** Whether this user can open a path (nav entries, palette commands, deep links). */
export function canOpenPath(user: SessionUser | null | undefined, pathname: string): boolean {
  return hasRouteAccess(user, matchRoute(pathname).route);
}

/**
 * Whether the session carries a single grant. For in-page section navigation
 * (Settings tabs) whose panels call an endpoint guarded by that permission.
 * Unknown grants fail closed, exactly as above.
 */
export function hasPermission(user: SessionUser | null | undefined, permission: Permission): boolean {
  return !!user && (user.effectivePermissions ?? []).includes(permission);
}
