import { MemoryRouter } from 'react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import { receptionistFixtures } from '../../test/fixtures/receptionist';
import { AfterHoursCard } from './AfterHoursCard';

/**
 * The card this replaces was a placeholder that rendered zeros. A zero here is
 * a claim ("nobody called after hours"), and it must only be made from a
 * response that actually said so: never while loading, never after a failure,
 * and never for a clinic whose hours are not configured, where "after hours"
 * has no meaning yet.
 */
const HOURS = receptionistFixtures.hoursStatus();

let respond: (path: string) => Promise<unknown>;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
});

function renderCard() {
  return render(<MemoryRouter><AfterHoursCard /></MemoryRouter>);
}

describe('AfterHoursCard', () => {
  it('shows no numbers while the request is in flight', () => {
    respond = () => new Promise(() => {});
    renderCard();

    expect(screen.getByText(/Loading hours status…/)).toBeInTheDocument();
    expect(screen.queryByText(/After-hours calls/)).not.toBeInTheDocument();
  });

  it('names the failure instead of rendering zeros', async () => {
    respond = () => Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR'));
    renderCard();

    expect(await screen.findByRole('alert')).toHaveTextContent('Hours status could not be loaded.');
    expect(screen.queryByText(/After-hours calls/)).not.toBeInTheDocument();
  });

  it('says an unconfigured clinic cannot be counted, and links to the tab that fixes it', async () => {
    respond = () => Promise.resolve(HOURS);
    renderCard();

    const row = await screen.findByTestId('after-hours-clinic-2');
    expect(row).toHaveTextContent('Opening hours are not configured');
    expect(row).not.toHaveTextContent('After-hours calls');
    expect(screen.getByRole('link', { name: /Set hours in the Clinic Profile tab/ })).toHaveAttribute('href', '/receptionist-studio?tab=clinic');
  });

  it('shows open/closed, the next opening and the real counts for a configured clinic', async () => {
    respond = () => Promise.resolve(HOURS);
    renderCard();

    const row = await screen.findByTestId('after-hours-clinic-1');
    expect(row).toHaveTextContent('Closed — reopens Monday 31 August at 09:00');
    expect(row).toHaveTextContent('Today: 09:00 to 17:00');
    expect(row).toHaveTextContent('2');
    expect(row).toHaveTextContent('11');
  });

  it('says when the times are formatted with a fallback because no pack is approved', async () => {
    respond = () => Promise.resolve(HOURS);
    renderCard();

    await waitFor(() => expect(screen.getByTestId('after-hours-clinic-1')).toBeInTheDocument());
    expect(screen.getByTestId('after-hours-clinic-1')).not.toHaveTextContent('fallback format');
  });

  it('shows Open now for a clinic that is open', async () => {
    respond = () => Promise.resolve({ ...HOURS, clinics: [{ ...HOURS.clinics[0], isOpenNow: true }] });
    renderCard();

    expect(await screen.findByText('Open now')).toBeInTheDocument();
  });

  it('says the workspace has no clinics rather than showing an empty card', async () => {
    respond = () => Promise.resolve({ at: HOURS.at, clinics: [] });
    renderCard();

    expect(await screen.findByText(/No clinics configured yet/)).toBeInTheDocument();
  });
});
