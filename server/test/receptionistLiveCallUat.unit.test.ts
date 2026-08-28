import 'dotenv/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../config/env';
import {
  authorizeLiveCallDestination,
  evaluateLiveCallAdmission,
  isWithinLiveCallWindow,
  liveCallUatDisclosure,
  LIVE_CALL_UAT_DISCLOSURE,
  liveCallUatScope,
  liveCallUatStatus,
  maskPhone,
  maskProviderId,
} from '../lib/receptionist/liveCallUat';

const AUTHORIZED_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';

const original = {
  callsAuthorized: env.LIVE_TEST_CALLS_AUTHORIZED,
  executionId: env.LIVE_TEST_EXECUTION_ID,
  tenantId: env.LIVE_TEST_TENANT_ID,
  authorizedPhone: env.AUTHORIZED_TEST_PHONE_E164,
  allowlist: env.LIVE_TEST_RECIPIENT_ALLOWLIST,
  expiresAt: env.LIVE_TEST_EXPIRES_AT,
  timezone: env.LIVE_TEST_TIMEZONE,
  start: env.LIVE_TEST_WINDOW_START,
  end: env.LIVE_TEST_WINDOW_END,
  maxCalls: env.LIVE_TEST_MAX_CALLS,
  maxCallMinutes: env.LIVE_TEST_MAX_CALL_MINUTES,
  maxTotalMinutes: env.LIVE_TEST_MAX_TOTAL_MINUTES,
  maxCost: env.LIVE_TEST_MAX_PROVIDER_COST_USD,
  estimate: env.LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD,
};

function configureActiveUat() {
  env.LIVE_TEST_CALLS_AUTHORIZED = true;
  env.LIVE_TEST_EXECUTION_ID = 'voice-uat-run-001';
  env.LIVE_TEST_TENANT_ID = AUTHORIZED_TENANT_ID;
  env.AUTHORIZED_TEST_PHONE_E164 = '+12025550123';
  env.LIVE_TEST_RECIPIENT_ALLOWLIST = '';
  env.LIVE_TEST_EXPIRES_AT = '2026-08-11T22:00:00.000Z';
  env.LIVE_TEST_TIMEZONE = 'UTC';
  env.LIVE_TEST_WINDOW_START = '00:00';
  env.LIVE_TEST_WINDOW_END = '23:59';
  env.LIVE_TEST_MAX_CALLS = 2;
  env.LIVE_TEST_MAX_CALL_MINUTES = 5;
  env.LIVE_TEST_MAX_TOTAL_MINUTES = 10;
  env.LIVE_TEST_MAX_PROVIDER_COST_USD = 3;
  env.LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD = 0.2;
}

beforeEach(configureActiveUat);

afterEach(() => {
  env.LIVE_TEST_CALLS_AUTHORIZED = original.callsAuthorized;
  env.LIVE_TEST_EXECUTION_ID = original.executionId;
  env.LIVE_TEST_TENANT_ID = original.tenantId;
  env.AUTHORIZED_TEST_PHONE_E164 = original.authorizedPhone;
  env.LIVE_TEST_RECIPIENT_ALLOWLIST = original.allowlist;
  env.LIVE_TEST_EXPIRES_AT = original.expiresAt;
  env.LIVE_TEST_TIMEZONE = original.timezone;
  env.LIVE_TEST_WINDOW_START = original.start;
  env.LIVE_TEST_WINDOW_END = original.end;
  env.LIVE_TEST_MAX_CALLS = original.maxCalls;
  env.LIVE_TEST_MAX_CALL_MINUTES = original.maxCallMinutes;
  env.LIVE_TEST_MAX_TOTAL_MINUTES = original.maxTotalMinutes;
  env.LIVE_TEST_MAX_PROVIDER_COST_USD = original.maxCost;
  env.LIVE_TEST_ESTIMATED_COST_PER_MINUTE_USD = original.estimate;
});

