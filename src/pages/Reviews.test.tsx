import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../lib/api';
import type { ApiReview } from '../lib/apiAdapters';
import { GROWTH_POLICY_PATH } from '../lib/growthPolicy';
import Reviews from './Reviews';

/**
 * Two defects met on this screen.
 *
 * The figures (average rating, positive sentiment, review-risk) were printed
 * from `?? 0` fallbacks, so an unanswered or failed request read as a real
 * measurement. And the reply composer opened pre-filled with one canned
 * compliment, which staff could file verbatim against a one-star review.
 *
 * Both are now structural: the figures live inside render props, and the
 * composer's only source of text is the user or a draft stored on the review.
 */

/** The exact sentence the old build put in every composer. */
const CANNED_REPLY = 'Thank you so much for taking the time to share your feedback';

const BARE_FIGURE = /^\$?-?[\d,]+(\.\d+)?%?$/;

const REVIEW_TILES = ['Average rating', 'Reviews loaded', 'Positive sentiment'];
const REPUTATION_TILES = ['Review-risk score', 'Pending requests'];

const REVIEWS: ApiReview[] = [
  {
    id: 'review-1', branchId: 'branch-1', rating: 5, text: 'The nurse explained everything clearly.',
    platform: 'google', createdAt: '2026-08-02T09:30:00.000Z', responded: false, aiDraftResponse: null,
    sentiment: 'positive',
  },
  {
    // The one-star case. Nothing complimentary may be offered for this row.
    id: 'review-2', branchId: 'branch-1', rating: 1, text: 'Waited ninety minutes and nobody explained why.',
    platform: 'yelp', createdAt: '2026-08-03T09:30:00.000Z', responded: false, aiDraftResponse: null,
    sentiment: 'negative',
  },
  {
    // A sentiment the product does not define, and a stored draft to review.
    id: 'review-3', branchId: 'branch-1', rating: 4, text: 'Reception was slow but the treatment was good.',
    platform: 'facebook', createdAt: '2026-08-04T09:30:00.000Z', responded: false,
    aiDraftResponse: 'Draft stored against this review, awaiting a reviewer.', sentiment: 'mixed',
  },
  {
    // No usable rating on the stored row.
    id: 'review-4', branchId: 'branch-1', rating: 'not recorded' as unknown as number, text: 'Short note, no score.',
    platform: '', createdAt: '2026-08-05T09:30:00.000Z', responded: false, aiDraftResponse: null,
    sentiment: 'positive',
  },
];

const BRANCHES = [{ id: 'branch-1', name: 'Riverside Clinic' }];

