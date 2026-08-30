import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import { receptionistFixtures } from '../../test/fixtures/receptionist';
import { LocalePackPanel } from './LocalePackPanel';

/**
 * The pack is the evidence: the recording disclosure hashed onto every
 * consent event, and the emergency number the agent speaks. So approval is an
 * OWNER/ADMIN act that acknowledges an exact hash, a non-owner sees the reason
 * they cannot do it rather than a button that fails, and the preview is
 * rendered from the pack's own strings so nobody approves wording they did not
 * actually read.
 */
const CLINIC = receptionistFixtures.clinics()[0];
const PACKS = receptionistFixtures.localePacks();

type Responder = (path: string, init?: RequestInit) => Promise<unknown>;
let respond: Responder;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string, init?: RequestInit) => respond(path, init));
});

function responder(role: string, handlers: { packs?: Responder } = {}): Responder {
  return (path, init) => {
    if (path === '/v1/auth/me') return Promise.resolve({ user: { id: 'user-1', email: 'jane@example.com', name: 'Jane', role }, access: { permissions: [] } });
    if (path === '/v1/receptionist/catalog') return Promise.resolve(receptionistFixtures.catalog());
    if (path.includes('/locale-packs')) return (handlers.packs ?? (() => Promise.resolve(receptionistFixtures.localePacks())))(path, init);
    return Promise.reject(new Error(`Unexpected request in test: ${init?.method ?? 'GET'} ${path}`));
  };
}

function renderPanel() {
  return render(<LocalePackPanel clinic={CLINIC} />);
}

describe('LocalePackPanel', () => {
  it('groups packs by language and country, newest version first', async () => {
    respond = responder('OWNER');
    renderPanel();

    const group = await screen.findByLabelText('Locale pack en-GB GB');
    const versions = [...group.querySelectorAll('[data-testid^="pack-"]')].map(node => node.getAttribute('data-testid'));
    expect(versions).toEqual(['pack-pack-gb-2', 'pack-pack-gb-1']);
  });

  it('offers "Adopt platform default" only where a pack is missing', async () => {
    respond = responder('OWNER');
    renderPanel();

    // en-US/US has a platform default and no tenant pack; en-GB/GB already has packs.
    expect(await screen.findByTestId('pack-missing-en-US-US')).toBeInTheDocument();
    expect(screen.queryByTestId('pack-missing-en-GB-GB')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Adopt platform default/ })).toHaveLength(1);
  });

  it('creates a draft from the platform default for the missing pair', async () => {
    let posted: Record<string, unknown> | null = null;
    respond = responder('OWNER', {
      packs: (_path, init) => {
        if (init?.method === 'POST') { posted = JSON.parse(String(init.body)); return Promise.resolve(PACKS.packs[1]); }
        return Promise.resolve(receptionistFixtures.localePacks());
      },
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Adopt platform default/ }));

    await waitFor(() => expect(posted).toEqual({ language: 'en-US', country: 'US', from: { kind: 'platform_default' } }));
  });

  it('renders the preview client-side, with no placeholder left unresolved', async () => {
    respond = responder('OWNER');
    renderPanel();

    const preview = await screen.findByTestId('preview-pack-gb-2');
    expect(preview.textContent).toContain('Harley Street Medical Group');
    expect(preview.textContent).not.toContain('{{');
  });

  it('shows the emergency number from the pack, not a hardcoded 911', async () => {
    respond = responder('OWNER');
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'emergency.instruction' }));
    const preview = screen.getByTestId('preview-pack-gb-2');
    expect(preview.textContent).toContain('999');
    expect(preview.textContent).not.toContain('911');
  });

  it('marks an unknown placeholder before the server refuses the pack', async () => {
    respond = responder('OWNER');
    renderPanel();

    const editor = await screen.findByLabelText(/Wording for disclosure.recording/);
    fireEvent.change(editor, { target: { value: 'Hi from {{mystery}}' } });

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('Unknown placeholder: {{mystery}}'))).toBe(true);
  });

  it('approves with the evidence hash shown on screen', async () => {
    let approved: { path: string; body: Record<string, unknown> } | null = null;
    respond = responder('OWNER', {
      packs: (path, init) => {
        if (init?.method === 'POST' && path.endsWith('/approve')) { approved = { path, body: JSON.parse(String(init.body)) }; return Promise.resolve(PACKS.packs[1]); }
        return Promise.resolve(receptionistFixtures.localePacks());
      },
    });
    renderPanel();

    const approve = await screen.findByRole('button', { name: /Approve pack/ });
    await waitFor(() => expect(approve).toBeEnabled());
    // The hash the reviewer is shown is the one that gets acknowledged; read it
    // off the screen before approving, because approving reloads the list.
    expect(screen.getByTestId('pack-pack-gb-2').textContent).toContain('evidence 7b585a11d5603acc4faa5220d201ebb6fcf41231b0773ef97f3b1abbfa13305b');
    fireEvent.click(approve);

    await waitFor(() => expect(approved).not.toBeNull());
    expect(approved!.path).toBe('/v1/receptionist/locale-packs/pack-gb-2/approve');
    expect(approved!.body).toEqual({ acknowledgedEvidenceHash: '7b585a11d5603acc4faa5220d201ebb6fcf41231b0773ef97f3b1abbfa13305b' });
  });

  it('disables approval for a non-owner and says why', async () => {
    respond = responder('MANAGER');
    renderPanel();

    const approve = await screen.findByRole('button', { name: /Approve pack/ });
    await waitFor(() => expect(approve).toBeDisabled());
    expect(approve).toHaveAttribute('title', 'Owner or Admin approval required');
    expect(screen.getByText('Owner or Admin approval required')).toBeInTheDocument();
  });

  it('does not offer to edit or approve an already approved pack', async () => {
    respond = responder('OWNER');
    renderPanel();

    const approvedPack = await screen.findByTestId('pack-pack-gb-1');
    fireEvent.click(within(approvedPack, 'Review wording')!);

    expect(screen.getByLabelText(/Approved wording for disclosure.recording/)).toHaveAttribute('readonly');
    expect(within(approvedPack, 'Approve pack', true)).toBeNull();
  });

  it('names a failed load instead of claiming the workspace has no packs', async () => {
    respond = responder('OWNER', { packs: () => Promise.reject(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR')) });
    renderPanel();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some(alert => alert.textContent?.includes('Locale packs could not be loaded.'))).toBe(true);
    expect(screen.queryByText(/No packs and no platform defaults/)).not.toBeInTheDocument();
  });
});

/** Finds a button by name inside one pack row. */
function within(scope: HTMLElement, name: string, optional = false): HTMLButtonElement | null {
  const match = [...scope.querySelectorAll('button')].find(button => button.textContent?.trim() === name) ?? null;
  if (!match && !optional) throw new Error(`No button named ${name} in this pack row`);
  return match;
}
