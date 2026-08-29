import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';

const EMPTY_ROWS: never[] = [];

export function useApiResource<TApi, TView extends { id: string }>(
  path: string,
  fallback: TView[],
  mapRow: (row: TApi) => TView,
) {
  const fallbackRef = useRef(fallback);
  // Lazy initializer: reads the prop once on mount (refs must not be read
  // during render; the ref is only for the async catch below).
  const [data, setData] = useState<TView[]>(() => fallback ?? EMPTY_ROWS);
  const [source, setSource] = useState<'live' | 'offline'>('offline');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadIndex, setReloadIndex] = useState(0);

  // `mapRow` is read through a ref instead of being a dependency of the request
  // effect. Most call sites pass an inline arrow (`row => row`), which is a new
  // function on every render, so depending on it re-ran the effect every render
  // and refetched the endpoint in an unbounded loop. The mapper is a pure row
  // projection, so applying the latest one when the response lands is
  // equivalent to applying the one that started the request — and it makes the
  // request identity depend only on the thing that actually identifies it, the
  // path. src/hooks/useResource.ts documents the same hazard for the successor
  // hook, which solves it by requiring a stable loader identity.
  const mapRowRef = useRef(mapRow);
  useEffect(() => {
    mapRowRef.current = mapRow;
  });

  useEffect(() => {
    let active = true;
    apiRequest<TApi[] | { data: TApi[] }>(path)
      .then(response => {
        const rows = Array.isArray(response) ? response : response.data;
        if (!active) return;
        // Always show live data once it loads, even when empty — never merge mock in.
        setData(rows.map(row => mapRowRef.current(row)));
        setSource('live');
      })
      .catch(() => {
        if (!active) return;
        setData(fallbackRef.current ?? EMPTY_ROWS);
        setSource('offline');
        setError('Unable to load live data');
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => { active = false; };
  }, [path, reloadIndex]);

  return {
    data,
    source,
    loading,
    error,
    reload: () => {
      setLoading(true);
      setError(null);
      setReloadIndex(current => current + 1);
    },
  };
}
