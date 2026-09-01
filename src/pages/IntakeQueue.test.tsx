import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

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

beforeEach(() => {
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
});
