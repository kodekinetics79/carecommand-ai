import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { VoiceLineStatus } from '../../../lib/receptionist';
import type { VoiceLineStatusResponse } from '../../../lib/receptionistDeployment';
import { VoiceLineStatusCard } from './VoiceLineStatusCard';

/**
 * The production card said "set the missing environment variables" for every
 * kind of unreadiness and always rendered the live-test block. These tests
 * hold the new contract: the server's own blockers with their fix links, an
 * honest verification expiry, and an attended-UAT block that exists only when
 * the server sent one (demo profile).
 */
function status(overrides: Partial<VoiceLineStatusResponse> = {}): VoiceLineStatusResponse {
  return {
    providerConfigured: true,
    providerMode: 'live',
    agentReady: false,
    agentScope: { clinicId: 'clinic-1', campaignId: 'camp-1', agentId: 'agent-1', agentName: 'Riley' },
    verification: { status: 'VERIFIED', expiresAt: '2026-08-30T14:00:00.000Z', expiresInMs: 19 * 60 * 60 * 1000, autoRenew: { enabled: true, lastSystemAttemptAt: new Date().toISOString() } },
    blockers: [],
    attendedUat: null,
    adhocTestCallsAllowed: false,
    ...overrides,
  };
}

function renderCard(value: VoiceLineStatusResponse | VoiceLineStatus | null) {
  return render(<MemoryRouter><VoiceLineStatusCard status={value} /></MemoryRouter>);
}

describe('VoiceLineStatusCard — the server says what is wrong and where to fix it', () => {
  it('renders each server blocker with its own words and a fix link', () => {
    renderCard(status({
      agentReady: false,
      blockers: [
        { code: 'agent_unverified', severity: 'blocking', title: 'The voice line has not passed a line check', action: 'Run the line check before activating.', fixHref: '/receptionist-studio?tab=campaign&agent=agent-1', scope: 'agent' },
        { code: 'voice_service_number_missing', severity: 'blocking', title: 'Outbound caller number is not set', action: 'Ask your CareCommand administrator to set this on the API and worker environments, then reload.', fixHref: null, scope: 'server' },
      ],
    }));

    expect(screen.getByText('The voice line has not passed a line check')).toBeInTheDocument();
    expect(screen.getByText('Run the line check before activating.')).toBeInTheDocument();
    expect(screen.getByText('Outbound caller number is not set')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix The voice line has not passed a line check' })).toHaveAttribute('href', '/receptionist-studio?tab=campaign&agent=agent-1');
    // A blocker with no fix link offers no link at all rather than a dead one.
    expect(screen.queryByRole('link', { name: 'Fix Outbound caller number is not set' })).not.toBeInTheDocument();
    expect(screen.getByText(/2 blocking items/)).toBeInTheDocument();
  });

  it('hides the attended live-test block when the server did not send one', () => {
    renderCard(status({ agentReady: true }));
    expect(screen.queryByTestId('attended-uat')).not.toBeInTheDocument();
    expect(screen.queryByText(/Attended live-test authorization/)).not.toBeInTheDocument();
  });

  it('shows the attended live-test block with its limits when the server sent one', () => {
    renderCard(status({
      attendedUat: {
        enabled: true, active: false, executionId: 'uat-1', allowedDestinationMasked: '***-***-0199', expiresAt: null,
        timezone: 'America/New_York', windowStart: '09:00', windowEnd: '17:00', maxCalls: 2, maxCallMinutes: 5,
        maxTotalMinutes: 10, maxProviderCostUsd: 5, projectedMaximumCostUsd: 2, blockingReason: 'live_test_outside_window',
        attemptsUsed: 0, callsRemaining: 2, minutesUsed: 0, minutesRemaining: 10, activeCalls: 0, admissionReason: null,
      },
    }));

    expect(screen.getByTestId('attended-uat')).toBeInTheDocument();
    expect(screen.getByText(/\*\*\*-\*\*\*-0199/)).toBeInTheDocument();
    expect(screen.getByText('live_test_outside_window')).toBeInTheDocument();
  });

  it('shows the mock badge so nobody mistakes a rehearsal for a live provider', () => {
    renderCard(status({ providerMode: 'mock', agentReady: true }));
    expect(screen.getByText('mock mode')).toBeInTheDocument();
  });

  it('says the verification expiry auto-renews only when the worker actually ran', () => {
    renderCard(status({ agentReady: true }));
    expect(screen.getByText('Verified · expires in 19h — auto-renews')).toBeInTheDocument();
  });

  it('warns instead when auto-renewal is not running', () => {
    renderCard(status({
      agentReady: true,
      verification: { status: 'VERIFIED', expiresAt: '2026-08-30T14:00:00.000Z', expiresInMs: 5 * 60 * 60 * 1000, autoRenew: { enabled: false, lastSystemAttemptAt: null } },
    }));
    expect(screen.getByText('Verified · expires in 5h — auto-renewal is not running; verify manually before then')).toBeInTheDocument();
  });

  it('still renders the pre-C5 status body so the outbound panel keeps working', () => {
    const legacy: VoiceLineStatus = {
      configured: false, mock: true, missing: ['voice_service_number_missing', 'AGENT_DEPLOYMENT'], readyAgents: 0, adhocTestCallsAllowed: true,
      liveTest: {
        enabled: false, active: false, executionId: null, allowedDestinationMasked: null, expiresAt: null, timezone: 'UTC',
        windowStart: '09:00', windowEnd: '17:00', maxCalls: 0, maxCallMinutes: 0, maxTotalMinutes: 0, maxProviderCostUsd: 0,
        projectedMaximumCostUsd: 0, blockingReason: 'live_test_not_authorized', attemptsUsed: 0, callsRemaining: 0,
        minutesUsed: 0, minutesRemaining: 0, activeCalls: 0, admissionReason: null,
      },
      checklist: [
        { key: 'voice_service_key_missing', label: 'Voice service credential', set: true },
        { key: 'voice_service_number_missing', label: 'Outbound caller number', set: false },
        { key: 'AGENT_DEPLOYMENT', label: 'Published agent deployment', set: false },
        { key: 'LIVE_TEST_CALLS_AUTHORIZED', label: 'Attended live-test authorization', set: false },
      ],
    };
    renderCard(legacy);

    expect(screen.getByText('Outbound caller number')).toBeInTheDocument();
    expect(screen.getByText('Published agent deployment')).toBeInTheDocument();
    expect(screen.getByText('mock mode')).toBeInTheDocument();
    // liveTest.enabled is false, so no attended-UAT block is invented.
    expect(screen.queryByTestId('attended-uat')).not.toBeInTheDocument();
  });
});