/**
 * `GET /v1/growth/policy`. The seven fields the reputation screens classify
 * with; the defaults here are the ones in server/modules/growth/defaults.ts.
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

const REPUTATION = {
  summary: { unresolvedCases: 3, avgBadReviewRisk: 62, avgNpsScore: 41, pendingReviewRequests: 2 },
  cases: [{
    id: 'case-1', branchId: 'branch-1', branch: { name: 'Riverside Clinic' }, patient: null,
    badReviewRisk: 84, complaintCategory: 'Wait time', unresolvedComplaint: 'Long wait reported at reception.',
    workflowStatus: 'awaiting callback', recoveryWorkflow: 'Call the patient before end of day.',
    suggestedReply: 'Review before sending.', npsScore: 12, publicTrend: 'declining',
    staffComplaintDetected: false, createdAt: '2026-08-20T10:00:00.000Z',
  }],
  reviewRequests: [],
};

const PENDING_FOREVER = () => new Promise<never>(() => {});

let respond: (path: string) => Promise<unknown>;

const answerEverything = (path: string) => Promise.resolve(
  path.startsWith('/v1/reviews') ? REVIEWS
    : path.startsWith('/v1/branches') ? BRANCHES
      : path.startsWith('/v1/providers') ? []
        : path.startsWith(GROWTH_POLICY_PATH) ? growthPolicy()
          : REPUTATION,
);

beforeEach(() => {
  respond = PENDING_FOREVER;
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
});

function renderPage() {
  return render(<MemoryRouter><Reviews /></MemoryRouter>);
}

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

describe('Reviews figures', () => {
  it('renders no review figure while the requests are in flight', async () => {
    renderPage();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());

    expect(screen.getByText('Loading reputation')).toBeInTheDocument();
    for (const label of [...REVIEW_TILES, ...REPUTATION_TILES]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('0.0')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(renderedFigures()).toEqual([]);
    expect(screen.getByText('Loading Review feed…')).toBeInTheDocument();
  });

  it('prints the figures the responses actually support once they land', async () => {
    respond = answerEverything;
    renderPage();

    await screen.findByText('Average rating');

    // Only the three rows carrying a usable rating: (5 + 1 + 4) / 3.
    expect(figureFor('Average rating')).toBe('3.3');
    expect(screen.getByText('Across 3 rated reviews')).toBeInTheDocument();
    expect(figureFor('Reviews loaded')).toBe('4');

    // Three rows carry a sentiment the product defines; two of them are
    // positive. The unrecognised 'mixed' row is excluded from both halves of
    // the fraction. Had it been relabelled "neutral" this would read 50%.
    expect(figureFor('Positive sentiment')).toBe('67%');
    expect(screen.getByText('Of 3 classified reviews')).toBeInTheDocument();

    expect(figureFor('Review-risk score')).toBe('62%');
    expect(figureFor('Pending requests')).toBe('2');
    expect(screen.getByText('3 need review')).toBeInTheDocument();
  });

  it('renders no review figure when the requests fail', async () => {
    respond = () => Promise.reject(new ApiError(500, 'Something went wrong on our side. Please try again in a moment.', 'INTERNAL_SERVER_ERROR'));
    renderPage();

    const figuresNotice = await screen.findByText('Review figures could not be loaded');
    expect(within(figuresNotice.closest('[role="alert"]') as HTMLElement)
      .getByText('Not loaded — do not read as zero.')).toBeInTheDocument();
    expect(screen.getByText('Reputation figures could not be loaded')).toBeInTheDocument();

    expect(screen.getByText('Data unavailable')).toBeInTheDocument();
    for (const label of [...REVIEW_TILES, ...REPUTATION_TILES]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(renderedFigures()).toEqual([]);
    // A failed feed is not an empty workspace.
    expect(screen.queryByText('No reviews recorded yet')).not.toBeInTheDocument();
  });

  it('says what each row really carries instead of filling the gaps', async () => {
    respond = answerEverything;
    renderPage();

    await screen.findByText('Average rating');

    // A Yelp review is a Yelp review.
    expect(screen.getByText('yelp')).toBeInTheDocument();
    expect(screen.getByText('facebook')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('internal');

    // Absences are named, not guessed.
    expect(screen.getByText('Rating not recorded')).toBeInTheDocument();
    expect(screen.getByText('sentiment not classified')).toBeInTheDocument();
    expect(screen.getByText('Platform not recorded')).toBeInTheDocument();
    expect(screen.getAllByText('No reviewer name on this record')).toHaveLength(REVIEWS.length);
    expect(screen.getByText('1 loaded review carries no rating and is not counted above.')).toBeInTheDocument();
  });
});

describe('Reviews request volume', () => {
  it('asks each endpoint once for one mount', async () => {
    respond = answerEverything;
    renderPage();

    await screen.findByText('Average rating');
    await new Promise(resolve => setTimeout(resolve, 60));

    for (const endpoint of ['/v1/reviews', '/v1/branches', '/v1/providers/overview', '/v1/reputation', GROWTH_POLICY_PATH]) {
      expect(apiRequestMock.mock.calls.filter(([path]) => String(path).startsWith(endpoint))).toHaveLength(1);
    }
    // Five feeds, five requests. The policy is read once per mount like the
    // rest — it is not re-fetched per clinic row it bands.
    expect(apiRequestMock).toHaveBeenCalledTimes(5);
  });
});

describe('Reviews response composer', () => {
  it('opens empty for every review with no stored draft, and stays disabled until someone writes', async () => {
    respond = answerEverything;
    renderPage();
    await screen.findByText('Average rating');

    // review-1, review-2 and review-4 have no stored draft.
    expect(screen.getAllByRole('button', { name: 'Write a response' })).toHaveLength(3);

    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getAllByRole('button', { name: 'Write a response' })[index]);

      const composer = screen.getByLabelText('Your response') as HTMLTextAreaElement;
      expect(composer.value).toBe('');
      expect(composer.textContent).toBe('');
      expect(screen.getByRole('button', { name: /Record response/ })).toBeDisabled();
      expect(document.body.textContent).not.toContain(CANNED_REPLY);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    }
  });

  it('offers a one-star review no complimentary text and no enabled action', async () => {
    respond = answerEverything;
    renderPage();
    await screen.findByText('Average rating');

    fireEvent.click(screen.getAllByRole('button', { name: 'Write a response' })[1]);

    const composer = screen.getByLabelText('Your response') as HTMLTextAreaElement;
    // Confirms this is the one-star row's composer and not a neighbour's.
    expect(composer).toHaveAttribute('id', 'review-response-review-2');
    expect(composer.value).toBe('');
    expect(composer).toHaveAttribute('placeholder', 'Write the reply this clinic should stand behind for this review.');
    expect(screen.getByRole('button', { name: /Record response/ })).toBeDisabled();
    expect(document.body.textContent).not.toContain(CANNED_REPLY);
    expect(document.body.textContent).not.toContain('Thank you so much');
  });

  it('enables the action only once the user has typed something', async () => {
    respond = answerEverything;
    renderPage();
    await screen.findByText('Average rating');

    fireEvent.click(screen.getAllByRole('button', { name: 'Write a response' })[1]);
    const composer = screen.getByLabelText('Your response');

    expect(screen.getByRole('button', { name: /Record response/ })).toBeDisabled();

    // Whitespace is not a response.
    fireEvent.change(composer, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: /Record response/ })).toBeDisabled();

    fireEvent.change(composer, { target: { value: 'We are sorry about the wait. The practice manager will call you today.' } });
    expect(screen.getByRole('button', { name: /Record response/ })).toBeEnabled();
  });

  it('records exactly the text the user wrote', async () => {
    respond = answerEverything;
    renderPage();
    await screen.findByText('Average rating');

    fireEvent.click(screen.getAllByRole('button', { name: 'Write a response' })[1]);
    fireEvent.change(screen.getByLabelText('Your response'), {
      target: { value: 'We are sorry about the wait. The practice manager will call you today.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Record response/ }));

    await waitFor(() => expect(
      apiRequestMock.mock.calls.some(([path]) => path === '/v1/reviews/review-2/respond')).toBe(true));

    const [, init] = apiRequestMock.mock.calls.find(([path]) => path === '/v1/reviews/review-2/respond') as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      response: 'We are sorry about the wait. The practice manager will call you today.',
    });
    expect(String(init.body)).not.toContain('Thank you so much');
  });

  it('prefills only from a draft stored on the review, and labels it as stored', async () => {
    // The rule is "never invent text", not "never show stored text". A draft
    // the workspace saved is real data, and the composer says where it came
    // from so a reviewer reads it against this rating before recording it.
    respond = answerEverything;
    renderPage();
    await screen.findByText('Average rating');

    fireEvent.click(screen.getByRole('button', { name: 'Review stored draft and respond' }));

    const composer = screen.getByLabelText('Your response') as HTMLTextAreaElement;
    expect(composer).toHaveAttribute('id', 'review-response-review-3');
    expect(composer.value).toBe('Draft stored against this review, awaiting a reviewer.');
    expect(screen.getByText(/Prefilled from the draft stored on this review/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(CANNED_REPLY);
  });

  it('never puts the canned compliment on the page in any state', async () => {
    respond = PENDING_FOREVER;
    const pending = renderPage();
    expect(document.body.textContent).not.toContain(CANNED_REPLY);
    pending.unmount();

    respond = answerEverything;
    renderPage();
    await screen.findByText('Average rating');
    expect(document.body.textContent).not.toContain(CANNED_REPLY);
  });
});

/**
 * The clinic reputation bands used to be written into the JSX as `>= 4.5` and
 * `>= 4`, so every tenant on the platform was told the same thing about what
 * "good" means and none of them could see, let alone change, the rule. They now
 * come from `GET /v1/growth/policy`.
 *
 * Two properties are held here. A tenant with different bands must get a
 * different colour AND different copy — a band that ignores configuration is
 * the original defect wearing a config read. And a band whose policy has not
 * arrived, failed, or came back unusable must not be drawn at all: a green 4.4
 * under a tenant whose "good" starts at 4.6 is not a late claim, it is a wrong
 * one, and a hardcoded fallback would make it permanently wrong.
 */

