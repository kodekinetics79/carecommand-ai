import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { Campaign, Clinic, IntakeField } from '../../lib/receptionist';
import { IntakeBuilder } from './IntakeBuilder';

/**
 * Reordering used to be optimistic with no rollback: a refused reorder left
 * the screen showing an order the server never accepted. These tests hold
 * the contract: arrows are disabled while the reorder is in flight, a refused
 * reorder rolls the list back to the server's order and names the cause, and
 * a failed initial load is never rendered as "No fields yet".
 */
function field(id: string, label: string, sortOrder: number): IntakeField {
  return { id, campaignId: 'camp-1', fieldType: id === 'f-first' ? 'FIRST_NAME' : 'LAST_NAME', label, aiQuestion: `${label}?`, validationRule: null, placeholder: null, options: [], required: true, confirmationRequired: false, sortOrder };
}

const FIELDS = [field('f-first', 'First name', 0), field('f-last', 'Last name', 1)];

const campaign: Campaign = {
  id: 'camp-1', clinicId: 'clinic-1', agentId: null, name: 'Spring Cleaning', campaignType: 'REACTIVATION', status: 'DRAFT',
  offerTitle: 'Offer', offerDescription: 'Desc', offerScript: 'Script', appointmentType: 'Consultation', bookingRules: null,
  eligibleLocationIds: [], smsConfirmation: false, emailConfirmation: false, intakeFields: FIELDS,
};
const clinic = { id: 'clinic-1', name: 'Brightsmile', locations: [{ id: 'location-1', name: 'Downtown Medical Centre' }] } as unknown as Clinic;

type Responder = (path: string, init?: RequestInit) => Promise<unknown>;
let respond: Responder;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

/** Labels of the field rows, top to bottom (the catalog buttons on the right carry no <p>). */
function rowLabels(): string[] {
  return screen.getAllByRole('button', { name: /^(First name|Last name)/ })
    .map(button => button.querySelector('p')?.textContent ?? null)
    .filter((label): label is string => label !== null);
}

describe('IntakeBuilder — reorder rolls back when the server refuses', () => {
  it('creates preferred location without duplicating mapped locations as forbidden display-name options', async () => {
    respond = (path, init) => {
      if (path.startsWith('/v1/receptionist/intake-fields?campaignId=camp-1')) return Promise.resolve(FIELDS);
      if (path === '/v1/receptionist/intake-fields' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          campaignId: 'camp-1',
          fieldType: 'PREFERRED_LOCATION',
          options: [],
        });
        return Promise.resolve({ ...field('preferred', 'Preferred location', 2), fieldType: 'PREFERRED_LOCATION' });
      }
      return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
    };
    render(<IntakeBuilder campaign={campaign} clinic={clinic} onChanged={async () => {}} />);

    await waitFor(() => expect(rowLabels()).toEqual(['First name', 'Last name']));
    fireEvent.click(screen.getByRole('button', { name: 'Preferred location' }));
    expect(await screen.findByText('Preferred location added')).toBeInTheDocument();
  });

  it('disables the arrows while the reorder is in flight, then restores the order and shows the cause', async () => {
    let rejectReorder!: (error: unknown) => void;
    respond = (path, init) => {
      if (path.startsWith('/v1/receptionist/intake-fields?campaignId=camp-1')) return Promise.resolve(FIELDS);
      if (path === '/v1/receptionist/intake-fields/reorder' && init?.method === 'POST') return new Promise((_, reject) => { rejectReorder = reject; });
      return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
    };
    render(<IntakeBuilder campaign={campaign} clinic={clinic} onChanged={async () => {}} />);

    await waitFor(() => expect(rowLabels()).toEqual(['First name', 'Last name']));
    const [moveFirstDown] = screen.getAllByRole('button', { name: 'Move field down' });
    fireEvent.click(moveFirstDown);

    // Optimistic swap, with every arrow disabled until the server answers.
    await waitFor(() => expect(rowLabels()).toEqual(['Last name', 'First name']));
    for (const arrow of [...screen.getAllByRole('button', { name: 'Move field down' }), ...screen.getAllByRole('button', { name: 'Move field up' })]) {
      expect(arrow).toBeDisabled();
    }

    rejectReorder(new ApiError(409, 'Intake contract is attested; pause the campaign before reordering fields.', 'INTERNAL_SERVER_ERROR'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Intake contract is attested; pause the campaign before reordering fields.');
    expect(rowLabels()).toEqual(['First name', 'Last name']);
    // Arrows are usable again for a retry.
    const [firstDownAgain] = screen.getAllByRole('button', { name: 'Move field down' });
    expect(firstDownAgain).toBeEnabled();
  });

  it('keeps the new order once the server accepts it', async () => {
    const reordered = [{ ...FIELDS[1], sortOrder: 0 }, { ...FIELDS[0], sortOrder: 1 }];
    respond = (path, init) => {
      if (path.startsWith('/v1/receptionist/intake-fields?campaignId=camp-1')) return Promise.resolve(FIELDS);
      if (path === '/v1/receptionist/intake-fields/reorder' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ campaignId: 'camp-1', orderedIds: ['f-last', 'f-first'] });
        return Promise.resolve(reordered);
      }
      return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
    };
    render(<IntakeBuilder campaign={campaign} clinic={clinic} onChanged={async () => {}} />);

    await waitFor(() => expect(rowLabels()).toEqual(['First name', 'Last name']));
    fireEvent.click(screen.getAllByRole('button', { name: 'Move field down' })[0]);

    await screen.findByText('Order saved');
    expect(rowLabels()).toEqual(['Last name', 'First name']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names a failed field load instead of rendering "No fields yet"', async () => {
    respond = (path) => path.startsWith('/v1/receptionist/intake-fields?campaignId=camp-1')
      ? Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR'))
      : Promise.reject(new Error(`Unexpected request in test: ${path}`));
    render(<IntakeBuilder campaign={{ ...campaign, intakeFields: [] }} clinic={clinic} onChanged={async () => {}} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Intake fields could not be loaded.');
    expect(screen.queryByText(/No fields yet/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
