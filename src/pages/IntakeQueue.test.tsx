import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

vi.mock('../hooks/useSession', () => ({ useSession: useSessionMock }));

import IntakeQueue from './IntakeQueue';

const packet = {
  intakePacketId: 'packet-1', appointmentId: 'appointment-1', appointmentRequestId: null,
  patientId: 'patient-1', leadId: null, status: 'submitted', source: 'public',
  readinessScore: 92, submittedAt: '2026-08-31T14:00:00.000Z', reviewedAt: null,
  tokenExpiresAt: null, createdAt: '2026-08-31T13:00:00.000Z',
  sections: [{ sectionType: 'demographics', status: 'completed' }],
  allowedActions: ['approve', 'mark_needs_review'], deepLinkTarget: 'appointment/appointment-1', setupRequired: true,
  subject: { kind: 'patient', name: 'Alex Rivera' },
  clinic: { id: 'branch-1', name: 'Downtown Clinic', timezone: 'America/New_York' },
  visit: { service: 'New Patient Consultation', startsAt: '2026-09-03T14:00:00.000Z' },
};

function patient(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, branchId: 'branch-1', branch: { name: 'Arlington' }, firstName: 'Alex', lastName: 'Rivera', externalRef: `MRN-${id}`,
    email: null, phone: null, dateOfBirth: null, lifecycleStage: 'ACTIVE', churnRisk: 0,
    lifetimeValue: '0', outstandingBalance: '0', tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  useSessionMock.mockReturnValue({ user: { role: 'OWNER', effectivePermissions: ['intake:read', 'intake:write'] } });
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => {
    if (path === '/v1/intake/queue') return Promise.resolve([packet]);
    if (path === '/v1/intake/packets/packet-1') return Promise.resolve({ ...packet, documents: [], consentRecords: [] });
    if (path.startsWith('/v1/patients')) return Promise.resolve([]);
    return Promise.reject(new Error(`Unexpected request in test: ${path}`));
  });
});

describe('Patient Intake review identity', () => {
  it('shows the patient, clinic, and visit before offering approval', async () => {
    render(<MemoryRouter><IntakeQueue /></MemoryRouter>);

    expect((await screen.findAllByText('Alex Rivera')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Downtown Clinic.*New Patient Consultation/).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('searches the full patient directory on the server instead of limiting choices to the first page', async () => {
    render(<MemoryRouter><IntakeQueue /></MemoryRouter>);

    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search patients for new intake' }), { target: { value: 'Rivera' } });
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/patients?limit=25&search=Rivera'));
  });

  it('keeps cursor paging available so a match beyond the first 25 can be selected', async () => {
    apiRequestMock.mockImplementation((path: string) => {
      if (path === '/v1/intake/queue') return Promise.resolve([packet]);
      if (path === '/v1/intake/packets/packet-1') return Promise.resolve({ ...packet, documents: [], consentRecords: [] });
      if (path === '/v1/patients?limit=25') return Promise.resolve({ data: [] });
      if (path === '/v1/patients?limit=25&search=Rivera') {
        return Promise.resolve({ data: Array.from({ length: 25 }, (_, index) => patient(`page-1-${index}`)), nextCursor: 'cursor-25' });
      }
      if (path === '/v1/patients?limit=25&cursor=cursor-25&search=Rivera') {
        return Promise.resolve({ data: [patient('patient-26', { externalRef: 'MRN-0026' })] });
      }
      return Promise.reject(new Error(`Unexpected request in test: ${path}`));
    });
    render(<MemoryRouter><IntakeQueue /></MemoryRouter>);

    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search patients for new intake' }), { target: { value: 'Rivera' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Load more matches' }));

    expect(await screen.findByRole('option', { name: 'Alex Rivera · Arlington · ref MRN-0026' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more matches' })).not.toBeInTheDocument();
  });

  it('disambiguates duplicate patient names with references or masked contact details', async () => {
    apiRequestMock.mockImplementation((path: string) => {
      if (path === '/v1/intake/queue') return Promise.resolve([packet]);
      if (path === '/v1/intake/packets/packet-1') return Promise.resolve({ ...packet, documents: [], consentRecords: [] });
      if (path === '/v1/patients?limit=25') return Promise.resolve({ data: [] });
      if (path === '/v1/patients?limit=25&search=Alex') return Promise.resolve({ data: [
        patient('duplicate-a', { externalRef: 'BH-1001' }),
        patient('duplicate-b', { externalRef: null, phone: '+1 (571) 430-5555' }),
      ] });
      return Promise.reject(new Error(`Unexpected request in test: ${path}`));
    });
    render(<MemoryRouter><IntakeQueue /></MemoryRouter>);

    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search patients for new intake' }), { target: { value: 'Alex' } });

    expect(await screen.findByRole('option', { name: 'Alex Rivera · Arlington · ref BH-1001' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Alex Rivera · Arlington · phone ending 5555' })).toBeInTheDocument();
  });

  it('does not offer intake mutations to a read-only user', async () => {
    useSessionMock.mockReturnValue({ user: { role: 'AUDITOR', effectivePermissions: ['intake:read'] } });
    render(<MemoryRouter><IntakeQueue /></MemoryRouter>);

    expect((await screen.findAllByText('Alex Rivera')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('searchbox', { name: 'Search patients for new intake' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
