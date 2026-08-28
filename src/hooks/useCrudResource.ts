import { useCallback, useState } from 'react';
import { apiRequest } from '../lib/api';
import { describeFailure, type ResourceFailure } from '../lib/resourceState';
import { useResource } from './useResource';

/**
 * Live, editable list resource. It owns create/update/delete and reloads from
 * the API after each mutation.
 *
 * Reads run through the shared screen-state contract (useResource), so a list
 * that failed to load reports `error` instead of rendering as an empty list —
 * the previous seed-list fallback made "offline" and "you have none" look the
 * same. A mutation that fails reports its own failure rather than silently
 * leaving the old rows on screen.
 */
export function useCrudResource<T extends { id: string }>(path: string) {
  const { state, reload } = useResource<T[]>(path);
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<ResourceFailure | null>(null);

  const mutate = useCallback(async (run: () => Promise<unknown>) => {
    setBusy(true);
    setActionFailure(null);
    try {
      await run();
      reload();
    } catch (err) {
      setActionFailure(describeFailure(err));
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const create = (body: Record<string, unknown>) =>
    mutate(() => apiRequest(path, { method: 'POST', body: JSON.stringify(body) }));

  const update = (id: string, body: Record<string, unknown>) =>
    mutate(() => apiRequest(`${path}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }));

  const remove = (id: string) =>
    mutate(() => apiRequest(`${path}/${id}`, { method: 'DELETE' }));

  return { state, reload, busy, actionFailure, create, update, remove };
}
