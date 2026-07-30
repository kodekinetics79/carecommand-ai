import { createHash } from 'node:crypto';

export const RETELL_RATE_WINDOW_MS = 60_000;
export const RETELL_RATE_STORE_TIMEOUT_MS = 500;
export const RETELL_EVENT_PER_CALL_LIMIT = 20;
export const RETELL_TOOL_PER_CALL_LIMIT = 120;
export const RETELL_TENANT_CALLBACK_LIMIT = 12_000;
export const RETELL_INVALID_SIGNATURE_SOURCE_LIMIT = 60;

export interface RetellRateRedis {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

type CallbackKind = 'event' | 'tool';
type LocalCounter = { count: number; expiresAt: number };
const localCounters = new Map<string, LocalCounter>();

const RATE_SCRIPT = `
local tenant_count = redis.call('INCR', KEYS[1])
if tenant_count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local call_count = redis.call('INCR', KEYS[2])
if call_count == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
return { tenant_count, call_count }
`;

const INVALID_SIGNATURE_RATE_SCRIPT = `
local source_count = redis.call('INCR', KEYS[1])
if source_count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return source_count
`;

export async function withRetellRateStoreDeadline<T>(operation: Promise<T>, timeoutMs = RETELL_RATE_STORE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Retell rate store deadline exceeded')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function opaqueKey(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function pruneLocalCounters(nowMs: number) {
  for (const [candidate, counter] of localCounters) {
    if (counter.expiresAt <= nowMs) localCounters.delete(candidate);
  }
  // Development/test fallback only. Keep an absolute cap even when an attacker
  // generates only fresh unique keys and there is therefore nothing expired.
  while (localCounters.size >= 20_000) {
    const oldest = localCounters.keys().next().value as string | undefined;
    if (!oldest) break;
    localCounters.delete(oldest);
  }
}

function incrementLocal(key: string, nowMs: number) {
  pruneLocalCounters(nowMs);
  const existing = localCounters.get(key);
  if (!existing || existing.expiresAt <= nowMs) {
    localCounters.set(key, { count: 1, expiresAt: nowMs + RETELL_RATE_WINDOW_MS });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

export type VerifiedRetellRateResult =
  | { allowed: true; tenantCount: number; callCount: number }
  | { allowed: false; reason: 'tenant_limit' | 'call_limit' | 'store_unavailable' };

export async function enforceVerifiedRetellRateLimit(input: {
  tenantId: string;
  providerCallId: string;
  kind: CallbackKind;
  redis?: RetellRateRedis;
  production: boolean;
  nowMs?: number;
}): Promise<VerifiedRetellRateResult> {
  const nowMs = input.nowMs ?? Date.now();
  const tenantKey = `cc:retell:verified:${input.kind}:tenant:${opaqueKey(input.tenantId)}`;
  const callKey = `cc:retell:verified:${input.kind}:call:${opaqueKey(`${input.tenantId}:${input.providerCallId}`)}`;
  const callLimit = input.kind === 'event' ? RETELL_EVENT_PER_CALL_LIMIT : RETELL_TOOL_PER_CALL_LIMIT;
  let counts: [number, number];
  if (input.redis) {
    try {
      const raw = await withRetellRateStoreDeadline(input.redis.eval(RATE_SCRIPT, 2, tenantKey, callKey, RETELL_RATE_WINDOW_MS));
      if (!Array.isArray(raw) || raw.length !== 2) throw new Error('Unexpected Retell rate-store response');
      counts = [Number(raw[0]), Number(raw[1])];
      if (!counts.every(Number.isFinite)) throw new Error('Invalid Retell rate-store counters');
    } catch {
      if (input.production) return { allowed: false, reason: 'store_unavailable' };
      counts = [incrementLocal(tenantKey, nowMs), incrementLocal(callKey, nowMs)];
    }
  } else {
    if (input.production) return { allowed: false, reason: 'store_unavailable' };
    counts = [incrementLocal(tenantKey, nowMs), incrementLocal(callKey, nowMs)];
  }
  if (counts[0] > RETELL_TENANT_CALLBACK_LIMIT) return { allowed: false, reason: 'tenant_limit' };
  if (counts[1] > callLimit) return { allowed: false, reason: 'call_limit' };
  return { allowed: true, tenantCount: counts[0], callCount: counts[1] };
}

export type InvalidRetellSignatureRateResult =
  | { allowed: true; sourceCount: number }
  | { allowed: false; reason: 'source_limit' | 'store_unavailable' };

/**
 * Abuse bucket used only after HMAC verification fails. Valid Retell traffic
 * never consumes this source bucket, which is important because Retell shares
 * an egress IP across customers. `source` must be Fastify's resolved socket IP;
 * the app only honors forwarded headers from explicitly configured proxies.
 */
export async function enforceInvalidRetellSignatureRateLimit(input: {
  source: string;
  redis?: RetellRateRedis;
  production: boolean;
  nowMs?: number;
}): Promise<InvalidRetellSignatureRateResult> {
  const nowMs = input.nowMs ?? Date.now();
  const sourceKey = `cc:retell:invalid-signature:source:${opaqueKey(input.source)}`;
  let count: number;
  if (input.redis) {
    try {
      const raw = await withRetellRateStoreDeadline(input.redis.eval(INVALID_SIGNATURE_RATE_SCRIPT, 1, sourceKey, RETELL_RATE_WINDOW_MS));
      count = Number(raw);
      if (!Number.isFinite(count)) throw new Error('Invalid Retell invalid-signature counter');
    } catch {
      if (input.production) return { allowed: false, reason: 'store_unavailable' };
      count = incrementLocal(sourceKey, nowMs);
    }
  } else {
    if (input.production) return { allowed: false, reason: 'store_unavailable' };
    count = incrementLocal(sourceKey, nowMs);
  }
  if (count > RETELL_INVALID_SIGNATURE_SOURCE_LIMIT) return { allowed: false, reason: 'source_limit' };
  return { allowed: true, sourceCount: count };
}
