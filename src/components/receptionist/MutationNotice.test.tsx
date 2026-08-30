import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../../lib/api';
import { describeMutationFailure } from '../../hooks/useMutationState';
import { MutationNotice } from './MutationNotice';

/**
 * E7 — the server writes a remediation sentence for all 54 failure codes and
 * sends it on every receptionist 409 as `title` / `action` / `fixHref`. The
 * client kept only `message` and `code`, so a refused deploy, activate,
 * verify or campaign edit degraded to a bare identifier next to readiness
 * rows that were fully guided. These tests hold that it does not.
 */
function conflict(details: Record<string, unknown>) {
  return new ApiError(409, String(details.message ?? 'Conflict'), String(details.code ?? 'conflict'), details);
}

const activationConflict = conflict({
  code: 'campaign_not_ready',
  message: 'Campaign configuration is not deployable: campaign_not_ready.',
  title: 'The campaign is not ready to activate',
  action: 'Clear the listed checks, then activate.',
  fixHref: '/receptionist-studio?tab=campaign',
});

describe('describeMutationFailure — remediation survives the trip to the screen', () => {
  it('keeps the server’s title, action and fix link off a 409', () => {
    const error = describeMutationFailure(activationConflict);
    expect(error.remediation).toEqual({
      title: 'The campaign is not ready to activate',
      action: 'Clear the listed checks, then activate.',
      fixHref: '/receptionist-studio?tab=campaign',
    });
  });

  it('is null when the failure carries no remediation, rather than inventing one', () => {
    expect(describeMutationFailure(new ApiError(500, 'An unexpected error occurred', 'INTERNAL_SERVER_ERROR')).remediation).toBeNull();
    expect(describeMutationFailure(new Error('offline')).remediation).toBeNull();
  });

  it('ignores blank remediation fields instead of rendering an empty sentence', () => {
    const error = describeMutationFailure(conflict({ code: 'cooldown', message: 'Too soon.', title: '   ', action: '', fixHref: null }));
    expect(error.remediation).toBeNull();
  });
});

describe('MutationNotice', () => {
  it('renders the remediation sentence and a Fix link beside the code', () => {
    render(<MemoryRouter><MutationNotice state={describeMutationFailure(activationConflict)} /></MemoryRouter>);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Campaign configuration is not deployable: campaign_not_ready.');
    expect(within(alert).getByTestId('remediation-action')).toHaveTextContent('The campaign is not ready to activate — Clear the listed checks, then activate.');
    expect(alert).toHaveTextContent('code: campaign_not_ready');
    expect(within(alert).getByRole('link')).toHaveAttribute('href', '/receptionist-studio?tab=campaign');
  });

  it('renders no remediation block, and no dangling Fix, when the server sent none', () => {
    render(<MemoryRouter><MutationNotice state={describeMutationFailure(new ApiError(503, 'The provider is unavailable', 'provider_unavailable'))} /></MemoryRouter>);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The provider is unavailable');
    expect(within(alert).queryByTestId('remediation-action')).not.toBeInTheDocument();
    expect(within(alert).queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not repeat the title when it is already the message', () => {
    const state = describeMutationFailure(conflict({
      code: 'engine_not_owned', message: 'This agent was not created by CareCommand',
      title: 'This agent was not created by CareCommand', action: 'Link an agent CareCommand deployed, or create one here.', fixHref: null,
    }));
    render(<MemoryRouter><MutationNotice state={state} /></MemoryRouter>);

    const action = screen.getByTestId('remediation-action');
    expect(action).toHaveTextContent('Link an agent CareCommand deployed, or create one here.');
    expect(action.textContent).not.toContain('—');
  });
});
