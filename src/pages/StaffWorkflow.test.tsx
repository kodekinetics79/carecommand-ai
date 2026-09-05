import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

const sessionMock = vi.hoisted(() => vi.fn());
vi.mock('../hooks/useSession', () => ({ useSession: sessionMock }));

const getSelectedClinicIdMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/session', async () => {
  const actual = await vi.importActual<typeof import('../lib/session')>('../lib/session');
  return { ...actual, getSelectedClinicId: getSelectedClinicIdMock };
});

import StaffWorkflow from './StaffWorkflow';

/**
 * A receptionist task in the shared staff queue is a caller waiting on a
 * person. It has to arrive as a caller — name, message, callback state — not
 * as a title string, and a role that cannot read call artifacts must see the
 * restricted view instead.
 */
const GRANTS = ['staff:read', 'staff:task-status', 'receptionist:call-artifacts:read'];

function signedIn(permissions: string[] = GRANTS) {
  sessionMock.mockReturnValue({
    user: { id: 'u1', email: 'a@b.test', displayName: 'Ann Front', role: 'FRONT_DESK', branch: null, tenant: { id: 't', name: 'T', slug: 't' }, active: true, effectivePermissions: permissions },
    loading: false,
  });
}

const RECEPTIONIST_TASK = {
  id: 'task-1', title: 'Message for the front desk', priority: 'high', status: 'OPEN',
  dueAt: '2026-08-29T18:00:00.000Z', createdAt: '2026-08-29T17:30:00.000Z',
  branchId: null, branch: null, assignedToId: null, assignedTo: null,
  acknowledgedAt: null, acknowledgedBy: null, completedAt: null, outcomeCode: null, outcomeNote: null,
  callLogId: 'call-1', patientId: null, patient: null,
  clinic: { id: 'c1', name: 'Brightsmile', timezone: 'America/Los_Angeles' },
  metadata: { workflow: 'receptionist_safety', kind: 'message' },
  receptionist: {
    kind: 'message', callerName: 'Jordan Vale', callbackPhoneMasked: '***-***-4242',
    verifiedPhoneMasked: null, requestedPhoneMasked: '***-***-4242', hasRequestedPhone: true,
    messages: [{ text: 'Asking about a crown.', recordedAt: '2026-08-29T17:30:00.000Z' }],
    messageCount: 1, reasonCategory: 'billing', callbackWindow: null,
    transferStatus: 'attempted', transferUpdatedAt: '2026-08-29T17:31:00.000Z',
    toolName: null, denialReason: null, appointmentRequestId: null, appointmentId: null,
    staffNotes: [], source: 'webhook_call_ended', requiresAcknowledgement: true,
  },
};

const GENERIC_TASK = {
  id: 'task-2', title: 'Chase an insurance denial', priority: 'medium', status: 'OPEN',
  dueAt: null, createdAt: '2026-08-29T16:00:00.000Z', branchId: null, branch: null,
  assignedToId: null, assignedTo: null, metadata: { workflow: 'insurance_denial_prevention' },
};

let tasks: unknown[];

