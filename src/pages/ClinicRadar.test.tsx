import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../lib/api';
import ClinicRadar from './ClinicRadar';

/**
 * "Open reputation cases: 0" is a safety claim. A clinic reading it stops
 * looking. It may therefore be printed only from a response that actually said
 * zero — never while a request is in flight, never after one failed, and never
 * during a refresh of a tile that was previously showing three.
 *
 * The tile is fed by `?? 0` no longer; it lives inside a render prop that only
 * the ready state can reach. These tests hold that door shut.
 */

const BARE_FIGURE = /^\$?-?[\d,]+(\.\d+)?%?$/;

const BRANCHES = [{ id: 'branch-1', name: 'Riverside Clinic' }];

function reputationPayload(unresolvedCases: number) {
  return {
    summary: { unresolvedCases, avgBadReviewRisk: 62, avgNpsScore: 41, pendingReviewRequests: 2 },
    cases: [{
      id: 'case-1', branchId: 'branch-1', branch: { name: 'Riverside Clinic' }, patient: null,
      badReviewRisk: 84, complaintCategory: 'Wait time', unresolvedComplaint: 'Waited ninety minutes past the appointment time.',
      workflowStatus: 'awaiting callback', recoveryWorkflow: 'Call the patient before end of day.',
      suggestedReply: 'Review before sending.', npsScore: 12, publicTrend: 'declining',
      staffComplaintDetected: false, createdAt: '2026-08-20T10:00:00.000Z',
    }],
    reviewRequests: [],
  };
}

const COMPETITORS = [{
  id: 'competitor-1', name: 'Northside Dental', distanceKm: '1.2', googleRating: '4.1', reviewVolume: 420,
  complaintThemes: ['wait times'], activeOffers: ['Free consultation'], localRankTrend: 'up',
  weaknessSummary: 'Long waits reported.', opportunityAlert: 'Reviews mention scheduling.',
  marketOpeningRecommendation: 'Review same-week availability.', createdAt: '2026-08-21T11:00:00.000Z',
  branch: { name: 'Riverside Clinic' }, insights: [],
}];

const PENDING_FOREVER = () => new Promise<never>(() => {});

let respond: (path: string) => Promise<unknown>;

beforeEach(() => {
  respond = PENDING_FOREVER;
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
});

function renderPage() {
  return render(<MemoryRouter><ClinicRadar /></MemoryRouter>);
}

function renderedFigures() {
  return screen.queryAllByText(BARE_FIGURE).map(element => element.textContent?.trim() ?? '');
}

/** These tiles print the figure in the paragraph immediately below the label. */
function figureUnder(label: string) {
  const labelElement = screen.getByText(label);
  const figure = labelElement.nextElementSibling;
  if (!figure) throw new Error(`No figure is rendered under "${label}"`);
  return figure.textContent?.trim() ?? '';
}

/** Answers each feed from a per-path queue, so a reload can answer differently. */
function answerInOrder(queues: Record<string, Array<() => Promise<unknown>>>) {
  const cursor: Record<string, number> = {};
  return (path: string) => {
    const key = Object.keys(queues).find(prefix => path.startsWith(prefix));
    if (!key) throw new Error(`No fixture registered for ${path}`);
    const index = cursor[key] ?? 0;
    cursor[key] = index + 1;
    const step = queues[key][Math.min(index, queues[key].length - 1)];
    return step();
  };
}

describe('ClinicRadar signal figures', () => {
  it('renders no signal figure while the feeds are in flight', async () => {
    renderPage();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());

    expect(screen.getByText('Loading signals')).toBeInTheDocument();
    for (const label of ['Signals loaded', 'High Priority', 'Medium Priority', 'Open reputation cases']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Recorded as unresolved')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(renderedFigures()).toEqual([]);
    // The wait is announced. (The KPI tiles pass a bare visual skeleton via
    // `loading`, which carries no text, so the announcement comes from the
    // board below them.)
    expect(screen.getByText('Loading Signals…')).toBeInTheDocument();
  });

  it('prints the figures the two feeds actually returned', async () => {
    respond = path => Promise.resolve(
      path.startsWith('/v1/branches') ? BRANCHES
        : path.startsWith('/v1/reputation') ? reputationPayload(3)
          : COMPETITORS,
    );
    renderPage();

    await screen.findByText('Signals loaded');

    // One reputation case (risk 84 → high) and one competitor (4.1 → high).
    expect(figureUnder('Signals loaded')).toBe('2');
    expect(figureUnder('High Priority')).toBe('2');
    expect(figureUnder('Medium Priority')).toBe('0');
    expect(figureUnder('Open reputation cases')).toBe('3');
    expect(screen.getByText('2 signals loaded')).toBeInTheDocument();
  });
});

