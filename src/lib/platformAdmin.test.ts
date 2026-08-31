import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformAdmin, setPlatformToken, getPlatformToken } from './platformAdmin';

/**
 * What a refusal is allowed to say.
 *
 * Every 401 used to be reported as "Platform session expired. Please sign in
 * again." - the response body was discarded and one message substituted for all
 * of them. So a mistyped two-factor code, an expired enrolment token and a dead
 * session were indistinguishable in the console, and the one message shown sent
 * the operator to fix the thing that was not wrong. It also cleared the stored
 * token on sign-in failures, where there was no session to lose.
 */
function respond(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: status < 400,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => { setPlatformToken(null); vi.unstubAllGlobals(); });

describe('platform client — a refusal names what was refused', () => {
  it('reports a rejected two-factor code as a rejected code', async () => {
    vi.stubGlobal('fetch', respond(401, { error: 'invalid_code', message: 'Invalid authentication code.' }));
    await expect(platformAdmin.mfaVerify('000000', 'mfa-token')).rejects.toThrow('Invalid authentication code.');
  });

  it('does not clear a stored session because a SIGN-IN was refused', async () => {
    setPlatformToken('an-existing-session');
    vi.stubGlobal('fetch', respond(401, { error: 'invalid_credentials', message: 'Invalid email or password.' }));
    await expect(platformAdmin.login('someone@example.test', 'wrong')).rejects.toThrow('Invalid email or password.');
    // The sign-in attempt carried no session, so there was none to expire.
    expect(getPlatformToken()).toBe('an-existing-session');
  });

  it('still reports a genuinely dead session as expired, and drops the token', async () => {
    setPlatformToken('a-stale-session');
    vi.stubGlobal('fetch', respond(401, null));
    await expect(platformAdmin.tenants()).rejects.toThrow(/session expired/i);
    expect(getPlatformToken()).toBeNull();
  });

  it('prefers the server’s own words over a generic message on an authenticated 401', async () => {
    setPlatformToken('a-session');
    vi.stubGlobal('fetch', respond(401, { error: 'platform_unauthorized', message: 'Platform session not found.' }));
    await expect(platformAdmin.tenants()).rejects.toThrow('Platform session not found.');
    expect(getPlatformToken()).toBeNull();
  });
});
