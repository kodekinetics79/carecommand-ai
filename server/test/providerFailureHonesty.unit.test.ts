import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../config/env';
import { createPaymentProvider, ProviderOperationError, StripePaymentProvider } from '../modules/revenue-protection';

const original = {
  provider: env.PAYMENT_PROVIDER,
  secret: env.STRIPE_SECRET_KEY,
};

const request = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  branchId: '33333333-3333-4333-8333-333333333333',
  amount: 45.5,
  reason: 'Synthetic provider failure test',
};

afterEach(() => {
  Object.assign(env, { PAYMENT_PROVIDER: original.provider, STRIPE_SECRET_KEY: original.secret });
  vi.unstubAllGlobals();
});

describe('provider failure honesty', () => {
  it('never converts a Stripe network failure into a mock success or localhost link', async () => {
    Object.assign(env, { PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_synthetic_not_a_real_secret' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('synthetic network failure'); }));
    const provider = new StripePaymentProvider();

    await expect(provider.createPaymentRequest(request)).rejects.toEqual(expect.objectContaining({
      name: 'ProviderOperationError', provider: 'Stripe Payments',
    }));
    await expect(provider.createPaymentLink(request)).rejects.toBeInstanceOf(ProviderOperationError);
  });

  it('never silently substitutes mock payments for an unconfigured selected provider', async () => {
    Object.assign(env, { PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: undefined });
    const provider = createPaymentProvider();
    await expect(provider.createPaymentRequest(request)).rejects.toBeInstanceOf(ProviderOperationError);
  });
});
