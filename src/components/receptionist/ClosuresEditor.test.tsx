import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import { receptionistFixtures } from '../../test/fixtures/receptionist';
import { ClosuresEditor } from './ClosuresEditor';

const LOCATIONS = receptionistFixtures.clinics()[0].locations ?? [];

type Responder = (path: string, init?: RequestInit) => Promise<unknown>;
let respond: Responder;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

function renderEditor() {
  return render(<ClosuresEditor clinicId="clinic-1" locations={LOCATIONS} timezone="Europe/London" locale="en-GB" />);
}

function listOnly(closures = receptionistFixtures.closures()): Responder {
  return path => path.startsWith('/v1/receptionist/clinics/clinic-1/closures')
    ? Promise.resolve(closures)
    : Promise.reject(new Error(`Unexpected request in test: ${path}`));
}

async function openAddForm() {
  fireEvent.click(await screen.findByRole('button', { name: /Add closure/ }));
}

describe('ClosuresEditor', () => {
  it('lists upcoming closures with the words callers will hear', async () => {
    respond = listOnly();
    renderEditor();

    expect(await screen.findByText(/Staff training day/)).toBeInTheDocument();
    expect(screen.getByText(/All locations/)).toBeInTheDocument();
    expect(screen.getByText(/Harley Street/)).toBeInTheDocument();
  });

  it('posts YYYY-MM-DD dates and the reason', async () => {
    let posted: Record<string, unknown> | null = null;
    respond = (path, init) => {
      if (path.startsWith('/v1/receptionist/clinics/clinic-1/closures') && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return Promise.resolve({ id: 'closure-new' });
      }
      if (path.startsWith('/v1/receptionist/clinics/clinic-1/closures')) return Promise.resolve(receptionistFixtures.closures());
      return Promise.reject(new Error(`Unexpected request in test: ${path}`));
    };
    renderEditor();
    await openAddForm();

    fireEvent.change(screen.getByLabelText(/First day closed/), { target: { value: '2026-12-24' } });
    fireEvent.change(screen.getByLabelText(/Last day closed/), { target: { value: '2026-12-26' } });
    fireEvent.change(screen.getByLabelText(/Reason callers hear/), { target: { value: 'Christmas closure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create closure' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toEqual({ locationId: null, startsOn: '2026-12-24', endsOn: '2026-12-26', reason: 'Christmas closure', internalNote: null });
  });

  it('sends the chosen location when the closure is not clinic-wide', async () => {
    let posted: Record<string, unknown> | null = null;
    respond = (_path, init) => {
      if (init?.method === 'POST') { posted = JSON.parse(String(init.body)); return Promise.resolve({ id: 'closure-new' }); }
      return Promise.resolve(receptionistFixtures.closures());
    };
    renderEditor();
    await openAddForm();

    fireEvent.change(screen.getByLabelText(/Applies to/), { target: { value: 'loc-1' } });
    fireEvent.change(screen.getByLabelText(/Reason callers hear/), { target: { value: 'Boiler repair' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create closure' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({ locationId: 'loc-1', reason: 'Boiler repair' });
  });

  it('renders a Zod field error next to the field that caused it', async () => {
    respond = (_path, init) => {
      if (init?.method === 'POST') {
        return Promise.reject(new ApiError(400, 'reason: Reason must be at least 2 characters', 'VALIDATION_ERROR', {
          error: 'VALIDATION_ERROR',
          details: { fieldErrors: { reason: ['Reason must be at least 2 characters'] }, formErrors: [] },
        }));
      }
      return Promise.resolve(receptionistFixtures.closures());
    };
    renderEditor();
    await openAddForm();

    fireEvent.change(screen.getByLabelText(/Reason callers hear/), { target: { value: 'xy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create closure' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('Reason must be at least 2 characters'))).toBe(true);
    expect(screen.getByLabelText(/Reason callers hear/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('refuses a backwards date range locally instead of posting it', async () => {
    const requests: string[] = [];
    respond = (path, init) => { requests.push(`${init?.method ?? 'GET'} ${path}`); return Promise.resolve(receptionistFixtures.closures()); };
    renderEditor();
    await openAddForm();

    fireEvent.change(screen.getByLabelText(/First day closed/), { target: { value: '2026-12-26' } });
    fireEvent.change(screen.getByLabelText(/Last day closed/), { target: { value: '2026-12-24' } });
    fireEvent.change(screen.getByLabelText(/Reason callers hear/), { target: { value: 'Christmas closure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create closure' }));

    expect(await screen.findByText('The end date must be on or after the start date.')).toBeInTheDocument();
    expect(requests.some(request => request.startsWith('POST'))).toBe(false);
  });

  it('deletes only after the confirmation dialog is confirmed', async () => {
    const requests: string[] = [];
    respond = (path, init) => {
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (init?.method === 'DELETE') return Promise.resolve(undefined);
      return Promise.resolve(receptionistFixtures.closures());
    };
    renderEditor();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete closure Staff training day' }));
    expect(requests.some(request => request.startsWith('DELETE'))).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete closure' }));

    await waitFor(() => expect(requests).toContain('DELETE /v1/receptionist/closures/closure-1'));
  });

  it('names a failed load instead of showing "No upcoming closures"', async () => {
    respond = () => Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR'));
    renderEditor();

    expect(await screen.findByRole('alert')).toHaveTextContent('Closures could not be loaded.');
    expect(screen.queryByText('No upcoming closures.')).not.toBeInTheDocument();
  });

  it('says so honestly when the clinic really has no closures', async () => {
    respond = listOnly([]);
    renderEditor();
    expect(await screen.findByText('No upcoming closures.')).toBeInTheDocument();
  });
});
