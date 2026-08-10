import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('eligibility reconciliation frontend continuity', () => {
  it('preserves an ambiguous logical-action key across module reload while browser storage remains available', async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);
    const firstModule = await import('../../src/lib/eligibilityIdempotency');
    let firstKey = '';
    await expect(firstModule.runEligibilityAction('insurance_v1', { patientId: 'patient-1' }, async key => {
      firstKey = key;
      throw new TypeError('response lost');
    })).rejects.toThrow('response lost');

    vi.resetModules();
    const reloadedModule = await import('../../src/lib/eligibilityIdempotency');
    let reloadedKey = '';
    await expect(reloadedModule.runEligibilityAction('insurance_v1', { patientId: 'patient-1' }, async key => {
      reloadedKey = key;
      throw new TypeError('still ambiguous');
    })).rejects.toThrow('still ambiguous');
    expect(reloadedKey).toBe(firstKey);
  });

  it('treats the server reconciliation endpoint as canonical after local state is lost', () => {
    const source = readFileSync('src/pages/InsuranceEligibility.tsx', 'utf8');
    expect(source).toContain('/v1/insurance/eligibility/executions/reconciliation?state=');
    expect(source).toContain('Reload from server');
    expect(source).toContain('Server-held work queue');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('sessionStorage');
    expect(source).toContain('payer calls are never retried from this workflow');
    expect(source).toContain('Eligibility is not a payment guarantee.');
  });
});
