import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  LOADING_STATE,
  defaultIsEmpty,
  describeFailure,
  hasResponse,
  receivedData,
  resolveResourceState,
  resourceFailure,
  timedOutFailure,
  type ResourceState,
} from './resourceState';

// The exact sentences the contract promises. Spelled out rather than imported
// so that rewording the copy is a deliberate, visible change and not something
// a test silently agrees with.
const PERMISSION_SENTENCE =
  'Your role does not have access to this data, so nothing was loaded. Ask a workspace administrator if you need it.';
const SESSION_SENTENCE = 'Your session has expired, so nothing was loaded. Sign in again to continue.';
const OFFLINE_SENTENCE =
  'The server could not be reached, so nothing was loaded. Check your connection and try again.';

// Real 403 bodies. Only the first is a statement about the user's ROLE; the
// other two are statements about the workspace, and the remedy differs.
const ENTITLEMENT_MESSAGE = 'Campaign automation is not included in the Starter plan. Upgrade to Growth to enable it.';
const SUSPENSION_MESSAGE = 'This workspace is suspended. Contact CareCommand support to restore access.';
const RBAC_MESSAGE = 'Forbidden: missing required permission (billing:read)';

describe('describeFailure', () => {
  it('keeps the server explanation for a feature_locked 403', () => {
    // The remedy is a plan upgrade the tenant can actually buy. Replacing this
    // with the RBAC sentence sends an owner to ask themselves for permission.
    const failure = describeFailure(new ApiError(403, ENTITLEMENT_MESSAGE, 'feature_locked'));

    expect(failure.message).toBe(ENTITLEMENT_MESSAGE);
    expect(failure.permissionDenied).toBe(false);
    expect(failure.code).toBe('feature_locked');
    expect(failure.status).toBe(403);
  });

  it('replaces the permission string with the role sentence for an insufficient_permission 403', () => {
    const failure = describeFailure(new ApiError(403, RBAC_MESSAGE, 'insufficient_permission'));

    expect(failure.message).toBe(PERMISSION_SENTENCE);
    expect(failure.message).not.toContain('billing:read');
    expect(failure.permissionDenied).toBe(true);
  });

  it('keeps the server explanation for a 403 that is neither RBAC nor entitlement', () => {
    // errors.ts sends `handledError.code ?? 'INTERNAL_SERVER_ERROR'`, so a
    // suspension arrives with that code and its own accurate sentence. Nobody
    // in the workspace can grant their way out of it.
    const failure = describeFailure(new ApiError(403, SUSPENSION_MESSAGE, 'INTERNAL_SERVER_ERROR'));

    expect(failure.message).toBe(SUSPENSION_MESSAGE);
    expect(failure.permissionDenied).toBe(false);
  });

  it('names an expired session rather than reporting it as a fault', () => {
    const failure = describeFailure(new ApiError(401, 'Unauthorized', 'unauthorized'));

    expect(failure.message).toBe(SESSION_SENTENCE);
    expect(failure.sessionExpired).toBe(true);
    expect(failure.permissionDenied).toBe(false);
  });

  it('reports an unreachable API as offline rather than as an empty answer', () => {
    const failure = describeFailure(new TypeError('Failed to fetch'));

    expect(failure.message).toBe(OFFLINE_SENTENCE);
    expect(failure.offline).toBe(true);
    expect(failure.status).toBeUndefined();
  });

  it('never returns a blank message, whatever it was handed', () => {
    const candidates: unknown[] = [
      new ApiError(500, '', 'INTERNAL_SERVER_ERROR'),
      new ApiError(403, '   ', 'feature_locked'),
      new Error(''),
      'a bare string',
      null,
      undefined,
    ];

    for (const candidate of candidates) {
      expect(describeFailure(candidate).message.trim()).not.toBe('');
    }
  });
});

describe('the four-state contract', () => {
  const received = <T,>(data: T): ResourceState<T> => ({ status: 'ready', data, receivedAt: 1_700_000_000_000 });
  const failed = (): ResourceState<string[]> => ({ status: 'error', failure: timedOutFailure(15_000) });

  it('never resolves an error into empty or ready, and yields no data', () => {
    const state = failed();

    // Even an isEmpty that says "everything is empty" cannot manufacture the
    // empty state out of a request that failed.
    const view = resolveResourceState(state, () => true);

    expect(view.status).toBe('error');
    expect(view).toBe(state);
    expect(receivedData(view)).toBeNull();
    expect(hasResponse(view)).toBe(false);
    expect(resourceFailure(view)?.timedOut).toBe(true);
    expect('data' in view).toBe(false);
  });

  it('never resolves a loading state into empty or ready, and yields no data', () => {
    const state: ResourceState<string[]> = LOADING_STATE;

    const view = resolveResourceState(state, () => true);

    expect(view.status).toBe('loading');
    expect(receivedData(view)).toBeNull();
    expect(hasResponse(view)).toBe(false);
    expect(resourceFailure(view)).toBeNull();
    expect('data' in view).toBe(false);
  });

  it('produces empty only from a value that was received', () => {
    const view = resolveResourceState(received<string[]>([]));

    expect(view.status).toBe('empty');
    expect(receivedData(view)).toEqual([]);
    expect(hasResponse(view)).toBe(true);
    expect(resourceFailure(view)).toBeNull();
  });

  it('keeps a received value that carries records in ready', () => {
    const view = resolveResourceState(received(['a-row']));

    expect(view.status).toBe('ready');
    expect(receivedData(view)).toEqual(['a-row']);
  });

  it('re-resolves a stale empty back to ready when the value now carries records', () => {
    const stale: ResourceState<string[]> = { status: 'empty', data: ['a-row'], receivedAt: 1 };

    expect(resolveResourceState(stale).status).toBe('ready');
  });

  it('treats a missing body as empty and a zero-valued body as data', () => {
    // A zero that was received is a fact; a zero invented for a panel that
    // never answered is the defect this contract exists to prevent.
    expect(defaultIsEmpty([])).toBe(true);
    expect(defaultIsEmpty(null)).toBe(true);
    expect(defaultIsEmpty(undefined)).toBe(true);
    expect(defaultIsEmpty(0)).toBe(false);
    expect(defaultIsEmpty({ checksPassed: 0 })).toBe(false);
  });
});
