import { afterEach, describe, expect, it, vi } from 'vitest';

function sessionResponse(role: string, clinicAccesses?: Array<{ id: string; name: string; location: string; isPrimary: boolean }>) {
  return {
    accessToken: 'access-token',
    csrfToken: 'csrf-token',
    user: {
      id: 'user-1', email: 'user@example.test', displayName: 'Test User', role, active: true,
      tenant: { id: 'tenant-1', name: 'Bright Health LLC', slug: 'bright-health' },
      clinicAccesses,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  vi.resetModules();
});

describe('session clinic scope restoration', () => {
  it('does not silently narrow an owner with a clinic stored by an older session', async () => {
    window.localStorage.setItem('carecommand-active-clinic', JSON.stringify({ tenantId: 'tenant-1', clinicId: 'clinic-a' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sessionResponse('OWNER')), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const session = await import('./session');

    await session.login('owner@example.test', 'synthetic-password');

    expect(session.getSelectedClinicId()).toBeNull();
    expect(window.localStorage.getItem('carecommand-active-clinic')).toBeNull();
  });

  it.each(['MANAGER', 'BILLING'])('restores only an explicitly assigned clinic for a %s user', async role => {
    window.localStorage.setItem('carecommand-active-clinic', JSON.stringify({ tenantId: 'tenant-1', clinicId: 'clinic-b' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sessionResponse(role, [
      { id: 'clinic-a', name: 'Arlington', location: 'Arlington, VA', isPrimary: true },
      { id: 'clinic-b', name: 'Fairfax', location: 'Fairfax, VA', isPrimary: false },
    ])), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const session = await import('./session');

    await session.login('manager@example.test', 'synthetic-password');

    expect(session.getSelectedClinicId()).toBe('clinic-b');
  });
});
