import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

const sessionMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useSession', () => ({ useSession: sessionMock }));
vi.mock('../../hooks/useEntitlements', () => ({ useEntitlements: () => new Set(['ai_receptionist']) }));

import { ApiError } from '../../lib/api';
import { resetFrontDeskPollForTests } from '../../hooks/useFrontDeskPoll';
import Sidebar from './Sidebar';

/**
 * The badge is a claim about how much work is waiting. It may only be shown
 * when the summary actually loaded, and a red one means an emergency nobody
 * has acknowledged.
 */
const GRANTS = ['staff:read', 'staff:task-status', 'receptionist:call-artifacts:read'];

function signedIn(permissions: string[] = GRANTS) {
  sessionMock.mockReturnValue({
    user: { id: 'u1', email: 'a@b.test', displayName: 'Ann Front', role: 'FRONT_DESK', tenant: { id: 't', name: 'T', slug: 't' }, active: true, effectivePermissions: permissions },
    loading: false,
  });
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    openByKind: { message: 2, human_handoff: 1 }, overdue: 1,
    unacknowledgedCritical: [], mine: 0, dueWithin30m: 1, generatedAt: '2026-08-29T17:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  resetFrontDeskPollForTests();
  signedIn();
  apiRequestMock.mockReset();
});

afterEach(() => { resetFrontDeskPollForTests(); });

const renderSidebar = () => render(<MemoryRouter><Sidebar /></MemoryRouter>);
const frontDeskLink = () => screen.getByRole('link', { name: /Front Desk/ });

describe('Sidebar Front Desk entry', () => {
  it('offers Front Desk and Receptionist Studio to a role that holds their grants', async () => {
    apiRequestMock.mockResolvedValue(summary());
    renderSidebar();
    expect(frontDeskLink()).toHaveAttribute('href', '/front-desk');
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith('/v1/tasks/summary'));
  });

  it('hides Front Desk from a role without receptionist:call-artifacts:read', () => {
    signedIn(['staff:read']);
    apiRequestMock.mockResolvedValue(summary());
    renderSidebar();
    expect(screen.queryByRole('link', { name: /Front Desk/ })).not.toBeInTheDocument();
    // …and it never asks for a summary it is not allowed to read.
    expect(apiRequestMock).not.toHaveBeenCalledWith('/v1/tasks/summary');
  });

  /**
   * The auditor's shape: it may read call artifacts and recordings, and holds
   * no staff grant at all. The board is built from both — the calls, and the
   * task lanes those calls create — and GET /v1/tasks{,/summary} is guarded by
   * staff:read. Offering the entry produced a page whose calls loaded and whose
   * every lane answered 403, with a badge polling that same 403 every 20s from
   * every screen in the app.
   */
  it('hides Front Desk from a role that may read call artifacts but holds no staff grant', () => {
    signedIn(['receptionist:call-artifacts:read', 'receptionist:recordings:read', 'compliance:read', 'audit:read']);
    apiRequestMock.mockResolvedValue(summary());
    renderSidebar();
    expect(screen.queryByRole('link', { name: /Front Desk/ })).not.toBeInTheDocument();
    expect(apiRequestMock).not.toHaveBeenCalledWith('/v1/tasks/summary');
  });

  it('badges open work in amber', async () => {
    apiRequestMock.mockResolvedValue(summary());
    renderSidebar();
    const badge = await within(frontDeskLink()).findByText('3');
    expect(badge.className).toContain('badge-amber');
  });

  /**
   * D7. The preview is capped at five server-side. A badge that prints the
   * preview's length reads "5" beside nine open emergencies, which is worse
   * than no badge: it is a number staff will act on.
   */
  it('badges the real emergency count, not the length of the capped preview', async () => {
    apiRequestMock.mockResolvedValue(summary({
      unacknowledgedCriticalCount: 9,
      unacknowledgedCritical: [1, 2, 3, 4, 5].map(index => ({
        id: `c${index}`, title: `Emergency ${index}`, createdAt: '2026-08-29T17:00:00.000Z',
        clinicName: 'Brightsmile', workflow: 'receptionist_safety', kind: 'emergency',
      })),
    }));
    renderSidebar();
    const badge = await within(frontDeskLink()).findByText('9');
    expect(badge.className).toContain('badge-red');
  });

  it('badges a capped preview as "5+" rather than claiming the total is 5', async () => {
    apiRequestMock.mockResolvedValue(summary({
      unacknowledgedCritical: [1, 2, 3, 4, 5].map(index => ({
        id: `c${index}`, title: `Emergency ${index}`, createdAt: '2026-08-29T17:00:00.000Z', clinicName: 'Brightsmile',
      })),
    }));
    renderSidebar();
    const badge = await within(frontDeskLink()).findByText('5+');
    expect(badge.className).toContain('badge-red');
  });

  it('badges an unacknowledged emergency in red, and counts the emergencies', async () => {
    apiRequestMock.mockResolvedValue(summary({
      unacknowledgedCritical: [{ id: 't1', title: 'Emergency', createdAt: '2026-08-29T17:00:00.000Z', clinicName: 'Brightsmile' }],
    }));
    renderSidebar();
    const badge = await within(frontDeskLink()).findByText('1');
    expect(badge.className).toContain('badge-red');
  });

  it('shows no badge at all when the summary could not be loaded', async () => {
    apiRequestMock.mockRejectedValue(new ApiError(503, 'Summary unavailable.', 'UNAVAILABLE'));
    renderSidebar();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    // No number is invented from a failed read — not even a zero.
    expect(within(frontDeskLink()).queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it('shows no badge when there is genuinely nothing waiting', async () => {
    apiRequestMock.mockResolvedValue(summary({ openByKind: {}, unacknowledgedCritical: [] }));
    renderSidebar();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    expect(within(frontDeskLink()).queryByText(/^\d+$/)).not.toBeInTheDocument();
  });
});