/** Riverside averages 4.3 across three rated reviews; Harbour averages 2.0. */
const BAND_BRANCHES = [
  { id: 'branch-1', name: 'Riverside Clinic' },
  { id: 'branch-2', name: 'Harbour Clinic' },
];

const bandReview = (id: string, branchId: string, rating: number): ApiReview => ({
  id, branchId, rating, text: 'Recorded review.', platform: 'google',
  createdAt: '2026-08-02T09:30:00.000Z', responded: false, aiDraftResponse: null, sentiment: 'positive',
});

const BAND_REVIEWS: ApiReview[] = [
  bandReview('band-1', 'branch-1', 4),
  bandReview('band-2', 'branch-1', 5),
  bandReview('band-3', 'branch-1', 4),
  bandReview('band-4', 'branch-2', 2),
  bandReview('band-5', 'branch-2', 2),
];

/** Answers the banding fixture, with the policy request under the test's control. */
function answerBands(policyStep: () => Promise<unknown>) {
  return (path: string) => {
    if (path.startsWith(GROWTH_POLICY_PATH)) return policyStep();
    return Promise.resolve(
      path.startsWith('/v1/reviews') ? BAND_REVIEWS
        : path.startsWith('/v1/branches') ? BAND_BRANCHES
          : path.startsWith('/v1/providers') ? []
            : REPUTATION,
    );
  };
}

