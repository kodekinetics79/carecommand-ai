import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import { receptionistFixtures } from '../../test/fixtures/receptionist';
import { CreateClinicDialog } from './CreateClinicDialog';

/**
 * Creating a clinic used to POST a name and a phone number and let the server
 * default the timezone, the language and the disclosure (M22). Those defaults
 * are caller-facing: they decide when the agent says the clinic is open and
 * which emergency number it speaks. Nothing may be submitted silently.
 */
const BRANCHES = [
  { id: 'branch-1', name: 'Harley Street', location: 'London', timezone: 'Europe/London', active: true },
  { id: 'branch-2', name: 'Closed site', location: 'Leeds', timezone: 'Europe/London', active: false },
];

type Responder = (path: string, init?: RequestInit) => Promise<unknown>;
let respond: Responder;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

function responder(overrides: { branches?: unknown; create?: Responder } = {}): Responder {
  return (path, init) => {
    if (path === '/v1/receptionist/catalog') return Promise.resolve(receptionistFixtures.catalog());
    if (path === '/v1/receptionist/scheduling-branches') return Promise.resolve(overrides.branches ?? BRANCHES);
    if (path === '/v1/receptionist/clinics' && init?.method === 'POST') {
      return (overrides.create ?? (() => Promise.resolve(receptionistFixtures.clinics()[0])))(path, init);
    }
    return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
  };
}

function renderDialog(onCreated = vi.fn(), onClose = vi.fn()) {
  render(<CreateClinicDialog onClose={onClose} onCreated={onCreated} />);
  return { onCreated, onClose };
}

describe('CreateClinicDialog', () => {
  it('defaults the timezone from the tenant\'s active branch and the language to one with an approved pack', async () => {
    respond = responder();
    renderDialog();

    await waitFor(() => expect((screen.getByLabelText(/Timezone/) as HTMLSelectElement).value).toBe('Europe/London'));
    expect(screen.getByText('Defaulted from branch Harley Street.')).toBeInTheDocument();
    expect((screen.getByLabelText(/Default language/) as HTMLSelectElement).value).toBe('en-GB');
    expect((screen.getByLabelText(/Country/) as HTMLSelectElement).value).toBe('GB');
  });

  it('sends every chosen value, not just name and phone', async () => {
    let posted: Record<string, unknown> | null = null;
    respond = responder({ create: (_path, init) => { posted = JSON.parse(String(init!.body)); return Promise.resolve(receptionistFixtures.clinics()[0]); } });
    const { onCreated, onClose } = renderDialog();

    await waitFor(() => expect((screen.getByLabelText(/Timezone/) as HTMLSelectElement).value).toBe('Europe/London'));
    fireEvent.change(screen.getByLabelText(/Clinic name/), { target: { value: 'Example Health' } });
    fireEvent.change(screen.getByLabelText(/Trusted inbound phone number/), { target: { value: '+442071234567' } });
    fireEvent.click(screen.getByRole('button', { name: /Create clinic/ }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toEqual({ name: 'Example Health', phone: '+442071234567', country: 'GB', timezone: 'Europe/London', defaultLanguage: 'en-GB' });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses to submit with a field left blank instead of letting the server guess', async () => {
    const requests: string[] = [];
    respond = (path, init) => { requests.push(`${init?.method ?? 'GET'} ${path}`); return responder()(path, init); };
    renderDialog();

    await waitFor(() => expect((screen.getByLabelText(/Timezone/) as HTMLSelectElement).value).toBe('Europe/London'));
    fireEvent.change(screen.getByLabelText(/Clinic name/), { target: { value: 'Example Health' } });
    fireEvent.click(screen.getByRole('button', { name: /Create clinic/ }));

    expect(await screen.findByText(/none of them can be guessed for you/)).toBeInTheDocument();
    expect(requests.some(request => request.startsWith('POST'))).toBe(false);
  });

  it('blocks creation and says why when the tenant has no active branch', async () => {
    respond = responder({ branches: [BRANCHES[1]] });
    renderDialog();

    expect(await screen.findByText(/Add an active scheduling branch first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create clinic/ })).toBeDisabled();
  });

  it('shows the server\'s own refusal instead of closing as if it had worked', async () => {
    const onClose = vi.fn();
    respond = responder({
      create: () => Promise.reject(new ApiError(400, 'phone: Phone must include country code in E.164 format', 'VALIDATION_ERROR', {
        error: 'VALIDATION_ERROR',
        details: { fieldErrors: { phone: ['Phone must include country code in E.164 format'] }, formErrors: [] },
      })),
    });
    renderDialog(vi.fn(), onClose);

    await waitFor(() => expect((screen.getByLabelText(/Timezone/) as HTMLSelectElement).value).toBe('Europe/London'));
    fireEvent.change(screen.getByLabelText(/Clinic name/), { target: { value: 'Example Health' } });
    fireEvent.change(screen.getByLabelText(/Trusted inbound phone number/), { target: { value: '020 7123 4567' } });
    fireEvent.click(screen.getByRole('button', { name: /Create clinic/ }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('phone: Phone must include country code in E.164 format'))).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Trusted inbound phone number/)).toHaveAttribute('aria-invalid', 'true');
  });
});
