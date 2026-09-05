import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

const sessionMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useSession', () => ({ useSession: sessionMock }));

import { ApiError } from '../lib/api';
import { notifyFrontDeskMutated, resetFrontDeskPollForTests } from '../hooks/useFrontDeskPoll';
import FrontDesk from './FrontDesk';

/**
 * The front desk is the page a clinic runs its day on, so the claims it makes
 * have to be exact: a lane that could not load says so (it never renders as
 * "nothing to do"), a caller's number is never printed in full from a LIST,
 * every count is the server's rather than the length of a truncated page, and
 * nothing is booked or acknowledged until the server said it was.
 */

const FULL_GRANTS = [
  'staff:read', 'staff:task-status', 'receptionist:call-artifacts:read',
  'receptionist:booking-review', 'appointment:write', 'patient:read',
];

function signedIn(permissions: string[] = FULL_GRANTS) {
  sessionMock.mockReturnValue({
    user: { id: 'user-1', email: 'front@desk.test', displayName: 'Ann Front', role: 'FRONT_DESK', tenant: { id: 't1', name: 'T', slug: 't' }, active: true, effectivePermissions: permissions },
    loading: false,
  });
}

const CLINIC = { id: 'clinic-1', name: 'Brightsmile Dental', timezone: 'America/Los_Angeles' };

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1', title: 'Message from a caller', priority: 'high', status: 'OPEN',
    dueAt: '2026-08-29T18:00:00.000Z', createdAt: '2026-08-29T17:30:00.000Z',
    branchId: null, branch: null, assignedToId: null, assignedTo: null,
    acknowledgedAt: null, acknowledgedBy: null, completedAt: null, outcomeCode: null, outcomeNote: null,
    callLogId: 'call-1', patientId: null, patient: null,
    clinic: { id: CLINIC.id, name: CLINIC.name, timezone: CLINIC.timezone },
    receptionist: {
      kind: 'message', callerName: 'Jordan Vale',
      callbackPhoneMasked: '***-***-4242', verifiedPhoneMasked: '***-***-4242', requestedPhoneMasked: null,
      hasRequestedPhone: false, messages: [{ text: 'Please call me back about a crown.', recordedAt: '2026-08-29T17:30:00.000Z' }],
      messageCount: 1, reasonCategory: 'billing', callbackWindow: null, transferStatus: 'not_attempted',
      transferUpdatedAt: null, toolName: null, denialReason: null, appointmentRequestId: null, appointmentId: null,
      staffNotes: [], source: 'webhook_call_ended', requiresAcknowledgement: true, remediation: null, clinicId: CLINIC.id,
    },
    ...overrides,
  };
}

const EMERGENCY = task({
  id: 'task-emergency', title: 'Emergency reported on a call', priority: 'critical',
  receptionist: { ...task().receptionist, kind: 'emergency', callerName: 'Sam Reyes', reasonCategory: 'chest_pain' },
});

/**
 * D9's task, in the shape the hourly re-verify worker actually files today:
 * its own workflow, no `kind`, and the remediation copy in the raw metadata.
 * The page has to recognise it without waiting for the server change.
 */
const DEPLOYMENT_TASK = {
  id: 'task-deploy', title: 'AI receptionist deployment needs attention', priority: 'HIGH', status: 'OPEN',
  dueAt: '2026-08-29T19:00:00.000Z', createdAt: '2026-08-29T17:00:00.000Z',
  branchId: null, branch: null, assignedToId: null, assignedTo: null,
  acknowledgedAt: null, acknowledgedBy: null, completedAt: null, outcomeCode: null, outcomeNote: null,
  callLogId: null, patientId: null, patient: null, clinic: null, receptionist: null,
  metadata: {
    workflow: 'receptionist_deployment', agentId: 'agent-1', clinicId: CLINIC.id, code: 'number_bound',
    title: 'The phone number is not bound to this agent',
    action: 'Re-deploy the campaign so the number points at the published agent.',
    fixHref: '/receptionist-studio?tab=deploy&clinic=clinic-1',
  },
};

const REQUEST = {
  id: 'req-1', branchId: 'branch-1', patientId: null, campaignId: null, callLogId: 'call-2',
  requestedService: 'Cleaning', requestedDateTime: '2026-09-01T17:00:00.000Z',
  collectedName: 'Priya Shah', collectedPhoneMasked: '***-***-9090', collectedEmail: null,
  status: 'PENDING_REVIEW', source: 'voice', missingFields: [], outcomeReason: null,
  bookedAppointmentId: null, bookedAppointment: null,
  callLog: { id: 'call-2', providerCallRef: 'call_x', callerName: 'Priya Shah', direction: 'inbound', startedAt: '2026-08-29T17:00:00.000Z', clinicId: CLINIC.id, patientId: null },
  patient: null, createdAt: '2026-08-29T17:01:00.000Z',
};

