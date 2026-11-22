import { db } from '../../lib/db';
import { dependencyUp } from '../../lib/metrics';
import { checkQueueRedis, checkRateLimitRedis, type RedisPingable } from './redisChecks';

export { checkQueueRedis, checkRateLimitRedis } from './redisChecks';

// Dependency probes shared by the readiness route (modules/health/routes.ts)
// and the /metrics scrape (plugins/metrics.ts). Both publish into the
// dependency_up gauge, so the DependencyDown alert has fresh data even when no
// external monitor is polling /health/ready — the Prometheus scrape itself
// keeps the gauge live.

async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, 2000);
    return true;
  } catch {
    return false;
  }
}

export interface DependencyCheckOptions {
  rateLimitRedis?: RedisPingable;
  queuesEnabled?: boolean;
  queueProbe?: () => Promise<unknown>;
}

/** Run dependency probes and publish the results to the dependency_up gauge. */
export async function refreshDependencyGauges(options: DependencyCheckOptions = {}): Promise<{
  databaseOk: boolean;
  redisOk: boolean;
  queueRedisOk: boolean;
}> {
  const [databaseOk, redisOk, queueRedisOk] = await Promise.all([
    checkDatabase(),
    checkRateLimitRedis(options.rateLimitRedis),
    checkQueueRedis({ enabled: options.queuesEnabled ?? false, probe: options.queueProbe }),
  ]);
  dependencyUp.set({ dependency: 'database' }, databaseOk ? 1 : 0);
  dependencyUp.set({ dependency: 'redis' }, redisOk ? 1 : 0);
  dependencyUp.set({ dependency: 'queue-redis' }, queueRedisOk ? 1 : 0);
  return { databaseOk, redisOk, queueRedisOk };
}
