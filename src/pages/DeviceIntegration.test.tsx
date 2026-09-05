import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
const sessionRole = vi.hoisted(() => ({ value: 'OWNER' }));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

vi.mock('../hooks/useSession', () => ({
  useSession: () => ({
    user: {
      id: 'user-1', email: 'owner@bright-health.test', role: sessionRole.value, displayName: 'Bright Health Owner', active: true,
      tenant: { id: 'tenant-1', name: 'Bright Health LLC', slug: 'bright-health' },
    },
  }),
}));

import DeviceIntegration from './DeviceIntegration';

const OVERVIEW = {
  summary: { total: 0, reporting: 0, stale: 0, neverReported: 0, error: 0 },
  devices: [], branches: [{ id: 'branch-1', name: 'Arlington Clinic' }],
};

function provider(overrides: Record<string, unknown> = {}) {
  return {
    key: 'withings', displayName: 'Withings', category: 'DIRECT_API', supportsSandbox: true, supportsWebhook: true,
    note: 'BP / weight / sleep. OAuth sandbox and a signed webhook secret are required before enrolment.',
    configFields: [
      { key: 'clientId', label: 'Client ID', secret: false, required: true },
      { key: 'clientSecret', label: 'Client secret', secret: true, required: true },
      { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, required: true },
    ],
    status: 'NOT_CONFIGURED', mode: 'sandbox', configured: false, webhookConfigured: false,
    lastHealthCheckAt: null, lastHealthStatus: null, healthMessage: null, lastSyncAt: null,
    healthVerdictStale: null, healthVerdictTtlHours: 24,
    ...overrides,
  };
}

function renderPage() {
  return render(<MemoryRouter><DeviceIntegration /></MemoryRouter>);
}

beforeEach(() => {
  sessionRole.value = 'OWNER';
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/v1/devices/overview') return OVERVIEW;
    if (path === '/v1/devices/providers') return [provider()];
    if (path === '/v1/devices/providers/withings/configure' && init?.method === 'POST') {
      return { providerKey: 'withings', mode: 'sandbox', status: 'SANDBOX', webhookConfigured: true };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

describe('Device Integration provider activation and role integrity', () => {
  it('lets an owner save the complete signed sandbox setup without claiming vendor reachability', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Withings Client ID' }), { target: { value: 'synthetic-client' } });
    fireEvent.change(screen.getByLabelText('Withings Client secret'), { target: { value: 'synthetic-secret' } });
    fireEvent.change(screen.getByLabelText('Withings Webhook signing secret'), { target: { value: 'whsec-synthetic' } });
    expect(screen.getByText(/Saving proves only local setup and signed-webhook readiness/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/devices/providers/withings/configure', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'sandbox',
        config: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', webhookSecret: 'whsec-synthetic' },
      }),
    }));
    expect(await screen.findByText(/Signed intake is ready for enrollment; vendor reachability is still unverified/)).toBeInTheDocument();
  });

  it('keeps provider users read-only and removes every server-refused mutation', async () => {
    sessionRole.value = 'PROVIDER';
    renderPage();

    expect(await screen.findByText('Withings')).toBeInTheDocument();
    expect(screen.getByText(/Read-only device registry/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register device' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace setup' })).not.toBeInTheDocument();
  });

  it('labels stored credentials without webhook proof as incomplete rather than ready', async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === '/v1/devices/overview') return OVERVIEW;
      if (path === '/v1/devices/providers') return [provider({ configured: true, status: 'SANDBOX', webhookConfigured: false })];
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage();

    expect(await screen.findByText('Webhook incomplete')).toBeInTheDocument();
    expect(screen.queryByText('Signed intake ready')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace setup' })).toBeInTheDocument();
  });
});