const CALL = {
  id: 'call-1', clinicId: CLINIC.id, campaign: null, callerName: 'Jordan Vale', callerPhoneMasked: '***-***-4242',
  patientId: null, patient: null, direction: 'inbound', outcome: 'ESCALATED', durationSeconds: 64,
  startedAt: '2026-08-29T17:29:00.000Z', endedAt: '2026-08-29T17:30:04.000Z', reviewStatus: 'UNREVIEWED',
  recordingConsentStatus: 'ACKNOWLEDGED', recordingAvailable: true, openHandoffCount: 1,
  bookedAppointmentId: null, transcriptSummary: 'Caller asked about a crown.', createdAt: '2026-08-29T17:29:00.000Z',
};

const SUMMARY = {
  openByKind: { message: 1, emergency: 1 }, openNeedsAction: 2, overdue: 0,
  unacknowledgedCritical: [{ id: 'task-emergency', title: 'Emergency reported on a call', createdAt: '2026-08-29T17:31:00.000Z', clinicName: CLINIC.name, workflow: 'receptionist_safety', kind: 'emergency' }],
  unacknowledgedCriticalCount: 1,
  mine: 0, dueWithin30m: 1, generatedAt: '2026-08-29T17:35:00.000Z',
};

const CALL_SUMMARY = { unreviewed: 1, openHandoffs: 1, inbound: 4, outbound: 0, booked: 0, pendingRequests: 1, range: { from: '2026-08-29T00:00:00.000Z', to: '2026-08-29T23:59:59.000Z' } };

const KPIS = {
  period: { from: '2026-08-29T07:00:00.000Z', to: '2026-08-30T06:59:59.000Z', timezone: CLINIC.timezone },
  counts: { inbound: 4, outbound: 0, answeredInbound: 3, booked: 1, escalated: 1, optedOut: 0, pendingRequests: 1, openHandoffs: 1, activeCampaigns: 1, clinics: 1 },
  rates: { bookingRate: 0.3333, containedPct: 0.6666, afterHoursPct: null, callbacksWithinSlaPct: null },
  aht: 74,
  definitions: { version: 'kpi-v2', answeredInbound: 'Inbound calls whose outcome is not NO_ANSWER, FAILED or IN_PROGRESS.', bookingRate: 'Inbound BOOKED / answered inbound. Null when nothing was answered.' },
};

type Handler = (path: string, init?: RequestInit) => unknown;
let routes: Array<[RegExp, string, Handler]>;

/** Register a responder for the first request whose method+path matches. */
function route(method: string, pattern: RegExp, handler: Handler) {
  routes.unshift([pattern, method, handler]);
}

function happyPath() {
  route('GET', /^\/v1\/receptionist\/clinics$/, () => [CLINIC]);
  route('GET', /^\/v1\/tasks\?.*workflow=receptionist_safety/, () => ({ data: [EMERGENCY, task()], nextCursor: null }));
  route('GET', /^\/v1\/tasks\?.*workflow=receptionist_deployment/, () => ({ data: [], nextCursor: null }));
  route('GET', /^\/v1\/tasks\/summary$/, () => SUMMARY);
  route('GET', /^\/v1\/receptionist\/appointment-requests\?/, () => ({ data: [REQUEST], nextCursor: null }));
  route('GET', /^\/v1\/receptionist\/call-logs\/summary/, () => CALL_SUMMARY);
  route('GET', /^\/v1\/receptionist\/call-logs\?/, () => ({ data: [CALL], nextCursor: null }));
  route('GET', /^\/v1\/receptionist\/overview/, () => KPIS);
  route('GET', /^\/v1\/services$/, () => [
    { id: 'svc-1', name: 'Cleaning', category: 'hygiene', active: true, defaultDurationMinutes: 30, bookableByVoice: true, voiceDurationMinutes: 30 },
    { id: 'svc-2', name: 'Crown fitting', category: 'restorative', active: true, defaultDurationMinutes: 60, bookableByVoice: false, voiceDurationMinutes: null },
  ]);
}

