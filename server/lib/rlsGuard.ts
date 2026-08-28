import { db } from './db';
import { env } from '../config/env';
import {
  EXPECTED_RUNTIME_ROLE,
  GLOBAL_RUNTIME_TABLE_PRIVILEGES,
  expectedRuntimeTablePrivileges,
  isTenantRuntimeTable,
} from './rlsRuntimeManifest';

// ===========================================================================
// RLS runtime-role guard.
//
// Tenant row-level security is only effective when the connecting database role
// CANNOT bypass it. A superuser, or any role with rolbypassrls, silently ignores
// every RLS policy — so the FORCEd tenant-isolation policies become a no-op and
// the only remaining control is the app-level `where: { tenantId }`. The prod
// cutover requirement ("runtime role must be app_rls / rolbypassrls=false") was
// a manual checklist item; this turns it into an automated boot-time guard.
//
// Behaviour:
//   - Always inspects the connected role at boot.
//   - Production always fails closed on unsafe or unverifiable roles.
//   - Non-production logs unsafe roles unless RLS_ENFORCE_RUNTIME_ROLE=true.
// The enforce flag only opts non-production into fail-closed mode.
// ===========================================================================

// Minimal shape shared by the Prisma client and an interactive-transaction
// client, so the check can run on a SET-LOCAL-ROLE transaction in tests.
interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

type RuntimeRoleRow = {
  role: string;
  session_role: string;
  super: boolean;
  bypass: boolean;
  can_create_role: boolean;
  can_create_db: boolean;
  can_replicate: boolean;
  can_create_in_public: boolean;
  public_schema_owner: string;
  owns_public_objects: bigint | number;
};

type RuntimeTableRow = {
  table_name: string;
  owner_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  has_tenant_id: boolean;
  tenant_id_not_null: boolean;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
};

type RuntimePolicyRow = {
  table_name: string;
  command: string;
  roles: string[];
  using_expression: string | null;
  check_expression: string | null;
};

export interface RlsRoleStatus {
  /** The Postgres role the connection authenticated as (current_user). */
  role: string;
  /** Role is a superuser (implicitly bypasses RLS). */
  isSuperuser: boolean;
  /** Role has rolbypassrls. */
  hasBypassRls: boolean;
  /** True when the role bypasses RLS for any reason (superuser OR rolbypassrls). */
  bypassesRls: boolean;
  /** Login/session principal; production must authenticate directly as app_rls. */
  sessionRole?: string;
  /** Exact least-privilege/RLS manifest deviations. Empty means boot-safe. */
  postureDefects: string[];
  /** The diagnostic query could not run (e.g. DB not reachable at boot). */
  checkFailed?: boolean;
}

interface CheckRlsOptions {
  /**
   * The disposable local browser harness authenticates as the database owner
   * and immediately SET ROLEs to app_rls because migrations intentionally do
   * not bake an app_rls password into source. Real deployments must never use
   * this exception: they authenticate directly as app_rls.
   */
  allowDisposableRoleSwitch?: boolean;
}

/**
 * Inspect the RLS-bypass status of the role on a given connection. This is an
 * advisory diagnostic: it must NEVER crash the process, so a query failure
 * (DB not ready at boot, permissions) resolves to a checkFailed status instead
 * of throwing. The real tenant control (RLS policies + app-level scoping) is
 * independent of this check.
 */
