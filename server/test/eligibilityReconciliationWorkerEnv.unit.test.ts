import { afterEach, describe, expect, it, vi } from 'vitest';
import { envSchema } from '../config/env';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
  ELIGIBILITY_HMAC_SECRET: 'e'.repeat(32),
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('eligibility reconciliation worker configuration', () => {
  it('fails production closed when scanning is disabled', () => {
    const parsed = envSchema.safeParse({
      ...base,
      NODE_ENV: 'production',
      QUEUE_NAMESPACE: 'eligibility-production-a',
      ELIGIBILITY_RECONCILIATION_ENABLED: 'false',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['ELIGIBILITY_RECONCILIATION_ENABLED'] }),
      ]));
    }
  });

  it('does not upsert a scheduler when explicitly disabled in local/demo mode', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('QUEUES_ENABLED', 'false');
    vi.stubEnv('ELIGIBILITY_RECONCILIATION_ENABLED', 'false');
    vi.resetModules();
    const queues = await import('../workers/queues');
    const upsert = vi.spyOn(queues.eligibilityReconciliationQueue, 'upsertJobScheduler');

    await queues.registerEligibilityReconciliationSchedule();

    expect(upsert).not.toHaveBeenCalled();
    await queues.eligibilityReconciliationQueue.close();
  });
});
