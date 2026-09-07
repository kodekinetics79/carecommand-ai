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
    maxRetryAttempts: 1, status: 'DRAFT', createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

const CANDIDATES_PATH = '/v1/receptionist/outbound-target-candidates?campaignId=ob-1';
const TARGETS_PATH = '/v1/receptionist/outbound-campaigns/ob-1/targets';
let respond: (path: string, init?: RequestInit) => Promise<unknown>;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

function renderList(onConfigure?: () => void, overrides: Partial<OutboundCampaign> = {}) {
  return render(<TargetList campaign={campaign(overrides)} targets={[]} onAdded={() => {}} onCall={() => {}} canCall={false} onConfigure={onConfigure} />);
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
    expect(screen.getByRole('button', { name: 'Add patients' })).toBeDisabled();

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

    await screen.findByRole('button', { name: 'Add patients' });
    fireEvent.click(screen.getByRole('button', { name: 'Add patients' }));
    expect(await screen.findByText('No patients match this search.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(POLICY_MISSING_GUIDANCE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close patient picker' })).toBeEnabled();
  });
});

describe('TargetList — appointment reminders are about one real appointment', () => {
  it('auto-selects the only upcoming appointment and sends its id with the patient target', async () => {
    let posted: unknown = null;
    respond = async (path, init) => {
      if (path === CANDIDATES_PATH) {
        return [{
          type: 'patient',
          id: 'patient-1',
          name: 'Jordan Test',
          phone: '+15714305555',
          voiceAuthorizationReady: true,
          voiceAuthorizationReason: 'treatment_operations',
          appointments: [{
            appointmentId: 'appointment-1',
            startsAt: '2026-09-02T14:00:00.000Z',
            timezone: 'America/New_York',
            service: 'Follow-up visit',
            clinician: 'Dr. Maya Chen',
            location: 'Main Clinic',
          }],
        }];
      }
      if (path === TARGETS_PATH && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return { added: 1 };
      }
      throw new Error(`Unexpected request in test: ${path}`);
    };

    renderList(undefined, {
      purpose: 'APPOINTMENT_REMINDER',
      legalBasis: 'TREATMENT_OPERATIONS',
      policyVersion: 'appointment-reminder-v1',
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Add patients' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Jordan Test' }));

    const appointment = screen.getByRole('combobox', { name: 'Appointment for Jordan Test' }) as HTMLSelectElement;
    await waitFor(() => expect(appointment.value).toBe('appointment-1'));
    expect(screen.getByText(/choose the patient and the exact upcoming visit/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save to list' }));
    await waitFor(() => expect(posted).toEqual({
      targets: [{ patientId: 'patient-1', appointmentId: 'appointment-1' }],
    }));
  });

  it('keeps CRM leads out of the patient picker and disables patients with no upcoming appointment', async () => {
    respond = path => path === CANDIDATES_PATH ? Promise.resolve([
      {
        type: 'lead', id: 'lead-1', name: 'Lead Person', phone: '+15714305556',
        voiceAuthorizationReady: true, voiceAuthorizationReason: 'compatible_immutable_consent', appointments: [],
      },
      {
        type: 'patient', id: 'patient-2', name: 'No Appointment Patient', phone: '+15714305557',
        voiceAuthorizationReady: true, voiceAuthorizationReason: 'treatment_operations', appointments: [],
      },
    ]) : Promise.reject(new Error(`Unexpected request in test: ${path}`));

    renderList(undefined, {
      purpose: 'APPOINTMENT_REMINDER',
      legalBasis: 'TREATMENT_OPERATIONS',
      policyVersion: 'appointment-reminder-v1',
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Add patients' }));
    expect(await screen.findByText('No Appointment Patient')).toBeInTheDocument();
    expect(screen.queryByText('Lead Person')).not.toBeInTheDocument();
    expect(screen.getByText('No upcoming appointment')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select No Appointment Patient' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save to list' })).toBeDisabled();
  });

  it('adds one or many existing patients in a single save action', async () => {
    let posted: unknown = null;
    respond = async (path, init) => {
      if (path === CANDIDATES_PATH) return [
        { type: 'patient', id: 'patient-1', name: 'Jordan Test', phone: '+15714305555', voiceAuthorizationReady: true, voiceAuthorizationReason: 'treatment_operations', appointments: [] },
        { type: 'patient', id: 'patient-2', name: 'Casey Test', phone: '+15714305556', voiceAuthorizationReady: true, voiceAuthorizationReason: 'treatment_operations', appointments: [] },
      ];
      if (path === TARGETS_PATH && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return { added: 2 };
      }
      throw new Error(`Unexpected request in test: ${path}`);
    };

    renderList(undefined, { purpose: 'CARE_COORDINATION', legalBasis: 'TREATMENT_OPERATIONS', policyVersion: 'care-v1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add patients' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select all shown (2)' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save to list' }));

    await waitFor(() => expect(posted).toEqual({
      targets: [{ patientId: 'patient-1' }, { patientId: 'patient-2' }],
    }));
  });
});
