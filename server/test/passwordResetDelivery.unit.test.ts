import 'dotenv/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { env } = await import('../config/env');
const { __setProviderSnapshotForTests } = await import('../lib/providerCredentials');
const { deliverPasswordReset, passwordResetDeliveryConfigured } = await import('../lib/passwordResetDelivery');

const original = {
  NODE_ENV: env.NODE_ENV,
  PUBLIC_APP_URL: env.PUBLIC_APP_URL,
  EMAIL_HTTP_PROVIDER: env.EMAIL_HTTP_PROVIDER,
};

describe('password reset delivery', () => {
  beforeEach(() => {
    Object.assign(env, { NODE_ENV: 'production', PUBLIC_APP_URL: 'https://carecommand.example.com', EMAIL_HTTP_PROVIDER: 'generic' });
    __setProviderSnapshotForTests({
      email: { provider: 'generic', apiUrl: 'https://mail.example.test/send', apiKey: 'test-key', fromAddress: 'security@carecommand.example.test' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(env, original);
    __setProviderSnapshotForTests({});
  });

  it('sends a fragment credential with a provider idempotency key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'message-1' }), { status: 202, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverPasswordReset({
      email: 'owner@bright.example', tenantName: 'Bright Health LLC', token: 'a'.repeat(43), deliveryId: 'delivery-1',
    });

    expect(result).toMatchObject({ ok: true, status: 'sent', providerMessageId: 'message-1' });
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ 'Idempotency-Key': 'password-reset-delivery-1' });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.text).toContain('/login#reset=');
    expect(body.text).toContain('a'.repeat(43));
    expect(body.text).not.toContain('?token=');
  });

  it('uses the documented SendGrid contract and accepts only HTTP 202', async () => {
    __setProviderSnapshotForTests({
      email: { provider: 'sendgrid', apiUrl: 'https://api.sendgrid.com/v3/mail/send', apiKey: 'test-key', fromAddress: 'security@carecommand.example.test' },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202, headers: { 'x-message-id': 'sg-message-1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverPasswordReset({ email: 'owner@bright.example', tenantName: 'Bright Health LLC', token: 'b'.repeat(43), deliveryId: 'delivery-2' });
    expect(result).toMatchObject({ ok: true, providerMessageId: 'sg-message-1' });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.personalizations[0].to[0].email).toBe('owner@bright.example');
    expect(body.content[0].type).toBe('text/plain');
  });

  it('fails closed for partial provider configuration or an unsafe production app URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    __setProviderSnapshotForTests({ email: { apiUrl: 'https://mail.example.test/send', apiKey: 'test-key' } });
    expect(passwordResetDeliveryConfigured()).toBe(false);
    expect((await deliverPasswordReset({ email: 'owner@bright.example', tenantName: 'Bright Health LLC', token: 'c'.repeat(43), deliveryId: 'delivery-3' })).ok).toBe(false);

    __setProviderSnapshotForTests({ email: { apiUrl: 'https://mail.example.test/send', apiKey: 'test-key', fromAddress: 'security@carecommand.example.test' } });
    Object.assign(env, { PUBLIC_APP_URL: 'http://localhost:12000' });
    expect(passwordResetDeliveryConfigured()).toBe(false);
    expect((await deliverPasswordReset({ email: 'owner@bright.example', tenantName: 'Bright Health LLC', token: 'd'.repeat(43), deliveryId: 'delivery-4' })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
