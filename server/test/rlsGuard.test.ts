import 'dotenv/config';
import { describe, it, expect, afterAll } from 'vitest';
import { db } from '../lib/db';
import { checkRlsRuntimeRole, assertRlsRuntimeRole, rlsRoleMessage } from '../lib/rlsGuard';

// Proves the RLS runtime-role guard correctly classifies the connecting role and
// fails closed when enforcement is on. The bypass paths (superuser / rolbypassrls)
// are driven by a deterministic stub client so the test holds regardless of which
// role the local/CI DATABASE_URL happens to use; the restricted (safe) path is
// exercised against the real database connection.

afterAll(async () => {
  await db.$disconnect();
});

/** A fake query client that returns a fixed pg_roles row. */
function roleClient(role: string, isSuper: boolean, bypass: boolean) {
  return {
    $queryRaw: async <T>() => [{ role, super: isSuper, bypass }] as T,
  };
}

describe('RLS runtime-role guard', () => {
  it('classifies a superuser connection as bypassing RLS', async () => {
    const status = await checkRlsRuntimeRole(roleClient('postgres', true, false));
    expect(status.bypassesRls).toBe(true);
    expect(status.isSuperuser).toBe(true);
  });

  it('classifies a rolbypassrls connection as bypassing RLS', async () => {
    const status = await checkRlsRuntimeRole(roleClient('owner', false, true));
    expect(status.bypassesRls).toBe(true);
    expect(status.hasBypassRls).toBe(true);
    expect(status.isSuperuser).toBe(false);
  });

  it('classifies a NOSUPERUSER NOBYPASSRLS role as NOT bypassing RLS', async () => {
    const status = await checkRlsRuntimeRole(roleClient('app_rls', false, false));
    expect(status.bypassesRls).toBe(false);
  });

  it('throws (fails closed) when enforcing and the role can bypass RLS', async () => {
    await expect(
      assertRlsRuntimeRole({ enforce: true, client: roleClient('postgres', true, false) }),
    ).rejects.toThrow(/BYPASSES row-level security/);
  });

  it('in production, unsafe roles always throw even if enforcement is disabled', async () => {
    const logger = { warn: () => {}, error: () => {} };
    await expect(assertRlsRuntimeRole({
      enforce: false,
      isProduction: true,
      logger,
      client: roleClient('owner', false, true),
    })).rejects.toThrow(/BYPASSES row-level security/);
  });

  it('a restricted role is silent and never throws, even when enforced', async () => {
    const logs: string[] = [];
    const logger = { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
    const status = await assertRlsRuntimeRole({
      enforce: true,
      isProduction: true,
      logger,
      client: roleClient('app_rls', false, false),
    });
    expect(status.bypassesRls).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it('reads the real database connection role without error', async () => {
    const status = await checkRlsRuntimeRole();
    expect(status.role).toBeTruthy();
    expect(typeof status.bypassesRls).toBe('boolean');
  });

  it('produces an actionable message naming app_rls and the enforce flag', () => {
    const message = rlsRoleMessage({ role: 'owner', isSuperuser: false, hasBypassRls: true, bypassesRls: true });
    expect(message).toContain('app_rls');
    expect(message).toContain('RLS_ENFORCE_RUNTIME_ROLE');
  });
});
