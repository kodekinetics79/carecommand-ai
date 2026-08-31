import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../../lib/api';
import type { OutboundCampaign } from '../../../lib/receptionist';
import { POLICY_MISSING_GUIDANCE, TargetList } from './TargetList';

/**
 * The production "Testing Clinic Call" campaign had no purpose / legal basis /
 * policy version, so `/outbound-target-candidates` answered 409 — and the
 * Studio rendered the generic red "could not be loaded" failure. The 409 is a
 * configuration step, not a load failure; these tests keep the three states
 * (policy missing / load failed / genuinely empty) distinguishable.
 */
function campaign(overrides: Partial<OutboundCampaign> = {}): OutboundCampaign {
  return {
    id: 'ob-1', clinicId: 'clinic-1', agentId: null, receptionistCampaignId: null, name: 'Testing Clinic Call', script: 'Hi',
    purpose: null, legalBasis: null, policyVersion: null, authorityApprovedAt: null, authorityApprovedById: null, authorityFingerprint: null,
    requiredFields: ['firstName', 'lastName', 'phone'], customQuestions: null, consentText: null, humanHandoffInstruction: null,
    bookingMode: 'APPOINTMENT_REQUEST_ONLY', defaultBranchId: null, defaultService: null, quietHoursStart: null, quietHoursEnd: null,
    maxRetryAttempts: 1, dialerEnabled: false, dialerMaxConcurrentCalls: 1, dialerCallsPerMinute: 1, dialerRetryGapMinutes: 60,
    status: 'DRAFT', createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

const CANDIDATES_PATH = '/v1/receptionist/outbound-target-candidates?campaignId=ob-1';
let respond: (path: string) => Promise<unknown>;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
});

function renderList(onConfigure?: () => void) {
  return render(<TargetList campaign={campaign()} targets={[]} onAdded={() => {}} onCall={() => {}} canCall={false} onConfigure={onConfigure} />);
}

describe('TargetList — candidate states are not interchangeable', () => {
  it('turns the 409 (purpose / legal basis / policy missing) into a guided state with a way to the settings', async () => {
    respond = path => path === CANDIDATES_PATH
      ? Promise.reject(new ApiError(409, 'Outbound campaign purpose, policy version, and legal basis are required before selecting targets.', 'INTERNAL_SERVER_ERROR'))
      : Promise.reject(new Error(`Unexpected request in test: ${path}`));
    const onConfigure = vi.fn();
    renderList(onConfigure);

    expect(await screen.findByText(POLICY_MISSING_GUIDANCE)).toBeInTheDocument();
    expect(screen.getByText(/purpose, policy version, and legal basis are required/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Authorized outbound target' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Go to campaign settings' }));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it('shows a load failure with its cause and a Retry when the request genuinely failed', async () => {
    let attempts = 0;
    respond = path => {
      if (path !== CANDIDATES_PATH) return Promise.reject(new Error(`Unexpected request in test: ${path}`));
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR'))
        : Promise.resolve([]);
    };
    renderList();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Authorized target candidates could not be loaded.');
    expect(alert).toHaveTextContent('An unexpected error occurred');
    expect(alert).toHaveTextContent('Existing rows are preserved');
    expect(screen.queryByText(POLICY_MISSING_GUIDANCE)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(attempts).toBe(2);
  });

  it('renders a genuinely empty answer as empty — no alert, no guidance', async () => {
    respond = path => path === CANDIDATES_PATH ? Promise.resolve([]) : Promise.reject(new Error(`Unexpected request in test: ${path}`));
    renderList();

    expect(await screen.findByText('No authorized identity with a canonical phone yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(POLICY_MISSING_GUIDANCE)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Authorized outbound target' })).toBeEnabled();
  });
});