function withProviders(availability = 4) {
  route('GET', /^\/v1\/providers\/overview/, () => [
    { id: 'prov-1', branchId: 'branch-1', active: true, specialty: 'Dentistry', branch: { name: 'Main' }, user: { displayName: 'Dr Wu' }, _count: { availability } },
  ]);
  route('GET', /^\/v1\/scheduling\/providers\/prov-1\/slots/, () => ({
    providerId: 'prov-1', date: '2026-09-01', slots: [{ startsAt: '2026-09-01T17:00:00.000Z', endsAt: '2026-09-01T17:30:00.000Z' }],
  }));
}

beforeEach(() => {
  routes = [];
  signedIn();
  resetFrontDeskPollForTests();
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const match = routes.find(([pattern, verb]) => verb === method && pattern.test(path));
    if (!match) throw new Error(`Unexpected request in test: ${method} ${path}`);
    return match[2](path, init);
  });
});

afterEach(() => {
  resetFrontDeskPollForTests();
});

const renderPage = () => render(<MemoryRouter><FrontDesk /></MemoryRouter>);

describe('FrontDesk lanes', () => {
  it('renders each lane from its own source', async () => {
    happyPath();
    renderPage();

    const emergencies = await screen.findByRole('region', { name: 'Emergencies & urgent' });
    expect(await within(emergencies).findByText('Sam Reyes')).toBeInTheDocument();

    const callbacks = screen.getByRole('region', { name: 'Callbacks due' });
    expect(within(callbacks).getByText('Jordan Vale')).toBeInTheDocument();
    expect(within(callbacks).getByText(/Please call me back about a crown/)).toBeInTheDocument();

    const booking = await screen.findByRole('region', { name: 'Booking requests' });
    expect(within(booking).getByText('Priya Shah')).toBeInTheDocument();

    const unread = await screen.findByRole('region', { name: 'Unreviewed calls' });
    expect(within(unread).getByRole('button', { name: 'Call with Jordan Vale' })).toBeInTheDocument();
  });

  it('shows a lane that failed as a failure with a retry, never as an empty queue', async () => {
    happyPath();
    let attempts = 0;
    route('GET', /^\/v1\/tasks\?.*workflow=receptionist_safety/, () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(500, 'The task service is down.', 'INTERNAL');
      return { data: [task()], nextCursor: null };
    });
    renderPage();

    const lane = await screen.findByRole('region', { name: 'Callbacks due' });
    expect(await within(lane).findByText('Callbacks due could not be loaded.')).toBeInTheDocument();
    expect(within(lane).getByText(/Do not read this as an empty queue/)).toBeInTheDocument();
    expect(within(lane).queryByText('No caller is waiting on a callback.')).not.toBeInTheDocument();

    fireEvent.click(within(lane).getByRole('button', { name: 'Retry' }));
    expect(await within(lane).findByText('Jordan Vale')).toBeInTheDocument();
  });

  it('distinguishes an empty lane from a failed one', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/appointment-requests\?/, () => ({ data: [], nextCursor: null }));
    renderPage();
    const lane = await screen.findByRole('region', { name: 'Booking requests' });
    expect(await within(lane).findByText('No booking request is waiting for review.')).toBeInTheDocument();
  });

  it('shows a loading state before any source has answered', () => {
    happyPath();
    route('GET', /^\/v1\/tasks\?.*workflow=receptionist_safety/, () => new Promise<never>(() => {}));
    renderPage();
    expect(screen.getByText(/Loading emergencies & urgent…/)).toBeInTheDocument();
  });
});

describe('FrontDesk scope and navigation', () => {
  it('separates the network queue from clinic-scoped call operations', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/clinics$/, () => [
      CLINIC,
      { id: 'clinic-2', name: 'Brightsmile North', timezone: 'America/New_York' },
    ]);
    renderPage();

    const scope = await screen.findByRole('region', { name: 'Front desk data scope' });
    expect(within(scope).getByText('Network queue · task lanes and header count')).toBeInTheDocument();
    expect(within(scope).getByText('Clinic operations · calls, booking requests and call KPIs')).toBeInTheDocument();
    expect(within(scope).getByRole('combobox', { name: 'Clinic operations scope' })).toHaveValue(CLINIC.id);
  });

  it('provides keyboard-reachable links to every primary action lane', async () => {
    happyPath();
    renderPage();

    const navigation = await screen.findByRole('navigation', { name: 'Jump to queue lane' });
    expect(await within(navigation).findByRole('link', { name: 'Emergencies, 1' })).toHaveAttribute('href', '#queue-emergencies');
    expect(within(navigation).getByRole('link', { name: 'Callbacks, 1' })).toHaveAttribute('href', '#queue-callbacks');
    expect(await within(navigation).findByRole('link', { name: 'Bookings, 1' })).toHaveAttribute('href', '#queue-bookings');
    expect(within(navigation).getByRole('link', { name: 'Unreviewed calls, 1' })).toHaveAttribute('href', '#queue-unreviewed');
  });
});

