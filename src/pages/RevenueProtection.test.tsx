import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
const overviewMock = vi.hoisted(() => vi.fn());
const capabilitiesMock = vi.hoisted(() => vi.fn());
const queueMock = vi.hoisted(() => vi.fn());
const sessionPermissions = vi.hoisted(() => ({ value: ['billing:read', 'billing:write', 'patient:read', 'revenue:read'] }));
const sessionUser = vi.hoisted(() => ({ role: 'OWNER', branchId: null as string | null }));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

vi.mock('../hooks/useSession', () => ({
  useSession: () => ({ user: { ...sessionUser, effectivePermissions: sessionPermissions.value } }),
}));

vi.mock('../lib/revenueProtection', async () => {
  const actual = await vi.importActual<typeof import('../lib/revenueProtection')>('../lib/revenueProtection');
  return {
    ...actual,
    fetchRevenueProtectionOverview: overviewMock,
    fetchRevenueProtectionCapabilities: capabilitiesMock,
    fetchAppointmentVerificationQueue: queueMock,
  };
});

import RevenueProtection from './RevenueProtection';
import { clearSession, selectClinic } from '../lib/session';

const capabilities = {
  eligibility: { key: 'eligibility_checks', label: 'Eligibility checks', state: 'test_data', detail: 'Uses synthetic test responses.', usable: true },
  cardPayments: { key: 'card_payments', label: 'Card payments', state: 'test_data', detail: 'Uses synthetic payment records.', usable: true },
  payerCount: 0,
  recentRuns: 0,
  latestRun: null,
};

function overview(unpaidBalances: number) {
  return {
    summary: {
      paymentsDueToday: 0,
      copaysExpected: unpaidBalances,
      depositsCollected: 0,
      unpaidBalances,
      failedPayments: 0,
      revenueProtected: 770,
      revenueAtRisk: 0,
    },
    insurancePayers: [],
    patientInsurancePolicies: [],
    eligibilityVerifications: [],
    patientResponsibilityEstimates: [],
    priorAuthorizations: [],
    paymentRequests: [],
    paymentTransactions: [],
    depositRules: [],
    depositRequirements: [],
    revenueProtectionAlerts: [],
    integrationRunLogs: [],
  };
}

beforeEach(() => {
  clearSession(false);
  sessionPermissions.value = ['billing:read', 'billing:write', 'patient:read', 'revenue:read'];
  sessionUser.role = 'OWNER';
  sessionUser.branchId = null;
  apiRequestMock.mockReset();
  overviewMock.mockReset();
  capabilitiesMock.mockReset();
  queueMock.mockReset();
  apiRequestMock.mockResolvedValue([
    { id: 'branch-1', name: 'Downtown Clinic', location: 'Main Street' },
    { id: 'branch-2', name: 'Lakeside Clinic', location: 'Lake Avenue' },
  ]);
  overviewMock.mockResolvedValue(overview(530));
  capabilitiesMock.mockResolvedValue(capabilities);
  queueMock.mockResolvedValue({ appointments: [] });
});

function renderPage() {
  return render(<MemoryRouter><RevenueProtection /></MemoryRouter>);
}

describe('Revenue Operations scope integrity', () => {
  it('never labels clinic-scoped Billing totals as All clinics', async () => {
    sessionUser.role = 'BILLING';
    sessionUser.branchId = 'branch-1';
    renderPage();

    const selector = await screen.findByRole('combobox', { name: 'Clinic scope' });

    expect(selector).toHaveValue('branch-1');
    expect(screen.queryByRole('option', { name: 'All clinics' })).not.toBeInTheDocument();
    expect(overviewMock).toHaveBeenCalledWith('branch-1');
  });

  it('keeps the revenue selector synchronized with the global clinic switcher', async () => {
    sessionUser.role = 'BILLING';
    sessionUser.branchId = 'branch-1';
    renderPage();

    const selector = await screen.findByRole('combobox', { name: 'Clinic scope' });
    expect(selector).toHaveValue('branch-1');

    act(() => selectClinic('tenant-1', 'branch-2'));

    await waitFor(() => expect(selector).toHaveValue('branch-2'));
    await waitFor(() => expect(overviewMock).toHaveBeenCalledWith('branch-2'));
  });

  it('removes old clinic money while the newly selected clinic is loading', async () => {
    let resolveClinic!: (value: ReturnType<typeof overview>) => void;
    const clinicOverview = new Promise<ReturnType<typeof overview>>(resolve => { resolveClinic = resolve; });
    overviewMock.mockImplementation((branchId?: string) => branchId === 'branch-2' ? clinicOverview : Promise.resolve(overview(530)));
    renderPage();

    expect(await screen.findAllByText('$530')).not.toHaveLength(0);
    fireEvent.change(screen.getByRole('combobox', { name: 'Clinic scope' }), { target: { value: 'branch-2' } });

    expect(await screen.findByText(/Loading revenue and insurance records for the selected clinic scope/)).toBeInTheDocument();
    expect(screen.queryByText('$530')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    await act(async () => {
      resolveClinic(overview(100));
      await clinicOverview;
    });
    expect((await screen.findAllByText('$100')).length).toBeGreaterThan(0);
    expect(overviewMock).toHaveBeenCalledWith('branch-2');
  });

  it('reloads the appointment verification queue when Refresh is used', async () => {
    renderPage();
    await waitFor(() => expect(queueMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(queueMock).toHaveBeenCalledTimes(2));
    expect(overviewMock).toHaveBeenCalledTimes(2);
  });

  it('shows the clinic-local appointment date, time, and timezone', async () => {
    queueMock.mockResolvedValue({
      appointments: [{
        id: 'appointment-1', branchId: 'branch-1', branchName: 'Downtown Clinic', clinicTimezone: 'America/New_York',
        patientId: 'patient-1', patientName: 'Avery Patient', appointmentTime: '2026-01-05T15:00:00.000Z',
        serviceType: 'Annual wellness', payerName: 'Test Payer', memberId: 'SYNTHETIC-1',
        eligibilityStatus: 'Not Verified', copay: 0, deductibleRemaining: 0, priorAuthStatus: 'Not Required',
        coverageActive: false, coverageStatus: 'not_verified', providerMode: 'mock',
        recommendedAction: 'Verify insurance before the appointment.', riskLevel: 'LOW',
      }],
    });
    renderPage();

    expect(await screen.findByText(/Jan 5, 10:00 AM EST/)).toBeInTheDocument();
    expect(screen.getAllByText('Downtown Clinic').length).toBeGreaterThan(0);
  });

  it('keeps mutation controls disabled for billing-read-only staff', async () => {
    sessionPermissions.value = ['billing:read'];
    renderPage();

    expect(await screen.findByText(/Read-only revenue access/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Payments & Deposits' }));
    expect(screen.getByRole('button', { name: 'Create Rule' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Deposit rule name' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Ask Advisors' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open CRM' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revenue Leaks' })).not.toBeInTheDocument();
  });
});
