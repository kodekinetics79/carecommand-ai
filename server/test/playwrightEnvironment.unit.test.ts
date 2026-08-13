import { describe, expect, it } from 'vitest';
import { buildPlaywrightEnvironment } from '../scripts/playwrightEnvironment';

const ENTROPY = 'a'.repeat(64);

describe('guarded Playwright environment', () => {
  it('creates isolated per-run values only inside a disposable database context', () => {
    const result = buildPlaywrightEnvironment({ RLS_DISPOSABLE_DB: 'carecommand_rls_behavior_test' }, ENTROPY);

    expect(result.QUEUE_NAMESPACE).toBe(`carecommand-e2e-${ENTROPY.slice(0, 24)}`);
    expect(result.ELIGIBILITY_HMAC_SECRET).toBe(ENTROPY);
    expect(() => buildPlaywrightEnvironment({}, ENTROPY)).toThrow(/guarded disposable database context/);
  });

  it('preserves valid explicit values and rejects unsafe test configuration', () => {
    const explicit = buildPlaywrightEnvironment({
      RLS_DISPOSABLE_DB: 'carecommand_rls_behavior_test',
      QUEUE_NAMESPACE: 'ci-run-123',
      ELIGIBILITY_HMAC_SECRET: 'e'.repeat(32),
    }, ENTROPY);

    expect(explicit.QUEUE_NAMESPACE).toBe('ci-run-123');
    expect(explicit.ELIGIBILITY_HMAC_SECRET).toBe('e'.repeat(32));
    expect(() => buildPlaywrightEnvironment({
      RLS_DISPOSABLE_DB: 'carecommand_rls_behavior_test',
      QUEUE_NAMESPACE: 'carecommand-local',
    }, ENTROPY)).toThrow(/isolated from the local default/);
  });
});
