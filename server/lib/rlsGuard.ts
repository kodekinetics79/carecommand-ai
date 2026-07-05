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
//   - Always inspects the connected role at boot (API and worker entrypoints).
//   - PRODUCTION ALWAYS ENFORCES: an unsafe role refuses to boot, and a role
//     that cannot be verified (DB unreachable) is retried and then refused —
//     "cannot verify isolation" is not a state production may run in. The
//     RLS_ENFORCE_RUNTIME_ROLE flag CANNOT disable this in production.
//   - Non-production: advisory by default (warn and continue, so dev/test on a
//     single owner role stay usable); RLS_ENFORCE_RUNTIME_ROLE=true opts into
//     the same fail-closed behavior (staging, or dev already on app_rls).
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
    + 'DATABASE_URL; set its password via prisma/rls/app_rls_setup.sql. Production always fails closed on '
    + 'this condition (see docs/RLS.md).';
}

/**
 * Effective enforcement for the runtime-role guard.
 *
 * Production ALWAYS enforces — tenant isolation is release-blocking, so an
 * unsafe runtime role must never boot silently, and no env flag can turn that
 * off. Outside production the RLS_ENFORCE_RUNTIME_ROLE flag opts in.
 */
export function resolveRlsEnforcement(
  nodeEnv: string = env.NODE_ENV,
  enforceFlag: boolean = env.RLS_ENFORCE_RUNTIME_ROLE,
): boolean {
  return nodeEnv === 'production' || enforceFlag;
}

interface AssertLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

interface AssertOptions {
  client?: RawQueryClient;
  /**
   * Throw when the role bypasses RLS (or cannot be verified). Defaults to
   * resolveRlsEnforcement(): ALWAYS true in production; the
   * RLS_ENFORCE_RUNTIME_ROLE flag opts in elsewhere.
   */
  enforce?: boolean;
  /** Drives error-vs-warn log level AND implies enforcement. Defaults to NODE_ENV==='production'. */
  isProduction?: boolean;
  logger?: AssertLogger;
  /** Retries when the verification query fails (DB waking up at boot). */
  verifyRetries?: number;
  /** Delay between verification retries, in ms. */
  verifyRetryDelayMs?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Boot-time assertion. Returns the role status; never throws for a correctly-
 * restricted role.
 *
 * Fail-closed contract (enforcing = production, or enforce/flag opt-in):
 *   - role bypasses RLS  → throw (refuse to boot).
 *   - role unverifiable  → retry (default 4×2500ms ≈ 10s for a DB that is
 *     still waking), then throw. "Could not verify isolation" must not be a
 *     bootable production state — a crash-looping deploy is loud; a silently
 *     unverified one is not.
 * Advisory (non-enforcing, dev/test): warn and continue in both cases.
 */
export async function assertRlsRuntimeRole(options: AssertOptions = {}): Promise<RlsRoleStatus> {
  const logger = options.logger ?? console;
  const isProduction = options.isProduction ?? (env.NODE_ENV === 'production');
  const enforce = options.enforce
    ?? resolveRlsEnforcement(isProduction ? 'production' : env.NODE_ENV, env.RLS_ENFORCE_RUNTIME_ROLE);

  const client = options.client ?? db;
  let status = await checkRlsRuntimeRole(client);

  if (status.checkFailed && enforce) {
    const retries = options.verifyRetries ?? 4;
    const delayMs = options.verifyRetryDelayMs ?? 2500;
    for (let attempt = 1; attempt <= retries && status.checkFailed; attempt += 1) {
      logger.warn(`RLS runtime-role guard: verification query failed (attempt ${attempt}/${retries}) — retrying in ${delayMs}ms.`);
      await sleep(delayMs);
      status = await checkRlsRuntimeRole(client);
    }
  }

  if (status.checkFailed) {
    if (enforce) {
      throw new Error(
        'RLS runtime-role guard: could not verify the runtime DB role and enforcement is on '
        + '(production always enforces). Refusing to boot with unverifiable tenant isolation.',
      );
    }
    logger.warn('RLS runtime-role guard: could not verify the DB role at boot (continuing — advisory mode).');
    return status;
  }

  if (!status.bypassesRls) return status;

  const message = rlsRoleMessage(status);
  if (enforce) throw new Error(message);

  if (isProduction) logger.error(message);
  else logger.warn(message);
  return status;
}
