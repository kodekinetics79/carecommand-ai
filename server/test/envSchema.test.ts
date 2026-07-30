import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { envSchema } from '../config/env';

// PORTAL_TOKEN_OUTBOX_PATH writes RAW patient magic-login tokens to disk (E2E
// delivery sink). In production that is a PHI/credential leak, so env parsing
// must fail closed at boot — unless the Playwright harness explicitly opts in
// with E2E_TEST_MODE=true (it serves the built app under NODE_ENV=production).
// Schema is exercised in isolation: envSchema.parse() is exactly what boot runs.

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
};

const productionProfile = {
  ...base,
  NODE_ENV: 'production' as const,
  PLATFORM_DATABASE_URL: 'postgresql://app_platform:pass@db.carecommand.example.com:5432/db',
  PUBLIC_API_URL: 'https://api.pilot.carecommand.example.com',
  CORS_ORIGINS: 'https://pilot.carecommand.example.com',
  COOKIE_SAMESITE: 'none' as const,
  METRICS_TOKEN: 'metrics-test-token',
};

describe('env schema — PORTAL_TOKEN_OUTBOX_PATH production guard', () => {
  it('rejects production + outbox path without the E2E escape hatch (boot fails closed)', () => {
    const res = envSchema.safeParse({ ...base, NODE_ENV: 'production', PORTAL_TOKEN_OUTBOX_PATH: '.playwright/portal-outbox.jsonl' });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find(i => i.path.includes('PORTAL_TOKEN_OUTBOX_PATH'));
      expect(issue?.message).toContain('must not be set when NODE_ENV=production');
    }
  });

  it('accepts production + outbox path when E2E_TEST_MODE=true (Playwright harness)', () => {
    const res = envSchema.safeParse({ ...base, NODE_ENV: 'production', PORTAL_TOKEN_OUTBOX_PATH: '.playwright/portal-outbox.jsonl', E2E_TEST_MODE: 'true' });
    expect(res.success).toBe(true);
  });

  it('E2E_TEST_MODE follows booleanString semantics — the string "false" does NOT unlock the outbox', () => {
    // z.coerce.boolean would turn "false" into true; booleanString must not.
    const res = envSchema.safeParse({ ...base, NODE_ENV: 'production', PORTAL_TOKEN_OUTBOX_PATH: '/tmp/outbox.jsonl', E2E_TEST_MODE: 'false' });
    expect(res.success).toBe(false);
  });

  it('accepts the outbox path outside production without any flag (dev/test sink)', () => {
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'development', PORTAL_TOKEN_OUTBOX_PATH: '/tmp/outbox.jsonl' }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'test', PORTAL_TOKEN_OUTBOX_PATH: '/tmp/outbox.jsonl' }).success).toBe(true);
  });

  it('production without the outbox path parses fine (no flag needed)', () => {
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'production' }).success).toBe(true);
  });
});

// Deployment-profile integration gate (docs/INTEGRATION_MODE_REGISTER.md).
// Providers default to mock, so a bare env under 'pilot'/'enterprise' MUST
// fail boot: an enterprise-validation environment can never silently run on
// mocks. The gate keys on DEPLOYMENT_PROFILE, never NODE_ENV — the E2E harness
// runs NODE_ENV=production under the default 'demo' profile.

