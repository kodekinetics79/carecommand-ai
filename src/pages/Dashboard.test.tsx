import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});
vi.mock('../hooks/useBackendHealth', () => ({ useBackendHealth: () => true }));

import Dashboard from './Dashboard';

type Handler = (init?: RequestInit) => unknown;
let handlers: Record<string, Handler>;

const OWNER = {
  user: {
    id: 'u1', email: 'owner@bright-health.test', displayName: 'Avery Morgan', role: 'OWNER',
    tenant: { id: 't1', name: 'Bright Health LLC', slug: 'bright-health' }, active: true,
  },
  access: { tenantId: 't1', role: 'OWNER', permissions: ['revenue:read', 'staff:read', 'crm:read', 'receptionist:call-artifacts:read'] },
};

beforeEach(() => {
  handlers = {
    'GET /v1/auth/me': () => OWNER,
    'GET /v1/dashboard/summary': () => ({
      generatedAt: new Date().toISOString(), networkRevenue: 0, revenueRecovered: 0,
      activeCustomers: 0, todaysAppointments: 0, noShowRisk: 0, callsRecovered: 0,
      missedCalls: 0, activeOpportunities: 0, pendingApprovals: 0,
    }),
    'GET /v1/branches': () => [{ id: 'b1', name: 'Fairfax Clinic', location: 'Fairfax, VA' }],
    'GET /v1/providers/overview': () => ({ data: [] }),
    'GET /v1/opportunities': () => [],
    'GET /v1/revenue-leaks': () => [],
    'GET /v1/capabilities': () => [],
  };
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? 'GET'} ${path}`];
    if (!handler) throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
    return handler(init);
  });
});

function Destination() {
  const location = useLocation();
  return <p data-testid="destination">{location.pathname}</p>;
}

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="*" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
}

function requested(): string[] {
  return apiRequestMock.mock.calls.map(([path, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${path}`);
}

describe('Operational Briefing', () => {
  it('loads only recorded tenant evidence for an authorized owner', async () => {
    renderDashboard();
    for (const endpoint of [
      'GET /v1/dashboard/summary', 'GET /v1/branches', 'GET /v1/providers/overview',
      'GET /v1/opportunities', 'GET /v1/revenue-leaks', 'GET /v1/capabilities',
    ]) await waitFor(() => expect(requested()).toContain(endpoint));

    expect(await screen.findByRole('heading', { name: 'Operational Briefing' })).toBeInTheDocument();
    expect(screen.getByText('Bright Health LLC')).toBeInTheDocument();
    expect(screen.getByText('The priority feed loaded and contains no recorded actions.')).toBeInTheDocument();
  });

  it('does not request gated revenue or staff data for a role without those grants', async () => {
    handlers['GET /v1/auth/me'] = () => ({ ...OWNER, access: { ...OWNER.access, permissions: [] } });
    renderDashboard();
    await waitFor(() => expect(requested()).toContain('GET /v1/dashboard/summary'));
    await waitFor(() => expect(requested()).toContain('GET /v1/capabilities'));
    expect(requested()).not.toContain('GET /v1/opportunities');
    expect(requested()).not.toContain('GET /v1/revenue-leaks');
    expect(requested()).not.toContain('GET /v1/branches');
    expect(requested()).not.toContain('GET /v1/providers/overview');
    expect(screen.getByText(/does not request revenue data your role cannot read/i)).toBeInTheDocument();
  });

  it('renders source, ownership and due evidence, then opens the real source workflow', async () => {
    handlers['GET /v1/opportunities'] = () => [{
      id: 'opp-1', title: 'Recover interrupted scheduling calls', description: 'Two patient callbacks remain open.',
      source: 'missed_call', confidence: 92, urgency: 'high', owner: 'Central Front Desk', updatedAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    }];
    renderDashboard();
    expect(await screen.findAllByText('Recover interrupted scheduling calls')).toHaveLength(2);
    expect(screen.getAllByText('Central Front Desk').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Open AI Front Desk' })[0]);
    expect(screen.getByTestId('destination')).toHaveTextContent('/ai-receptionist');
  });

  it('labels test and unconfigured capabilities without implying production readiness', async () => {
    handlers['GET /v1/capabilities'] = () => [
      { key: 'eligibility_checks', label: 'Eligibility checks', state: 'test_data', detail: 'Sandbox records', usable: true },
      { key: 'card_payments', label: 'Card payments', state: 'not_set_up', detail: 'Contact support', usable: false },
    ];
    renderDashboard();
    expect(await screen.findByText('Test data')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText(/does not claim certification or customer outcomes/i)).toBeInTheDocument();
  });
});
