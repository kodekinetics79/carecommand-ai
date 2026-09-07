import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import type { SessionUser } from '../../lib/session';
import ServiceCatalogPanel from './ServiceCatalogPanel';

const service = {
  id: 'service-1', name: 'Pilot New Patient Visit', category: 'primary-care', defaultDurationMinutes: 30,
  defaultAppointmentValue: null, depositRuleId: null, active: true, spokenDescription: null,
  bookableByVoice: false, voiceDurationMinutes: null, priceFrom: null,
  createdAt: '2026-09-07T12:00:00.000Z', updatedAt: '2026-09-07T12:00:00.000Z',
};

const owner = { id: 'user-1', role: 'OWNER' } as SessionUser;

describe('ServiceCatalogPanel voice booking controls', () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
    apiRequestMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/services' && !init?.method) return Promise.resolve([service]);
      if (path === '/v1/services/service-1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve({ ...service, ...body });
      }
      return Promise.reject(new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`));
    });
  });

  it('lets an authorized clinic owner wire an offered service to AI voice booking', async () => {
    render(<ServiceCatalogPanel user={owner} />);

    expect(await screen.findByText('Staff only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable AI booking' }));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/services/service-1', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ bookableByVoice: true }),
    })));
    expect(await screen.findByText(/now bookable by the AI receptionist/)).toBeInTheDocument();
  });
});
