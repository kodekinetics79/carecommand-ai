import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../lib/api';

export function useApiResource<TApi, TView extends { id: string }>(
  path: string,
  fallback: TView[],
  mapRow: (row: TApi) => TView,
) {
  const demoFallbackEnabled = import.meta.env.DEV || import.meta.env.VITE_DEMO_FALLBACK === 'true';
  const demoRows = useMemo(() => demoFallbackEnabled ? fallback : [], [demoFallbackEnabled, fallback]);
  const [data, setData] = useState(demoRows);
  const [source, setSource] = useState<'live' | 'demo'>('demo');
  const [reloadIndex, setReloadIndex] = useState(0);

  useEffect(() => {
    let active = true;
    apiRequest<TApi[] | { data: TApi[] }>(path)
      .then(response => {
        const rows = Array.isArray(response) ? response : response.data;
        if (!active || rows.length === 0) return;
        const liveRows = rows.map(mapRow);
        setData(demoFallbackEnabled ? [...liveRows, ...demoRows.filter(row => !liveRows.some(liveRow => liveRow.id === row.id))] : liveRows);
        setSource('live');
      })
      .catch(() => {
        if (!active) return;
        setData(demoRows);
        setSource('demo');
    });
    return () => { active = false; };
  }, [demoFallbackEnabled, demoRows, mapRow, path, reloadIndex]);

  return { data, source, reload: () => setReloadIndex(current => current + 1) };
}
