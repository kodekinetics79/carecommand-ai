import { describe, expect, it } from 'vitest';
import { clinicLocalMinuteToUtc, communicationQuietHoursDecision, parseClinicSlot, validateIanaTimezone } from '../lib/scheduling';

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

describe('appointment communication quiet hours', () => {
  it('allows communication outside the overnight window', () => {
    expect(communicationQuietHoursDecision(
      new Date('2026-07-04T16:00:00.000Z'), '20:00', '08:00', 'America/New_York',
    )).toEqual({ quiet: false, nextAllowedAt: null, reason: null });
  });

  it('defers overnight communication to the clinic-local end', () => {
    const decision = communicationQuietHoursDecision(
      new Date('2026-07-05T02:15:00.000Z'), '20:00', '08:00', 'America/New_York',
    );
    expect(decision.quiet).toBe(true);
    expect(decision.nextAllowedAt?.toISOString()).toBe('2026-07-05T12:00:00.000Z');
  });

  it('advances through a nonexistent spring-forward quiet-hours end', () => {
    const decision = communicationQuietHoursDecision(
      new Date('2026-03-08T06:30:00.000Z'), '20:00', '02:30', 'America/New_York',
    );
    expect(decision.nextAllowedAt?.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('waits for the second occurrence of a fall-back quiet-hours end', () => {
    const decision = communicationQuietHoursDecision(
      new Date('2026-11-01T06:10:00.000Z'), '20:00', '01:30', 'America/New_York',
    );
    expect(decision.nextAllowedAt?.toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });

  it('fails closed on invalid configuration or timezone', () => {
    expect(communicationQuietHoursDecision(new Date(), '20:00', '20:00', 'UTC')).toMatchObject({ quiet: true, nextAllowedAt: null, reason: 'quiet_hours_invalid' });
    expect(communicationQuietHoursDecision(new Date(), '20:00', '08:00', 'Mars/Olympus')).toMatchObject({ quiet: true, nextAllowedAt: null, reason: 'quiet_hours_invalid' });
  });
});
