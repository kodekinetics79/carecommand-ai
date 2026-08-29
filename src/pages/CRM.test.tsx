import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import CRM from './CRM';

/**
 * The CRM Command View is where a clinic owner reads their own business back to
 * themselves. It used to compute every figure in the browser over one capped
 * page of leads and patients and print the result with no qualification.
 *
 * These tests hold three things shut:
 *   * no figure is printed from anything but a server response;
 *   * every threshold in the copy is the value the SERVER says it used, so a
 *     tenant that retunes its policy sees its own numbers described;
 *   * a capped list and an uncomputable metric say so, rather than showing a
 *     confident number that happens to be about a hundred rows.
 */

/** Anything a reader would take for a stat value: 12, 0, 3.4, 15%, $12,500. */
const BARE_FIGURE = /^\$?-?[\d,]+(\.\d+)?%?$/;
const PENDING_FOREVER = () => new Promise<never>(() => {});

const POLICY = {
  source: 'tenant' as const,
  hotLeadScore: 55,
  scoreBandHigh: 55,
  scoreBandMid: 30,
  goingColdDays: 21,
  churnRiskHigh: 60,
  highValuePatientLtv: 5000,
  recoverableLtvFraction: 0.4,
  recoverableLtvPercent: 40,
};

const METRICS = {
  asOf: '2026-08-28T09:00:00.000Z',
  scope: { patients: 'tenant', leads: 'tenant', branchId: null, note: 'Lead figures are tenant-wide.' },
  basis: {
    leadCount: 320, openLeadCount: 240, closedLeadCount: 0,
    patientCount: 1240, inactivePatientCount: 410, unscoredLeadCount: 2, truncated: false,
  },
  metrics: {
    openPipeline: 812_500, hotLeads: 37, winRate: null, avgDeal: 3_385,
    avgChurnRisk: 44, avgLtv: 2_910, missedCallValue: 41_000, inactiveRecoverable: 260_000,
    campaignRoi: null,
  },
  unavailable: {
    winRate: 'No lead has reached retained or lost yet, so there is no won/lost ratio to report.',
    campaignRoi: 'Campaign return on investment is not derived from any recorded spend, so it is not reported.',
  },
  policy: POLICY,
};

function scoredLead(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'lead-1', name: 'Idris Bennett', phone: '+15550001', email: null, channel: 'SMS',
    service: 'Implant consult', stage: 'booked', knownStage: 'booked', source: 'Website',
    estimatedValue: 4200, createdAt: '2026-08-26T09:00:00.000Z', patientId: null,
    ageDays: 2, score: 78, scoreBand: 'high', scoreDrivers: [], scoreUnavailableReason: null,
    hot: true, goingCold: false,
    nextBestAction: { label: 'Send intake form + deposit link', cta: 'send_intake_form' },
    bestTime: 'Planning assumption: prompt review now',
    ...overrides,
  };
}

const PIPELINE = {
  asOf: '2026-08-28T09:00:00.000Z',
  scope: { leads: 'tenant', branchId: null, note: 'Lead figures are tenant-wide.' },
  data: [scoredLead({ id: 'loaded-1', name: 'Page Lead', score: 31, scoreBand: 'medium', hot: false })],
  limit: 200,
  returned: 1,
  total: 320,
  truncated: true,
  stageTotals: [
    { stage: 'new-inquiry', known: true, label: 'New Inquiry', count: 100, value: 200_000 },
    { stage: 'booked', known: true, label: 'Booked', count: 140, value: 612_500 },
  ],
  // Deliberately NOT in `data`: the server ranked it across every open lead.
  priority: [scoredLead({ id: 'priority-1', name: 'Tenant Wide Winner' })],
  maxEstimatedValue: 40_000,
  policy: POLICY,
};

