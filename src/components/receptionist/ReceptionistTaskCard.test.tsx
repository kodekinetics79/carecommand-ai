import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { resetFrontDeskPollForTests } from '../../hooks/useFrontDeskPoll';
import { normalizeTaskRow, type FrontDeskTaskRow } from '../../lib/frontDesk';
import { ReceptionistTaskCard, type TaskCardPermissions } from './ReceptionistTaskCard';

/**
 * Two day-2 corrections live on this card:
 *
 *   E6 — after the audited reveal the number is shown in FULL with a copy
 *   button. A desk on a physical handset has to read the digits; masking them
 *   after the disclosure was already spent blocks the primary action and
 *   protects nothing.
 *
 *   E11 — a deployment-attention task carries a written remediation and a fix
 *   link instead of caller fields it does not have.
 */

const CAN: TaskCardPermissions = { work: true, readArtifacts: true, book: true };

function callerTask(): FrontDeskTaskRow {
  return normalizeTaskRow({
    id: 'task-1', title: 'Message from a caller', priority: 'high', status: 'OPEN',
    createdAt: '2026-08-30T09:00:00.000Z',
    clinic: { id: 'c1', name: 'Brightsmile', timezone: 'America/Los_Angeles' },
    metadata: {
      workflow: 'receptionist_safety', kind: 'message', callerName: 'Jordan Vale',
      callbackPhone: '+14155554242', message: 'Please call me back.',
    },
  });
}

beforeEach(() => {
  resetFrontDeskPollForTests();
  apiRequestMock.mockReset();
});
afterEach(() => resetFrontDeskPollForTests());

describe('ReceptionistTaskCard — the audited reveal (E6)', () => {
  it('shows the mask until the reveal, then the full number with a copy button', async () => {
    apiRequestMock.mockResolvedValue({
      ...callerTask(),
      contact: { callbackPhone: '+14155554242', verifiedPhone: null, requestedCallbackPhone: null, callerName: 'Jordan Vale' },
    });
    render(<ReceptionistTaskCard task={callerTask()} timezone="America/Los_Angeles" can={CAN} onChanged={() => {}} />);

    expect(screen.getByText('***-***-4242')).toBeInTheDocument();
    expect(screen.queryByText('+14155554242')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Call back Jordan Vale' }));
    const link = await screen.findByRole('link', { name: /Dial Jordan Vale/ });
    expect(link).toHaveAttribute('href', 'tel:+14155554242');
    expect(link).toHaveTextContent('+14155554242');
    expect(screen.getByText('revealed and logged')).toBeInTheDocument();
  });

  it('copies the number and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    apiRequestMock.mockResolvedValue({
      ...callerTask(),
      contact: { callbackPhone: '+14155554242', verifiedPhone: null, requestedCallbackPhone: null, callerName: 'Jordan Vale' },
    });
    render(<ReceptionistTaskCard task={callerTask()} timezone="America/Los_Angeles" can={CAN} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Call back Jordan Vale' }));
    fireEvent.click(await screen.findByRole('button', { name: /Copy Jordan Vale's number/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('+14155554242'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('never reports a refused clipboard as a successful copy', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    apiRequestMock.mockResolvedValue({
      ...callerTask(),
      contact: { callbackPhone: '+14155554242', verifiedPhone: null, requestedCallbackPhone: null, callerName: 'Jordan Vale' },
    });
    render(<ReceptionistTaskCard task={callerTask()} timezone="America/Los_Angeles" can={CAN} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Call back Jordan Vale' }));
    fireEvent.click(await screen.findByRole('button', { name: /Copy Jordan Vale's number/ }));

    expect(await screen.findByText(/clipboard was not available/)).toBeInTheDocument();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('says no number is on record instead of offering a dead tel: link', async () => {
    apiRequestMock.mockResolvedValue({
      ...callerTask(),
      contact: { callbackPhone: null, verifiedPhone: null, requestedCallbackPhone: null, callerName: 'Jordan Vale' },
    });
    render(<ReceptionistTaskCard task={callerTask()} timezone="America/Los_Angeles" can={CAN} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Call back Jordan Vale' }));
    expect(await screen.findByText('No callback number is on record for this task.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Dial/ })).not.toBeInTheDocument();
  });
});

describe('ReceptionistTaskCard — deployment attention (E11)', () => {
  const deploymentTask = () => normalizeTaskRow({
    id: 'task-deploy', title: 'AI receptionist deployment needs attention', priority: 'HIGH', status: 'OPEN',
    createdAt: '2026-08-30T09:00:00.000Z',
    metadata: {
      workflow: 'receptionist_deployment', agentId: 'agent-1', clinicId: 'c1', code: 'number_bound',
      title: 'The phone number is not bound to this agent',
      action: 'Re-deploy the campaign so the number points at the published agent.',
      fixHref: '/receptionist-studio?tab=deploy',
    },
  });

  it('renders the remediation the server wrote, with its fix link and code', () => {
    render(<ReceptionistTaskCard task={deploymentTask()} timezone="America/Los_Angeles" can={CAN} onChanged={() => {}} />);
    expect(screen.getByText('The phone number is not bound to this agent')).toBeInTheDocument();
    expect(screen.getByText('Re-deploy the campaign so the number points at the published agent.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix this' })).toHaveAttribute('href', '/receptionist-studio?tab=deploy');
    expect(screen.getByText('Code: number_bound')).toBeInTheDocument();
  });

  it('shows the deployment as the subject and offers no caller controls it has no data for', () => {
    render(<ReceptionistTaskCard task={deploymentTask()} timezone="America/Los_Angeles" can={CAN} onChanged={() => {}} />);
    expect(screen.getByText('AI receptionist deployment needs attention')).toBeInTheDocument();
    expect(screen.queryByText('Unknown caller')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Call back/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Not linked to a patient')).not.toBeInTheDocument();
  });

  it('must be acknowledged by a person, whatever priority it was filed with', () => {
    render(<ReceptionistTaskCard task={deploymentTask()} timezone="America/Los_Angeles" can={CAN} onChanged={() => {}} />);
    expect(screen.getByText('Not yet acknowledged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Acknowledge/ })).toBeInTheDocument();
  });
});
