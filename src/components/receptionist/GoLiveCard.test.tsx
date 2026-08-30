import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { ReadinessResponse, VerificationView } from '../../lib/receptionistDeployment';
import { GoLiveCard, ServiceStatusStrip } from './GoLiveCard';
import { serviceStatus } from '../../lib/receptionistDeployment';

/**
 * The go-live path is ordered and each step is a readiness row: nothing is
 * marked done because the UI assumes it, and a step the server has not
 * evaluated stays pending.
 *
 * These fixtures use `number_bound` — the key `campaignReadiness.ts` actually
 * emits. They previously used `phone_number_bound`, which the server has never
 * emitted, so "forward the public number to the DID" could never leave "Not
 * evaluated yet.", never got a Fix link, and the card could never reach 5/5 —
 * while both jsdom fixtures made that ship green.
 */
function readiness(checks: ReadinessResponse['checks'], overrides: Partial<ReadinessResponse> = {}): ReadinessResponse {
  return {
    campaignId: 'camp-1', status: 'DRAFT', ready: false, checks,
    actions: { activate: { allowed: false, reasons: [] }, pause: { allowed: false, reasons: [] }, archive: { allowed: true, reasons: [] } },
    evaluatedAt: '2026-08-29T18:00:00.000Z',
    ...overrides,
  };
}

const deployedAndVerified: ReadinessResponse['checks'] = [
  { key: 'deployment_current', label: 'Deployment current', status: 'pass', code: null, detail: 'Version 4 is deployed and matches the draft.', fixHref: null },
  { key: 'agent_verified', label: 'Agent verified', status: 'pass', code: null, detail: 'Verified.', fixHref: null },
];

function verification(overrides: Partial<VerificationView> = {}): VerificationView {
  return {
    status: 'VERIFIED', expiresAt: null, expiresInMs: 19 * 60 * 60 * 1000,
    autoRenew: { enabled: true, lastSystemAttemptAt: new Date().toISOString() },
    ...overrides,
  };
}

