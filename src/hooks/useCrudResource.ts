import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';

/**
 * Live, editable list resource. Unlike useApiResource (read-only with demo
 * fallback), this hook owns create/update/delete and refreshes from the API
 * after each mutation. Falls back to the provided seed list only until the
 * first successful load, so the UI is never empty while offline.
 */
export function useCrudResource<T extends { id: string }>(path: string, fallback: T[]) {
  const [data, setData] = useState<T[]>(fallback);
  const [source, setSource] = useState<'live' | 'demo'>('demo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await apiRequest<T[]>(path);
      setData(rows);
      setSource('live');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [path]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const rows = await apiRequest<T[]>(path);
        if (!active) return;
        setData(rows);
        setSource('live');
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
    return () => {
      active = false;
    };
  }, [path]);

  async function mutate(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  const create = (body: Record<string, unknown>) =>
    mutate(() => apiRequest(path, { method: 'POST', body: JSON.stringify(body) }));

  const update = (id: string, body: Record<string, unknown>) =>
    mutate(() => apiRequest(`${path}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }));

  const remove = (id: string) =>
    mutate(() => apiRequest(`${path}/${id}`, { method: 'DELETE' }));

  return { data, source, busy, error, create, update, remove, refresh };
}
