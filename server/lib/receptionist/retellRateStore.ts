import Redis from 'ioredis';
import { env } from '../../config/env';
import {
  withRetellRateStoreDeadline,
  type RetellRateRedis,
} from './providerRateLimit';

const RETELL_RATE_CIRCUIT_COOLDOWN_MS = 1_000;

export interface FailFastRedisClient extends RetellRateRedis {
  status: string;
  connect(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
}

export function createRetellRateStoreManager(input: {
  createClient: () => FailFastRedisClient;
  now?: () => number;
  deadlineMs?: number;
  circuitCooldownMs?: number;
}) {
  const now = input.now ?? Date.now;
  const deadlineMs = input.deadlineMs;
  const circuitCooldownMs = input.circuitCooldownMs ?? RETELL_RATE_CIRCUIT_COOLDOWN_MS;
  let active: FailFastRedisClient | null = null;
  let connectingClient: FailFastRedisClient | null = null;
  let connecting: Promise<FailFastRedisClient> | null = null;
  let circuitOpenUntil = 0;
  let generation = 0;

  function disconnect(client: FailFastRedisClient | null) {
    if (!client) return;
    try { client.disconnect(false); } catch { /* already closed */ }
  }

  function trip(client: FailFastRedisClient | null) {
    disconnect(client);
    if (active === client) active = null;
    circuitOpenUntil = now() + circuitCooldownMs;
  }

  async function acquire(): Promise<FailFastRedisClient> {
    if (active?.status === 'ready') return active;
    if (active) trip(active);
    if (now() < circuitOpenUntil) throw new Error('Retell rate store circuit open');
    if (connecting) return connecting;

    const candidate = input.createClient();
    const candidateGeneration = generation;
    connectingClient = candidate;
    connecting = (async () => {
      try {
        await withRetellRateStoreDeadline(candidate.connect(), deadlineMs);
        if (candidateGeneration !== generation) throw new Error('Retell rate store closed during connection');
        if (candidate.status !== 'ready') throw new Error('Retell rate store did not become ready');
        active = candidate;
        circuitOpenUntil = 0;
        return candidate;
      } catch (error) {
        trip(candidate);
        throw error;
      } finally {
        connecting = null;
        connectingClient = null;
      }
    })();
    return connecting;
  }

  const store: RetellRateRedis = {
    async eval(script, numberOfKeys, ...args) {
      const client = await acquire();
      try {
        return await withRetellRateStoreDeadline(client.eval(script, numberOfKeys, ...args), deadlineMs);
      } catch (error) {
        trip(client);
        throw error;
      }
    },
  };

  return {
    store,
    close() {
      generation += 1;
      disconnect(active);
      disconnect(connectingClient);
      active = null;
      connectingClient = null;
      connecting = null;
      circuitOpenUntil = 0;
    },
  };
}

const singleton = createRetellRateStoreManager({
  createClient: () => {
    const client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      enableReadyCheck: true,
      maxRetriesPerRequest: 0,
      connectTimeout: 500,
      commandTimeout: 500,
      retryStrategy: () => null,
      reconnectOnError: () => false,
    });
    // Connection failures are surfaced through connect/EVAL promises and the
    // circuit breaker; attach a listener so IORedis never emits an unhandled
    // process-level `error` event.
    client.on('error', () => {});
    return client;
  },
});

export const retellRateStore = singleton.store;
export const closeRetellRateStore = singleton.close;
