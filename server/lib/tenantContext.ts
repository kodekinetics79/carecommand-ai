import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from './db';
import type { Prisma } from '../generated/prisma/client';

// The Prisma interactive-transaction client ("tx"). Callers run their queries
// against THIS client so they execute on the same pinned connection that holds
// the transaction-local tenant GUC.
export type TenantTxClient = Prisma.TransactionClient;

export interface TenantContext {
  tenantId: string;
  source: 'request' | 'worker' | 'webhook';
}

// AsyncLocalStorage scopes the active tenant to a single async call tree. It is
// torn down when runInTenantTransaction resolves, so context cannot bleed into
// another request handled on the same thread/connection.
const storage = new AsyncLocalStorage<TenantContext>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertTenantId(tenantId: string | undefined | null): string {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    // Fail closed: never run DB work with a missing/invalid tenant. Once RLS is
    // enabled an unset GUC would silently filter everything to nothing; here we
    // refuse up front so the bug surfaces immediately instead of leaking.
    throw new Error('TenantContext: a valid tenantId is required (fail-closed)');
  }
  return tenantId;
}

/** The active tenant id for the current async context, if any. */
export function getCurrentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/** The full active tenant context, if any. */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/** Like getCurrentTenantId but throws when called outside a tenant context. */
export function requireTenantId(): string {
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Error('TenantContext: no active tenant context (fail-closed)');
  return tenantId;
}

/**
 * Core primitive. Opens a Prisma interactive transaction, sets
 * `app.current_tenant_id` transaction-locally (set_config(..., is_local=true))
 * on the SAME connection the callback's `tx` uses, and runs the callback inside
 * an AsyncLocalStorage scope.
 *
 * Guarantees:
 *  - same-connection: the GUC and every `tx.*` query run on the one connection
 *    Prisma pins for the duration of the interactive transaction.
 *  - no leakage: is_local=true means the GUC is discarded at COMMIT/ROLLBACK, so
 *    it never survives onto the next pooled checkout; ALS is unwound on return.
 *  - fail-closed: an invalid/missing tenantId throws before any DB work.
 *
 * Phase A note: RLS is NOT enabled yet, so this changes no query results today.
 * It is opt-in plumbing — callers that adopt it must run their queries against
 * the provided `tx`, not the global `db`, for the context to apply.
 */
async function runInTenantTransaction<T>(
  tenantId: string,
  source: TenantContext['source'],
  fn: (tx: TenantTxClient) => Promise<T>,
): Promise<T> {
  const validated = assertTenantId(tenantId);
  return storage.run({ tenantId: validated, source }, () =>
    db.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${validated}, true)`;
      return fn(tx);
    }),
  );
}

/** Tenant context for an authenticated HTTP request (request.auth.tenantId). */
export function runWithTenantContext<T>(tenantId: string, fn: (tx: TenantTxClient) => Promise<T>): Promise<T> {
  return runInTenantTransaction(tenantId, 'request', fn);
}

/** Tenant context for a background job (tenant comes from the job payload). */
export function runWithJobTenantContext<T>(tenantId: string, fn: (tx: TenantTxClient) => Promise<T>): Promise<T> {
  return runInTenantTransaction(tenantId, 'worker', fn);
}

/**
 * Tenant context for a public webhook AFTER the tenant has been resolved
 * (e.g. Retell via clinic/campaign id, Stripe via the matched payment request).
 * The unauthenticated tenant-resolution lookup happens before this call; only
 * the tenant-scoped writes run inside it.
 */
export function runWithWebhookTenantContext<T>(tenantId: string, fn: (tx: TenantTxClient) => Promise<T>): Promise<T> {
  return runInTenantTransaction(tenantId, 'webhook', fn);
}

/** Reads the GUC actually visible on a tx connection. Intended for tests/asserts. */
export async function readTenantGuc(tx: TenantTxClient): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ tenant: string | null }>>`SELECT current_setting('app.current_tenant_id', true) AS tenant`;
  const value = rows[0]?.tenant;
  return value && value.length > 0 ? value : null;
}
