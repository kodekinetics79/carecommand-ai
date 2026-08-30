import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { AgentRow, Blocker, CatalogView, VerificationView } from '../../lib/receptionistDeployment';
import { AgentEditor } from './AgentEditor';

/**
 * The editor is keyed by agent id only, so a refetch after a failed verify
 * must not wipe the cause the user was just shown (C1). C5 adds the honest
 * expiry line, the provider mismatch badge, the binding-change confirmation
 * and the cooldown countdown after a 429.
 */
function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'agent-1', clinicId: 'clinic-1', name: 'Riley', voice: '11labs-Anna', tone: 'Warm and professional',
    language: 'en-US', persona: null, greetingOverride: null, active: true,
    providerAgentId: 'agent_7f21', providerVersionTag: 'prod', providerVersion: 4, providerStatus: 'VERIFIED',
    providerPublished: true, providerVoiceId: '11labs-Anna', providerLanguage: 'en-US',
    providerVerifiedAt: '2026-08-29T17:00:00.000Z', providerVerificationExpiresAt: '2026-08-30T17:00:00.000Z',
    providerLastAttemptAt: '2026-08-29T17:00:00.000Z', providerLastAttemptStatus: 'SUCCEEDED', providerLastErrorCode: null,
    ...overrides,
  };
}

const catalog: CatalogView = {
  voices: [{ voiceId: '11labs-Anna', name: 'Anna', provider: 'elevenlabs', gender: 'female', accent: 'American', previewUrl: null }],
  languages: [{ id: 'en-US', label: 'English (US)' }],
  tones: [{ id: 'Warm and professional', label: 'Warm and professional' }],
  campaignTypes: [],
  providerMode: 'live',
};

const verified: VerificationView = {
  status: 'VERIFIED', expiresAt: '2026-08-30T17:00:00.000Z', expiresInMs: 19 * 60 * 60 * 1000,
  autoRenew: { enabled: true, lastSystemAttemptAt: new Date().toISOString() },
};

function renderEditor(props: Partial<React.ComponentProps<typeof AgentEditor>> = {}) {
  const merged = {
    agent: agent(), onSave: vi.fn().mockResolvedValue(undefined), onVerify: vi.fn().mockResolvedValue(undefined),
    ...props,
  } as React.ComponentProps<typeof AgentEditor>;
  return render(<MemoryRouter><AgentEditor {...merged} /></MemoryRouter>);
}

