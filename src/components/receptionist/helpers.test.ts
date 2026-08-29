import { describe, expect, it } from 'vitest';
import { formatEnumLabel } from './helpers';

describe('formatEnumLabel', () => {
  it('sentence-cases SCREAMING_SNAKE and snake_case enum values', () => {
    expect(formatEnumLabel('PENDING_REVIEW')).toBe('Pending review');
    expect(formatEnumLabel('BOOKED')).toBe('Booked');
    expect(formatEnumLabel('transport_ambiguous')).toBe('Transport ambiguous');
    expect(formatEnumLabel('provider_deployment_drift')).toBe('Provider deployment drift');
  });

  it('splits camelCase into words', () => {
    expect(formatEnumLabel('directBooking')).toBe('Direct booking');
    expect(formatEnumLabel('appointmentRequestOnly')).toBe('Appointment request only');
  });

  it('leaves mixed-case human text and acronyms as written (M71)', () => {
    expect(formatEnumLabel('Warm and professional')).toBe('Warm and professional');
    expect(formatEnumLabel('Retell LLM')).toBe('Retell LLM');
    expect(formatEnumLabel('SMS confirmation')).toBe('SMS confirmation');
    expect(formatEnumLabel('en-US')).toBe('En-US');
  });

  it('never returns an empty label', () => {
    expect(formatEnumLabel('')).toBe('Unknown');
    expect(formatEnumLabel('   ')).toBe('Unknown');
  });
});
