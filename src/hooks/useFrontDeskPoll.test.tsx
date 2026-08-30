import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { authEventName } from '../lib/session';
import { notifyFrontDeskMutated, resetFrontDeskPollForTests, useFrontDeskPoll } from './useFrontDeskPoll';

/**
 * The poller is module state shared by the sidebar badge, the emergency banner
 * and the Front Desk header. Everything it can get wrong, it gets wrong on all
 * three at once (E14):
 *
 *   - keeping the previous session's counts after a sign-out, so a different
 *     tenant's numbers render as live;
 *   - absorbing a post-mutation refresh into a request that was issued BEFORE
 *     the mutation, so an acknowledged emergency stays in the red banner.
 */

function Probe() {
  const poll = useFrontDeskPoll();
  return (
    <div>
      <span data-testid="state">{poll.state}</span>
      <span data-testid="count">{poll.data ? String(poll.data.openByKind.message ?? 0) : 'none'}</span>
    </div>
  );
}

function summary(messageCount: number) {
  return {
    openByKind: { message: messageCount }, openNeedsAction: messageCount, overdue: 0,
    unacknowledgedCritical: [], mine: 0, dueWithin30m: 0,
    generatedAt: `2026-08-30T10:00:0${messageCount}.000Z`,
  };
}

beforeEach(() => {
  resetFrontDeskPollForTests();
  apiRequestMock.mockReset();
});

afterEach(() => {
  resetFrontDeskPollForTests();
});

describe('useFrontDeskPoll', () => {
  it('publishes the summary it read', async () => {
    apiRequestMock.mockResolvedValue(summary(3));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('ready'));
    expect(screen.getByTestId('count')).toHaveTextContent('3');
  });

  it('forgets the previous session on an auth change and re-reads', async () => {
    apiRequestMock.mockResolvedValue(summary(3));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'));

    // A different tenant signs in. The old counts must not survive the switch.
    apiRequestMock.mockResolvedValue(summary(7));
    window.dispatchEvent(new Event(authEventName));
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('7'));
    expect(screen.getByTestId('count')).not.toHaveTextContent('3');
  });

  it('drops a response that was already in flight when the session changed', async () => {
    const stale: { release: ((value: unknown) => void) | null } = { release: null };
    apiRequestMock.mockImplementationOnce(() => new Promise(resolve => { stale.release = resolve; }));
    render(<Probe />);
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));

    apiRequestMock.mockResolvedValue(summary(7));
    window.dispatchEvent(new Event(authEventName));
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('7'));

    // The previous tenant's answer lands late. It must be discarded, not painted.
    stale.release?.(summary(3));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getByTestId('count')).toHaveTextContent('7');
  });

  it('chains a fresh read after a mutation instead of joining the in-flight one', async () => {
    const first: { release: ((value: unknown) => void) | null } = { release: null };
    apiRequestMock.mockImplementationOnce(() => new Promise(resolve => { first.release = resolve; }));
    render(<Probe />);
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));

    // A staff member acknowledges an emergency while the first poll is open.
    apiRequestMock.mockResolvedValue(summary(0));
    notifyFrontDeskMutated();
    first.release?.(summary(5));

    // The pre-mutation answer may paint briefly, but a second read follows it,
    // so the acknowledged task cannot sit in the banner for another interval.
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
  });

  it('keeps the last good data but reports an error state when a read fails', async () => {
    apiRequestMock.mockResolvedValueOnce(summary(3));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'));

    apiRequestMock.mockRejectedValue(new Error('down'));
    notifyFrontDeskMutated();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
    expect(screen.getByTestId('count')).toHaveTextContent('3');
  });
});
