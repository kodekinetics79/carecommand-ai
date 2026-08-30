import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api';
import { describeMutationFailure, useMutationState } from './useMutationState';

/**
 * The mutation-state contract: a failed action never disappears. Every error
 * becomes an `error` state carrying the server's own message and code, a Zod
 * 400 names the first failing field, and a success is only ever claimed from
 * a resolved action.
 */
function validationError(fieldErrors: Record<string, string[]>, formErrors: string[] = []) {
  const first = Object.entries(fieldErrors)[0];
  const message = first ? `${first[0]}: ${first[1][0]}` : formErrors[0] ?? 'Request validation failed';
  return new ApiError(400, message, 'VALIDATION_ERROR', {
    error: 'VALIDATION_ERROR',
    message,
    requestId: 'req-1',
    details: { fieldErrors, formErrors },
  });
}

describe('useMutationState', () => {
  it('starts idle, is busy while the action runs, and is saved only once it resolves', async () => {
    const { result } = renderHook(() => useMutationState());
    expect(result.current.state.status).toBe('idle');

    let resolve!: (value: string) => void;
    const pending = new Promise<string>(r => { resolve = r; });
    let outcome: Promise<string | undefined>;
    act(() => { outcome = result.current.run(() => pending, { successMessage: 'Clinic saved' }); });
    expect(result.current.state.status).toBe('busy');

    await act(async () => { resolve('row'); await outcome; });
    expect(result.current.state).toMatchObject({ status: 'saved', message: 'Clinic saved' });
    expect(await outcome!).toBe('row');
  });

  it('maps a Zod 400 to the first field error and keeps the whole field map', async () => {
    const { result } = renderHook(() => useMutationState());
    const error = validationError({
      humanFallbackNumber: ['Phone must include country code in E.164 format'],
      timezone: ['Invalid IANA timezone'],
    });

    let outcome: unknown = 'not-run';
    await act(async () => { outcome = await result.current.run(() => Promise.reject(error)); });

    expect(outcome).toBeUndefined();
    expect(result.current.state).toMatchObject({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: 'human fallback number: Phone must include country code in E.164 format',
      fieldErrors: {
        humanFallbackNumber: ['Phone must include country code in E.164 format'],
        timezone: ['Invalid IANA timezone'],
      },
    });
  });

  it('keeps the server code and message on a 409', async () => {
    const { result } = renderHook(() => useMutationState());
    const conflict = new ApiError(409, 'Provider deployment drift detected. Pause active and runnable campaigns before approving the new immutable version.', 'provider_deployment_drift', { code: 'provider_deployment_drift' });

    await act(async () => { await result.current.run(() => Promise.reject(conflict)); });

    expect(result.current.state).toMatchObject({
      status: 'error',
      code: 'provider_deployment_drift',
      message: 'Provider deployment drift detected. Pause active and runnable campaigns before approving the new immutable version.',
      fieldErrors: {},
    });
  });

  it('describes a network failure and a 5xx in plain language instead of swallowing them', async () => {
    const { result } = renderHook(() => useMutationState());

    await act(async () => { await result.current.run(() => Promise.reject(new TypeError('Failed to fetch'))); });
    expect(result.current.state).toMatchObject({ status: 'error', code: null });
    expect(result.current.state.status === 'error' && result.current.state.failure.offline).toBe(true);
    expect(result.current.state.status === 'error' && result.current.state.message).toMatch(/could not be reached/);

    await act(async () => { await result.current.run(() => Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR'))); });
    expect(result.current.state).toMatchObject({ status: 'error', code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred' });
  });

  it('rethrows when asked so a confirmation dialog can keep its own contract, while still recording the failure', async () => {
    const { result } = renderHook(() => useMutationState());
    const conflict = new ApiError(409, 'Agent history is referenced by a campaign.', 'INTERNAL_SERVER_ERROR');

    await act(async () => {
      await expect(result.current.run(() => Promise.reject(conflict), { rethrow: true })).rejects.toBe(conflict);
    });
    expect(result.current.state).toMatchObject({ status: 'error', message: 'Agent history is referenced by a campaign.' });
  });

  it('reset returns to idle', async () => {
    const { result } = renderHook(() => useMutationState());
    await act(async () => { await result.current.run(() => Promise.reject(new Error('boom'))); });
    expect(result.current.state.status).toBe('error');
    act(() => result.current.reset());
    expect(result.current.state.status).toBe('idle');
  });

  it('a slow failure cannot overwrite a later success', async () => {
    const { result } = renderHook(() => useMutationState());
    let rejectSlow!: (error: unknown) => void;
    const slow = new Promise<never>((_, reject) => { rejectSlow = reject; });

    let slowRun: Promise<unknown>;
    act(() => { slowRun = result.current.run(() => slow); });
    await act(async () => { await result.current.run(() => Promise.resolve('ok')); });
    expect(result.current.state.status).toBe('saved');

    await act(async () => { rejectSlow(new Error('late')); await slowRun; });
    expect(result.current.state.status).toBe('saved');
  });
});

describe('describeMutationFailure', () => {
  it('falls back to a form-level error when a VALIDATION_ERROR has no field path', () => {
    const failure = describeMutationFailure(validationError({}, ['Quiet hours start and end must differ']));
    expect(failure.message).toBe('Quiet hours start and end must differ');
    expect(failure.fieldErrors).toEqual({});
  });

  it('names nested fields by their leaf, in plain words', () => {
    const failure = describeMutationFailure(validationError({ 'bookingRules.hoursStart': ['Expected HH:MM'] }));
    expect(failure.message).toBe('hours start: Expected HH:MM');
  });
});