beforeEach(() => {
  signedIn();
  getSelectedClinicIdMock.mockReturnValue(null);
  tasks = [RECEPTIONIST_TASK, GENERIC_TASK];
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/v1/tasks')) return { data: tasks, nextCursor: null };
    if (path.startsWith('/v1/staff/overview')) return { data: [], nextCursor: null, measurement: { source: 'snapshot', automatedAggregation: false, limitation: 'Context only.' } };
    if (path.startsWith('/v1/staff/assignees')) return [];
    if (path.startsWith('/v1/branches')) return { data: [] };
    if (path.includes('/task-2/status')) return { ...GENERIC_TASK, status: 'COMPLETED', outcomeCode: 'resolved_elsewhere' };
    if (path.includes('/acknowledge')) return { ...RECEPTIONIST_TASK, acknowledgedAt: '2026-08-29T17:45:00.000Z', acknowledgedBy: { displayName: 'Ann Front' } };
    if (path.includes('/notes')) return RECEPTIONIST_TASK;
    throw new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`);
  });
});

const renderPage = () => render(<MemoryRouter><StaffWorkflow /></MemoryRouter>);

describe('StaffWorkflow receptionist card', () => {
  it('renders a receptionist task as its caller, with the message and transfer state', async () => {
    renderPage();
    const card = await screen.findByRole('article', { name: 'Message: Jordan Vale' });
    expect(within(card).getByText('Jordan Vale')).toBeInTheDocument();
    expect(within(card).getByText(/Asking about a crown/)).toBeInTheDocument();
    expect(within(card).getByText('Message')).toBeInTheDocument();
    expect(within(card).getByText('Not yet acknowledged')).toBeInTheDocument();
  });

  it('keeps rendering non-receptionist tasks as ordinary rows', async () => {
    renderPage();
    expect(await screen.findByText('Chase an insurance denial')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: /Chase an insurance denial/ })).not.toBeInTheDocument();
  });

  it('acknowledges from the queue and re-reads the server', async () => {
    renderPage();
    const card = await screen.findByRole('article', { name: 'Message: Jordan Vale' });
    fireEvent.click(within(card).getByRole('button', { name: 'Acknowledge Jordan Vale' }));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/staff/tasks/task-1/acknowledge', expect.objectContaining({ method: 'PATCH' })));
  });

  it('shows the restricted view, and no caller detail, to a role without call-artifact access', async () => {
    signedIn(['staff:read', 'staff:task-status']);
    tasks = [{ ...RECEPTIONIST_TASK, receptionist: { kind: 'message', restricted: true, requiresAcknowledgement: true } }];
    renderPage();
    const card = await screen.findByRole('article', { name: 'Message: Message for the front desk' });
    expect(within(card).getByText('Details restricted to front-desk roles.')).toBeInTheDocument();
    expect(within(card).queryByText('Jordan Vale')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Call back/ })).not.toBeInTheDocument();
  });

  it('will not close a receptionist task without an outcome', async () => {
    renderPage();
    const card = await screen.findByRole('article', { name: 'Message: Jordan Vale' });
    fireEvent.click(within(card).getByRole('button', { name: 'Done with Jordan Vale' }));
    expect(within(card).getByRole('button', { name: 'Mark done' })).toBeDisabled();
    fireEvent.change(within(card).getByLabelText('Outcome for Jordan Vale'), { target: { value: 'left_voicemail' } });
    expect(within(card).getByRole('button', { name: 'Mark done' })).toBeEnabled();
  });

  it('requires a recorded outcome and explicit confirmation for a generic task', async () => {
    renderPage();
    await screen.findByText('Chase an insurance denial');
    fireEvent.click(screen.getByRole('button', { name: 'Complete…' }));
    const confirm = screen.getByRole('button', { name: 'Confirm completion' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Outcome for Chase an insurance denial'), { target: { value: 'resolved_elsewhere' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/staff/tasks/task-2/status', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ status: 'COMPLETED', outcomeCode: 'resolved_elsewhere' }),
    })));
  });

  it('makes work beyond the first 100-row page reachable', async () => {
    const pageTwo = { ...GENERIC_TASK, id: 'task-101', title: 'Reachable task 101' };
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === '/v1/tasks?limit=100') return { data: tasks, nextCursor: 'next-100' };
      if (path.includes('cursor=next-100')) return { data: [pageTwo], nextCursor: null };
      if (path.startsWith('/v1/staff/overview')) return { data: [], nextCursor: null, measurement: { source: 'snapshot', automatedAggregation: false, limitation: 'Context only.' } };
      if (path.startsWith('/v1/staff/assignees')) return [];
      if (path.startsWith('/v1/branches')) return { data: [] };
      throw new Error(`Unexpected request in test: ${path}`);
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Load next 100 tasks' }));
    expect(await screen.findByText('Reachable task 101')).toBeInTheDocument();
  });

  it('defaults new work to the globally selected clinic, not the user primary clinic', async () => {
    signedIn([...GRANTS, 'staff:write']);
    sessionMock.mockReturnValue({
      user: { id: 'u1', email: 'a@b.test', displayName: 'Ann Front', role: 'FRONT_DESK', branchId: 'c1', branch: null, tenant: { id: 't', name: 'T', slug: 't' }, active: true, effectivePermissions: [...GRANTS, 'staff:write'] },
      loading: false,
    });
    getSelectedClinicIdMock.mockReturnValue('c2');
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/tasks')) return { data: tasks, nextCursor: null };
      if (path.startsWith('/v1/staff/overview')) return { data: [], nextCursor: null, measurement: { source: 'snapshot', automatedAggregation: false, limitation: 'Context only.' } };
      if (path.startsWith('/v1/staff/assignees')) return [];
      if (path.startsWith('/v1/branches')) return { data: [
        { id: 'c1', name: 'Arlington', location: 'VA', timezone: 'America/New_York', active: true },
        { id: 'c2', name: 'Fairfax', location: 'VA', timezone: 'America/New_York', active: true },
      ] };
      throw new Error(`Unexpected request in test: ${path}`);
    });
    renderPage();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/branches?limit=100'));
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    expect(screen.getByRole('combobox', { name: 'Clinic' })).toHaveValue('c2');
  });
});
