import { describe, expect, it } from 'vitest';
import { clinicLocalMinuteToUtc, parseClinicSlot, validateIanaTimezone } from '../lib/scheduling';

describe('clinic scheduling timezone conversion', () => {
  it('rejects nonexistent spring-forward wall times', () => {
    expect(clinicLocalMinuteToUtc('2026-03-08', 2 * 60 + 30, 'America/New_York')).toBeNull();
  });

  it('chooses the earlier instant deterministically during a fall-back fold', () => {
    expect(parseClinicSlot('2026-11-01', '01:30', 'America/New_York')?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('maps a clinic-local date across its UTC boundary', () => {
    expect(parseClinicSlot('2026-07-04', '09:00', 'America/Los_Angeles')?.toISOString()).toBe('2026-07-04T16:00:00.000Z');
  });

  it('rejects invalid IANA timezone identifiers', () => {
    expect(() => validateIanaTimezone('Mars/Olympus')).toThrow(/Invalid branch timezone/);
  });
});
