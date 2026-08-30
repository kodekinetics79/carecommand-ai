import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

const sessionMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useSession', () => ({ useSession: sessionMock }));

import { ApiError } from '../../lib/api';
import { ActivityPanel } from './ActivityPanel';

/**
 * The Studio's Activity tab is where a reviewer works the call queue. The
 * claims under test: a failed list is a failure (never "no calls"), the
 * filters actually reach the server, pagination adds rows instead of
 * replacing them, and a role that may read a review cannot silently edit it.
 */
const GRANTS = ['receptionist:call-artifacts:read', 'receptionist:booking-review', 'receptionist:manage', 'appointment:write'];

function signedIn(permissions: string[] = GRANTS) {
  sessionMock.mockReturnValue({
    user: { id: 'u1', email: 'a@b.test', displayName: 'Mia Manager', role: 'MANAGER', tenant: { id: 't', name: 'T', slug: 't' }, active: true, effectivePermissions: permissions },
    loading: false,
  });
}

function call(overrides: Record<string, unknown> = {}) {
  return {
    id: 'call-1', clinicId: 'clinic-1', campaign: null, callerName: 'Jordan Vale', callerPhoneMasked: '***-***-4242',
    patientId: null, patient: null, direction: 'inbound', outcome: 'ESCALATED', durationSeconds: 64,
    startedAt: '2026-08-29T17:29:00.000Z', endedAt: null, reviewStatus: 'UNREVIEWED',
    recordingConsentStatus: 'ACKNOWLEDGED', recordingAvailable: false, openHandoffCount: 1,
    bookedAppointmentId: null, transcriptSummary: 'Asked about a crown.', createdAt: '2026-08-29T17:29:00.000Z',
    ...overrides,
  };
}

const SUMMARY = { unreviewed: 3, openHandoffs: 1, inbound: 8, outbound: 2, booked: 1, pendingRequests: 1, range: { from: '2026-08-22', to: '2026-08-29' } };

const REQUEST = {
  id: 'req-1', branchId: 'branch-1', patientId: null, campaignId: null, callLogId: 'call-2',
  requestedService: 'Cleaning', requestedDateTime: '2026-09-01T17:00:00.000Z',
  collectedName: 'Priya Shah', collectedPhoneMasked: '***-***-9090', collectedEmail: null,
  status: 'PENDING_REVIEW', source: 'voice', missingFields: ['preferredBranch'], outcomeReason: null,
  bookedAppointmentId: null, bookedAppointment: null, callLog: null, patient: null, createdAt: '2026-08-29T17:01:00.000Z',
};

/** Every GET the panel makes, and the paths it made them on. */
let callPaths: string[];
let callPages: Array<{ data: unknown[]; nextCursor: string | null }>;
let callsFail: ApiError | null;
let requestsFail: ApiError | null;
let detail: Record<string, unknown> | null;

beforeEach(() => {
  signedIn();
  callPaths = [];
  callPages = [{ data: [call()], nextCursor: null }];
  callsFail = null;
  requestsFail = null;
  detail = null;
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/v1/receptionist/clinics') return [{ id: 'clinic-1', name: 'Brightsmile', timezone: 'America/Los_Angeles' }];
    if (path.startsWith('/v1/receptionist/call-logs/summary')) return SUMMARY;
    if (path.startsWith('/v1/receptionist/call-logs?')) {
      callPaths.push(path);
      if (callsFail) throw callsFail;
      return callPages.shift() ?? { data: [], nextCursor: null };
    }
    if (/^\/v1\/receptionist\/call-logs\/[^/?]+$/.test(path)) return detail ?? call();
    if (path.startsWith('/v1/receptionist/appointment-requests')) {
      if (requestsFail) throw requestsFail;
      return { data: [REQUEST], nextCursor: null };
    }
    if (path.startsWith('/v1/receptionist/opt-outs')) return [];
    throw new Error(`Unexpected request in test: ${method} ${path}`);
  });
});

const renderPanel = () => render(<ActivityPanel clinicId="clinic-1" timezone="America/Los_Angeles" />);

