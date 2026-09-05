import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
const logoutMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  apiRequest: apiRequestMock,
}));

vi.mock('../lib/session', () => ({
  authEventName: 'carecommand-auth-change',
  clearSession: vi.fn(() => window.dispatchEvent(new CustomEvent('carecommand-auth-change', { detail: { state: 'cleared' } }))),
  login: vi.fn(),
  logout: logoutMock,
}));

import { useSession } from './useSession';

const AUTH_ME = {
  user: {
    id: 'user-1', email: 'owner@example.test', displayName: 'Owner One', role: 'OWNER', active: true,
    tenant: { id: 'tenant-1', name: 'Bright Health LLC', slug: 'bright-health' },
  },
  access: { tenantId: 'tenant-1', role: 'OWNER', permissions: ['admin:manage'] },
};

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockResolvedValue(AUTH_ME);
  logoutMock.mockReset();
  logoutMock.mockImplementation(async () => {
    window.dispatchEvent(new CustomEvent('carecommand-auth-change', { detail: { state: 'cleared' } }));
  });
});

describe('useSession logout boundary', () => {
  it('clears every mounted session consumer without rehydrating the revoked session', async () => {
    const { result } = renderHook(() => ({ shell: useSession(), topbar: useSession() }));
    await waitFor(() => expect(result.current.shell.user?.id).toBe('user-1'));
    await waitFor(() => expect(result.current.topbar.user?.id).toBe('user-1'));
    expect(apiRequestMock).toHaveBeenCalledTimes(2);

    await act(async () => { await result.current.topbar.signOut(); });

    expect(result.current.shell.user).toBeNull();
    expect(result.current.topbar.user).toBeNull();
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });

  it('does not restore a user when an older auth hydration resolves after logout', async () => {
    let resolveHydration!: (value: typeof AUTH_ME) => void;
    const pendingHydration = new Promise<typeof AUTH_ME>(resolve => { resolveHydration = resolve; });
    apiRequestMock.mockReturnValue(pendingHydration);
    const { result } = renderHook(() => ({ shell: useSession(), topbar: useSession() }));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(2));

    await act(async () => { await result.current.topbar.signOut(); });
    expect(result.current.shell.user).toBeNull();
    expect(result.current.shell.loading).toBe(false);

    await act(async () => { resolveHydration(AUTH_ME); await pendingHydration; });

    expect(result.current.shell.user).toBeNull();
    expect(result.current.topbar.user).toBeNull();
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });
});