describe('attended live-call UAT admission', () => {
  const now = new Date('2026-08-11T12:00:00.000Z');

  it('authorizes exactly one normalized destination and masks all exposed identifiers', () => {
    const status = liveCallUatStatus(now, AUTHORIZED_TENANT_ID);
    expect(status).toMatchObject({
      active: true,
      allowedDestinationMasked: '***-***-0123',
      maxCalls: 2,
      maxTotalMinutes: 10,
      projectedMaximumCostUsd: 2,
      blockingReason: null,
    });
    expect(authorizeLiveCallDestination('(202) 555-0123', now, AUTHORIZED_TENANT_ID)).toMatchObject({ allowed: true, destination: '+12025550123' });
    expect(authorizeLiveCallDestination('+12125550100', now, AUTHORIZED_TENANT_ID)).toMatchObject({ allowed: false, reason: 'live_test_destination_not_allowlisted' });
    expect(authorizeLiveCallDestination('+12025550123', now, OTHER_TENANT_ID)).toMatchObject({ allowed: false, reason: 'live_test_tenant_not_authorized' });
    expect(maskPhone('+12025550123')).toBe('***-***-0123');
    expect(maskProviderId('call_1234567890')).toBe('call…7890');
    expect(liveCallUatScope()).toBe('receptionist.live-uat:voice-uat-run-001');
  });

  it('prepends the mandatory synthetic UAT disclosure without dropping the clinic disclosure', () => {
    expect(liveCallUatDisclosure('This call may be recorded after consent.')).toBe(
      `${LIVE_CALL_UAT_DISCLOSURE} This call may be recorded after consent.`,
    );
    expect(liveCallUatDisclosure(null)).toBe(LIVE_CALL_UAT_DISCLOSURE);
  });

  it('fails closed outside the time window and after authorization expiry', () => {
    env.LIVE_TEST_WINDOW_START = '13:00';
    env.LIVE_TEST_WINDOW_END = '14:00';
    expect(liveCallUatStatus(now, AUTHORIZED_TENANT_ID)).toMatchObject({ active: false, blockingReason: 'live_test_outside_window' });

    env.LIVE_TEST_WINDOW_START = '00:00';
    env.LIVE_TEST_WINDOW_END = '23:59';
    env.LIVE_TEST_EXPIRES_AT = '2026-08-11T11:59:59.000Z';
    expect(liveCallUatStatus(now, AUTHORIZED_TENANT_ID)).toMatchObject({ active: false, blockingReason: 'live_test_authorization_expired' });
  });

  it('enforces a single active call, call count, total minutes, and conservative cost reservation', () => {
    expect(evaluateLiveCallAdmission({ attemptsUsed: 0, connectedSeconds: 0, activeCalls: 0 }, now, AUTHORIZED_TENANT_ID)).toMatchObject({ allowed: true, projectedCostUsd: 1 });
    expect(evaluateLiveCallAdmission({ attemptsUsed: 0, connectedSeconds: 0, activeCalls: 1 }, now, AUTHORIZED_TENANT_ID)).toMatchObject({ allowed: false, reason: 'live_test_single_active_call' });
    expect(evaluateLiveCallAdmission({ attemptsUsed: 2, connectedSeconds: 0, activeCalls: 0 }, now, AUTHORIZED_TENANT_ID)).toMatchObject({ allowed: false, reason: 'live_test_call_cap_reached' });
    expect(evaluateLiveCallAdmission({ attemptsUsed: 1, connectedSeconds: 6 * 60, activeCalls: 0 }, now, AUTHORIZED_TENANT_ID)).toMatchObject({ allowed: false, reason: 'live_test_minute_cap_reached' });

    env.LIVE_TEST_MAX_PROVIDER_COST_USD = 1.5;
    expect(evaluateLiveCallAdmission({ attemptsUsed: 1, connectedSeconds: 0, activeCalls: 0 }, now, AUTHORIZED_TENANT_ID)).toMatchObject({ allowed: false, reason: 'live_test_cost_cap_reached' });
  });

  it('supports overnight windows without treating an all-day window as valid', () => {
    expect(isWithinLiveCallWindow(new Date('2026-08-11T23:00:00.000Z'), 'UTC', '21:00', '08:00')).toBe(true);
    expect(isWithinLiveCallWindow(new Date('2026-08-11T12:00:00.000Z'), 'UTC', '21:00', '08:00')).toBe(false);
    expect(isWithinLiveCallWindow(now, 'UTC', '09:00', '09:00')).toBe(false);
  });
});
