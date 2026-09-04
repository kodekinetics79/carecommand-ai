import { describe, expect, it } from 'vitest';
import {
  PLATFORM_ONLY_PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
} from '../lib/permissions';

function grants(role: keyof typeof ROLE_PERMISSIONS) {
  return new Set<Permission>(ROLE_PERMISSIONS[role]);
}

function expectHas(role: keyof typeof ROLE_PERMISSIONS, permissions: Permission[]) {
  const held = grants(role);
  for (const permission of permissions) expect(held.has(permission), `${role} should have ${permission}`).toBe(true);
}

function expectLacks(role: keyof typeof ROLE_PERMISSIONS, permissions: Permission[]) {
  const held = grants(role);
  for (const permission of permissions) expect(held.has(permission), `${role} should not have ${permission}`).toBe(false);
}

describe('default role permission matrix', () => {
  it('keeps platform supplier mechanics out of every clinic role', () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>) {
      expectLacks(role, [...PLATFORM_ONLY_PERMISSIONS]);
    }
  });

  it('gives Owner and Admin tenant governance without platform-only supplier access', () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      expectHas(role, [
        'admin:manage',
        'settings:write',
        'patient:export',
        'receptionist:manage',
        'receptionist:recordings:read',
        'campaign:manage',
      ]);
      expectLacks(role, ['platform:voice-line-mechanics:read']);
    }
  });

  it('keeps Branch Manager operational but outside tenant-administration and full-PHI export', () => {
    expectHas('MANAGER', [
      'patient:read',
      'patient:write',
      'intake:read',
      'appointment:write',
      'schedule:manage',
      'staff:write',
      'receptionist:manage',
      'campaign:manage',
    ]);
    expectLacks('MANAGER', ['admin:manage', 'patient:export', 'receptionist:recordings:read']);
  });

  it('keeps Front Desk focused on patient access and routine front-office execution', () => {
    expectHas('FRONT_DESK', [
      'patient:read',
      'patient:write',
      'intake:read',
      'intake:write',
      'appointment:read',
      'appointment:write',
      'staff:task-status',
      'receptionist:booking-review',
      'receptionist:call-artifacts:read',
    ]);
    expectLacks('FRONT_DESK', [
      'admin:manage',
      'settings:write',
      'patient:export',
      'receptionist:manage',
      'receptionist:recordings:read',
      'billing:write',
    ]);
  });

  it('keeps Provider clinical and scheduling access separate from business administration', () => {
    expectHas('PROVIDER', [
      'patient:read',
      'intake:read',
      'appointment:read',
      'appointment:write',
      'schedule:manage',
      'partner-report:review',
    ]);
    expectLacks('PROVIDER', [
      'admin:manage',
      'settings:write',
      'patient:export',
      'billing:write',
      'campaign:manage',
      'receptionist:manage',
      'receptionist:recordings:read',
    ]);
  });

  it('keeps Billing on revenue and payment operations, not marketing or AI configuration', () => {
    expectHas('BILLING', [
      'billing:read',
      'billing:write',
      'insurance:reconcile',
      'revenue:read',
      'revenue:write',
      'campaign:payment-followup:manage',
    ]);
    expectLacks('BILLING', [
      'admin:manage',
      'patient:export',
      'campaign:manage',
      'receptionist:manage',
      'receptionist:recordings:read',
    ]);
  });

  it('keeps Analyst read-only', () => {
    expectHas('ANALYST', ['patient:read', 'appointment:read', 'billing:read', 'audit:read', 'operations:read']);
    const held = grants('ANALYST');
    for (const permission of held) {
      expect(permission.endsWith(':write') || permission.endsWith(':manage'), `Analyst unexpectedly mutates through ${permission}`).toBe(false);
    }
  });

  it('separates Compliance Officer from Auditor authority', () => {
    expectHas('COMPLIANCE_OFFICER', ['compliance:read', 'compliance:manage', 'audit:read', 'patient:export', 'receptionist:recordings:read']);
    expectHas('AUDITOR', ['compliance:read', 'audit:read', 'receptionist:call-artifacts:read', 'receptionist:recordings:read']);
    expectLacks('AUDITOR', ['compliance:manage', 'patient:export', 'admin:manage', 'settings:write']);
  });
});
