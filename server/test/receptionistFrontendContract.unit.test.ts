import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from '../../src/lib/api';
import { clearSession, setAccessTokenOnly } from '../../src/lib/session';
import {
  OUTBOUND_RECONCILIATION_WARNING, launchResultFromError, mergeReconciliationRefresh,
  launchControlsBlocked, parseLaunchResult, presentLaunchResult, receptionistApi, validateOutboundQuietHours,
  clearTransportAmbiguityToken, readTransportAmbiguityToken, transportAmbiguityStorageKey,
  TRANSPORT_AMBIGUITY_STORAGE_UNAVAILABLE, writeTransportAmbiguityToken,
  type OutboundReconciliationEvidence,
} from '../../src/lib/receptionist';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearSession(false);
  vi.unstubAllGlobals();
});

describe('front-desk launch response contract', () => {
  it('preserves structured 409/423 launch decisions on ApiError and exposes them to the launch presenter', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    setAccessTokenOnly('unit-token');
    const decision = {
      status: 'blocked', reason: 'outbound_stopped', callLogId: 'call-log-1',
      reviewRecorded: false, signalRecorded: true,
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(decision), {
      status: 423, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    let caught: unknown;
    try { await apiRequest('/v1/receptionist/outbound-campaigns/campaign/call'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).details).toEqual(decision);
    const result = launchResultFromError(caught);
    expect(result).toMatchObject(decision);
    expect(presentLaunchResult(result!)).toMatchObject({ kind: 'err', refresh: true });
  });

  it('fails closed for malformed known statuses and unknown statuses without throwing in presentation', () => {
    const malformed = parseLaunchResult({ status: 'setup_required' });
    const unknown = parseLaunchResult({ status: 'provider_magic_success', callId: 'untrusted' });
    expect(malformed).toEqual({ status: 'unknown_response', receivedStatus: 'setup_required' });
    expect(unknown).toEqual({ status: 'unknown_response', receivedStatus: 'provider_magic_success' });
    expect(presentLaunchResult(malformed)).toMatchObject({ kind: 'err', refresh: true });
    expect(presentLaunchResult(unknown).text).toMatch(/do not retry/i);
  });

  it.each(['campaign_authority_changed', 'quiet_hours', 'provider_intent_evidence_failed'] as const)(
    'recognizes the server safety decision %s as a blocked launch',
    reason => {
      const result = parseLaunchResult({ status: 'blocked', reason });
      expect(result).toEqual({ status: 'blocked', reason });
      expect(presentLaunchResult(result)).toMatchObject({ kind: 'err', refresh: true });
    },
  );

  it('turns a rejected fetch after launch submission into a red do-not-retry reconciliation state', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    setAccessTokenOnly('unit-token');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'registered' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockRejectedValueOnce(new TypeError('network response lost'));
    globalThis.fetch = fetchMock;
    const result = await receptionistApi.launchCall('campaign-1', { phone: '+12125550199' });
    expect(result).toMatchObject({ status: 'transport_ambiguous', clientAttemptToken: expect.any(String) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/launch-attempts');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain((result as { clientAttemptToken: string }).clientAttemptToken);
    expect(presentLaunchResult(result)).toMatchObject({ kind: 'err', refresh: true });
    expect(presentLaunchResult(result).text).toContain(OUTBOUND_RECONCILIATION_WARNING);
    expect(launchControlsBlocked({ transportAmbiguous: true, reconciliationVerified: true, reconciliations: [] })).toBe(true);
  });

  it('renders every launch state truthfully, including amber accepted-but-degraded and red reconciliation', () => {
    const cases = [
      { status: 'launched', callId: 'c1', callLogId: 'l1', mock: false, trackingDegraded: false },
      { status: 'launched', callId: 'c2', callLogId: 'l2', mock: false, trackingDegraded: true },
      { status: 'setup_required', missing: ['RETELL_API_KEY'] },
      { status: 'skipped', reason: 'quiet_hours' },
      { status: 'blocked', reason: 'outbound_stopped' },
      { status: 'cancelled', reason: 'outbound_stopped', providerStopApplied: true },
      { status: 'reconciliation_required', callLogId: 'l3', callId: 'c3', providerStopApplied: false, reviewRecorded: false },
      { status: 'failed', callLogId: 'l4', error: 'retell_error_422', reviewRecorded: false },
    ].map(parseLaunchResult);
    for (const result of cases) expect(presentLaunchResult(result).text.length).toBeGreaterThan(20);
    expect(presentLaunchResult(cases[1]).kind).toBe('warn');
    expect(presentLaunchResult(cases[6])).toMatchObject({ kind: 'err', refresh: true });
    expect(presentLaunchResult(cases[6]).text).toMatch(/do not retry/i);
  });
});

describe('persistent outbound reconciliation refresh state', () => {
  const durableRow: OutboundReconciliationEvidence = {
    localCallLogId: '7a1cc11d-bda4-44f4-8095-aad115b7df8b',
    providerCallId: 'retell_live_possible_1',
    targetId: 'e1231aa0-f4c1-4c08-8474-f8be8b321c22',
    triggerSources: ['RECONCILIATION_REQUIRED', 'RECONCILIATION_SIGNAL', 'RECONCILIATION_TASK'],
    signalIds: ['signal-1'], signalStatuses: ['open'],
    reviewTaskIds: ['task-1'], reviewTaskStatuses: ['OPEN'],
    createdAt: '2026-07-31T04:00:00.000Z',
  };

  it('reconstructs the critical warning after refresh and preserves it when refresh evidence fails', () => {
    const afterNavigation = mergeReconciliationRefresh([], { ok: true, rows: [durableRow] });
    expect(afterNavigation).toEqual([durableRow]);
    expect(OUTBOUND_RECONCILIATION_WARNING).toBe('possible live provider call—do not retry');
    expect(afterNavigation[0]).toMatchObject({
      localCallLogId: durableRow.localCallLogId, providerCallId: durableRow.providerCallId,
    });
    expect(mergeReconciliationRefresh(afterNavigation, { ok: false })).toEqual([durableRow]);
  });

  it('removes the persistent warning only after a successful refresh returns durable resolution', () => {
    expect(mergeReconciliationRefresh([durableRow], { ok: true, rows: [] })).toEqual([]);
  });

  it('keeps controls fail-closed across a failed durable refresh and opens only after explicit ambiguity clearance', () => {
    const afterFailedRefresh = mergeReconciliationRefresh([durableRow], { ok: false });
    expect(launchControlsBlocked({
      transportAmbiguous: true,
      reconciliationVerified: false,
      reconciliations: afterFailedRefresh,
    })).toBe(true);
    expect(launchControlsBlocked({
      transportAmbiguous: false,
      reconciliationVerified: true,
      reconciliations: [],
    })).toBe(false);
  });

  it('persists the attempt token across a remount and fails closed when storage is unavailable', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const key = transportAmbiguityStorageKey('campaign-1');
    expect(writeTransportAmbiguityToken(storage, key, 'attempt-token')).toBe(true);
    expect(readTransportAmbiguityToken(storage, key)).toBe('attempt-token');
    expect(clearTransportAmbiguityToken(storage, key)).toBe(true);
    expect(readTransportAmbiguityToken(storage, key)).toBeNull();

    const unavailable = { getItem: () => { throw new Error('blocked'); } };
    expect(readTransportAmbiguityToken(unavailable, key)).toBe(TRANSPORT_AMBIGUITY_STORAGE_UNAVAILABLE);
    expect(launchControlsBlocked({
      transportAmbiguous: true, reconciliationVerified: true, reconciliations: [],
    })).toBe(true);
  });
});

describe('outbound quiet-hours form contract', () => {
  it.each([
    [null, null, 'America/New_York', 'required'],
    ['21:00', null, 'America/New_York', 'both'],
    ['9:00', '17:00', 'America/New_York', 'HH:mm'],
    ['21:00', '21:00', 'America/New_York', 'cannot be equal'],
    ['21:00', '08:00', 'Not/A_Timezone', 'timezone'],
  ])('rejects unsafe quiet-hours configuration', (start, end, timezone, expected) => {
    expect(validateOutboundQuietHours(start, end, timezone)).toContain(expected);
  });

  it('accepts a strict overnight window in a valid IANA timezone', () => {
    expect(validateOutboundQuietHours('21:00', '08:00', 'America/New_York')).toBeNull();
  });
});
