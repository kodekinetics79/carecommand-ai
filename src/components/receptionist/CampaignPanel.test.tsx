import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { Campaign, Clinic } from '../../lib/receptionist';
import type { AgentRow, ConfirmationChannels, ReadinessResponse, RetellStatusResponse } from '../../lib/receptionistDeployment';
import { CampaignPanel } from './CampaignPanel';

/**
 * The panel used to offer a raw status select, which let a campaign be set
 * ACTIVE with no readiness at all, and confirmation toggles that promised SMS
 * from a workspace with no SMS provider. These tests hold the replacements.
 */
function clinic(overrides: Partial<Clinic> = {}): Clinic {
  return {
    id: 'clinic-1', name: 'Brightsmile Dental Group', logoUrl: null, phone: '+14155550142', website: null, addressLine: null,
    timezone: 'America/Los_Angeles', defaultLanguage: 'en-US', complianceDisclosure: 'Hi, this is Riley.',
    humanFallbackNumber: '+14155550100', doNotContactPolicy: 'Stop on request.', workingHours: null, active: true, locations: [],
    ...overrides,
  };
}

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1', clinicId: 'clinic-1', agentId: null, name: 'Spring Cleaning Reactivation', campaignType: 'Reactivation',
    status: 'DRAFT', offerTitle: 'Cleaning', offerDescription: 'A cleaning', offerScript: 'Book a cleaning',
    appointmentType: 'Hygiene', bookingRules: null, eligibleLocationIds: [], smsConfirmation: false, emailConfirmation: false,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'agent-1', clinicId: 'clinic-1', name: 'Riley', voice: '11labs-Anna', tone: 'Warm and professional', language: 'en-US',
    persona: null, greetingOverride: null, active: true, providerAgentId: 'agent_7f21', providerVersionTag: 'prod',
    providerVersion: 4, providerStatus: 'VERIFIED', providerPublished: true, providerVoiceId: '11labs-Anna', providerLanguage: 'en-US',
    providerVerifiedAt: '2026-08-29T17:00:00.000Z', providerVerificationExpiresAt: '2026-08-30T17:00:00.000Z',
    providerLastAttemptAt: '2026-08-29T17:00:00.000Z', providerLastAttemptStatus: 'SUCCEEDED', providerLastErrorCode: null,
    ...overrides,
  };
}

const readiness: ReadinessResponse = {
  campaignId: 'camp-1', status: 'DRAFT', ready: false,
  checks: [{ key: 'agent_linked', label: 'Agent linked', status: 'fail', code: 'agent_unlinked', detail: 'No agent is linked to this campaign.', fixHref: null }],
  actions: { activate: { allowed: false, reasons: ['campaign_not_ready'] }, pause: { allowed: false, reasons: [] }, archive: { allowed: true, reasons: [] } },
  evaluatedAt: '2026-08-29T18:00:00.000Z',
};

const providerStatus: RetellStatusResponse = {
  providerConfigured: true, providerMode: 'live', agentReady: true,
  agentScope: { clinicId: 'clinic-1', campaignId: 'camp-1', agentId: 'agent-1', agentName: 'Riley' },
  verification: { status: 'VERIFIED', expiresAt: null, expiresInMs: 19 * 60 * 60 * 1000, autoRenew: { enabled: true, lastSystemAttemptAt: new Date().toISOString() } },
  blockers: [], attendedUat: null, adhocTestCallsAllowed: false,
};

const channels: ConfirmationChannels = {
  sms: { status: 'unconfigured', detail: 'No SMS provider is configured for this workspace.' },
  email: { status: 'live', detail: 'Sending through the configured email provider.' },
};

interface Stubs {
  agents?: () => Promise<unknown>;
  readiness?: () => Promise<unknown>;
  channels?: () => Promise<unknown>;
  patch?: (body: Record<string, unknown>) => Promise<unknown>;
}

let respond: (path: string, init?: RequestInit) => Promise<unknown>;

