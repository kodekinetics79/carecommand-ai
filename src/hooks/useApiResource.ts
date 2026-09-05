import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';

const EMPTY_ROWS: never[] = [];

export function useApiResource<TApi, TView extends { id: string }>(
  path: string,
  fallback: TView[],
  mapRow: (row: TApi) => TView,
  options: { allPages?: boolean; maxPages?: number; enabled?: boolean } = {},
) {
  const fallbackRef = useRef(fallback);
  // Lazy initializer: reads the prop once on mount (refs must not be read
  // during render; the ref is only for the async catch below).
  const [data, setData] = useState<TView[]>(() => fallback ?? EMPTY_ROWS);
  const [source, setSource] = useState<'live' | 'offline'>('offline');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [errorPath, setErrorPath] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [reloadIndex, setReloadIndex] = useState(0);
  const allPages = options.allPages === true;
  const maxPages = options.maxPages ?? 20;
  const enabled = options.enabled !== false;

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
    if (!enabled) return () => { active = false; };
    const load = async () => {
      const rows: TApi[] = [];
      let cursor: string | undefined;
      let remainingCursor: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const separator = path.includes('?') ? '&' : '?';
        const pagePath = cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path;
        const response = await apiRequest<TApi[] | { data: TApi[]; nextCursor?: string }>(pagePath);
        if (Array.isArray(response)) {
          rows.push(...response);
          break;
        }
        rows.push(...response.data);
        remainingCursor = response.nextCursor;
        if (!allPages || !response.nextCursor) break;
        if (page === maxPages - 1) throw new Error('The result exceeded the safe page limit. Narrow the selected scope.');
        cursor = response.nextCursor;
      }
      return { rows, nextCursor: allPages ? undefined : remainingCursor };
    };
    load()
      .then(result => {
        if (!active) return;
        // Always show live data once it loads, even when empty — never merge mock in.
        setData(result.rows.map(row => mapRowRef.current(row)));
        setNextCursor(result.nextCursor);
        setSource('live');
        setError(null);
        setErrorPath(null);
        setLoadedPath(path);
      })
      .catch(() => {
        if (!active) return;
        setData(fallbackRef.current ?? EMPTY_ROWS);
        setNextCursor(undefined);
        setSource('offline');
        setError('Unable to load live data');
        setErrorPath(path);
        setLoadedPath(path);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => { active = false; };
  }, [allPages, enabled, maxPages, path, reloadIndex]);

  return {
    data,
    source,
    loading,
    error,
    loadedPath,
    errorPath,
    nextCursor,
    reload: () => {
      setLoading(true);
      setError(null);
      setReloadIndex(current => current + 1);
    },
  };
}
