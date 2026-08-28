/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const user = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'session@test.invalid',
  displayName: 'Session Test',
  role: 'ADMIN',
  tenant: { id: '11111111-1111-4111-8111-111111111111', name: 'Test', slug: 'test' },
  active: true,
};

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('document', { cookie: 'cc_csrf=test-csrf' });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client session refresh single-flight', () => {
  it('shares one rotating refresh request across concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ accessToken: 'rotated-access', csrfToken: 'rotated-csrf', user }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getAccessToken, refreshSession } = await import('../../src/lib/session');
    const calls = [refreshSession(), refreshSession(), refreshSession(), refreshSession()];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();

    const sessions = await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessions.every(session => session.accessToken === 'rotated-access')).toBe(true);
    expect(getAccessToken()).toBe('rotated-access');
  });

  it('shares one failure and clears the in-memory token once for all waiters', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ message: 'Session expired' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = await import('../../src/lib/session');
    session.setAccessTokenOnly('stale-access');
    const calls = [session.refreshSession(), session.refreshSession(), session.refreshSession()];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();

    const results = await Promise.allSettled(calls);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.getAccessToken()).toBeNull();
  });

  it('bootstraps CSRF from the API for a separate-origin SPA and keeps it in memory', async () => {
    vi.stubGlobal('document', { cookie: '' });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/csrf')) {
        expect(init?.credentials).toBe('include');
        return new Response(JSON.stringify({ csrfToken: 'api-domain-csrf' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(url).toMatch(/\/v1\/auth\/refresh$/);
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('api-domain-csrf');
      return new Response(JSON.stringify({ accessToken: 'separate-origin-access', csrfToken: 'rotated-memory-csrf', user }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = await import('../../src/lib/session');
    await expect(session.refreshSession()).resolves.toMatchObject({ accessToken: 'separate-origin-access' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.getAccessToken()).toBe('separate-origin-access');
  });
});