/** E13 — one number per fact, and a truncated lane that admits it. */
describe('FrontDesk counts', () => {
  it('counts the same inbound population that the unreviewed lane loads', async () => {
    happyPath();
    const summaryRequest = vi.fn((path: string) => { void path; return CALL_SUMMARY; });
    route('GET', /^\/v1\/receptionist\/call-logs\/summary/, summaryRequest);
    renderPage();

    await waitFor(() => expect(summaryRequest).toHaveBeenCalled());
    expect(summaryRequest.mock.calls[0]?.[0]).toContain('direction=inbound');
  });

  it('takes every tile from a server count, not from the length of a truncated page', async () => {
    happyPath();
    // 9 emergencies exist; the lane page carries 2 rows. The tile must read 9.
    route('GET', /^\/v1\/tasks\/summary$/, () => ({
      ...SUMMARY, openByKind: { message: 12, emergency: 9 }, openNeedsAction: 21,
    }));
    route('GET', /^\/v1\/receptionist\/call-logs\/summary/, () => ({ ...CALL_SUMMARY, unreviewed: 37, pendingRequests: 60 }));
    renderPage();

    const tile = async (title: string) => (await screen.findAllByText(title))
      .map(node => node.closest('div.cc-card'))
      .find((card): card is HTMLElement => card instanceof HTMLElement)!;
    await waitFor(async () => expect(within(await tile('Emergencies')).getByText('9')).toBeInTheDocument());
    await waitFor(async () => expect(within(await tile('Booking requests')).getByText('60')).toBeInTheDocument());
    await waitFor(async () => expect(within(await tile('Unreviewed calls')).getByText('37')).toBeInTheDocument());
  });

  it('says "showing N of M" and offers Load more when a lane is truncated', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/call-logs\/summary/, () => ({ ...CALL_SUMMARY, pendingRequests: 60 }));
    route('GET', /^\/v1\/receptionist\/appointment-requests\?/, (path: string) =>
      path.includes('cursor=')
        ? { data: [{ ...REQUEST, id: 'req-2', collectedName: 'Ola Diaz' }], nextCursor: null }
        : { data: [REQUEST], nextCursor: 'req-1' });
    renderPage();

    const lane = await screen.findByRole('region', { name: 'Booking requests' });
    expect(await within(lane).findByText('Showing 1 of 60.')).toBeInTheDocument();
    fireEvent.click(within(lane).getByRole('button', { name: 'Load more' }));
    expect(await within(lane).findByText('Ola Diaz')).toBeInTheDocument();
    expect(within(lane).getByText('Showing 2 of 60.')).toBeInTheDocument();
  });

  it('shows a tile as unavailable rather than zero when its count could not be read', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/call-logs\/summary/, () => { throw new ApiError(503, 'Down.', 'UNAVAILABLE'); });
    renderPage();
    const card = (await screen.findAllByText('Booking requests'))
      .map(node => node.closest('div.cc-card'))
      .find((node): node is HTMLElement => node instanceof HTMLElement)!;
    expect(within(card).getByText('—')).toBeInTheDocument();
    expect(within(card).getByText('Unavailable')).toBeInTheDocument();
    expect(within(card).queryByText('0')).not.toBeInTheDocument();
  });
});

