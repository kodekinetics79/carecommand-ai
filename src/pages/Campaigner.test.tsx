import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import type { Campaign, CampaignLaunchPreview } from '../lib/crm';
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
  providerMode: 'configured_pending_provider', provider: 'twilio', channel: 'sms', scheduledAt: null,
  audience: { total: 240, eligible: 180, suppressed: 44, missingContact: 16, authorityRequired: 12, atomicBoundaryBlocked: 0 },
  liveDispatchActivated: false,
  activationNotice: 'Live campaign dispatch is not activated for SMS in this workspace.',
  finalConfirmationRequired: true,
  confirmationStatement: 'You are authorizing this exact audience, template, channel and provider.',
};

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
function stubLoadedPage(rows: Campaign[] = CAMPAIGNS) {
  handlers['GET /v1/crm/campaigns'] = () => rows;
  handlers['GET /v1/crm/audiences/inactive_patients/preview?channel=sms'] = () => AUDIENCE_PREVIEW;
  for (const row of rows) handlers[`GET /v1/crm/campaigns/${row.id}/deliveries`] = () => [];
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
  });
});

describe('Campaigner attribution honesty', () => {
  it('names attributed revenue as unrecorded instead of printing $0, in every state', async () => {
    renderPage();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());

    // Loading: the absence is not a loading problem, so it is stated already.
    const tile = screen.getByText('Attributed revenue').closest('div')?.parentElement;
    expect(tile).not.toBeNull();
    expect(within(tile as HTMLElement).getByText('Not recorded yet')).toBeInTheDocument();
    expect(within(tile as HTMLElement).queryByText(BARE_FIGURE)).toBeNull();
    expect(screen.getByText(/No delivery is tied to a booking or a payment yet/)).toBeInTheDocument();
  });

  it('keeps the unevidenced figure unevidenced after a successful load', async () => {
    stubLoadedPage();
    renderPage();

    await screen.findByText('Awaiting approval');

    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    // Nothing on the page claims an open rate, a booking count or a revenue
    // figure — no code path records any of them.
    expect(screen.queryByText('Open Rate')).not.toBeInTheDocument();
    expect(screen.queryByText('Recorded Bookings')).not.toBeInTheDocument();
    // The same discipline per campaign: the row carries revenue/opened/booked
    // columns nothing writes, so the detail states the absence.
    expect(await screen.findByText(/Response, open and revenue outcomes are not recorded/)).toBeInTheDocument();
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
    renderPage();

    expect(await screen.findByText(/Audience evidence is unavailable/)).toBeInTheDocument();
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
