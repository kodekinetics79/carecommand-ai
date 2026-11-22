import Redis from 'ioredis';
import { assertProductionRateLimitStore } from './rateLimitPolicy';

// A serverless cold start may need a DNS lookup plus a full TLS handshake to a
// regional managed Redis service. 1.5s was below the observed provider cold
// connection time and made a healthy store look absent, taking the API down.
// Keep the bounds finite, but allow enough room for that first connection.
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2_000;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 1_000;
const DEFAULT_STARTUP_ATTEMPTS = 3;
const DEFAULT_STARTUP_RETRY_DELAY_MS = 125;

type RateLimitCommandDefinition = {
  numberOfKeys: number;
  lua: string;
};

type RateLimitResult = [number, number];
type RateLimitCallback = (error: Error | null, result?: RateLimitResult) => void;

export interface ApiRateLimitClient {
  status: string;
  lastConnectionError?: Error;
  connect(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
  ping(): Promise<string>;
  defineCommand(name: string, definition: RateLimitCommandDefinition): void;
  rateLimit?: (
    key: string,
    timeWindow: number,
    max: number,
    continueExceeding: boolean,
    exponentialBackoff: boolean,
  ) => Promise<RateLimitResult>;
}

export interface ApiRateLimitRedis {
  defineCommand(name: string, definition: RateLimitCommandDefinition): void;
  rateLimit(
    key: string,
    timeWindow: number,
    max: number,
    continueExceeding: boolean,
    exponentialBackoff: boolean,
    callback: RateLimitCallback,
  ): void;
  rateLimit(
    key: string,
    timeWindow: number,
    max: number,
    continueExceeding: boolean,
    exponentialBackoff: boolean,
  ): Promise<RateLimitResult>;
  ping(): Promise<string>;
  close(): void;
}

function createRedisClient(redisUrl: string): ApiRateLimitClient {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: 0,
    connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
    commandTimeout: DEFAULT_COMMAND_TIMEOUT_MS,
    // This manager owns recovery. A failed socket is discarded so a warm
    // serverless instance never remains bound to a permanently dead client.
    retryStrategy: () => null,
    reconnectOnError: () => false,
  });
  const apiClient = client as ApiRateLimitClient;
  // ioredis can reject connect() with only "Connection is closed" after first
  // emitting the useful socket/TLS/authentication error. Preserve that first
  // error for diagnosis while still preventing an unhandled EventEmitter error.
  client.on('error', error => {
    apiClient.lastConnectionError = error instanceof Error
      ? error
      : new Error('Redis connection failed');
  });
  return apiClient;
}

