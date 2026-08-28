import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';
import { env } from '../config/env';
import { getPlatformDatabaseContext } from './platformContextStore';

function connectionString(): string {
  if (env.PLATFORM_DATABASE_URL) return env.PLATFORM_DATABASE_URL;
  throw new Error('PlatformDatabase: PLATFORM_DATABASE_URL is required; the platform plane must never fall back to the tenant runtime role');
}

const adapter = new PrismaPg({ connectionString: connectionString() });
const basePlatformDb = new PrismaClient({ adapter });

type DynamicRecord = Record<PropertyKey, unknown>;
type DynamicMethod = (...args: unknown[]) => unknown;
const rawMethods = new Set(['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe', '$queryRawTyped']);

async function applyPlatformContext(
  tx: Prisma.TransactionClient,
  context: { actorId: string; actorRole: string },
): Promise<void> {
  await tx.$executeRaw`
    SELECT
      set_config('app.current_platform_actor_id', ${context.actorId}, true),
      set_config('app.current_platform_actor_role', ${context.actorRole}, true),
      set_config('app.current_context_source', 'platform', true)
  `;
}

function scopedDelegate(target: PrismaClient, delegateName: string, delegate: object): object {
  return new Proxy(delegate, {
    get(delegateTarget, operation, receiver) {
      const value = Reflect.get(delegateTarget, operation, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const context = getPlatformDatabaseContext();
        if (!context) return Reflect.apply(value as DynamicMethod, delegateTarget, args);
        return target.$transaction(async tx => {
          await applyPlatformContext(tx, context);
          const txDelegate = Reflect.get(tx as unknown as DynamicRecord, delegateName) as DynamicRecord;
          const txMethod = Reflect.get(txDelegate, operation) as DynamicMethod;
          return Reflect.apply(txMethod, txDelegate, args);
        });
      };
    },
  });
}

const delegateCache = new Map<string, object>();
const platformDbProxy = new Proxy(basePlatformDb, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    const context = getPlatformDatabaseContext();
    if (property === '$transaction' && context) {
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: Parameters<PrismaClient['$transaction']>[1]) =>
        target.$transaction(async tx => {
          await applyPlatformContext(tx, context);
          return callback(tx);
        }, options);
    }
    if (typeof property === 'string' && rawMethods.has(property) && context) {
      return (...args: unknown[]) => target.$transaction(async tx => {
        await applyPlatformContext(tx, context);
        const method = Reflect.get(tx as unknown as DynamicRecord, property) as DynamicMethod;
        return Reflect.apply(method, tx, args);
      });
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

export const platformDb = platformDbProxy as unknown as PrismaClient;

export interface PlatformRolePosture {
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  owns_public_tables: bigint;
}

/** Fail closed before serving the platform plane with an over-privileged role. */
export async function assertPlatformDatabaseRole(): Promise<PlatformRolePosture> {
  const rows = await basePlatformDb.$queryRaw<PlatformRolePosture[]>`
    SELECT r.rolname AS current_user,
           r.rolsuper,
           r.rolbypassrls,
           r.rolcreatedb,
           r.rolcreaterole,
           (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = r.rolname) AS owns_public_tables
    FROM pg_roles r
    WHERE r.rolname = current_user
  `;
  const posture = rows[0];
  const dedicatedConfigured = Boolean(env.PLATFORM_DATABASE_URL);
  if (!posture || posture.rolsuper || posture.rolbypassrls || posture.rolcreatedb || posture.rolcreaterole || posture.owns_public_tables !== 0n || (dedicatedConfigured && posture.current_user !== 'app_platform')) {
    throw new Error('PlatformDatabase: runtime role must be app_platform, non-owner, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and NOCREATEROLE');
  }
  return posture;
}