describe('ActivityPanel call queue', () => {
  it('renders the queue with its summary counts', async () => {
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Open call with Jordan Vale' })).toBeInTheDocument();
    const counts = screen.getByLabelText('Call queue counts');
    expect(within(counts).getByText('Unreviewed').nextSibling).toHaveTextContent('3');
    expect(within(counts).getByText('Open handoffs').nextSibling).toHaveTextContent('1');
  });

  it('renders a failed load as a failure with a retry, not as "no calls"', async () => {
    callsFail = new ApiError(500, 'The call service is down.', 'INTERNAL');
    renderPanel();
    expect(await screen.findByText('Call logs could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('The call service is down.')).toBeInTheDocument();
    expect(screen.queryByText(/No calls logged yet/)).not.toBeInTheDocument();

    callsFail = null;
    callPages = [{ data: [call()], nextCursor: null }];
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Open call with Jordan Vale' })).toBeInTheDocument();
  });

  it('distinguishes a genuinely empty queue from a failed one', async () => {
    callPages = [{ data: [], nextCursor: null }];
    renderPanel();
    expect(await screen.findByText(/No calls logged yet/)).toBeInTheDocument();
  });

  it('sends each filter to the server and says when a filter, not the clinic, emptied the list', async () => {
    renderPanel();
    await screen.findByRole('button', { name: 'Open call with Jordan Vale' });

    callPages = [{ data: [], nextCursor: null }];
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'inbound' } });
    await waitFor(() => expect(callPaths.at(-1)).toContain('direction=inbound'));

    fireEvent.click(screen.getByRole('button', { name: 'Outcome Booked' }));
    await waitFor(() => expect(callPaths.at(-1)).toContain('outcome=BOOKED'));

    fireEvent.click(screen.getByRole('button', { name: 'Review Unreviewed' }));
    await waitFor(() => expect(callPaths.at(-1)).toContain('reviewStatus=UNREVIEWED'));

    fireEvent.change(screen.getByLabelText('Handoff'), { target: { value: 'open' } });
    await waitFor(() => expect(callPaths.at(-1)).toContain('handoff=open'));

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } });
    await waitFor(() => expect(callPaths.at(-1)).toContain('from=2026-08-01'));

    expect(await screen.findByText('No call matches these filters.')).toBeInTheDocument();
  });

  it('pages with a cursor and appends rows rather than replacing them', async () => {
    callPages = [
      { data: [call()], nextCursor: 'cursor-2' },
      { data: [call({ id: 'call-9', callerName: 'Sam Reyes' })], nextCursor: null },
    ];
    renderPanel();
    await screen.findByRole('button', { name: 'Open call with Jordan Vale' });

    fireEvent.click(screen.getByRole('button', { name: 'Load more calls' }));
    expect(await screen.findByRole('button', { name: 'Open call with Sam Reyes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open call with Jordan Vale' })).toBeInTheDocument();
    expect(callPaths.at(-1)).toContain('cursor=cursor-2');
    expect(screen.queryByRole('button', { name: 'Load more calls' })).not.toBeInTheDocument();
  });
});

describe('ActivityPanel review permissions', () => {
  it('disables the review form and says so when the server reports canEdit false', async () => {
    detail = { ...call(), reviewCapabilities: { canEdit: false, canSignOff: false }, appointments: [], appointmentRequests: [], staffTasks: [] };
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Open call with Jordan Vale' }));
    expect(await screen.findByText('Your role can read this review but not edit it.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Staff operational summary/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  });

  it('offers sign-off only on a REVIEWED call that has not been edited since', async () => {
    detail = { ...call(), reviewStatus: 'REVIEWED', reviewCapabilities: { canEdit: true, canSignOff: true }, appointments: [], appointmentRequests: [], staffTasks: [] };
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Open call with Jordan Vale' }));
    expect(await screen.findByRole('button', { name: 'Final manager sign-off' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Caller intent/), { target: { value: 'Wanted a crown quote.' } });
    expect(screen.queryByRole('button', { name: 'Final manager sign-off' })).not.toBeInTheDocument();
    expect(screen.getByText('Edits require re-review before sign-off.')).toBeInTheDocument();
  });
});

describe('ActivityPanel appointments subtab', () => {
  it('lists core appointment requests with Book it and Reject', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /Appointments/ }));
    const row = await screen.findByLabelText('Appointment request from Priya Shah');
    expect(within(row).getByText(/Cleaning/)).toBeInTheDocument();
    expect(within(row).getByText(/Missing: preferredBranch/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Book it for Priya Shah' })).toBeInTheDocument();
  });

  it('requires a reason of at least five characters to reject', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /Appointments/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject request from Priya Shah' }));
    const submit = screen.getByRole('button', { name: 'Reject request' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for rejecting Priya Shah'), { target: { value: 'Caller booked elsewhere' } });
    expect(submit).toBeEnabled();
  });

  it('hides booking controls from a role that cannot book', async () => {
    signedIn(['receptionist:call-artifacts:read']);
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /Appointments/ }));
    expect(await screen.findByText('Your role can read this request but not book or reject it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Book it/ })).not.toBeInTheDocument();
  });

  it('renders a failed request load as a failure, not an empty list', async () => {
    requestsFail = new ApiError(403, 'You do not have access to this.', 'FORBIDDEN');
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: /Appointments/ }));
    expect(await screen.findByText('Appointment requests could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('No appointment request is waiting for review.')).not.toBeInTheDocument();
  });
});