describe('env schema — DEPLOYMENT_PROFILE integration-mode gate', () => {
  it('demo profile (default) boots with all providers mock — including under NODE_ENV=production (E2E harness)', () => {
    expect(envSchema.safeParse({ ...base }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'production' }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'demo' }).success).toBe(true);
  });

  it('pilot + mock payments without acknowledgement → boot fails naming integration, profile, and fix', () => {
    const res = envSchema.safeParse({ ...productionProfile, DEPLOYMENT_PROFILE: 'pilot' });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find(i => i.path.includes('PAYMENT_PROVIDER'));
      expect(issue?.message).toContain('payments');
      expect(issue?.message).toContain('DEPLOYMENT_PROFILE=pilot');
      expect(issue?.message).toContain('ALLOWED_MOCK_INTEGRATIONS');
    }
  });

  it('pilot flags EVERY unacknowledged mock (payments, insurance, ai each named)', () => {
    const res = envSchema.safeParse({ ...productionProfile, DEPLOYMENT_PROFILE: 'pilot' });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map(i => i.path[0]);
      expect(paths).toContain('PAYMENT_PROVIDER');
      expect(paths).toContain('INSURANCE_PROVIDER');
      expect(paths).toContain('AI_PROVIDER');
    }
  });

  it('pilot + mocks accepted when each is explicitly acknowledged (trim + case-insensitive tokens)', () => {
    expect(envSchema.safeParse({
      ...productionProfile, DEPLOYMENT_PROFILE: 'pilot',
      ALLOWED_MOCK_INTEGRATIONS: 'payments,insurance,ai',
    }).success).toBe(true);
    expect(envSchema.safeParse({
      ...productionProfile, DEPLOYMENT_PROFILE: 'pilot',
      ALLOWED_MOCK_INTEGRATIONS: ' Payments , INSURANCE , ai ',
    }).success).toBe(true);
  });

  it('pilot acknowledgement is per-integration — acking ai/insurance does not cover payments', () => {
    const res = envSchema.safeParse({
      ...productionProfile, DEPLOYMENT_PROFILE: 'pilot',
      ALLOWED_MOCK_INTEGRATIONS: 'ai,insurance',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some(i => i.path.includes('PAYMENT_PROVIDER'))).toBe(true);
      expect(res.error.issues.some(i => i.path.includes('AI_PROVIDER'))).toBe(false);
      expect(res.error.issues.some(i => i.path.includes('INSURANCE_PROVIDER'))).toBe(false);
    }
  });

  it('pilot with real providers boots without any acknowledgement', () => {
    expect(envSchema.safeParse({
      ...productionProfile, DEPLOYMENT_PROFILE: 'pilot',
      PAYMENT_PROVIDER: 'stripe', INSURANCE_PROVIDER: 'stedi', AI_PROVIDER: 'claude',
      STRIPE_SECRET_KEY: 'sk_test_profile', STRIPE_WEBHOOK_SECRET: 'whsec_profile',
      STRIPE_SUCCESS_URL: 'https://pilot.carecommand.example.com/revenue-protection?payment=success',
      STRIPE_CANCEL_URL: 'https://pilot.carecommand.example.com/revenue-protection?payment=cancel',
      CLAUDE_API_KEY: 'claude-test-key',
    }).success).toBe(true);
  });

  it('enterprise + mock payments is rejected EVEN WITH acknowledgement (money path)', () => {
    const res = envSchema.safeParse({
      ...productionProfile, DEPLOYMENT_PROFILE: 'enterprise',
      ALLOWED_MOCK_INTEGRATIONS: 'payments,insurance,ai',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find(i => i.path.includes('PAYMENT_PROVIDER'));
      expect(issue?.message).toContain('enterprise');
      expect(issue?.message).toContain('mock payments');
    }
  });

  it('enterprise boots with real payments + acknowledged mock ai/insurance', () => {
    expect(envSchema.safeParse({
      ...productionProfile, DEPLOYMENT_PROFILE: 'enterprise',
      PAYMENT_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_profile', STRIPE_WEBHOOK_SECRET: 'whsec_profile',
      STRIPE_SUCCESS_URL: 'https://pilot.carecommand.example.com/revenue-protection?payment=success',
      STRIPE_CANCEL_URL: 'https://pilot.carecommand.example.com/revenue-protection?payment=cancel',
      ALLOWED_MOCK_INTEGRATIONS: 'insurance,ai',
    }).success).toBe(true);
  });

  it('unknown acknowledgement tokens fail boot in every profile (a typo must not silently ack nothing)', () => {
    const res = envSchema.safeParse({ ...base, ALLOWED_MOCK_INTEGRATIONS: 'payment' }); // typo: "payment"
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find(i => i.path.includes('ALLOWED_MOCK_INTEGRATIONS'));
      expect(issue?.message).toContain('unknown integration "payment"');
    }
  });

  it('pilot fails closed when its operational posture is development, loopback, unmonitored, or missing the platform plane', () => {
    const res = envSchema.safeParse({
      ...base,
      DEPLOYMENT_PROFILE: 'pilot',
      ALLOWED_MOCK_INTEGRATIONS: 'payments,insurance,ai',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map(issue => issue.path[0]);
      expect(paths).toContain('NODE_ENV');
      expect(paths).toContain('PLATFORM_DATABASE_URL');
      expect(paths).toContain('PUBLIC_API_URL');
      expect(paths).toContain('CORS_ORIGINS');
      expect(paths).toContain('METRICS_TOKEN');
      expect(paths).toContain('COOKIE_SAMESITE');
    }
  });

  it('pilot accepts an explicitly acknowledged synthetic provider posture only when operational controls are present', () => {
    expect(envSchema.safeParse({
      ...productionProfile,
      DEPLOYMENT_PROFILE: 'pilot',
      ALLOWED_MOCK_INTEGRATIONS: 'payments,insurance,ai',
    }).success).toBe(true);
  });

  it('selected live providers fail boot when their required credentials or public redirect URLs are absent', () => {
    const res = envSchema.safeParse({
      ...productionProfile,
      DEPLOYMENT_PROFILE: 'pilot',
      PAYMENT_PROVIDER: 'stripe',
      INSURANCE_PROVIDER: 'stedi',
      AI_PROVIDER: 'openai',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const paths = res.error.issues.map(issue => issue.path[0]);
      expect(paths).toContain('STRIPE_SECRET_KEY');
      expect(paths).toContain('STRIPE_WEBHOOK_SECRET');
      expect(paths).toContain('STRIPE_SUCCESS_URL');
      expect(paths).toContain('STRIPE_CANCEL_URL');
      expect(paths).toContain('OPENAI_API_KEY');
    }
  });

  it('rejects disguised loopback, private IP, credentials, paths, queries, and reserved development domains', () => {
    const invalidPairs = [
      { PUBLIC_API_URL: 'https://localhost.' },
      { PUBLIC_API_URL: 'https://service.localhost' },
      { PUBLIC_API_URL: 'https://10.0.0.1' },
      { PUBLIC_API_URL: 'https://user:pass@api.carecommand.example.com' },
      { CORS_ORIGINS: 'https://10.0.0.1/path' },
      { CORS_ORIGINS: 'https://pilot.carecommand.example.com/path' },
      { CORS_ORIGINS: 'https://pilot.example.test' },
      { CORS_ORIGINS: 'https://pilot.carecommand.example.com?tenant=x' },
    ];
    for (const invalid of invalidPairs) {
      const res = envSchema.safeParse({
        ...productionProfile,
        DEPLOYMENT_PROFILE: 'pilot',
        ALLOWED_MOCK_INTEGRATIONS: 'payments,insurance,ai',
        ...invalid,
      });
      expect(res.success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it('allows public HTTPS Stripe redirect paths and query state but rejects private redirect hosts', () => {
    const valid = envSchema.safeParse({
      ...productionProfile,
      DEPLOYMENT_PROFILE: 'pilot',
      PAYMENT_PROVIDER: 'stripe',
      INSURANCE_PROVIDER: 'mock',
      AI_PROVIDER: 'mock',
      ALLOWED_MOCK_INTEGRATIONS: 'insurance,ai',
      STRIPE_SECRET_KEY: 'sk_test_profile',
      STRIPE_WEBHOOK_SECRET: 'whsec_profile',
      STRIPE_SUCCESS_URL: 'https://pilot.carecommand.example.com/revenue-protection?payment=success',
      STRIPE_CANCEL_URL: 'https://pilot.carecommand.example.com/revenue-protection?payment=cancel',
    });
    expect(valid.success).toBe(true);

    const invalid = envSchema.safeParse({
      ...productionProfile,
      DEPLOYMENT_PROFILE: 'pilot',
      PAYMENT_PROVIDER: 'stripe',
      INSURANCE_PROVIDER: 'mock',
      AI_PROVIDER: 'mock',
      ALLOWED_MOCK_INTEGRATIONS: 'insurance,ai',
      STRIPE_SECRET_KEY: 'sk_test_profile',
      STRIPE_WEBHOOK_SECRET: 'whsec_profile',
      STRIPE_SUCCESS_URL: 'https://127.0.0.1/revenue-protection?payment=success',
      STRIPE_CANCEL_URL: 'https://pilot.carecommand.example.com/revenue-protection?payment=cancel',
    });
    expect(invalid.success).toBe(false);
  });
});
