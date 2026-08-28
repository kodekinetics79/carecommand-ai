import { ApiError, humanApiMessage } from './api';

/**
 * Shared screen-state contract.
 *
 * A panel is in exactly one of four mutually exclusive states, and each state
 * licenses exactly one kind of claim:
 *
 *   loading — a request is in flight. No value, no dash, no zero.
 *   error   — the request failed. Nothing may be rendered that could be read
 *             as data: not a number, not an em dash, not "no records".
 *   empty   — a response WAS received and carried no records. This is a
 *             factual claim about the workspace, so it is only reachable from
 *             a successful response.
 *   ready   — a response was received and carried records.
 *
 * `useResource` only ever produces loading | error | ready; `empty` is derived
 * from a received value by `resolveResourceState`. An empty state therefore
 * cannot be manufactured out of a failed or in-flight request, which is the
 * defect this contract exists to prevent (a failed request rendering "0" or
 * "No users" is indistinguishable from an empty workspace).
 */

export interface ResourceFailure {
  /** Plain-language sentence. Never a raw status code or permission string. */
  readonly message: string;
  /** HTTP status when the API answered at all. Absent when it did not. */
  readonly status?: number;
  /** Server error code (ApiError.code) so callers can branch on a known case. */
  readonly code?: string;
  /** The load was stopped by the watchdog instead of being answered. */
  readonly timedOut: boolean;
  /** The request never reached the API (network / CORS / server down). */
  readonly offline: boolean;
  /** Refused for permission reasons; retrying waits on an administrator. */
  readonly permissionDenied: boolean;
  /** The session is gone; the user must sign in again. */
  readonly sessionExpired: boolean;
}

export type ResourceState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly failure: ResourceFailure }
  | { readonly status: 'empty'; readonly data: T; readonly receivedAt: number }
  | { readonly status: 'ready'; readonly data: T; readonly receivedAt: number };

/** The single loading value; the state carries no data, so it needs no type. */
export const LOADING_STATE: ResourceState<never> = { status: 'loading' };

const OFFLINE_MESSAGE = 'The server could not be reached, so nothing was loaded. Check your connection and try again.';
const UNKNOWN_MESSAGE = 'The request did not complete, so nothing was loaded. Please try again.';
const PERMISSION_MESSAGE = 'Your role does not have access to this data, so nothing was loaded. Ask a workspace administrator if you need it.';
const SESSION_MESSAGE = 'Your session has expired, so nothing was loaded. Sign in again to continue.';

/** Message for a load the watchdog stopped rather than one the server answered. */
export function timeoutMessage(timeoutMs: number): string {
  return `The server did not answer within ${Math.round(timeoutMs / 1000)} seconds, so the request was stopped and nothing was loaded.`;
}

export function timedOutFailure(timeoutMs: number): ResourceFailure {
  return {
    message: timeoutMessage(timeoutMs),
    timedOut: true,
    offline: false,
    permissionDenied: false,
    sessionExpired: false,
  };
}

/**
 * Turns whatever a loader threw into one plain-language sentence.
 *
 * A server-supplied `message` wins (it is usually the actionable one), except
 * on 401/403 where the server's own words are a permission string rather than
 * something a clinic user can act on.
 */
export function describeFailure(error: unknown): ResourceFailure {
  if (error instanceof ApiError) {
    // Only a genuine RBAC denial gets the permission sentence. errors.ts sends
    // `handledError.code ?? 'INTERNAL_SERVER_ERROR'`, so an entitlement denial
    // carries 'feature_locked' and names a real upgrade the tenant can buy,
    // while a suspension or branch-scope refusal carries its own explanation.
    // Overriding all three told the user their ROLE was the problem when it was
    // not — the same mislabelling this contract exists to remove.
    const permissionDenied = error.status === 403 && error.code === 'insufficient_permission';
    const sessionExpired = error.status === 401;
    const message = permissionDenied
      ? PERMISSION_MESSAGE
      : sessionExpired
        ? SESSION_MESSAGE
        : error.message.trim() || humanApiMessage(error.status);
    return {
      message,
      status: error.status,
      code: error.code,
      timedOut: false,
      offline: false,
      permissionDenied,
      sessionExpired,
    };
  }

  // fetch() rejects with a TypeError when the request never reached the API.
  if (error instanceof TypeError) {
    return { message: OFFLINE_MESSAGE, timedOut: false, offline: true, permissionDenied: false, sessionExpired: false };
  }

  if (error instanceof Error) {
    // api.ts throws this plain Error when the shared refresh fails.
    const sessionExpired = error.message.startsWith('Session expired');
    return {
      message: sessionExpired ? SESSION_MESSAGE : error.message.trim() || UNKNOWN_MESSAGE,
      timedOut: false,
      offline: false,
      permissionDenied: false,
      sessionExpired,
    };
  }

  return { message: UNKNOWN_MESSAGE, timedOut: false, offline: false, permissionDenied: false, sessionExpired: false };
}

/**
 * Default emptiness test: an empty list, or a response with no body at all.
 * Anything else counts as a value that was received and must be shown.
 */
export function defaultIsEmpty(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  return data == null;
}

/**
 * Refines a settled state into the four-state view. `empty` is produced here
 * and only here, and only from data that arrived in a successful response.
 */
export function resolveResourceState<T>(state: ResourceState<T>, isEmpty?: (data: T) => boolean): ResourceState<T> {
  if (state.status !== 'ready' && state.status !== 'empty') return state;
  const empty = (isEmpty ?? defaultIsEmpty)(state.data);
  if (empty === (state.status === 'empty')) return state;
  return empty
    ? { status: 'empty', data: state.data, receivedAt: state.receivedAt }
    : { status: 'ready', data: state.data, receivedAt: state.receivedAt };
}

/**
 * The received value, or null when nothing was received. Use this only where a
 * value is genuinely optional decoration; never pair it with `?? 0` or `?? '—'`
 * to fill a hole left by a failed request.
 */
export function receivedData<T>(state: ResourceState<T>): T | null {
  return state.status === 'ready' || state.status === 'empty' ? state.data : null;
}

/** True once a response has been received, whatever it contained. */
export function hasResponse<T>(state: ResourceState<T>): boolean {
  return state.status === 'ready' || state.status === 'empty';
}

/** The failure, or null when the resource did not fail. */
export function resourceFailure<T>(state: ResourceState<T>): ResourceFailure | null {
  return state.status === 'error' ? state.failure : null;
}
