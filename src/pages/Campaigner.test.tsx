import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

// The module boundary every request on this page goes through: `useResource`
// and the whole `crmApi` client both call `apiRequest`.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../lib/api';
import type {
  Campaign, CampaignLaunchPreview, CampaignAttributionSummary, CampaignAttributionSummaryRow,
  CampaignAttributionDetail,
} from '../lib/crm';
import Campaigner from './Campaigner';

/**
 * Campaigner is now the one campaign destination, on the one campaign backend.
 *
 * It used to be the planner over `/v1/campaigns` — a thin CRUD whose schema
 * cannot set a campaign type, an audience or an approval, so nothing it created
 * could ever dispatch. These tests hold four things shut:
 *
 *   * every figure comes from a response, and no figure is printed while a
 *     request is in flight or after it failed;
 *   * a figure the data cannot evidence is named as absent, never as $0;
 *   * the goal a user picked survives the navigation into the creator;
 *   * approval and launch go through the fingerprinted exact-preview
 *     confirmation, and the forgeable legacy status write is never called.
 */

/** Anything a reader would take for a stat value: 12, 0, 3.4, 15%, $12,500. */
const BARE_FIGURE = /^\$?-?[\d,]+(\.\d+)?%?$/;

const KPI_LABELS = ['Recorded campaigns', 'Awaiting approval', 'Running'];

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1', name: 'Six-month recall',
    campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients',
    channel: 'sms', status: 'ACTIVE', requiresApproval: true,
    approvedByUserId: 'user-1', approvedAt: '2026-08-20T09:00:00.000Z', scheduledAt: null,
    messageSubject: null, messageTemplate: 'Hi {{firstName}}, it has been a while.',
    draftSource: 'rule_based', audienceSize: 240,
    allowedActions: ['pause', 'cancel'], deepLinkTarget: 'campaign/campaign-1',
    requiresApprovalPending: false, archivedAt: null,
    dispatchAuthorizedAt: '2026-08-20T09:05:00.000Z', dispatchAuthorizedByUserId: 'user-1',
    dispatchAuthorizationRecorded: true,
    ...overrides,
  };
}

const RUNNING = campaign();
const AWAITING_APPROVAL = campaign({
  id: 'campaign-2', name: 'Hygiene follow-up', status: 'APPROVAL_REQUIRED',
  approvedByUserId: null, approvedAt: null, requiresApprovalPending: true,
  audienceSize: 80, allowedActions: ['edit', 'generate_draft', 'approve'],
  dispatchAuthorizedAt: null, dispatchAuthorizedByUserId: null, dispatchAuthorizationRecorded: false,
});
const CAMPAIGNS = [RUNNING, AWAITING_APPROVAL];

const AUDIENCE_PREVIEW = {
  audienceType: 'inactive_patients', channel: 'sms',
  total: 240, eligible: 180, suppressed: 44, missingContact: 16,
  sample: [{ name: 'Idris Bennett', reason: 'No visit in 14 months', destinationMasked: '+1 ••• ••01' }],
};

const LAUNCH_PREVIEW: CampaignLaunchPreview = {
  campaignId: 'campaign-2', fingerprint: 'a'.repeat(64), templateRevision: 'rev-3',
  providerMode: 'configured_pending_provider', channel: 'sms', scheduledAt: null,
  audience: { total: 240, eligible: 180, suppressed: 44, missingContact: 16, authorityRequired: 12, atomicBoundaryBlocked: 0 },
  liveDispatchActivated: false,
  activationNotice: 'Live campaign dispatch is not activated for SMS in this workspace.',
  finalConfirmationRequired: true,
  confirmationStatement: 'You are authorizing this exact audience, template, channel and provider.',
};

// --- Attribution fixtures --------------------------------------------------
// Shaped exactly as GET /v1/crm/attribution/summary and
// GET /v1/crm/campaigns/:id/attribution answer, including the `basis` both ship
// with their figures and the engagement disclosure the server pins to null.

const ENGAGEMENT = {
  openRate: null, responseRate: null, unavailableReason: 'no_truthful_open_or_reply_receipt',
} as const;