describe('Reviews clinic rating bands', () => {
  it('bands and states the thresholds the product default configures', async () => {
    respond = answerBands(() => Promise.resolve(growthPolicy()));
    renderPage();

    await screen.findByText('Riverside');

    // 4.3 sits between the configured fair and good bounds; 2.0 is below both.
    expect(screen.getByText('4.3')).toHaveClass('text-amber-v');
    expect(screen.getByText('2.0')).toHaveClass('text-red-v');
    expect(screen.getByText(/Green at ≥ 4.5, amber at ≥ 4.0, red below/)).toBeInTheDocument();
    expect(screen.getByText(/this workspace has not set its own thresholds yet/)).toBeInTheDocument();
  });

  it('gives a tenant with different bands a different colour and different copy', async () => {
    // Good starts at 4.2 and fair at 1.5, so BOTH clinics move a band: the 4.3
    // clinic goes amber → green and the 2.0 clinic goes red → amber. Restoring
    // either retired literal puts them back and fails this test.
    respond = answerBands(() => Promise.resolve(growthPolicy({
      source: 'tenant', reviewRatingGood: 4.2, reviewRatingFair: 1.5,
    })));
    renderPage();

    await screen.findByText('Riverside');

    expect(screen.getByText('4.3')).toHaveClass('text-emerald-v');
    expect(screen.getByText('2.0')).toHaveClass('text-amber-v');
    expect(screen.getByText(/Green at ≥ 4.2, amber at ≥ 1.5, red below/)).toBeInTheDocument();
    expect(screen.getByText(/Configured for this workspace/)).toBeInTheDocument();
    // The retired literals are nowhere in the copy.
    expect(screen.queryByText(/Green at ≥ 4.5/)).not.toBeInTheDocument();
  });

  it('draws no band while the policy is still in flight, even though the reviews arrived', async () => {
    respond = answerBands(PENDING_FOREVER);
    renderPage();

    // The rest of the page is entitled to speak: the average of the loaded
    // reviews needs no policy, so it renders.
    await screen.findByText('Average rating');
    expect(figureFor('Average rating')).toBe('3.4');

    // The banded panel does not.
    expect(screen.queryByText('Riverside')).not.toBeInTheDocument();
    expect(screen.queryByText('4.3')).not.toBeInTheDocument();
    expect(screen.queryByText('2.0')).not.toBeInTheDocument();
    expect(screen.queryByText(/Green at ≥/)).not.toBeInTheDocument();
    expect(screen.getByText('Loading Clinic ratings…')).toBeInTheDocument();
  });

  it('names the failure instead of falling back to a default band', async () => {
    respond = answerBands(() => Promise.reject(
      new ApiError(403, 'Forbidden', 'insufficient_permission')));
    renderPage();

    const heading = await screen.findByText('Clinic ratings could not be loaded');
    expect(within(heading.closest('[role="alert"]') as HTMLElement)
      .getByText(/no figure here should be read as zero, empty or healthy/)).toBeInTheDocument();

    expect(screen.queryByText('4.3')).not.toBeInTheDocument();
    expect(screen.queryByText('2.0')).not.toBeInTheDocument();
    expect(screen.queryByText(/Green at ≥/)).not.toBeInTheDocument();
  });

  it('refuses a policy it cannot classify with rather than banding against NaN', async () => {
    // Every numeric bound missing. `Number(undefined)` is NaN and every `>=`
    // against NaN is false, so a lenient adapter would have quietly published
    // every clinic in this workspace as red.
    respond = answerBands(() => Promise.resolve({ source: 'tenant' }));
    renderPage();

    await screen.findByText('Clinic ratings could not be loaded');
    expect(screen.getByText(/configured growth thresholds are incomplete/)).toBeInTheDocument();
    expect(screen.queryByText('4.3')).not.toBeInTheDocument();
    expect(screen.queryByText('2.0')).not.toBeInTheDocument();
  });
});

