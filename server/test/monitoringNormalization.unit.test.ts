import { describe, expect, it } from 'vitest';
import { normalizeManualReading } from '../modules/monitoring/routes';

describe('manual monitoring reading plausibility', () => {
  it('accepts plausible canonical values', () => {
    expect(normalizeManualReading({ readingType: 'glucose', value: '120', unit: 'mg/dL' })?.numericValue).toBe(120);
    expect(normalizeManualReading({ readingType: 'blood_pressure', value: '120/80', unit: 'mmHg' })).toMatchObject({ numericValue: 120, valueSecondary: 80 });
    expect(normalizeManualReading({ readingType: 'oxygen', value: '98', unit: '%' })?.numericValue).toBe(98);
  });

  it.each([
    { readingType: 'glucose' as const, value: '5000', unit: 'mg/dL' },
    { readingType: 'blood_pressure' as const, value: '70/120', unit: 'mmHg' },
    { readingType: 'oxygen' as const, value: '140', unit: '%' },
    { readingType: 'weight' as const, value: '-1', unit: 'kg' },
    { readingType: 'temperature' as const, value: '100', unit: '°C' },
    { readingType: 'heart_rate' as const, value: '1000', unit: 'bpm' },
  ])('rejects an implausible $readingType measurement', input => {
    expect(normalizeManualReading(input)).toBeNull();
  });
});
