import { describe, it, expect } from 'vitest';
import {
  zonedParts, zonedTimeToInstant, zonedDateKey, zonedMonthBounds,
  resolveRequestedMonth, isSupportedTimeZone,
} from './rpmPeriod';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';
const UTC = 'UTC';

describe('local wall-clock reading', () => {
  it('reads an instant in the target zone, not the host zone', () => {
    // 2026-03-15T02:30:00Z is still the 14th, late evening, in Los Angeles.
    const parts = zonedParts(new Date('2026-03-15T02:30:00.000Z'), LA);
    expect(parts).toMatchObject({ year: 2026, month: 3, day: 14, hour: 19, minute: 30 });
  });

  it('renders midnight as hour 0, never 24', () => {
    expect(zonedParts(new Date('2026-03-15T07:00:00.000Z'), LA).hour).toBe(0);
    expect(zonedParts(new Date('2026-06-01T00:00:00.000Z'), UTC).hour).toBe(0);
  });
});

describe('local wall-clock to instant', () => {
  it('round-trips through both directions', () => {
    for (const zone of [UTC, LA, TOKYO, 'Europe/London', 'Asia/Kolkata']) {
      const instant = zonedTimeToInstant(2026, 8, 29, 14, 5, 30, zone);
      expect(zonedParts(instant, zone)).toMatchObject({ year: 2026, month: 8, day: 29, hour: 14, minute: 5, second: 30 });
    }
  });

  it('handles a half-hour offset zone', () => {
    // Kolkata is UTC+5:30 year-round.
    const instant = zonedTimeToInstant(2026, 1, 1, 0, 0, 0, 'Asia/Kolkata');
    expect(instant.toISOString()).toBe('2025-12-31T18:30:00.000Z');
  });

  it('resolves local midnight correctly across a DST boundary', () => {
    // US DST begins 2026-03-08. Midnight on the 1st is PST (UTC-8); midnight on
    // the 31st is PDT (UTC-7). A single fixed offset would get one of them wrong.
    expect(zonedTimeToInstant(2026, 3, 1, 0, 0, 0, LA).toISOString()).toBe('2026-03-01T08:00:00.000Z');
    expect(zonedTimeToInstant(2026, 3, 31, 0, 0, 0, LA).toISOString()).toBe('2026-03-31T07:00:00.000Z');
  });
});

describe('month bounds are local, not UTC', () => {
  it('starts and ends a Los Angeles month at local midnight', () => {
    const bounds = zonedMonthBounds(new Date('2026-08-15T12:00:00.000Z'), LA);
    // August is PDT (UTC-7), so local midnight is 07:00Z.
    expect(bounds.start.toISOString()).toBe('2026-08-01T07:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-09-01T07:00:00.000Z');
  });

  it('rolls December into the next year', () => {
    const bounds = zonedMonthBounds(new Date('2026-12-20T00:00:00.000Z'), UTC);
    expect(bounds.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  // THE DEFECT. Under UTC bounds, the last local evening of the month resolved
  // to the FOLLOWING month, so a clinician reviewing a patient at 16:30 local on
  // the 31st was told the session fell outside the current period and could not
  // record it at all.
  it('keeps the last local evening of the month inside that month', () => {
    const lastEveningLocal = new Date('2026-09-01T00:30:00.000Z'); // 17:30 Aug 31 in LA
    expect(zonedParts(lastEveningLocal, LA)).toMatchObject({ month: 8, day: 31, hour: 17 });

    const bounds = zonedMonthBounds(lastEveningLocal, LA);
    expect(zonedParts(bounds.start, LA).month).toBe(8);
    expect(lastEveningLocal >= bounds.start && lastEveningLocal < bounds.end).toBe(true);

    // The old behaviour, shown for contrast: UTC already called it September.
    expect(lastEveningLocal.getUTCMonth() + 1).toBe(9);
  });

  // The mirror case: a clinic ahead of UTC had the first local hours of a month
  // counted against the PREVIOUS one.
  it('keeps the first local hours of the month inside that month', () => {
    const firstMorningLocal = new Date('2026-08-31T22:00:00.000Z'); // 07:00 Sep 1 in Tokyo
    expect(zonedParts(firstMorningLocal, TOKYO)).toMatchObject({ month: 9, day: 1 });

    const bounds = zonedMonthBounds(firstMorningLocal, TOKYO);
    expect(zonedParts(bounds.start, TOKYO).month).toBe(9);
    expect(firstMorningLocal >= bounds.start).toBe(true);
  });
});

describe('device-day bucketing is local', () => {
  // THE INFLATION DEFECT. Two readings on ONE local day straddling UTC midnight
  // used to produce two distinct UTC dates, so eight local days of transmission
  // could satisfy a sixteen-device-day threshold.
  it('counts two readings on one local day as one day', () => {
    const morning = new Date('2026-08-14T15:00:00.000Z'); // 08:00 Aug 14 in LA
    const evening = new Date('2026-08-15T01:00:00.000Z'); // 18:00 Aug 14 in LA

    expect(zonedDateKey(morning, LA)).toBe('2026-08-14');
    expect(zonedDateKey(evening, LA)).toBe('2026-08-14');
    expect(new Set([zonedDateKey(morning, LA), zonedDateKey(evening, LA)]).size).toBe(1);

    // The old UTC bucketing produced two, from one local day of transmission.
    expect(new Set([morning.toISOString().slice(0, 10), evening.toISOString().slice(0, 10)]).size).toBe(2);
  });

  it('still counts genuinely separate local days separately', () => {
    const day1 = new Date('2026-08-14T15:00:00.000Z');
    const day2 = new Date('2026-08-15T15:00:00.000Z');
    expect(new Set([zonedDateKey(day1, LA), zonedDateKey(day2, LA)]).size).toBe(2);
  });
});

describe('addressing a closed period', () => {
  const now = new Date('2026-08-29T12:00:00.000Z');

  it('defaults to the month containing now', () => {
    expect(zonedParts(resolveRequestedMonth(undefined, now, UTC).start, UTC).month).toBe(8);
  });

  it('addresses a month that has already ended, which is when billing happens', () => {
    const july = resolveRequestedMonth(new Date('2026-07-10T00:00:00.000Z'), now, UTC);
    expect(july.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(july.end.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('normalises any instant inside a month to that month, so a half-month cannot be addressed', () => {
    const fromMiddle = resolveRequestedMonth(new Date('2026-07-17T09:41:23.000Z'), now, UTC);
    const fromStart = resolveRequestedMonth(new Date('2026-07-01T00:00:00.000Z'), now, UTC);
    expect(fromMiddle.start.toISOString()).toBe(fromStart.start.toISOString());
    expect(fromMiddle.end.toISOString()).toBe(fromStart.end.toISOString());
  });
});

describe('timezone validation', () => {
  it('accepts real zones and rejects nonsense', () => {
    expect(isSupportedTimeZone(LA)).toBe(true);
    expect(isSupportedTimeZone('Europe/London')).toBe(true);
    expect(isSupportedTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isSupportedTimeZone('')).toBe(false);
  });
});
