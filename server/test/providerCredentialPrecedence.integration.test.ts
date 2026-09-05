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

const { providerConfig, providerValue, providerConfigured, resolveCredentialPrecedence, __setProviderSnapshotForTests, PROVIDER_CATALOG } =
  await import('../lib/providerCredentials');
const { retellConfigStatus, retellCredentials } = await import('../lib/retell');
const { channelStatus, providerModeFor } = await import('../lib/campaigns');

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

  it('uses the same saved SMS credential for readiness that the sender uses', () => {
    __setProviderSnapshotForTests({
      sms: { accountSid: 'AC_saved', authToken: 'tok_saved', fromNumber: '+15550000001' },
    });
    expect(channelStatus('sms')).toMatchObject({ configured: true, setupRequired: false, provider: 'twilio' });
    expect(providerModeFor('sms')).toBe('live_supported');
  });

  it('recognizes the configured HTTP email provider without requiring unused SMTP fields', () => {
    __setProviderSnapshotForTests({
      email: { apiUrl: 'https://mail.example.test/send', apiKey: 'saved-email-key', fromAddress: 'clinic@example.test' },
    });
    expect(channelStatus('email')).toMatchObject({ configured: true, setupRequired: false, provider: 'http-email' });
    expect(providerModeFor('email')).toBe('live_supported');
  });

  /**
   * The rule, asserted against explicit inputs.
   *
   * These used to go through providerConfig, which reads whatever provider
   * credentials happen to be in the ambient environment - so they passed on a
   * laptop with a populated .env and failed in CI, which has none. A test that
   * reports which machine ran it is worse than no test.
   */
  describe('the precedence rule, independent of any machine', () => {
    const COMPLETE_ENV = { accountSid: 'AC_env', authToken: 'tok_env', fromNumber: '+15550000002' };

    it('prefers a complete saved credential over complete environment config', () => {
      const resolved = resolveCredentialPrecedence('sms', { accountSid: 'AC_saved', authToken: 'tok_saved', fromNumber: '+15550000001' }, COMPLETE_ENV);
      expect(resolved).toMatchObject({ source: 'db' });
      expect(resolved.values.authToken).toBe('tok_saved');
    });

    it('refuses to let a half-saved credential shadow working environment config', () => {
      // Saving one field of three must not take SMS offline mid-edit.
      const resolved = resolveCredentialPrecedence('sms', { accountSid: 'AC_saved' }, COMPLETE_ENV);
      expect(resolved.source).toBe('env');
      expect(resolved.values.accountSid).toBe('AC_env');
    });

    it('falls back to the environment when nothing is saved', () => {
      expect(resolveCredentialPrecedence('sms', undefined, COMPLETE_ENV)).toMatchObject({ source: 'env' });
    });

    it('reports a partial save when there is no environment to fall back to', () => {
      // Worth reporting rather than pretending nothing is set: the console
      // shows it, and providerConfigured still says it is not usable.
      const resolved = resolveCredentialPrecedence('sms', { accountSid: 'AC_saved' }, {});
      expect(resolved).toMatchObject({ source: 'db' });
      expect(resolved.values.fromNumber).toBeUndefined();
    });

    it('reports nothing configured when neither plane has anything', () => {
      expect(resolveCredentialPrecedence('sms', undefined, {})).toEqual({ values: {}, source: null });
    });
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

  it('never reports a half-saved credential as connected, on any machine', () => {
    // The wiring test stays tolerant of the ambient environment on purpose: the
    // rule is pinned above with explicit inputs, and what matters here is that
    // an incomplete credential is never called configured either way.
    __setProviderSnapshotForTests({ voice: { apiKey: 'only-the-key' } });
    const resolved = providerConfig('voice');
    if (resolved.source === 'db') expect(providerConfigured('voice')).toBe(false);
    else expect(resolved.values.apiKey).not.toBe('only-the-key');
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
