import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { hasResponse, receivedData, resolveResourceState, resourceFailure } from '../lib/resourceState';
import { RESOURCE_TIMEOUT_MS, useResource } from './useResource';

afterEach(() => {
  vi.useRealTimers();
});

describe('useResource', () => {
  it('ends a load that is never answered instead of spinning forever', async () => {
    vi.useFakeTimers();
    // A socket that accepts the request and then says nothing: the promise
    // never settles, so only the watchdog can end the loading state.
    const neverAnswers = () => new Promise<string[]>(() => {});

    const { result } = renderHook(() => useResource<string[]>(neverAnswers));

    expect(result.current.state.status).toBe('loading');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESOURCE_TIMEOUT_MS + 1);
    });

    expect(result.current.state.status).toBe('error');
    expect(resourceFailure(result.current.state)?.timedOut).toBe(true);
    expect(resourceFailure(result.current.state)?.message).toContain('nothing was loaded');
    expect(receivedData(result.current.state)).toBeNull();
  });

  it('reports a failed load as error and hands the caller no value to render', async () => {
    const refuses = () => Promise.reject(new ApiError(500, '', 'INTERNAL_SERVER_ERROR'));

    const { result } = renderHook(() => useResource<string[]>(refuses));

    await waitFor(() => expect(result.current.state.status).toBe('error'));

    // Not empty, not ready, and no seed list standing in for the real answer.
    expect(receivedData(result.current.state)).toBeNull();
    expect(hasResponse(result.current.state)).toBe(false);
    expect(resolveResourceState(result.current.state, () => true).status).toBe('error');
  });

  it('routes a loader that throws before it returns through the same failure path', async () => {
    const throwsImmediately = (): Promise<string[]> => {
      throw new Error('Loader could not be built');
    };

    const { result } = renderHook(() => useResource<string[]>(throwsImmediately));

    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(resourceFailure(result.current.state)?.message).toBe('Loader could not be built');
  });

  it('reaches empty only by receiving a response that carried no records', async () => {
    const answersWithNoRecords = () => Promise.resolve<string[]>([]);

    const { result } = renderHook(() => useResource<string[]>(answersWithNoRecords));

    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    expect(hasResponse(result.current.state)).toBe(true);
    expect(receivedData(result.current.state)).toEqual([]);
    expect(resolveResourceState(result.current.state).status).toBe('empty');
  });

  it('reads as loading again while a retry is in flight rather than keeping the old answer', async () => {
    const answers = () => Promise.resolve(['a-row']);

    const { result } = renderHook(() => useResource<string[]>(answers));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      result.current.reload();
    });

    expect(result.current.state.status).toBe('loading');
    expect(receivedData(result.current.state)).toBeNull();

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(receivedData(result.current.state)).toEqual(['a-row']);
  });
});