async function within<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createApiRateLimitStoreManager(input: {
  createClient: () => ApiRateLimitClient;
  now?: () => number;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  circuitCooldownMs?: number;
}) {
  const now = input.now ?? Date.now;
  const connectTimeoutMs = input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const commandTimeoutMs = input.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const circuitCooldownMs = input.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
  let active: ApiRateLimitClient | null = null;
  let connectingClient: ApiRateLimitClient | null = null;
  let connecting: Promise<ApiRateLimitClient> | null = null;
  let circuitOpenUntil = 0;
  let generation = 0;
  let commandDefinition: RateLimitCommandDefinition | null = null;

  function disconnect(client: ApiRateLimitClient | null) {
    if (!client) return;
    try { client.disconnect(false); } catch { /* already closed */ }
  }

  function trip(client: ApiRateLimitClient | null) {
    disconnect(client);
    if (active === client) active = null;
    circuitOpenUntil = now() + circuitCooldownMs;
  }

  function installCommand(client: ApiRateLimitClient) {
    if (!commandDefinition) return;
    client.defineCommand('rateLimit', commandDefinition);
    if (typeof client.rateLimit !== 'function') {
      throw new Error('rate-limit Redis client did not install the rateLimit command');
    }
  }

  async function acquire(): Promise<ApiRateLimitClient> {
    if (active?.status === 'ready') return active;
    if (active) trip(active);
    if (now() < circuitOpenUntil) throw new Error('API rate-limit Redis circuit open');
    if (connecting) return connecting;

    const candidate = input.createClient();
    const candidateGeneration = generation;
    connectingClient = candidate;
    connecting = (async () => {
      try {
        await within(
          candidate.connect().then(() => undefined),
          connectTimeoutMs,
          'API rate-limit Redis connection timed out',
        );
        if (candidateGeneration !== generation) throw new Error('API rate-limit Redis closed during connection');
        if (candidate.status !== 'ready') throw new Error('API rate-limit Redis did not become ready');
        installCommand(candidate);
        active = candidate;
        circuitOpenUntil = 0;
        return candidate;
      } catch (error) {
        const operationalError = candidate.lastConnectionError ?? error;
        trip(candidate);
        throw operationalError;
      } finally {
        connecting = null;
        connectingClient = null;
      }
    })();
    return connecting;
  }

  async function run<T>(operation: (client: ApiRateLimitClient) => Promise<T>): Promise<T> {
    const client = await acquire();
    try {
      return await within(operation(client), commandTimeoutMs, 'API rate-limit Redis command timed out');
    } catch (error) {
      trip(client);
      throw error;
    }
  }

  const executeRateLimit = (
    key: string,
    timeWindow: number,
    max: number,
    continueExceeding: boolean,
    exponentialBackoff: boolean,
    callback?: RateLimitCallback,
  ): Promise<RateLimitResult> | void => {
    const operation = run(client => {
      if (typeof client.rateLimit !== 'function') {
        throw new Error('rate-limit Redis command is not installed');
      }
      return client.rateLimit(key, timeWindow, max, continueExceeding, exponentialBackoff);
    });
    if (callback) {
      void operation.then(
        result => callback(null, result),
        error => callback(error instanceof Error ? error : new Error('rate-limit Redis command failed')),
      );
      return;
    }
    return operation;
  };

  const store = {
    defineCommand(name: string, definition: RateLimitCommandDefinition) {
      if (name !== 'rateLimit') throw new Error(`Unsupported Redis command: ${name}`);
      commandDefinition = definition;
      // Match ioredis: defineCommand dynamically installs the named command.
      // @fastify/rate-limit checks for this property before defining its Lua
      // script, so it must not exist on the wrapper until this call occurs.
      (store as unknown as { rateLimit: typeof executeRateLimit }).rateLimit = executeRateLimit;
      if (active?.status === 'ready') installCommand(active);
    },
    ping() {
      return run(client => client.ping());
    },
    close() {
      generation += 1;
      disconnect(active);
      disconnect(connectingClient);
      active = null;
      connectingClient = null;
      connecting = null;
      circuitOpenUntil = 0;
    },
  } as ApiRateLimitRedis;

  return { store, connect: acquire, close: store.close };
}

export async function acquireApiRateLimitStore(input: {
  nodeEnv: string;
  redisUrl: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  startupAttempts?: number;
  startupRetryDelayMs?: number;
  createClient?: (redisUrl: string) => ApiRateLimitClient;
}): Promise<ApiRateLimitRedis | undefined> {
  const attempts = input.startupAttempts
    ?? (input.nodeEnv === 'production' ? DEFAULT_STARTUP_ATTEMPTS : 1);
  const retryDelayMs = input.startupRetryDelayMs ?? DEFAULT_STARTUP_RETRY_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const manager = createApiRateLimitStoreManager({
      createClient: () => (input.createClient ?? createRedisClient)(input.redisUrl),
      connectTimeoutMs: input.connectTimeoutMs,
      commandTimeoutMs: input.commandTimeoutMs,
    });
    try {
      await manager.connect();
      return manager.store;
    } catch (error) {
      manager.close();
      lastError = error;
      const message = error instanceof Error ? error.message : '';
      const retryable = /EBUSY|EAI_AGAIN|ETIMEDOUT|ECONNRESET|Connection is closed|socket hang up/i.test(message);
      if (attempt < attempts && retryable) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }
      break;
    }
  }

  if (input.nodeEnv === 'production') {
    const message = lastError instanceof Error ? lastError.message : '';
    const reason = message.includes('connection timed out')
      ? 'connect_timeout'
      : /ECONNREFUSED/i.test(message)
        ? 'connection_refused'
        : /ETIMEDOUT/i.test(message)
          ? 'connect_timeout'
          : message.includes('did not become ready')
            ? 'not_ready'
            : message.includes('Connection is closed')
              ? 'connection_closed'
              : /WRONGPASS|NOAUTH|authentication/i.test(message)
                ? 'authentication_failed'
                : /ENOTFOUND|EAI_AGAIN|EBUSY/i.test(message)
                  ? 'dns_failed'
                  : /certificate|TLS|SSL/i.test(message)
                    ? 'tls_failed'
                    : 'connection_failed';
    throw new Error(`RateLimit: distributed store is required in production (${reason})`, { cause: lastError });
  }
  assertProductionRateLimitStore(input.nodeEnv, undefined);
  return undefined;
}
