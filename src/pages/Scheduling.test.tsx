import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { GROWTH_POLICY_PATH } from '../lib/growthPolicy';
import { todayInZone } from '../lib/clinicTime';
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
  const startsAt = new Date(`${todayInZone('UTC')}T14:30:00.000Z`);
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
  appointmentResponse?: (path: string) => unknown;
  branches?: unknown[];
  branchResponse?: () => Promise<unknown>;
  queueResponse?: unknown;
  policy?: () => Promise<unknown>;
}) {
  respond = (path: string) => {
    if (path.startsWith('/v1/auth/me')) {
      return Promise.resolve({ user: { id: 'user-1', role: 'MANAGER', displayName: 'Front Desk' }, access: { permissions: [] } });
    }
    if (path.startsWith('/v1/appointments')) return Promise.resolve(options.appointmentResponse ? options.appointmentResponse(path) : options.appointments ?? []);
    if (path.startsWith('/v1/providers/overview')) return Promise.resolve([]);
    if (path.startsWith('/v1/patients')) return Promise.resolve([]);
    if (path.startsWith('/v1/branches')) return options.branchResponse
      ? options.branchResponse()
      : Promise.resolve(options.branches ?? [{ id: 'branch-1', name: 'Downtown', timezone: 'UTC' }]);
    if (path.startsWith('/v1/revenue-protection/appointment-queue')) return Promise.resolve(options.queueResponse ?? { appointments: [] });
    if (path === GROWTH_POLICY_PATH) return options.policy ? options.policy() : Promise.resolve(growthPolicy());
    return Promise.reject(new Error(`Unexpected request in test: ${path}`));
  };
}

function renderPage() {
  return render(<MemoryRouter><Scheduling /></MemoryRouter>);
}

