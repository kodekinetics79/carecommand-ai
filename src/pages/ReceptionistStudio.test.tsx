import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../lib/api';
import { STUDIO_TAB_IDS, resolveStudioTab } from '../lib/receptionistDeployment';
import ReceptionistStudio from './ReceptionistStudio';

/**
 * The Studio is where an owner takes a clinic live, so three things have to
 * hold on every render: a fix link lands on the screen it names (E3/E4/B7),
 * the header prints only numbers the server could actually compute (E8/SF-2),
 * and the go-live path and the service status are visible without hunting for
 * a tab (SF-3/SF-4).
 */
const CLINIC = {
  id: 'clinic-1', name: 'Brightsmile Dental Group', phone: '+14155550142', logoUrl: null, website: null, addressLine: null,
  country: 'US', timezone: 'America/Los_Angeles', defaultLanguage: 'en-US', complianceDisclosure: 'Hi, this is Riley.',
  humanFallbackNumber: '+14155550100', doNotContactPolicy: null, workingHours: null, active: true,
  updatedAt: '2026-08-30T09:00:00.000Z', locations: [], _count: { campaigns: 2 },
  readiness: { ready: false, blockers: ['clinic_hours_missing'] },
};

const SECOND_CLINIC = { ...CLINIC, id: 'clinic-2', name: 'Northside Family Dental', readiness: { ready: true, blockers: [] }, _count: { campaigns: 1 } };

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 'camp-1', clinicId: 'clinic-1', agentId: 'agent-1', name: 'New-patient scheduling', campaignType: 'Reactivation',
    status: 'DRAFT', offerTitle: 'Cleaning', offerDescription: 'A cleaning', offerScript: 'Book a cleaning',
    appointmentType: 'Hygiene', bookingRules: null, eligibleLocationIds: [], smsConfirmation: false, emailConfirmation: false,
    intakeFields: [],
    ...overrides,
  };
}

const READINESS = {
  campaignId: 'camp-1', status: 'DRAFT', ready: false, providerMode: 'live',
  checks: [
    { key: 'deployment_current', label: 'The deployed prompt matches this campaign', status: 'pass', code: null, title: '', detail: 'Version 4 is deployed.', fixHref: null },
    { key: 'agent_verified', label: 'The voice line passed its line check', status: 'pass', code: null, title: '', detail: 'Verified.', fixHref: null },
    { key: 'agent_linked', label: 'An agent is assigned', status: 'pass', code: null, title: '', detail: 'Riley.', fixHref: null },
    {
      key: 'number_bound', label: 'The phone number answers with this agent', status: 'fail', code: 'number_bound',
      title: 'The number is not bound to this deployment',
      detail: 'The phone number does not point at this version, so a caller would not reach this receptionist. Publish to the line again.',
      fixHref: '/receptionist-studio?clinic=clinic-1&campaign=camp-1&tab=deploy',
    },
  ],
  actions: { activate: { allowed: false, reasons: ['campaign_not_ready'] }, pause: { allowed: false, reasons: [] }, archive: { allowed: true, reasons: [] } },
  evaluatedAt: '2026-08-30T09:00:00.000Z',
};

const VOICE_LINE_STATUS = {
  providerConfigured: true, providerMode: 'live', agentReady: true,
  agentScope: { clinicId: 'clinic-1', campaignId: 'camp-1', agentId: 'agent-1', agentName: 'Riley' },
  verification: { status: 'VERIFIED', expiresAt: null, expiresInMs: 19 * 60 * 60 * 1000, autoRenew: { enabled: true, lastSystemAttemptAt: new Date().toISOString() } },
  blockers: [], attendedUat: null, adhocTestCallsAllowed: false,
};

/** The kpi-v2 body, legacy scalars included exactly as the route still sends them. */
const OVERVIEW = {
  period: { from: '2026-08-23', to: '2026-08-30', timezone: 'America/Los_Angeles', period: 'week' },
  counts: { inbound: 14, outbound: 3, answeredInbound: 1, booked: 0, escalated: 0, optedOut: 1, pendingRequests: 2, openHandoffs: 0, activeCampaigns: 0, clinics: 1 },
  rates: { bookingRate: null, containedPct: 1, afterHoursPct: null, callbacksWithinSlaPct: null },
  aht: null,
  definitions: {
    version: 'kpi-v2',
    answeredInbound: 'Inbound calls whose outcome is not NO_ANSWER, FAILED or IN_PROGRESS.',
    bookingRate: 'Inbound BOOKED / answered inbound. Null when nothing was answered.',
    aht: 'Average call seconds, excluding in-progress and zero-second calls.',
  },
  // Package D deletes these; the header must already ignore them.
  clinics: 1, activeCampaigns: 0, totalCalls: 7, booked: 1, bookingRate: 14, appointmentRequests: 2, optOuts: 1, avgDurationSeconds: 0,
};

