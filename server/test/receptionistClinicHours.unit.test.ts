import { describe, expect, it } from 'vitest';
import {
  buildHoursDynamicVariables,
  hoursHash,
  hoursStatus,
  hoursSummarySpoken,
  isOpenAt,
  nextOpening,
  resolveEffectiveHours,
  todayHoursSpoken,
  upcomingClosuresSpoken,
  type ClosureRule,
  type HoursSource,
  type WeeklyHours,
} from '../lib/receptionist/clinicHours';
import type { LocaleFormat } from '../lib/receptionist/localePacks/types';

const US: LocaleFormat = { language: 'en-US', timeStyle: '12h', dateStyle: 'weekday-month-day' };
const GB: LocaleFormat = { language: 'en-GB', timeStyle: '24h', dateStyle: 'weekday-day-month' };

const WEEKDAYS_9_5: WeeklyHours = {
  monday: { open: true, start: '09:00', end: '17:00' },
  tuesday: { open: true, start: '09:00', end: '17:00' },
  wednesday: { open: true, start: '09:00', end: '17:00' },
  thursday: { open: true, start: '09:00', end: '17:00' },
  friday: { open: true, start: '09:00', end: '17:00' },
  saturday: { open: false },
  sunday: { open: false },
};

function source(overrides: Partial<HoursSource> = {}): HoursSource {
  return { timezone: 'America/New_York', clinicHours: WEEKDAYS_9_5, closures: [], ...overrides };
}

function closure(partial: Partial<ClosureRule> = {}): ClosureRule {
  return { id: 'closure-1', locationId: null, startsOn: '2026-09-03', endsOn: '2026-09-03', reason: 'Staff training', ...partial };
}

