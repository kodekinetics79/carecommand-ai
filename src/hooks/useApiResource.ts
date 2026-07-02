import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';

const EMPTY_ROWS: never[] = [];

export function useApiResource<TApi, TView extends { id: string }>(
  path: string,
  fallback: TView[],
  mapRow: (row: TApi) => TView,
) {
  const fallbackRef = useRef(fallback);
  const [data, setData] = useState<TView[]>(fallbackRef.current ?? EMPTY_ROWS);
  const [source, setSource] = useState<'live' | 'offline'>('offline');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadIndex, setReloadIndex] = useState(0);

  useEffect(() => {
    let active = true;
    apiRequest<TApi[] | { data: TApi[] }>(path)
      .then(response => {
        const rows = Array.isArray(response) ? response : response.data;
        if (!active) return;
        // Always show live data once it loads, even when empty — never merge mock in.
        setData(rows.map(mapRow));
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
  }, [mapRow, path, reloadIndex]);

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
