import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

// The module boundary every request on this page goes through: the dashboard
// service and every useResource loader call `apiRequest`.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import Dashboard from './Dashboard';

/**
 * Every campaign CTA on the dashboard is a decision the user already made, so
 * the navigation into /campaigns must carry it. These tests pin the exact
 * handoff payload each CTA sends — an honest `{ source }` where the CTA
 * promises nothing more specific, and a goal only where the CTA's own copy
 * names one (the empty ROI panel offers a reactivation campaign → winback).
 */

/** Never-answering request: what the first frames of every real load look like. */
const PENDING_FOREVER = () => new Promise<never>(() => {});

type Handler = (init?: RequestInit) => unknown;
let handlers: Record<string, Handler>;

beforeEach(() => {
  handlers = {};
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? 'GET'} ${path}`];
    // An unregistered endpoint stays pending rather than resolving to
    // undefined: a test must never accidentally assert against a fake answer.
    return handler ? handler(init) : PENDING_FOREVER();
  });
});

/** Where every campaign CTA must land, printing the state it arrived with. */
function CampaignDestination() {
  const location = useLocation();
  return <pre data-testid="landed">{JSON.stringify(location.state)}</pre>;
}

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/campaigns" element={<CampaignDestination />} />
      </Routes>
    </MemoryRouter>,
  );
}

function landedState(): unknown {
  return JSON.parse(screen.getByTestId('landed').textContent ?? 'null');
}

describe('Dashboard campaign handoffs', () => {
  it('sends the source with the "All campaigns" header CTA', () => {
    renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: /All campaigns/ }));
    expect(landedState()).toEqual({ source: 'Dashboard' });
  });

  it('sends the winback goal the empty ROI panel\'s create CTA offers', async () => {
    handlers['GET /v1/campaigns?limit=4'] = () => [];
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Create campaign draft' }));
    expect(landedState()).toEqual({
      goal: 'winback', source: 'Dashboard', contextLabel: 'No campaigns recorded yet',
    });
  });

  it('sends only the source from the priority rail\'s generic launch CTA', async () => {
    handlers['GET /v1/opportunities'] = () => [];
    handlers['GET /v1/revenue-leaks'] = () => [];
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Launch a campaign' }));
    expect(landedState()).toEqual({ source: 'Dashboard' });
  });

  it('sends the source with the command deck\'s "Review campaigns" CTA', async () => {
    handlers['GET /v1/dashboard/summary'] = () => ({
      generatedAt: '2026-08-28T12:00:00.000Z',
      networkRevenue: 120000, revenueRecovered: 8000,
      activeCustomers: 640, todaysAppointments: 22,
      noShowRisk: 3, callsRecovered: 12, missedCalls: 4,
      activeOpportunities: 15000, pendingApprovals: 2,
    });
    renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: /Review campaigns/ }));
    await waitFor(() => expect(landedState()).toEqual({ source: 'Dashboard' }));
  });
});
