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

/**
 * The signed-in session. Every panel on this page is gated on what the user is
 * permitted to see, so a test that answers no session is testing a dashboard
 * nobody ever sees — the panels stay loading because nothing has been asked.
 * These tests are about campaign handoffs, so they run as a user holding the
 * grants the panels require; the gating itself is pinned separately below.
 */
const FULL_ACCESS_SESSION = {
  user: { id: 'u1', email: 'owner@example.com', name: 'Owner', role: 'OWNER', tenantId: 't1' },
  access: { permissions: ['revenue:read', 'staff:read', 'campaign:read'] },
};

beforeEach(() => {
  handlers = {};
  handlers['GET /v1/auth/me'] = () => FULL_ACCESS_SESSION;
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

/**
 * The cockpit used to ask for every panel's data regardless of who was looking,
 * so FRONT_DESK, PROVIDER and AUDITOR each collected fourteen 403s on the
 * landing page, every visit, while the UI swallowed them silently. Nothing
 * rendered a status code, which is exactly why it went unnoticed for so long.
 *
 * These pin both halves: the requests are not sent, and the panels that could
 * only ever show a refusal are not rendered.
 */
describe('Dashboard panels a role may not see', () => {
  // Endpoint -> the grant its route enforces, per the receptionist/operations
  // /providers/campaigns route modules on the server.
  const GATED = {
    'GET /v1/revenue-snapshots?limit=100': 'revenue:read',
    'GET /v1/opportunities': 'revenue:read',
    'GET /v1/revenue-leaks': 'revenue:read',
    'GET /v1/providers/overview': 'staff:read',
    'GET /v1/campaigns?limit=4': 'campaign:read',
  } as const;

  function renderAs(permissions: string[]) {
    handlers['GET /v1/auth/me'] = () => ({ ...FULL_ACCESS_SESSION, access: { permissions } });
    return renderDashboard();
  }

  /** Every path the page actually requested, method included. */
  function requested(): string[] {
    return apiRequestMock.mock.calls.map(([path, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${path}`);
  }

  it('asks for nothing the signed-in role is not permitted to read', async () => {
    renderAs([]);
    // The session resolving is what unblocks every other decision on the page.
    await waitFor(() => expect(requested()).toContain('GET /v1/auth/me'));
    await waitFor(() => expect(requested()).toContain('GET /v1/dashboard/summary'));

    for (const endpoint of Object.keys(GATED)) {
      expect(requested(), `${endpoint} must not be requested by a role without ${GATED[endpoint as keyof typeof GATED]}`).not.toContain(endpoint);
    }
  });

  it('does not render a panel that could only ever show a refusal', async () => {
    renderAs([]);
    await waitFor(() => expect(requested()).toContain('GET /v1/dashboard/summary'));

    expect(screen.queryByText('Revenue snapshot trend')).toBeNull();
    expect(screen.queryByText('Provider Capacity')).toBeNull();
    expect(screen.queryByText('Branch Capacity Planning')).toBeNull();
    expect(screen.queryByText('Campaign performance evidence')).toBeNull();
    // ...and no raw authorization vocabulary in its place.
    expect(screen.queryByText(/does not have access/i)).toBeNull();
  });

  it('still asks, and still renders, for a role that holds the grants', async () => {
    renderAs(['revenue:read', 'staff:read', 'campaign:read']);
    for (const endpoint of Object.keys(GATED)) {
      await waitFor(() => expect(requested()).toContain(endpoint));
    }
    expect(screen.getByText('Revenue snapshot trend')).toBeTruthy();
    expect(screen.getByText('Campaign performance evidence')).toBeTruthy();
  });

  it('asks only for the family a partially-granted role holds', async () => {
    renderAs(['staff:read']);
    await waitFor(() => expect(requested()).toContain('GET /v1/providers/overview'));
    expect(requested()).not.toContain('GET /v1/revenue-snapshots?limit=100');
    expect(requested()).not.toContain('GET /v1/campaigns?limit=4');
    expect(screen.getByText('Provider Capacity')).toBeTruthy();
    expect(screen.queryByText('Revenue snapshot trend')).toBeNull();
  });
});