describe('clinic hours engine', () => {
  it('prefers a location override for the day it defines and keeps clinic hours elsewhere', () => {
    const withOverride = source({
      locationHours: { monday: { open: true, start: '08:00', end: '12:00' } },
      locationId: 'location-1',
    });
    const monday = resolveEffectiveHours(withOverride, '2026-08-31');
    expect(monday.windows).toEqual([{ start: '08:00', end: '12:00' }]);
    expect(monday.source).toBe('location');
    // Tuesday has no override, so it still reads the clinic schedule.
    const tuesday = resolveEffectiveHours(withOverride, '2026-09-01');
    expect(tuesday.windows).toEqual([{ start: '09:00', end: '17:00' }]);
    expect(tuesday.source).toBe('clinic');
  });

  it('closes the whole day for an all-day closure and reports its reason', () => {
    const day = resolveEffectiveHours(source({ closures: [closure()] }), '2026-09-03');
    expect(day.open).toBe(false);
    expect(day.windows).toEqual([]);
    expect(day.closure).toMatchObject({ reason: 'Staff training', allDay: true });
  });

  it('splits a window into two when a partial-day closure falls inside it', () => {
    const day = resolveEffectiveHours(source({ closures: [closure({ startTime: '12:00', endTime: '13:00' })] }), '2026-09-03');
    expect(day.windows).toEqual([{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }]);
    expect(day.open).toBe(true);
    expect(day.closure).toMatchObject({ allDay: false });
  });

  it('ignores a closure scoped to another location', () => {
    const day = resolveEffectiveHours(
      source({ locationId: 'location-1', closures: [closure({ locationId: 'location-2' })] }),
      '2026-09-03',
    );
    expect(day.open).toBe(true);
    expect(day.closure).toBeNull();
  });

  it('treats the window start as inclusive and the end as exclusive', () => {
    const clinic = source();
    // 2026-09-01 is a Tuesday. 09:00 and 16:59 local are open; 17:00 is not.
    expect(isOpenAt(clinic, new Date('2026-09-01T13:00:00Z')).open).toBe(true);   // 09:00 EDT
    expect(isOpenAt(clinic, new Date('2026-09-01T20:59:00Z')).open).toBe(true);   // 16:59 EDT
    expect(isOpenAt(clinic, new Date('2026-09-01T21:00:00Z')).open).toBe(false);  // 17:00 EDT
    expect(isOpenAt(clinic, new Date('2026-09-01T12:59:00Z')).open).toBe(false);  // 08:59 EDT
  });

  it('resolves open/closed correctly across both DST transitions', () => {
    const clinic = source();
    // Spring forward: 2026-03-08. 09:00 EST->EDT day; 14:00Z is 09:00 EST-4.
    expect(isOpenAt(clinic, new Date('2026-03-09T13:00:00Z')).open).toBe(true);   // Mon 09:00 EDT
    expect(isOpenAt(clinic, new Date('2026-03-09T12:00:00Z')).open).toBe(false);  // Mon 08:00 EDT
    // Fall back: 2026-11-01. The Monday after is EST (UTC-5).
    expect(isOpenAt(clinic, new Date('2026-11-02T14:00:00Z')).open).toBe(true);   // Mon 09:00 EST
    expect(isOpenAt(clinic, new Date('2026-11-02T13:00:00Z')).open).toBe(false);  // Mon 08:00 EST
  });

  it('walks past a weekend and a closure to the next real opening', () => {
    // Friday 2026-09-04 18:00 EDT -> Monday is closed, so Tuesday 09:00.
    const next = nextOpening(source({ closures: [closure({ startsOn: '2026-09-07', endsOn: '2026-09-07', reason: 'Labor Day' })] }), new Date('2026-09-04T22:00:00Z'));
    expect(next).toMatchObject({ date: '2026-09-08', start: '09:00' });
    expect(new Date(next!.startsAt).toISOString()).toBe('2026-09-08T13:00:00.000Z');
  });

  it('returns null when the horizon holds no opening at all', () => {
    expect(nextOpening(source({ clinicHours: { monday: { open: false } } }), new Date('2026-09-01T12:00:00Z'))).toBeNull();
    expect(nextOpening(source({ closures: [closure({ startsOn: '2026-09-01', endsOn: '2026-09-30', reason: 'Refurbishment' })] }), new Date('2026-09-01T12:00:00Z'), 14)).toBeNull();
  });

  it('speaks times in the pack style', () => {
    const day = resolveEffectiveHours(source(), '2026-09-01');
    expect(todayHoursSpoken(day, US)).toBe('9 AM to 5 PM');
    expect(todayHoursSpoken(day, GB)).toBe('09:00 to 17:00');
    const closed = resolveEffectiveHours(source({ closures: [closure()] }), '2026-09-03');
    expect(todayHoursSpoken(closed, US)).toBe('closed today: Staff training');
    expect(todayHoursSpoken(resolveEffectiveHours(source({ clinicHours: null }), '2026-09-01'), US)).toBe('hours not configured');
  });

  it('groups equal consecutive days into one spoken summary', () => {
    const weekly: WeeklyHours = { ...WEEKDAYS_9_5, saturday: { open: true, start: '09:00', end: '13:00' } };
    expect(hoursSummarySpoken({ clinicHours: weekly }, US))
      .toBe('Monday to Friday 9 AM to 5 PM, Saturday 9 AM to 1 PM, closed Sunday');
    expect(hoursSummarySpoken({ clinicHours: null }, US)).toBe('not configured');
  });

  it('lists upcoming closures in the pack date order', () => {
    const withClosure = source({ closures: [closure({ startsOn: '2026-09-03', endsOn: '2026-09-04' })] });
    expect(upcomingClosuresSpoken(withClosure, new Date('2026-09-01T12:00:00Z'), 60, US))
      .toEqual(['Closed Thursday, September 3 to Friday, September 4: Staff training']);
    expect(upcomingClosuresSpoken(withClosure, new Date('2026-09-01T12:00:00Z'), 60, GB))
      .toEqual(['Closed Thursday 3 September to Friday 4 September: Staff training']);
  });

  it('hashes the same configuration identically regardless of key order', () => {
    const a = hoursHash(source());
    const reordered: WeeklyHours = {
      friday: { open: true, start: '09:00', end: '17:00' },
      monday: { open: true, start: '09:00', end: '17:00' },
      tuesday: { open: true, start: '09:00', end: '17:00' },
      sunday: { open: false },
      wednesday: { open: true, start: '09:00', end: '17:00' },
      saturday: { open: false },
      thursday: { open: true, start: '09:00', end: '17:00' },
    };
    expect(hoursHash(source({ clinicHours: reordered }))).toBe(a);
    expect(hoursHash(source({ closures: [closure()] }))).not.toBe(a);
  });

  it('reports unknown rather than false when hours are not configured', () => {
    const configured = hoursStatus(source(), new Date('2026-09-01T13:00:00Z'), US);
    expect(buildHoursDynamicVariables({ status: configured, strings: { emergencyNumber: '911' } })).toEqual({
      is_open_now: 'true',
      hours_today: '9 AM to 5 PM',
      next_opening: '',
      closure_reason: '',
      emergency_number: '911',
    });
    const unconfigured = hoursStatus(source({ clinicHours: null }), new Date('2026-09-01T13:00:00Z'), US);
    const vars = buildHoursDynamicVariables({ status: unconfigured, strings: null });
    expect(vars.is_open_now).toBe('unknown');
    expect(vars.emergency_number).toBe('');
  });

  it('carries the closure reason into the status for the agent to speak', () => {
    const status = hoursStatus(source({ closures: [closure()] }), new Date('2026-09-03T14:00:00Z'), US);
    expect(status.isOpenNow).toBe(false);
    expect(status.closureReason).toBe('Staff training');
    expect(status.nextOpeningSpoken).toBe('Friday, September 4 at 9 AM');
  });
});