describe('Reviews top provider list', () => {
  const provider = (id: string, name: string, rating: string) => ({
    id, branchId: 'branch-1', specialty: 'General', utilization: 0, appointmentsToday: 0,
    appointmentsThisMonth: 0, rating, reviewCount: 4, revenueThisMonth: '0',
    repeatVisitRate: 0, followUpRate: 0, branch: { name: 'Riverside Clinic' },
    user: { displayName: name },
  });

  it('says how much of the ranked list the card is showing when it cuts one', async () => {
    const providers = [
      provider('p1', 'Ada Okafor', '4.9'), provider('p2', 'Ben Cole', '4.8'),
      provider('p3', 'Cara Diaz', '4.7'), provider('p4', 'Dev Rao', '4.6'),
      provider('p5', 'Eve Marsh', '4.5'), provider('p6', 'Finn Ward', '4.4'),
      provider('p7', 'Gia Nunes', '4.3'),
    ];
    respond = (path: string) => (path.startsWith('/v1/providers')
      ? Promise.resolve(providers)
      : answerEverything(path));
    renderPage();

    await screen.findByText('Ada Okafor');

    // Five listed, and the card admits there are seven.
    expect(screen.getByText('Highest 5 of 7 providers with a recorded rating.')).toBeInTheDocument();
    expect(screen.queryByText('Finn Ward')).not.toBeInTheDocument();
    expect(screen.queryByText('Gia Nunes')).not.toBeInTheDocument();
  });

  it('makes no truncation claim when the whole ranked list fits', async () => {
    respond = (path: string) => (path.startsWith('/v1/providers')
      ? Promise.resolve([provider('p1', 'Ada Okafor', '4.9'), provider('p2', 'Ben Cole', '4.8')])
      : answerEverything(path));
    renderPage();

    await screen.findByText('Ada Okafor');
    expect(screen.getByText('Ben Cole')).toBeInTheDocument();
    expect(screen.queryByText(/providers with a recorded rating\./)).not.toBeInTheDocument();
  });
});
