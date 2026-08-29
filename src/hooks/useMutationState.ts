import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { describeFailure, type ResourceFailure } from '../lib/resourceState';

/**
 * Shared mutation-state contract for Studio / Front Desk actions.
 *
 * A mutation is in exactly one of four states, and each state licenses one
 * claim on screen:
 *
 *   idle  — nothing has been attempted since the last reset.
 *   busy  — a request is in flight; controls should be disabled.
 *   saved — the server accepted the write. Only reachable from a 2xx.
 *   error — the server (or the network) refused. Carries the server's own
 *           `code` and `message`, plus per-field errors for a Zod 400, so the
 *           panel can show the real cause and an action instead of nothing.
 *
 * `run` never throws: a failed action becomes an `error` state, never an
 * unhandled rejection that leaves the "Save" button re-enabled and the user
 * believing the write happened.
 */
export type MutationState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'saved'; savedAt: number; message?: string }
  | { status: 'error'; message: string; code: string | null; fieldErrors: Record<string, string[]>; failure: ResourceFailure };

export type MutationError = Extract<MutationState, { status: 'error' }>;

const VALIDATION_CODE = 'VALIDATION_ERROR';

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

/**
 * Reads `details.fieldErrors` out of an API error body. errors.ts sends the
 * Zod shape as `{ error: 'VALIDATION_ERROR', details: { fieldErrors, formErrors } }`
 * and ApiError.details is the whole body, so look one level down first and
 * accept the flattened shape too in case a caller hands the map in directly.
 */
export function extractFieldErrors(details: Readonly<Record<string, unknown>> | undefined): Record<string, string[]> {
  if (!details) return {};
  const nested = details.details;
  const source = nested && typeof nested === 'object' && 'fieldErrors' in (nested as Record<string, unknown>)
    ? (nested as Record<string, unknown>).fieldErrors
    : details.fieldErrors;
  if (!source || typeof source !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(source as Record<string, unknown>)) {
    const list = asStringList(messages);
    if (list.length) out[field] = list;
  }
  return out;
}

/** Plain-language field name for a dotted Zod path ("bookingRules.hoursStart" -> "hours start"). */
export function humanizeFieldName(path: string): string {
  const leaf = path.split('.').pop() ?? path;
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase();
}

/**
 * Maps whatever a mutation threw into the `error` state.
 *
 * - Zod 400 (`VALIDATION_ERROR` with `details.fieldErrors`): the message is the
 *   first field error, named by its field, and the whole map is kept so a form
 *   can mark each input.
 * - 409: keeps the server `code` and its own `message` (it is the actionable one).
 * - Network / 5xx / everything else: `describeFailure` sentences.
 */
export function describeMutationFailure(error: unknown): MutationError {
  const failure = describeFailure(error);
  const fieldErrors = error instanceof ApiError ? extractFieldErrors(error.details) : {};
  const code = error instanceof ApiError ? error.code ?? null : failure.code ?? null;
  let message = failure.message;
  const firstField = Object.entries(fieldErrors)[0];
  if (error instanceof ApiError && error.status === 400 && (code === VALIDATION_CODE || firstField) && firstField) {
    const [field, messages] = firstField;
    message = `${humanizeFieldName(field)}: ${messages[0]}`;
  } else if (error instanceof ApiError && error.status === 400 && code === VALIDATION_CODE) {
    const formErrors = asStringList((error.details?.details as Record<string, unknown> | undefined)?.formErrors);
    if (formErrors.length) message = formErrors[0];
  }
  return { status: 'error', message, code, fieldErrors, failure };
}

export interface MutationRunOptions {
  /** Shown in the saved pill instead of the default "Saved". */
  successMessage?: string;
  /**
   * Record the failure in `state` AND rethrow it. For actions run from inside
   * a confirmation dialog, which must stay open and show the cause itself.
   */
  rethrow?: boolean;
}

export interface UseMutationStateResult {
  state: MutationState;
  /** Runs the action. Resolves to its result, or `undefined` when it failed (the failure is in `state`). */
  run<T>(fn: () => Promise<T>, opts?: MutationRunOptions): Promise<T | undefined>;
  reset(): void;
}

export function useMutationState(): UseMutationStateResult {
  const [state, setState] = useState<MutationState>({ status: 'idle' });
  const mounted = useRef(true);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async <T,>(fn: () => Promise<T>, opts?: MutationRunOptions): Promise<T | undefined> => {
    const ticket = ++sequence.current;
    const settle = (next: MutationState) => {
      // A later run owns the state now; an earlier one settling must not
      // overwrite it (a slow failure landing after a fast success would show
      // an error for a write that went through).
      if (mounted.current && sequence.current === ticket) setState(next);
    };
    setState({ status: 'busy' });
    try {
      const result = await fn();
      settle({ status: 'saved', savedAt: Date.now(), ...(opts?.successMessage ? { message: opts.successMessage } : {}) });
      return result;
    } catch (error) {
      settle(describeMutationFailure(error));
      if (opts?.rethrow) throw error;
      return undefined;
    }
  }, []);

  const reset = useCallback(() => {
    sequence.current += 1;
    setState({ status: 'idle' });
  }, []);

  return { state, run, reset };
}

/** Convenience for `disabled={...}` props. */
export function isBusy(state: MutationState): boolean {
  return state.status === 'busy';
}

/** The `savedAt` timestamp, or null — matches the existing `SaveBar` prop. */
export function savedAtOf(state: MutationState): number | null {
  return state.status === 'saved' ? state.savedAt : null;
}
