import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

// The module boundary every request on this page goes through: the whole
// opportunityService client calls `apiRequest`.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import OpportunityCenter from './OpportunityCenter';

/**
 * The action drawer's campaign CTAs are confirmed decisions about one named
 * opportunity, so the navigation into /campaigns must carry the goal, the
 * source and the exact title the user acted on — and the ranking panel's
 * generic create CTA sends an honest source-only handoff, never an invented
 * goal.
 */

type Handler = (init?: RequestInit) => unknown;
let handlers: Record<string, Handler>;

beforeEach(() => {
  handlers = {};
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? 'GET'} ${path}`];
    // An unregistered endpoint stays pending rather than resolving to
    // undefined: a test must never accidentally assert against a fake answer.
    return handler ? handler(init) : new Promise<never>(() => {});
  });
});

/** A raw API opportunity row as /v1/opportunities returns it. */
function opportunityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'opp-1', title: 'Re-engage lapsed hygiene patients', category: 'inactive-patients',
    expectedRevenue: 4200, actualRevenue: 0, roi: 3, confidence: 70,
    urgency: 'high', effortLevel: 'low', status: 'pending', ownerApprovalRequired: false,
    recommendedAction: 'Contact the queue', trigger: 'inactivity', source: 'crm',
    ...overrides,
  };
}

function stubPage(opportunities: Array<Record<string, unknown>>) {
  handlers['GET /v1/revenue-leaks?limit=30'] = () => [];
  handlers['GET /v1/opportunities?limit=30'] = () => opportunities;
}

function CampaignDestination() {
  const location = useLocation();
  return <pre data-testid="landed">{JSON.stringify(location.state)}</pre>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/opportunities']}>
      <Routes>
        <Route path="/opportunities" element={<OpportunityCenter />} />
        <Route path="/campaigns" element={<CampaignDestination />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function landedState(): Promise<unknown> {
  const landed = await screen.findByTestId('landed');
  return JSON.parse(landed.textContent ?? 'null');
}

/** Opens the drawer for the row, clicks its campaign CTA, confirms the modal. */
async function driveDrawerCta(rowTitle: string, ctaLabel: string) {
  fireEvent.click(await screen.findByText(rowTitle));
  const drawer = await screen.findByRole('dialog', { name: rowTitle });
  fireEvent.click(within(drawer).getByRole('button', { name: ctaLabel }));
  const modal = await screen.findByRole('dialog', { name: 'Open Campaigner?' });
  fireEvent.click(within(modal).getByRole('button', { name: ctaLabel }));
}

describe('OpportunityCenter campaign handoffs', () => {
  // The recovery CTA appears for two categories with different honest goals:
  // an inactive-patients opportunity is a winback, a reputation one is a
  // review push. 'payments' fit neither and was corrected — the goal now
  // derives from the category being acted on.
  it('recovery CTA derives its goal from the opportunity category', async () => {
    stubPage([opportunityRow()]);
    renderPage();
    await driveDrawerCta('Re-engage lapsed hygiene patients', 'Build Recovery Campaign');
    await waitFor(async () => expect(await landedState()).toEqual({
      goal: 'winback', source: 'Opportunity Center',
      contextLabel: 'Re-engage lapsed hygiene patients',
    }));
  });

  it('schedule-fill CTA carries the requests goal and the opportunity acted on', async () => {
    stubPage([opportunityRow({ id: 'opp-2', title: 'Refill cancelled Thursday slots', category: 'no-show' })]);
    renderPage();
    await driveDrawerCta('Refill cancelled Thursday slots', 'Build Schedule Fill Campaign');
    await waitFor(async () => expect(await landedState()).toEqual({
      goal: 'requests', source: 'Opportunity Center',
      contextLabel: 'Refill cancelled Thursday slots',
    }));
  });

  it('the empty ranking panel\'s create CTA sends only the source', async () => {
    stubPage([]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create campaign draft' }));
    expect(await landedState()).toEqual({ source: 'Opportunity Center' });
  });
});