/** E12 / D7 / D8 — the emergency count and what the banner is allowed to announce. */
describe('FrontDesk critical banner', () => {
  it('prints the real emergency count and lists the preview beneath it', async () => {
    happyPath();
    route('GET', /^\/v1\/tasks\/summary$/, () => ({
      ...SUMMARY,
      unacknowledgedCriticalCount: 9,
      unacknowledgedCritical: [1, 2, 3, 4, 5].map(index => ({
        id: `crit-${index}`, title: `Emergency ${index}`, createdAt: '2026-08-29T17:31:00.000Z',
        clinicName: CLINIC.name, workflow: 'receptionist_safety', kind: 'emergency',
      })),
    }));
    renderPage();

    const banner = await screen.findByRole('alert', { name: 'Unacknowledged emergencies' });
    expect(within(banner).getByText('9 emergencies need acknowledgement')).toBeInTheDocument();
    expect(within(banner).getByText(/…and 4 more not listed here/)).toBeInTheDocument();
    expect(await screen.findByText(/2 need action · 9 critical/)).toBeInTheDocument();
  });

  it('says "or more" instead of printing a capped preview as the total', async () => {
    happyPath();
    route('GET', /^\/v1\/tasks\/summary$/, () => {
      const rest: Record<string, unknown> = { ...SUMMARY };
      delete rest.unacknowledgedCriticalCount;
      return {
        ...rest,
        unacknowledgedCritical: [1, 2, 3, 4, 5].map(index => ({
          id: `crit-${index}`, title: `Emergency ${index}`, createdAt: '2026-08-29T17:31:00.000Z', clinicName: CLINIC.name,
        })),
      };
    });
    renderPage();

    const banner = await screen.findByRole('alert', { name: 'Unacknowledged emergencies' });
    expect(within(banner).getByText('5 or more emergencies need acknowledgement')).toBeInTheDocument();
    expect(await screen.findByText(/5\+ critical/)).toBeInTheDocument();
  });

  it('never announces a critical task from another workflow as a clinical emergency', async () => {
    happyPath();
    route('GET', /^\/v1\/tasks\/summary$/, () => ({
      ...SUMMARY,
      unacknowledgedCriticalCount: 2,
      unacknowledgedCritical: [
        { id: 'crit-1', title: 'Chest pain reported', createdAt: '2026-08-29T17:31:00.000Z', clinicName: CLINIC.name, workflow: 'receptionist_safety', kind: 'emergency' },
        { id: 'crit-2', title: 'Insurance batch failed', createdAt: '2026-08-29T17:31:00.000Z', clinicName: null, workflow: 'insurance_reconciliation', kind: null },
      ],
    }));
    renderPage();

    const banner = await screen.findByRole('alert', { name: 'Unacknowledged emergencies' });
    expect(within(banner).getByText('Chest pain reported')).toBeInTheDocument();
    expect(within(banner).queryByText('Insurance batch failed')).not.toBeInTheDocument();
    expect(within(banner).getByText('1 emergency needs acknowledgement')).toBeInTheDocument();
  });
});

/** E11 / D9 — the task that says the receptionist is off the air. */
describe('FrontDesk service status', () => {
  it('shows a deployment-attention task filed under its own workflow, with the fix link', async () => {
    happyPath();
    route('GET', /^\/v1\/tasks\?.*workflow=receptionist_deployment/, () => ({ data: [DEPLOYMENT_TASK], nextCursor: null }));
    renderPage();

    const lane = await screen.findByRole('region', { name: 'Service status' });
    expect(await within(lane).findByText(/Your AI receptionist needs attention/)).toBeInTheDocument();
    expect(within(lane).getByText('The phone number is not bound to this agent')).toBeInTheDocument();
    expect(within(lane).getByText('Re-deploy the campaign so the number points at the published agent.')).toBeInTheDocument();
    expect(within(lane).getByRole('link', { name: 'Fix this' })).toHaveAttribute('href', '/receptionist-studio?tab=deploy&clinic=clinic-1');
    // …and it is not mixed into the caller lanes.
    expect(within(screen.getByRole('region', { name: 'Callbacks due' })).queryByText(/deployment needs attention/)).not.toBeInTheDocument();
  });

  it('shows the same task when Package D files it as a deployment_attention kind on the safety workflow', async () => {
    happyPath();
    route('GET', /^\/v1\/tasks\?.*workflow=receptionist_safety/, () => ({
      data: [task({
        id: 'task-deploy-2', title: 'AI receptionist deployment needs attention', priority: 'critical',
        receptionist: {
          ...task().receptionist, kind: 'deployment_attention', callerName: null, messages: [],
          remediation: { code: 'agent_verified', title: 'Verification lapsed', action: 'Re-verify the agent.', fixHref: '/receptionist-studio?tab=campaign' },
        },
      })],
      nextCursor: null,
    }));
    renderPage();

    const lane = await screen.findByRole('region', { name: 'Service status' });
    expect(await within(lane).findByText('Verification lapsed')).toBeInTheDocument();
    expect(within(lane).getByRole('link', { name: 'Fix this' })).toHaveAttribute('href', '/receptionist-studio?tab=campaign');
  });

  it('states the healthy case rather than rendering nothing, and never claims health when the read failed', async () => {
    happyPath();
    renderPage();
    const lane = await screen.findByRole('region', { name: 'Service status' });
    expect(await within(lane).findByText(/No deployment alert is open/)).toBeInTheDocument();

    routes = [];
    happyPath();
    route('GET', /^\/v1\/tasks\?.*workflow=receptionist_safety/, () => { throw new ApiError(503, 'Tasks are down.', 'UNAVAILABLE'); });
    route('GET', /^\/v1\/tasks\?.*workflow=receptionist_deployment/, () => { throw new ApiError(503, 'Tasks are down.', 'UNAVAILABLE'); });
    resetFrontDeskPollForTests();
    const second = renderPage();
    const failedLane = await within(second.container).findByRole('region', { name: 'Service status' });
    expect(await within(failedLane).findByText('Service status could not be loaded.')).toBeInTheDocument();
    expect(within(failedLane).getByText(/does NOT mean the line is answering/)).toBeInTheDocument();
  });
});

