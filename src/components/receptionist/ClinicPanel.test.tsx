import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { ClinicRow } from '../../lib/receptionistClinic';
import { receptionistFixtures } from '../../test/fixtures/receptionist';
import { ClinicPanel } from './ClinicPanel';

/**
 * Two contracts meet in this panel.
 *
 * C1's: ClinicPanel.save used to be try/finally with no catch, so a 409 or a
 * Zod 400 vanished and the form simply re-enabled its Save button.
 *
 * C2's: the country is required for activation and is never inferred, the
 * option lists come from the served catalog rather than eight compiled-in
 * timezones, and a concurrent edit is refused by `expectedUpdatedAt` instead
 * of silently overwriting someone else's save.
 */
const CATALOG = receptionistFixtures.catalog();

function clinic(overrides: Partial<ClinicRow> = {}): ClinicRow {
  return { ...receptionistFixtures.clinics()[0], ...overrides };
}

type Responder = (path: string, init?: RequestInit) => Promise<unknown>;
let respond: Responder;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

/** Mirrors the page: onChanged reloads the clinic and hands the panel the row the server now holds. */
function Harness({ initial, onReload }: { initial: ClinicRow; onReload: () => ClinicRow }) {
  const [row, setRow] = useState(initial);
  return <ClinicPanel clinic={row} onChanged={async () => { setRow(onReload()); }} />;
}

/** Everything the panel loads besides the clinic PATCH under test. */
function background(path: string): Promise<unknown> | null {
  if (path === '/v1/receptionist/catalog') return Promise.resolve(CATALOG);
  if (path === '/v1/receptionist/scheduling-branches') return Promise.resolve([]);
  if (path.includes('/closures')) return Promise.resolve([]);
  return null;
}

function withPatch(patch: (body: Record<string, unknown>) => Promise<unknown>): Responder {
  return (path, init) => {
    const loaded = background(path);
    if (loaded) return loaded;
    if (path === '/v1/receptionist/clinics/clinic-1' && init?.method === 'PATCH') return patch(JSON.parse(String(init.body)));
    return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
  };
}

function renameAndSave(nextName: string) {
  fireEvent.change(screen.getByDisplayValue('Harley Street Medical Group'), { target: { value: nextName } });
  fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
}

