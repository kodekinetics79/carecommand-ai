import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api';

/** One-shot GET for object responses (not lists). Exposes loading/error/reload. */
export function useApiData<T>(path: string, fallback: T) {
  const fallbackRef = useRef(fallback);
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [errorPath, setErrorPath] = useState<string | null>(null);

  // Awaitable manual refresh. All state updates happen after the await, so this
  // is safe to call from event handlers and from the effect below.
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorPath(null);
    try {
      const res = await apiRequest<T>(path);
      setData(res);
      setError(null);
      setLoadedPath(path);
    } catch (err) {
      setData(fallbackRef.current);
      setError(err instanceof Error ? err.message : 'Failed to load');
      setErrorPath(path);
      setLoadedPath(path);
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
        setErrorPath(null);
        setLoadedPath(path);
      } catch (err) {
        if (!active) return;
        setData(fallbackRef.current);
        setError(err instanceof Error ? err.message : 'Failed to load');
        setErrorPath(path);
        setLoadedPath(path);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [path]);

  return { data, loading, error, loadedPath, errorPath, reload, setData };
}
