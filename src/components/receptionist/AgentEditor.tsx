import { useEffect, useState } from 'react';
import { ShieldCheck, Loader2, Trash2, ArrowDownToLine } from 'lucide-react';
import { Field, TextInput, TextArea, Select, Toggle } from '../ui/Field';
import type { Agent } from '../../lib/receptionist';
import {
  agentRowOf, blockedByOf, providerMismatchOf, retryAfterSecondsOf, verificationLine, voiceLabel, withCurrentOption,
  type AgentRow, type Blocker, type BlockedByCampaign, type CatalogView, type ProviderMode, type VerificationView,
} from '../../lib/receptionistDeployment';
import { isBusy, savedAtOf, useMutationState } from '../../hooks/useMutationState';
import ConfirmationModal from '../workflow/ConfirmationModal';
import { ConfirmedButton, SaveBar } from './shared';
import { MutationNotice } from './MutationNotice';
import { FixLink } from './ReadinessChecklist';

/** The fields this editor owns. Provider snapshot fields are read from the prop, never from the draft. */
function editableFields(agent: Agent) {
  return {
    name: agent.name, voice: agent.voice, tone: agent.tone, language: agent.language,
    persona: agent.persona, greetingOverride: agent.greetingOverride, active: agent.active,
    providerAgentId: agent.providerAgentId, providerVersionTag: agent.providerVersionTag,
  };
}

const sameEditableFields = (a: Agent, b: Agent) => JSON.stringify(editableFields(a)) === JSON.stringify(editableFields(b));

function bindingChanged(draft: Agent, agent: Agent): boolean {
  return (draft.providerAgentId ?? '') !== (agent.providerAgentId ?? '') || draft.providerVersionTag !== agent.providerVersionTag;
}

const TONE_TEXT = { ok: 'text-emerald-v', warn: 'text-amber-v', error: 'text-red-v', muted: 'text-t3' } as const;

/**
 * Keyed by agent id only (see CampaignPanel): it never remounts on a
 * `providerLastAttemptAt` change, so the drift / verification error the user
 * was just shown survives the refetch. The draft holds the editable subset;
 * the provider evidence block always reads the latest `agent` prop, and the
 * last provider `code` / `message` stays visible until the next attempt.
 *
 * Voice / language / tone options come from the catalog; a stored value
 * outside the catalog is merged into the list so it still renders.
 */
