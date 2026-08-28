import { db } from './db';
import { env } from '../config/env';

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
//   - If it bypasses RLS: error-log in production, warn otherwise.
//   - If RLS_ENFORCE_RUNTIME_ROLE=true: throw (fail closed) — refuse to boot.
// The enforce flag defaults OFF so it cannot brick a deploy that has not yet
// migrated its runtime role to app_rls; flip it on after the cutover.
// ===========================================================================

// Minimal shape shared by the Prisma client and an interactive-transaction
// client, so the check can run on a SET-LOCAL-ROLE transaction in tests.
interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface RlsRoleStatus {
  /** The Postgres role the connection authenticated as (current_user). */
  role: string;
  /** Role is a superuser (implicitly bypasses RLS). */
  isSuperuser: boolean;
  /** Role has rolbypassrls. */
  hasBypassRls: boolean;
  /** True when the role bypasses RLS for any reason (superuser OR rolbypassrls). */
  bypassesRls: boolean;
  /** The diagnostic query could not run (e.g. DB not reachable at boot). */
  checkFailed?: boolean;
}

/**
 * Inspect the RLS-bypass status of the role on a given connection. This is an
 * advisory diagnostic: it must NEVER crash the process, so a query failure
 * (DB not ready at boot, permissions) resolves to a checkFailed status instead
 * of throwing. The real tenant control (RLS policies + app-level scoping) is
 * independent of this check.
 */
export async function checkRlsRuntimeRole(client: RawQueryClient = db): Promise<RlsRoleStatus> {
  try {
    const rows = await client.$queryRaw<Array<{ role: string; super: boolean; bypass: boolean }>>`
      SELECT current_user AS role,
             rolsuper     AS super,
             rolbypassrls AS bypass
      FROM pg_roles
      WHERE rolname = current_user`;
    const row = rows[0];
    const isSuperuser = Boolean(row?.super);
    const hasBypassRls = Boolean(row?.bypass);
    return {
      role: row?.role ?? 'unknown',
      isSuperuser,
      hasBypassRls,
      bypassesRls: isSuperuser || hasBypassRls,
    };
  } catch {
    return { role: 'unknown', isSuperuser: false, hasBypassRls: false, bypassesRls: false, checkFailed: true };
  }
}

export function rlsRoleMessage(status: RlsRoleStatus): string {
  const reason = status.isSuperuser ? 'superuser' : 'rolbypassrls';
  return `RLS runtime-role guard: database role "${status.role}" BYPASSES row-level security (${reason}). `
    + 'Tenant RLS policies are silently ineffective on this connection — the only tenant control is the '
    + 'application-level filter. Use a restricted role (app_rls, NOSUPERUSER NOBYPASSRLS) for the runtime '
    + 'DATABASE_URL. Set RLS_ENFORCE_RUNTIME_ROLE=true to make this fatal once the cutover is done.';
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
}

/**
 * Boot-time assertion. Returns the role status; logs (or throws when enforced)
 * if the role can bypass RLS. Never throws for a correctly-restricted role.
 */
export async function assertRlsRuntimeRole(options: AssertOptions = {}): Promise<RlsRoleStatus> {
  const status = await checkRlsRuntimeRole(options.client ?? db);
  // Advisory only: if the check couldn't run, warn but never block boot.
  if (status.checkFailed) {
    (options.logger ?? console).warn('RLS runtime-role guard: could not verify the DB role at boot (continuing).');
    return status;
  }
  if (!status.bypassesRls) return status;

  const message = rlsRoleMessage(status);
  const enforce = options.enforce ?? env.RLS_ENFORCE_RUNTIME_ROLE;
  if (enforce) throw new Error(message);

  const isProduction = options.isProduction ?? (env.NODE_ENV === 'production');
  const logger = options.logger ?? console;
  if (isProduction) logger.error(message);
  else logger.warn(message);
  return status;
}
