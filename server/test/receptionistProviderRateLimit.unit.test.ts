import { describe, expect, it } from 'vitest';
import {
  enforceInvalidRetellSignatureRateLimit,
  enforceVerifiedRetellRateLimit,
  RETELL_EVENT_PER_CALL_LIMIT,
  RETELL_INVALID_SIGNATURE_SOURCE_LIMIT,
  RETELL_TENANT_CALLBACK_LIMIT,
  RETELL_TOOL_PER_CALL_LIMIT,
  type RetellRateRedis,
} from '../lib/receptionist/providerRateLimit';

class CounterRedis implements RetellRateRedis {
  readonly values = new Map<string, number>();
  readonly keySets: string[][] = [];
  fail = false;

  async eval(_script: string, numberOfKeys: number, ...args: Array<string | number>) {
    if (this.fail) throw new Error('redis down');
    const keys = args.slice(0, numberOfKeys).map(String);
    this.keySets.push(keys);
    const counts = keys.map(key => {
      const value = (this.values.get(key) ?? 0) + 1;
      this.values.set(key, value);
      return value;
    });
    return numberOfKeys === 1 ? counts[0] : counts;
  }
}

describe('verified Retell callback rate policy', () => {
  it('enforces exact event and tool per-call thresholds', async () => {
    const redis = new CounterRedis();
    for (let count = 1; count <= RETELL_EVENT_PER_CALL_LIMIT; count++) {
      expect(await enforceVerifiedRetellRateLimit({ tenantId: 'tenant-a', providerCallId: 'event-call', kind: 'event', redis, production: true })).toMatchObject({ allowed: true, callCount: count });
    }
    expect(await enforceVerifiedRetellRateLimit({ tenantId: 'tenant-a', providerCallId: 'event-call', kind: 'event', redis, production: true })).toEqual({ allowed: false, reason: 'call_limit' });

    for (let count = 1; count <= RETELL_TOOL_PER_CALL_LIMIT; count++) {
      expect((await enforceVerifiedRetellRateLimit({ tenantId: 'tenant-a', providerCallId: 'tool-call', kind: 'tool', redis, production: true })).allowed).toBe(true);
    }
    expect(await enforceVerifiedRetellRateLimit({ tenantId: 'tenant-a', providerCallId: 'tool-call', kind: 'tool', redis, production: true })).toEqual({ allowed: false, reason: 'call_limit' });
  });

  it('isolates opaque counters by tenant, call, and callback kind', async () => {
    const redis = new CounterRedis();
    const inputs = [
      { tenantId: 'tenant-a', providerCallId: 'call-a', kind: 'event' as const },
      { tenantId: 'tenant-a', providerCallId: 'call-b', kind: 'event' as const },
      { tenantId: 'tenant-b', providerCallId: 'call-a', kind: 'event' as const },
      { tenantId: 'tenant-a', providerCallId: 'call-a', kind: 'tool' as const },
    ];
    for (const input of inputs) {
      expect(await enforceVerifiedRetellRateLimit({ ...input, redis, production: true })).toMatchObject({ allowed: true, callCount: 1 });
    }
    const allKeys = redis.keySets.flat();
    expect(new Set(allKeys).size).toBe(7);
    expect(allKeys.join(' ')).not.toContain('tenant-a');
    expect(allKeys.join(' ')).not.toContain('call-a');
  });

  it('enforces tenant aggregate capacity and fails closed without a production store', async () => {
    const atLimit: RetellRateRedis = { eval: async () => [RETELL_TENANT_CALLBACK_LIMIT + 1, 1] };
    expect(await enforceVerifiedRetellRateLimit({ tenantId: 'tenant', providerCallId: 'call', kind: 'tool', redis: atLimit, production: true })).toEqual({ allowed: false, reason: 'tenant_limit' });
    expect(await enforceVerifiedRetellRateLimit({ tenantId: 'tenant', providerCallId: 'call', kind: 'tool', production: true })).toEqual({ allowed: false, reason: 'store_unavailable' });
    const failing = new CounterRedis();
    failing.fail = true;
    expect(await enforceVerifiedRetellRateLimit({ tenantId: 'tenant', providerCallId: 'call', kind: 'tool', redis: failing, production: true })).toEqual({ allowed: false, reason: 'store_unavailable' });
  });
});

describe('invalid Retell signature source policy', () => {
  it('uses a separate opaque source counter with an exact threshold', async () => {
    const redis = new CounterRedis();
    for (let count = 1; count <= RETELL_INVALID_SIGNATURE_SOURCE_LIMIT; count++) {
      expect(await enforceInvalidRetellSignatureRateLimit({ source: '192.0.2.10', redis, production: true })).toMatchObject({ allowed: true, sourceCount: count });
    }
    expect(await enforceInvalidRetellSignatureRateLimit({ source: '192.0.2.10', redis, production: true })).toEqual({ allowed: false, reason: 'source_limit' });
    expect(redis.keySets[0].join(' ')).not.toContain('192.0.2.10');
  });

  it('reports unavailable in production and permits bounded local fallback only outside production', async () => {
    expect(await enforceInvalidRetellSignatureRateLimit({ source: '192.0.2.11', production: true })).toEqual({ allowed: false, reason: 'store_unavailable' });
    expect(await enforceInvalidRetellSignatureRateLimit({ source: '192.0.2.11', production: false, nowMs: 1 })).toMatchObject({ allowed: true, sourceCount: 1 });
  });
});
