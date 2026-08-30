import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import { resetFrontDeskPollForTests } from '../../hooks/useFrontDeskPoll';
import { BookItDialog } from './BookItDialog';
import type { AppointmentRequestRow } from '../../lib/frontDesk';

/**
 * "Book it" is the last step of the primary inbound loop: unknown caller →
 * booking request → booked. Everything asserted here is a way that step failed
 * on day 1 (E1, E15) — a 400 nobody could read, a modal a keyboard user fell
 * out of, a promised phone link nothing made, and providers offered who could
 * never have an open slot.
 */

const REQUEST: AppointmentRequestRow = {
  id: 'req-1', branchId: 'branch-1', patientId: null, campaignId: null, callLogId: 'call-2',
  requestedService: 'Cleaning', requestedDateTime: '2026-09-01T17:00:00.000Z',
  collectedName: 'Priya Shah', collectedPhoneMasked: '***-***-9090', collectedEmail: null,
  status: 'PENDING_REVIEW', source: 'voice', missingFields: [], outcomeReason: null,
  bookedAppointmentId: null, bookedAppointment: null,
  callLog: { id: 'call-2', retellCallId: 'c', callerName: 'Priya Shah', direction: 'inbound', startedAt: null, clinicId: 'clinic-1', patientId: null },
  patient: null, createdAt: '2026-08-29T17:01:00.000Z',
};

const SERVICES = [
  { id: 'svc-1', name: 'Cleaning', category: 'hygiene', active: true, defaultDurationMinutes: 30, bookableByVoice: true, voiceDurationMinutes: 30 },
  { id: 'svc-2', name: 'Crown fitting', category: 'restorative', active: true, defaultDurationMinutes: 60, bookableByVoice: false, voiceDurationMinutes: null },
  { id: 'svc-3', name: 'Retired whitening', category: 'cosmetic', active: false, defaultDurationMinutes: 45, bookableByVoice: true, voiceDurationMinutes: 45 },
];

type Handler = (path: string, init?: RequestInit) => unknown;
let routes: Array<[RegExp, string, Handler]>;
function route(method: string, pattern: RegExp, handler: Handler) { routes.unshift([pattern, method, handler]); }

function providers(availability = 4) {
  return [
    { id: 'prov-1', branchId: 'branch-1', active: true, specialty: 'Dentistry', branch: { name: 'Main' }, user: { displayName: 'Dr Wu' }, _count: { availability } },
    { id: 'prov-2', branchId: 'branch-1', active: true, specialty: 'Hygiene', branch: { name: 'Main' }, user: { displayName: 'Dr Ada' }, _count: { availability: 0 } },
  ];
}

function happyPath() {
  route('GET', /^\/v1\/providers\/overview/, () => providers());
  route('GET', /^\/v1\/services$/, () => SERVICES);
  route('GET', /^\/v1\/scheduling\/providers\/prov-1\/slots/, () => ({
    providerId: 'prov-1', date: '2026-09-01', slots: [{ startsAt: '2026-09-01T17:00:00.000Z', endsAt: '2026-09-01T17:30:00.000Z' }],
  }));
}

beforeEach(() => {
  routes = [];
  resetFrontDeskPollForTests();
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const match = routes.find(([pattern, verb]) => verb === method && pattern.test(path));
    if (!match) throw new Error(`Unexpected request in test: ${method} ${path}`);
    return match[2](path, init);
  });
});

afterEach(() => resetFrontDeskPollForTests());

function renderDialog(overrides: Partial<AppointmentRequestRow> = {}) {
  const onBooked = vi.fn();
  const onClose = vi.fn();
  const result = render(
    <BookItDialog request={{ ...REQUEST, ...overrides }} timezone="America/Los_Angeles" onClose={onClose} onBooked={onBooked} />,
  );
  return { ...result, onBooked, onClose };
}

async function fillOut(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('Provider'), { target: { value: 'prov-1' } });
  fireEvent.change(within(dialog).getByLabelText(/First name/), { target: { value: 'Priya' } });
  fireEvent.change(within(dialog).getByLabelText(/Last name/), { target: { value: 'Shah' } });
  await within(dialog).findByLabelText('Open slot');
  fireEvent.click(within(dialog).getByRole('checkbox'));
}

describe('BookItDialog — the body the server accepts (E1)', () => {
  it('sends createPatient as a sibling of patientId, with no branchId', async () => {
    happyPath();
    const booked = vi.fn(() => ({ status: 'BOOKED', appointment: { id: 'a1', service: 'Cleaning', startsAt: '2026-09-01T17:00:00.000Z' }, confirmationsQueued: [] }));
    route('POST', /^\/v1\/receptionist\/appointment-requests\/req-1\/book$/, booked);
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    await fillOut(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm booking/ }));

    await waitFor(() => expect(booked).toHaveBeenCalled());
    const body = JSON.parse(String((booked.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.createPatient).toEqual({ firstName: 'Priya', lastName: 'Shah' });
    expect(body).not.toHaveProperty('patientId');
  });

  it('sends a plain uuid patientId when an existing patient is linked', async () => {
    happyPath();
    const booked = vi.fn(() => ({ status: 'BOOKED', appointment: { id: 'a1', service: 'Cleaning', startsAt: '2026-09-01T17:00:00.000Z' }, confirmationsQueued: [] }));
    route('POST', /^\/v1\/receptionist\/appointment-requests\/req-1\/book$/, booked);
    renderDialog({ patientId: 'patient-9', patient: { firstName: 'Priya', lastName: 'Shah' } });
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    fireEvent.change(within(dialog).getByLabelText('Provider'), { target: { value: 'prov-1' } });
    await within(dialog).findByLabelText('Open slot');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm booking/ }));

    await waitFor(() => expect(booked).toHaveBeenCalled());
    const body = JSON.parse(String((booked.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.patientId).toBe('patient-9');
    expect(body).not.toHaveProperty('createPatient');
  });
});

