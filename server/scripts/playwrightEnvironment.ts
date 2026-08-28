import { randomBytes } from 'node:crypto';

const QUEUE_NAMESPACE_PATTERN = /^[A-Za-z0-9:_-]{1,80}$/;

export function buildPlaywrightEnvironment(
  source: NodeJS.ProcessEnv,
  entropy = randomBytes(32).toString('hex'),
): NodeJS.ProcessEnv {
  if (!source.RLS_DISPOSABLE_DB) {
    throw new Error('Playwright environment generation requires the guarded disposable database context.');
  }
  if (!/^[a-f0-9]{64}$/.test(entropy)) {
    throw new Error('Playwright environment entropy must be 32 bytes encoded as lowercase hexadecimal.');
  }

  const configuredNamespace = source.QUEUE_NAMESPACE?.trim();
  const queueNamespace = configuredNamespace || `carecommand-e2e-${entropy.slice(0, 24)}`;
  if (!QUEUE_NAMESPACE_PATTERN.test(queueNamespace) || queueNamespace === 'carecommand-local') {
    throw new Error('Playwright QUEUE_NAMESPACE must be explicit, safe, and isolated from the local default.');
  }

  const configuredEligibilitySecret = source.ELIGIBILITY_HMAC_SECRET?.trim();
  const eligibilitySecret = configuredEligibilitySecret || entropy;
  if (eligibilitySecret.length < 32) {
    throw new Error('Playwright ELIGIBILITY_HMAC_SECRET must contain at least 32 characters.');
  }

  return {
    ...source,
    QUEUE_NAMESPACE: queueNamespace,
    ELIGIBILITY_HMAC_SECRET: eligibilitySecret,
  };
}
