/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEligibility } from '../../src/lib/revenueProtection';
import { insuranceApi } from '../../src/lib/insurance';
import { clearSession, setAccessTokenOnly } from '../../src/lib/session';

afterEach(() => {
  clearSession(false);
  vi.unstubAllGlobals();
});

describe('eligibility frontend idempotency contract', () => {
  it('keeps one user-action key stable across the API transport auth-refresh retry', async () => {
    vi.stubGlobal('document', { cookie: 'cc_csrf=eligibility-test-csrf' });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    setAccessTokenOnly('expired-access');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'rotated-access',
        csrfToken: 'rotated-csrf',
        user: { id: 'user', email: 'u@example.test', displayName: 'U', role: 'ADMIN', tenant: { id: 'tenant', name: 'T', slug: 't' }, active: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'verification', verificationId: 'verification' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await checkEligibility({ patientId: 'patient' }, 'elig_stable-user-action-key');

    const eligibilityCalls = fetchMock.mock.calls.filter(call => String(call[0]).includes('/v1/revenue-protection/eligibility/check'));
    expect(eligibilityCalls).toHaveLength(2);
    expect(new Headers(eligibilityCalls[0]?.[1]?.headers).get('Idempotency-Key')).toBe('elig_stable-user-action-key');
    expect(new Headers(eligibilityCalls[1]?.[1]?.headers).get('Idempotency-Key')).toBe('elig_stable-user-action-key');
  });

  it('adds a fresh durable key for an insurance intake eligibility action', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    setAccessTokenOnly('unit-access');
    const fetchMock = vi.fn<typeof fetch>(async (...args) => {
      void args;
      return new Response(JSON.stringify({ verificationId: 'verification' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await insuranceApi.runEligibilityCheck({ appointmentId: 'appointment' });
    const header = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Idempotency-Key');
    expect(header).toMatch(/^elig_[0-9a-f-]{36}$/);
  });

  it('reuses the logical-action key when a lost response is retried by the user', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    setAccessTokenOnly('unit-access');
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network response was lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ verificationId: 'replayed-verification' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const input = { patientId: 'same-patient', serviceType: 'office' };

    await expect(checkEligibility(input)).rejects.toThrow('network response was lost');
    await expect(checkEligibility(input)).resolves.toMatchObject({ verificationId: 'replayed-verification' });

    const keys = fetchMock.mock.calls.map(call => new Headers(call[1]?.headers).get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^elig_[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('retains the key after reconciliation-required so a later click cannot create a new payer execution', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    setAccessTokenOnly('unit-access');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'reconciliation_required', executionId: 'exec-1' }), { status: 409, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'reconciliation_required', executionId: 'exec-1' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const input = { patientId: 'ambiguous-patient' };

    await expect(checkEligibility(input)).rejects.toMatchObject({ status: 409 });
    await expect(checkEligibility(input)).rejects.toMatchObject({ status: 409 });

    const keys = fetchMock.mock.calls.map(call => new Headers(call[1]?.headers).get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});
