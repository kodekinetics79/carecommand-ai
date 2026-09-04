import { describe, expect, it } from 'vitest';
import { ROUTES, canOpenPath, hasRouteAccess, matchRoute, type Permission } from './access';
import type { SessionUser } from './session';

/**
 * The route registry states what a destination's own endpoints enforce, so the
 * app stops offering doors the API will close. The campaign workspace is the
 * case that needed two grants and claimed none: `/reactivation` was recorded as
 * "entitlement only, no permission" while the page behind it read campaigns AND
 * the patient contact evidence — audience preview, suppressions — that
 * `crm:read` guards.
 */

function userWith(permissions: Permission[]): SessionUser {
  return { role: 'MANAGER', effectivePermissions: permissions } as unknown as SessionUser;
}

const CAMPAIGN_PATHS = ['/campaigns', '/campaigner', '/reactivation'] as const;

describe('campaign workspace access', () => {
  it('requires both campaign and CRM read grants', () => {
    for (const path of CAMPAIGN_PATHS) {
      expect(canOpenPath(userWith(['campaign:read', 'crm:read']), path), path).toBe(true);
      expect(canOpenPath(userWith(['campaign:read']), path), path).toBe(false);
      expect(canOpenPath(userWith(['crm:read']), path), path).toBe(false);
      expect(canOpenPath(userWith([]), path), path).toBe(false);
    }
  });

  it('states the same requirement on the retired paths as on the destination', () => {
    // Both redirect to /campaigns. A door that opens only to bounce the user
    // into a section they cannot read is worse than not offering it.
    const destination = ROUTES['/campaigns'];
    for (const path of CAMPAIGN_PATHS) {
      expect(ROUTES[path], path).toEqual(destination);
    }
  });

  it('does not let /campaigns shadow /campaigner, or either shadow the other', () => {
    expect(matchRoute('/campaigns').path).toBe('/campaigns');
    expect(matchRoute('/campaigner').path).toBe('/campaigner');
    expect(matchRoute('/reactivation').path).toBe('/reactivation');
  });

  it('still fails closed before the session has resolved its grants', () => {
    expect(canOpenPath(null, '/campaigns')).toBe(false);
    expect(canOpenPath(undefined, '/campaigns')).toBe(false);
  });
});

describe('roles and access administration', () => {
  it('requires the same admin:manage grant as the permission catalogue API', () => {
    expect(matchRoute('/settings/roles-access').path).toBe('/settings/roles-access');
    expect(canOpenPath(userWith([]), '/settings/roles-access')).toBe(false);
    expect(canOpenPath(userWith(['admin:manage']), '/settings/roles-access')).toBe(true);
  });

  it('does not let the parent settings route make the child editor public', () => {
    expect(canOpenPath(userWith([]), '/settings')).toBe(true);
    expect(canOpenPath(userWith([]), '/settings/roles-access')).toBe(false);
  });
});

describe('single-permission destinations are unaffected', () => {
  it('accepts a lone string permission exactly as before', () => {
    expect(hasRouteAccess(userWith(['crm:read']), ROUTES['/crm'])).toBe(true);
    expect(hasRouteAccess(userWith(['campaign:read']), ROUTES['/crm'])).toBe(false);
  });

  it('leaves permission-free destinations open to any signed-in user', () => {
    expect(hasRouteAccess(userWith([]), ROUTES['/'])).toBe(true);
    expect(hasRouteAccess(userWith([]), ROUTES['/autopilot'])).toBe(true);
  });
});
