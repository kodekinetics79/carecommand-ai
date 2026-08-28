import 'dotenv/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/commsProvider', () => ({
  sendMessage: vi.fn(),
}));

const { sendMessage } = await import('../lib/commsProvider');
const { deliverPortalToken } = await import('../lib/portalDelivery');
const { env } = await import('../config/env');

const input = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  patientId: '10000000-0000-4000-8000-000000000002',
  accountId: '10000000-0000-4000-8000-000000000003',
  token: 'synthetic-test-token',
  email: 'patient@example.test',
  phone: null,
  purpose: 'request-link' as const,
};

describe('portal credential delivery is truthful and fail-closed', () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockReset();
    Object.assign(env, { PORTAL_TOKEN_OUTBOX_PATH: undefined });
  });

  it('preserves a provider failure instead of claiming the credential was sent', async () => {
    vi.mocked(sendMessage).mockResolvedValue({ ok: false, status: 'setup_required', mode: 'setup_required', failureReason: 'provider_not_configured' });
    await expect(deliverPortalToken(input)).resolves.toEqual(expect.objectContaining({ ok: false, status: 'setup_required', mode: 'setup_required' }));
  });

  it('converts an unexpected provider exception into an explicit failed result', async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error('synthetic provider fault'));
    await expect(deliverPortalToken(input)).resolves.toEqual({ ok: false, status: 'failed', mode: 'live', failureReason: 'portal_provider_exception' });
  });

  it('refuses delivery when no verified destination exists', async () => {
    await expect(deliverPortalToken({ ...input, email: null, phone: null })).resolves.toEqual(expect.objectContaining({ ok: false, status: 'setup_required', failureReason: 'portal_destination_missing' }));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
