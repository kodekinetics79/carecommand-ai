import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { ReadinessResponse } from '../../lib/receptionistDeployment';
import { GoLiveCard } from './GoLiveCard';

/**
 * The go-live path is ordered and each step is a readiness row: nothing is
 * marked done because the UI assumes it, and a step the server has not
 * evaluated stays pending.
 */
function readiness(checks: ReadinessResponse['checks']): ReadinessResponse {
  return {
    campaignId: 'camp-1', status: 'DRAFT', ready: false, checks,
    actions: { activate: { allowed: false, reasons: [] }, pause: { allowed: false, reasons: [] }, archive: { allowed: true, reasons: [] } },
    evaluatedAt: '2026-08-29T18:00:00.000Z',
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
      { key: 'deployment_current', label: 'Deployment current', status: 'pass', code: null, detail: 'Version 4 is deployed and matches the draft.', fixHref: null },
      { key: 'agent_verified', label: 'Agent verified', status: 'pass', code: null, detail: 'Verified.', fixHref: null },
      { key: 'phone_number_bound', label: 'Number bound', status: 'fail', code: 'number_unbound', detail: 'The Retell number does not point at this agent version.', fixHref: '/receptionist-studio?tab=retell' },
    ])} /></MemoryRouter>);

    const list = screen.getByRole('list', { name: 'Go live steps' });
    const byStep = (key: string) => within(list).getAllByRole('listitem').find(node => node.getAttribute('data-step') === key);
    expect(byStep('deploy')).toHaveAttribute('data-status', 'done');
    expect(byStep('forward')).toHaveAttribute('data-status', 'todo');
    // The server never evaluated the test call, so the card does not claim it happened.
    expect(byStep('test_call')).toHaveAttribute('data-status', 'pending');
    expect(screen.getByText('The Retell number does not point at this agent version.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix Forward the public number to the DID' })).toBeInTheDocument();
    expect(screen.getByText('2/5 steps')).toBeInTheDocument();
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
