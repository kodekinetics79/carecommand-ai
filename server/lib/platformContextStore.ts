import { AsyncLocalStorage } from 'node:async_hooks';

export interface PlatformDatabaseContext {
  actorId?: string;
  actorRole?: string;
}

const storage = new AsyncLocalStorage<PlatformDatabaseContext>();

/**
 * Bind the authenticated platform identity to the remainder of the request's
 * async chain. The platform database client replays this identity as
 * transaction-local PostgreSQL settings before touching tenant control data.
 */
export function enterPlatformDatabaseContext(context: PlatformDatabaseContext): void {
  const current = storage.getStore();
  if (current) Object.assign(current, context);
  else storage.enterWith({ ...context });
}

export function getPlatformDatabaseContext(): Required<PlatformDatabaseContext> | undefined {
  const context = storage.getStore();
  return context?.actorId && context.actorRole
    ? { actorId: context.actorId, actorRole: context.actorRole }
    : undefined;
}

/** Establish one mutable context container for the complete Fastify request. */
export function runWithPlatformDatabaseRequest<T>(callback: () => T): T {
  return storage.run({}, callback);
}
