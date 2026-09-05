import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
const sessionRole = vi.hoisted(() => ({ value: 'OWNER' }));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

vi.mock('../hooks/useSession', () => ({
  useSession: () => ({
    user: {
      id: 'user-1', role: sessionRole.value, displayName: 'Synthetic Reviewer', branchId: null,
      tenant: { id: 'tenant-1', name: 'Bright Health LLC', slug: 'bright-health' },
    },
  }),
}));

import RemoteMonitoring from './RemoteMonitoring';

function overview(criticalAlerts: number, patientName = 'All Clinics Patient') {
  return {
    summary: { readingsToday: 8, openAlerts: criticalAlerts, criticalAlerts, missedReadings: 1, offlineDevices: 0, patientsAtRisk: criticalAlerts, dayDefinition: 'Sum of each active clinic local day' },
    recentReadings: criticalAlerts ? [{
      id: `reading-${patientName}`, patientName, deviceName: 'Synthetic Glucose Meter', readingType: 'glucose',
      value: '155', unit: 'mg/dL', capturedAt: '2026-09-01T12:00:00.000Z', validationStatus: 'valid', source: 'device', trend: 'flat',
    }] : [],
    deviceHealth: [], notifications: [],
    assignableUsers: [{ id: 'manager-1', name: 'Clinic Manager', role: 'MANAGER', branchId: null }],
  };
}

function alertPage(patientName = 'All Clinics Patient') {
  return {
    items: [{
      id: `alert-${patientName}`, patientName, readingType: 'glucose', value: '155', unit: 'mg/dL', severity: 'critical', branchId: 'branch-1',
      alertType: 'abnormal_reading', status: 'open', assignedTo: null, generatedReason: 'Synthetic threshold event', createdAt: '2026-09-01T12:00:00.000Z',
    }],
    total: 1, limit: 100, truncated: false,
  };
}

function briefing() {
  return { generatedAt: '2026-09-01T12:00:00.000Z', counts: { criticalOpen: 0, missedHigh: 0, offlineDevices: 0 }, signals: [], disclaimer: 'Operational summary only.' };
}

function renderPage() {
  return render(<MemoryRouter><RemoteMonitoring /></MemoryRouter>);
}

beforeEach(() => {
  sessionRole.value = 'OWNER';
  apiRequestMock.mockReset();
});

describe('Connected Care scope and role integrity', () => {
  it('removes old clinic facts while a new clinic scope is loading and scopes every board request', async () => {
    let releaseBranch!: () => void;
    const branchGate = new Promise<void>(resolve => { releaseBranch = resolve; });
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === '/v1/branches?limit=100') return [
        { id: 'branch-1', name: 'Downtown Clinic' },
        { id: 'branch-2', name: 'Lakeside Clinic' },
      ];
      const scoped = path.includes('branchId=branch-2');
      if (scoped) await branchGate;
      if (path.startsWith('/v1/monitoring/overview')) return scoped ? overview(1, 'Lakeside Patient') : overview(5);
      if (path.startsWith('/v1/monitoring/alerts')) return scoped ? alertPage('Lakeside Patient') : alertPage();
      if (path.startsWith('/v1/monitoring/patients-at-risk')) return [];
      if (path.startsWith('/v1/monitoring/morning-briefing')) return briefing();
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage();

    expect(await screen.findByText('5 critical-priority open')).toBeInTheDocument();
    expect(screen.getAllByText('All Clinics Patient').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole('combobox', { name: 'Clinic scope' }), { target: { value: 'branch-2' } });

    expect(await screen.findByText('Checking critical queue')).toBeInTheDocument();
    expect(screen.queryByText('All Clinics Patient')).not.toBeInTheDocument();
    expect(screen.queryByText('5 critical-priority open')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    await act(async () => {
      releaseBranch();
      await branchGate;
    });
    expect(await screen.findByText('1 critical-priority open')).toBeInTheDocument();
    expect(screen.getAllByText('Lakeside Patient').length).toBeGreaterThan(0);
    for (const endpoint of ['overview', 'alerts', 'patients-at-risk', 'morning-briefing']) {
      expect(apiRequestMock).toHaveBeenCalledWith(`/v1/monitoring/${endpoint}?branchId=branch-2`);
    }
  });

  it('shows unknown metrics instead of false zeroes while the first response is pending', () => {
    apiRequestMock.mockImplementation((path: string) => path === '/v1/branches?limit=100' ? Promise.resolve([]) : new Promise<never>(() => {}));
    renderPage();

    expect(screen.getByText('Checking critical queue')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(6);
    expect(screen.queryByText('0 critical-priority open')).not.toBeInTheDocument();
  });

  it('never turns a failed clinical read into zeroes or genuine-empty claims', async () => {
    apiRequestMock.mockImplementation((path: string) => path === '/v1/branches?limit=100'
      ? Promise.resolve([{ id: 'branch-1', name: 'Downtown Clinic' }])
      : Promise.reject(new Error('Monitoring service unavailable')));
    renderPage();

    expect(await screen.findByText('Critical queue unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(6);
    expect(screen.getAllByText('Data unavailable')).toHaveLength(6);
    expect(screen.queryByText('No open workflow alerts')).not.toBeInTheDocument();
    expect(screen.queryByText('No readings captured yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('No patients flagged')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Current clinic data is unavailable/).length).toBeGreaterThan(0);
  });

  it('does not let an old-clinic mutation completion invalidate the newly selected clinic', async () => {
    let finishAction!: () => void;
    const actionGate = new Promise<void>(resolve => { finishAction = resolve; });
    apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/v1/branches?limit=100') return [{ id: 'branch-2', name: 'Lakeside Clinic' }];
      if (init?.method === 'PATCH') { await actionGate; return { status: 'acknowledged' }; }
      const scoped = path.includes('branchId=branch-2');
      if (path.startsWith('/v1/monitoring/overview')) return scoped ? overview(1, 'Lakeside Patient') : overview(5);
      if (path.startsWith('/v1/monitoring/alerts')) return scoped ? alertPage('Lakeside Patient') : alertPage();
      if (path.startsWith('/v1/monitoring/patients-at-risk')) return [];
      if (path.startsWith('/v1/monitoring/morning-briefing')) return briefing();
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Record acknowledged/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Clinic scope' }), { target: { value: 'branch-2' } });
    expect(await screen.findByText('1 critical-priority open')).toBeInTheDocument();
    expect(screen.getAllByText('Lakeside Patient').length).toBeGreaterThan(0);

    await act(async () => {
      finishAction();
      await actionGate;
    });
    await waitFor(() => expect(screen.getByText('1 critical-priority open')).toBeInTheDocument());
    expect(screen.getAllByText('Lakeside Patient').length).toBeGreaterThan(0);
    expect(apiRequestMock.mock.calls.filter(([path]) => path === '/v1/monitoring/overview')).toHaveLength(1);
  });

  it('keeps provider access read-only and does not render controls the API will refuse', async () => {
    sessionRole.value = 'PROVIDER';
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === '/v1/branches?limit=100') return [];
      if (path === '/v1/monitoring/overview') return overview(1);
      if (path === '/v1/monitoring/alerts') return alertPage();
      if (path === '/v1/monitoring/patients-at-risk') return [];
      if (path === '/v1/monitoring/morning-briefing') return briefing();
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage();

    expect(await screen.findByText(/Read-only clinical view/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record acknowledged/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Assign alert' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close workflow alert/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('1 critical-priority open')).toBeInTheDocument());
  });
});
