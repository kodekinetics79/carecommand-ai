export interface RedisPingable {
  ping(): Promise<string>;
}

async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkRateLimitRedis(client: RedisPingable | undefined): Promise<boolean> {
  try {
    if (!client) return false;
    return await withTimeout(client.ping(), 1000) === 'PONG';
  } catch {
    return false;
  }
}

export async function checkQueueRedis(input: {
  enabled: boolean;
  probe?: () => Promise<unknown>;
}): Promise<boolean> {
  if (!input.enabled) return true;
  try {
    if (!input.probe) return false;
    await withTimeout(input.probe(), 1000);
    return true;
  } catch {
    return false;
  }
}
