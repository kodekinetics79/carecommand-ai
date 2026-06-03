import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';

/** One-shot GET for object responses (not lists). Exposes loading/error/reload. */
export function useApiData<T>(path: string, fallback: T) {
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Awaitable manual refresh. All state updates happen after the await, so this
  // is safe to call from event handlers and from the effect below.
  const reload = useCallback(async () => {
    try {
      const res = await apiRequest<T>(path);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await apiRequest<T>(path);
        if (!active) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [path]);

  return { data, loading, error, reload, setData };
}
