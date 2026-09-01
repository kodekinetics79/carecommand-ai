import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { Deployment, DeploymentDiff, VoiceLineConfigurationExport, VoiceLineStatusResponse } from '../../lib/receptionistDeployment';
import { DeployPanel } from './DeployPanel';

/**
 * Deploy publishes; verification is a second request. These tests hold that
 * the panel never claims a verified deployment off the deploy response, that
 * it shows the server's own failure words, and that the manual (BYO) path is
 * always available — an operator must be able to finish in the console.
 */
function status(overrides: Partial<VoiceLineStatusResponse> = {}): VoiceLineStatusResponse {
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

/**
 * Exactly what `deploymentProjection` sends: masked provider id, the number
 * binding, and no `campaignId` / `agentId` / `createdAt` — the fields the
 * client type used to invent. `GET /deployments/latest` wraps this in
 * `{ deployment }`, which the client read as the row itself: the settle poll
 * compared `undefined` to 'VERIFIED' and always spent its whole budget, and
 * the verification-failed panel threw on `latest.status.toLowerCase()`.
 */
function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 'dep-1', status: 'VERIFIED', mock: false,
    configurationReference: 'LINE-00DEP1',
    voiceId: 'voice-anna', language: 'en-US', steps: [], providerErrorCode: null,
    numberBound: true, boundPhoneNumberMasked: '+1 ••• ••• 0142', deployedBySource: 'USER',
    startedAt: '2026-08-29T17:00:00.000Z', publishedAt: '2026-08-29T17:00:20.000Z', verifiedAt: '2026-08-29T17:00:30.000Z',
    ...overrides,
  };
}

/** The envelope the route actually answers with. */
const latestBody = (row: Deployment | null = deployment()) => ({ deployment: row });

/**
 * What `GET /deployment-diff` sends. There is no `toolsDiff` in it — the panel
 * read `.added.length` off that missing object and threw the moment a draft
 * went stale, which is precisely when an operator needs this screen.
 */
function diff(overrides: Partial<DeploymentDiff> = {}): DeploymentDiff {
  const row = deployment();
  return {
    deployment: {
      id: row.id, status: row.status, verifiedAt: row.verifiedAt,
      configurationReference: row.configurationReference,
      voiceId: row.voiceId, language: row.language,
    },
    draft: { voiceId: row.voiceId, language: row.language, toolNames: ['book_appointment', 'take_message'] },
    changed: [],
    toolsDiff: { added: [], removed: [], changed: [] },
    ...overrides,
  };
}

function config(): VoiceLineConfigurationExport {
  return {
    systemPrompt: '# Role\nYou are Riley.',
    voiceId: 'voice-anna',
    language: 'en-US',
    beginMessage: 'Hi, this is Riley, an AI assistant for Brightsmile Dental.',
    // The mechanics below arrive ONLY for a caller holding
    // `platform:voice-line-mechanics:read`. This fixture keeps them so the
    // support-only checklist stays under test; the tenant fixture (no
    // `webhookUrl`) is asserted separately, and the panel renders nothing.
    dynamicVariables: { is_open_now: 'true' },
    webhookUrl: 'https://api.example.com/v1/receptionist/webhooks/voice',
    bookingFunction: { name: 'book_appointment' },
    callOutcomeFields: [{ name: 'outcome', type: 'enum', description: 'Call outcome' }],
    tools: [
      { name: 'book_appointment', url: 'https://api.example.com/v1/receptionist/webhooks/voice/fn?clinicId=clinic-1', parameters: { required: ['startsAt'] } },
      { name: 'take_message', url: 'https://api.example.com/v1/receptionist/webhooks/voice/fn?clinicId=clinic-1' },
    ],
  };
}

let respond: (path: string, init?: RequestInit) => Promise<unknown>;

function routes(overrides: Partial<Record<'status' | 'diff' | 'latest' | 'deploy' | 'verify', () => Promise<unknown>>> = {}) {
  return (path: string, init?: RequestInit): Promise<unknown> => {
    if (path.startsWith('/v1/receptionist/voice-line-status')) return (overrides.status ?? (() => Promise.resolve(status())))();
    if (path.endsWith('/deployment-diff')) return (overrides.diff ?? (() => Promise.resolve(diff())))();
    if (path.endsWith('/deployments/latest')) return (overrides.latest ?? (() => Promise.resolve(latestBody())))();
    if (path.endsWith('/deploy') && init?.method === 'POST') return (overrides.deploy ?? (() => Promise.reject(new Error('deploy not stubbed'))))();
    if (path.endsWith('/verify-provider') && init?.method === 'POST') return (overrides.verify ?? (() => Promise.resolve({ id: 'agent-1' })))();
    return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
  };
}

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

