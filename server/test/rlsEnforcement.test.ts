import 'dotenv/config';
import { describe, it, expect, vi } from 'vitest';
import { assertRlsRuntimeRole, checkRlsRuntimeRole, resolveRlsEnforcement } from '../lib/rlsGuard';
import { booleanString } from '../lib/booleanString';

// Boot-time enforcement contract, proven without a live DB by stubbing the
// role-inspection client. Complements server/test/rls.test.ts (real DB-level
// isolation on the enrolled tables) — this file is about WHO IS ALLOWED TO BOOT.

/** A fake query client that returns a fixed pg_roles row (matches RawQueryClient's generic). */
function roleClient(role: string, isSuper: boolean, bypass: boolean) {
  return { $queryRaw: async <T,>() => [{ role, super: isSuper, bypass }] as T };
}
const safeRole = roleClient('app_rls', false, false);
const superuserRole = roleClient('postgres', true, false);
const bypassRole = roleClient('ops_reader', false, true);
const unreachableDb = {
  $queryRaw: async <T,>(): Promise<T> => {
    throw new Error('connection refused');
  },
};
const silentLogger = { warn: vi.fn(), error: vi.fn() };

describe('resolveRlsEnforcement — production cannot opt out', () => {
  it('production always enforces, regardless of the env flag', () => {
    expect(resolveRlsEnforcement('production', false)).toBe(true);
    expect(resolveRlsEnforcement('production', true)).toBe(true);
  });

  it('non-production enforces only when the flag opts in', () => {
    expect(resolveRlsEnforcement('development', false)).toBe(false);
    expect(resolveRlsEnforcement('development', true)).toBe(true);
    expect(resolveRlsEnforcement('test', false)).toBe(false);
  });
});

describe('assertRlsRuntimeRole — unsafe production config refuses to boot', () => {
  it('refuses to boot in production on a superuser runtime role (flag cannot disable)', async () => {
    await expect(
      assertRlsRuntimeRole({ client: superuserRole, isProduction: true, logger: silentLogger }),
    ).rejects.toThrow(/BYPASSES row-level security/);
  });

  it('refuses to boot in production on a BYPASSRLS runtime role', async () => {
    await expect(
      assertRlsRuntimeRole({ client: bypassRole, isProduction: true, logger: silentLogger }),
    ).rejects.toThrow(/BYPASSES row-level security/);
  });

  it('refuses to boot in production when the role cannot be verified (after retries)', async () => {
    await expect(
      assertRlsRuntimeRole({
        client: unreachableDb,
        isProduction: true,
        logger: silentLogger,
        verifyRetries: 2,
        verifyRetryDelayMs: 1,
      }),
    ).rejects.toThrow(/Refusing to boot with unverifiable tenant isolation/);
  });

  it('recovers when the DB becomes reachable during verification retries', async () => {
    let calls = 0;
    const flaky = {
      $queryRaw: async <T,>() => {
        calls += 1;
        if (calls < 3) throw new Error('still waking up');
        return [{ role: 'app_rls', super: false, bypass: false }] as T;
      },
    };
    const status = await assertRlsRuntimeRole({
      client: flaky,
      isProduction: true,
      logger: silentLogger,
      verifyRetries: 4,
      verifyRetryDelayMs: 1,
    });
    expect(status.bypassesRls).toBe(false);
    expect(status.role).toBe('app_rls');
  });

  it('enforce flag opts non-production into the same fail-closed behavior', async () => {
    await expect(
      assertRlsRuntimeRole({ client: superuserRole, enforce: true, isProduction: false, logger: silentLogger }),
    ).rejects.toThrow(/BYPASSES/);
  });
});

describe('assertRlsRuntimeRole — dev/test stay usable', () => {
  it('boots with a warning on an unsafe role outside production', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const status = await assertRlsRuntimeRole({ client: superuserRole, isProduction: false, logger });
    expect(status.bypassesRls).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('boots with a warning when the role cannot be verified outside production', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const status = await assertRlsRuntimeRole({ client: unreachableDb, isProduction: false, logger });
    expect(status.checkFailed).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws for a correctly-restricted role, in any mode', async () => {
    const prod = await assertRlsRuntimeRole({ client: safeRole, isProduction: true, logger: silentLogger });
    const dev = await assertRlsRuntimeRole({ client: safeRole, isProduction: false, logger: silentLogger });
    expect(prod.bypassesRls).toBe(false);
    expect(dev.bypassesRls).toBe(false);
  });

  it('checkRlsRuntimeRole itself never throws (advisory diagnostic)', async () => {
    const status = await checkRlsRuntimeRole(unreachableDb);
    expect(status.checkFailed).toBe(true);
    expect(status.bypassesRls).toBe(false);
  });
});

describe('RLS_ENFORCE_RUNTIME_ROLE parsing — the flag means what the operator wrote', () => {
  // z.coerce.boolean() coerced the STRING "false" to true; render.yaml passes
  // this flag as a quoted string, so correct word parsing is boot-critical.
  it('parses "false"/"true" strings correctly (render.yaml passes strings)', () => {
    const flag = booleanString(false);
    expect(flag.parse('false')).toBe(false);
    expect(flag.parse('FALSE')).toBe(false);
    expect(flag.parse('0')).toBe(false);
    expect(flag.parse('true')).toBe(true);
    expect(flag.parse('1')).toBe(true);
  });

  it('empty/unset take the default; garbage fails loudly instead of picking a side', () => {
    expect(booleanString(true).parse('')).toBe(true);
    expect(booleanString(false).parse(undefined)).toBe(false);
    expect(() => booleanString(false).parse('bananas')).toThrow();
  });
});
