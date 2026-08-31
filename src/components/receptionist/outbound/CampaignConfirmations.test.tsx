import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../../lib/api';
import type { OutboundCampaign } from '../../../lib/receptionist';
import type { VoiceLineStatusResponse } from '../../../lib/receptionistDeployment';
import { CampaignDetail } from './CampaignDetail';

/**
 * A reminder campaign exists to turn "the clinic booked this" into "the patient
 * says they are coming". The panel showed the calls it PLACED and never the
 * answers they produced, so a clinic could run the whole campaign and have no
 * way to tell whether it had worked.
 *
 * These pin the count against the response — and, more importantly, pin what
 * happens when there is no response. A campaign summary is the worst possible
 * place to invent a zero: "nobody confirmed" and "we could not ask" render
 * identically and mean opposite things (src/lib/resourceState.ts).
 */

function campaign(): OutboundCampaign {
  return {
    id: 'ob-1', clinicId: 'clinic-1', agentId: 'agent-1', receptionistCampaignId: null,
    name: 'Appointment reminder', script: 'Hi', purpose: 'APPOINTMENT_REMINDER',
    legalBasis: 'TREATMENT_OPERATIONS', policyVersion: 'pilot-2026-08',
    authorityApprovedAt: '2026-08-31T09:42:05.000Z', authorityApprovedById: 'user-1', authorityFingerprint: 'e37c1',
    requiredFields: ['firstName'], customQuestions: null, consentText: null, humanHandoffInstruction: null,
    bookingMode: 'APPOINTMENT_REQUEST_ONLY', defaultBranchId: null, defaultService: null,
    quietHoursStart: null, quietHoursEnd: null, maxRetryAttempts: 1, status: 'RUNNING',
    createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
  } as OutboundCampaign;
}

function serverStatus(): VoiceLineStatusResponse {
  return {
    providerConfigured: true,
    providerMode: 'live',
    agentReady: true,
    agentScope: { clinicId: 'clinic-1', campaignId: 'ob-1', agentId: 'agent-1', agentName: 'Ava' },
    verification: { status: 'VERIFIED', expiresAt: null, expiresInMs: null, autoRenew: { enabled: true, lastSystemAttemptAt: null } },
    blockers: [],
    attendedUat: null,
    adhocTestCallsAllowed: false,
  } as unknown as VoiceLineStatusResponse;
}

/** Exactly the body GET /outbound-campaigns/:id/confirmations returns. */
function confirmations(overrides: Record<string, number> = {}) {
  return { campaignId: 'ob-1', targets: 40, targetsWithAppointment: 38, patientConfirmed: 9, confirmedOnCampaignCall: 7, ...overrides };
}

/** Every other request this panel makes on mount; none of them matter here. */
function respondWith(confirmationsResponse: () => Promise<unknown>) {
  apiRequestMock.mockImplementation((path: string) => {
    if (path.includes('/confirmations')) return confirmationsResponse();
    return Promise.resolve([]);
  });
}

function renderPanel() {
  return render(<CampaignDetail campaign={campaign()} status={serverStatus()} outboundStopped={false} onChanged={() => {}} />);
}

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe('CampaignDetail — whether the campaign actually produced confirmations', () => {
  it('reports how many people answered, and how many of those this campaign earned', async () => {
    respondWith(() => Promise.resolve(confirmations()));
    renderPanel();

    expect(await screen.findByText(/9 of 38 patients have told us they’re coming\./)).toBeInTheDocument();
    expect(screen.getByText(/7 of them said so on a call from this campaign\./)).toBeInTheDocument();
    // The two people on the list who are not booked in are accounted for, not
    // quietly dropped out of the denominator.
    expect(screen.getByText(/2 more people on this list are not booked in/)).toBeInTheDocument();
  });

  it('does not credit the campaign with confirmations it did not produce', async () => {
    respondWith(() => Promise.resolve(confirmations({ patientConfirmed: 4, confirmedOnCampaignCall: 0 })));
    renderPanel();

    expect(await screen.findByText(/4 of 38 patients have told us they’re coming\./)).toBeInTheDocument();
    expect(screen.getByText(/None of them said so on a call from this campaign/)).toBeInTheDocument();
  });

  it('says nothing is confirmable when no target is booked in for an appointment', async () => {
    respondWith(() => Promise.resolve(confirmations({ targets: 12, targetsWithAppointment: 0, patientConfirmed: 0, confirmedOnCampaignCall: 0 })));
    renderPanel();

    expect(await screen.findByText(/Nobody on this list is booked in for an appointment yet/)).toBeInTheDocument();
    // An empty campaign is a fact about the workspace, so it must not be
    // dressed up as a result: no "0 of 0" total beside it.
    expect(screen.queryByText(/have told us they’re coming/)).not.toBeInTheDocument();
  });

  it('renders a named failure instead of a zero when the count cannot be read', async () => {
    respondWith(() => Promise.reject(new ApiError(500, 'Something broke', 'INTERNAL_SERVER_ERROR')));
    renderPanel();

    const failure = await screen.findByText(/Something broke/);
    expect(failure).toHaveAttribute('role', 'alert');
    // Not a number, not a dash, not "none" — the contract in resourceState.ts.
    expect(screen.queryByText(/have told us they’re coming/)).not.toBeInTheDocument();
    expect(screen.queryByText(/said so on a call from this campaign/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('does not report a count the signed-in role was refused', async () => {
    respondWith(() => Promise.reject(new ApiError(403, 'forbidden', 'insufficient_permission')));
    renderPanel();

    // The plain-language permission sentence, not a permission string.
    expect(await screen.findByText(/Your role does not have access to this data/)).toBeInTheDocument();
    expect(screen.queryByText(/have told us they’re coming/)).not.toBeInTheDocument();
  });
});