function renderPanel(cfg: VoiceLineConfigurationExport | null = config()) {
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

    expect(await screen.findByText('LINE-00DEP1')).toBeInTheDocument();
    expect(screen.getByText('VERIFIED')).toBeInTheDocument();
    expect(screen.getByText(/expires in 19h — auto-renews/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Publish to the line again/ })).toBeEnabled();
  });

  it('offers a direct line-check recovery action when verification has expired', async () => {
    respond = routes({
      status: () => Promise.resolve(status({
        verification: { status: 'VERIFIED', expiresAt: '2026-08-31T17:00:00.000Z', expiresInMs: -1, autoRenew: { enabled: true, lastSystemAttemptAt: null } },
        blockers: [{ code: 'agent_verification_stale', severity: 'blocking', title: 'The last line check has expired', action: 'Run the line check again.', fixHref: '/receptionist-studio?tab=deploy', scope: 'agent' }],
      })),
    });
    renderPanel();

    expect(await screen.findByRole('button', { name: /Run the line check/ })).toBeEnabled();
  });

  it('shows changed-setting chips and a Deploy changes button when the draft moved on', async () => {
    // No `toolsDiff` — the route does not send one. Rendering the stale state
    // used to throw here and take the whole tab down with it.
    const { deployment: row, draft, changed } = diff({ changed: ['prompt', 'voice'] });
    respond = routes({ diff: () => Promise.resolve({ deployment: row, draft, changed, placeholders: [] }) });
    renderPanel();

    expect(await screen.findByTestId('deploy-changes')).toBeInTheDocument();
    expect(screen.getByText('Prompt')).toBeInTheDocument();
    expect(screen.getByText('Voice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Publish changes/ })).toBeInTheDocument();
  });

  it('warns before redeploying a campaign that is answering calls right now', async () => {
    respond = routes();
    render(<MemoryRouter><DeployPanel campaignId="camp-1" config={config()} campaignStatus="ACTIVE" pollIntervalMs={1} pollMaxAttempts={2} /></MemoryRouter>);

    const warning = await screen.findByTestId('redeploy-degrade-warning');
    expect(warning).toHaveTextContent('This campaign is answering calls now.');
    expect(warning).toHaveTextContent('cannot book');
  });

  it('does not warn about a degrade window on a campaign that is not live', async () => {
    respond = routes();
    render(<MemoryRouter><DeployPanel campaignId="camp-1" config={config()} campaignStatus="DRAFT" pollIntervalMs={1} pollMaxAttempts={2} /></MemoryRouter>);

    await screen.findByText('LINE-00DEP1');
    expect(screen.queryByTestId('redeploy-degrade-warning')).not.toBeInTheDocument();
  });

  it('walks publish → verify → confirm and only then reports the settled row', async () => {
    let releaseDeploy: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { releaseDeploy = () => resolve(); });
    const calls: string[] = [];
    respond = (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return routes({
        diff: () => Promise.resolve(diff({ deployment: null })),
        // The route sends no `agent`: the panel must verify the agent the
        // provider-status read already resolved.
        deploy: async () => {
          await gate;
          return { deployment: deployment({ status: 'PUBLISHED', verifiedAt: null }), verification: { status: 'pending' }, message: 'Published to the line.' };
        },
      })(path, init);
    };
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Publish to the line/ }));
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

    fireEvent.click(await screen.findByRole('button', { name: /Publish to the line/ }));

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

    fireEvent.click(await screen.findByRole('button', { name: /Publish to the line again/ }));

    expect(await screen.findByText('Another active campaign uses this agent.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Recall wave' })).toHaveAttribute('href', '/receptionist-studio?tab=campaign&campaign=camp-9');
  });

  it('reports a published-but-unverified deployment honestly and offers Verify again', async () => {
    respond = routes({
      diff: () => Promise.resolve(diff({ deployment: null })),
      deploy: () => Promise.resolve({
        deployment: deployment({ status: 'PUBLISHED', verifiedAt: null }),
        verification: { status: 'failed', code: 'prompt_drift', message: 'The published prompt does not match this configuration.' },
      }),
      latest: () => Promise.resolve(latestBody(deployment({ status: 'PUBLISHED', verifiedAt: null }))),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Publish to the line/ }));

    expect(await screen.findByText(/Published, but the line check did not pass: The published prompt does not match this configuration./)).toBeInTheDocument();
    expect(screen.getByText('code: prompt_drift')).toBeInTheDocument();
    // Reading the `{ deployment }` envelope as the row made this line throw.
    expect(await screen.findByText(/Deployment published · LINE-00DEP1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run the line check/ })).toBeInTheDocument();
  });

  it('stops polling as soon as the settled row arrives, rather than spending the whole budget', async () => {
    let latestCalls = 0;
    respond = routes({
      diff: () => Promise.resolve(diff({ deployment: null })),
      deploy: () => Promise.resolve({ deployment: deployment({ status: 'PUBLISHED', verifiedAt: null }), verification: { status: 'pending' } }),
      latest: () => { latestCalls += 1; return Promise.resolve(latestBody(deployment())); },
    });
    render(<MemoryRouter><DeployPanel campaignId="camp-1" config={config()} pollIntervalMs={1} pollMaxAttempts={8} /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Publish to the line/ }));
    expect(await screen.findByText('Deployed')).toBeInTheDocument();
    // One read: the VERIFIED row settles the poll. Reading the envelope as the
    // row never matched 'VERIFIED', so every deploy burned the whole budget.
    expect(latestCalls).toBe(1);
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

    expect(await screen.findByText('No receptionist is assigned to this campaign.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Publish to the line/ })).toBeDisabled();
  });

  it('names a failed provider-status load instead of rendering an empty ready state', async () => {
    respond = routes({ status: () => Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR')) });
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Voice line status could not be loaded.');
    expect(alert).toHaveTextContent('An unexpected error occurred');
  });
});
