import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../lib/api';
import { GROWTH_POLICY_PATH } from '../lib/growthPolicy';
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

/**
 * `GET /v1/growth/policy`. Defaults are the ones in
 * server/modules/growth/defaults.ts, which are the numbers this screen used to
 * hardcode.
 */
function growthPolicy(overrides: Record<string, unknown> = {}) {
  return {
    source: 'default',
    reviewRatingGood: 4.5,
    reviewRatingFair: 4.0,
    reputationRiskHigh: 80,
    reputationRiskMedium: 55,
    competitorRatingHighSeverityMax: 4.2,
    competitorRatingMediumSeverityMax: 4.5,
    competitorReviewVolumeHigh: 350,
    ...overrides,
  };
}

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

/**
 * Answers all four feeds, with any of them overridable for one test. Every
 * severity on this page is decided by the configured policy, so the policy is
 * one of the feeds a fixture has to supply.
 */
function answerAll(overrides: Partial<Record<'branches' | 'reputation' | 'competitors' | 'policy', () => Promise<unknown>>> = {}) {
  return (path: string) => {
    if (path.startsWith(GROWTH_POLICY_PATH)) return (overrides.policy ?? (() => Promise.resolve(growthPolicy())))();
    if (path.startsWith('/v1/branches')) return (overrides.branches ?? (() => Promise.resolve(BRANCHES)))();
    if (path.startsWith('/v1/reputation')) return (overrides.reputation ?? (() => Promise.resolve(reputationPayload(3))))();
    return (overrides.competitors ?? (() => Promise.resolve(COMPETITORS)))();
  };
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
    respond = answerAll();
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
    respond = answerAll({ reputation: PENDING_FOREVER });
    renderPage();

    // The competitor sidebar is allowed to fill in; the case tile is not.
    await screen.findByText('Northside Dental');

    expect(screen.queryByText('Open reputation cases')).not.toBeInTheDocument();
    expect(screen.queryByText('Recorded as unresolved')).not.toBeInTheDocument();
    expect(screen.queryAllByText('0')).toEqual([]);
    expect(screen.getByText('Loading Signals…')).toBeInTheDocument();
  });

  it('makes no affirmative zero when the reputation request fails', async () => {
    respond = answerAll({
      reputation: () => Promise.reject(new ApiError(500, 'Something went wrong on our side. Please try again in a moment.', 'INTERNAL_SERVER_ERROR')),
    });
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
      [GROWTH_POLICY_PATH]: [() => Promise.resolve(growthPolicy())],
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
    respond = answerAll();
    renderPage();

    await screen.findByText('Signals loaded');
    await new Promise(resolve => setTimeout(resolve, 60));

    for (const endpoint of ['/v1/branches', '/v1/reputation', '/v1/competitors/radar', GROWTH_POLICY_PATH]) {
      expect(apiRequestMock.mock.calls.filter(([path]) => String(path).startsWith(endpoint))).toHaveLength(1);
    }
    // Four feeds, four requests. The policy is read once per mount, not once
    // per signal it classifies.
    expect(apiRequestMock).toHaveBeenCalledTimes(4);
  });
});

/**
 * Severity on this board used to be decided by five literals compiled into the
 * page — `>= 80` / `>= 55` for reputation risk, `<= 4.2` / `<= 4.5` / `> 350`
 * for competitors — so "High Priority · Signals needing action now" meant the
 * same thing for every clinic on the platform and none of them could see the
 * rule, let alone change it.
 *
 * Worse, the server's advisory engine classified the SAME `badReviewRisk` field
 * at `>= 60` (server/modules/advisory/service.ts), so one field had three
 * numbers across two layers. These tests pin the page to the configured bands
 * so that divergence can only shrink from here.
 */

