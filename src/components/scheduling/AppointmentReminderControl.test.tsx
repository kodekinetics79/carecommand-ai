import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { AppointmentCommunicationPlan } from '../../lib/appointments';
import AppointmentReminderControl from './AppointmentReminderControl';

function plan(overrides: Partial<AppointmentCommunicationPlan> = {}): AppointmentCommunicationPlan {
  return {
    mode: 'NONE',
    status: 'PAUSED',
    reminderLeadMinutes: 1440,
    revision: null,
    appointmentVersion: 1,
    messages: [],
    summary: 'No reminders selected',
    ...overrides,
  };
}

beforeEach(() => apiRequestMock.mockReset());

describe('AppointmentReminderControl', () => {
  it('loads lazily and saves Text with the exact appointment version and plan revision', async () => {
    apiRequestMock.mockImplementation((_path: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(plan());
      return Promise.resolve(plan({
        mode: 'SMS', status: 'ACTIVE', revision: 1,
        messages: [{ channel: 'SMS', state: 'scheduled', dueAt: '2026-09-08T14:00:00.000Z' }],
        summary: 'Text reminder scheduled',
      }));
    });
    render(<AppointmentReminderControl appointmentId="appointment-1" appointmentVersion={1} canEdit eligible />);

    expect(apiRequestMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Reminders/ }));
    expect(await screen.findByRole('radio', { name: 'None' })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'Text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save reminder choice' }));

    expect(await screen.findByText('Text reminder scheduled')).toBeInTheDocument();
    const saveCall = apiRequestMock.mock.calls.find(call => call[1]?.method === 'PUT');
    expect(saveCall?.[0]).toBe('/v1/appointments/appointment-1/communication-plan');
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      mode: 'SMS', reminderLeadMinutes: 1440, appointmentVersion: 1, revision: null,
    });
  });

  it('shows setup-needed truth for Call without exposing phone or supplier identifiers', async () => {
    apiRequestMock.mockImplementation((_path: string, init?: RequestInit) => init
      ? Promise.resolve(plan({
        mode: 'VOICE', status: 'BLOCKED_SETUP', revision: 1,
        messages: [{ channel: 'VOICE', state: 'setup_needed', dueAt: '2026-09-08T14:00:00.000Z' }],
        summary: 'Call reminder selected; automation setup needed',
      }))
      : Promise.resolve(plan()));
    render(<AppointmentReminderControl appointmentId="appointment-1" appointmentVersion={1} canEdit eligible />);

    fireEvent.click(screen.getByRole('button', { name: /Reminders/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Call' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save reminder choice' }));

    const warning = await screen.findByText('Will not send until automatic reminders are set up. Call reminder selected.');
    expect(warning.parentElement).toHaveClass('border-amber-500/60');
    expect(warning.parentElement).not.toHaveClass('bg-[var(--emerald-soft)]');
    // Supplier vocabulary is enforced across every tenant-facing source file
    // by vendorNeutralityLint; this component additionally proves that no
    // technical caller number leaks into the setup-needed state.
    expect(document.body).not.toHaveTextContent(/\+1\d{10}/i);
  });

  it('names an optimistic conflict and refreshes to the current choice before retry', async () => {
    let gets = 0;
    apiRequestMock.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.reject(new ApiError(409, 'Reminder choices changed; refresh before saving'));
      gets += 1;
      return Promise.resolve(gets === 1 ? plan() : plan({
        mode: 'BOTH', status: 'BLOCKED_SETUP', revision: 2,
        summary: 'Text and call reminders selected; automation setup needed',
      }));
    });
    render(<AppointmentReminderControl appointmentId="appointment-1" appointmentVersion={1} canEdit eligible />);

    fireEvent.click(screen.getByRole('button', { name: /Reminders/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save reminder choice' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/changed elsewhere/i);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh reminders' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Both' })).toBeChecked());
    expect(screen.getByText('Will not send until automatic reminders are set up. Text and call reminders selected.')).toBeInTheDocument();
  });

  it('keeps the four keyboard-native choices visible but read-only when the appointment is not eligible', async () => {
    apiRequestMock.mockResolvedValue(plan({ mode: 'SMS', revision: 1, summary: 'Text reminder selected; automation setup needed' }));
    render(<AppointmentReminderControl appointmentId="appointment-1" appointmentVersion={1} canEdit eligible={false} />);

    fireEvent.click(screen.getByRole('button', { name: /Reminders/ }));
    expect(await screen.findAllByRole('radio')).toHaveLength(4);
    expect(screen.getByRole('radio', { name: 'Text' })).toBeDisabled();
    expect(screen.getByText(/only be changed for an upcoming booked appointment/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save reminder choice' })).not.toBeInTheDocument();
  });
});
