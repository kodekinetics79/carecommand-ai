import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => ({
  user: { role: 'OWNER', effectivePermissions: ['admin:manage', 'settings:write'] } as {
    role: string;
    effectivePermissions: string[];
  },
  loading: false,
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

vi.mock('../hooks/useSession', () => ({
  useSession: () => ({
    user: sessionState.user,
    loading: sessionState.loading,
    isAuthenticated: true,
    signOut: vi.fn(),
  }),
}));

import Settings from './Settings';

const OVERVIEW = {
  summary: { totalUsers: 2, activeUsers: 2, totalRoles: 0, activeBranches: 2, recentAuditEvents: 5 },
  tenant: { name: 'Bright Health LLC', slug: 'bright-health', createdAt: '2026-08-01T12:00:00.000Z' },
  branches: [
    { id: 'branch-1', name: 'Riverside', location: 'New York', active: true },
    { id: 'branch-2', name: 'Lakeside', location: 'New Jersey', active: true },
  ],
};

const POSTURE = {
  authMode: 'password+refresh-cookie with explicit dev-token fallback',
  rbacEnabled: true,
  auditLoggingEnabled: true,
  rateLimitingEnabled: true,
  devTokenDisabledInProduction: false,
  httpsRequired: false,
  csrf: { enabled: true },
  secrets: { jwtSecretConfigured: true, jwtRefreshSecretConfigured: true },
  accessTokenTtlMinutes: 15,
  auditEventCount: 5,
  loginEventCount: 2,
};

function answer(path: string) {
  if (path === '/v1/admin/overview') return Promise.resolve(OVERVIEW);
  if (path === '/v1/security/posture') return Promise.resolve(POSTURE);
  if (path === '/v1/admin/users') {
    return Promise.resolve({
      users: [{
        id: 'user-1', displayName: 'Bailey Billing', email: 'billing@example.test', role: 'BILLING', active: true,
        branch: { name: 'Riverside' }, accessBranches: [{ id: 'branch-1', name: 'Riverside' }],
      }],
      branches: OVERVIEW.branches,
    });
  }
  if (path === '/v1/settings/roles') return Promise.resolve([]);
  if (path === '/v1/settings/notification-templates') return Promise.resolve([]);
  throw new Error(`Unexpected request: ${path}`);
}

function renderPage() {
  return render(<MemoryRouter><Settings /></MemoryRouter>);
}

beforeEach(() => {
  sessionState.user = { role: 'OWNER', effectivePermissions: ['admin:manage', 'settings:write'] };
  sessionState.loading = false;
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => answer(path));
});

describe('Administration role-aware journey', () => {
  it('keeps a provider in personal settings and issues no admin-only request', () => {
    sessionState.user = { role: 'PROVIDER', effectivePermissions: [] };
    renderPage();

    expect(screen.getByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Display & Currency' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'My Account' })).toBeInTheDocument();
    for (const name of ['Workspace Overview', 'Team & Users', 'Roles & Access', 'Notifications', 'Security & Sessions']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByText('Personal settings')).toBeInTheDocument();
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('offers managers configurable settings without exposing tenant administration', () => {
    sessionState.user = { role: 'MANAGER', effectivePermissions: ['settings:write'] };
    renderPage();

    expect(screen.getByRole('button', { name: 'Roles & Access' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Workspace Overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Team & Users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Security & Sessions' })).not.toBeInTheDocument();
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('shows owners the complete tenant controls and counts all eight security checks', async () => {
    renderPage();

    await screen.findByText('Workspace summary');
    for (const name of ['Workspace Overview', 'Display & Currency', 'Team & Users', 'Roles & Access', 'Notifications', 'My Account', 'Security & Sessions']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('Tenant administration')).toBeInTheDocument();
    expect(screen.getByText('6/8')).toBeInTheDocument();
    expect(screen.getByText('Password sign-in · development test mode')).toBeInTheDocument();
    expect(screen.getByText('Custom Roles')).toBeInTheDocument();
    expect(apiRequestMock.mock.calls.filter(([path]) => path === '/v1/admin/overview')).toHaveLength(1);
    expect(apiRequestMock.mock.calls.filter(([path]) => path === '/v1/security/posture')).toHaveLength(1);
  });

  it('includes the billing role in the tenant-admin role selector', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Team & Users' }));

    const selector = await screen.findByRole('combobox', { name: 'Role for Bailey Billing' });
    expect(within(selector).getByRole('option', { name: 'BILLING' })).toBeInTheDocument();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/admin/users', expect.anything()));
  });

  it('saves audited multi-clinic access through the tenant-admin endpoint', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Team & Users' }));

    await screen.findByText('Bailey Billing');
    fireEvent.click(screen.getByRole('button', { name: 'Edit clinic access' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lakeside' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Primary clinic for Bailey Billing' }), { target: { value: 'branch-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save clinic access' }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/admin/users/user-1/branches', {
      method: 'PATCH',
      body: JSON.stringify({ branchIds: ['branch-1', 'branch-2'], primaryBranchId: 'branch-2' }),
    }));
  });

  it('does not describe an unassigned non-admin user as tenant-wide', async () => {
    apiRequestMock.mockImplementation((path: string) => path === '/v1/admin/users'
      ? Promise.resolve({
          users: [{
            id: 'provider-1', displayName: 'Parker Provider', email: 'provider@example.test', role: 'PROVIDER', active: true,
            branch: null, accessBranches: [],
          }],
          branches: OVERVIEW.branches,
        })
      : answer(path));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Team & Users' }));

    await screen.findByText('Parker Provider');
    expect(screen.getByText('No clinic access recorded')).toBeInTheDocument();
    expect(screen.queryByText('Tenant-wide')).not.toBeInTheDocument();
  });
});