const CATALOG = {
  generatedAt: '2026-08-30T09:00:00.000Z',
  fieldTypes: [],
  timezones: { groups: [{ region: 'Americas', zones: ['America/Los_Angeles'] }], recommended: ['America/Los_Angeles'] },
  countries: [{ code: 'US', name: 'United States', callingCode: '+1', defaultEmergencyNumber: '911', defaultLanguages: ['en-US'], currency: 'USD' }],
  languages: [{ id: 'en-US', label: 'English (US)', provider: 'voice_service' }],
  tones: ['Warm and professional'],
  campaignTypes: ['Reactivation'],
  localePacks: [{ language: 'en-US', country: 'US', status: 'APPROVED', packId: 'pack-1', hasPlatformDefault: true, platformDefaultVersion: 2 }],
  limits: { maxIntakeFields: 20, faqMax: 20, payersMax: 40, closureMaxDays: 30, knowledgeTextMax: 4000, closureReasonMax: 240, accessNotesMax: 1000 },
};

const VOICE_LINE_CONFIG = {
  systemPrompt: '# Role\nYou are Riley.', voiceId: 'voice-anna', language: 'en-US',
  beginMessage: 'Hi, this is Riley.', dynamicVariables: { is_open_now: 'true' },
  webhookUrl: 'https://api.example.com/v1/receptionist/webhooks/voice',
  bookingFunction: { name: 'book_appointment' },
  callOutcomeFields: [{ name: 'outcome', type: 'enum', description: 'Call outcome' }],
  tools: [],
};

let overrides: Record<string, () => Promise<unknown>>;

function respond(path: string): Promise<unknown> {
  for (const [prefix, handler] of Object.entries(overrides)) {
    if (path.startsWith(prefix)) return handler();
  }
  if (path === '/v1/receptionist/clinics') return Promise.resolve([CLINIC, SECOND_CLINIC]);
  if (path === '/v1/receptionist/overview') return Promise.resolve(OVERVIEW);
  if (path.startsWith('/v1/receptionist/campaigns?clinicId=clinic-1')) return Promise.resolve([campaign(), campaign({ id: 'camp-2', name: 'Recall wave', agentId: 'agent-2' })]);
  if (path.startsWith('/v1/receptionist/campaigns?clinicId=clinic-2')) return Promise.resolve([campaign({ id: 'camp-9', clinicId: 'clinic-2', name: 'Northside recall' })]);
  if (path.includes('/readiness')) return Promise.resolve(READINESS);
  if (path.startsWith('/v1/receptionist/voice-line-status')) return Promise.resolve(VOICE_LINE_STATUS);
  if (path === '/v1/receptionist/catalog') return Promise.resolve(CATALOG);
  if (path.startsWith('/v1/receptionist/agents')) return Promise.resolve([]);
  if (path.startsWith('/v1/receptionist/scheduling-branches')) return Promise.resolve([]);
  if (path.includes('/voice-line-configuration')) return Promise.resolve(VOICE_LINE_CONFIG);
  if (path.includes('/deployment-diff')) return Promise.resolve({ deployment: null, draft: {}, changed: [], placeholders: [] });
  if (path.includes('/deployments/latest')) return Promise.resolve({ deployment: null });
  // Panels below the rail fetch their own resources; the assertions here are
  // about the header, the strip and the rail, so an empty body is enough.
  return Promise.resolve({});
}

beforeEach(() => {
  overrides = {};
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
});

function renderStudio(search = '') {
  return render(<MemoryRouter initialEntries={[`/receptionist-studio${search}`]}><ReceptionistStudio /></MemoryRouter>);
}

describe('resolveStudioTab — every fixTab the server writes lands somewhere real (E4 / B7)', () => {
  it('accepts the server’s `deploy` and `agent` ids', () => {
    expect(resolveStudioTab('deploy')).toBe('deploy');
    expect(resolveStudioTab('agent')).toBe('campaign');
  });

  it('keeps the pre-rename supplier-named id working', () => {
    expect(resolveStudioTab('retell')).toBe('deploy'); // vendor-neutral-exempt: proves the inbound alias for links printed before the rename still lands.
  });

  it('accepts every non-null `fixTab` in server/lib/receptionist/remediation.ts', () => {
    // `RemediationTab = 'agent' | 'campaign' | 'intake' | 'clinic' | 'deploy' | 'scheduling' | null`.
    // 'scheduling' is an absolute route (/scheduling), not a Studio tab.
    for (const fixTab of ['agent', 'campaign', 'intake', 'clinic', 'deploy']) {
      expect(resolveStudioTab(fixTab), `fixTab '${fixTab}' resolves to no Studio tab`).not.toBeNull();
    }
  });

  it('refuses an id nobody defines rather than guessing', () => {
    expect(resolveStudioTab('scheduling')).toBeNull();
    expect(resolveStudioTab('nonsense')).toBeNull();
    expect(resolveStudioTab(null)).toBeNull();
  });

  it('renders one button per canonical tab id', async () => {
    renderStudio();
    const tablist = await screen.findByRole('tablist');
    expect(within(tablist).getAllByRole('tab')).toHaveLength(STUDIO_TAB_IDS.length);
  });
});

