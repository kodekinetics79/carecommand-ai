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
 * A clinic could run a reminder campaign and still not see which appointments
 * were confirmed, because `Appointment.patientConfirmedAt` existed in the
 * database and nowhere in the product.
 *
 * The load-bearing assertion in every test below is the DISTINCTION.
 * `status: CONFIRMED` is the state every appointment is created in — it only
 * ever means "the clinic booked this" — while `patientConfirmedAt` is the
 * patient's own answer. Collapsing them, or letting one imply the other, would
 * put a green confirmation on a row nobody has ever spoken to, which is the
 * single failure this feature exists to prevent.
 *
 * The last test is the resourceState.ts contract: a schedule that failed to
 * load must not report that nobody has confirmed. "0 confirmed" and "we could
 * not ask" are indistinguishable on screen and mean opposite things.
 */

interface ConfirmationFields {
  patientConfirmedAt?: string | null;
  patientConfirmationSource?: string | null;
  patientConfirmedCallLogId?: string | null;
}

function appointment(id: string, confirmation: ConfirmationFields = {}) {
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
    // Every row is CONFIRMED, exactly as the database creates them. None of
    // these rows may render as patient-confirmed on the strength of that.
    status: 'CONFIRMED',
    noShowRisk: 10,
    channel: 'EMAIL',
    value: '180',
    notes: null,
    ...confirmation,
  };
}

const CONFIRMED_BY_CALL: ConfirmationFields = {
  patientConfirmedAt: '2026-08-31T13:14:00.000Z',
  patientConfirmationSource: 'receptionist_call',
  patientConfirmedCallLogId: '6f4d2b9c-1111-4a2b-9c3d-0f1e2d3c4b5a',
};

/** The grants the Studio's call queue and its call records actually require. */
const CALL_EVIDENCE_GRANTS = ['receptionist:call-artifacts:read', 'receptionist:manage'];

let respond: (path: string) => Promise<unknown>;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
});

function respondWith(options: {
  appointments?: unknown[] | (() => Promise<unknown>);
  permissions?: string[];
}) {
  respond = (path: string) => {
    if (path.startsWith('/v1/auth/me')) {
      return Promise.resolve({
        user: { id: 'user-1', role: 'MANAGER', displayName: 'Front Desk' },
        access: { permissions: options.permissions ?? [] },
      });
    }
    if (path.startsWith('/v1/appointments')) {
      return typeof options.appointments === 'function'
        ? options.appointments()
        : Promise.resolve(options.appointments ?? []);
    }
    if (path.startsWith('/v1/providers/overview')) return Promise.resolve([]);
    if (path.startsWith('/v1/patients')) return Promise.resolve([]);
    if (path.startsWith('/v1/branches')) return Promise.resolve([]);
    if (path.startsWith('/v1/revenue-protection/appointment-queue')) return Promise.resolve({ appointments: [] });
    if (path === GROWTH_POLICY_PATH) return Promise.resolve({ source: 'default', noShowRiskHigh: 50 });
    return Promise.reject(new Error(`Unexpected request in test: ${path}`));
  };
}

function renderPage() {
  return render(<MemoryRouter><Scheduling /></MemoryRouter>);
}

describe('Scheduling — a patient confirmation is visible, and is not the booking status', () => {
  it('shows the patient’s own answer, with how and when they gave it', async () => {
    respondWith({ appointments: [appointment('a', CONFIRMED_BY_CALL)] });
    renderPage();

    expect(await screen.findByText(/Patient said they’re coming/)).toBeInTheDocument();
    // Plain language, no source codes: never "receptionist_call".
    expect(screen.getByText(/Told us on a phone call/)).toBeInTheDocument();
    expect(screen.queryByText(/receptionist_call/)).not.toBeInTheDocument();
  });

  it('does NOT claim a patient confirmed a booking they were never asked about', async () => {
    respondWith({ appointments: [appointment('a')] });
    renderPage();

    // The row loads, and its status badge says only what status means: booked.
    expect(await screen.findByText('Patient a')).toBeInTheDocument();
    expect(screen.getByText('Booked')).toBeInTheDocument();
    // status CONFIRMED must never be rendered as the patient's confirmation.
    expect(screen.queryByText(/Patient said they’re coming/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Told us/)).not.toBeInTheDocument();
  });

  it('counts only real confirmations across the day, never the booked rows', async () => {
    respondWith({ appointments: [appointment('a', CONFIRMED_BY_CALL), appointment('b'), appointment('c')] });
    renderPage();

    // Three booked appointments; one patient has actually answered.
    expect(await screen.findByText(/1 of 3 patients have told us they’re coming\./)).toBeInTheDocument();
  });

  it('offers the call that evidences the confirmation to a user who can open it', async () => {
    respondWith({ appointments: [appointment('a', CONFIRMED_BY_CALL)], permissions: CALL_EVIDENCE_GRANTS });
    renderPage();

    const link = await screen.findByRole('button', { name: 'Open the call' });
    // The row's own sentence describes the control from OUTSIDE it: a date or a
    // count folded into a control's accessible name is how a tab once
    // announced as "Clinic Profile1".
    expect(link.getAttribute('aria-describedby')).toBe('appt-a-patient-confirmation');
    expect(link).toHaveAccessibleName('Open the call');
    // The description is the row's own sentence, and it does not contain the
    // control — a description holding the button's label would describe the
    // button to itself.
    const description = document.getElementById('appt-a-patient-confirmation');
    expect(description?.textContent).toMatch(/Told us on a phone call/);
    expect(description?.contains(link)).toBe(false);
  });

  it('hides the call link from a role that cannot open the call record', async () => {
    respondWith({ appointments: [appointment('a', CONFIRMED_BY_CALL)], permissions: [] });
    renderPage();

    // The confirmation itself is still shown — only the door that would 403 is
    // withheld, rather than offered and closed on arrival.
    expect(await screen.findByText(/Patient said they’re coming/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the call' })).not.toBeInTheDocument();
  });

  it('offers no call link when the confirmation was not produced by a call', async () => {
    respondWith({
      appointments: [appointment('a', { patientConfirmedAt: '2026-08-31T13:14:00.000Z', patientConfirmationSource: 'staff', patientConfirmedCallLogId: null })],
      permissions: CALL_EVIDENCE_GRANTS,
    });
    renderPage();

    expect(await screen.findByText(/Told us to a member of staff/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the call' })).not.toBeInTheDocument();
  });

  it('reports a failed schedule load as unavailable, never as "nobody has confirmed"', async () => {
    respondWith({ appointments: () => Promise.reject(new Error('boom')) });
    renderPage();

    await waitFor(() => {
      const failure = screen.getAllByRole('alert').find(el => /Scheduling data is unavailable/i.test(el.textContent ?? ''));
      expect(failure).toBeDefined();
    });
    // No confirmation count at all — not "0 of 0", not a dash, not "none".
    expect(screen.queryByText(/told us they’re coming/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nobody has answered a reminder yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Patient said they’re coming/)).not.toBeInTheDocument();
  });
});
