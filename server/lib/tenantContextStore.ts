import { AsyncLocalStorage } from 'node:async_hooks';

export type TenantContextSource = 'request' | 'portal' | 'worker' | 'webhook' | 'platform' | 'support' | 'system';

export interface TenantContext {
  tenantId: string;
  actorId: string;
  actorRole: string;
  source: TenantContextSource;
  requestId?: string;
  correlationId?: string;
  supportReason?: string;
  supportExpiresAt?: Date;
  supportSessionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface TenantContextScope { context?: TenantContext }
const storage = new AsyncLocalStorage<TenantContextScope>();

export function validateTenantContext(context: TenantContext): TenantContext {
  if (!UUID_RE.test(context.tenantId)) {
    throw new Error('TenantContext: a valid tenantId is required (fail-closed)');
  }
  if (!context.actorId.trim()) {
    throw new Error('TenantContext: an actorId is required (fail-closed)');
  }
  if (!context.actorRole.trim()) {
    throw new Error('TenantContext: an actorRole is required (fail-closed)');
  }
  if (context.supportExpiresAt && context.supportExpiresAt.getTime() <= Date.now()) {
    throw new Error('TenantContext: support authorization has expired (fail-closed)');
  }
  if (context.source === 'support' && !context.supportReason?.trim()) {
    throw new Error('TenantContext: support access requires a reason (fail-closed)');
  }
  if (context.source === 'support' && (!context.supportSessionId || !UUID_RE.test(context.supportSessionId))) {
    throw new Error('TenantContext: support access requires a valid session (fail-closed)');
  }
  return context;
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore()?.context;
}

export function getCurrentTenantId(): string | undefined {
  return getTenantContext()?.tenantId;
}

export function requireTenantContext(): TenantContext {
  const context = getTenantContext();
  if (!context) throw new Error('TenantContext: no active tenant context (fail-closed)');
  return context;
}

export function requireTenantId(): string {
  return requireTenantContext().tenantId;
}

export function runInTenantContext<T>(context: TenantContext, fn: () => T): T {
  return storage.run({ context: validateTenantContext(context) }, fn);
}

/** Establish a mutable per-request scope before authentication is resolved. */
export function initializeTenantContextScope<T>(fn: () => T): T {
  return storage.run({}, fn);
}

/** Activate a verified context for the current request/job async chain. */
export function enterTenantContext(context: TenantContext): TenantContext {
  const validated = validateTenantContext(context);
  const scope = storage.getStore();
  if (scope) scope.context = validated;
  else storage.enterWith({ context: validated });
  return validated;
}
