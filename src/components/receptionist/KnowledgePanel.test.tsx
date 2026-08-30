import { MemoryRouter } from 'react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { KnowledgeView } from '../../lib/receptionistClinic';
import { receptionistFixtures } from '../../test/fixtures/receptionist';
import { KnowledgePanel } from './KnowledgePanel';

/**
 * Knowledge is prompt-bearing content: what is typed here becomes what the
 * agent tells a patient about coverage, payment and what counts as urgent.
 * So a draft must save against the revision it was edited from, and approval
 * — the act that puts the words in front of callers — must be impossible
 * while the server says the draft is invalid.
 */
const CLINIC = receptionistFixtures.clinics()[0];
const SERVICES = [
  { id: 'svc-1', name: 'Hygiene visit', category: 'general', defaultDurationMinutes: 30, defaultAppointmentValue: null, depositRuleId: null, active: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', spokenDescription: null, bookableByVoice: false, voiceDurationMinutes: null, priceFrom: null },
];

type Responder = (path: string, init?: RequestInit) => Promise<unknown>;
let respond: Responder;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

function knowledge(overrides: Partial<KnowledgeView> = {}): KnowledgeView {
  return { ...receptionistFixtures.knowledge(), ...overrides };
}

function renderPanel() {
  return render(<MemoryRouter><KnowledgePanel clinic={CLINIC} /></MemoryRouter>);
}

function responder(handlers: { knowledge?: Responder } = {}): Responder {
  return (path, init) => {
    if (path === '/v1/receptionist/catalog') return Promise.resolve(receptionistFixtures.catalog());
    if (path === '/v1/services') return Promise.resolve(SERVICES);
    if (path.includes('/knowledge')) return (handlers.knowledge ?? (() => Promise.resolve(knowledge())))(path, init);
    return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
  };
}

describe('KnowledgePanel', () => {
  it('renders every section from the served draft', async () => {
    respond = responder();
    renderPanel();

    expect(await screen.findByDisplayValue('Bupa')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/We accept card and bank transfer\. Payment is due/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/New patients are welcome\. Please arrive/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Severe pain, a lost filling/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('+442071234570')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Is there parking?')).toBeInTheDocument();
  });

  it('says who approved which revision, and that the draft has moved on', async () => {
    respond = responder();
    renderPanel();
    expect(await screen.findByText(/Approved rev 3 by Jane Okafor on .* · the draft has unapproved changes/)).toBeInTheDocument();
  });

  it('keeps urgent care separate from the emergency number', async () => {
    respond = responder();
    renderPanel();
    await screen.findByDisplayValue('Bupa');
    expect(screen.getByText(/A life-threatening call is routed to the emergency number in the approved locale pack/)).toBeInTheDocument();
  });

  it('saves the draft with the revision it was edited from', async () => {
    let put: Record<string, unknown> | null = null;
    respond = responder({
      knowledge: (_path, init) => {
        if (init?.method === 'PUT') { put = JSON.parse(String(init.body)); return Promise.resolve(knowledge({ draftRevision: 5 })); }
        return Promise.resolve(knowledge());
      },
    });
    renderPanel();

    fireEvent.change(await screen.findByDisplayValue('Bupa'), { target: { value: 'Bupa International' } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));

    await waitFor(() => expect(put).not.toBeNull());
    expect(put).toMatchObject({ expectedRevision: 4 });
    const draft = (put as unknown as { draft: { acceptedPayers: Array<{ name: string }>; urgentCare: unknown } }).draft;
    expect(draft.acceptedPayers[0].name).toBe('Bupa International');
    expect(draft.urgentCare).toMatchObject({ onCallNumber: '+442071234570' });
  });

  it('refuses to enable Approve while the server says the draft is invalid, and lists why', async () => {
    respond = responder();
    renderPanel();

    await screen.findByDisplayValue('Bupa');
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('This draft cannot be approved yet');
    expect(alert).toHaveTextContent('faq.1.answer: Answer is required');
  });

  it('approves with the current revision once the draft is valid and saved', async () => {
    let approved: Record<string, unknown> | null = null;
    respond = responder({
      knowledge: (_path, init) => {
        if (init?.method === 'POST') { approved = JSON.parse(String(init.body)); return Promise.resolve(knowledge()); }
        return Promise.resolve(knowledge({ dirty: false, validation: { ok: true, issues: [] } }));
      },
    });
    renderPanel();

    const approve = await screen.findByRole('button', { name: /Approve/ });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);

    await waitFor(() => expect(approved).toEqual({ expectedRevision: 4 }));
  });

  it('disables Approve while there are unsaved edits, rather than approving a stale revision', async () => {
    respond = responder({ knowledge: () => Promise.resolve(knowledge({ dirty: false, validation: { ok: true, issues: [] } })) });
    renderPanel();

    await waitFor(() => expect(screen.getByRole('button', { name: /Approve/ })).toBeEnabled());
    fireEvent.change(screen.getByDisplayValue('Bupa'), { target: { value: 'Bupa International' } });
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
  });

  it('offers a Reload instead of overwriting when someone else saved first', async () => {
    respond = responder({
      knowledge: (_path, init) => init?.method === 'PUT'
        ? Promise.reject(new ApiError(409, 'The knowledge changed since you opened it.', 'STALE_REVISION', { error: 'STALE_REVISION' }))
        : Promise.resolve(knowledge()),
    });
    renderPanel();

    fireEvent.change(await screen.findByDisplayValue('Bupa'), { target: { value: 'Bupa International' } });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));

    // findAllByRole('alert') would resolve instantly against the validation
    // alert already on screen; wait for this exact sentence instead.
    expect(await screen.findByText('Someone else saved this knowledge; reload to see their changes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload/ })).toBeInTheDocument();
  });

  it('marks a duplicate plan name inline before the server refuses it', async () => {
    respond = responder();
    renderPanel();

    fireEvent.change(await screen.findByDisplayValue('AXA Health'), { target: { value: 'Bupa' } });

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('Two entries have this name.'))).toBe(true);
  });

  it('names a failed load instead of showing an empty knowledge form', async () => {
    respond = responder({ knowledge: () => Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR')) });
    renderPanel();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('Clinic knowledge could not be loaded.'))).toBe(true);
    expect(screen.queryByRole('button', { name: /Save draft/ })).not.toBeInTheDocument();
  });
});

