import { useState } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { useApiResource } from './useApiResource';

/**
 * The request-count IS the behaviour here, so counting calls is the only way to
 * state it. Every call site of this hook passes an inline mapper — `row => row`
 * or a small arrow — which is a new function object on every render. When that
 * mapper was a dependency of the request effect, each render invalidated the
 * effect, the effect issued the request, the response set state, state caused a
 * render, and the loop ran for as long as the page was open. The hook now reads
 * the mapper through a ref so the request identity depends only on the path.
 *
 * These tests fail the moment `mapRow` (or anything else re-created per render)
 * is put back into that dependency array.
 */

interface Row { id: string; label: string }

const ROWS: Row[] = [{ id: 'row-a', label: 'Row A' }, { id: 'row-b', label: 'Row B' }];

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockResolvedValue(ROWS);
});

function countFor(path: string) {
  return apiRequestMock.mock.calls.filter(([called]) => called === path).length;
}

describe('useApiResource request identity', () => {
  it('issues exactly one request although the mapper is a new function on every render', async () => {
    const { result, rerender } = renderHook(() =>
      // Written exactly as the call sites write it: a fresh arrow each render.
      useApiResource<Row, Row>('/v1/things', [], row => row));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Renders after the response landed are where the loop used to compound.
    for (let i = 0; i < 8; i += 1) rerender();
    await act(async () => { await Promise.resolve(); });
    rerender();

    expect(countFor('/v1/things')).toBe(1);
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  it('issues one request when the owning component re-renders for unrelated reasons', async () => {
    function Owner() {
      const [tick, setTick] = useState(0);
      const things = useApiResource<Row, Row>('/v1/things', [], row => row);
      return (
        <div>
          <button type="button" onClick={() => setTick(current => current + 1)}>Re-render</button>
          <p>{`renders:${tick}`}</p>
          <p>{things.loading ? 'loading' : `rows:${things.data.length}`}</p>
        </div>
      );
    }

    render(<Owner />);
    await screen.findByText('rows:2');

    for (let i = 0; i < 6; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Re-render' }));
    }
    await screen.findByText('renders:6');
    await act(async () => { await Promise.resolve(); });

    expect(countFor('/v1/things')).toBe(1);
  });

  it('still applies the mapper the current render supplied', async () => {
    const { result } = renderHook(() =>
      useApiResource<Row, { id: string; label: string }>('/v1/things', [], row => ({ id: row.id, label: row.label.toUpperCase() })));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data.map(row => row.label)).toEqual(['ROW A', 'ROW B']);
    expect(result.current.source).toBe('live');
    expect(countFor('/v1/things')).toBe(1);
  });

  it('does issue a second request when the path changes', async () => {
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useApiResource<Row, Row>(path, [], row => row),
      { initialProps: { path: '/v1/things' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ path: '/v1/other-things' });
    await waitFor(() => expect(countFor('/v1/other-things')).toBe(1));

    expect(countFor('/v1/things')).toBe(1);
    expect(apiRequestMock).toHaveBeenCalledTimes(2);
  });

  it('does issue a second request when reload() is called', async () => {
    // The guard above must not be satisfied by never refetching at all.
    const { result } = renderHook(() => useApiResource<Row, Row>('/v1/things', [], row => row));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.reload(); });
    await waitFor(() => expect(countFor('/v1/things')).toBe(2));

    await act(async () => { await Promise.resolve(); });
    expect(countFor('/v1/things')).toBe(2);
  });

  it('does not retry in a loop after a failed request', async () => {
    apiRequestMock.mockRejectedValue(new Error('nope'));

    const { result, rerender } = renderHook(() => useApiResource<Row, Row>('/v1/things', [], row => row));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    for (let i = 0; i < 5; i += 1) rerender();
    await act(async () => { await Promise.resolve(); });

    expect(countFor('/v1/things')).toBe(1);
  });
});
