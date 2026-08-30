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
import { resetFrontDeskPollForTests } from '../hooks/useFrontDeskPoll';
import FrontDesk from './FrontDesk';

/**
 * The front desk is the page a clinic runs its day on, so the claims it makes
 * have to be exact: a lane that could not load says so (it never renders as
 * "nothing to do"), a caller's number is never printed in full, and nothing is
 * booked or acknowledged until the server said it was.
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
      staffNotes: [], source: 'retell_live_call', requiresAcknowledgement: true,
    },
    ...overrides,
  };
}

const EMERGENCY = task({
  id: 'task-emergency', title: 'Emergency reported on a call', priority: 'critical',
  receptionist: { ...task().receptionist, kind: 'emergency', callerName: 'Sam Reyes', reasonCategory: 'chest_pain' },
});

const REQUEST = {
  id: 'req-1', branchId: 'branch-1', patientId: null, campaignId: null, callLogId: 'call-2',
  requestedService: 'Cleaning', requestedDateTime: '2026-09-01T17:00:00.000Z',
  collectedName: 'Priya Shah', collectedPhoneMasked: '***-***-9090', collectedEmail: null,
  status: 'PENDING_REVIEW', source: 'voice', missingFields: [], outcomeReason: null,
  bookedAppointmentId: null, bookedAppointment: null,
  callLog: { id: 'call-2', retellCallId: 'call_x', callerName: 'Priya Shah', direction: 'inbound', startedAt: '2026-08-29T17:00:00.000Z', clinicId: CLINIC.id, patientId: null },
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
  openByKind: { message: 1, emergency: 1 }, overdue: 0,
  unacknowledgedCritical: [{ id: 'task-emergency', title: 'Emergency reported on a call', createdAt: '2026-08-29T17:31:00.000Z', clinicName: CLINIC.name }],
  mine: 0, dueWithin30m: 1, generatedAt: '2026-08-29T17:35:00.000Z',
};

type Handler = (path: string, init?: RequestInit) => unknown;
let routes: Array<[RegExp, string, Handler]>;

/** Register a responder for the first request whose method+path matches. */
function route(method: string, pattern: RegExp, handler: Handler) {
  routes.unshift([pattern, method, handler]);
}

function happyPath() {
  route('GET', /^\/v1\/receptionist\/clinics$/, () => [CLINIC]);
  route('GET', /^\/v1\/tasks\?/, () => ({ data: [EMERGENCY, task()], nextCursor: null }));
  route('GET', /^\/v1\/tasks\/summary$/, () => SUMMARY);
  route('GET', /^\/v1\/receptionist\/appointment-requests\?/, () => ({ data: [REQUEST], nextCursor: null }));
  route('GET', /^\/v1\/receptionist\/call-logs\?/, () => ({ data: [CALL], nextCursor: null }));
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
    expect(within(unread).getByLabelText('Call with Jordan Vale')).toBeInTheDocument();
  });

  it('shows a lane that failed as a failure with a retry, never as an empty queue', async () => {
    happyPath();
    let attempts = 0;
    route('GET', /^\/v1\/tasks\?/, () => {
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
    route('GET', /^\/v1\/tasks\?/, () => new Promise<never>(() => {}));
    renderPage();
    expect(screen.getByText(/Loading emergencies & urgent…/)).toBeInTheDocument();
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

  it('books a request through /appointment-requests/:id/book and refreshes', async () => {
    happyPath();
    route('GET', /^\/v1\/providers\/overview/, () => [
      { id: 'prov-1', branchId: 'branch-1', active: true, specialty: 'Dentistry', branch: { name: 'Main' }, user: { displayName: 'Dr Wu' } },
    ]);
    route('GET', /^\/v1\/scheduling\/providers\/prov-1\/slots/, () => ({
      providerId: 'prov-1', date: '2026-09-01', slots: [{ startsAt: '2026-09-01T17:00:00.000Z', endsAt: '2026-09-01T17:30:00.000Z' }],
    }));
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
    expect(body).toMatchObject({
      providerProfileId: 'prov-1',
      startsAt: '2026-09-01T17:00:00.000Z',
      service: 'Cleaning',
      acknowledgeRequestDifferences: true,
      patientId: { create: { firstName: 'Priya', lastName: 'Shah', branchId: 'branch-1' } },
    });
  });

  it('keeps the booking dialog open and shows the server reason when the slot was taken', async () => {
    happyPath();
    route('GET', /^\/v1\/providers\/overview/, () => [
      { id: 'prov-1', branchId: 'branch-1', active: true, specialty: 'Dentistry', branch: { name: 'Main' }, user: { displayName: 'Dr Wu' } },
    ]);
    route('GET', /^\/v1\/scheduling\/providers\/prov-1\/slots/, () => ({
      providerId: 'prov-1', date: '2026-09-01', slots: [{ startsAt: '2026-09-01T17:00:00.000Z', endsAt: '2026-09-01T17:30:00.000Z' }],
    }));
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

  it('reveals a callback number only through the audited task detail, and never prints it', async () => {
    happyPath();
    const revealed = vi.fn(() => ({ ...task(), contact: { callbackPhone: '+14155554242', verifiedPhone: '+14155554242', requestedCallbackPhone: null, callerName: 'Jordan Vale' } }));
    route('GET', /^\/v1\/staff\/tasks\/task-1$/, revealed);
    renderPage();

    const callbacks = await screen.findByRole('region', { name: 'Callbacks due' });
    fireEvent.click(within(callbacks).getByRole('button', { name: 'Call back Jordan Vale' }));
    const dial = await within(callbacks).findByRole('link', { name: /Dial Jordan Vale/ });
    expect(dial).toHaveAttribute('href', 'tel:+14155554242');
    // The number is dialable but never rendered: only the mask is on screen.
    expect(dial).toHaveTextContent('***-***-4242');
    expect(screen.queryByText(/4155554242/)).not.toBeInTheDocument();
  });
});

describe('FrontDesk permissions', () => {
  it('hides call-back, book and acknowledge for a role that cannot work the queue', async () => {
    signedIn(['staff:read']);
    happyPath();
    route('GET', /^\/v1\/tasks\?/, () => ({
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
