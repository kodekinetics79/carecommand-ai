import { fireEvent, render, screen } from '@testing-library/react';
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
  highLifetimeValueCount: 6, averageLifetimeValue: 1800, outstandingBalance: 900,
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
    handlers['GET /v1/patients?limit=100'] = () => [];
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