describe('Scheduling — a new booking inherits the selected clinic date', () => {
  it('opens on the board date instead of an empty native date input', async () => {
    respondWith({
      branches: [{ id: 'branch-1', name: 'Downtown', timezone: 'UTC' }],
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Book appointment' }));

    expect(screen.getByLabelText('Date')).toHaveValue(todayInZone('UTC'));
  });
});

describe('Scheduling — all-clinic scope respects each clinic local day', () => {
  it('keeps every insurance action reachable on narrow screens and names a capped queue', async () => {
    respondWith({
      queueResponse: {
        truncated: true,
        appointments: [{
          id: 'queue-1', branchId: 'branch-1', branchName: 'Downtown', patientId: 'patient-1', patientName: 'Patient Queue',
          appointmentTime: `${todayInZone('UTC')}T15:00:00.000Z`, serviceType: 'Consultation', payerName: 'Synthetic Payer', memberId: 'SYN-1',
          eligibilityStatus: 'Not Verified', copay: 0, deductibleRemaining: 0, priorAuthStatus: 'Not Required', coverageActive: false,
          coverageStatus: 'not_verified', providerMode: 'simulator', recommendedAction: 'Verify', riskLevel: 'HIGH',
        }],
      },
    });
    renderPage();

    const patient = await screen.findByText('Patient Queue');
    const table = patient.closest('table');
    expect(table).not.toBeNull();
    expect(table?.parentElement).toHaveClass('overflow-x-auto');
    expect(screen.getByText(/first 100 verification rows are shown/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request eligibility response' })).toBeInTheDocument();
  });

  it('hides timezone-dependent appointments and retries branch metadata when clinic scope fails', async () => {
    respondWith({
      appointments: [{ ...appointment('unsafe', 10), startsAt: '2026-09-01T13:30:00.000Z' }],
      branchResponse: () => Promise.reject(new Error('branches unavailable')),
    });
    renderPage();

    expect(await screen.findByText(/clinic timezone data is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Patient unsafe')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.getByText(/^Appointments are unavailable until clinic timezones load\.$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Insurance appointments are unavailable until clinic timezones load\.$/i)).toBeInTheDocument();
    expect(screen.queryByText(/no appointments match/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book appointment' })).toBeDisabled();
    const branchCallsBeforeRetry = apiRequestMock.mock.calls.filter(call => String(call[0]).startsWith('/v1/branches')).length;
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    await waitFor(() => {
      const branchCalls = apiRequestMock.mock.calls.filter(call => String(call[0]).startsWith('/v1/branches')).length;
      expect(branchCalls).toBeGreaterThan(branchCallsBeforeRetry);
    });
  });

  it('continues through appointment pages instead of silently stopping at the first 100 rows', async () => {
    respondWith({
      branches: [{ id: 'branch-1', name: 'Downtown', timezone: 'UTC' }],
      appointmentResponse: path => path.includes('cursor=page-2')
        ? { data: [{ ...appointment('second-page', 10), startsAt: '2026-09-01T14:30:00.000Z' }] }
        : { data: [{ ...appointment('first-page', 10), startsAt: '2026-09-01T13:30:00.000Z' }], nextCursor: 'page-2' },
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Pick a date'), { target: { value: '2026-09-01' } });
    expect(await screen.findByText('Patient first-page')).toBeInTheDocument();
    expect(await screen.findByText('Patient second-page')).toBeInTheDocument();
    expect(apiRequestMock.mock.calls.some(call => String(call[0]).includes('cursor=page-2'))).toBe(true);
  });

  it('uses the union day window, filters by each appointment branch, and makes duplicate clinic names distinct', async () => {
    respondWith({
      branches: [
        { id: 'branch-la', name: 'Synthetic Clinic', timezone: 'America/Los_Angeles' },
        { id: 'branch-ny', name: 'Synthetic Clinic', timezone: 'America/New_York' },
      ],
      appointments: [
        { ...appointment('la', 10), branchId: 'branch-la', startsAt: '2026-09-01T07:30:00.000Z' },
        { ...appointment('ny', 10), branchId: 'branch-ny', startsAt: '2026-09-02T03:30:00.000Z' },
        { ...appointment('tomorrow', 10), branchId: 'branch-ny', startsAt: '2026-09-02T04:30:00.000Z' },
      ],
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Pick a date'), { target: { value: '2026-09-01' } });

    expect(await screen.findByText('Patient la')).toBeInTheDocument();
    expect(screen.getByText('Patient ny')).toBeInTheDocument();
    expect(screen.queryByText('Patient tomorrow')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Synthetic Clinic · America/Los_Angeles, America/Los_Angeles' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Synthetic Clinic · America/New_York, America/New_York' })).toBeInTheDocument();

    await waitFor(() => {
      const requested = apiRequestMock.mock.calls.map(call => String(call[0]));
      expect(requested.some(path => path.includes('/v1/appointments?limit=100')
        && path.includes('from=2026-09-01T04:00:00.000Z')
        && path.includes('to=2026-09-02T07:00:00.000Z'))).toBe(true);
    });
  });

  it('shows and edits an appointment in its own branch timezone', async () => {
    respondWith({
      branches: [
        { id: 'branch-la', name: 'West Clinic', timezone: 'America/Los_Angeles' },
        { id: 'branch-ny', name: 'East Clinic', timezone: 'America/New_York' },
      ],
      appointments: [
        { ...appointment('ny', 10), branchId: 'branch-ny', startsAt: '2026-09-02T03:30:00.000Z' },
      ],
    });
    renderPage();

    fireEvent.change(await screen.findByLabelText('Pick a date'), { target: { value: '2026-09-01' } });
    const patient = await screen.findByText('Patient ny');
    const row = patient.closest('[data-appointment-id]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/11:30 PM EDT/)).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/East Clinic/)).toBeInTheDocument();

    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Reschedule' }));
    expect(within(row as HTMLElement).getByLabelText('New date')).toHaveValue('2026-09-01');
    expect(within(row as HTMLElement).getByLabelText('New time')).toHaveValue('23:30');
  });
});

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
