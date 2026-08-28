import { describe, expect, it } from 'vitest';
import { isTargetDialable, targetStatusAfterOutcome } from '../modules/receptionist/outbound';

describe('outbound receptionist target lifecycle policy', () => {
  it('allows only pending targets within the configured retry allowance', () => {
    expect(isTargetDialable('PENDING', 0, 1)).toBe(true);
    expect(isTargetDialable('PENDING', 1, 1)).toBe(true);
    expect(isTargetDialable('PENDING', 2, 1)).toBe(false);
    for (const terminal of ['CALLING', 'COMPLETED', 'FAILED', 'OPTED_OUT']) {
      expect(isTargetDialable(terminal, 0, 10)).toBe(false);
    }
  });

  it('terminalizes definitive outcomes and retries transient outcomes only within allowance', () => {
    expect(targetStatusAfterOutcome('BOOKED', 1, 1)).toBe('COMPLETED');
    expect(targetStatusAfterOutcome('NOT_INTERESTED', 1, 1)).toBe('COMPLETED');
    expect(targetStatusAfterOutcome('OPTED_OUT', 1, 1)).toBe('OPTED_OUT');
    expect(targetStatusAfterOutcome('NO_ANSWER', 1, 1)).toBe('PENDING');
    expect(targetStatusAfterOutcome('FAILED', 2, 1)).toBe('FAILED');
    expect(targetStatusAfterOutcome('IN_PROGRESS', 1, 1)).toBeNull();
  });
});