function routes(stubs: Stubs = {}) {
  return (path: string, init?: RequestInit): Promise<unknown> => {
    if (path.startsWith('/v1/receptionist/agents?')) return (stubs.agents ?? (() => Promise.resolve([])))();
    if (path.endsWith('/readiness')) return (stubs.readiness ?? (() => Promise.resolve(readiness)))();
    if (path.endsWith('/confirmation-channels')) return (stubs.channels ?? (() => Promise.resolve(channels)))();
    if (path.startsWith('/v1/receptionist/retell-status')) return Promise.resolve(providerStatus);
    if (path === '/v1/receptionist/catalog') return Promise.resolve({ voices: [], languages: [], tones: [], campaignTypes: [], providerMode: 'live' });
    if (path === '/v1/receptionist/campaigns/camp-1' && init?.method === 'PATCH') {
      return (stubs.patch ?? (() => Promise.resolve(campaign())))(JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
  };
}

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

function renderPanel(row: Campaign = campaign()) {
  return render(<MemoryRouter><CampaignPanel clinic={clinic()} campaign={row} onChanged={async () => {}} /></MemoryRouter>);
}

describe('CampaignPanel', () => {
  it('shows the explicit no-agent-linked state instead of an empty select', async () => {
    respond = routes();
    renderPanel();

    expect(await screen.findByTestId('no-agent-linked')).toBeInTheDocument();
    expect(screen.getByText('No agent linked')).toBeInTheDocument();
    expect(screen.getByText(/cannot answer or place calls/)).toBeInTheDocument();
  });

  it('disables a confirmation toggle whose channel cannot deliver, and says why', async () => {
    respond = routes();
    renderPanel();

    await waitFor(() => expect(screen.getByText('No SMS provider is configured for this workspace.')).toBeInTheDocument());
    expect(screen.getByText('unconfigured')).toBeInTheDocument();
    const sms = screen.getByRole('button', { name: /SMS confirmation/ }).parentElement;
    expect(sms).toHaveAttribute('aria-disabled', 'true');

    // Clicking a disabled channel must not turn it on.
    fireEvent.click(screen.getByRole('button', { name: /SMS confirmation/ }));
    expect(screen.queryByRole('button', { name: /Save changes/ })).toBeDisabled();

    // The live channel stays usable.
    expect(screen.getByText('Sending through the configured email provider.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Email confirmation/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/ })).toBeEnabled());
  });

  it('has no raw status select — transitions go through the readiness gate', async () => {
    respond = routes();
    renderPanel();

    await screen.findByTestId('no-agent-linked');
    expect(screen.queryByRole('option', { name: 'ARCHIVED' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Activate/ })).toBeDisabled();
    expect(screen.getByText('No agent is linked to this campaign.')).toBeInTheDocument();
  });

  it('never sends status on a save, so a campaign cannot be activated behind the gate', async () => {
    let body: Record<string, unknown> | null = null;
    respond = routes({ patch: received => { body = received; return Promise.resolve(campaign({ name: 'Autumn recall' })); } });
    renderPanel();

    await screen.findByTestId('no-agent-linked');
    fireEvent.change(screen.getByDisplayValue('Spring Cleaning Reactivation'), { target: { value: 'Autumn recall' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!).toMatchObject({ name: 'Autumn recall' });
    expect(body!).not.toHaveProperty('status');
  });

  it('surfaces a 409 on save with the server code instead of silently re-enabling', async () => {
    respond = routes({ patch: () => Promise.reject(new ApiError(409, 'Campaign configuration is not deployable: intake_schema_unattested.', 'INTERNAL_SERVER_ERROR')) });
    renderPanel();

    await screen.findByTestId('no-agent-linked');
    fireEvent.change(screen.getByDisplayValue('Spring Cleaning Reactivation'), { target: { value: 'Autumn recall' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(node => node.textContent?.includes('Campaign configuration is not deployable: intake_schema_unattested.'))).toBe(true);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('renders the agent editor once an agent is linked, and leaves the go-live rail to the Studio header', async () => {
    respond = routes({ agents: () => Promise.resolve([agent()]) });
    renderPanel(campaign({ agentId: 'agent-1' }));

    expect(await screen.findByDisplayValue('Riley')).toBeInTheDocument();
    expect(screen.getByText('Verified · expires in 19h — auto-renews')).toBeInTheDocument();
    // SF-4 promoted the ordered path into the persistent Studio rail, so it
    // exists once per screen rather than once per panel.
    expect(screen.queryByRole('list', { name: 'Go live steps' })).not.toBeInTheDocument();
  });

  // The agent editor has its own SaveBar; the campaign's is the last one.
  const campaignSaveButton = () => screen.getAllByRole('button', { name: /Save changes/ }).at(-1)!;

  it('does not report unsaved changes just because the campaign was activated elsewhere', async () => {
    respond = routes({ agents: () => Promise.resolve([agent()]) });
    const { rerender } = renderPanel(campaign({ agentId: 'agent-1' }));
    await screen.findByDisplayValue('Riley');
    expect(campaignSaveButton()).toBeDisabled();

    // The activation transition changes only `status`, which this panel does
    // not edit. It used to flip the panel to dirty, and the next Save re-posted
    // a draft assembled before the transition.
    rerender(<MemoryRouter><CampaignPanel clinic={clinic()} campaign={campaign({ agentId: 'agent-1', status: 'ACTIVE' })} onChanged={() => Promise.resolve()} /></MemoryRouter>);
    expect(campaignSaveButton()).toBeDisabled();
  });

  it('keeps a half-typed edit when the campaign row reloads unchanged', async () => {
    respond = routes({ agents: () => Promise.resolve([agent()]) });
    const { rerender } = renderPanel(campaign({ agentId: 'agent-1' }));
    await screen.findByDisplayValue('Riley');

    fireEvent.change(screen.getByDisplayValue('Spring Cleaning Reactivation'), { target: { value: 'Autumn recall' } });
    // A sibling reload hands back an equal-by-value row with a new identity.
    rerender(<MemoryRouter><CampaignPanel clinic={clinic()} campaign={campaign({ agentId: 'agent-1' })} onChanged={() => Promise.resolve()} /></MemoryRouter>);

    expect(screen.getByDisplayValue('Autumn recall')).toBeInTheDocument();
  });

  it('names a failed readiness load rather than showing a campaign with no checks', async () => {
    respond = routes({ readiness: () => Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR')) });
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Activation readiness could not be loaded.');
    expect(screen.getByRole('button', { name: /Activate/ })).toBeDisabled();
  });
});
