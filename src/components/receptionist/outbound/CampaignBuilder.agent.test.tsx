import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api')>('../../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { CampaignBuilder } from './CampaignBuilder';

/**
 * This form never asked which receptionist places the calls, so every campaign
 * it created had `agentId: null` — and approval refuses that with
 * `agent_unlinked`. Combined with there being no edit form, a campaign created
 * here was unapprovable AND unfixable: the only remedy was a database write.
 *
 * It happened twice in one evening while trying to place a single demo call.
 *
 * Two guarantees, both pinned:
 *   1. the agent is SENT when the campaign is created;
 *   2. the form REFUSES to create one that could never be approved.
 */
const AGENT = {
  id: 'agent-1', clinicId: 'clinic-1', name: 'Ava', voice: 'v', tone: 't', language: 'en-US',
  persona: null, greetingOverride: null, active: true, providerAgentId: 'provider-agent-abc', providerVersionTag: 'carecommand', providerVersion: 3,
};

function renderBuilder() {
  return render(
    <CampaignBuilder
      clinicId="clinic-1" bookingAuthorities={[]} locations={[]} timezone="America/New_York"
      onSaved={() => {}} onCancel={() => {}}
    />,
  );
}

/** Fill the fields the form requires before it will attempt a save. */
async function fillRequired() {
  fireEvent.change(screen.getByPlaceholderText('June reactivation outreach'), { target: { value: 'Client demo call' } });
  const script = document.querySelector('textarea');
  if (script) fireEvent.change(script, { target: { value: 'Salam. Calling from Brightsmile Dental Group.' } });
  fireEvent.change(screen.getByPlaceholderText('21:00'), { target: { value: '23:50' } });
  fireEvent.change(screen.getByPlaceholderText('08:00'), { target: { value: '23:55' } });
}

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation(async (path: string) => {
    if (path.startsWith('/v1/receptionist/agents')) return [AGENT];
    return { id: 'new-campaign' };
  });
});

describe('a campaign is created with a receptionist attached', () => {
  it('sends the clinic’s only published receptionist without asking', async () => {
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Receptionist placing these calls')).toBeTruthy());
    // Chosen, not asked: one option is not a choice.
    await waitFor(() => expect((screen.getByLabelText('Receptionist placing these calls') as HTMLSelectElement).value).toBe('agent-1'));

    await fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /create|save/i }));

    await waitFor(() => {
      const create = apiRequestMock.mock.calls.find(([p, init]) => p === '/v1/receptionist/outbound-campaigns' && (init as RequestInit)?.method === 'POST');
      expect(create, 'the campaign was never created').toBeTruthy();
      expect(JSON.parse(String((create![1] as RequestInit).body)).agentId).toBe('agent-1');
    });
  });

  it('refuses to create a campaign no receptionist can ever run', async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/receptionist/agents')) return [];
      return { id: 'new-campaign' };
    });
    renderBuilder();
    await fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /create|save/i }));

    // Saving it would produce a campaign that cannot be approved and cannot be
    // edited — strictly worse than being told now.
    // The phrase appears in the field hint AND the save error; either is
    // the form telling the user, which is what this asserts.
    await waitFor(() => expect(screen.getAllByText(/no published receptionist/i).length).toBeGreaterThan(0));
    const created = apiRequestMock.mock.calls.find(([p, init]) => p === '/v1/receptionist/outbound-campaigns' && (init as RequestInit)?.method === 'POST');
    expect(created, 'an unapprovable campaign was created anyway').toBeFalsy();
  });

  it('ignores agents that are inactive or not published to the provider', async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/receptionist/agents')) {
        return [{ ...AGENT, id: 'a-inactive', active: false }, { ...AGENT, id: 'a-unpublished', providerAgentId: null }];
      }
      return { id: 'new-campaign' };
    });
    renderBuilder();
    await fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /create|save/i }));
    // The phrase appears in the field hint AND the save error; either is
    // the form telling the user, which is what this asserts.
    await waitFor(() => expect(screen.getAllByText(/no published receptionist/i).length).toBeGreaterThan(0));
  });
});