describe('BookItDialog — the caller keeps their phone number (E15)', () => {
  it('sends the revealed caller number as createPatient.phone', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/appointment-requests\/req-1$/, () => ({ ...REQUEST, collectedPhone: '+14155559090', rawCollectedFields: null }));
    const booked = vi.fn(() => ({ status: 'BOOKED', appointment: { id: 'a1', service: 'Cleaning', startsAt: '2026-09-01T17:00:00.000Z' }, confirmationsQueued: [] }));
    route('POST', /^\/v1\/receptionist\/appointment-requests\/req-1\/book$/, booked);
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });

    fireEvent.click(within(dialog).getByRole('button', { name: /Use the caller's number/ }));
    expect(await within(dialog).findByText('Taken from the call. The reveal was logged.')).toBeInTheDocument();
    await fillOut(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm booking/ }));

    await waitFor(() => expect(booked).toHaveBeenCalled());
    const body = JSON.parse(String((booked.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.createPatient.phone).toBe('+14155559090');
  });

  it('says the number could not be read rather than booking a patient with no phone silently', async () => {
    happyPath();
    route('GET', /^\/v1\/receptionist\/appointment-requests\/req-1$/, () => { throw new ApiError(403, 'Your role cannot read call artifacts.', 'FORBIDDEN'); });
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    fireEvent.click(within(dialog).getByRole('button', { name: /Use the caller's number/ }));
    expect(await within(dialog).findByText(/could not be read: Your role cannot read call artifacts\./)).toBeInTheDocument();
  });

  it('refuses to submit a phone that is not E.164, and says why', async () => {
    happyPath();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    await fillOut(dialog);
    fireEvent.change(within(dialog).getByLabelText('Phone'), { target: { value: '415-555-9090' } });

    expect(within(dialog).getByRole('button', { name: /Confirm booking/ })).toBeDisabled();
    expect(within(dialog).getByText(/must be E.164/)).toBeInTheDocument();
  });

  it('no longer claims the server links a phone it never copies', async () => {
    happyPath();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    expect(within(dialog).queryByText(/is linked by the server/)).not.toBeInTheDocument();
  });
});

describe('BookItDialog — providers and services the desk can actually use (E15)', () => {
  it('disables a provider with no availability and points at Scheduling', async () => {
    happyPath();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    const picker = await within(dialog).findByLabelText('Provider');
    const unavailable = within(picker).getByRole('option', { name: /Dr Ada/ });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveTextContent('no working hours set');
    expect(within(dialog).getByRole('link', { name: 'Set availability in Scheduling' })).toHaveAttribute('href', '/scheduling');
  });

  it('says so plainly when NO provider has availability, instead of an endless date hunt', async () => {
    routes = [];
    route('GET', /^\/v1\/providers\/overview/, () => providers(0));
    route('GET', /^\/v1\/services$/, () => SERVICES);
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    expect(await within(dialog).findByText(/No provider has availability/)).toBeInTheDocument();
  });

  it('offers the service catalog as a choice, voice-bookable first', async () => {
    happyPath();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    const picker = await within(dialog).findByLabelText('Service');
    expect(within(picker).getByRole('group', { name: 'Bookable by voice' })).toBeInTheDocument();
    expect(within(picker).getByRole('group', { name: 'Desk only (the AI cannot book these)' })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'Cleaning' })).toBeInTheDocument();
    // An inactive catalog row is not offered.
    expect(within(picker).queryByRole('option', { name: 'Retired whitening' })).not.toBeInTheDocument();
  });

  it('keeps the service the caller asked for even when it is not in the catalog', async () => {
    happyPath();
    renderDialog({ requestedService: 'Emergency extraction' });
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    const picker = await within(dialog).findByLabelText('Service');
    expect(within(picker).getByRole('option', { name: /Emergency extraction \(asked for on the call — not in the catalog\)/ })).toBeInTheDocument();
  });

  it('falls back to a typed service name when the catalog could not be loaded, and says so', async () => {
    happyPath();
    route('GET', /^\/v1\/services$/, () => { throw new ApiError(503, 'Catalog down.', 'UNAVAILABLE'); });
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    expect(await within(dialog).findByText(/service catalog could not be loaded/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Service')).toHaveProperty('tagName', 'INPUT');
  });
});

describe('BookItDialog — the modal keeps its aria-modal promise (E15)', () => {
  it('traps Tab inside the dialog', async () => {
    happyPath();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes on Escape', async () => {
    happyPath();
    const { onClose } = renderDialog();
    await screen.findByRole('dialog', { name: /Book it/ });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('says why Confirm is unavailable rather than disabling it silently', async () => {
    happyPath();
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: /Book it/ });
    expect(within(dialog).getByRole('button', { name: /Confirm booking/ })).toBeDisabled();
    expect(within(dialog).getByText('Choose a provider.')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/First name/), { target: { value: '' } });
    expect(within(dialog).getByText('Give the new patient a first and last name.')).toBeInTheDocument();
  });
});
