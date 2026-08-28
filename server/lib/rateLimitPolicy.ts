/**
 * Distributed rate limiting is an authentication control in production, not a
 * best-effort optimization. Refuse to start without the configured shared
 * store and propagate runtime store failures so privileged authentication
 * cannot silently degrade to per-instance or fail-open behavior.
 */
export function assertProductionRateLimitStore(nodeEnv: string, store: unknown): asserts store {
  if (nodeEnv === 'production' && !store) {
    throw new Error('RateLimit: distributed store is required in production');
  }
}

export function skipRateLimitStoreErrors(nodeEnv: string): boolean {
  return nodeEnv !== 'production';
}
