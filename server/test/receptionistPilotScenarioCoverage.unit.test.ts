import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('synthetic AI receptionist pilot scenario contract', () => {
  it('keeps every release-blocking review, handoff, and failure scenario in the attended synthetic lane', () => {
    const runbook = readFileSync('docs/PILOT_RUNBOOK.md', 'utf8');
    const scenarioIds = [
      'AR-CONSENT-REFUSAL',
      'AR-DEPLOYMENT-DRIFT',
      'AR-IDENTITY-LOCKOUT',
      'AR-BOOKING-COLLISION',
      'AR-HANDOFF-UNACKNOWLEDGED',
      'AR-TRANSFER-FAILURE',
      'AR-EMERGENCY',
      'AR-PROVIDER-BOOKED-WITHOUT-APPOINTMENT',
      'AR-OPERATOR-REVIEW',
      'AR-KILL-SWITCH',
    ];

    for (const scenarioId of scenarioIds) expect(runbook).toContain(`\`${scenarioId}\``);
    expect(runbook).toContain('signed-provider replay/integration harness');
    expect(runbook).toContain('Do not dial a real destination, enable provider recording, or submit a real message.');
    expect(runbook).toContain('A spoken/model response is not sufficient evidence');
    expect(runbook).toContain('Fail the receptionist pilot');
  });
});