const SEGMENTS = {
  asOf: '2026-08-28T09:00:00.000Z',
  scope: { patients: 'tenant', branchId: null },
  segments: [{
    key: 'inactive-30-60', label: '30–60 days inactive', description: 'Patients quiet 30–60 days',
    patientCount: 214, recoverableValue: 96_000,
    planningChannel: 'SMS', planningOffer: 'Gentle check-in + booking link', planningBookingRatePct: 18,
    plannedCostMinor: 21_400, currency: 'USD', costUnavailableReason: null,
    criteria: { minInactiveDays: 30, maxInactiveDays: 60, includeNeverVisited: false, minLifetimeValue: null, minChurnRisk: null, requiredTag: null },
    neverVisitedCandidates: 63,
    source: 'default', assumptionNotice: 'Unvalidated planning assumptions only; not a forecast or consent decision.',
  }],
  policy: POLICY,
};

function patient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'patient-1', firstName: 'Nadia', lastName: 'Okonkwo', email: 'nadia@example.test', phone: null,
    lifecycleStage: 'ACTIVE', churnRisk: 55, lifetimeValue: '3200',
    lastVisitAt: '2026-07-01T09:00:00.000Z', nextVisitAt: null, tags: [],
    ...overrides,
  };
}

let patientPage: { data: unknown[]; nextCursor?: string } = { data: [patient()] };
const requestedPaths: string[] = [];

function respond(path: string): Promise<unknown> {
  requestedPaths.push(path);
  if (path === '/v1/growth/metrics') return Promise.resolve(METRICS);
  if (path.startsWith('/v1/growth/leads')) return Promise.resolve(PIPELINE);
  if (path === '/v1/growth/segments/preview') return Promise.resolve(SEGMENTS);
  if (path === '/v1/crm/consent') return Promise.resolve([]);
  if (path.startsWith('/v1/patients')) return Promise.resolve(patientPage);
  return PENDING_FOREVER();
}

