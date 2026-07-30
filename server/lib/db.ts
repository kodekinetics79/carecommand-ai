import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';
import { env } from '../config/env';
import { getTenantContext, type TenantContext } from './tenantContextStore';

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const baseDb = new PrismaClient({ adapter });

type DynamicRecord = Record<PropertyKey, unknown>;
type DynamicMethod = (...args: unknown[]) => unknown;
const rawMethods = new Set(['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe', '$queryRawTyped']);

export async function applyTenantContextToTransaction(
  tx: Prisma.TransactionClient,
  context: TenantContext,
): Promise<void> {
  const supportExpiry = context.supportExpiresAt?.toISOString() ?? '';
  await tx.$executeRaw`
    SELECT
      set_config('app.current_tenant_id', ${context.tenantId}, true),
      set_config('app.current_actor_id', ${context.actorId}, true),
      set_config('app.current_actor_role', ${context.actorRole}, true),
      set_config('app.current_context_source', ${context.source}, true),
      set_config('app.current_request_id', ${context.requestId ?? ''}, true),
      set_config('app.current_correlation_id', ${context.correlationId ?? ''}, true),
      set_config('app.current_support_reason', ${context.supportReason ?? ''}, true),
      set_config('app.current_support_expires_at', ${supportExpiry}, true),
      set_config('app.current_support_session_id', ${context.supportSessionId ?? ''}, true)
  `;

  // Context is not accepted merely because it is syntactically valid. Every
  // protected operation revalidates the stored tenant state on its own pinned
  // connection. Unknown, suspended, and archived tenants fail closed.
  const tenants = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Tenant" WHERE id = ${context.tenantId}::uuid AND status = 'active' LIMIT 1
  `;
  if (tenants.length !== 1) {
    throw new Error('TenantContext: tenant is unknown, suspended, or archived (fail-closed)');
  }
}

function callTransactionMethod(
  target: PrismaClient,
  args: unknown[],
  context: TenantContext,
): unknown {
  const [input, options] = args;
  if (typeof input !== 'function') {
    throw new Error('TenantContext: array-form transactions are forbidden; use an interactive transaction');
  }
  const callback = input as (tx: Prisma.TransactionClient) => Promise<unknown>;
  return target.$transaction(async tx => {
    await applyTenantContextToTransaction(tx, context);
    return callback(tx);
  }, options as Parameters<PrismaClient['$transaction']>[1]);
}

function scopedRawMethod(target: PrismaClient, property: string, context: TenantContext): DynamicMethod {
  return (...args: unknown[]) => target.$transaction(async tx => {
    await applyTenantContextToTransaction(tx, context);
    const method = Reflect.get(tx as unknown as DynamicRecord, property) as DynamicMethod;
    return Reflect.apply(method, tx, args);
  });
}

function scopedDelegate(target: PrismaClient, delegateName: string, delegate: object): object {
  return new Proxy(delegate, {
    get(delegateTarget, operation, receiver) {
      const value = Reflect.get(delegateTarget, operation, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const context = getTenantContext();
        if (!context) return Reflect.apply(value as DynamicMethod, delegateTarget, args);
        return target.$transaction(async tx => {
          await applyTenantContextToTransaction(tx, context);
          const txDelegate = Reflect.get(tx as unknown as DynamicRecord, delegateName) as DynamicRecord;
          const txMethod = Reflect.get(txDelegate, operation) as DynamicMethod;
          return Reflect.apply(txMethod, txDelegate, args);
        });
      };
    },
  });
}

const delegateCache = new Map<string, object>();
const dbProxy = new Proxy(baseDb, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    const context = getTenantContext();

    if (property === '$transaction' && context) {
      return (...args: unknown[]) => callTransactionMethod(target, args, context);
    }
    if (typeof property === 'string' && rawMethods.has(property) && context) {
      return scopedRawMethod(target, property, context);
    }
    if (typeof property === 'string' && !property.startsWith('$') && value && typeof value === 'object') {
      const cached = delegateCache.get(property);
      if (cached) return cached;
      const proxy = scopedDelegate(target, property, value);
      delegateCache.set(property, proxy);
      return proxy;
    }
    if (typeof value === 'function') return value.bind(target);
    return value;
  },
});

/**
 * Runtime Prisma client. When a trusted tenant context is active, each model or
 * raw operation executes in a short transaction with transaction-local GUCs.
 * Without context it connects as app_rls and PostgreSQL policies fail closed.
 */
export const db = dbProxy as unknown as PrismaClient;
