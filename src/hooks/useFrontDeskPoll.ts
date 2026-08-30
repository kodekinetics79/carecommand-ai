import { useCallback, useSyncExternalStore } from 'react';
import { frontDeskApi, type TaskSummary } from '../lib/frontDesk';
import { describeFailure, type ResourceFailure } from '../lib/resourceState';

// ===========================================================================
// One shared poller for `GET /v1/tasks/summary` (design-C4 §2.1).
//
// The sidebar badge, the critical banner and the Front Desk header all read
// the same summary, so they share ONE interval rather than each polling on
// their own. The poll pauses while the tab is hidden, refetches the moment it
// becomes visible again, and refetches after any task mutation announced via
// `notifyFrontDeskMutated()`. Freshness is ≤20 s while a tab is open; there
// is no push, no browser notification and no SMS/email alert in this cycle
// (phase2-contracts §13) — the page and the Go-live card say so.
// ===========================================================================

export const FRONT_DESK_POLL_MS = 20_000;

export type FrontDeskPollState = 'loading' | 'ready' | 'error';

export interface FrontDeskPollSnapshot {
  data: TaskSummary | null;
  state: FrontDeskPollState;
  error: ResourceFailure | null;
}

type Listener = (snapshot: FrontDeskPollSnapshot) => void;

let snapshot: FrontDeskPollSnapshot = { data: null, state: 'loading', error: null };
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let visibilityBound = false;

function publish(next: FrontDeskPollSnapshot) {
  snapshot = next;
  listeners.forEach(listener => listener(snapshot));
}

async function fetchSummary(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const data = await frontDeskApi.taskSummary();
      publish({ data, state: 'ready', error: null });
    } catch (error) {
      // Keep the last good data so the page can still render it as stale, but
      // the state is 'error' so no badge is shown from it (never a fake zero).
      publish({ data: snapshot.data, state: 'error', error: describeFailure(error) });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function onVisibilityChange() {
  if (typeof document === 'undefined') return;
  if (document.hidden) {
    stopTimer();
  } else if (listeners.size > 0) {
    void fetchSummary();
    startTimer();
  }
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => { void fetchSummary(); }, FRONT_DESK_POLL_MS);
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    if (typeof document !== 'undefined' && !visibilityBound) {
      document.addEventListener('visibilitychange', onVisibilityChange);
      visibilityBound = true;
    }
    void fetchSummary();
    if (typeof document === 'undefined' || !document.hidden) startTimer();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopTimer();
      if (typeof document !== 'undefined' && visibilityBound) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        visibilityBound = false;
      }
    }
  };
}

/** Call after any task mutation (acknowledge, status, note, book) so every subscriber refreshes at once. */
export function notifyFrontDeskMutated(): void {
  if (listeners.size > 0) void fetchSummary();
}

/** Test seam: forget the shared snapshot between tests. Not for product code. */
export function resetFrontDeskPollForTests(): void {
  stopTimer();
  listeners.clear();
  inFlight = null;
  snapshot = { data: null, state: 'loading', error: null };
  if (typeof document !== 'undefined' && visibilityBound) {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = false;
  }
}

function getSnapshot(): FrontDeskPollSnapshot {
  return snapshot;
}

const DISABLED_SNAPSHOT: FrontDeskPollSnapshot = { data: null, state: 'loading', error: null };
function subscribeDisabled(): () => void { return () => {}; }
function getDisabledSnapshot(): FrontDeskPollSnapshot { return DISABLED_SNAPSHOT; }

/**
 * Subscribe to the shared summary. Pass `enabled: false` for a caller whose
 * session cannot read the queue (no staff:read / no ai_receptionist
 * entitlement); it then reports `loading` forever and never issues a request.
 */
export function useFrontDeskPoll(options: { enabled?: boolean } = {}): FrontDeskPollSnapshot & { refresh: () => Promise<void> } {
  const enabled = options.enabled ?? true;
  // useSyncExternalStore, not an effect + setState: the poller IS the external
  // store, and every subscriber must read the same snapshot in the same render.
  const current = useSyncExternalStore(
    enabled ? subscribe : subscribeDisabled,
    enabled ? getSnapshot : getDisabledSnapshot,
    getDisabledSnapshot,
  );

  const refresh = useCallback(async () => {
    if (enabled) await fetchSummary();
  }, [enabled]);

  return { ...current, refresh };
}
