import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import Autopilot from './Autopilot';

/**
 * Approving an action and the action running are two different facts, and the
 * server reports them separately. The screen used to discard the approve
 * response and print a green "Approved for execution" regardless — so an
 * approval that no worker had accepted, and one whose enqueue had failed
 * outright, both told the operator the automation was on its way.
 *
 * These tests drive the three states the API can answer with and hold each one
 * to what it actually means.
 */

/** The claim the old build made unconditionally. It may never reappear. */
const FALSE_CLAIM = 'Approved for execution';

const PLAYBOOKS = [{
  id: 'playbook-1', key: 'recall', name: 'Recall outreach',
  description: 'Contact patients due for a recall.', status: 'LIVE' as const,
  config: { autonomyLevel: 2, icon: 'clock', trigger: 'Recall due', action: 'Draft a recall message' },
}];

const APPROVAL = {
  id: 'approval-1', title: 'Send recall to twelve patients', reason: 'Twelve patients are past their recall date.',
  payload: { scope: 'Riverside Clinic' }, confidence: 78, status: 'PENDING' as const,
  reviewedAt: null, playbook: { key: 'recall', name: 'Recall outreach' },
};

type DispatchState = 'queued' | 'pending_dispatch' | 'dispatch_failed';

interface ApproveOptions {
  state: DispatchState;
  available?: boolean;
  reason?: string | null;
  /** What a subsequent POST to the dispatch endpoint answers with. */
  retryState?: DispatchState;
}

let approveOptions: ApproveOptions;
const dispatchCalls: Array<[string, RequestInit | undefined]> = [];

function answer(path: string, init?: RequestInit) {
  if (path.endsWith('/approve')) {
    return Promise.resolve({
      id: APPROVAL.id,
      status: 'APPROVED',
      dispatch: {
        capability: {
          available: approveOptions.available ?? true,
          mode: approveOptions.available === false ? 'manual_retry_required' : 'background_queue',
          reason: approveOptions.reason ?? null,
        },
        state: approveOptions.state,
      },
    });
  }
  if (path.endsWith('/dispatch')) {
    dispatchCalls.push([path, init]);
    return Promise.resolve({ id: APPROVAL.id, status: 'APPROVED', dispatch: { state: approveOptions.retryState ?? 'queued' } });
  }
  if (path.startsWith('/v1/autopilot/playbooks')) return Promise.resolve(PLAYBOOKS);
  if (path.includes('status=PENDING')) return Promise.resolve([APPROVAL]);
  return Promise.resolve([]);
}

beforeEach(() => {
  dispatchCalls.length = 0;
  approveOptions = { state: 'queued' };
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => answer(path, init));
});

async function renderAndApprove(options: ApproveOptions) {
  approveOptions = options;
  render(<MemoryRouter><Autopilot /></MemoryRouter>);
  await screen.findByText('Send recall to twelve patients');
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
}

describe('Autopilot dispatch reporting', () => {
  it('says an action is queued only when the server queued it', async () => {
    await renderAndApprove({ state: 'queued' });

    await screen.findByText(/Approved and queued for execution/);
    expect(screen.getByText(/A background job accepted this action/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FALSE_CLAIM);
  });

  it('does not claim execution for an approval nothing has accepted', async () => {
    await renderAndApprove({
      state: 'pending_dispatch',
      available: true,
      reason: 'Background queueing is enabled but no job has been accepted yet.',
    });

    await screen.findByText(/Approved · not dispatched/);
    expect(document.body.textContent).not.toContain(FALSE_CLAIM);
    expect(screen.queryByText(/queued for execution/)).not.toBeInTheDocument();
    expect(screen.getByText('Background queueing is enabled but no job has been accepted yet.')).toBeInTheDocument();
  });

  it('does not claim execution for an approval whose dispatch failed', async () => {
    await renderAndApprove({ state: 'dispatch_failed' });

    await screen.findByText(/Approved · dispatch failed/);
    expect(document.body.textContent).not.toContain(FALSE_CLAIM);
    expect(screen.queryByText(/queued for execution/)).not.toBeInTheDocument();
    expect(screen.getByText(/No execution is queued for this action/)).toBeInTheDocument();
  });
});

describe('Autopilot dispatch retry', () => {
  it('offers a failed dispatch a retry wired to the dispatch endpoint', async () => {
    await renderAndApprove({ state: 'dispatch_failed', retryState: 'queued' });
    await screen.findByText(/Approved · dispatch failed/);

    fireEvent.click(screen.getByRole('button', { name: 'Retry dispatch' }));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    const [path, init] = dispatchCalls[0];
    expect(path).toBe(`/v1/autopilot/approvals/${APPROVAL.id}/dispatch`);
    expect(init?.method).toBe('POST');

    // And the row reports the new state rather than staying red or turning
    // green on the click alone.
    await screen.findByText(/Approved and queued for execution/);
  });

  it('keeps reporting failure when the retry fails again', async () => {
    await renderAndApprove({ state: 'dispatch_failed', retryState: 'dispatch_failed' });
    await screen.findByText(/Approved · dispatch failed/);

    fireEvent.click(screen.getByRole('button', { name: 'Retry dispatch' }));

    await waitFor(() => expect(dispatchCalls).toHaveLength(1));
    expect(await screen.findByText(/Approved · dispatch failed/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FALSE_CLAIM);
  });

  it('offers a retry for a pending dispatch only while the runtime can accept one', async () => {
    await renderAndApprove({ state: 'pending_dispatch', available: true });
    await screen.findByText(/Approved · not dispatched/);

    expect(screen.getByRole('button', { name: 'Request dispatch' })).toBeInTheDocument();
  });

  it('offers no retry for a pending dispatch when the runtime cannot accept one', async () => {
    await renderAndApprove({
      state: 'pending_dispatch',
      available: false,
      reason: 'Background queueing is disabled in this runtime, so nothing can accept this action.',
    });

    await screen.findByText(/Approved · not dispatched/);
    // A button that cannot succeed is theatre; the reason takes its place.
    expect(screen.queryByRole('button', { name: 'Request dispatch' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry dispatch' })).not.toBeInTheDocument();
    expect(screen.getByText('Background queueing is disabled in this runtime, so nothing can accept this action.')).toBeInTheDocument();
    expect(dispatchCalls).toHaveLength(0);
    expect(document.body.textContent).not.toContain(FALSE_CLAIM);
  });
});
