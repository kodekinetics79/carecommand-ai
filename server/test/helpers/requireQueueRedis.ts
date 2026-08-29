import Redis from 'ioredis';
import { env } from '../../config/env';

// Queue-backed suites drain real BullMQ queues; they cannot be satisfied by a
// mock. When Redis is absent BullMQ retries silently and every assertion in the
// file surfaces as an opaque "Test timed out in 5000ms" — which reads like a
// product regression instead of a missing service, and cost a full triage pass
// to re-diagnose. Fail fast and name exactly what is missing.

/** Redis host:port only — never echo the URL, which may carry credentials. */
function redisTarget(): string {
  try {
    const url = new URL(env.REDIS_URL);
    return `${url.hostname}:${url.port || '6379'}`;
  } catch {
    return 'the configured REDIS_URL';
  }
}

export async function requireQueueRedis(): Promise<void> {
  if (!env.QUEUES_ENABLED) {
    throw new Error(
      'This suite drains real BullMQ queues and requires QUEUES_ENABLED=true (currently false).',
    );
  }
  const probe = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
  } catch (error) {
    throw new Error(
      `This suite drains real BullMQ queues and requires Redis at ${redisTarget()}, which is not reachable `
      + `(${error instanceof Error ? error.message : String(error)}). Start it with "docker compose up -d redis" `
      + 'or point REDIS_URL at a running instance.',
      { cause: error },
    );
  } finally {
    probe.disconnect();
  }
}