export async function checkRlsRuntimeRole(
  client: RawQueryClient = db,
  options: CheckRlsOptions = {},
): Promise<RlsRoleStatus> {
  try {
    const rows = await client.$queryRaw<RuntimeRoleRow[]>`
      SELECT current_user AS role,
             session_user AS session_role,
             runtime.rolsuper     AS super,
             runtime.rolbypassrls AS bypass,
             runtime.rolcreaterole AS can_create_role,
             runtime.rolcreatedb AS can_create_db,
             runtime.rolreplication AS can_replicate,
             has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public,
             schema_owner.rolname::text AS public_schema_owner,
             (
               SELECT count(*)
               FROM pg_class owned
               JOIN pg_namespace owned_ns ON owned_ns.oid = owned.relnamespace
               WHERE owned_ns.nspname = 'public' AND owned.relowner = runtime.oid
             ) + (
               SELECT count(*)
               FROM pg_proc owned_proc
               JOIN pg_namespace proc_ns ON proc_ns.oid = owned_proc.pronamespace
               WHERE proc_ns.nspname = 'public' AND owned_proc.proowner = runtime.oid
             ) AS owns_public_objects
      FROM pg_roles runtime
      JOIN pg_namespace public_ns ON public_ns.nspname = 'public'
      JOIN pg_roles schema_owner ON schema_owner.oid = public_ns.nspowner
      WHERE runtime.rolname = current_user`;
    const row = rows[0];
    if (!row) throw new Error('runtime role not found');
    const isSuperuser = Boolean(row?.super);
    const hasBypassRls = Boolean(row?.bypass);
    const defects: string[] = [];
    if (row.role !== EXPECTED_RUNTIME_ROLE) defects.push(`current_user is ${row.role}, expected ${EXPECTED_RUNTIME_ROLE}`);
    if (row.session_role !== EXPECTED_RUNTIME_ROLE && !options.allowDisposableRoleSwitch) {
      defects.push(`session_user is ${row.session_role}, expected direct ${EXPECTED_RUNTIME_ROLE} authentication`);
    }
    if (isSuperuser) defects.push('runtime role is SUPERUSER');
    if (hasBypassRls) defects.push('runtime role has BYPASSRLS');
    if (row.can_create_role) defects.push('runtime role has CREATEROLE');
    if (row.can_create_db) defects.push('runtime role has CREATEDB');
    if (row.can_replicate) defects.push('runtime role has REPLICATION');
    if (row.can_create_in_public) defects.push('runtime role can CREATE in schema public');
    if (row.public_schema_owner === row.role) defects.push('runtime role owns schema public');
    if (Number(row.owns_public_objects) !== 0) defects.push(`runtime role owns ${row.owns_public_objects} public object(s)`);

    const memberships = await client.$queryRaw<Array<{ inherited_role: string }>>`
      SELECT parent.rolname::text AS inherited_role
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles parent ON parent.oid = membership.roleid
      WHERE member.rolname = current_user
    `;
    if (memberships.length) defects.push(`runtime role inherits [${memberships.map(item => item.inherited_role).sort().join(', ')}]`);

    const tables = await client.$queryRaw<RuntimeTableRow[]>`
      SELECT c.relname::text AS table_name,
             owner.rolname::text AS owner_name,
             c.relrowsecurity AS rls_enabled,
             c.relforcerowsecurity AS rls_forced,
             EXISTS (
               SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
             ) AS has_tenant_id,
             COALESCE((
               SELECT a.attnotnull FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
             ), false) AS tenant_id_not_null,
             has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
             has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
             has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
             has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles owner ON owner.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `;
    const tableNames = new Set(tables.map(table => table.table_name));
    for (const required of ['Tenant', ...Object.keys(GLOBAL_RUNTIME_TABLE_PRIVILEGES)]) {
      if (!tableNames.has(required)) defects.push(`required manifest table ${required} is missing`);
    }
    for (const table of tables) {
      const expected = expectedRuntimeTablePrivileges(table);
      if (!expected) {
        defects.push(`unclassified public table ${table.table_name}`);
        continue;
      }
      const actual = new Set([
        table.can_select ? 'SELECT' : null,
        table.can_insert ? 'INSERT' : null,
        table.can_update ? 'UPDATE' : null,
        table.can_delete ? 'DELETE' : null,
      ].filter((value): value is string => value !== null));
      if (actual.size !== expected.size || [...actual].some(privilege => !expected.has(privilege))) {
        defects.push(`table ${table.table_name} privileges [${[...actual].join(',') || 'none'}] expected [${[...expected].join(',') || 'none'}]`);
      }
      if (table.owner_name === row.role) defects.push(`runtime role owns public table ${table.table_name}`);
      if (isTenantRuntimeTable(table) && (!table.rls_enabled || !table.rls_forced)) {
        defects.push(`protected table ${table.table_name} must have ENABLE and FORCE RLS`);
      }
    }

    const policies = await client.$queryRaw<RuntimePolicyRow[]>`
      SELECT tablename::text AS table_name,
             cmd::text AS command,
             roles::text[] AS roles,
             qual::text AS using_expression,
             with_check::text AS check_expression
      FROM pg_policies
      WHERE schemaname = 'public'
    `;
    for (const table of tables.filter(isTenantRuntimeTable)) {
      const expected = expectedRuntimeTablePrivileges(table);
      if (!expected) continue;
      const tablePolicies = policies.filter(policy => policy.table_name === table.table_name);
      if (tablePolicies.some(policy => policy.roles.includes('public'))) defects.push(`protected table ${table.table_name} has a PUBLIC policy`);
      for (const command of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const runtimePolicies = tablePolicies.filter(policy => policy.command === command && policy.roles.includes(EXPECTED_RUNTIME_ROLE));
        const shouldExist = expected.has(command);
        if (runtimePolicies.length !== (shouldExist ? 1 : 0)) {
          defects.push(`protected table ${table.table_name} has ${runtimePolicies.length} ${command} runtime policies; expected ${shouldExist ? 1 : 0}`);
          continue;
        }
        if (!shouldExist) continue;
        const policy = runtimePolicies[0];
        if (!`${policy.using_expression ?? ''} ${policy.check_expression ?? ''}`.includes('app_rls_tenant_allowed')) {
          defects.push(`protected table ${table.table_name} ${command} policy bypasses app_rls_tenant_allowed`);
        }
        if ((command === 'INSERT' || command === 'UPDATE') && !policy.check_expression) {
          defects.push(`protected table ${table.table_name} ${command} policy lacks WITH CHECK`);
        }
        if ((command === 'SELECT' || command === 'UPDATE' || command === 'DELETE') && !policy.using_expression) {
          defects.push(`protected table ${table.table_name} ${command} policy lacks USING`);
        }
      }
    }
    return {
      role: row.role,
      sessionRole: row.session_role,
      isSuperuser,
      hasBypassRls,
      bypassesRls: isSuperuser || hasBypassRls,
      postureDefects: defects,
    };
  } catch {
    return { role: 'unknown', isSuperuser: false, hasBypassRls: false, bypassesRls: false, postureDefects: [], checkFailed: true };
  }
}

