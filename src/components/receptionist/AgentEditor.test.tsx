import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import { mergeVoicesSection, normalizeCatalog } from '../../lib/receptionistDeployment';
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

/**
 * Built through the real normalisers from the bodies the two routes actually
 * send, not hand-written. `GET /v1/receptionist/catalog` carries no `voices`
 * section at all — which is exactly why the picker was empty in every tenant
 * and no test noticed. `GET /v1/receptionist/voices` is where the list lives
 * until the server folds it into the catalog (contract §7).
 */
const CATALOG_BODY = {
  languages: [{ id: 'en-US', label: 'English (US)' }],
  tones: [{ id: 'Warm and professional', label: 'Warm and professional' }],
  campaignTypes: [],
  countries: [{ code: 'US', name: 'United States' }],
};

const VOICES_BODY = {
  providerMode: 'live',
  source: 'provider',
  fetchedAt: '2026-08-30T09:00:00.000Z',
  error: null,
  voices: [
    { voiceId: '11labs-Anna', name: 'Anna', provider: 'elevenlabs', gender: 'female', accent: 'American', age: 'young', previewUrl: null },
    { voiceId: '11labs-Marcus', name: 'Marcus', provider: 'elevenlabs', gender: 'male', accent: 'British', age: 'middle', previewUrl: null },
  ],
};

const catalog: CatalogView = mergeVoicesSection(normalizeCatalog(CATALOG_BODY), VOICES_BODY);

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

describe('AgentEditor — the voice picker (E9)', () => {
  it('offers the provider voices the /voices section carries, which the catalog alone does not', () => {
    // The catalog body on its own has no voices: the stored value would be the
    // only option, labelled "(not in catalog)".
    const catalogOnly = normalizeCatalog(CATALOG_BODY);
    expect(catalogOnly.voices).toHaveLength(0);

    renderEditor({ catalog });

    const picker = screen.getByLabelText('Voice') as HTMLSelectElement;
    expect([...picker.options].map(option => option.value)).toEqual(['11labs-Anna', '11labs-Marcus']);
    expect(screen.getByText('Anna (female, American) · elevenlabs')).toBeInTheDocument();
  });

  it('says why the list is empty rather than showing a picker with one silent option', () => {
    const unavailable = mergeVoicesSection(normalizeCatalog(CATALOG_BODY), { providerMode: 'live', voices: [], source: 'unavailable', error: 'provider_unavailable' });
    renderEditor({ catalog: unavailable });

    expect(screen.getByText(/could not be read from the provider \(provider_unavailable\)/)).toBeInTheDocument();
    // The stored voice is still offered, marked, so nothing is silently replaced.
    expect(screen.getByText('11labs-Anna (not in catalog)')).toBeInTheDocument();
  });
});

describe('AgentEditor — the draft follows the stored row (E10)', () => {
  it('re-seeds the picker after an adopt changes the stored voice, and stops reverting it on the next Save', () => {
    const { rerender } = render(<MemoryRouter><AgentEditor
      agent={agent({ voice: '11labs-Anna' })}
      catalog={catalog}
      onSave={vi.fn().mockResolvedValue(agent())}
      onVerify={vi.fn().mockResolvedValue(undefined)}
    /></MemoryRouter>);
    expect((screen.getByLabelText('Voice') as HTMLSelectElement).value).toBe('11labs-Anna');

    // What "Adopt provider values" does: the server row comes back with the
    // provider's voice. The editor used to keep showing the old one, so Save
    // silently undid the adoption.
    rerender(<MemoryRouter><AgentEditor
      agent={agent({ voice: '11labs-Marcus' })}
      catalog={catalog}
      onSave={vi.fn().mockResolvedValue(agent())}
      onVerify={vi.fn().mockResolvedValue(undefined)}
    /></MemoryRouter>);

    expect((screen.getByLabelText('Voice') as HTMLSelectElement).value).toBe('11labs-Marcus');
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeDisabled();
  });

  it('keeps a half-typed name when the same row is handed back after a sibling reload', () => {
    const { rerender } = render(<MemoryRouter><AgentEditor
      agent={agent()} catalog={catalog}
      onSave={vi.fn().mockResolvedValue(agent())} onVerify={vi.fn().mockResolvedValue(undefined)}
    /></MemoryRouter>);

    fireEvent.change(screen.getByDisplayValue('Riley'), { target: { value: 'Rileyanne' } });
    rerender(<MemoryRouter><AgentEditor
      agent={agent()} catalog={catalog}
      onSave={vi.fn().mockResolvedValue(agent())} onVerify={vi.fn().mockResolvedValue(undefined)}
    /></MemoryRouter>);

    expect(screen.getByDisplayValue('Rileyanne')).toBeInTheDocument();
  });

  it('keeps the adopt confirmation visible after the mismatch it fixed has gone', async () => {
    const onAdoptProviderValues = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<MemoryRouter><AgentEditor
      agent={agent({ voice: '11labs-Marcus', providerVoiceId: '11labs-Anna' })}
      catalog={catalog}
      onSave={vi.fn().mockResolvedValue(agent())} onVerify={vi.fn().mockResolvedValue(undefined)}
      onAdoptProviderValues={onAdoptProviderValues}
    /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /Adopt provider values/ }));
    await waitFor(() => expect(onAdoptProviderValues).toHaveBeenCalled());

    // The adopt succeeded, so the mismatch badge is gone — the confirmation
    // used to live inside that block and vanish with it.
    rerender(<MemoryRouter><AgentEditor
      agent={agent({ voice: '11labs-Anna', providerVoiceId: '11labs-Anna' })}
      catalog={catalog}
      onSave={vi.fn().mockResolvedValue(agent())} onVerify={vi.fn().mockResolvedValue(undefined)}
      onAdoptProviderValues={onAdoptProviderValues}
    /></MemoryRouter>);

    expect(screen.queryByTestId('provider-mismatch')).not.toBeInTheDocument();
    expect(screen.getByText('Provider voice and language adopted')).toBeInTheDocument();
  });
});