/** SF-2 — the shift report. */
describe('FrontDesk shift report', () => {
  it('renders the kpi-v2 block with its definitions', async () => {
    happyPath();
    renderPage();
    const report = await screen.findByRole('region', { name: 'Shift report' });
    expect(await within(report).findByText('Answered inbound')).toBeInTheDocument();
    expect(within(report).getByText('3')).toBeInTheDocument();
    expect(within(report).getByText('33%')).toBeInTheDocument();
    expect(within(report).getByText('1m 14s')).toBeInTheDocument();
    expect(within(report).getByText(/Inbound BOOKED \/ answered inbound/)).toBeInTheDocument();
    expect(within(report).getByText(`Call KPIs: ${CLINIC.name} · Open task signals: network-wide`)).toBeInTheDocument();
    expect(within(report).getByText('Network callers waiting on a person')).toBeInTheDocument();
    expect(within(report).getByText('Network emergencies open')).toBeInTheDocument();
  });

  it('shows UNAVAILABLE, never 0%, for a rate with no denominator', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/overview/, () => ({
      ...KPIS,
      counts: { ...KPIS.counts, answeredInbound: 0, inbound: 0 },
      rates: { bookingRate: null, containedPct: null, afterHoursPct: null, callbacksWithinSlaPct: null },
      aht: null,
    }));
    renderPage();

    const report = await screen.findByRole('region', { name: 'Shift report' });
    await within(report).findByText('Booked on the call');
    expect(within(report).queryByText('0%')).not.toBeInTheDocument();
    expect(within(report).queryByText('0m 00s')).not.toBeInTheDocument();
    expect(within(report).getAllByText('Unavailable').length).toBeGreaterThanOrEqual(4);
    expect(within(report).getAllByText(/This is not a zero/).length).toBeGreaterThanOrEqual(4);
  });

  it('reports a failure instead of an empty report', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/overview/, () => { throw new ApiError(500, 'KPIs unavailable.', 'INTERNAL'); });
    renderPage();
    const report = await screen.findByRole('region', { name: 'Shift report' });
    expect(await within(report).findByText('The shift report could not be loaded.')).toBeInTheDocument();
    expect(within(report).getByText(/No figure is shown, because none was read/)).toBeInTheDocument();
  });

  it('marks preserved call counts and KPI values stale when a background refresh fails', async () => {
    happyPath();
    let summaryReads = 0;
    let callSummaryReads = 0;
    let kpiReads = 0;
    route('GET', /^\/v1\/tasks\/summary$/, () => ({
      ...SUMMARY,
      generatedAt: summaryReads++ === 0 ? '2026-08-29T17:35:00.000Z' : '2026-08-29T17:36:00.000Z',
    }));
    route('GET', /^\/v1\/receptionist\/call-logs\/summary/, () => {
      if (callSummaryReads++ > 0) throw new ApiError(503, 'Call metrics are temporarily unavailable.', 'UNAVAILABLE');
      return CALL_SUMMARY;
    });
    route('GET', /^\/v1\/receptionist\/overview/, () => {
      if (kpiReads++ > 0) throw new ApiError(503, 'KPI refresh is temporarily unavailable.', 'UNAVAILABLE');
      return KPIS;
    });
    renderPage();

    const report = await screen.findByRole('region', { name: 'Shift report' });
    expect(await within(report).findByText('Answered inbound')).toBeInTheDocument();
    notifyFrontDeskMutated();

    expect(await screen.findByText(/latest clinic call-summary refresh failed/i)).toBeInTheDocument();
    expect(await within(report).findByText(/latest call-KPI refresh failed/i)).toBeInTheDocument();
    expect(within(report).getByText('3')).toBeInTheDocument();
  });
});

