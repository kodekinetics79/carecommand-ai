import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';
import { LOADING_STATE, describeFailure, timedOutFailure, type ResourceState } from '../lib/resourceState';

/**
 * Loader for anything that is not a single GET (composed calls, mapped rows).
 * It must keep the same identity across renders — declare it at module scope or
 * wrap it in useCallback — because its identity is what identifies the request.
 */
export type ResourceLoader<T> = (signal: AbortSignal) => Promise<T>;
export type ResourceSource<T> = string | ResourceLoader<T>;

/**
 * How long a load may stay in flight before the hook stops waiting. This is
 * what makes "Loading…" guaranteed to terminate: the state transition is driven
 * by the timer, not by the request, so a socket that never answers still ends
 * in a named error with a retry instead of a permanent spinner.
 */
export const RESOURCE_TIMEOUT_MS = 15_000;

export interface UseResourceOptions {
  /** Override the watchdog. Keep it finite; there is no "wait forever" option. */
  timeoutMs?: number;
  /**
   * Whether to ask at all. Default true.
   *
   * Two callers need this, and both mean "the question is not askable yet or
   * ever": one waiting for the session to resolve before it knows whether the
   * user may see this data, and one that already knows they may not. A hook
   * cannot be called conditionally, so the choice has to live here.
   *
   * A disabled resource issues NO request and stays `loading`. That is
   * deliberate for the first caller — it is genuinely still waiting — and safe
   * for the second only because a panel the user is not permitted to see is
   * not rendered at all. Do not render a disabled resource and expect it to
   * resolve: it never will, because nothing was asked.
   */
  enabled?: boolean;
}

export interface UseResourceResult<T> {
  state: ResourceState<T>;
  /** Discards the current state and issues the request again. */
  reload: () => void;
}

interface SettledRecord<T> {
  source: ResourceSource<T>;
  attempt: number;
  state: ResourceState<T>;
}

/**
 * One request, modelled as the shared screen-state contract.
 *
 * The state is keyed to the request that produced it, so changing `source`
 * (a new filter, a new id) reads as `loading` immediately instead of leaving
 * the previous answer on screen under a new question, and `reload()` does the
 * same. Nothing here ever falls back to seed data: when a request fails the
 * state is `error`, and the caller has no value to render.
 */
export function useResource<T>(source: ResourceSource<T>, options: UseResourceOptions = {}): UseResourceResult<T> {
  const { timeoutMs = RESOURCE_TIMEOUT_MS, enabled = true } = options;
  const [attempt, setAttempt] = useState(0);
  const [record, setRecord] = useState<SettledRecord<T>>(() => ({ source, attempt: 0, state: LOADING_STATE }));

  useEffect(() => {
    // Not asked, so nothing is in flight and nothing will settle. The state
    // below stays `loading`, which is the truth: no answer has been received.
    if (!enabled) return;

    let active = true;
    let settled = false;
    const controller = new AbortController();

    const watchdog = setTimeout(() => {
      if (!active || settled) return;
      settled = true;
      controller.abort();
      setRecord({ source, attempt, state: { status: 'error', failure: timedOutFailure(timeoutMs) } });
    }, timeoutMs);

    let request: Promise<T>;
    try {
      request = typeof source === 'string'
        ? apiRequest<T>(source, { signal: controller.signal })
        : source(controller.signal);
    } catch (error) {
      // A loader that throws before it returns is still a failed load: route it
      // through the same rejection path instead of crashing the render.
      request = Promise.reject(error);
    }

    void request.then(
      data => {
        if (!active || settled) return;
        settled = true;
        clearTimeout(watchdog);
        setRecord({ source, attempt, state: { status: 'ready', data, receivedAt: Date.now() } });
      },
      error => {
        if (!active || settled) return;
        settled = true;
        clearTimeout(watchdog);
        setRecord({ source, attempt, state: { status: 'error', failure: describeFailure(error) } });
      },
    );

    return () => {
      active = false;
      clearTimeout(watchdog);
      controller.abort();
    };
  }, [source, attempt, timeoutMs, enabled]);

  const reload = useCallback(() => setAttempt(current => current + 1), []);

  // Derived, not stored: a record from an earlier source or attempt is not an
  // answer to the question being asked now, so it reads as loading.
  const state = enabled && record.source === source && record.attempt === attempt ? record.state : LOADING_STATE;

  return { state, reload };
}