describe('ReceptionistStudio', () => {
  it('opens the tab, clinic and campaign a fix link names (E3)', async () => {
    renderStudio('?clinic=clinic-2&campaign=camp-9&tab=deploy');

    await waitFor(() => expect(screen.getByRole('tab', { name: /Go live/ })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('tab', { name: /Clinic Profile/ })).toHaveAttribute('aria-selected', 'false');
    await screen.findByText('Northside recall');
  });

  it('follows `agent` to the campaign that links it', async () => {
    renderStudio('?clinic=clinic-1&agent=agent-2&tab=campaign');

    await waitFor(() => expect(screen.getByRole('tab', { name: /Agent & Campaign/ })).toHaveAttribute('aria-selected', 'true'));
    // camp-2 is the campaign that links agent-2; camp-1 is first in the list.
    await waitFor(() => expect(screen.getAllByText('Recall wave').length).toBeGreaterThan(0));
  });

  it('sends the server’s `agent` tab id to Agent & Campaign rather than falling back to Clinic Profile', async () => {
    renderStudio('?clinic=clinic-1&tab=agent');

    await waitFor(() => expect(screen.getByRole('tab', { name: /Agent & Campaign/ })).toHaveAttribute('aria-selected', 'true'));
  });

  it('says so when a link points at a campaign this clinic does not hold', async () => {
    renderStudio('?clinic=clinic-1&campaign=camp-404&tab=campaign');

    expect(await screen.findByText(/points at a campaign this clinic does not hold/)).toBeInTheDocument();
  });

  it('prints kpi-v2 with an em dash where the rate cannot be computed (E8 / SF-2)', async () => {
    renderStudio();

    const metrics = await screen.findByLabelText('Receptionist performance');
    const tile = (name: string) => within(metrics).getByText(name).closest('[data-kpi]') as HTMLElement;

    await waitFor(() => expect(within(tile('Answered inbound')).getByText('1')).toBeInTheDocument());
    // The legacy body says 14% over 7 calls in both directions; the honest
    // answer is that nothing was booked out of what was answered.
    expect(within(tile('Booking rate')).getByText('—')).toBeInTheDocument();
    expect(within(tile('Booking rate')).getByText('Not enough data')).toBeInTheDocument();
    expect(within(tile('Avg call')).getByText('—')).toBeInTheDocument();
    expect(metrics.textContent).not.toContain('0m 0s');
    expect(metrics.textContent).not.toContain('14%');
    expect(tile('Booking rate')).toHaveAttribute('title', 'Inbound BOOKED / answered inbound. Null when nothing was answered.');
  });

  it('names a failed KPI read instead of rendering a clinic with no calls', async () => {
    overrides = { '/v1/receptionist/overview': () => Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR')) };
    renderStudio();

    expect(await screen.findByText('The receptionist KPIs could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Receptionist performance')).not.toBeInTheDocument();
  });

  it('keeps the service status strip visible on a tab that is not the go-live tab (SF-3)', async () => {
    renderStudio('?clinic=clinic-1&tab=activity');

    const strip = await screen.findByLabelText('Receptionist service status');
    await waitFor(() => expect(strip).toHaveAttribute('data-service-state', 'not_answering'));
    expect(strip).toHaveTextContent('The number is not bound to this deployment');
    expect(within(strip).getByRole('link')).toHaveAttribute('href', '/receptionist-studio?clinic=clinic-1&campaign=camp-1&tab=deploy');
  });

  it('shows the go-live rail with the clinic prerequisite on the go-live tab (SF-4)', async () => {
    renderStudio('?clinic=clinic-1&tab=deploy');

    expect(await screen.findByRole('list', { name: 'Go live steps' })).toBeInTheDocument();
    expect(within(screen.getByTestId('clinic-prerequisites')).getByText('No hours')).toBeInTheDocument();
    expect(screen.getByTestId('next-action')).toHaveTextContent('Next: No hours');
    expect(screen.getByTestId('dial-this-number')).toHaveTextContent('Not confirmed yet.');
  });

  it('names the go-live tab after what it does, not after the vendor', async () => {
    renderStudio();

    await screen.findByRole('tablist');
    expect(screen.getByRole('tab', { name: /Go live/ })).toBeInTheDocument();
    // Asserting the absence of one specific old label only ever caught that
    // label. Pinning the whole list catches the NEXT supplier name too, and it
    // is the tab strip a clinic owner reads top to bottom.
    expect(screen.getAllByRole('tab').map(tab => tab.textContent?.trim())).toEqual([
      'Clinic Profile', 'Knowledge', 'Agent & Campaign', 'Intake Builder',
      'Preview', 'Go live', 'Outbound Calls', 'Activity',
    ]);
  });
});
