import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { GROWTH_POLICY_PATH } from '../lib/growthPolicy';
import Scheduling from './Scheduling';

/**
 * The red "N% risk" badge is a claim about the clinic's OWN configured rule:
 * an appointment is flagged when `noShowRisk >= noShowRiskHigh` from
 * GET /v1/growth/policy — the same threshold the advisory engine counts (and
 * prices at $120 a flag) with. This page used to hardcode `>= 50` while the
 * advisor counted `>= 60` and revenue-protection escalated at `> 65`.
 *
 * These tests hold the honest-state contract: the flag follows the configured
 * value, nothing is flagged from a guessed number while the policy is in
 * flight, and a failed policy read is named next to the timeline instead of
 * silently hiding risk from the front desk forever.
 */

function appointment(id: string, noShowRisk: number) {
  const startsAt = new Date();
  startsAt.setHours(14, 30, 0, 0);
  return {
    id,
    patientId: `patient-${id}`,
    patientName: `Patient ${id}`,
    providerRef: 'Dr Rivera',
    branchId: 'branch-1',
    service: 'Dermatology Review',
    startsAt: startsAt.toISOString(),
    status: 'CONFIRMED',
    noShowRisk,
    channel: 'EMAIL',
    value: '180',
    notes: null,
  };
}

function growthPolicy(overrides: Record<string, unknown> = {}) {
  // Defaults per server/modules/growth/defaults.ts.
  return { source: 'default', noShowRiskHigh: 50, ...overrides };
}

const PENDING_FOREVER = () => new Promise<never>(() => {});

let respond: (path: string) => Promise<unknown>;

beforeEach(() => {
  respond = PENDING_FOREVER;
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
});

function respondWith(options: {
  appointments?: unknown[];
  policy?: () => Promise<unknown>;
}) {
  respond = (path: string) => {
    if (path.startsWith('/v1/auth/me')) {
      return Promise.resolve({ user: { id: 'user-1', role: 'MANAGER', displayName: 'Front Desk' }, access: { permissions: [] } });
    }
    if (path.startsWith('/v1/appointments')) return Promise.resolve(options.appointments ?? []);
    if (path.startsWith('/v1/providers/overview')) return Promise.resolve([]);
    if (path.startsWith('/v1/patients')) return Promise.resolve([]);
    if (path.startsWith('/v1/branches')) return Promise.resolve([]);
    if (path.startsWith('/v1/revenue-protection/appointment-queue')) return Promise.resolve({ appointments: [] });
    if (path === GROWTH_POLICY_PATH) return options.policy ? options.policy() : Promise.resolve(growthPolicy());
    return Promise.reject(new Error(`Unexpected request in test: ${path}`));
  };
}

function renderPage() {
  return render(<MemoryRouter><Scheduling /></MemoryRouter>);
}

describe('Scheduling — the risk flag is the configured rule, not a literal', () => {
  it('flags at the default inclusive bound (>= 50): 55 and exactly 50 flagged, 49 not', async () => {
    respondWith({ appointments: [appointment('a', 55), appointment('b', 50), appointment('c', 49)] });
    renderPage();

    expect(await screen.findByText('55% risk')).toBeInTheDocument();
    expect(screen.getByText('50% risk')).toBeInTheDocument();
    expect(screen.queryByText('49% risk')).not.toBeInTheDocument();
    // The rule is stated beside the timeline, with its provenance.
    expect(screen.getByText(/stored risk ≥ 50/)).toBeInTheDocument();
    expect(screen.getByText(/Product default/)).toBeInTheDocument();
  });

  it('follows a tenant-configured threshold: at 70, a 55-risk row is no longer flagged', async () => {
    respondWith({
      appointments: [appointment('a', 55), appointment('b', 72)],
      policy: () => Promise.resolve(growthPolicy({ source: 'tenant', noShowRiskHigh: 70 })),
    });
    renderPage();

    expect(await screen.findByText('72% risk')).toBeInTheDocument();
    // Under the retired hardcoded `>= 50` this badge would render; under the
    // tenant's own rule it must not.
    expect(screen.queryByText('55% risk')).not.toBeInTheDocument();
    expect(screen.getByText(/stored risk ≥ 70/)).toBeInTheDocument();
    expect(screen.getByText(/Configured for this workspace/)).toBeInTheDocument();
  });

  it('flags nothing while the policy is still in flight — no provisional threshold', async () => {
    respondWith({ appointments: [appointment('a', 99)], policy: PENDING_FOREVER });
    renderPage();

    // The appointment itself renders; the risk claim does not.
    expect(await screen.findByText('Patient a')).toBeInTheDocument();
    expect(screen.queryByText('99% risk')).not.toBeInTheDocument();
    expect(screen.queryByText(/stored risk ≥/)).not.toBeInTheDocument();
  });

  it('names a failed policy read instead of silently hiding risk forever', async () => {
    respondWith({
      appointments: [appointment('a', 99)],
      policy: () => Promise.reject(new Error('boom')),
    });
    renderPage();

    expect(await screen.findByText('Patient a')).toBeInTheDocument();
    await waitFor(() => {
      const riskAlert = screen.getAllByRole('alert').find(el => /no-show risk threshold could not be loaded/i.test(el.textContent ?? ''));
      expect(riskAlert).toBeDefined();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('99% risk')).not.toBeInTheDocument();
  });

  it('refuses a policy payload without a usable noShowRiskHigh rather than coercing it', async () => {
    respondWith({
      appointments: [appointment('a', 99)],
      // A policy missing the field: Number(undefined) is NaN and NaN >= x is
      // always false, so coercion would silently unflag every appointment
      // while the page kept rendering. The adapter must throw into the shared
      // error state instead.
      policy: () => Promise.resolve({ source: 'tenant' }),
    });
    renderPage();

    expect(await screen.findByText('Patient a')).toBeInTheDocument();
    await waitFor(() => {
      const hiddenAlert = screen.getAllByRole('alert').find(el => /risk flags are hidden/i.test(el.textContent ?? ''));
      expect(hiddenAlert).toBeDefined();
    });
    expect(screen.queryByText('99% risk')).not.toBeInTheDocument();
  });
});
