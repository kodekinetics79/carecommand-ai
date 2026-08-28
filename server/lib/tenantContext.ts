import { db } from './db';
import type { Prisma } from '../generated/prisma/client';
import { getTenantContext as getStoredTenantContext, runInTenantContext, type TenantContext } from './tenantContextStore';

export type TenantTxClient = Prisma.TransactionClient;

export {
  enterTenantContext,
  getCurrentTenantId,
  getTenantContext,
  initializeTenantContextScope,
  requireTenantContext,
  requireTenantId,
  runInTenantContext,
  validateTenantContext,
  type TenantContext,
  type TenantContextSource,
} from './tenantContextStore';

async function runInTenantTransaction<T>(
  context: TenantContext,
  fn: (tx: TenantTxClient) => Promise<T>,
): Promise<T> {
  return runInTenantContext(context, () =>
    db.$transaction(tx => fn(tx)),
  );
}

export function runWithTrustedTenantContext<T>(
  context: TenantContext,
  fn: (tx: TenantTxClient) => Promise<T>,
): Promise<T> {
  return runInTenantTransaction(context, fn);
}

export function runWithTenantContext<T>(
  tenantId: string,
  fn: (tx: TenantTxClient) => Promise<T>,
  actor?: { id: string; role: string; requestId?: string },
): Promise<T> {
  const existing = getStoredTenantContext();
  if (existing) {
    if (existing.tenantId !== tenantId) {
      throw new Error('TenantContext: nested calls cannot change tenant scope (fail-closed)');
    }
    return runInTenantTransaction(existing, fn);
  }
  if (!actor?.id.trim() || !actor.role.trim()) {
    throw new Error('TenantContext: an explicit trusted actor is required when no request context exists (fail-closed)');
  }
  return runInTenantTransaction({
    tenantId,
    actorId: actor.id,
    actorRole: actor.role,
    source: 'request',
    requestId: actor.requestId,
  }, fn);
}

export function runWithJobTenantContext<T>(
  tenantId: string,
  fn: (tx: TenantTxClient) => Promise<T>,
  actorId = 'worker:job',
): Promise<T> {
  return runInTenantTransaction({ tenantId, actorId, actorRole: 'WORKER', source: 'worker' }, fn);
}

export function runWithWebhookTenantContext<T>(
  tenantId: string,
  fn: (tx: TenantTxClient) => Promise<T>,
  actorId = 'webhook:provider',
): Promise<T> {
  return runInTenantTransaction({ tenantId, actorId, actorRole: 'WEBHOOK', source: 'webhook' }, fn);
}

export async function readTenantGuc(tx: TenantTxClient): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ tenant: string | null }>>`
    SELECT current_setting('app.current_tenant_id', true) AS tenant
  `;
  const value = rows[0]?.tenant;
  return value && value.length > 0 ? value : null;
}