/** E5 — a call the desk can actually open. */
describe('FrontDesk call drawer', () => {
  it('opens a call from the unreviewed lane and says plainly that no transcript is retained', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/call-logs\/call-1$/, () => ({
      ...CALL, providerSummary: null, appointments: [], appointmentRequests: [], staffTasks: [],
    }));
    renderPage();

    const unread = await screen.findByRole('region', { name: 'Unreviewed calls' });
    fireEvent.click(await within(unread).findByRole('button', { name: 'Call with Jordan Vale' }));

    const drawer = await screen.findByRole('dialog', { name: 'Call detail' });
    expect(await within(drawer).findByText('Jordan Vale')).toBeInTheDocument();
    expect(within(drawer).getByText('Caller asked about a crown.')).toBeInTheDocument();
    expect(within(drawer).getByText(/Word-for-word transcripts are not retained/)).toBeInTheDocument();
    expect(within(drawer).getByText('No appointment was booked on this call.')).toBeInTheDocument();
  });

  it('reports a call that could not be opened instead of an empty drawer', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/call-logs\/call-1$/, () => { throw new ApiError(404, 'Call not found.', 'NOT_FOUND'); });
    renderPage();

    const unread = await screen.findByRole('region', { name: 'Unreviewed calls' });
    fireEvent.click(await within(unread).findByRole('button', { name: 'Call with Jordan Vale' }));
    const drawer = await screen.findByRole('dialog', { name: 'Call detail' });
    expect(await within(drawer).findByText('This call could not be opened.')).toBeInTheDocument();
    expect(within(drawer).getByText(/nothing was read/)).toBeInTheDocument();
  });
});