describe('ClinicRadar open reputation cases', () => {
  it('makes no affirmative zero while the reputation request is in flight', async () => {
    respond = path => (path.startsWith('/v1/reputation') ? PENDING_FOREVER() : Promise.resolve(path.startsWith('/v1/branches') ? BRANCHES : COMPETITORS));
    renderPage();

    // The competitor sidebar is allowed to fill in; the case tile is not.
    await screen.findByText('Northside Dental');

    expect(screen.queryByText('Open reputation cases')).not.toBeInTheDocument();
    expect(screen.queryByText('Recorded as unresolved')).not.toBeInTheDocument();
    expect(screen.queryAllByText('0')).toEqual([]);
    expect(screen.getByText('Loading Signals…')).toBeInTheDocument();
  });

  it('makes no affirmative zero when the reputation request fails', async () => {
    respond = path => (path.startsWith('/v1/reputation')
      ? Promise.reject(new ApiError(500, 'Something went wrong on our side. Please try again in a moment.', 'INTERNAL_SERVER_ERROR'))
      : Promise.resolve(path.startsWith('/v1/branches') ? BRANCHES : COMPETITORS));
    renderPage();

    const heading = await screen.findByText('Open reputation cases could not be loaded');
    const notice = heading.closest('[role="alert"]');
    expect(notice).not.toBeNull();
    expect(within(notice as HTMLElement).getByText('Not loaded — do not read as zero.')).toBeInTheDocument();

    expect(screen.queryByText('Open reputation cases')).not.toBeInTheDocument();
    expect(screen.queryByText('Recorded as unresolved')).not.toBeInTheDocument();
    expect(screen.queryAllByText('0')).toEqual([]);
    // And the board says out loud that it is only half a picture.
    expect(screen.getByRole('status')).toHaveTextContent('Reputation cases did not load');
  });

  it('withdraws the figure during a refresh instead of falling back to zero', async () => {
    respond = answerInOrder({
      '/v1/branches': [() => Promise.resolve(BRANCHES)],
      '/v1/competitors': [() => Promise.resolve(COMPETITORS)],
      // First answer: three open cases. Second: still in flight. Third: zero.
      '/v1/reputation': [
        () => Promise.resolve(reputationPayload(3)),
        PENDING_FOREVER,
        () => Promise.resolve(reputationPayload(0)),
      ],
    });
    renderPage();

    await screen.findByText('Open reputation cases');
    expect(figureUnder('Open reputation cases')).toBe('3');

    fireEvent.click(screen.getByRole('button', { name: /Refresh signals/ }));

    // The refresh is in flight. Three is no longer true, and zero is not known.
    await waitFor(() => expect(screen.queryByText('Open reputation cases')).not.toBeInTheDocument());
    expect(screen.queryByText('Recorded as unresolved')).not.toBeInTheDocument();
    expect(screen.queryAllByText('3')).toEqual([]);
    expect(screen.queryAllByText('0')).toEqual([]);
    expect(screen.getByText('Loading Signals…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Refresh signals/ }));

    // Now a response really did say zero, so the tile may say it.
    await waitFor(() => expect(figureUnder('Open reputation cases')).toBe('0'));
    expect(screen.getByText('Recorded as unresolved')).toBeInTheDocument();
  });
});

describe('ClinicRadar request volume', () => {
  it('asks each endpoint once for one mount', async () => {
    respond = path => Promise.resolve(
      path.startsWith('/v1/branches') ? BRANCHES
        : path.startsWith('/v1/reputation') ? reputationPayload(3)
          : COMPETITORS,
    );
    renderPage();

    await screen.findByText('Signals loaded');
    await new Promise(resolve => setTimeout(resolve, 60));

    for (const endpoint of ['/v1/branches', '/v1/reputation', '/v1/competitors/radar']) {
      expect(apiRequestMock.mock.calls.filter(([path]) => String(path).startsWith(endpoint))).toHaveLength(1);
    }
    expect(apiRequestMock).toHaveBeenCalledTimes(3);
  });
});