describe('KnowledgePanel — bookable by voice (service catalog rows)', () => {
  it('reads services from the catalog and says how many the agent may book', async () => {
    respond = responder();
    renderPanel();

    expect(await screen.findByText('0 of 1 services')).toBeInTheDocument();
    expect(screen.getByText('Hygiene visit')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'service catalog' })).toHaveAttribute('href', '/scheduling?tab=services');
  });

  it('PATCHes the ServiceCatalogItem voice columns, not a copy inside the knowledge document', async () => {
    let patched: { path: string; body: Record<string, unknown> } | null = null;
    respond = (path, init) => {
      if (path.startsWith('/v1/services/') && init?.method === 'PATCH') {
        patched = { path, body: JSON.parse(String(init.body)) };
        return Promise.resolve({ ...SERVICES[0], bookableByVoice: true });
      }
      return responder()(path, init);
    };
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit voice settings' }));
    fireEvent.change(screen.getByLabelText(/How the agent describes it/), { target: { value: 'a routine hygiene appointment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bookable by voice' }));
    fireEvent.click(screen.getByRole('button', { name: /Save voice settings/ }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched!.path).toBe('/v1/services/svc-1');
    expect(patched!.body).toEqual({ spokenDescription: 'a routine hygiene appointment', bookableByVoice: true, voiceDurationMinutes: null });
  });

  it('says the catalog is empty rather than implying the agent can book something', async () => {
    respond = (path, init) => path === '/v1/services' ? Promise.resolve([]) : responder()(path, init);
    renderPanel();

    expect(await screen.findByText(/No services in the catalog yet/)).toBeInTheDocument();
  });
});
