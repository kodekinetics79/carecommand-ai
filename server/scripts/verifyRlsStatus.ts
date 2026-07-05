/**
 * RLS posture verification — READ-ONLY, safe to run against production.
 *
 *   npm run rls:verify
 *   (uses the runtime DATABASE_URL — that is the point: it verifies the posture
 *    the application actually runs with)
 *
 * Checks, in order:
 *   1. Runtime role is restricted: not a superuser, no BYPASSRLS.   [hard fail]
 *   2. Every RLS-enrolled table has ROW LEVEL SECURITY enabled AND
 *      forced, and carries the tenant_isolation policy.             [hard fail]
 *   3. Coverage report: tenant-scoped tables (any table with a
 *      "tenantId" column) not yet RLS-enrolled.                     [informational]
 *
 * Exit code 0 = safe posture; 1 = unsafe (fails CI/cron checks loudly).
 * For deep behavioral verification (actual cross-tenant leakage attempts) run
 * the DB-backed suite: server/test/rls.test.ts, server/lib/rlsPilot.verify.ts,
 * server/lib/rlsWaveB3.verify.ts.
 */
import 'dotenv/config';
import { db } from '../lib/db';
import { checkRlsRuntimeRole } from '../lib/rlsGuard';

// Source of truth for which tables MUST be RLS-protected. Extend this list in
// the same commit as the migration that enrolls a new table (docs/RLS.md).
export const RLS_ENROLLED_TABLES = [
  'NotificationTemplate',
  'AiGuardrail',
  'CustomerPreference',
  'DepositRule',
  'RevenueProtectionAlert',
  'RevenueLeak',
] as const;

let failures = 0;
function report(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  // ── 1. Runtime role ────────────────────────────────────────────────────
  const role = await checkRlsRuntimeRole();
  if (role.checkFailed) {
    report('runtime role verified', false, 'could not query pg_roles (is the DB reachable?)');
  } else {
    report(
      `runtime role "${role.role}" cannot bypass RLS`,
      !role.bypassesRls,
      role.bypassesRls ? (role.isSuperuser ? 'SUPERUSER' : 'BYPASSRLS') : `superuser=false bypassrls=false`,
    );
  }

  // ── 2. Enrolled tables: enabled + forced + policy present ─────────────
  const tables = await db.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE relkind = 'r' AND relname = ANY(${[...RLS_ENROLLED_TABLES]})`;
  const policies = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_policies
    WHERE policyname = 'tenant_isolation' AND tablename = ANY(${[...RLS_ENROLLED_TABLES]})`;
  const policyTables = new Set(policies.map(p => p.tablename));

  for (const expected of RLS_ENROLLED_TABLES) {
    const row = tables.find(t => t.relname === expected);
    if (!row) {
      report(`${expected}: table exists`, false, 'not found in pg_class');
      continue;
    }
    report(`${expected}: RLS enabled`, row.relrowsecurity);
    report(`${expected}: RLS forced`, row.relforcerowsecurity);
    report(`${expected}: tenant_isolation policy present`, policyTables.has(expected));
  }

  // ── 3. Coverage report (informational — the app-level tenant filter is the
  //      control on these until they are enrolled in a later wave) ─────────
  const tenantScoped = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN pg_class pc ON pc.relname = c.table_name AND pc.relkind = 'r'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'
    ORDER BY c.table_name`;
  const unenrolled = tenantScoped
    .map(t => t.table_name)
    .filter(name => !(RLS_ENROLLED_TABLES as readonly string[]).includes(name));
  console.log(`\nℹ tenant-scoped tables: ${tenantScoped.length} total, ${RLS_ENROLLED_TABLES.length} RLS-enrolled, ${unenrolled.length} on app-level filtering only:`);
  console.log(`  ${unenrolled.join(', ') || '(none)'}`);

  console.log(failures === 0 ? '\nRLS posture: SAFE' : `\nRLS posture: UNSAFE (${failures} failed check${failures === 1 ? '' : 's'})`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async error => {
  console.error('rls:verify failed to run:', error);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
