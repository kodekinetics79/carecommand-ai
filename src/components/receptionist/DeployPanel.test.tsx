import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { Deployment, DeploymentDiff, RetellConfigExport, RetellStatusResponse } from '../../lib/receptionistDeployment';
import { DeployPanel } from './DeployPanel';

/**
 * Deploy publishes; verification is a second request. These tests hold that
 * the panel never claims a verified deployment off the deploy response, that
 * it shows the server's own failure words, and that the manual (BYO) path is
 * always available — an operator must be able to finish in the console.
 */
function status(overrides: Partial<RetellStatusResponse> = {}): RetellStatusResponse {
  return {
    providerConfigured: true,
    providerMode: 'live',
    agentReady: true,
    agentScope: { clinicId: 'clinic-1', campaignId: 'camp-1', agentId: 'agent-1', agentName: 'Riley' },
    verification: { status: 'VERIFIED', expiresAt: null, expiresInMs: 19 * 60 * 60 * 1000, autoRenew: { enabled: true, lastSystemAttemptAt: new Date().toISOString() } },
    blockers: [],
    attendedUat: null,
    adhocTestCallsAllowed: false,
    ...overrides,
  };
}

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 'dep-1', campaignId: 'camp-1', agentId: 'agent-1', status: 'VERIFIED', mock: false,
    providerAgentId: 'agen…7f21', providerAgentVersion: 4, providerLlmVersion: 2,
    promptHash: 'abc123def456789', toolFingerprint: 'tools-1', intakeFingerprint: 'intake-1',
    voiceId: '11labs-Anna', language: 'en-US', steps: [], providerErrorCode: null,
    startedAt: '2026-08-29T17:00:00.000Z', publishedAt: '2026-08-29T17:00:20.000Z', verifiedAt: '2026-08-29T17:00:30.000Z',
    createdAt: '2026-08-29T17:00:00.000Z',
    ...overrides,
  };
}

function diff(overrides: Partial<DeploymentDiff> = {}): DeploymentDiff {
  const row = deployment();
  return {
    deployment: {
      id: row.id, status: row.status, mock: row.mock, verifiedAt: row.verifiedAt, publishedAt: row.publishedAt,
      providerAgentVersion: row.providerAgentVersion, promptHash: row.promptHash, toolFingerprint: row.toolFingerprint,
      voiceId: row.voiceId, language: row.language, providerErrorCode: null,
    },
    draft: { promptHash: row.promptHash, toolFingerprint: row.toolFingerprint, intakeFingerprint: row.intakeFingerprint, voiceId: row.voiceId, language: row.language, webhookUrl: 'https://api.example.com/v1/receptionist/webhooks/retell' },
    changed: [],
    toolsDiff: { added: [], removed: [], changed: [] },
    ...overrides,
  };
}

function config(): RetellConfigExport {
  return {
    systemPrompt: '# Role\nYou are Riley.',
    voiceId: '11labs-Anna',
    language: 'en-US',
    beginMessage: 'Hi, this is Riley, an AI assistant for Brightsmile Dental.',
    dynamicVariables: { is_open_now: 'true' },
    webhookUrl: 'https://api.example.com/v1/receptionist/webhooks/retell',
    bookingFunction: { name: 'book_appointment' },
    callOutcomeFields: [{ name: 'outcome', type: 'enum', description: 'Call outcome' }],
    tools: [
      { name: 'book_appointment', url: 'https://api.example.com/v1/receptionist/webhooks/retell/fn?clinicId=clinic-1', parameters: { required: ['startsAt'] } },
      { name: 'take_message', url: 'https://api.example.com/v1/receptionist/webhooks/retell/fn?clinicId=clinic-1' },
    ],
  };
}

let respond: (path: string, init?: RequestInit) => Promise<unknown>;

function routes(overrides: Partial<Record<'status' | 'diff' | 'latest' | 'deploy' | 'verify', () => Promise<unknown>>> = {}) {
  return (path: string, init?: RequestInit): Promise<unknown> => {
    if (path.startsWith('/v1/receptionist/retell-status')) return (overrides.status ?? (() => Promise.resolve(status())))();
    if (path.endsWith('/deployment-diff')) return (overrides.diff ?? (() => Promise.resolve(diff())))();
    if (path.endsWith('/deployments/latest')) return (overrides.latest ?? (() => Promise.resolve(deployment())))();
    if (path.endsWith('/deploy') && init?.method === 'POST') return (overrides.deploy ?? (() => Promise.reject(new Error('deploy not stubbed'))))();
    if (path.endsWith('/verify-provider') && init?.method === 'POST') return (overrides.verify ?? (() => Promise.resolve({ id: 'agent-1' })))();
    return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
  };
}

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

function renderPanel(cfg: RetellConfigExport | null = config()) {
  return render(<MemoryRouter><DeployPanel campaignId="camp-1" config={cfg} pollIntervalMs={1} pollMaxAttempts={2} /></MemoryRouter>);
}

