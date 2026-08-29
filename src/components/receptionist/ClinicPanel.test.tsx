import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { Clinic } from '../../lib/receptionist';
import { ClinicPanel } from './ClinicPanel';

/**
 * ClinicPanel.save used to be try/finally with no catch: a 409 (the trusted
 * inbound number already assigned elsewhere) or a Zod 400 (fallback number
 * not E.164) vanished and the form simply re-enabled its Save button. These
 * tests hold the new contract: the server's own words are shown in an alert,
 * and "Saved" is only claimed after the server accepted the write.
 */
function clinic(overrides: Partial<Clinic> = {}): Clinic {
  return {
    id: 'clinic-1', name: 'Brightsmile Dental Group', logoUrl: null, phone: '+14155550142', website: null, addressLine: null,
    timezone: 'America/Los_Angeles', defaultLanguage: 'en-US', complianceDisclosure: 'Hi, this is Riley, the AI assistant.',
    humanFallbackNumber: '+14155550100', doNotContactPolicy: 'Stop on request.', workingHours: null, active: true, locations: [],
    ...overrides,
  };
}

type Responder = (path: string, init?: RequestInit) => Promise<unknown>;
let respond: Responder;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

/** Mirrors the page: onChanged reloads the clinic and hands the panel the row the server now holds. */
function Harness({ initial, onReload }: { initial: Clinic; onReload: () => Clinic }) {
  const [row, setRow] = useState(initial);
  return <ClinicPanel clinic={row} onChanged={async () => { setRow(onReload()); }} />;
}

function withPatch(patch: (body: Record<string, unknown>) => Promise<unknown>): Responder {
  return (path, init) => {
    if (path === '/v1/receptionist/scheduling-branches') return Promise.resolve([]);
    if (path === '/v1/receptionist/clinics/clinic-1' && init?.method === 'PATCH') return patch(JSON.parse(String(init.body)));
    return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
  };
}

function renameAndSave(nextName: string) {
  fireEvent.change(screen.getByDisplayValue('Brightsmile Dental Group'), { target: { value: nextName } });
  fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
}

describe('ClinicPanel — every server error is shown, nothing saves silently', () => {
  it('shows the server 409 message and code in an alert and does not claim Saved', async () => {
    respond = withPatch(() => Promise.reject(new ApiError(
      409,
      'Trusted inbound number +14155550142 is already assigned to another active clinic.',
      'INTERNAL_SERVER_ERROR',
      { error: 'INTERNAL_SERVER_ERROR', message: 'Trusted inbound number +14155550142 is already assigned to another active clinic.' },
    )));
    render(<Harness initial={clinic()} onReload={() => clinic()} />);

    renameAndSave('Brightsmile Dental');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Trusted inbound number +14155550142 is already assigned to another active clinic.');
    expect(alert).toHaveTextContent('code: INTERNAL_SERVER_ERROR');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    // The draft is kept so the user can correct and retry.
    expect(screen.getByDisplayValue('Brightsmile Dental')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('names the failing field on a Zod 400 instead of "Request validation failed"', async () => {
    respond = withPatch(() => Promise.reject(new ApiError(
      400,
      'humanFallbackNumber: Phone must include country code in E.164 format',
      'VALIDATION_ERROR',
      {
        error: 'VALIDATION_ERROR',
        message: 'humanFallbackNumber: Phone must include country code in E.164 format',
        details: { fieldErrors: { humanFallbackNumber: ['Phone must include country code in E.164 format'] }, formErrors: [] },
      },
    )));
    render(<Harness initial={clinic()} onReload={() => clinic()} />);

    fireEvent.change(screen.getByDisplayValue('+14155550100'), { target: { value: '(415) 555-0100' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('human fallback number: Phone must include country code in E.164 format');
    expect(alert).toHaveTextContent('code: VALIDATION_ERROR');
  });

  it('shows the Saved pill only after the server accepted the write', async () => {
    let patched: Record<string, unknown> | null = null;
    respond = withPatch(body => { patched = body; return Promise.resolve({ ...clinic(), ...body }); });
    render(<Harness initial={clinic()} onReload={() => clinic({ name: 'Brightsmile Dental' })} />);

    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    renameAndSave('Brightsmile Dental');

    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(patched).toMatchObject({ name: 'Brightsmile Dental', phone: '+14155550142' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names a failed scheduling-branch load instead of labelling every location "Not mapped"', async () => {
    respond = (path) => path === '/v1/receptionist/scheduling-branches'
      ? Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR'))
      : Promise.reject(new Error(`Unexpected request in test: ${path}`));
    render(<Harness
      initial={clinic({ locations: [{ id: 'loc-1', clinicId: 'clinic-1', name: 'Market Street', address: '500 Market Street', phone: null, branchId: 'branch-1', timezone: null, active: true, workingHours: null } as Clinic['locations'] extends (infer L)[] | undefined ? L : never] })}
      onReload={() => clinic()}
    />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Scheduling branches could not be loaded.');
    expect(screen.getByText(/Branch mapping unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Not mapped — booking disabled/)).not.toBeInTheDocument();
  });
});
