import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './api';

// A live token by default, so the request goes straight out instead of trying
// to refresh. The session-expiry block below takes the token away on purpose.
const session = vi.hoisted(() => {
  class AuthRequestError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'AuthRequestError';
      this.status = status;
    }
  }
  return { AuthRequestError, token: { value: 'test-access-token' as string | null }, refreshSession: vi.fn() };
});

vi.mock('./session', () => ({
  AuthRequestError: session.AuthRequestError,
  getAccessToken: () => session.token.value,
  refreshSession: session.refreshSession,
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
  session.token.value = 'test-access-token';
  session.refreshSession.mockReset();
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

// ===========================================================================
// There is no session left, versus the network dropped.
//
// useSession clears the signed-in user on ApiError 401/403 and on nothing else,
// deliberately: a transient 5xx must not bounce staff to /login mid-task. That
// left one case unattributed. Signing out clears the tokens and the refresh
// cookie, so the very next request has no access token, asks for a refresh, and
// is refused — and that refusal used to arrive as a bare Error with no status.
// Nothing cleared the user, so the workspace stayed on screen after Sign out.
// ===========================================================================
describe('apiRequest when the session cannot be rebuilt', () => {
  it('reports a refused refresh as the 401 it is, so the app signs out', async () => {
    session.token.value = null;
    session.refreshSession.mockRejectedValue(new session.AuthRequestError(401, 'Session expired.'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const error = await apiRequest('/v1/auth/me').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    // No request is sent without a token; the refusal is the whole answer.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT report a dropped connection as a 401, so a blip never signs anyone out', async () => {
    session.token.value = null;
    session.refreshSession.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', vi.fn());

    const error = await apiRequest('/v1/auth/me').catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(TypeError);
  });

  it('reports an expired access token whose refresh is refused as a 401', async () => {
    // A token that is present but stale: the request goes out, the server says
    // 401, the retry path asks for a refresh and is refused.
    answerWith(401, { error: 'unauthorized', message: 'Token expired' });
    session.refreshSession.mockRejectedValue(new session.AuthRequestError(401, 'Session expired.'));

    const error = await apiRequest('/v1/anything').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });
});