describe('FrontDesk actions', () => {
  it('acknowledges an emergency through the banner and re-reads the server', async () => {
    happyPath();
    const acknowledged = vi.fn(() => EMERGENCY);
    route('PATCH', /^\/v1\/staff\/tasks\/task-emergency\/acknowledge$/, acknowledged);
    renderPage();

    const banner = await screen.findByRole('alert', { name: 'Unacknowledged emergencies' });
    fireEvent.click(within(banner).getByRole('button', { name: 'Acknowledge Emergency reported on a call' }));
    await waitFor(() => expect(acknowledged).toHaveBeenCalled());
  });

  it('acknowledges from the task card', async () => {
    happyPath();
    const acknowledged = vi.fn(() => ({ ...EMERGENCY, acknowledgedAt: '2026-08-29T17:40:00.000Z' }));
    route('PATCH', /^\/v1\/staff\/tasks\/task-emergency\/acknowledge$/, acknowledged);
    renderPage();

    const emergencies = await screen.findByRole('region', { name: 'Emergencies & urgent' });
    fireEvent.click(await within(emergencies).findByRole('button', { name: 'Acknowledge Sam Reyes' }));
    await waitFor(() => expect(acknowledged).toHaveBeenCalled());
  });

  /**
   * E1 — the primary inbound loop. The route's schema is strict and wants a
   * sibling `createPatient`; the old body nested it under `patientId` and every
   * booking for a caller with no patient record 400'd.
   */
  it('books an unknown caller with createPatient, not a nested patientId', async () => {
    happyPath();
    withProviders();
    const booked = vi.fn(() => ({ status: 'BOOKED', appointment: { id: 'appt-1', service: 'Cleaning', startsAt: '2026-09-01T17:00:00.000Z' }, confirmationsQueued: [] }));
    route('POST', /^\/v1\/receptionist\/appointment-requests\/req-1\/book$/, booked);
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Book it for Priya Shah' }));
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });

    fireEvent.change(within(dialog).getByLabelText('Provider'), { target: { value: 'prov-1' } });
    fireEvent.change(within(dialog).getByLabelText(/First name/), { target: { value: 'Priya' } });
    fireEvent.change(within(dialog).getByLabelText(/Last name/), { target: { value: 'Shah' } });
    await within(dialog).findByLabelText('Open slot');
    fireEvent.click(within(dialog).getByRole('checkbox'));

    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm booking/ }));
    await waitFor(() => expect(booked).toHaveBeenCalled());
    const body = JSON.parse(String((booked.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({
      createPatient: { firstName: 'Priya', lastName: 'Shah' },
      providerProfileId: 'prov-1',
      startsAt: '2026-09-01T17:00:00.000Z',
      service: 'Cleaning',
      acknowledgeRequestDifferences: true,
    });
    // The old shape is gone: `patientId` is a uuid or absent, never an object.
    expect(body.patientId).toBeUndefined();
    expect(body.createPatient.branchId).toBeUndefined();
  });

  it('keeps the booking dialog open and shows the server reason when the slot was taken', async () => {
    happyPath();
    withProviders();
    route('POST', /^\/v1\/receptionist\/appointment-requests\/req-1\/book$/, () => {
      throw new ApiError(409, 'That slot was taken while you were reviewing.', 'slot_unavailable');
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Book it for Priya Shah' }));
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    fireEvent.change(within(dialog).getByLabelText('Provider'), { target: { value: 'prov-1' } });
    fireEvent.change(within(dialog).getByLabelText(/First name/), { target: { value: 'Priya' } });
    fireEvent.change(within(dialog).getByLabelText(/Last name/), { target: { value: 'Shah' } });
    await within(dialog).findByLabelText('Open slot');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm booking/ }));

    expect(await within(dialog).findByText('That slot was taken while you were reviewing.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Book it/ })).toBeInTheDocument();
  });

  it('requires a reason before a request can be rejected', async () => {
    happyPath();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject request from Priya Shah' }));
    const submit = screen.getByRole('button', { name: 'Reject request' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for rejecting Priya Shah'), { target: { value: 'Duplicate of an existing booking' } });
    expect(submit).toBeEnabled();
  });

  it('adds a note through the task card', async () => {
    happyPath();
    const noted = vi.fn(() => task());
    route('POST', /^\/v1\/staff\/tasks\/task-1\/notes$/, noted);
    renderPage();

    const callbacks = await screen.findByRole('region', { name: 'Callbacks due' });
    fireEvent.click(within(callbacks).getByRole('button', { name: 'Add note to Jordan Vale' }));
    fireEvent.change(within(callbacks).getByLabelText('Note for Jordan Vale'), { target: { value: 'Left a voicemail at 10:02.' } });
    fireEvent.click(within(callbacks).getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(noted).toHaveBeenCalled());
    expect(JSON.parse(String((noted.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ text: 'Left a voicemail at 10:02.' });
  });

  /** E6 — the list masks; the audited reveal shows the digits a desk has to read. */
  it('masks the number in the lane and shows it in full only after the audited reveal', async () => {
    happyPath();
    const revealed = vi.fn(() => ({ ...task(), contact: { callbackPhone: '+14155554242', verifiedPhone: '+14155554242', requestedCallbackPhone: null, callerName: 'Jordan Vale' } }));
    route('GET', /^\/v1\/staff\/tasks\/task-1$/, revealed);
    renderPage();

    const callbacks = await screen.findByRole('region', { name: 'Callbacks due' });
    // Before the reveal the lane carries only the mask.
    expect(within(callbacks).queryByText(/\+14155554242/)).not.toBeInTheDocument();

    fireEvent.click(within(callbacks).getByRole('button', { name: 'Call back Jordan Vale' }));
    const dial = await within(callbacks).findByRole('link', { name: /Dial Jordan Vale/ });
    expect(dial).toHaveAttribute('href', 'tel:+14155554242');
    expect(dial).toHaveTextContent('+14155554242');
    expect(within(callbacks).getByRole('button', { name: /Copy Jordan Vale's number/ })).toBeInTheDocument();
    expect(within(callbacks).getByText('revealed and logged')).toBeInTheDocument();
  });
});

describe('FrontDesk permissions', () => {
  it('hides call-back, book and acknowledge for a role that cannot work the queue', async () => {
    signedIn(['staff:read']);
    happyPath();
    route('GET', /^\/v1\/tasks\?.*workflow=receptionist_safety/, () => ({
      data: [task({ receptionist: { kind: 'message', restricted: true, requiresAcknowledgement: true } })],
      nextCursor: null,
    }));
    renderPage();

    const callbacks = await screen.findByRole('region', { name: 'Callbacks due' });
    expect(await within(callbacks).findByText('Details restricted to front-desk roles.')).toBeInTheDocument();
    expect(within(callbacks).queryByRole('button', { name: /Call back/ })).not.toBeInTheDocument();
    expect(within(callbacks).queryByRole('button', { name: /Acknowledge/ })).not.toBeInTheDocument();
    expect(within(callbacks).getByText('Your role can read this task but not change it.')).toBeInTheDocument();
    expect(await screen.findByText('Your role can read this request but not book or reject it.')).toBeInTheDocument();
  });

  it('shows no badge count when the summary could not be loaded', async () => {
    happyPath();
    route('GET', /^\/v1\/tasks\/summary$/, () => { throw new ApiError(503, 'Summary unavailable.', 'UNAVAILABLE'); });
    renderPage();
    expect(await screen.findByText(/The queue summary could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText(/need action/)).not.toBeInTheDocument();
  });
});
