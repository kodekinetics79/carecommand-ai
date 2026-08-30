import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { Campaign } from '../../lib/receptionist';
import type { ReadinessResponse } from '../../lib/receptionistDeployment';
import { ReadinessChecklist } from './ReadinessChecklist';
import { CampaignActions } from './CampaignActions';

/**
 * Readiness is the only activation gate. These tests hold two things: the
 * checklist shows the server's evaluation verbatim (a check the server has
 * not evaluated is "pending", never a silent pass), and a refused activation
 * shows the server's failing rows instead of a generic error.
 */
function readiness(overrides: Partial<ReadinessResponse> = {}): ReadinessResponse {
  return {
    campaignId: 'camp-1',
    status: 'DRAFT',
    ready: false,
    checks: [
      { key: 'agent_verified', label: 'Agent verified', status: 'pass', code: null, detail: 'Verified 2 hours ago.', fixHref: null },
      { key: 'services_bookable', label: 'A service is bookable by voice', status: 'fail', code: 'no_provider_availability', detail: 'No provider has availability in a mapped branch.', fixHref: '/scheduling?tab=availability' },
      { key: 'locale_pack_approved', label: 'Locale pack approved', status: 'pending', code: null, detail: 'Not evaluated: the locale pack module is not available.', fixHref: null },
      { key: 'disclosure_composed', label: 'Disclosure composed', status: 'warn', code: null, detail: 'Using the baseline disclosure only.', fixHref: null },
    ],
    actions: { activate: { allowed: false, reasons: ['campaign_not_ready'] }, pause: { allowed: false, reasons: [] }, archive: { allowed: true, reasons: [] } },
    evaluatedAt: '2026-08-29T18:00:00.000Z',
    ...overrides,
  };
}

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1', clinicId: 'clinic-1', agentId: 'agent-1', name: 'Spring Cleaning Reactivation', campaignType: 'Reactivation',
    status: 'DRAFT', offerTitle: 'Cleaning', offerDescription: 'A cleaning', offerScript: 'Book a cleaning',
    appointmentType: 'Hygiene', bookingRules: null, eligibleLocationIds: [], smsConfirmation: false, emailConfirmation: false,
    ...overrides,
  };
}

let respond: (path: string, init?: RequestInit) => Promise<unknown>;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
  respond = path => Promise.reject(new Error(`Unexpected request in test: ${path}`));
});

describe('ReadinessChecklist — the server evaluation, rendered as it is', () => {
  it('renders every check with its status, detail and fix link', () => {
    render(<MemoryRouter><ReadinessChecklist readiness={readiness()} /></MemoryRouter>);

    expect(screen.getByText('A service is bookable by voice')).toBeInTheDocument();
    expect(screen.getByText('No provider has availability in a mapped branch.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix A service is bookable by voice' })).toHaveAttribute('href', '/scheduling?tab=availability');
    // "pending" is shown as not evaluated, never as a pass.
    const pending = screen.getByText('Locale pack approved').closest('li');
    expect(pending).toHaveAttribute('data-status', 'pending');
    expect(screen.getByRole('status')).toHaveTextContent('2 items to fix');
  });

  it('says ready, and counts warnings separately, once every blocking check passes', () => {
    render(<MemoryRouter><ReadinessChecklist readiness={readiness({
      ready: true,
      checks: [
        { key: 'agent_verified', label: 'Agent verified', status: 'pass', code: null, detail: 'Verified.', fixHref: null },
        { key: 'disclosure_composed', label: 'Disclosure composed', status: 'warn', code: null, detail: 'Using the baseline disclosure only.', fixHref: null },
      ],
    })} /></MemoryRouter>);

    expect(screen.getByRole('status')).toHaveTextContent('Ready to activate · 1 warning');
  });
});

