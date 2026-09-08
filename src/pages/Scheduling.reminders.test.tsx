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

const patient = {
  id: 'patient-1', branchId: 'branch-1', firstName: 'Avery', lastName: 'Jordan',
  lifecycleStage: 'ACTIVE', churnRisk: 0, lifetimeValue: '0', outstandingBalance: '0', tags: [],
};

const provider = {
  id: 'provider-1', branchId: 'branch-1', specialty: 'Primary care', active: true,
  utilization: 0, appointmentsToday: 0, appointmentsThisMonth: 0, rating: '5', reviewCount: 0,
  revenueThisMonth: '0', repeatVisitRate: 0, followUpRate: 0,
  branch: { name: 'Bright Health' }, user: { displayName: 'Dr Rivera' }, _count: { availability: 1 },
};

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/v1/auth/me') return Promise.resolve({
      user: { id: 'user-1', role: 'MANAGER', displayName: 'Practice manager' },
      access: { permissions: ['appointment:read', 'appointment:write'] },
    });
    if (path.startsWith('/v1/branches')) return Promise.resolve([{ id: 'branch-1', name: 'Bright Health', timezone: 'UTC' }]);
    if (path.startsWith('/v1/appointments') && path.endsWith('/communication-plan') && init?.method === 'PUT') {
      return Promise.resolve({
        mode: 'SMS', status: 'BLOCKED_SETUP', reminderLeadMinutes: 1440, revision: 1, appointmentVersion: 1,
        messages: [{ channel: 'SMS', state: 'setup_needed', dueAt: '2026-09-08T14:00:00.000Z' }],
        summary: 'Text reminder selected; automation setup needed',
      });
    }
    if (path.startsWith('/v1/appointments')) return Promise.resolve([]);
    if (path.startsWith('/v1/providers/overview')) return Promise.resolve([provider]);
    if (path.startsWith('/v1/patients')) return Promise.resolve([patient]);
    if (path === '/v1/services') return Promise.resolve([]);
    if (path.startsWith('/v1/revenue-protection/appointment-queue')) return Promise.resolve({ appointments: [] });
    if (path === GROWTH_POLICY_PATH) return Promise.resolve({ source: 'default', noShowRiskHigh: 50 });
    if (path.startsWith('/v1/scheduling/providers/provider-1/slots')) {
      return Promise.resolve({ providerId: 'provider-1', date: todayInZone('UTC'), slots: [{ startsAt: `${todayInZone('UTC')}T14:00:00.000Z`, endsAt: `${todayInZone('UTC')}T14:30:00.000Z` }] });
    }
    if (path === '/v1/scheduling/providers/provider-1/book' && init?.method === 'POST') return Promise.resolve({ id: 'appointment-new', version: 1 });
    return Promise.reject(new Error(`Unexpected request in test: ${path}`));
  });
});

describe('Scheduling booking reminders', () => {
  it('defaults to None and saves the chosen reminder after canonical booking', async () => {
    render(<MemoryRouter><Scheduling /></MemoryRouter>);

    const trigger = await screen.findByRole('button', { name: 'Book appointment' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Book appointment' });
    expect(screen.getByLabelText('Search patients')).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'None' })).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(4);

    fireEvent.change(screen.getByLabelText('Patient'), { target: { value: 'patient-1' } });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'Annual wellness visit' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'provider-1' } });
    fireEvent.click(await screen.findByRole('button', { name: /2:00 PM/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Text' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Book appointment' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Will not send until automatic reminders are set up. Text reminder selected. Appointment booked.');
    const reminderCall = apiRequestMock.mock.calls.find(call => String(call[0]).endsWith('/appointment-new/communication-plan'));
    expect(reminderCall?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(reminderCall?.[1]?.body))).toEqual({ mode: 'SMS', appointmentVersion: 1, revision: null });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Book appointment' })).not.toBeInTheDocument());
  });

  it('traps focus, closes with Escape, and restores focus to the booking trigger', async () => {
    render(<MemoryRouter><Scheduling /></MemoryRouter>);
    const trigger = await screen.findByRole('button', { name: 'Book appointment' });
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Book appointment' });
    const closeButtons = within(dialog).getAllByRole('button', { name: 'Close booking dialog' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(closeButtons[1]).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Book appointment' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('revalidates the insurance queue after a same-day reschedule', async () => {
    const day = todayInZone('UTC');
    let moved = false;
    let queueReads = 0;
    apiRequestMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/v1/auth/me') return Promise.resolve({
        user: { id: 'user-1', role: 'MANAGER', displayName: 'Practice manager' },
        access: { permissions: ['appointment:read', 'appointment:write'] },
      });
      if (path.startsWith('/v1/branches')) return Promise.resolve([{ id: 'branch-1', name: 'Bright Health', timezone: 'UTC' }]);
      if (path.endsWith('/appointment-1/reschedule') && init?.method === 'PATCH') {
        moved = true;
        return Promise.resolve({ id: 'appointment-1' });
      }
      if (path.startsWith('/v1/appointments')) return Promise.resolve([{
        id: 'appointment-1', patientId: 'patient-1', patientName: 'Avery Jordan', providerRef: 'Dr Rivera',
        branchId: 'branch-1', service: 'Annual wellness visit', startsAt: `${day}T${moved ? '15:00' : '14:30'}:00.000Z`,
        status: 'CONFIRMED', noShowRisk: 0, channel: 'EMAIL', value: '0', notes: null, version: moved ? 2 : 1,
      }]);
      if (path.startsWith('/v1/providers/overview')) return Promise.resolve([]);
      if (path.startsWith('/v1/patients')) return Promise.resolve([]);
      if (path === '/v1/services') return Promise.resolve([]);
      if (path.startsWith('/v1/revenue-protection/appointment-queue')) {
        queueReads += 1;
        return Promise.resolve({ appointments: [{
          id: 'appointment-1', branchId: 'branch-1', branchName: 'Bright Health', patientId: 'patient-1', patientName: 'Avery Jordan',
          appointmentTime: `${day}T${moved ? '15:00' : '14:30'}:00.000Z`, serviceType: 'Annual wellness visit', payerName: null, memberId: null,
          eligibilityStatus: 'Not Verified', copay: 0, deductibleRemaining: 0, priorAuthStatus: 'Not Required', coverageActive: false,
          coverageStatus: 'not_verified', providerMode: 'mock', recommendedAction: 'Verify', riskLevel: 'LOW',
        }] });
      }
      if (path === GROWTH_POLICY_PATH) return Promise.resolve({ source: 'default', noShowRiskHigh: 50 });
      return Promise.reject(new Error(`Unexpected request in test: ${path}`));
    });

    render(<MemoryRouter><Scheduling /></MemoryRouter>);
    const patientName = await screen.findAllByText('Avery Jordan');
    const appointmentRow = patientName.map(node => node.closest('[data-appointment-id]')).find(Boolean) as HTMLElement;
    fireEvent.click(within(appointmentRow).getByRole('button', { name: 'Reschedule' }));
    fireEvent.change(within(appointmentRow).getByLabelText('New time'), { target: { value: '15:00' } });
    fireEvent.click(within(appointmentRow).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(queueReads).toBeGreaterThan(1));
    const queueRow = screen.getAllByText('Avery Jordan')
      .map(node => node.closest('tr'))
      .find(Boolean) as HTMLTableRowElement;
    expect(queueRow).toHaveTextContent('3:00 PM UTC');
    expect(queueRow).not.toHaveTextContent('2:30 PM UTC');
  });
});
