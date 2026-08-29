import { describe, expect, it } from 'vitest';
import {
  clinicDayRangeUtc,
  clinicTimeToUtc,
  resolveTimezone,
  shiftClinicDate,
  todayInZone,
} from './clinicTime';

// The reported defect, concretely: a Chicago clinic's late-afternoon
// appointments belong to the next UTC day, so they fell outside a UTC
// midnight-to-midnight query and disappeared from today's board. And a
// reschedule typed in one timezone was written as if it had been typed in
// another. Both are silent — the screen looks right and is wrong, which is worse
// than a visible failure because nobody goes looking.

describe('clinicTimeToUtc', () => {
  it('reads a wall-clock time as the clinic means it, not as UTC', () => {
    // 2026-07-15 is summer: Chicago is CDT, UTC-5.
    expect(clinicTimeToUtc('2026-07-15', '14:30', 'America/Chicago').toISOString())
      .toBe('2026-07-15T19:30:00.000Z');
    // The same wall time in a different clinic is a different instant. This is
    // the reschedule bug: the browser's zone used to decide this.
    expect(clinicTimeToUtc('2026-07-15', '14:30', 'America/New_York').toISOString())
      .toBe('2026-07-15T18:30:00.000Z');
    expect(clinicTimeToUtc('2026-07-15', '14:30', 'UTC').toISOString())
      .toBe('2026-07-15T14:30:00.000Z');
  });

  it('uses the offset in force on the day, not a fixed one', () => {
    // January: Chicago is CST, UTC-6 — one hour further from UTC than in July.
    expect(clinicTimeToUtc('2026-01-15', '14:30', 'America/Chicago').toISOString())
      .toBe('2026-01-15T20:30:00.000Z');
  });

  it('resolves correctly on both sides of a DST transition', () => {
    // US DST starts 2026-03-08 at 02:00 local. 01:30 is CST, 03:30 is CDT.
    expect(clinicTimeToUtc('2026-03-08', '01:30', 'America/Chicago').toISOString())
      .toBe('2026-03-08T07:30:00.000Z');
    expect(clinicTimeToUtc('2026-03-08', '03:30', 'America/Chicago').toISOString())
      .toBe('2026-03-08T08:30:00.000Z');
  });

  it('accepts seconds as well as HH:MM', () => {
    expect(clinicTimeToUtc('2026-07-15', '00:00:00', 'America/Chicago').toISOString())
      .toBe('2026-07-15T05:00:00.000Z');
  });
});

describe('clinicDayRangeUtc', () => {
  it('covers the clinic day, so a late-afternoon appointment stays on today', () => {
    const { from, to } = clinicDayRangeUtc('2026-07-15', 'America/Chicago');
    expect(from.toISOString()).toBe('2026-07-15T05:00:00.000Z');
    expect(to.toISOString()).toBe('2026-07-16T05:00:00.000Z');

    // 19:00 CDT is 00:00Z the NEXT day. Under the old UTC-midnight window this
    // appointment vanished from the board; it must sit inside the range.
    const lateAfternoon = clinicTimeToUtc('2026-07-15', '19:00', 'America/Chicago');
    expect(lateAfternoon.toISOString()).toBe('2026-07-16T00:00:00.000Z');
    expect(lateAfternoon.getTime()).toBeGreaterThanOrEqual(from.getTime());
    expect(lateAfternoon.getTime()).toBeLessThan(to.getTime());
  });

  it('is 23 hours long on the day the clocks go forward', () => {
    const { from, to } = clinicDayRangeUtc('2026-03-08', 'America/Chicago');
    expect(to.getTime() - from.getTime()).toBe(23 * 3_600_000);
  });

  it('is 25 hours long on the day the clocks go back', () => {
    // US DST ends 2026-11-01.
    const { from, to } = clinicDayRangeUtc('2026-11-01', 'America/Chicago');
    expect(to.getTime() - from.getTime()).toBe(25 * 3_600_000);
  });

  it('excludes the next day rather than guessing at 23:59:59.999', () => {
    const { to } = clinicDayRangeUtc('2026-07-15', 'America/Chicago');
    const nextMidnight = clinicTimeToUtc('2026-07-16', '00:00:00', 'America/Chicago');
    expect(to.getTime()).toBe(nextMidnight.getTime());
  });
});

describe('todayInZone', () => {
  it('reports the clinic date, not the UTC date', () => {
    // 00:30Z on the 16th is still 19:30 on the 15th in Chicago. Computing this
    // with toISOString() is what made the board open on tomorrow every evening.
    const evening = new Date('2026-07-16T00:30:00.000Z');
    expect(todayInZone('America/Chicago', evening)).toBe('2026-07-15');
    expect(todayInZone('UTC', evening)).toBe('2026-07-16');
  });

  it('reports the next day for a clinic already past midnight', () => {
    const lateUtc = new Date('2026-07-15T23:30:00.000Z');
    expect(todayInZone('Asia/Tokyo', lateUtc)).toBe('2026-07-16');
    expect(todayInZone('UTC', lateUtc)).toBe('2026-07-15');
  });
});

describe('shiftClinicDate', () => {
  it('moves whole days', () => {
    expect(shiftClinicDate('2026-07-15', 1, 'America/Chicago')).toBe('2026-07-16');
    expect(shiftClinicDate('2026-07-15', 2, 'America/Chicago')).toBe('2026-07-17');
  });

  it('still moves exactly one day across a DST transition', () => {
    // Stepping from midnight would land short or long here; stepping from midday
    // is why this holds.
    expect(shiftClinicDate('2026-03-07', 1, 'America/Chicago')).toBe('2026-03-08');
    expect(shiftClinicDate('2026-03-08', 1, 'America/Chicago')).toBe('2026-03-09');
    expect(shiftClinicDate('2026-10-31', 1, 'America/Chicago')).toBe('2026-11-01');
    expect(shiftClinicDate('2026-11-01', 1, 'America/Chicago')).toBe('2026-11-02');
  });

  it('crosses month and year boundaries', () => {
    expect(shiftClinicDate('2026-12-31', 1, 'America/Chicago')).toBe('2027-01-01');
  });
});

describe('resolveTimezone', () => {
  it('keeps a usable IANA zone', () => {
    expect(resolveTimezone('America/Chicago')).toBe('America/Chicago');
  });

  it('falls back rather than throwing on a missing or unusable value', () => {
    // A branch with no timezone, or a stored value the runtime cannot use, must
    // not take the scheduling board down.
    for (const bad of [null, undefined, '', '   ', 'Not/AZone']) {
      expect(() => resolveTimezone(bad)).not.toThrow();
      expect(resolveTimezone(bad).length).toBeGreaterThan(0);
    }
  });
});