beforeEach(() => {
  requestedPaths.length = 0;
  patientPage = { data: [patient()] };
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
  // The KPI counter eases from 0 over 900ms unless the viewer asked for reduced
  // motion. Asserting a figure mid-animation would be asserting on a frame.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

const renderPage = () => render(<MemoryRouter><CRM /></MemoryRouter>);
const openTab = async (label: string) => {
  fireEvent.click(await screen.findByRole('tab', { name: label }));
};

describe('CRM Command View figures', () => {
  it('prints no figure at all while the growth requests are in flight', async () => {
    apiRequestMock.mockImplementation(PENDING_FOREVER);
    renderPage();

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    expect(screen.getByLabelText('Loading CRM data')).toBeInTheDocument();
    expect(screen.queryAllByText(BARE_FIGURE)).toEqual([]);
    expect(screen.queryByText('Open pipeline')).not.toBeInTheDocument();
  });

  it('renders the tenant-wide figures the server computed and says they are not a sample', async () => {
    renderPage();

    expect(await screen.findByText('Open pipeline')).toBeInTheDocument();
    // The KPI counter settles on the next animation frame, so each figure is
    // awaited rather than read out of the frame the label appeared in.
    expect(await screen.findByText('$812,500')).toBeInTheDocument();
    expect(await screen.findByText('37')).toBeInTheDocument();
    expect(await screen.findByText('44%')).toBeInTheDocument();
    expect(await screen.findByText('$2,910')).toBeInTheDocument();

    expect(screen.getByText(/Every figure covers all 1,240 patients and 320 leads in this workspace/))
      .toBeInTheDocument();
    expect(screen.getByText(/2 leads have a stage the priority heuristic does not recognise/))
      .toBeInTheDocument();
    // Averages must not be described as being "across patients" in the abstract.
    expect(screen.getAllByText('Across all 1,240 patients')).toHaveLength(2);
  });

  it('renders every threshold from the policy the server reported, not a hardcoded 70 or 30%', async () => {
    renderPage();

    expect(await screen.findByText('Rule score 55 or higher')).toBeInTheDocument();
    expect(screen.queryByText('Rule score 70 or higher')).not.toBeInTheDocument();
    expect(screen.getByText('Planning assumption: 40% of lifetime value across 410 inactive patients')).toBeInTheDocument();
    expect(screen.queryByText(/Planning assumption: 30%/)).not.toBeInTheDocument();
    // The copy still names the figure as an assumption rather than a projection.
    expect(screen.queryByText(/^Projected/)).not.toBeInTheDocument();
  });

  it('shows an uncomputable metric as an absence with the server\'s reason, never as zero', async () => {
    renderPage();

    const label = await screen.findByText('Win rate');
    const card = label.closest('div')!;
    expect(within(card).getByText('—')).toBeInTheDocument();
    expect(within(card).getByText(METRICS.unavailable.winRate)).toBeInTheDocument();
    expect(within(card).queryByText('0%')).not.toBeInTheDocument();
    // Campaign ROI is not reported at all rather than shown as a zero multiple.
    expect(screen.queryByText('Campaign ROI')).not.toBeInTheDocument();
  });

  it('ranks priority leads from the server\'s tenant-wide list, not the loaded page', async () => {
    renderPage();

    expect(await screen.findByText(/Tenant Wide Winner/)).toBeInTheDocument();
    // "Page Lead" is the only lead in `data`; it is not a priority lead and must
    // not be promoted into the list just because it was the row that loaded.
    expect(screen.queryByText(/Page Lead/)).not.toBeInTheDocument();
    expect(screen.getByText(/across all 240 open leads/)).toBeInTheDocument();
  });

  /**
   * The priority list is the server's top N SCORED open leads — it is not
   * filtered by `hotLeadScore`. The empty state used to say "no open lead
   * scores 55 or above", which is a different, false claim: the list is empty
   * when no open lead could be SCORED at all. These two tests pin the two real
   * causes apart, because they need different actions from the reader.
   */
  it('tells a workspace with no open leads that nothing is in the pipeline yet', async () => {
    apiRequestMock.mockImplementation((path: string) => {
      if (path === '/v1/growth/metrics') {
        return Promise.resolve({ ...METRICS, basis: { ...METRICS.basis, openLeadCount: 0 } });
      }
      if (path.startsWith('/v1/growth/leads')) return Promise.resolve({ ...PIPELINE, priority: [] });
      return respond(path);
    });
    renderPage();

    expect(await screen.findByText('No open leads yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review lead sources' })).toBeInTheDocument();
    // The retired copy asserted a threshold that does not gate this list.
    expect(screen.queryByText(/No open lead scores 55 or above/)).not.toBeInTheDocument();
    expect(screen.queryByText('None of your open leads can be ranked yet')).not.toBeInTheDocument();
  });

  it('tells a workspace whose open leads are all unscorable why none can be ranked', async () => {
    apiRequestMock.mockImplementation((path: string) => {
      if (path.startsWith('/v1/growth/leads')) return Promise.resolve({ ...PIPELINE, priority: [] });
      return respond(path);
    });
    renderPage();

    expect(await screen.findByText('None of your open leads can be ranked yet')).toBeInTheDocument();
    // The count is still the tenant-wide one, not the loaded page.
    expect(screen.getByText(/All 240 open leads were checked, not just a loaded page/)).toBeInTheDocument();
    expect(screen.queryByText('No open leads yet')).not.toBeInTheDocument();
  });

  it('surfaces the load failure instead of an empty pipeline', async () => {
    apiRequestMock.mockImplementation(() => Promise.reject(new Error('down')));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Your CRM data did not load/);
    expect(screen.getByRole('alert')).toHaveTextContent(/not zero, and not empty/);
    expect(screen.queryAllByText(BARE_FIGURE)).toEqual([]);
  });
});

