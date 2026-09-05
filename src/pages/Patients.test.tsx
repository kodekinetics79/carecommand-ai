import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

// The module boundary every request on this page goes through: useApiResource,
// useApiData and the create-patient form all call `apiRequest`.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import Patients from './Patients';

/**
 * The outreach recommendation is a winback decision made on this page, so the
 * navigation into /campaigns must carry the goal, the source, and the exact
 * aggregate claim the operator saw — a count, never patient-identifying detail
 * beyond what the page already shows. When the summary never arrived there is
 * no claim to echo, and the handoff must not invent one.
 */

type Handler = (init?: RequestInit) => unknown;
let handlers: Record<string, Handler>;

beforeEach(() => {
  handlers = {};
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? 'GET'} ${path}`];
    // An unregistered endpoint stays pending rather than resolving to
    // undefined: a test must never accidentally assert against a fake answer.
    return handler ? handler(init) : new Promise<never>(() => {});
  });
});

const SUMMARY = {
  scope: 'tenant', asOf: '2026-08-28T12:00:00.000Z',
  patientCount: 40, activeRetainedCount: 25, highRiskCount: 12,
  highLifetimeValueCount: 6, churnRiskHigh: 55, highValuePatientLtv: 3500, averageLifetimeValue: 1800, outstandingBalance: 900,
  lifecycleCounts: { INACTIVE: 4 }, branchCounts: {}, activeConsentCounts: { MARKETING: 20 },
  marketingConsentRate: 50,
};

function CampaignDestination() {
  const location = useLocation();
  return <pre data-testid="landed">{JSON.stringify(location.state)}</pre>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/patients']}>
      <Routes>
        <Route path="/patients" element={<Patients />} />
        <Route path="/campaigns" element={<CampaignDestination />} />
      </Routes>
    </MemoryRouter>,
  );
}

function landedState(): unknown {
  return JSON.parse(screen.getByTestId('landed').textContent ?? 'null');
}

describe('Patients campaign handoff', () => {
  it('carries winback, the source, and the risk-queue count the operator saw', async () => {
    handlers['GET /v1/patients?limit=25'] = () => [];
    handlers['GET /v1/branches?limit=100'] = () => [];
    handlers['GET /v1/patients/summary'] = () => SUMMARY;
    renderPage();
    // The card's claim must be on screen before the CTA can be echoing it.
    await screen.findByText('12 patients are in the risk review queue');
    fireEvent.click(screen.getByRole('button', { name: /Open campaign planning/ }));
    expect(landedState()).toEqual({
      goal: 'winback', source: 'Patients',
      contextLabel: '12 patients in the risk review queue',
    });
  });

  it('omits the context label rather than inventing one while the summary is absent', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Open campaign planning/ }));
    expect(landedState()).toEqual({ goal: 'winback', source: 'Patients' });
  });
});

describe('Patients multi-clinic records', () => {
  it('uses configured thresholds, shows clinic identity, and follows cursor pages', async () => {
    const firstPatient = {
      id: 'patient-1', branchId: 'branch-1', firstName: 'Avery', lastName: 'Stone', lifecycleStage: 'AT_RISK',
      churnRisk: 56, lifetimeValue: '3600', outstandingBalance: '0', tags: [], _count: { appointments: 3 },
    };
    const secondPatient = { ...firstPatient, id: 'patient-2', firstName: 'Morgan', lastName: 'Lee' };
    handlers['GET /v1/patients?limit=25'] = () => ({ data: [firstPatient], nextCursor: 'cursor-2' });
    handlers['GET /v1/patients?limit=25&cursor=cursor-2'] = () => ({ data: [secondPatient] });
    handlers['GET /v1/branches?limit=100'] = () => [{ id: 'branch-1', name: 'Downtown Clinic', active: true }];
    handlers['GET /v1/patients/summary'] = () => SUMMARY;
    renderPage();

    expect(await screen.findByText('Avery Stone')).toBeInTheDocument();
    expect(screen.getByText(/Downtown Clinic · 3 recorded visits/)).toBeInTheDocument();
    expect(screen.getByText('Stored score ≥55%')).toBeInTheDocument();
    expect(screen.getByText('56% risk')).toBeInTheDocument();
    expect(screen.getByText('High LTV (≥$3,500)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Morgan Lee')).toBeInTheDocument();
    expect(screen.getByText('Page 2')).toBeInTheDocument();
  });

  it('removes tenant claims while a selected-clinic summary loads, then labels the clinic facts accurately', async () => {
    let resolveClinicSummary!: (value: typeof SUMMARY) => void;
    const clinicSummary = new Promise<typeof SUMMARY>((resolve) => { resolveClinicSummary = resolve; });
    handlers['GET /v1/patients?limit=25'] = () => [];
    handlers['GET /v1/patients?limit=25&branchId=branch-2'] = () => [];
    handlers['GET /v1/branches?limit=100'] = () => [
      { id: 'branch-1', name: 'Downtown Clinic', active: true },
      { id: 'branch-2', name: 'Lakeside Clinic', active: true },
    ];
    handlers['GET /v1/patients/summary'] = () => SUMMARY;
    handlers['GET /v1/patients/summary?branchId=branch-2'] = () => clinicSummary;
    renderPage();

    await screen.findByText('Tenant aggregate facts');
    fireEvent.click(screen.getByRole('button', { name: 'Lakeside Clinic' }));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/patients/summary?branchId=branch-2'));

    expect(screen.queryByText('Tenant aggregate facts')).not.toBeInTheDocument();
    expect(screen.queryByText('12 patients are in the risk review queue')).not.toBeInTheDocument();

    await act(async () => {
      resolveClinicSummary({ ...SUMMARY, scope: 'selected_branch', patientCount: 9, highRiskCount: 3 });
      await clinicSummary;
    });
    expect(await screen.findByText('Selected-clinic aggregate facts')).toBeInTheDocument();
    expect(screen.getByText('Selected clinic')).toBeInTheDocument();
    expect(screen.getByText('Selected clinic only')).toBeInTheDocument();
    expect(screen.getByText('3 patients are in the risk review queue')).toBeInTheDocument();
  });
});
