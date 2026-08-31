import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import type { OutboundCampaign } from '../../../lib/receptionist';
import type { VoiceLineStatusResponse } from '../../../lib/receptionistDeployment';
import { CampaignDetail } from './CampaignDetail';

/**
 * `/voice-line-status` migrated from { configured, mock, missing, liveTest } to
 * { providerConfigured, attendedUat, blockers, ... }. VoiceLineStatusCard moved
 * to the normalizer; CampaignDetail did not, and kept reading the old field
 * names straight off the new body.
 *
 * Both reads were `undefined`, which is the worst possible failure here because
 * neither is an error:
 *   - `configured` -> false  => "The voice line isn't connected" on a READY line,
 *                               and `canCall` false, so every launch control was
 *                               permanently disabled;
 *   - `liveTest`   -> absent => the attended-UAT card never rendered at all, so
 *                               there was no way to attach the authorized
 *                               recipient.
 *
 * Observed in production 2026-08-31 with a verified voice line and an ACTIVE
 * live-test authorization: the card above said ready, this panel said not
 * connected, and nothing could be dialled. TypeScript could not catch it — the
 * response is cast, not parsed, so a stale field name is a compile-time
 * success and a runtime undefined.
 *
 * These pin the panel against the shape the SERVER actually returns.
 */
function campaign(overrides: Partial<OutboundCampaign> = {}): OutboundCampaign {
  return {
    id: 'ob-1', clinicId: 'clinic-1', agentId: 'agent-1', receptionistCampaignId: null,
    name: 'Appointment reminder', script: 'Hi', purpose: 'APPOINTMENT_REMINDER',
    legalBasis: 'TREATMENT_OPERATIONS', policyVersion: 'pilot-2026-08',
    authorityApprovedAt: '2026-08-31T09:42:05.000Z', authorityApprovedById: 'user-1', authorityFingerprint: 'e37c1',
    requiredFields: ['firstName'], customQuestions: null, consentText: null, humanHandoffInstruction: null,
    bookingMode: 'APPOINTMENT_REQUEST_ONLY', defaultBranchId: null, defaultService: null,
    quietHoursStart: null, quietHoursEnd: null, maxRetryAttempts: 1, status: 'RUNNING',
    createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  } as OutboundCampaign;
}

/** Exactly what server/modules/receptionist/deployment.ts returns. */
function serverStatus(overrides: Partial<VoiceLineStatusResponse> = {}): VoiceLineStatusResponse {
  return {
    providerConfigured: true,
    providerMode: 'live',
    agentReady: true,
    agentScope: { clinicId: 'clinic-1', campaignId: 'ob-1', agentId: 'agent-1', agentName: 'Ava' },
    verification: { status: 'VERIFIED', expiresAt: null, expiresInMs: null, autoRenew: { enabled: true, lastSystemAttemptAt: null } },
    blockers: [],
    attendedUat: {
      enabled: true, active: true, executionId: 'uat-1', allowedDestinationMasked: '***-***-5555',
      expiresAt: '2026-08-31T23:00:00.000Z', timezone: 'America/New_York', windowStart: '09:00', windowEnd: '20:00',
      maxCalls: 2, maxCallMinutes: 5, maxTotalMinutes: 10, maxProviderCostUsd: 3, projectedMaximumCostUsd: 1.5,
      blockingReason: null, callsRemaining: 2, minutesRemaining: 10, admissionReason: null,
    } as VoiceLineStatusResponse['attendedUat'],
    adhocTestCallsAllowed: false,
    ...overrides,
  };
}

beforeEach(() => {
  apiRequestMock.mockReset();
  // Nothing this panel loads on mount matters to these assertions.
  apiRequestMock.mockImplementation(async () => []);
});

describe('CampaignDetail reads the shape the server actually sends', () => {
  it('does not claim the voice line is disconnected when the server says it is configured', () => {
    render(<CampaignDetail campaign={campaign()} status={serverStatus()} outboundStopped={false} onChanged={() => {}} />);
    expect(screen.queryByText(/voice line isn.t connected/i)).toBeNull();
  });

  it('still says so when the server really does report it unconfigured', () => {
    render(<CampaignDetail campaign={campaign()} status={serverStatus({ providerConfigured: false })} outboundStopped={false} onChanged={() => {}} />);
    expect(screen.getByText(/voice line isn.t connected/i)).toBeTruthy();
  });

  it('renders the attended live-UAT card from attendedUat, with its real limits', () => {
    render(<CampaignDetail campaign={campaign()} status={serverStatus()} outboundStopped={false} onChanged={() => {}} />);
    expect(screen.getByText(/Attended synthetic live voice UAT/i)).toBeTruthy();
    // The masked destination and caps must be the server's, not placeholders.
    expect(screen.getByText(/\*\*\*-\*\*\*-5555/)).toBeTruthy();
    expect(screen.getByText(/2 calls remaining/)).toBeTruthy();
    expect(screen.getByText(/10 minutes remaining/)).toBeTruthy();
  });

  it('offers no attach control when the server sent no attended-UAT block', () => {
    render(<CampaignDetail campaign={campaign()} status={serverStatus({ attendedUat: null })} outboundStopped={false} onChanged={() => {}} />);
    expect(screen.queryByText(/Attended synthetic live voice UAT/i)).toBeNull();
  });

  it('names the reason instead of hiding it when the authorization is blocked', () => {
    const blocked = serverStatus();
    const status = serverStatus({ attendedUat: { ...blocked.attendedUat!, active: false, blockingReason: 'outside_window' } });
    render(<CampaignDetail campaign={campaign()} status={status} outboundStopped={false} onChanged={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Blocked:/i);
  });
});