const ATTRIBUTION_BASIS: CampaignAttributionSummary['basis'] = {
  derivedFrom: 'CampaignAttribution rows only',
  rules: {
    booked: 'last-accepted-delivery-before-booking@v1',
    attended: 'attendance-on-attributed-appointment@v1',
    paid: 'net-payment-on-attributed-appointment@v1',
  },
  evidenceableOutcomes: ['booked', 'attended', 'paid'],
  valueBasis: 'attributedValue is the net of PaymentTransactions actually recorded against the attributed appointment. A booking and an attendance carry 0. No per-event constant is imputed anywhere.',
  windowSource: 'GrowthPolicy.campaignAttributionWindowDays, captured on each row at attribution time so a later policy change cannot rewrite it',
  notAttributed: 'An outcome that cannot be tied to a provider-accepted delivery inside that delivery\'s window is not attributed at all.',
};

function attributionRow(overrides: Partial<CampaignAttributionSummaryRow> = {}): CampaignAttributionSummaryRow {
  return {
    campaignId: 'campaign-1', name: 'Six-month recall',
    campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients',
    branchId: null, status: 'ACTIVE', providerAcceptedDeliveries: 180,
    // The shape the server sends for a campaign nothing has been attributed to:
    // zero outcomes and the STRING '0.00', which is a sum of no rows.
    outcomes: { engaged: 0, booked: 0, attended: 0, paid: 0 },
    attributedValue: '0.00', currency: null, windowDaysObserved: [],
    firstAttributedAt: null, lastAttributedAt: null,
    engagement: { ...ENGAGEMENT }, deepLinkTarget: 'campaign/campaign-1',
    ...overrides,
  };
}

const NO_ATTRIBUTION: CampaignAttributionSummary = {
  campaigns: [attributionRow(), attributionRow({ campaignId: 'campaign-2', name: 'Hygiene follow-up', status: 'APPROVAL_REQUIRED', providerAcceptedDeliveries: 0 })],
  basis: ATTRIBUTION_BASIS,
};

const EVIDENCED_ATTRIBUTION: CampaignAttributionSummary = {
  campaigns: [
    attributionRow({
      outcomes: { engaged: 0, booked: 9, attended: 4, paid: 3 },
      attributedValue: '4210.50', currency: 'usd', windowDaysObserved: [30],
      firstAttributedAt: '2026-08-02T10:00:00.000Z', lastAttributedAt: '2026-08-24T10:00:00.000Z',
    }),
    attributionRow({ campaignId: 'campaign-2', name: 'Hygiene follow-up', status: 'APPROVAL_REQUIRED', providerAcceptedDeliveries: 0 }),
  ],
  basis: ATTRIBUTION_BASIS,
};

function attributionDetail(overrides: Partial<CampaignAttributionDetail> = {}): CampaignAttributionDetail {
  return {
    campaignId: 'campaign-1',
    outcomes: { engaged: 0, booked: 0, attended: 0, paid: 0 },
    attributedValue: '0.00', currency: null, windowDaysObserved: [],
    firstAttributedAt: null, lastAttributedAt: null,
    engagement: { ...ENGAGEMENT }, attributions: [], deepLinkTarget: 'campaign/campaign-1',
    ...overrides,
  };
}

const EVIDENCED_DETAIL: CampaignAttributionDetail = attributionDetail({
  outcomes: { engaged: 0, booked: 9, attended: 4, paid: 3 },
  attributedValue: '4210.50', currency: 'usd', windowDaysObserved: [30],
  firstAttributedAt: '2026-08-02T10:00:00.000Z', lastAttributedAt: '2026-08-24T10:00:00.000Z',
  attributions: [{
    id: 'attr-1', outcomeType: 'paid', campaignDeliveryId: 'delivery-1',
    patientId: 'patient-1', leadId: null, branchId: 'branch-1', appointmentId: 'appointment-1',
    paymentTransactionId: 'payment-1', attributedValue: '4210.50', currency: 'usd',
    window: { days: 30, startsAt: '2026-08-01T10:00:00.000Z', endsAt: '2026-08-31T10:00:00.000Z', recordedAtAttributionTime: true },
    rule: 'net-payment-on-attributed-appointment@v1', evidence: {}, attributedAt: '2026-08-24T10:00:00.000Z',
  }],
});