describe('Patient Intelligence lookup', () => {
  it('searches on the server and does not filter the loaded rows in the browser', async () => {
    renderPage();
    await screen.findByText('Open pipeline');
    await openTab('Patient Intelligence');

    // The server answers a search for "implant" with a patient whose NAME does
    // not contain it — an email, phone or external-ref match. A browser-side
    // name filter would drop this row and report "No patients found".
    patientPage = { data: [patient({ id: 'patient-2', firstName: 'Grace', lastName: 'Adeyemi' })] };
    fireEvent.change(screen.getByLabelText('Search patients'), { target: { value: 'implant' } });

    await waitFor(() => expect(requestedPaths.some(p => p.includes('search=implant'))).toBe(true));
    expect(await screen.findByText('Grace Adeyemi')).toBeInTheDocument();
    expect(screen.queryByText('No patients found')).not.toBeInTheDocument();
    expect(requestedPaths.some(p => p.startsWith('/v1/patients') && p.includes('limit=100'))).toBe(true);
  });

  it('reports an empty search result as a fact about the workspace, not the page', async () => {
    renderPage();
    await screen.findByText('Open pipeline');
    await openTab('Patient Intelligence');

    patientPage = { data: [] };
    fireEvent.change(screen.getByLabelText('Search patients'), { target: { value: 'zzz' } });

    expect(await screen.findByText('No patients found')).toBeInTheDocument();
    expect(screen.getByText(/No patient in this workspace matches “zzz”\./)).toBeInTheDocument();
  });

  it('says so when the table is showing a capped page', async () => {
    patientPage = { data: [patient()], nextCursor: 'patient-1' };
    renderPage();
    await screen.findByText('Open pipeline');
    await openTab('Patient Intelligence');

    expect(await screen.findByRole('status')).toHaveTextContent(/Showing the first 100 matching records/);
    expect(screen.getByText(/Sorting reorders these 100 only/)).toBeInTheDocument();
    expect(screen.getByText(/Search covers all 1,240 patients in this workspace/)).toBeInTheDocument();
  });

  it('bands churn risk against the configured threshold rather than a hardcoded 50', async () => {
    patientPage = {
      data: [
        patient({ id: 'below', firstName: 'Below', lastName: 'Threshold', churnRisk: 55 }),
        patient({ id: 'above', firstName: 'Above', lastName: 'Threshold', churnRisk: 70 }),
      ],
    };
    renderPage();
    await screen.findByText('Open pipeline');
    await openTab('Patient Intelligence');

    // The tenant's churnRiskHigh is 60. Under the deleted client-side rule this
    // 55% patient was flagged red on every screen in every workspace.
    expect((await screen.findByText('55%')).className).toContain('badge-emerald');
    expect(screen.getByText('70%').className).toContain('badge-red');
  });
});

describe('Smart segments and pipeline disclosures', () => {
  it('prices a segment in the configured currency and names who the window excludes', async () => {
    renderPage();
    await screen.findByText('Open pipeline');
    await openTab('Smart Segments');

    expect(await screen.findByText('30–60 days inactive')).toBeInTheDocument();
    expect(screen.getByText('214')).toBeInTheDocument();
    expect(screen.getByText('Planning value (40%)')).toBeInTheDocument();
    expect(screen.getByText('$214')).toBeInTheDocument();
    expect(screen.getByText(/Excludes 63 patients with no recorded last visit/)).toBeInTheDocument();
    expect(screen.getByText(/counted across every patient in this workspace/)).toBeInTheDocument();
  });

  it('reports the pipeline board as capped while showing tenant-wide lane totals', async () => {
    renderPage();
    await screen.findByText('Open pipeline');
    await openTab('Pipeline');

    expect(await screen.findByRole('status')).toHaveTextContent(/Showing 1 of 320 leads/);
    // The lane header is the server's count and value for the whole tenant, not
    // a sum of the cards below it.
    expect(await screen.findByText('140')).toBeInTheDocument();
    expect(await screen.findByText('$612,500')).toBeInTheDocument();
  });
});