export function AgentEditor({
  agent, onSave, onVerify, onAdoptProviderValues, onDelete,
  referenced = false, verification = null, blockers = [], providerMode = null, catalog = null,
}: {
  agent: AgentRow;
  /** Resolves with the row the server actually stored, so the draft is refreshed from it rather than left stale. */
  onSave: (patch: Partial<Agent>) => Promise<AgentRow>;
  onVerify: () => Promise<void>;
  onAdoptProviderValues?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  /** The current campaign still links this agent; deleting is refused until it is unlinked. */
  referenced?: boolean;
  verification?: VerificationView | null;
  /** Server blockers scoped to this agent (title / action / fix link rendered verbatim). */
  blockers?: Blocker[];
  providerMode?: ProviderMode | null;
  catalog?: CatalogView | null;
}) {
  const [draft, setDraft] = useState<Agent>(agent);
  // The row the editor last agreed with. When the server row changes value —
  // an adopt, another operator's save, a verification that normalised a field
  // — the draft restarts from it. Without this the picker kept showing the old
  // voice after "Adopt provider values" succeeded, and the next Save silently
  // reverted the adoption. Compared by value, not identity, so a refetch that
  // returns the same row never discards a half-typed edit.
  const [seed, setSeed] = useState<Agent>(agent);
  const [confirmBinding, setConfirmBinding] = useState(false);
  const [saveBlockedBy, setSaveBlockedBy] = useState<BlockedByCampaign[]>([]);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const saveState = useMutationState();
  const verifyState = useMutationState();
  const adoptState = useMutationState();
  const deleteState = useMutationState();
  const busy = isBusy(saveState.state) || isBusy(verifyState.state) || isBusy(adoptState.state) || isBusy(deleteState.state);
  const dirty = !sameEditableFields(draft, agent);
  const set = <K extends keyof Agent>(key: K, value: Agent[K]) => setDraft(prev => ({ ...prev, [key]: value }));

  // During render rather than in an effect, so the first paint after a change
  // already shows the server's values instead of the stale draft.
  if (!sameEditableFields(seed, agent)) {
    setSeed(agent);
    setDraft(agent);
  }

  useEffect(() => {
    if (cooldownUntil === null) return;
    const id = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= cooldownUntil) setCooldownUntil(null);
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);
  const cooldownSeconds = cooldownUntil === null ? 0 : Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  async function commitSave() {
    setSaveBlockedBy([]);
    const updated = await saveState.run(async () => {
      try {
        return await onSave(editableFields(draft));
      } catch (error) {
        setSaveBlockedBy(blockedByOf(error));
        throw error;
      }
    });
    // The draft is refreshed from the row the server actually stored, so a
    // normalised or server-defaulted field never leaves a stale value on screen.
    if (updated) {
      setSeed(updated);
      setDraft(updated);
    }
  }

  function save() {
    if (bindingChanged(draft, agent)) setConfirmBinding(true);
    else void commitSave();
  }

  async function verify() {
    await verifyState.run(async () => {
      try {
        await onVerify();
      } catch (error) {
        const retryAfter = retryAfterSecondsOf(error);
        if (retryAfter) {
          setNow(Date.now());
          setCooldownUntil(Date.now() + retryAfter * 1000);
        }
        throw error;
      }
    }, { successMessage: 'Provider deployment verified' });
  }

  async function adopt() {
    if (!onAdoptProviderValues) return;
    await adoptState.run(onAdoptProviderValues, { successMessage: 'Provider voice and language adopted' });
  }

  async function remove() {
    if (!onDelete) return;
    await deleteState.run(onDelete, { rethrow: true });
  }

  const mismatch = providerMismatchOf(agent);
  const agentBlockers = blockers.filter(blocker => blocker.scope === 'agent' || blocker.scope === 'provider');
  const errorRemediation = agent.providerLastErrorCode
    ? blockers.find(blocker => blocker.code === `agent_invalid:${agent.providerLastErrorCode}` || blocker.code === agent.providerLastErrorCode) ?? null
    : null;
  const line = verification ? verificationLine(verification) : null;
  const verifyFailure = verifyState.state.status === 'error' ? verifyState.state : null;
  const failedAgent = verifyFailure ? agentRowOf(verifyFailure.failure) : null;
  void failedAgent;

  const voiceOptions = withCurrentOption((catalog?.voices ?? []).map(voice => ({ id: voice.voiceId, label: voiceLabel(voice) })), draft.voice);
  const languageOptions = withCurrentOption(catalog?.languages ?? [], draft.language);
  const toneOptions = withCurrentOption(catalog?.tones ?? [], draft.tone);
  const catalogHint = catalog ? undefined : 'Catalog not loaded — only the stored value is offered.';
  // A picker with one option and no explanation is indistinguishable from a
  // tenant that genuinely has one voice. The server's own reason is printed.
  const voiceHint = catalogHint
    ?? (catalog && catalog.voices.length === 0
      ? `${catalog.voicesUnavailable ?? 'The voice catalogue is empty.'} Only the stored voice is offered.`
      : 'Deployed to Retell with the campaign.');

  // Why Verify is disabled, in words. A greyed button with no explanation is
  // the failure this replaces; the cooldown has its own countdown line below.
  const verifyBlockReason = dirty
    ? 'Save these changes before verifying the provider deployment.'
    : !agent.providerAgentId
      ? 'Enter and save a Retell agent ID before verification.'
      : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Agent name" required><TextInput value={draft.name} onChange={e => set('name', e.target.value)} /></Field>
        <Field label="Voice" hint={voiceHint}>
          <Select aria-label="Voice" value={draft.voice} onChange={e => set('voice', e.target.value)}>
            {voiceOptions.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
          </Select>
        </Field>
        <Field label="Tone" hint={catalogHint ?? 'Shapes the generated system prompt.'}>
          <Select aria-label="Tone" value={draft.tone} onChange={e => set('tone', e.target.value)}>
            {toneOptions.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </Field>
        <Field label="Language" hint={catalogHint ?? 'Deployed to Retell with the campaign.'}>
          <Select aria-label="Language" value={draft.language} onChange={e => set('language', e.target.value)}>
            {languageOptions.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Persona" hint="Rendered into the system prompt on the next deploy."><TextArea rows={2} value={draft.persona ?? ''} onChange={e => set('persona', e.target.value)} /></Field>
      <Field label="Greeting override" hint="Rendered into the system prompt on the next deploy."><TextInput value={draft.greetingOverride ?? ''} onChange={e => set('greetingOverride', e.target.value)} /></Field>

      <div className="space-y-3 rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-bold text-t1">Retell deployment</p>
            <p className="text-[11px] text-t3">Deploy from the RetellAI Export tab, or link an agent you published yourself. CareCommand verifies either before it answers a call.</p>
          </div>
          <div className="flex items-center gap-2">
            {providerMode === 'mock' && <span className="badge badge-violet">mock mode</span>}
            <span className={`badge ${agent.providerStatus === 'VERIFIED' ? 'badge-emerald' : agent.providerStatus === 'INVALID' ? 'badge-red' : 'badge-amber'}`}>{agent.providerStatus}</span>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Retell agent ID"><TextInput aria-label="Retell agent ID" value={draft.providerAgentId ?? ''} onChange={e => set('providerAgentId', e.target.value || null)} placeholder="agent_…" /></Field>
          <Field label="Deployment tag" hint="Linked agents must carry this tag; deployed agents are pinned by version instead."><TextInput aria-label="Deployment tag" value={draft.providerVersionTag} onChange={e => set('providerVersionTag', e.target.value)} /></Field>
        </div>
        {!agent.providerAgentId && <p className="text-[11px] text-t3" role="status">No Retell agent linked yet.</p>}
        {agent.providerVersion !== null && <p className="text-[11px] text-t2">Pinned version {agent.providerVersion} · {agent.providerVoiceId ?? 'voice unavailable'} · {agent.providerLanguage ?? 'language unavailable'}</p>}
        {line
          ? <p className={`text-[11px] font-semibold ${TONE_TEXT[line.tone]}`}>{line.text}</p>
          : agent.providerVerifiedAt && <p className="text-[11px] text-t3">Verified {new Date(agent.providerVerifiedAt).toLocaleString()} · expires {agent.providerVerificationExpiresAt ? new Date(agent.providerVerificationExpiresAt).toLocaleString() : 'unknown'}</p>}
        {mismatch && (
          <div className="flex flex-wrap items-center gap-2" data-testid="provider-mismatch">
            <span className="badge badge-amber">
              Differs from verified provider ({[mismatch.voice ? agent.providerVoiceId : null, mismatch.language ? agent.providerLanguage : null].filter(Boolean).join(' / ')})
            </span>
            {onAdoptProviderValues && (
              <button
                type="button"
                disabled={busy || dirty}
                onClick={adopt}
                title={dirty ? 'Save or discard these changes before adopting the provider values.' : 'Copy the verified provider voice and language onto this agent.'}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t1 disabled:opacity-40"
              >
                {isBusy(adoptState.state) ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <ArrowDownToLine className="h-3 w-3" aria-hidden="true" />} Adopt provider values
              </button>
            )}
            {dirty && onAdoptProviderValues && <span className="text-[11px] font-semibold text-amber-v">Save or discard these changes before adopting the provider values.</span>}
          </div>
        )}
        {/* Outside the mismatch block on purpose: a successful adopt clears the
            mismatch, and the notice used to vanish with it — so the one action
            that fixed the drift never confirmed that it had. */}
        <MutationNotice state={adoptState.state} savedLabel="Provider voice and language adopted" />
        {agent.providerLastErrorCode && (
          <div role="alert" className="space-y-1 rounded-lg border border-red-v/40 bg-[var(--red-soft)] px-3 py-2 text-xs text-red-v">
            <p className="font-semibold">
              Last provider check{agent.providerLastAttemptAt ? ` (${new Date(agent.providerLastAttemptAt).toLocaleString()})` : ''}: {agent.providerLastErrorCode.replaceAll('_', ' ')}
            </p>
            {errorRemediation && (
              <p className="text-red-v/90"><span className="font-semibold">{errorRemediation.title}</span> — {errorRemediation.action} <FixLink href={errorRemediation.fixHref} label={`Fix ${errorRemediation.title}`} /></p>
            )}
          </div>
        )}
        {agentBlockers.filter(blocker => blocker !== errorRemediation).length > 0 && (
          <ul className="space-y-1" aria-label="Agent blockers">
            {agentBlockers.filter(blocker => blocker !== errorRemediation).map(blocker => (
              <li key={blocker.code} className="flex items-start gap-2 text-[11px] text-t2">
                <span className={`badge ${blocker.severity === 'blocking' ? 'badge-amber' : 'badge-blue'}`}>{blocker.severity}</span>
                <span><span className="font-semibold text-t1">{blocker.title}</span> — {blocker.action}</span>
                <FixLink href={blocker.fixHref} label={`Fix ${blocker.title}`} />
              </li>
            ))}
          </ul>
        )}
        <MutationNotice
          state={verifyState.state}
          savedLabel="Provider deployment verified"
          onRetry={verifyState.state.status === 'error' && !dirty && agent.providerAgentId && cooldownSeconds === 0 ? verify : undefined}
          retryLabel="Verify again"
        />
        {cooldownSeconds > 0 && <p role="status" className="text-[11px] font-semibold text-amber-v">Provider check cooling down — retry in {cooldownSeconds}s.</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Toggle checked={draft.active} onChange={value => set('active', value)} label="Agent active" />
          <div className="flex flex-wrap items-center gap-2">
            {onDelete && (
              <ConfirmedButton
                dialogTitle="Delete this agent?"
                message={`Delete ${agent.name}? Its provider link and verification history are removed. This cannot be undone.`}
                confirmLabel="Delete agent"
                tone="red"
                disabled={busy || referenced}
                buttonTitle={referenced ? 'Unlink this agent from the campaign before deleting it.' : 'Delete the agent'}
                onConfirm={remove}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-red-v disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete agent
              </ConfirmedButton>
            )}
            <button
              type="button"
              disabled={busy || Boolean(verifyBlockReason) || cooldownSeconds > 0}
              onClick={verify}
              title={cooldownSeconds > 0 ? `Retry in ${cooldownSeconds}s` : verifyBlockReason ?? 'Ask the provider for the published agent and compare it to this configuration.'}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t1 disabled:opacity-40"
            >
              {isBusy(verifyState.state) ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
              {cooldownSeconds > 0 ? `Retry in ${cooldownSeconds}s` : 'Verify provider deployment'}
            </button>
          </div>
        </div>
        {verifyBlockReason && cooldownSeconds === 0 && <p className="text-[11px] font-semibold text-amber-v">{verifyBlockReason}</p>}
        <MutationNotice state={deleteState.state} showSaved={false} />
      </div>

      <MutationNotice state={saveState.state} showSaved={false} onRetry={dirty ? save : undefined} />
      {saveBlockedBy.length > 0 && (
        <p role="alert" className="text-xs text-amber-v">
          Pause {saveBlockedBy.length === 1 ? 'this campaign' : 'these campaigns'} before changing the provider binding: {saveBlockedBy.map(row => row.name).join(', ')}.
        </p>
      )}
      <SaveBar dirty={dirty} busy={busy} onSave={save} savedAt={savedAtOf(saveState.state)} />

      {confirmBinding && (
        <ConfirmationModal
          title="Change the linked Retell agent?"
          message="Changing the agent ID or tag resets provider verification. Campaigns that use this agent cannot answer or place calls until the new binding is verified; active campaigns must be paused first."
          confirmLabel="Change binding"
          tone="amber"
          onConfirm={commitSave}
          onClose={() => setConfirmBinding(false)}
        />
      )}
    </div>
  );
}
