import 'dotenv/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { providerConfig, providerValue, providerConfigured, __setProviderSnapshotForTests, PROVIDER_CATALOG } =
  await import('../lib/providerCredentials');
const { retellConfigStatus, retellCredentials } = await import('../lib/retell');

/**
 * The defect this closes: the Control Tower encrypted provider credentials into
 * PlatformIntegration and reported "connected - via db - test ok", while every
 * sender read process.env directly. An operator rotating a leaked Twilio token
 * saw a green badge and a passing connection test, and every message kept going
 * out on the compromised key.
 *
 * Precedence is now one rule, and these tests are that rule: a COMPLETE saved
 * credential beats the environment, an INCOMPLETE one never does.
 */
describe('provider credential precedence', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => { __setProviderSnapshotForTests({}); });
  afterEach(() => { process.env = { ...originalEnv }; __setProviderSnapshotForTests({}); });

  it('uses a complete saved credential over the environment', () => {
    __setProviderSnapshotForTests({
      sms: { accountSid: 'AC_saved', authToken: 'tok_saved', fromNumber: '+15550000001' },
    });
    const resolved = providerConfig('sms');
    expect(resolved.source).toBe('db');
    expect(resolved.values.authToken).toBe('tok_saved');
    expect(providerValue('sms', 'fromNumber')).toBe('+15550000001');
  });

  it('refuses to let a half-saved credential shadow working environment config', () => {
    // Saving one field of three must not take SMS offline.
    __setProviderSnapshotForTests({ sms: { accountSid: 'AC_saved' } });
    const resolved = providerConfig('sms');
    expect(resolved.source).not.toBe('db');
    expect(resolved.values.accountSid).not.toBe('AC_saved');
  });

  it('falls back to the environment when nothing is saved', () => {
    const resolved = providerConfig('voice');
    expect(resolved.source === 'env' || resolved.source === null).toBe(true);
  });

  it('reports a provider as unconfigured when neither plane has all of it', () => {
    __setProviderSnapshotForTests({ insurance: {} });
    expect(providerConfigured('insurance')).toBe(providerConfig('insurance').values.apiKey !== undefined);
  });

  it('routes the receptionist through the same rule, so the console and the calls agree', () => {
    __setProviderSnapshotForTests({
      voice: { apiKey: 'mock-saved-key', fromNumber: '+15550000009' },
    });
    const creds = retellCredentials();
    expect(creds.apiKey).toBe('mock-saved-key');
    expect(creds.fromNumber).toBe('+15550000009');
    expect(creds.source).toBe('db');

    const status = retellConfigStatus();
    expect(status.configured).toBe(true);
    // The saved key is a mock key, and the status must say so rather than
    // implying a live provider.
    expect(status.mock).toBe(true);
  });

  it('never lets a half-saved credential be reported as connected', () => {
    __setProviderSnapshotForTests({ voice: { apiKey: 'only-the-key' } });
    const resolved = providerConfig('voice');
    // Whichever plane answers, an incomplete credential set is not "connected".
    if (resolved.source === 'db') {
      expect(providerConfigured('voice')).toBe(false);
      expect(resolved.values.fromNumber).toBeUndefined();
    } else {
      // Complete environment configuration wins over a partial save, so the
      // product keeps working while the operator is mid-edit.
      expect(resolved.source).toBe('env');
      expect(resolved.values.apiKey).not.toBe('only-the-key');
    }
  });

  it('keeps one catalog for the console and the senders', () => {
    // A field the console can save but no sender reads is exactly how the vault
    // came to be wired to nothing.
    expect(Object.keys(PROVIDER_CATALOG).sort()).toEqual(
      ['email', 'insurance', 'payments', 'payments_webhook', 'sms', 'voice'],
    );
    for (const [key, def] of Object.entries(PROVIDER_CATALOG)) {
      expect(def.required.length, `${key} must declare required fields`).toBeGreaterThan(0);
      for (const required of def.required) {
        expect(def.fields.map(f => f.k), `${key}.${required} must be a declared field`).toContain(required);
        expect(def.env[required], `${key}.${required} must map to an env var`).toBeTruthy();
      }
    }
  });
});
