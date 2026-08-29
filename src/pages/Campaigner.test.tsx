import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

// The module boundary every loader on this page goes through: the page's
// `fetchList` helper and `useResource`'s string sources both call `apiRequest`.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../lib/api';
import type { ApiCampaign } from '../lib/apiAdapters';
import Campaigner from './Campaigner';

/**
 * Nothing on a KPI tile may be readable as a figure until the request that
 * produced it has answered. A "$0" printed over an unanswered request is
 * indistinguishable from a workspace that genuinely attributed nothing, and it
 * is the same claim a clinic owner would act on.
 *
 * Every figure on this page now lives inside a ResourceSection render prop, so
 * these tests assert the DOM in all three states: pending, answered, failed.
 */

/** Anything a reader would take for a stat value: 12, 0, 3.4, 15%, $12,500. */
const BARE_FIGURE = /^\$?-?[\d,]+(\.\d+)?%?$/;

const KPI_LABELS = ['Attributed Revenue', 'Recorded Bookings', 'Active Campaigns', 'Booking / Accepted'];

const CAMPAIGNS: ApiCampaign[] = [
  {
    id: 'campaign-1', name: 'Six-month recall', goal: 'Reconnect with inactive patients', status: 'ACTIVE',
    channels: ['SMS'], audienceSize: 240, sent: 200, opened: 120, responded: 45, booked: 30,
    revenue: '12500', startsAt: '2026-08-01T00:00:00.000Z', endsAt: null, aiGenerated: false,
  },
  {
    id: 'campaign-2', name: 'Hygiene follow-up', goal: 'Request patient feedback', status: 'DRAFT',
    channels: ['EMAIL'], audienceSize: 80, sent: 0, opened: 0, responded: 0, booked: 0,
    revenue: '0', startsAt: null, endsAt: null, aiGenerated: false,
  },
];

let respond: (path: string) => Promise<unknown>;

beforeEach(() => {
  // Default: the request is accepted and never answered, which is the state the
  // screen is in for the first frames of every real page load.
  respond = () => new Promise(() => {});
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
});

function renderPage() {
  return render(<MemoryRouter><Campaigner /></MemoryRouter>);
}

/** Every element whose whole text reads as a stat value. */
function renderedFigures() {
  return screen.queryAllByText(BARE_FIGURE).map(element => element.textContent?.trim() ?? '');
}

/** StatCard prints the figure in the paragraph immediately above its label. */
function figureFor(label: string) {
  const labelElement = screen.getByText(label);
  const figure = labelElement.previousElementSibling;
  if (!figure) throw new Error(`No figure is rendered above "${label}"`);
  return figure.textContent?.trim() ?? '';
}

describe('Campaigner KPI tiles', () => {
  it('renders no figure at all while the campaign request is in flight', async () => {
    renderPage();

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());

    expect(screen.getByText('Loading campaigns')).toBeInTheDocument();
    for (const label of KPI_LABELS) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    // The specific shapes a pending tile used to print.
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('0.0')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(renderedFigures()).toEqual([]);

    // The wait is announced rather than shown as an answer.
    expect(screen.getByText('Loading Campaign library…')).toBeInTheDocument();
  });

  it('prints the figures the response actually supports once it lands', async () => {
    respond = () => Promise.resolve(CAMPAIGNS);
    renderPage();

    await screen.findByText('Attributed Revenue');

    expect(figureFor('Attributed Revenue')).toBe('$12,500');
    expect(figureFor('Recorded Bookings')).toBe('30');
    expect(figureFor('Active Campaigns')).toBe('1');
    // 30 bookings over 200 accepted requests.
    expect(figureFor('Booking / Accepted')).toBe('15%');
    expect(screen.getByText('1 active · stored campaign records')).toBeInTheDocument();
  });

  it('renders no figure when the campaign request fails', async () => {
    respond = () => Promise.reject(new ApiError(500, 'Something went wrong on our side. Please try again in a moment.', 'INTERNAL_SERVER_ERROR'));
    renderPage();

    const totals = await screen.findByText('Campaign totals could not be loaded');
    const notice = totals.closest('[role="alert"]');
    expect(notice).not.toBeNull();
    expect(within(notice as HTMLElement).getByText('Not loaded — do not read as zero.')).toBeInTheDocument();

    expect(screen.getByText('Data unavailable')).toBeInTheDocument();
    for (const label of KPI_LABELS) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(renderedFigures()).toEqual([]);
    // Not a zero, and not an empty workspace either.
    expect(screen.queryByText('No campaigns recorded yet')).not.toBeInTheDocument();
    // One retry beside the tiles, one beside the library.
    expect(screen.getAllByRole('button', { name: /try again/i })).toHaveLength(2);
  });

  it('prints a zero only because the response said the workspace has none', async () => {
    respond = () => Promise.resolve([]);
    renderPage();

    await screen.findByText('Attributed Revenue');

    // The distinction the whole contract exists for: this $0 is a fact about
    // the workspace, and it is reachable only from a response that carried it.
    expect(figureFor('Attributed Revenue')).toBe('$0');
    expect(figureFor('Recorded Bookings')).toBe('0');
    expect(figureFor('Active Campaigns')).toBe('0');
    // A rate over no accepted requests is undefined, not 0%.
    expect(figureFor('Booking / Accepted')).toBe('—');
    expect(screen.getByText('No provider-accepted requests recorded')).toBeInTheDocument();
    expect(screen.getByText('No campaigns recorded yet')).toBeInTheDocument();
  });

  it('does not refetch the campaign feed on every render', async () => {
    respond = () => Promise.resolve(CAMPAIGNS);
    renderPage();

    await screen.findByText('Attributed Revenue');
    await new Promise(resolve => setTimeout(resolve, 40));

    expect(apiRequestMock.mock.calls.filter(([path]) => String(path).startsWith('/v1/campaigns'))).toHaveLength(1);
  });
});
