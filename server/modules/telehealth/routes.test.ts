import { describe, expect, it } from 'vitest';
import { clinicTodayRange } from './routes';

describe('telehealth clinic-local day range', () => {
  it('bounds today at the clinic midnight and excludes tomorrow', () => {
    const now = new Date('2026-09-03T02:00:00.000Z'); // Sep 2, 10:00 PM in New York
    const range = clinicTodayRange('America/New_York', now);
    expect(range.from.toISOString()).toBe('2026-09-02T04:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-09-03T04:00:00.000Z');
    expect(new Date('2026-09-03T04:00:00.000Z').getTime()).toBe(range.to.getTime());
  });
});
