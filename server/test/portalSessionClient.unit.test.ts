/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', new Proxy({}, {
    get() { throw new Error('portal credentials must not access localStorage'); },
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('portal browser session client', () => {
  it('holds the short-lived bearer in memory and clears it after revocable logout', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer portal-memory-token');
      if (url.endsWith('/logout')) {
        return new Response(JSON.stringify({ loggedOut: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ displayName: 'Patient', email: null, clinicName: 'Clinic' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = await import('../../src/lib/portalClient');
    expect(client.getPortalToken()).toBeNull();
    client.setPortalToken('portal-memory-token');
    await expect(client.portalClient.me()).resolves.toMatchObject({ displayName: 'Patient' });
    await expect(client.portalClient.logout()).resolves.toEqual({ loggedOut: true });
    expect(client.getPortalToken()).toBeNull();
  });
});