describe('ClinicPanel — errors are shown, nothing saves silently', () => {
  it('shows the server 409 message and code in an alert and does not claim Saved', async () => {
    respond = withPatch(() => Promise.reject(new ApiError(
      409,
      'Trusted inbound number +442071234567 is already assigned to another active clinic.',
      'INTERNAL_SERVER_ERROR',
      { error: 'INTERNAL_SERVER_ERROR', message: 'Trusted inbound number +442071234567 is already assigned to another active clinic.' },
    )));
    render(<Harness initial={clinic()} onReload={() => clinic()} />);

    renameAndSave('Harley Street Medical');

    const alerts = await screen.findAllByRole('alert');
    const alert = alerts.find(node => node.textContent?.includes('already assigned'))!;
    expect(alert).toHaveTextContent('code: INTERNAL_SERVER_ERROR');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Harley Street Medical')).toBeInTheDocument();
  });

  it('names the failing field on a Zod 400 instead of "Request validation failed"', async () => {
    respond = withPatch(() => Promise.reject(new ApiError(
      400,
      'humanFallbackNumber: Phone must include country code in E.164 format',
      'VALIDATION_ERROR',
      {
        error: 'VALIDATION_ERROR',
        details: { fieldErrors: { humanFallbackNumber: ['Phone must include country code in E.164 format'] }, formErrors: [] },
      },
    )));
    render(<Harness initial={clinic()} onReload={() => clinic()} />);

    fireEvent.change(screen.getByDisplayValue('+442071234568'), { target: { value: '(415) 555-0100' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('human fallback number: Phone must include country code in E.164 format'))).toBe(true);
  });

  it('shows the Saved pill only after the server accepted the write, and sends only what changed', async () => {
    let patched: Record<string, unknown> | null = null;
    respond = withPatch(body => { patched = body; return Promise.resolve({ ...clinic(), ...body }); });
    render(<Harness initial={clinic()} onReload={() => clinic({ name: 'Harley Street Medical' })} />);

    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    renameAndSave('Harley Street Medical');

    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(patched).toEqual({ name: 'Harley Street Medical', expectedUpdatedAt: '2026-08-29T12:00:00.000Z' });
  });

  it('sends null to clear the fallback number rather than an empty string', async () => {
    let patched: Record<string, unknown> | null = null;
    respond = withPatch(body => { patched = body; return Promise.resolve(clinic()); });
    render(<Harness initial={clinic()} onReload={() => clinic({ humanFallbackNumber: null })} />);

    fireEvent.change(screen.getByDisplayValue('+442071234568'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toMatchObject({ humanFallbackNumber: null });
  });

  it('refuses a malformed website locally and never sends it', async () => {
    const requests: string[] = [];
    respond = (path, init) => {
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      return background(path) ?? Promise.resolve(clinic());
    };
    render(<Harness initial={clinic()} onReload={() => clinic()} />);

    fireEvent.change(screen.getByDisplayValue('https://harley.example.com'), { target: { value: 'harley.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    expect(await screen.findByText('Enter a full URL starting with http:// or https://')).toBeInTheDocument();
    expect(requests.some(request => request.startsWith('PATCH'))).toBe(false);
  });
});

describe('ClinicPanel — country, catalog and readiness', () => {
  it('offers the served countries and marks a missing one as an activation blocker', async () => {
    respond = withPatch(() => Promise.resolve(clinic()));
    render(<Harness initial={clinic({ country: null, readiness: undefined })} onReload={() => clinic()} />);

    await waitFor(() => expect(screen.getByLabelText(/Country/)).toBeInTheDocument());
    const select = screen.getByLabelText(/Country/) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map(option => option.value)).toContain('GB'));
    expect([...select.options].map(option => option.textContent)).toContain('United Kingdom (GB)');
    expect(screen.getByTestId('country-blocker')).toHaveTextContent('Country not set — activation is blocked');
  });

  it('keeps a stored timezone the catalog does not list', async () => {
    respond = withPatch(() => Promise.resolve(clinic()));
    render(<Harness initial={clinic({ timezone: 'Pacific/Chatham' })} onReload={() => clinic()} />);

    const select = await screen.findByLabelText(/Timezone/) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('Pacific/Chatham'));
    expect([...select.options].some(option => option.textContent?.includes('Pacific/Chatham (not in catalog)'))).toBe(true);
  });

  it('says the option lists are unavailable when the catalog fails, instead of offering an empty select', async () => {
    respond = (path, init) => {
      if (path === '/v1/receptionist/catalog') return Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR'));
      return background(path) ?? withPatch(() => Promise.resolve(clinic()))(path, init);
    };
    render(<Harness initial={clinic()} onReload={() => clinic()} />);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('The receptionist catalog could not be loaded.'))).toBe(true);
    expect((screen.getByLabelText(/Timezone/) as HTMLSelectElement).value).toBe('Europe/London');
  });

  it('shows the transfer badge for a ready fallback and for each refusal reason', async () => {
    respond = withPatch(() => Promise.resolve(clinic()));
    const { unmount } = render(<Harness initial={clinic()} onReload={() => clinic()} />);
    expect(screen.getByTestId('transfer-readiness')).toHaveTextContent('Transfer ready');
    unmount();

    render(<Harness initial={clinic({ humanFallbackNumber: null, readiness: undefined })} onReload={() => clinic()} />);
    expect(screen.getByTestId('transfer-readiness')).toHaveTextContent('Not set — callers will be offered a message instead of a transfer');
  });

  it('shows the pack status beside the language so the blocker is visible before saving', async () => {
    respond = withPatch(() => Promise.resolve(clinic()));
    render(<Harness initial={clinic()} onReload={() => clinic()} />);

    const select = await screen.findByLabelText(/Default language/) as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map(option => option.textContent)).toContain('English (UK) — pack approved'));
  });

  it('sends the whole week when hours change, keeping the days that did not', async () => {
    let patched: Record<string, unknown> | null = null;
    respond = withPatch(body => { patched = body; return Promise.resolve(clinic()); });
    render(<Harness initial={clinic()} onReload={() => clinic()} />);

    fireEvent.click(screen.getByLabelText('Friday open'));
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(patched).not.toBeNull());
    const hours = (patched as unknown as { workingHours: Record<string, unknown> }).workingHours;
    expect(hours.friday).toEqual({ open: false });
    expect(hours.saturday).toEqual({ open: true, start: '09:00', end: '13:00' });
  });

  it('offers a Reload instead of overwriting when someone else saved first', async () => {
    let reloads = 0;
    respond = withPatch(() => Promise.reject(new ApiError(409, 'The clinic changed since you opened it.', 'STALE_REVISION', {
      error: 'STALE_REVISION', message: 'The clinic changed since you opened it.',
    })));
    render(<Harness initial={clinic()} onReload={() => { reloads += 1; return clinic({ name: 'Renamed by someone else' }); }} />);

    renameAndSave('Harley Street Medical');

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('Someone else saved this clinic; reload to see their changes.'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Reload/ }));
    await waitFor(() => expect(reloads).toBe(1));
    await waitFor(() => expect(screen.getByDisplayValue('Renamed by someone else')).toBeInTheDocument());
  });
});