describe('CampaignActions — activation is gated, and a refusal is shown', () => {
  it('disables Activate until the server says the campaign is ready', () => {
    render(<MemoryRouter><CampaignActions campaign={campaign()} readiness={readiness()} onChanged={() => {}} /></MemoryRouter>);

    const activate = screen.getByRole('button', { name: /Activate/ });
    expect(activate).toBeDisabled();
    expect(activate).toHaveAttribute('title', 'Fix every failing readiness check first.');
  });

  it('activates when ready and tells the panel to refresh', async () => {
    const onChanged = vi.fn();
    respond = (path, init) => {
      if (path === '/v1/receptionist/campaigns/camp-1/activate' && init?.method === 'POST') return Promise.resolve(campaign({ status: 'ACTIVE' }));
      return Promise.reject(new Error(`Unexpected request in test: ${path}`));
    };
    render(<MemoryRouter><CampaignActions
      campaign={campaign()}
      readiness={readiness({ ready: true, actions: { activate: { allowed: true, reasons: [] }, pause: { allowed: false, reasons: [] }, archive: { allowed: true, reasons: [] } } })}
      onChanged={onChanged}
    /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /Activate/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Campaign activated')).toBeInTheDocument();
  });

  it('renders the failing checks a 409 carries instead of a generic error', async () => {
    respond = () => Promise.reject(new ApiError(409, 'Campaign configuration is not deployable: campaign_not_ready.', 'campaign_not_ready', {
      code: 'campaign_not_ready',
      message: 'Campaign configuration is not deployable: campaign_not_ready.',
      reasons: [
        // `number_bound` is the key the server emits; the fixture used to say
        // `phone_number_bound`, which nothing on the server has ever sent.
        { key: 'number_bound', label: 'The phone number answers with this agent', status: 'fail', code: 'number_bound', title: 'The number is not bound to this deployment', detail: 'The Retell number does not point at this agent version.', fixHref: '/receptionist-studio?tab=deploy' },
      ],
    }));
    render(<MemoryRouter><CampaignActions
      campaign={campaign()}
      readiness={readiness({ ready: true, actions: { activate: { allowed: true, reasons: [] }, pause: { allowed: false, reasons: [] }, archive: { allowed: true, reasons: [] } } })}
      onChanged={() => {}}
    /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /Activate/ }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(node => node.textContent?.includes('Campaign configuration is not deployable: campaign_not_ready.'))).toBe(true);
    expect(screen.getByText('The phone number answers with this agent')).toBeInTheDocument();
    expect(screen.getByText('The Retell number does not point at this agent version.')).toBeInTheDocument();
    // E7's sibling: the remediation title travels with the row and is shown.
    expect(screen.getByText('The number is not bound to this deployment')).toBeInTheDocument();
  });

  it('confirms before pausing an active campaign', async () => {
    let paused = false;
    respond = (path, init) => {
      if (path === '/v1/receptionist/campaigns/camp-1/pause' && init?.method === 'POST') { paused = true; return Promise.resolve(campaign({ status: 'PAUSED' })); }
      return Promise.reject(new Error(`Unexpected request in test: ${path}`));
    };
    render(<MemoryRouter><CampaignActions
      campaign={campaign({ status: 'ACTIVE' })}
      readiness={readiness({ status: 'ACTIVE', actions: { activate: { allowed: false, reasons: [] }, pause: { allowed: true, reasons: [] }, archive: { allowed: false, reasons: [] } } })}
      onChanged={() => {}}
    /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Pause this campaign?');
    expect(paused).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Pause campaign' }));
    await waitFor(() => expect(paused).toBe(true));
  });

  it('refuses to archive an active campaign and says to pause it first', () => {
    render(<MemoryRouter><CampaignActions
      campaign={campaign({ status: 'ACTIVE' })}
      readiness={readiness({ status: 'ACTIVE' })}
      onChanged={() => {}}
    /></MemoryRouter>);

    const archive = screen.getByRole('button', { name: /Archive/ });
    expect(archive).toBeDisabled();
    expect(archive).toHaveAttribute('title', 'Pause the campaign before archiving it.');
  });
});
