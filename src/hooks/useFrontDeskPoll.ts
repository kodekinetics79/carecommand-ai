import { useCallback, useSyncExternalStore } from 'react';
import { frontDeskApi, type TaskSummary } from '../lib/frontDesk';
import { authEventName } from '../lib/session';
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

const EMPTY_SNAPSHOT: FrontDeskPollSnapshot = { data: null, state: 'loading', error: null };

let snapshot: FrontDeskPollSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let visibilityBound = false;
let authBound = false;
/**
 * Bumped by every reset. A response that started before the reset carries the
 * previous session's (or previous tenant's) counts, so it is dropped on arrival
 * instead of being published as live.
 */
let generation = 0;
/** Set when a mutation lands while a poll is already in flight — see fetchSummary. */
let refetchQueued = false;

function publish(next: FrontDeskPollSnapshot) {
  snapshot = next;
  listeners.forEach(listener => listener(snapshot));
}

/**
 * One request at a time. A caller that arrives while a request is in flight
 * normally joins it — but a caller that has just CHANGED something must not:
 * the in-flight response was issued before the mutation and would repaint the
 * acknowledged emergency as still open for another 20 s. Those callers queue a
 * follow-up fetch instead (`fresh`).
 */
async function fetchSummary(options: { fresh?: boolean } = {}): Promise<void> {
  if (inFlight) {
    if (options.fresh) refetchQueued = true;
    return inFlight;
  }
  const startedAt = generation;
  inFlight = (async () => {
    try {
      const data = await frontDeskApi.taskSummary();
      if (startedAt === generation) publish({ data, state: 'ready', error: null });
    } catch (error) {
      // Keep the last good data so the page can still render it as stale, but
      // the state is 'error' so no badge is shown from it (never a fake zero).
      if (startedAt === generation) publish({ data: snapshot.data, state: 'error', error: describeFailure(error) });
    } finally {
      inFlight = null;
    }
  })();
  await inFlight;
  if (refetchQueued) {
    refetchQueued = false;
    if (listeners.size > 0) await fetchSummary();
  }
}

/**
 * The session changed (sign-in, sign-out, token cleared). Counts belong to the
 * session that fetched them: showing the previous tenant's numbers as live
 * after a switch is the same class of lie as showing a stale zero.
 */
function onAuthChange() {
  resetFrontDeskPoll();
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
    if (typeof window !== 'undefined' && !authBound) {
      window.addEventListener(authEventName, onAuthChange);
      authBound = true;
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
      if (typeof window !== 'undefined' && authBound) {
        window.removeEventListener(authEventName, onAuthChange);
        authBound = false;
      }
    }
  };
}

/** Call after any task mutation (acknowledge, status, note, book) so every subscriber refreshes at once. */
export function notifyFrontDeskMutated(): void {
  if (listeners.size > 0) void fetchSummary({ fresh: true });
}

/**
 * Discard the shared snapshot and, if anything is still subscribed, fetch a new
 * one. Called on every auth change; also the test seam.
 *
 * The snapshot is module state, so without this a sign-out leaves the previous
 * session's counts in memory and the sidebar renders them as live for the first
 * paint of the next session.
 */
export function resetFrontDeskPoll(): void {
  generation += 1;
  inFlight = null;
  refetchQueued = false;
  publish(EMPTY_SNAPSHOT);
  if (listeners.size > 0) {
    void fetchSummary();
    if (typeof document === 'undefined' || !document.hidden) startTimer();
  } else {
    stopTimer();
  }
}

/** Test seam: forget the shared snapshot AND every subscriber between tests. Not for product code. */
export function resetFrontDeskPollForTests(): void {
  stopTimer();
  listeners.clear();
  generation += 1;
  inFlight = null;
  refetchQueued = false;
  snapshot = EMPTY_SNAPSHOT;
  if (typeof document !== 'undefined' && visibilityBound) {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = false;
  }
  if (typeof window !== 'undefined' && authBound) {
    window.removeEventListener(authEventName, onAuthChange);
    authBound = false;
  }
}

function getSnapshot(): FrontDeskPollSnapshot {
  return snapshot;
}

const DISABLED_SNAPSHOT: FrontDeskPollSnapshot = EMPTY_SNAPSHOT;
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
