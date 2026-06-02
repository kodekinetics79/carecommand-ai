import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api';

export function useApiResource<TApi, TView extends { id: string }>(
  path: string,
  fallback: TView[],
  mapRow: (row: TApi) => TView,
) {
  // Live-only by default. Demo data is opt-in (VITE_DEMO_FALLBACK=true) and is
  // only used as a placeholder until live data arrives / if the API is offline.
  const demoFallbackEnabled = import.meta.env.VITE_DEMO_FALLBACK === 'true';
  const demoRows = useMemo(() => demoFallbackEnabled ? fallback : [], [demoFallbackEnabled, fallback]);
  const [data, setData] = useState(demoRows);
  const [source, setSource] = useState<'live' | 'demo'>('demo');
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
        setData(demoRows);
        setSource('demo');
    });
    return () => { active = false; };
  }, [demoRows, mapRow, path, reloadIndex]);

  return { data, source, reload: () => setReloadIndex(current => current + 1) };
}
