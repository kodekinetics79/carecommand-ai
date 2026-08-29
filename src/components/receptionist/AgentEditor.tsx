import { useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Field, TextInput, TextArea, Select, Toggle } from '../ui/Field';
import { VOICE_OPTIONS, TONE_OPTIONS, LANGUAGE_OPTIONS, type Agent } from '../../lib/receptionist';
import { isBusy, savedAtOf, useMutationState } from '../../hooks/useMutationState';
import { SaveBar } from './shared';
import { MutationNotice } from './MutationNotice';

/** The fields this editor owns. Provider snapshot fields are read from the prop, never from the draft. */
function editableFields(agent: Agent) {
  return {
    name: agent.name, voice: agent.voice, tone: agent.tone, language: agent.language,
    persona: agent.persona, greetingOverride: agent.greetingOverride, active: agent.active,
    providerAgentId: agent.providerAgentId, providerVersionTag: agent.providerVersionTag,
  };
}

/**
 * Keyed by agent id only (see CampaignPanel). It used to remount on every
 * `providerLastAttemptAt` change, which wiped the drift / verification error
 * the user had just been shown. The draft holds the editable subset; the
 * provider evidence block always reads the latest `agent` prop.
 */
export function AgentEditor({ agent, onSave, onVerify }: { agent: Agent; onSave: (patch: Partial<Agent>) => Promise<void>; onVerify: () => Promise<void> }) {
  const [draft, setDraft] = useState<Agent>(agent);
  const saveState = useMutationState();
  const verifyState = useMutationState();
  const busy = isBusy(saveState.state) || isBusy(verifyState.state);
  const dirty = JSON.stringify(editableFields(draft)) !== JSON.stringify(editableFields(agent));
  const set = <K extends keyof Agent>(key: K, value: Agent[K]) => setDraft(prev => ({ ...prev, [key]: value }));

  async function save() {
    await saveState.run(() => onSave(editableFields(draft)));
  }

  async function verify() {
    await verifyState.run(() => onVerify(), { successMessage: 'Provider deployment verified' });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Agent name" required><TextInput value={draft.name} onChange={e => set('name', e.target.value)} /></Field>
        <Field label="Prompt-preview voice" hint="Launch uses the provider-verified voice snapshot.">
          <Select value={draft.voice} onChange={e => set('voice', e.target.value)}>
            {VOICE_OPTIONS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
          </Select>
        </Field>
        <Field label="Prompt-preview tone" hint="Preview/export only; saving does not deploy this value to the linked Retell agent.">
          <Select value={draft.tone} onChange={e => set('tone', e.target.value)}>
            {[...new Set([draft.tone, ...TONE_OPTIONS])].map(t => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Prompt-preview language" hint="Launch uses the provider-verified language snapshot.">
          <Select value={draft.language} onChange={e => set('language', e.target.value)}>
            {LANGUAGE_OPTIONS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Prompt-preview persona" hint="Preview/export only; this is not synchronized to the linked Retell response engine."><TextArea rows={2} value={draft.persona ?? ''} onChange={e => set('persona', e.target.value)} /></Field>
      <Field label="Prompt-preview greeting" hint="Preview/export only; live calls use the separately configured and verified provider deployment."><TextInput value={draft.greetingOverride ?? ''} onChange={e => set('greetingOverride', e.target.value)} /></Field>
      <div className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-bold text-t1">Retell deployment</p>
            <p className="text-[11px] text-t3">Link an existing published agent. CareCommand only reads and verifies it.</p>
          </div>
          <span className={`badge ${agent.providerStatus === 'VERIFIED' ? 'badge-emerald' : agent.providerStatus === 'INVALID' ? 'badge-red' : 'badge-amber'}`}>{agent.providerStatus}</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Retell agent ID"><TextInput value={draft.providerAgentId ?? ''} onChange={e => set('providerAgentId', e.target.value || null)} placeholder="agent_…" /></Field>
          <Field label="Deployment tag" hint="The returned agent must explicitly contain this tag."><TextInput value={draft.providerVersionTag} onChange={e => set('providerVersionTag', e.target.value)} /></Field>
        </div>
        {agent.providerVersion !== null && <p className="text-[11px] text-t2">Pinned version {agent.providerVersion} · {agent.providerVoiceId ?? 'voice unavailable'} · {agent.providerLanguage ?? 'language unavailable'}</p>}
        {agent.providerVerifiedAt && <p className="text-[11px] text-t3">Verified {new Date(agent.providerVerifiedAt).toLocaleString()} · expires {agent.providerVerificationExpiresAt ? new Date(agent.providerVerificationExpiresAt).toLocaleString() : 'unknown'}</p>}
        {agent.providerLastErrorCode && (
          <p role="alert" className="text-xs font-semibold text-red-v">
            Last provider check{agent.providerLastAttemptAt ? ` (${new Date(agent.providerLastAttemptAt).toLocaleString()})` : ''}: {agent.providerLastErrorCode.replaceAll('_', ' ')}
          </p>
        )}
        <MutationNotice state={verifyState.state} savedLabel="Provider deployment verified" onRetry={verifyState.state.status === 'error' && !dirty && agent.providerAgentId ? verify : undefined} retryLabel="Verify again" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Toggle checked={draft.active} onChange={value => set('active', value)} label="Agent active" />
          <button type="button" disabled={busy || dirty || !agent.providerAgentId} onClick={verify} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t1 disabled:opacity-40">
            {isBusy(verifyState.state) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />} Verify provider deployment
          </button>
        </div>
      </div>
      <MutationNotice state={saveState.state} showSaved={false} onRetry={dirty ? save : undefined} />
      <SaveBar dirty={dirty} busy={busy} onSave={save} savedAt={savedAtOf(saveState.state)} />
    </div>
  );
}