describe('DeployPanel', () => {
  it('lists every manual setting and every tool so the BYO path stays possible', async () => {
    respond = routes();
    renderPanel();

    expect(await screen.findByTestId('byo-checklist')).toBeInTheDocument();
    for (const key of ['agent_language', 'agent_voice', 'begin_message', 'response_engine', 'webhook_url', 'webhook_events', 'data_storage_setting', 'publish']) {
      expect(document.querySelector(`[data-checklist-key="${key}"]`)).not.toBeNull();
    }
    // The tag is not assigned by us any more, so it is not a manual step either.
    expect(document.querySelector('[data-checklist-key="assign_tag"]')).toBeNull();
    expect(document.querySelector('[data-tool="book_appointment"]')).not.toBeNull();
    expect(document.querySelector('[data-tool="take_message"]')).not.toBeNull();
  });

  it('shows the deployed version and expiry when the deployment matches the draft', async () => {
    respond = routes();
    renderPanel();

    expect(await screen.findByText('Version 4')).toBeInTheDocument();
    expect(screen.getByText('VERIFIED')).toBeInTheDocument();
    expect(screen.getByText(/expires in 19h — auto-renews/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Redeploy/ })).toBeEnabled();
  });

  it('shows changed-setting chips and a Deploy changes button when the draft moved on', async () => {
    respond = routes({ diff: () => Promise.resolve(diff({ changed: ['prompt', 'voice'], toolsDiff: { added: ['check_availability'], removed: [], changed: [] } })) });
    renderPanel();

    expect(await screen.findByTestId('deploy-changes')).toBeInTheDocument();
    expect(screen.getByText('Prompt')).toBeInTheDocument();
    expect(screen.getByText('Voice')).toBeInTheDocument();
    expect(screen.getByText(/added check_availability/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Deploy changes/ })).toBeInTheDocument();
  });

  it('walks publish → verify → confirm and only then reports the settled row', async () => {
    let releaseDeploy: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { releaseDeploy = () => resolve(); });
    const calls: string[] = [];
    respond = (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return routes({
        diff: () => Promise.resolve(diff({ deployment: null })),
        deploy: async () => {
          await gate;
          return { deployment: deployment({ status: 'PUBLISHED', verifiedAt: null }), agent: { id: 'agent-1' }, verification: { status: 'pending' } };
        },
      })(path, init);
    };
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Deploy to Retell/ }));
    await waitFor(() => expect(document.querySelector('[data-step="publish"][data-step-state="running"]')).not.toBeNull());
    releaseDeploy!();

    await waitFor(() => expect(calls.some(call => call.includes('verify-provider'))).toBe(true));
    await waitFor(() => expect(calls.some(call => call.includes('deployments/latest'))).toBe(true));
    // Verification is a second request; the deploy response alone never claims it.
    expect(calls.filter(call => call.startsWith('POST')).map(call => call.split(' ')[1]))
      .toEqual(['/v1/receptionist/campaigns/camp-1/deploy', '/v1/receptionist/agents/agent-1/verify-provider']);
  });

  it('shows the server code and message when a deploy is refused, and the cooldown when rate limited', async () => {
    respond = routes({
      diff: () => Promise.resolve(diff({ deployment: null })),
      deploy: () => Promise.reject(new ApiError(429, 'Another deployment started less than a minute ago.', 'cooldown', { code: 'cooldown', message: 'Another deployment started less than a minute ago.', retryAfterSeconds: 45 })),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Deploy to Retell/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Another deployment started less than a minute ago.');
    expect(alert).toHaveTextContent('code: cooldown');
    expect(await screen.findByText(/Retry available in 4[0-9]s/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry in 4[0-9]s/ })).toBeDisabled();
  });

  it('names the campaigns that block a deploy and links to each', async () => {
    respond = routes({
      deploy: () => Promise.reject(new ApiError(409, 'Another active campaign uses this agent.', 'provider_deployment_drift', {
        code: 'provider_deployment_drift',
        message: 'Another active campaign uses this agent.',
        blockedBy: [{ campaignId: 'camp-9', name: 'Recall wave' }],
      })),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Redeploy/ }));

    expect(await screen.findByText('Another active campaign uses this agent.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Recall wave' })).toHaveAttribute('href', '/receptionist-studio?tab=campaign&campaign=camp-9');
  });

  it('reports a published-but-unverified deployment honestly and offers Verify again', async () => {
    respond = routes({
      diff: () => Promise.resolve(diff({ deployment: null })),
      deploy: () => Promise.resolve({
        deployment: deployment({ status: 'PUBLISHED', verifiedAt: null }),
        agent: { id: 'agent-1' },
        verification: { status: 'failed', code: 'prompt_drift', message: 'The published prompt does not match this configuration.' },
      }),
      latest: () => Promise.resolve(deployment({ status: 'PUBLISHED', verifiedAt: null })),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Deploy to Retell/ }));

    expect(await screen.findByText(/Published, but verification failed: The published prompt does not match this configuration./)).toBeInTheDocument();
    expect(screen.getByText('code: prompt_drift')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Verify again/ })).toBeInTheDocument();
  });

  it('refuses to offer a deploy with no agent linked and points at the Agent tab', async () => {
    respond = routes({
      status: () => Promise.resolve(status({
        agentReady: false,
        agentScope: { clinicId: 'clinic-1', campaignId: 'camp-1', agentId: null, agentName: null },
        blockers: [{ code: 'agent_unlinked', severity: 'blocking', title: 'No agent linked', action: 'Create an agent for this campaign.', fixHref: '/receptionist-studio?tab=campaign', scope: 'campaign' }],
      })),
      diff: () => Promise.resolve(diff({ deployment: null })),
    });
    renderPanel();

    expect(await screen.findByText('No agent linked to this campaign.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Deploy to Retell/ })).toBeDisabled();
  });

  it('names a failed provider-status load instead of rendering an empty ready state', async () => {
    respond = routes({ status: () => Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR')) });
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Provider status could not be loaded.');
    expect(alert).toHaveTextContent('An unexpected error occurred');
  });
});
