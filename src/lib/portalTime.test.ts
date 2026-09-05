import { describe, expect, it } from 'vitest';
import { clinicDateOffset, clinicLocalDateTimeToIso, formatClinicDateTime } from './portalTime';

describe('portal clinic timezone handling', () => {
  it('formats an instant in the authoritative clinic timezone', () => {
    const rendered = formatClinicDateTime('2026-07-15T13:00:00.000Z', 'America/New_York');
    expect(rendered).toContain('Jul 15, 2026');
    expect(rendered).toContain('9:00 AM');
    expect(rendered).toContain('EDT');
  });

  it('converts clinic-local input without using the browser timezone', () => {
    expect(clinicLocalDateTimeToIso('2026-07-15T09:00', 'America/New_York')).toEqual({
      iso: '2026-07-15T13:00:00.000Z', error: null,
    });
  });

  it('rejects nonexistent and ambiguous DST wall times instead of shifting or guessing', () => {
    expect(clinicLocalDateTimeToIso('2026-03-08T02:30', 'America/New_York')).toEqual({ iso: null, error: 'nonexistent' });
    expect(clinicLocalDateTimeToIso('2026-11-01T01:30', 'America/New_York')).toEqual({ iso: null, error: 'ambiguous' });
  });

  it('derives date defaults from the clinic day across a UTC boundary', () => {
    const now = new Date('2026-07-15T02:00:00.000Z');
    expect(clinicDateOffset(0, 'America/Los_Angeles', now)).toBe('2026-07-14');
    expect(clinicDateOffset(7, 'America/Los_Angeles', now)).toBe('2026-07-21');
  });
});
