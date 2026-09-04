import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  assertRoleEditWithinAuthority,
  type Permission,
} from '../lib/permissions';

function requestWithPermissions(permissions: Permission[]): FastifyRequest {
  return {
    _permissionCache: new Set(permissions),
  } as unknown as FastifyRequest;
}

describe('role permission edit authority', () => {
  it('prevents Owner from losing settings:write recovery authority', async () => {
    const request = requestWithPermissions(['admin:manage', 'settings:write']);
    const result = await assertRoleEditWithinAuthority(request, {
      names: ['Owner'],
      permissions: ['admin:manage'],
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'protected_admin_permission',
    });
  });

  it('prevents Admin from losing admin:manage recovery authority', async () => {
    const request = requestWithPermissions(['admin:manage', 'settings:write']);
    const result = await assertRoleEditWithinAuthority(request, {
      names: ['Admin'],
      permissions: ['settings:write'],
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'protected_admin_permission',
    });
  });

  it('accepts an administrative override that retains both recovery grants', async () => {
    const request = requestWithPermissions(['admin:manage', 'settings:write', 'patient:read']);
    const result = await assertRoleEditWithinAuthority(request, {
      names: ['Owner'],
      permissions: ['admin:manage', 'settings:write', 'patient:read'],
    });

    expect(result).toEqual({ ok: true });
  });

  it('does not let a non-admin redefine a built-in role', async () => {
    const request = requestWithPermissions(['settings:write']);
    const result = await assertRoleEditWithinAuthority(request, {
      names: ['Branch Manager'],
      permissions: ['settings:write'],
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: 'reserved_role_name',
    });
  });

  it('does not let an editor grant a permission they do not hold', async () => {
    const request = requestWithPermissions(['settings:write']);
    const result = await assertRoleEditWithinAuthority(request, {
      names: ['Custom reporting role'],
      permissions: ['settings:write', 'patient:export'],
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: 'permission_escalation',
    });
  });
});