/** Never-answering request: what the first frames of every real load look like. */
const PENDING_FOREVER = () => new Promise<never>(() => {});

type Handler = (init?: RequestInit) => unknown;
let handlers: Record<string, Handler>;

beforeEach(() => {
  handlers = {};
  apiRequestMock.mockReset();
  // `async` on purpose: a handler that throws must reach the page as a REJECTED
  // request, exactly as a 500 does, not as a synchronous throw the component
  // never gets the chance to handle.
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? 'GET'} ${path}`];
    // An unregistered endpoint stays pending rather than resolving to
    // undefined: a test must never accidentally assert against a fake answer.
    return handler ? handler(init) : PENDING_FOREVER();
  });
});

/** Registers the reads a fully-loaded page performs. */
function stubLoadedPage(rows: Campaign[] = CAMPAIGNS, attribution: CampaignAttributionSummary = NO_ATTRIBUTION) {
  handlers['GET /v1/crm/campaigns'] = () => rows;
  handlers['GET /v1/crm/audiences/inactive_patients/preview?channel=sms'] = () => AUDIENCE_PREVIEW;
  handlers['GET /v1/crm/attribution/summary'] = () => attribution;
  for (const row of rows) {
    handlers[`GET /v1/crm/campaigns/${row.id}/deliveries`] = () => [];
    handlers[`GET /v1/crm/campaigns/${row.id}/attribution`] = () => attributionDetail({ campaignId: row.id });
  }
}

function renderPage(state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/campaigns', state }]}>
      <Campaigner />
    </MemoryRouter>,
  );
}

/** Every element whose whole text reads as a stat value. */
function renderedFigures() {
  return screen.queryAllByText(BARE_FIGURE).map(element => element.textContent?.trim() ?? '');
}

/**
 * StatCard prints the figure in the paragraph immediately above its label.
 * Scoped to <p> so a filter tab that happens to share a word with a tile
 * ("Running") cannot be mistaken for the tile.
 */
function figureFor(label: string) {
  const labelElement = screen.getByText(label, { selector: 'p' });
  const figure = labelElement.previousElementSibling;
  if (!figure) throw new Error(`No figure is rendered above "${label}"`);
  return figure.textContent?.trim() ?? '';
}

function callsTo(method: string, path: string) {
  return apiRequestMock.mock.calls.filter(([p, init]) =>
    String(p) === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method);
}

/** Every request this page made to the retired analytics CRUD. */
function legacyCampaignCalls() {
  return apiRequestMock.mock.calls.filter(([p]) => String(p).startsWith('/v1/campaigns'));
}

describe('Campaigner portfolio state', () => {
  it('renders no figure at all while the campaign request is in flight', async () => {
    renderPage();

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());

    expect(screen.getByText('Loading campaigns')).toBeInTheDocument();
    for (const label of KPI_LABELS) {
      expect(screen.queryByText(label, { selector: 'p' })).not.toBeInTheDocument();
    }
    // The specific shapes a pending tile used to print.
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(renderedFigures()).toEqual([]);

    // The wait is announced rather than shown as an answer.
    expect(screen.getByText('Loading Campaign library…')).toBeInTheDocument();
  });

  it('prints the figures the response actually supports once it lands', async () => {
    stubLoadedPage();
    renderPage();

    await screen.findByText('Awaiting approval');

    expect(figureFor('Recorded campaigns')).toBe('2');
    expect(figureFor('Awaiting approval')).toBe('1');
    expect(figureFor('Running')).toBe('1');
    expect(screen.getByText('1 running · 2 recorded')).toBeInTheDocument();
  });

  it('renders no figure when the campaign request fails', async () => {
    handlers['GET /v1/crm/campaigns'] = () => {
      throw new ApiError(500, 'Something went wrong on our side. Please try again in a moment.', 'INTERNAL_SERVER_ERROR');
    };
    renderPage();

    const totals = await screen.findByText('Campaign totals could not be loaded');
    const notice = totals.closest('[role="alert"]');
    expect(notice).not.toBeNull();
    expect(within(notice as HTMLElement).getByText('Not loaded — do not read as zero.')).toBeInTheDocument();

    expect(screen.getByText('Data unavailable')).toBeInTheDocument();
    for (const label of KPI_LABELS) {
      expect(screen.queryByText(label, { selector: 'p' })).not.toBeInTheDocument();
    }
    expect(renderedFigures()).toEqual([]);
    // Not a zero, and not an empty workspace either.
    expect(screen.queryByText('No campaigns recorded yet')).not.toBeInTheDocument();
    // One retry beside the tiles, one beside the library.
    expect(screen.getAllByRole('button', { name: /try again/i })).toHaveLength(2);
  });

  it('prints a zero only because the response said the workspace has none', async () => {
    handlers['GET /v1/crm/campaigns'] = () => [];
    renderPage();

    await screen.findByText('Awaiting approval');

    // The distinction the whole contract exists for: this 0 is a fact about the
    // workspace, and it is reachable only from a response that carried it.
    expect(figureFor('Recorded campaigns')).toBe('0');
    expect(figureFor('Awaiting approval')).toBe('0');
    expect(figureFor('Running')).toBe('0');
    expect(screen.getByText('No campaigns recorded yet')).toBeInTheDocument();
  });

  it('does not refetch any endpoint on re-render', async () => {
    stubLoadedPage();
    renderPage();

    await screen.findByText('Audience preview');
    await new Promise(resolve => setTimeout(resolve, 40));

    expect(callsTo('GET', '/v1/crm/campaigns')).toHaveLength(1);
    expect(callsTo('GET', '/v1/crm/audiences/inactive_patients/preview?channel=sms')).toHaveLength(1);
    expect(callsTo('GET', '/v1/crm/campaigns/campaign-1/deliveries')).toHaveLength(1);
    // The two attribution reads are held to the same rule: one request per
    // endpoint per mount, however many times the page re-renders.
    expect(callsTo('GET', '/v1/crm/attribution/summary')).toHaveLength(1);
    expect(callsTo('GET', '/v1/crm/campaigns/campaign-1/attribution')).toHaveLength(1);
  });
});

describe('Campaigner attribution honesty', () => {
  /**
   * The tile is now wired to GET /v1/crm/attribution/summary. The guarantee it
   * carried before — never "$0 attributed" — is unchanged; what moved is WHERE
   * the absence is stated. It is no longer asserted while the request is in
   * flight, because "no delivery is tied to a payment" is a claim about the
   * workspace and only a response can support it.
   */
  it('prints no figure and claims no absence while the attribution request is in flight', async () => {
    // The campaign list answers; attribution stays pending, so the tile is the
    // only thing still loading.
    handlers['GET /v1/crm/campaigns'] = () => CAMPAIGNS;
    handlers['GET /v1/crm/audiences/inactive_patients/preview?channel=sms'] = () => AUDIENCE_PREVIEW;
    renderPage();

    await screen.findByText('Awaiting approval');

    // No amount, and no verdict about the workspace either.
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('Not recorded yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/No delivery is tied to a booking or a payment yet/)).not.toBeInTheDocument();
    // …and no basis note, which would imply a figure had been produced.
    expect(screen.queryByText(/How every attributed figure on this page was produced/)).not.toBeInTheDocument();
    expect(screen.getByText('Loading Attributed revenue…')).toBeInTheDocument();
  });

  it('renders no figure, and no absence claim, when the attribution request fails', async () => {
    stubLoadedPage();
    handlers['GET /v1/crm/attribution/summary'] = () => {
      throw new ApiError(500, 'Something went wrong on our side. Please try again in a moment.', 'INTERNAL_SERVER_ERROR');
    };
    renderPage();

    const notice = (await screen.findByText('Attributed revenue could not be loaded')).closest('[role="alert"]');
    expect(notice).not.toBeNull();
    expect(within(notice as HTMLElement).getByText('Not loaded — do not read as zero.')).toBeInTheDocument();
    expect(within(notice as HTMLElement).queryByText(BARE_FIGURE)).toBeNull();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    // A failed request must not be readable as "nothing was attributed".
    expect(screen.queryByText('Not recorded yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/How every attributed figure on this page was produced/)).not.toBeInTheDocument();
  });

  it('states the absence, never $0, when the response carries no attributed payment', async () => {
    stubLoadedPage();
    renderPage();

    await screen.findByText('Awaiting approval');

    // The response arrived and carried `attributedValue: '0.00'` for every
    // campaign. That string is a sum of no rows, and printing it as $0.00 is
    // the defect: the tile reads the `paid` outcome COUNT instead.
    const tile = (await screen.findByText('Attributed revenue')).closest('div')?.parentElement;
    expect(tile).not.toBeNull();
    expect(within(tile as HTMLElement).getByText('Not recorded yet')).toBeInTheDocument();
    expect(within(tile as HTMLElement).queryByText(BARE_FIGURE)).toBeNull();
    expect(within(tile as HTMLElement).getByText(/No delivery is tied to a booking or a payment yet/)).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    // No manufactured engagement figure anywhere on the page.
    expect(screen.queryByText('Open Rate')).not.toBeInTheDocument();
    expect(screen.queryByText('Recorded Bookings')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('prints the attributed amount, and its basis, once evidence exists', async () => {
    stubLoadedPage(CAMPAIGNS, EVIDENCED_ATTRIBUTION);
    renderPage();

    await screen.findByText('Awaiting approval');

    // 3 `paid` rows totalling 4210.50 USD — a real figure, so it is shown.
    expect(figureFor('Attributed revenue')).toMatch(/4,210\.50/);
    const basis = (await screen.findByText(/How every attributed figure on this page was produced/)).parentElement as HTMLElement;
    expect(screen.getByText('3 attributed payments across 1 campaign')).toBeInTheDocument();
    expect(screen.queryByText('Not recorded yet')).not.toBeInTheDocument();

    // And the provenance the API shipped with it: window, value basis, rules.
    expect(within(basis).getByText(/30-day/)).toBeInTheDocument();
    expect(within(basis).getByText(/GrowthPolicy.campaignAttributionWindowDays/)).toBeInTheDocument();
    expect(within(basis).getByText(/net of PaymentTransactions actually recorded against the attributed appointment/)).toBeInTheDocument();
    expect(within(basis).getByText('last-accepted-delivery-before-booking@v1')).toBeInTheDocument();
    expect(within(basis).getByText('net-payment-on-attributed-appointment@v1')).toBeInTheDocument();
    expect(within(basis).getByText(/cannot be tied to a provider-accepted delivery inside that delivery/)).toBeInTheDocument();
    expect(within(basis).getByText(/CampaignAttribution rows only/)).toBeInTheDocument();
  });

  it('never adds attributed amounts recorded in different currencies', async () => {
    stubLoadedPage(CAMPAIGNS, {
      basis: ATTRIBUTION_BASIS,
      campaigns: [
        attributionRow({ outcomes: { engaged: 0, booked: 2, attended: 1, paid: 1 }, attributedValue: '100.00', currency: 'usd', windowDaysObserved: [30] }),
        attributionRow({ campaignId: 'campaign-2', outcomes: { engaged: 0, booked: 1, attended: 0, paid: 1 }, attributedValue: '90.00', currency: 'gbp', windowDaysObserved: [30] }),
      ],
    });
    renderPage();

    await screen.findByText('Awaiting approval');

    const tile = (await screen.findByText('Attributed revenue')).closest('div')?.parentElement as HTMLElement;
    expect(within(tile).getByText(/recorded in USD and GBP/)).toBeInTheDocument();
    expect(within(tile).getByText('Not recorded yet')).toBeInTheDocument();
    expect(within(tile).queryByText(BARE_FIGURE)).toBeNull();
    // The bookings ARE evidenced, and are stated as what they are.
    expect(within(tile).getByText(/3 attributed bookings recorded. A booking is an outcome, not revenue./)).toBeInTheDocument();
  });
});

describe('Campaigner per-campaign outcomes', () => {
  it('shows the selected campaign\'s attributed outcomes and the reason there is no open rate', async () => {
    handlers['GET /v1/crm/campaigns'] = () => [RUNNING];
    handlers['GET /v1/crm/audiences/inactive_patients/preview?channel=sms'] = () => AUDIENCE_PREVIEW;
    handlers['GET /v1/crm/attribution/summary'] = () => EVIDENCED_ATTRIBUTION;
    handlers['GET /v1/crm/campaigns/campaign-1/deliveries'] = () => [];
    handlers['GET /v1/crm/campaigns/campaign-1/attribution'] = () => EVIDENCED_DETAIL;
    renderPage();

    const outcomes = (await screen.findByText('Attributed outcomes')).parentElement as HTMLElement;

    expect(within(outcomes).getByText('9')).toBeInTheDocument();
    expect(within(outcomes).getByText(/attributed bookings/)).toBeInTheDocument();
    expect(within(outcomes).getByText('4')).toBeInTheDocument();
    expect(within(outcomes).getByText(/4,210\.50/)).toBeInTheDocument();
    expect(within(outcomes).getByText(/1 evidence row/)).toBeInTheDocument();
    expect(within(outcomes).getByText(/30-day attribution window as recorded on each row/)).toBeInTheDocument();

    // Engagement: the stated reason, never a percentage.
    expect(within(outcomes).getByText(/no provider gives this platform a truthful open or reply receipt/)).toBeInTheDocument();
    expect(within(outcomes).queryByText('0%')).toBeNull();
    expect(screen.queryByText(/Open rate 0%/)).not.toBeInTheDocument();
    // The claim this replaced is gone because the outcomes are now recorded.
    expect(screen.queryByText(/Response, open and revenue outcomes are not recorded/)).not.toBeInTheDocument();
  });

  it('states the absence of attributed revenue per campaign rather than $0.00', async () => {
    stubLoadedPage([RUNNING]);
    renderPage();

    const outcomes = (await screen.findByText('Attributed outcomes')).parentElement as HTMLElement;

    expect(within(outcomes).getByText('not recorded yet')).toBeInTheDocument();
    // No currency-formatted amount anywhere in the block. (The honest sentence
    // itself names "$0" as the thing it refuses to print, so the assertion is
    // against a rendered AMOUNT, not against the word.)
    expect(within(outcomes).queryByText(/^\$[\d,]+\.\d{2}$/)).toBeNull();
    expect(within(outcomes).getByText(/No delivery is tied to a booking or a payment yet/)).toBeInTheDocument();
    // The counts are counts of evidence rows, so a response carrying none is a
    // truthful zero about attribution — not a claim that nothing was measured.
    expect(within(outcomes).getByText(/0 evidence rows/)).toBeInTheDocument();
  });

  it('prints no per-campaign outcome figure while the read is in flight or after it fails', async () => {
    handlers['GET /v1/crm/campaigns'] = () => [RUNNING];
    handlers['GET /v1/crm/audiences/inactive_patients/preview?channel=sms'] = () => AUDIENCE_PREVIEW;
    handlers['GET /v1/crm/attribution/summary'] = () => NO_ATTRIBUTION;
    handlers['GET /v1/crm/campaigns/campaign-1/deliveries'] = () => [];
    // In flight.
    renderPage();
    expect(await screen.findByText('Loading attributed outcomes…')).toBeInTheDocument();
    expect(screen.queryByText('Attributed outcomes')).not.toBeInTheDocument();

    cleanup();

    // Failed.
    handlers['GET /v1/crm/campaigns/campaign-1/attribution'] = () => {
      throw new ApiError(500, 'Attribution failed', 'INTERNAL_SERVER_ERROR');
    };
    renderPage();

    expect(await screen.findByText(/Attribution evidence is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('Attributed outcomes')).not.toBeInTheDocument();
    expect(screen.queryByText(/Do not infer that this campaign produced no bookings or no revenue/)).toBeInTheDocument();
  });
});

describe('Campaigner handoff', () => {
  it('carries a goal chosen elsewhere into the creator, prefilled', async () => {
    stubLoadedPage();
    renderPage({ goal: 'winback', source: 'CRM', contextLabel: '412 patients with no visit in 12 months' });

    await screen.findByText('New campaign draft');

    expect((screen.getByLabelText('Campaign type') as HTMLSelectElement).value).toBe('inactive_patient_reactivation');
    expect((screen.getByLabelText('Audience type') as HTMLSelectElement).value).toBe('inactive_patients');
    expect(screen.getByText('412 patients with no visit in 12 months')).toBeInTheDocument();
    expect(screen.getByText(/Carried over from CRM/)).toBeInTheDocument();
  });

  it('carries the ClinicRadar / Advisory payload shape rather than dropping it', async () => {
    stubLoadedPage();
    renderPage({ goal: 'reviews', title: 'Reputation slipping', branchName: 'Northgate', source: 'ClinicRadar' });

    await screen.findByText('New campaign draft');

    expect((screen.getByLabelText('Campaign type') as HTMLSelectElement).value).toBe('review_request');
    expect(screen.getByText('Reputation slipping · Northgate')).toBeInTheDocument();
  });

  it('opens no creator, and invents no audience, for a payload-free arrival', async () => {
    stubLoadedPage();
    renderPage();

    await screen.findByText('Audience preview');

    expect(screen.queryByText('New campaign draft')).not.toBeInTheDocument();
  });

  it('picks up a goal chosen on the page itself and never guesses an audience', async () => {
    stubLoadedPage();
    renderPage();

    await screen.findByText('Awaiting approval');
    fireEvent.click(screen.getByText('Recover failed payments'));

    expect((await screen.findByLabelText('Campaign type') as HTMLSelectElement).value).toBe('failed_payment_recovery');
    expect((screen.getByLabelText('Audience type') as HTMLSelectElement).value).toBe('failed_payment_recovery');

    // With no goal there is no audience, and creation stays blocked until the
    // operator says who is being contacted.
    fireEvent.change(screen.getByLabelText('Audience type'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('Q3 reactivation'), { target: { value: 'Failed card recovery' } });
    expect(screen.getByRole('button', { name: /^Create$/ })).toBeDisabled();
  });
});

describe('Campaigner governed workflow', () => {
  it('creates, approves and launch-previews from this one page', async () => {
    stubLoadedPage();
    const created = campaign({
      id: 'campaign-3', name: 'Q3 reactivation', status: 'APPROVAL_REQUIRED',
      approvedByUserId: null, approvedAt: null, requiresApprovalPending: true,
      allowedActions: ['edit', 'generate_draft', 'approve'],
      dispatchAuthorizedAt: null, dispatchAuthorizedByUserId: null, dispatchAuthorizationRecorded: false,
    });
    handlers['POST /v1/crm/campaigns'] = () => created;
    handlers['GET /v1/crm/campaigns/campaign-3/deliveries'] = () => [];
    handlers['GET /v1/crm/campaigns/campaign-3/launch-preview'] = () => ({ ...LAUNCH_PREVIEW, campaignId: 'campaign-3' });
    handlers['POST /v1/crm/campaigns/campaign-3/approve'] = () => ({ ...created, requiresApprovalPending: false, allowedActions: ['launch'] });

    renderPage({ goal: 'winback' });
    await screen.findByText('New campaign draft');

    // 1. Create — the goal's type and audience are already on the request.
    fireEvent.change(screen.getByPlaceholderText('Q3 reactivation'), { target: { value: 'Q3 reactivation' } });
    handlers['GET /v1/crm/campaigns'] = () => [created, ...CAMPAIGNS];
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await screen.findByRole('button', { name: /Review and approve/ });
    const createBody = JSON.parse(String((callsTo('POST', '/v1/crm/campaigns')[0][1] as RequestInit).body));
    expect(createBody).toMatchObject({
      name: 'Q3 reactivation', campaignType: 'inactive_patient_reactivation',
      audienceType: 'inactive_patients', channel: 'sms',
    });

    // 2. Approve — only against the exact server preview, and only after the
    //    operator confirms the audience breakdown that preview reported.
    fireEvent.click(screen.getByRole('button', { name: /Review and approve/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/You are authorizing this exact audience, template, channel and provider/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Eligible: 180/)).toBeInTheDocument();
    expect(within(dialog).getByText(/suppressed: 44/)).toBeInTheDocument();
    expect(within(dialog).getByText(/missing contact: 16/)).toBeInTheDocument();
    expect(within(dialog).getByText(/consent record required: 12/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Authorize exact preview' }));

    await waitFor(() => expect(callsTo('POST', '/v1/crm/campaigns/campaign-3/approve')).toHaveLength(1));
    const approveBody = JSON.parse(String((callsTo('POST', '/v1/crm/campaigns/campaign-3/approve')[0][1] as RequestInit).body));
    // The fingerprint is the one the server just issued, not one the page made up.
    expect(approveBody).toEqual({ previewFingerprint: 'a'.repeat(64), confirmExactAudienceTemplateProvider: true });
    expect(callsTo('GET', '/v1/crm/campaigns/campaign-3/launch-preview')).toHaveLength(1);
  });

  it('will not dispatch without a fresh exact preview and an explicit confirmation', async () => {
    const launchable = campaign({
      id: 'campaign-4', name: 'Deposit chase', status: 'SCHEDULED',
      requiresApprovalPending: false, allowedActions: ['launch', 'cancel'],
    });
    stubLoadedPage([launchable]);
    handlers['GET /v1/crm/campaigns/campaign-4/launch-preview'] = () => ({ ...LAUNCH_PREVIEW, campaignId: 'campaign-4' });
    handlers['POST /v1/crm/campaigns/campaign-4/launch'] = () => ({
      campaignId: 'campaign-4', status: 'ACTIVE', setupRequired: false,
      summary: { total: 240, accepted: 180, deliveryUnknown: 0, suppressed: 44, skipped: 16, setupRequired: 0, queued: 0, failed: 0, authorityBlocked: 0, atomicBoundaryBlocked: 0 },
      provider: { channel: 'sms', configured: true, setupRequired: false, missing: [], mode: 'live_supported', liveDispatchActivated: true },
      launchFingerprint: 'a'.repeat(64),
    });

    renderPage();
    const launchButton = await screen.findByRole('button', { name: /Review and launch/ });

    // Opening the review dispatches nothing.
    fireEvent.click(launchButton);
    const dialog = await screen.findByRole('dialog');
    expect(callsTo('POST', '/v1/crm/campaigns/campaign-4/launch')).toHaveLength(0);

    // Backing out of the confirmation dispatches nothing either.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(callsTo('POST', '/v1/crm/campaigns/campaign-4/launch')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Review and launch/ }));
    const reopened = await screen.findByRole('dialog');
    fireEvent.click(within(reopened).getByRole('button', { name: 'Dispatch exact preview' }));

    await waitFor(() => expect(callsTo('POST', '/v1/crm/campaigns/campaign-4/launch')).toHaveLength(1));
    const launchBody = JSON.parse(String((callsTo('POST', '/v1/crm/campaigns/campaign-4/launch')[0][1] as RequestInit).body));
    expect(launchBody).toEqual({ force: false, previewFingerprint: 'a'.repeat(64), confirmExactAudienceTemplateProvider: true });
    // Two launches, two previews: the fingerprint is never reused from memory.
    expect(callsTo('GET', '/v1/crm/campaigns/campaign-4/launch-preview')).toHaveLength(2);
  });

  it('shows the audience and dispatch evidence, and refuses to imply either when it is missing', async () => {
    handlers['GET /v1/crm/campaigns'] = () => [RUNNING];
    handlers['GET /v1/crm/audiences/inactive_patients/preview?channel=sms'] = () => {
      throw new ApiError(500, 'Audience preview failed', 'INTERNAL_SERVER_ERROR');
    };
    handlers['GET /v1/crm/campaigns/campaign-1/deliveries'] = () => {
      throw new ApiError(500, 'Deliveries failed', 'INTERNAL_SERVER_ERROR');
    };
    handlers['GET /v1/crm/campaigns/campaign-1/attribution'] = () => {
      throw new ApiError(500, 'Attribution failed', 'INTERNAL_SERVER_ERROR');
    };
    renderPage();

    expect(await screen.findByText(/Audience evidence is unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Attribution evidence is unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Dispatch evidence is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('No dispatch records are stored for this campaign.')).not.toBeInTheDocument();
  });

  it('pauses through the governed endpoint and never touches the retired status write', async () => {
    stubLoadedPage([RUNNING]);
    handlers['POST /v1/crm/campaigns/campaign-1/pause'] = () => ({ ...RUNNING, status: 'PAUSED' });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Pause/ }));

    await waitFor(() => expect(callsTo('POST', '/v1/crm/campaigns/campaign-1/pause')).toHaveLength(1));
    // The forgeable path — PATCH /v1/campaigns/:id { status } — set campaign
    // state with no fingerprint, approval or audience check. This page has no
    // remaining call to it in any flow.
    expect(legacyCampaignCalls()).toEqual([]);
  });
});
