import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
const sessionPermissions = vi.hoisted(() => ({ value: ['crm:read', 'crm:write', 'receptionist:call-artifacts:read', 'receptionist:manage'] }));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

vi.mock('../hooks/useSession', () => ({
  useSession: () => ({ user: { effectivePermissions: sessionPermissions.value } }),
}));

import AIReceptionist from './AIReceptionist';

const readiness = {
  channel: 'sms', destinationMasked: '+1******0101', identityStatus: 'patient_linked',
  destinationSource: 'linked_patient_record', destinationVerificationStatus: 'format_verified',
  authorizationBasis: 'recorded_inbound_conversation_reply', explicitConsentStatus: 'granted',
  consentSource: 'patient_request', consentCapturedAt: '2026-09-01T12:00:00.000Z',
  suppressionStatus: 'not_suppressed', submissionState: 'clear', ready: true,
  readinessReason: 'ready_for_server_recheck', draftSource: 'rule_based_staff_review_draft',
  senderIdentity: 'Downtown Clinic', channelTerms: 'operational_reply_to_recorded_inbound_conversation',
  channelTermsSource: 'carecommand_operational_reply_policy_v1',
};

function conversation(id: string, branchId: string, branchName: string, firstName: string) {
  return {
    id, branchId, channel: 'SMS', status: 'unread', intent: 'Scheduling', latestMessage: 'I need to move my appointment.',
    lastAgentMessage: null, lastAgentMessageAt: null, estimatedValue: '0', aiHandled: false,
    createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:10:00.000Z',
    patient: { firstName, lastName: 'Patient' }, branch: { name: branchName }, replyReadiness: readiness,
  };
}

function callLog(id: string, clinicId: string, callerName: string) {
  const clinicName = clinicId === 'voice-1' ? 'Downtown Voice Line' : 'Lakeside Voice Line';
  return {
    id, clinicId, campaignId: null, providerCallRef: 'call_***1234', callerName, callerPhone: null,
    direction: 'inbound', outcome: 'BOOKED', durationSeconds: 95, sentiment: null, transcriptSummary: null,
    reviewStatus: 'UNREVIEWED', recordingConsentStatus: 'GRANTED', startedAt: null, endedAt: null,
    createdAt: '2026-09-01T12:15:00.000Z', clinic: { id: clinicId, name: clinicName }, campaign: null,
  };
}

const branches = [
  { id: 'branch-1', name: 'Downtown Clinic', active: true },
  { id: 'branch-2', name: 'Lakeside Clinic', active: true },
];

beforeEach(() => {
  sessionPermissions.value = ['crm:read', 'crm:write', 'receptionist:call-artifacts:read', 'receptionist:manage'];
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string) => {
    if (path === '/v1/branches?limit=100') return branches;
    if (path === '/v1/conversations?limit=100') return [conversation('conv-1', 'branch-1', 'Downtown Clinic', 'Avery')];
    if (path === '/v1/conversations?limit=100&branchId=branch-2') return [conversation('conv-2', 'branch-2', 'Lakeside Clinic', 'Morgan')];
    if (path === '/v1/receptionist/call-logs?limit=100') return { data: [callLog('call-1', 'voice-1', 'Avery Patient')] };
    if (path === '/v1/receptionist/call-logs?limit=100&branchId=branch-2') return { data: [callLog('call-2', 'voice-2', 'Morgan Patient')] };
    return new Promise<never>(() => {});
  });
});

describe('Communications workspace', () => {
  it('presents one truthful inbox with visible clinic identity', async () => {
    render(<MemoryRouter><AIReceptionist /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Communications' })).toBeInTheDocument();
    expect((await screen.findAllByText('Avery Patient')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Downtown Clinic').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: /Calls/ }));
    expect((await screen.findAllByText('Downtown Voice Line')).length).toBeGreaterThan(0);
  });

  it('requests both message and canonical call evidence for the selected clinic', async () => {
    render(<MemoryRouter><AIReceptionist /></MemoryRouter>);
    await screen.findAllByText('Avery Patient');
    fireEvent.click(screen.getByRole('button', { name: 'Lakeside Clinic' }));

    expect((await screen.findAllByText('Morgan Patient')).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith('/v1/conversations?limit=100&branchId=branch-2');
      expect(apiRequestMock).toHaveBeenCalledWith('/v1/receptionist/call-logs?limit=100&branchId=branch-2');
    });
    expect(screen.getAllByText('Lakeside Clinic').length).toBeGreaterThan(0);
  });

  it('does not render empty metrics while scoped records are still loading', async () => {
    const implementation = apiRequestMock.getMockImplementation();
    apiRequestMock.mockImplementation((path: string) => {
      if (path === '/v1/receptionist/call-logs?limit=100') return new Promise<never>(() => {});
      return implementation?.(path);
    });
    render(<MemoryRouter><AIReceptionist /></MemoryRouter>);

    expect(await screen.findByText('Loading clinic records')).toBeInTheDocument();
    expect(screen.queryByText('0/0')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('keeps failed scoped reads unavailable instead of presenting them as empty', async () => {
    const implementation = apiRequestMock.getMockImplementation();
    apiRequestMock.mockImplementation((path: string) => {
      if (path === '/v1/receptionist/call-logs?limit=100') throw new Error('Call evidence unavailable');
      return implementation?.(path);
    });
    render(<MemoryRouter><AIReceptionist /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load live data');
    expect(screen.queryByText('0/0')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText(/Scoped call evidence is unavailable/i)).toBeInTheDocument();
  });

  it('keeps reply and manager-only Studio actions hidden from a read-only role', async () => {
    sessionPermissions.value = ['crm:read', 'receptionist:call-artifacts:read'];
    render(<MemoryRouter><AIReceptionist /></MemoryRouter>);
    expect(await screen.findAllByText('Avery Patient')).not.toHaveLength(0);

    expect(screen.queryByRole('button', { name: 'Open receptionist studio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit reviewed reply/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot submit replies or escalations/i)).toBeInTheDocument();
  });
});
