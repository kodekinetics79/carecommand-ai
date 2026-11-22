import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it } from 'vitest';
import {
  acquireApiRateLimitStore,
  createApiRateLimitStoreManager,
  type ApiRateLimitClient,
} from '../../server/lib/apiRateLimitStore';

type RateLimitResult = [number, number];

function fakeClient(input: {
  connect?: () => Promise<void>;
  ping?: () => Promise<string>;
  rateLimit?: (key: string, timeWindow: number) => Promise<RateLimitResult>;
  onDisconnect?: () => void;
} = {}): ApiRateLimitClient {
  const client: ApiRateLimitClient = {
    status: 'wait',
    async connect() {
      await (input.connect?.() ?? Promise.resolve());
      client.status = 'ready';
    },
    disconnect: () => input.onDisconnect?.(),
    ping: input.ping ?? (async () => 'PONG'),
    defineCommand(name) {
      if (name !== 'rateLimit') throw new Error(`unexpected command ${name}`);
      client.rateLimit = input.rateLimit ?? (async () => [1, 60_000]);
    },
  };
  return client;
}

function sharedRateLimitClient(counts: Map<string, number>): ApiRateLimitClient {
  return fakeClient({
    rateLimit: async (key, timeWindow) => {
      const current = (counts.get(key) ?? 0) + 1;
      counts.set(key, current);
      return [current, timeWindow];
    },
  });
}

describe('API rate-limit store', () => {
  it('implements the real @fastify/rate-limit Redis contract across app instances', async () => {
    const counts = new Map<string, number>();
    const first = await acquireApiRateLimitStore({
      nodeEnv: 'production',
      redisUrl: 'rediss://redis.example.test:6380',
      createClient: () => sharedRateLimitClient(counts),
    });
    const second = await acquireApiRateLimitStore({
      nodeEnv: 'production',
      redisUrl: 'rediss://redis.example.test:6380',
      createClient: () => sharedRateLimitClient(counts),
    });
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const makeApp = async (redis: NonNullable<typeof first>) => {
      const app = Fastify({ logger: false });
      await app.register(rateLimit, {
        redis,
        max: 1,
        timeWindow: '1 minute',
        nameSpace: 'cc:test:',
        skipOnError: false,
      });
      app.get('/limited', async () => ({ ok: true }));
      await app.ready();
      return app;
    };

    const app1 = await makeApp(first!);
    const app2 = await makeApp(second!);
    const firstResponse = await app1.inject('/limited');
    const secondResponse = await app2.inject('/limited');
    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    expect(secondResponse.statusCode, secondResponse.body).toBe(429);
    await Promise.all([app1.close(), app2.close()]);
    first!.close();
    second!.close();
  });

  it('fails closed and disconnects when production Redis never becomes ready', async () => {
    let disconnected = 0;
    const client = fakeClient({ onDisconnect: () => { disconnected += 1; } });
    const originalConnect = client.connect.bind(client);
    client.connect = async () => {
      await originalConnect();
      client.status = 'connect';
    };

    await expect(acquireApiRateLimitStore({
      nodeEnv: 'production',
      redisUrl: 'rediss://redis.example.test:6380',
      createClient: () => client,
    })).rejects.toThrow('RateLimit: distributed store is required in production (not_ready)');
    expect(disconnected).toBe(1);
  });

  it('allows a bounded managed-Redis cold connection and classifies a real timeout', async () => {
    const client = fakeClient({ connect: () => new Promise<void>(() => {}) });

    await expect(acquireApiRateLimitStore({
      nodeEnv: 'production',
      redisUrl: 'rediss://redis.example.test:6380',
      connectTimeoutMs: 5,
      createClient: () => client,
    })).rejects.toThrow('RateLimit: distributed store is required in production (connect_timeout)');
  });

  it('recovers with a fresh client after a runtime command failure', async () => {
    let created = 0;
    let firstDisconnected = 0;
    const manager = createApiRateLimitStoreManager({
      circuitCooldownMs: 0,
      createClient: () => {
        created += 1;
        return created === 1
          ? fakeClient({
              rateLimit: async () => { throw new Error('connection lost'); },
              onDisconnect: () => { firstDisconnected += 1; },
            })
          : fakeClient({ rateLimit: async () => [1, 60_000] });
      },
    });
    await manager.connect();
    manager.store.defineCommand('rateLimit', { numberOfKeys: 1, lua: 'return {1, 1}' });

    await expect(manager.store.rateLimit('key', 60_000, 10, false, false)).rejects.toThrow('connection lost');
    await expect(manager.store.rateLimit('key', 60_000, 10, false, false)).resolves.toEqual([1, 60_000]);
    expect(created).toBe(2);
    expect(firstDisconnected).toBe(1);
    manager.close();
  });

  it('uses the in-memory limiter outside production when Redis is unavailable', async () => {
    const result = await acquireApiRateLimitStore({
      nodeEnv: 'development',
      redisUrl: 'redis://127.0.0.1:6379',
      createClient: () => fakeClient({ connect: async () => { throw new Error('unreachable'); } }),
    });

    expect(result).toBeUndefined();
  });
});
