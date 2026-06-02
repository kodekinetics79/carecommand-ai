import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';

/** One-shot GET for object responses (not lists). Exposes loading/error/reload. */
export function useApiData<T>(path: string, fallback: T) {
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
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

  useEffect(() => { void reload(); }, [reload]);

  return { data, loading, error, reload, setData };
}
