import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientAppointments } from './ClientSections';
import { getPortalToken, portalClient, setPortalToken } from '../../lib/portalClient';

vi.mock('../../lib/portalClient', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/portalClient')>();
  return { ...actual, portalClient: { ...actual.portalClient, appointments: vi.fn() } };
});

afterEach(() => {
  setPortalToken(null);
  vi.restoreAllMocks();
});

describe('patient portal appointment navigation', () => {
  it('uses SPA navigation from the empty state and preserves the memory-only portal session', async () => {
    vi.mocked(portalClient.appointments).mockResolvedValue({ upcoming: [], past: [] });
    setPortalToken('short-lived-portal-session');

    render(
      <MemoryRouter initialEntries={['/client/appointments']}>
        <Routes>
          <Route path="/client/appointments" element={<ClientAppointments />} />
          <Route path="/client/requests" element={<p>Appointment requests destination</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('No upcoming appointments')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Request appointment' }));

    expect(await screen.findByText('Appointment requests destination')).toBeInTheDocument();
    expect(getPortalToken()).toBe('short-lived-portal-session');
  });
});