/** Both feeds under the DEFAULT bands: risk 84 → high, 420 reviews → high. */
describe('ClinicRadar configured severity bands', () => {
  it('classifies and states the thresholds the product default configures', async () => {
    respond = answerAll();
    renderPage();

    await screen.findByText('Signals loaded');

    expect(figureUnder('High Priority')).toBe('2');
    expect(figureUnder('Medium Priority')).toBe('0');
    expect(screen.getByText(
      /high at a recorded risk ≥ 80 and medium at ≥ 55\..*high at a rating ≤ 4\.2 or more than 350 reviews, and medium at a rating ≤ 4\.5\./,
    )).toBeInTheDocument();
    expect(screen.getByText(/has not set its own thresholds yet/)).toBeInTheDocument();
  });

  it('gives a tenant with different bands a different classification', async () => {
    // The same two records, judged by a stricter tenant. Risk 84 no longer
    // clears a high band that starts at 90; the competitor's 420 reviews no
    // longer clear a volume band that starts above 500, and its 4.1 rating no
    // longer clears a high bound of 4.0 — so both records drop to medium.
    // Restoring ANY of the five retired literals puts a signal back into High.
    respond = answerAll({
      policy: () => Promise.resolve(growthPolicy({
        source: 'tenant',
        reputationRiskHigh: 90,
        reputationRiskMedium: 60,
        competitorRatingHighSeverityMax: 4.0,
        competitorRatingMediumSeverityMax: 4.3,
        competitorReviewVolumeHigh: 500,
      })),
    });
    renderPage();

    await screen.findByText('Signals loaded');

    expect(figureUnder('Signals loaded')).toBe('2');
    expect(figureUnder('High Priority')).toBe('0');
    expect(figureUnder('Medium Priority')).toBe('2');
    expect(screen.getByText(
      /high at a recorded risk ≥ 90 and medium at ≥ 60\..*high at a rating ≤ 4\.0 or more than 500 reviews, and medium at a rating ≤ 4\.3\./,
    )).toBeInTheDocument();
    expect(screen.getByText(/Configured for this workspace/)).toBeInTheDocument();
    expect(screen.queryByText(/recorded risk ≥ 80/)).not.toBeInTheDocument();
  });

  it('asserts no severity while the policy is in flight, though both feeds answered', async () => {
    respond = answerAll({ policy: PENDING_FOREVER });
    renderPage();

    // The tile that needs no bands is entitled to speak, and does.
    await screen.findByText('Open reputation cases');
    expect(figureUnder('Open reputation cases')).toBe('3');

    // Nothing that classifies may. "0 high priority signals" is exactly the
    // reassurance a clinic should not be given on an unclassified board.
    expect(screen.queryByText('Signals loaded')).not.toBeInTheDocument();
    expect(screen.queryByText('High Priority')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium Priority')).not.toBeInTheDocument();
    expect(screen.queryByText(/recorded risk ≥/)).not.toBeInTheDocument();
    expect(screen.queryByText('2 signals loaded')).not.toBeInTheDocument();
    expect(screen.getByText('Loading signals')).toBeInTheDocument();
    expect(screen.getByText('Loading Signals…')).toBeInTheDocument();
  });

  it('names the failure instead of classifying against a default band', async () => {
    respond = answerAll({
      policy: () => Promise.reject(new ApiError(403, 'Forbidden', 'insufficient_permission')),
    });
    renderPage();

    const heading = await screen.findByText('Signals could not be loaded');
    expect(within(heading.closest('[role="alert"]') as HTMLElement)
      .getByText(/no figure here should be read as zero, empty or healthy/)).toBeInTheDocument();

    expect(screen.queryByText('High Priority')).not.toBeInTheDocument();
    expect(screen.queryByText(/recorded risk ≥/)).not.toBeInTheDocument();
    expect(screen.getByText('Data unavailable')).toBeInTheDocument();
    // The board failing is not the workspace being quiet.
    expect(screen.queryByText('No signals recorded')).not.toBeInTheDocument();
  });

  it('refuses a policy it cannot classify with rather than comparing against NaN', async () => {
    // `>=` against NaN is always false, so a lenient adapter would have marked
    // every case and every competitor "low" — a clean bill of health invented
    // out of a malformed response.
    respond = answerAll({ policy: () => Promise.resolve({ source: 'tenant', reputationRiskHigh: 80 }) });
    renderPage();

    await screen.findByText('Signals could not be loaded');
    // Every panel that classifies says why it cannot, in the adapter's words.
    expect(screen.getAllByText(/configured growth thresholds are incomplete/).length).toBeGreaterThan(0);
    expect(screen.queryByText('High Priority')).not.toBeInTheDocument();
  });
});

describe('ClinicRadar signal timeline', () => {
  const competitor = (id: string, name: string) => ({
    ...COMPETITORS[0], id, name,
  });

  it('says how much of the timeline it is showing and connects only the rows it drew', async () => {
    // Eight signals: one reputation case and seven competitor records.
    respond = answerAll({
      competitors: () => Promise.resolve([1, 2, 3, 4, 5, 6, 7].map(n => competitor(`competitor-${n}`, `Rival ${n} Dental`))),
    });
    renderPage();

    await screen.findByText('Signals loaded');
    expect(figureUnder('Signals loaded')).toBe('8');

    expect(screen.getByText('Most recent 6 of 8 loaded detections.')).toBeInTheDocument();
    // Six dots drawn, five connectors between them. The connector used to
    // re-derive the cut with its own `Math.min(rows.length, 6)`, so the two
    // could disagree; they now come from one list.
    expect(document.querySelectorAll('div.w-px')).toHaveLength(5);
  });

  it('makes no truncation claim when every loaded detection fits', async () => {
    respond = answerAll();
    renderPage();

    await screen.findByText('Signals loaded');
    expect(screen.queryByText(/loaded detections\./)).not.toBeInTheDocument();
    // Two rows, one connector.
    expect(document.querySelectorAll('div.w-px')).toHaveLength(1);
  });
});