describe('AgentEditor', () => {
  it('says plainly when no Retell agent is linked and will not let you verify nothing', () => {
    renderEditor({ agent: agent({ providerAgentId: null, providerStatus: 'UNVERIFIED', providerVersion: null, providerVerifiedAt: null }) });

    expect(screen.getByText('No Retell agent linked yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Verify provider deployment/ })).toBeDisabled();
  });

  it('shows the pinned numeric version rather than a tag claim', () => {
    renderEditor({ verification: verified });

    expect(screen.getByText(/Pinned version 4/)).toBeInTheDocument();
    expect(screen.getByText('Verified · expires in 19h — auto-renews')).toBeInTheDocument();
  });

  it('warns when auto-renewal is not running so nobody relies on it', () => {
    renderEditor({ verification: { status: 'VERIFIED', expiresAt: null, expiresInMs: 3 * 60 * 60 * 1000, autoRenew: { enabled: false, lastSystemAttemptAt: null } } });

    expect(screen.getByText('Verified · expires in 3h — auto-renewal is not running; verify manually before then')).toBeInTheDocument();
  });

  it('renders the server remediation for an INVALID agent next to its error code', () => {
    const blockers: Blocker[] = [{
      code: 'agent_invalid:tag_dynamic_variables_not_empty',
      severity: 'blocking',
      title: 'The deployment tag carries default dynamic variables',
      action: 'Remove default dynamic variables from the tag in Retell; CareCommand supplies all variables per call.',
      fixHref: null,
      scope: 'agent',
    }];
    renderEditor({ agent: agent({ providerStatus: 'INVALID', providerLastErrorCode: 'tag_dynamic_variables_not_empty' }), blockers });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('tag dynamic variables not empty');
    expect(alert).toHaveTextContent('The deployment tag carries default dynamic variables');
    expect(alert).toHaveTextContent('Remove default dynamic variables from the tag in Retell');
  });

  it('keeps a failed verify visible when the parent hands back a refreshed row', async () => {
    // The 409 body carries the durable row; the panel re-renders with it. The
    // editor must not remount and lose the cause.
    function Harness() {
      const [row, setRow] = useState<AgentRow>(agent());
      return (
        <MemoryRouter>
          <AgentEditor
            agent={row}
            onSave={vi.fn().mockResolvedValue(undefined)}
            onVerify={async () => {
              setRow(agent({ providerStatus: 'INVALID', providerLastErrorCode: 'provider_deployment_drift', providerLastAttemptStatus: 'FAILED' }));
              throw new ApiError(409, 'The published agent no longer matches this configuration.', 'provider_deployment_drift');
            }}
          />
        </MemoryRouter>
      );
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /Verify provider deployment/ }));

    await waitFor(() => expect(screen.getByText('The published agent no longer matches this configuration.')).toBeInTheDocument());
    expect(screen.getByText('code: provider_deployment_drift')).toBeInTheDocument();
    expect(screen.getByText(/provider deployment drift/)).toBeInTheDocument();
  });

  it('confirms before changing the provider binding, and only then saves', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onSave });

    fireEvent.change(screen.getByLabelText('Retell agent ID'), { target: { value: 'agent_9999' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    expect(await screen.findByRole('dialog')).toHaveTextContent('Change the linked Retell agent?');
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Change binding' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ providerAgentId: 'agent_9999' })));
  });

  it('saves an ordinary edit without a confirmation', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onSave });

    fireEvent.change(screen.getByDisplayValue('Riley'), { target: { value: 'Robin' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Robin' })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('flags a provider mismatch and adopts the provider values on request', async () => {
    const onAdoptProviderValues = vi.fn().mockResolvedValue(undefined);
    renderEditor({ agent: agent({ voice: '11labs-Adrian', providerVoiceId: 'openai-Nova' }), onAdoptProviderValues });

    expect(screen.getByTestId('provider-mismatch')).toHaveTextContent('Differs from verified provider (openai-Nova)');
    fireEvent.click(screen.getByRole('button', { name: /Adopt provider values/ }));
    await waitFor(() => expect(onAdoptProviderValues).toHaveBeenCalledTimes(1));
  });

  it('counts down the cooldown after a 429 instead of inviting an immediate retry', async () => {
    const onVerify = vi.fn().mockRejectedValue(new ApiError(429, 'Too many verification attempts.', 'cooldown', { code: 'cooldown', retryAfterSeconds: 42 }));
    renderEditor({ onVerify });

    fireEvent.click(screen.getByRole('button', { name: /Verify provider deployment/ }));

    expect(await screen.findByText(/Provider check cooling down — retry in 4[0-9]s\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry in 4[0-9]s/ })).toBeDisabled();
  });

  it('renders a stored voice that is not in the catalog instead of silently replacing it', () => {
    renderEditor({ agent: agent({ voice: '11labs-Legacy' }), catalog });

    const voice = screen.getByLabelText('Voice') as HTMLSelectElement;
    expect(voice.value).toBe('11labs-Legacy');
    expect(screen.getByRole('option', { name: '11labs-Legacy (not in catalog)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Anna (female, American) · elevenlabs' })).toBeInTheDocument();
  });

  it('will not delete an agent the campaign still links', () => {
    renderEditor({ onDelete: vi.fn(), referenced: true });

    const remove = screen.getByRole('button', { name: /Delete agent/ });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'Unlink this agent from the campaign before deleting it.');
  });
});
