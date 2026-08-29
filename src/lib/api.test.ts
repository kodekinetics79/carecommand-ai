import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './api';

// A live token, so the request goes straight out instead of trying to refresh.
vi.mock('./session', () => ({
  getAccessToken: () => 'test-access-token',
  refreshSession: vi.fn(),
  clearSession: vi.fn(),
  setAccessTokenOnly: vi.fn(),
}));

const PLAIN_403_SENTENCE = 'You do not have access to this. Ask a clinic owner or administrator if you need it.';

// Real 403 bodies from server/lib/errors.ts. It sends
// `handledError.code ?? 'INTERNAL_SERVER_ERROR'`, so only an RBAC denial
// carries 'insufficient_permission' and only an entitlement denial carries
// 'feature_locked'. Everything else keeps a real explanation.
const ENTITLEMENT_MESSAGE = 'Campaign automation is not included in the Starter plan. Upgrade to Growth to enable it.';
const SUSPENSION_MESSAGE = 'This workspace is suspended. Contact CareCommand support to restore access.';
const RBAC_MESSAGE = 'Forbidden: missing required permission (billing:read)';

function answerWith(status: number, body: unknown) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function failureFrom(status: number, body: unknown): Promise<ApiError> {
  const fetchMock = answerWith(status, body);
  try {
    await apiRequest('/v1/anything');
  } catch (error) {
    // The request has to have gone out; otherwise the message under test came
    // from somewhere other than the response being simulated.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error(`Expected apiRequest to reject on ${status}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest 403 handling', () => {
  it('keeps the server explanation for a feature_locked 403', async () => {
    // An entitlement denial names an upgrade the tenant can buy. Laundering it
    // into the permission line tells an owner to ask themselves for access.
    const error = await failureFrom(403, { error: 'feature_locked', message: ENTITLEMENT_MESSAGE });

    expect(error.message).toBe(ENTITLEMENT_MESSAGE);
    expect(error.code).toBe('feature_locked');
  });

  it('replaces the permission string with plain language for an insufficient_permission 403', async () => {
    const error = await failureFrom(403, { error: 'insufficient_permission', message: RBAC_MESSAGE });

    expect(error.message).toBe(PLAIN_403_SENTENCE);
    expect(error.message).not.toContain('billing:read');
  });

  it('keeps the server explanation for a 403 that is neither RBAC nor entitlement', async () => {
    // Nobody in the workspace can grant their way out of a suspension, so
    // "ask a clinic owner or administrator" is advice that cannot work.
    const error = await failureFrom(403, { error: 'INTERNAL_SERVER_ERROR', message: SUSPENSION_MESSAGE });

    expect(error.message).toBe(SUSPENSION_MESSAGE);
    expect(error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('leaves status, code and details intact so callers can still branch', async () => {
    const error = await failureFrom(403, {
      error: 'insufficient_permission',
      message: RBAC_MESSAGE,
      requiredPermission: 'billing:read',
    });

    expect(error.status).toBe(403);
    expect(error.code).toBe('insufficient_permission');
    expect(error.details).toMatchObject({ requiredPermission: 'billing:read' });
  });
});

describe('apiRequest error text', () => {
  it('never surfaces a bare HTTP status for a failure with no body', async () => {
    answerWith(500, null);

    await expect(apiRequest('/v1/anything')).rejects.toThrow(
      'Something went wrong on our side. Please try again in a moment.');
  });

  it('surfaces the server message on statuses that are not access denials', async () => {
    const error = await failureFrom(409, { error: 'conflict', message: 'That slot was just booked by someone else.' });

    expect(error.message).toBe('That slot was just booked by someone else.');
    expect(error.status).toBe(409);
  });
});