export function rlsRoleMessage(status: RlsRoleStatus): string {
  if (!status.bypassesRls) {
    return `RLS runtime-role guard: database posture does not match the ${EXPECTED_RUNTIME_ROLE} least-privilege manifest: ${status.postureDefects.join('; ')}.`;
  }
  const reason = status.isSuperuser ? 'superuser' : 'rolbypassrls';
  return `RLS runtime-role guard: database role "${status.role}" BYPASSES row-level security (${reason}). `
    + 'Tenant RLS policies are silently ineffective on this connection — the only tenant control is the '
    + 'application-level filter. Use a restricted role (app_rls, NOSUPERUSER NOBYPASSRLS) for the runtime '
    + 'DATABASE_URL. Set RLS_ENFORCE_RUNTIME_ROLE=true in non-production to make this fatal before cutover.';
}

interface AssertLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

interface AssertOptions {
  client?: RawQueryClient;
  /** Throw when the role bypasses RLS. Defaults to env.RLS_ENFORCE_RUNTIME_ROLE. */
  enforce?: boolean;
  /** Drives error-vs-warn log level. Defaults to NODE_ENV==='production'. */
  isProduction?: boolean;
  logger?: AssertLogger;
  /** Unit-test seam; production callers should rely on the guarded default. */
  allowDisposableRoleSwitch?: boolean;
}

function disposableRoleSwitchAllowed(): boolean {
  const disposableDatabase = process.env.RLS_DISPOSABLE_DB ?? '';
  return env.E2E_TEST_MODE
    && env.DEPLOYMENT_PROFILE === 'demo'
    && /^carecommand_rls_behavior_[a-z0-9_]+$/.test(disposableDatabase);
}

/**
 * Boot-time assertion. Returns the role status; logs (or throws when enforced)
 * if the role can bypass RLS. Never throws for a correctly-restricted role.
 */
export async function assertRlsRuntimeRole(options: AssertOptions = {}): Promise<RlsRoleStatus> {
  const isProduction = options.isProduction ?? (env.NODE_ENV === 'production');
  const enforce = isProduction || (options.enforce ?? env.RLS_ENFORCE_RUNTIME_ROLE);
  const status = await checkRlsRuntimeRole(options.client ?? db, {
    allowDisposableRoleSwitch: options.allowDisposableRoleSwitch ?? disposableRoleSwitchAllowed(),
  });
  if (status.checkFailed) {
    const message = 'RLS runtime-role guard: could not verify the DB role at boot.';
    if (enforce) {
      throw new Error(`${message} Refusing to boot.`);
    }
    (options.logger ?? console).warn(`${message} Continuing in non-production without enforcement.`);
    return status;
  }
  if (!status.bypassesRls && status.postureDefects.length === 0) return status;

  const message = rlsRoleMessage(status);
  if (enforce) throw new Error(message);

  const logger = options.logger ?? console;
  if (isProduction) logger.error(message);
  else logger.warn(message);
  return status;
}
