import { db } from '../../lib/db';
import { autopilotQueue } from '../../workers/queues';
import { dependencyUp } from '../../lib/metrics';

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

export async function checkRedis(): Promise<boolean> {
  try {
    const client = (await withTimeout(Promise.resolve(autopilotQueue.client), 1000)) as unknown as { ping(): Promise<string> };
    const pong = await withTimeout(client.ping(), 1000);
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/** Run both probes and publish the results to the dependency_up gauge. */
export async function refreshDependencyGauges(): Promise<{ databaseOk: boolean; redisOk: boolean }> {
  const [databaseOk, redisOk] = await Promise.all([checkDatabase(), checkRedis()]);
  dependencyUp.set({ dependency: 'database' }, databaseOk ? 1 : 0);
  dependencyUp.set({ dependency: 'redis' }, redisOk ? 1 : 0);
  return { databaseOk, redisOk };
}
