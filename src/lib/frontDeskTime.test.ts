import { describe, expect, it } from 'vitest';
import { formatCallDuration, formatClinicDateTime, formatClinicTime, formatMinutes, formatRelativeDue } from './frontDeskTime';

/**
 * The clinic's clock, not the viewer's. These pin the two claims the front
 * desk makes with a timestamp: WHERE it is being read (the clinic zone) and
 * WHETHER a callback is late.
 */
describe('formatClinicDateTime', () => {
  it('renders the instant in the clinic zone, not the viewer zone', () => {
    // 2026-08-29T02:30Z is still the 28th, 19:30, in Los Angeles.
    const losAngeles = formatClinicDateTime('2026-08-29T02:30:00.000Z', 'America/Los_Angeles', undefined, 'en-US');
    const london = formatClinicDateTime('2026-08-29T02:30:00.000Z', 'Europe/London', undefined, 'en-US');
    expect(losAngeles).toContain('Aug 28');
    expect(london).toContain('Aug 29');
    expect(losAngeles).not.toEqual(london);
  });

  it('returns an empty string for a missing or unparseable value rather than "Invalid Date"', () => {
    expect(formatClinicDateTime(null, 'UTC')).toBe('');
    expect(formatClinicDateTime(undefined, 'UTC')).toBe('');
    expect(formatClinicDateTime('not-a-date', 'UTC')).toBe('');
  });

  it('falls back to a real zone when the clinic zone is missing or unusable', () => {
    expect(formatClinicTime('2026-08-29T02:30:00.000Z', 'Not/AZone', 'en-US')).not.toBe('');
  });
});

describe('formatRelativeDue', () => {
  const now = new Date('2026-08-29T12:00:00.000Z');

  it('reports an overdue task as overdue, with how long it has been waiting', () => {
    expect(formatRelativeDue('2026-08-29T11:57:00.000Z', now)).toEqual({ label: 'Overdue · 3 min', overdue: true });
  });

  it('counts down to a future due time', () => {
    expect(formatRelativeDue('2026-08-29T12:12:00.000Z', now)).toEqual({ label: 'in 12 min', overdue: false });
  });

  it('says "No due date" instead of implying a task is overdue when it has none', () => {
    expect(formatRelativeDue(null, now)).toEqual({ label: 'No due date', overdue: false });
  });
});

describe('duration formatting', () => {
  it('formats minutes, hours and days', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(125)).toBe('2 h 05 min');
    expect(formatMinutes(1500)).toBe('1 d 1 h');
  });

  it('renders an unknown or zero call duration as a dash, never "0m 00s"', () => {
    expect(formatCallDuration(null)).toBe('—');
    expect(formatCallDuration(0)).toBe('—');
    expect(formatCallDuration(64)).toBe('1m 04s');
  });
});