describe('GoLiveCard — the ordered path to answering a real call', () => {
  it('lists deploy, verify, forward, test call, activate in order', () => {
    render(<MemoryRouter><GoLiveCard readiness={null} campaignStatus="DRAFT" /></MemoryRouter>);

    const list = screen.getByRole('list', { name: 'Go live steps' });
    const steps = within(list).getAllByRole('listitem').map(node => node.getAttribute('data-step'));
    expect(steps).toEqual(['deploy', 'verify', 'forward', 'test_call', 'activate']);
  });

  it('marks each step from its readiness row and keeps unevaluated ones pending', () => {
    render(<MemoryRouter><GoLiveCard campaignStatus="DRAFT" readiness={readiness([
      ...deployedAndVerified,
      { key: 'number_bound', label: 'The phone number answers with this agent', status: 'fail', code: 'number_bound', title: 'The number is not bound to this deployment', detail: 'The phone number does not point at this receptionist version.', fixHref: '/receptionist-studio?clinic=c1&campaign=camp-1&tab=deploy' },
    ])} /></MemoryRouter>);

    const list = screen.getByRole('list', { name: 'Go live steps' });
    const byStep = (key: string) => within(list).getAllByRole('listitem').find(node => node.getAttribute('data-step') === key);
    expect(byStep('deploy')).toHaveAttribute('data-status', 'done');
    // This is E2: with the wrong key this step read "pending" forever.
    expect(byStep('forward')).toHaveAttribute('data-status', 'todo');
    // The server never evaluated the test call, so the card does not claim it happened.
    expect(byStep('test_call')).toHaveAttribute('data-status', 'pending');
    const forward = byStep('forward')!;
    expect(within(forward).getByText('The phone number does not point at this receptionist version.')).toBeInTheDocument();
    expect(within(forward).getByText('The number is not bound to this deployment')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix Forward the public number to the DID' })).toBeInTheDocument();
    expect(screen.getByText('2/5 steps')).toBeInTheDocument();
  });

  it('names the next action, with the server’s remediation title and its fix link', () => {
    render(<MemoryRouter><GoLiveCard campaignStatus="DRAFT" readiness={readiness([
      ...deployedAndVerified,
      { key: 'number_bound', label: 'The phone number answers with this agent', status: 'fail', code: 'number_bound', title: 'The number is not bound to this deployment', detail: 'Deploy again so the receptionist number answers with this agent.', fixHref: '/receptionist-studio?tab=deploy' },
    ])} /></MemoryRouter>);

    const next = screen.getByTestId('next-action');
    expect(next).toHaveTextContent('Next: The number is not bound to this deployment');
    expect(within(next).getByRole('link')).toHaveAttribute('href', '/receptionist-studio?tab=deploy');
  });

  it('prints the dialable number once the server proves the line is bound, and says so plainly when it cannot', () => {
    const { rerender } = render(<MemoryRouter><GoLiveCard campaignStatus="ACTIVE" readiness={readiness([
      ...deployedAndVerified,
      { key: 'number_bound', label: 'Bound', status: 'pass', code: null, detail: 'The line is confirmed.', fixHref: null },
      // The number arrives as a field, not as a phrase inside `detail`: the
      // card must not go looking for it in the server's English.
    ], { ready: true, boundNumber: '+14155550142' })} /></MemoryRouter>);

    expect(within(screen.getByTestId('dial-this-number')).getByText('+14155550142')).toBeInTheDocument();

    rerender(<MemoryRouter><GoLiveCard campaignStatus="ACTIVE" readiness={readiness(deployedAndVerified)} /></MemoryRouter>);
    expect(screen.getByTestId('dial-this-number')).toHaveTextContent('Not confirmed yet.');
  });

  it('promotes clinic prerequisites ahead of every deployment step', () => {
    render(<MemoryRouter><GoLiveCard campaignStatus="DRAFT" readiness={readiness(deployedAndVerified)} prerequisites={[
      { code: 'clinic_hours_missing', label: 'No hours', fixHref: '/receptionist-studio?clinic=c1&tab=clinic' },
    ]} /></MemoryRouter>);

    expect(within(screen.getByTestId('clinic-prerequisites')).getByText('No hours')).toBeInTheDocument();
    expect(screen.getByTestId('next-action')).toHaveTextContent('Next: No hours');
  });

  it('surfaces the redeploy degrade window instead of hiding it', () => {
    render(<MemoryRouter><GoLiveCard campaignStatus="ACTIVE" deploying readiness={readiness(deployedAndVerified, { ready: true })} /></MemoryRouter>);

    expect(screen.getByTestId('degrade-window')).toHaveTextContent('cannot book');
    expect(screen.getByLabelText('Receptionist service status')).toHaveAttribute('data-service-state', 'degraded');
  });

  it('marks activate done for a live campaign and shows the mock badge in rehearsal', () => {
    render(<MemoryRouter><GoLiveCard readiness={null} campaignStatus="ACTIVE" providerMode="mock" /></MemoryRouter>);

    const activate = within(screen.getByRole('list', { name: 'Go live steps' })).getAllByRole('listitem').find(node => node.getAttribute('data-step') === 'activate');
    expect(activate).toHaveAttribute('data-status', 'done');
    expect(screen.getByText('mock mode')).toBeInTheDocument();
  });

  it('states the two operational facts the runbook depends on', () => {
    render(<MemoryRouter><GoLiveCard readiness={null} campaignStatus="DRAFT" /></MemoryRouter>);

    expect(screen.getByText(/no-answer fallback to the front desk/)).toBeInTheDocument();
    expect(screen.getByText(/in-app only in the pilot/)).toBeInTheDocument();
  });
});

describe('ServiceStatusStrip — is the line answering right now', () => {
  it('says answering when every blocking check passes on an active campaign', () => {
    render(<MemoryRouter><ServiceStatusStrip status={serviceStatus({
      campaignStatus: 'ACTIVE',
      readiness: readiness([
        ...deployedAndVerified,
        { key: 'agent_linked', label: 'Agent linked', status: 'pass', code: null, detail: 'Riley.', fixHref: null },
        { key: 'number_bound', label: 'Bound', status: 'pass', code: null, detail: '+14155550142 answers with version 4.', fixHref: null },
      ], { ready: true }),
      verification: verification(),
    })} /></MemoryRouter>);

    expect(screen.getByLabelText('Receptionist service status')).toHaveAttribute('data-service-state', 'answering');
    expect(screen.getByText('Answering calls')).toBeInTheDocument();
  });

  it('says an ACTIVE campaign is not answering when the number is unbound, and offers the fix', () => {
    render(<MemoryRouter><ServiceStatusStrip status={serviceStatus({
      campaignStatus: 'ACTIVE',
      readiness: readiness([
        ...deployedAndVerified,
        { key: 'number_bound', label: 'Bound', status: 'fail', code: 'number_bound', title: 'The number is not bound to this deployment', detail: 'A caller would not reach this agent.', fixHref: '/receptionist-studio?tab=deploy' },
      ]),
    })} /></MemoryRouter>);

    const strip = screen.getByLabelText('Receptionist service status');
    expect(strip).toHaveAttribute('data-service-state', 'not_answering');
    expect(strip).toHaveTextContent('Active, but not answering');
    expect(strip).toHaveTextContent('A caller would not reach this agent.');
    expect(within(strip).getByRole('link')).toHaveAttribute('href', '/receptionist-studio?tab=deploy');
  });

  it('refuses to claim a state when readiness was never evaluated', () => {
    render(<MemoryRouter><ServiceStatusStrip status={serviceStatus({ campaignStatus: 'ACTIVE', readiness: null })} /></MemoryRouter>);

    expect(screen.getByLabelText('Receptionist service status')).toHaveAttribute('data-service-state', 'unknown');
    expect(screen.getByText('Service status unknown')).toBeInTheDocument();
  });

  it('warns while verification is about to lapse rather than after it has', () => {
    render(<MemoryRouter><ServiceStatusStrip status={serviceStatus({
      campaignStatus: 'ACTIVE',
      readiness: readiness([
        ...deployedAndVerified,
        { key: 'agent_linked', label: 'Agent linked', status: 'pass', code: null, detail: 'Riley.', fixHref: null },
        { key: 'number_bound', label: 'Bound', status: 'pass', code: null, detail: '+14155550142 answers with version 4.', fixHref: null },
      ], { ready: true }),
      verification: verification({ expiresInMs: 45 * 60 * 1000 }),
    })} /></MemoryRouter>);

    expect(screen.getByLabelText('Receptionist service status')).toHaveAttribute('data-service-state', 'degraded');
    expect(screen.getByText('Verification expires in 45m')).toBeInTheDocument();
  });
});
