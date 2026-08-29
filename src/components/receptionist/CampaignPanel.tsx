import { useEffect, useState } from 'react';
import { Bot, Trash2, Check, Megaphone } from 'lucide-react';
import { Field, TextInput, TextArea, Select, Toggle } from '../ui/Field';
import { receptionistApi as api, CAMPAIGN_TYPES, type Clinic, type Campaign, type Agent } from '../../lib/receptionist';
import { formatEnumLabel } from './helpers';
import { ConfirmedButton, SaveBar } from './shared';
import { AgentEditor } from './AgentEditor';

// ===== Campaign Panel (agent + campaign) ===================================

export function CampaignPanel({ clinic, campaign, onChanged }: { clinic: Clinic; campaign: Campaign; onChanged: () => Promise<unknown> }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draft, setDraft] = useState<Campaign>(campaign);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [newAgentName, setNewAgentName] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(campaign);
  const locations = clinic.locations ?? [];
  const rules = draft.bookingRules ?? {};

  useEffect(() => { void api.listAgents(clinic.id).then(setAgents); }, [clinic.id]);

  const set = <K extends keyof Campaign>(key: K, value: Campaign[K]) => setDraft(prev => ({ ...prev, [key]: value }));
  const setRule = (key: string, value: unknown) => setDraft(prev => ({ ...prev, bookingRules: { ...prev.bookingRules, [key]: value } }));

  const activeAgent = agents.find(a => a.id === draft.agentId) ?? null;

  async function ensureAgentAndSave() {
    setBusy(true);
    try {
      await api.updateCampaign(campaign.id, {
        name: draft.name, campaignType: draft.campaignType, status: draft.status, agentId: draft.agentId,
        offerTitle: draft.offerTitle, offerDescription: draft.offerDescription, offerScript: draft.offerScript,
        appointmentType: draft.appointmentType, bookingRules: draft.bookingRules, eligibleLocationIds: draft.eligibleLocationIds,
        smsConfirmation: draft.smsConfirmation, emailConfirmation: draft.emailConfirmation,
      });
      await onChanged();
      setSavedAt(Date.now());
    } finally { setBusy(false); }
  }

  async function saveAgent(patch: Partial<Agent>) {
    if (!activeAgent) return;
    const updated = await api.updateAgent(activeAgent.id, patch);
    setAgents(prev => prev.map(a => (a.id === updated.id ? updated : a)));
  }

  async function verifyAgent() {
    if (!activeAgent) return;
    try {
      const updated = await api.verifyAgentProvider(activeAgent.id);
      setAgents(prev => prev.map(a => (a.id === updated.id ? updated : a)));
    } finally {
      // A failed provider request still records a durable safe attempt state.
      // Refresh so Studio shows that state even when the API returns 503/409.
      setAgents(await api.listAgents(clinic.id));
    }
  }

  async function createNamedAgent() {
    const name = newAgentName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await api.createAgent({ clinicId: clinic.id, name });
      setAgents(prev => [...prev, created]);
      setDraft(prev => ({ ...prev, agentId: created.id }));
      setNewAgentName('');
    } finally { setBusy(false); }
  }

  async function deleteCampaign() {
    await api.deleteCampaign(campaign.id);
    await onChanged();
  }

  function toggleLocation(id: string) {
    set('eligibleLocationIds', draft.eligibleLocationIds.includes(id)
      ? draft.eligibleLocationIds.filter(l => l !== id)
      : [...draft.eligibleLocationIds, id]);
  }

  return (
    <div className="space-y-4">
      {/* Agent */}
      <div className="cc-card p-5 space-y-4">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Bot className="w-4 h-4 text-violet-v" /> Agent</h3>
        <Field label="Campaign agent" hint="Runnable campaigns require a fresh verified provider deployment.">
          <Select value={draft.agentId ?? ''} onChange={e => set('agentId', e.target.value || null)}>
            <option value="">No agent linked (draft only)</option>
            {agents.map(row => <option key={row.id} value={row.id}>{row.name} · {row.providerStatus}</option>)}
          </Select>
        </Field>
        {activeAgent ? (
          <AgentEditor
            key={`${activeAgent.id}:${activeAgent.providerLastAttemptAt ?? 'never'}:${activeAgent.providerStatus}:${activeAgent.providerVersion ?? 'unbound'}`}
            agent={activeAgent}
            onSave={saveAgent}
            onVerify={verifyAgent}
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <TextInput aria-label="New agent name" placeholder="Enter a receptionist name" value={newAgentName} onChange={e => setNewAgentName(e.target.value)} />
            <button type="button" disabled={!newAgentName.trim() || busy} onClick={createNamedAgent} className="rounded-xl bg-indigo px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Create agent</button>
          </div>
        )}
      </div>

      {/* Campaign */}
      <div className="cc-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Megaphone className="w-4 h-4 text-indigo" /> Campaign</h3>
          <ConfirmedButton
            dialogTitle="Delete receptionist campaign?"
            message={`Delete ${campaign.name} and its configuration? This action cannot be undone.`}
            confirmLabel="Delete campaign"
            tone="red"
            onConfirm={deleteCampaign}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)]"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </ConfirmedButton>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Campaign name" required><TextInput value={draft.name} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="Campaign type">
            <Select value={draft.campaignType} onChange={e => set('campaignType', e.target.value)}>
              {CAMPAIGN_TYPES.map(t => <option key={t} value={t}>{formatEnumLabel(t)}</option>)}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={draft.status} onChange={e => set('status', e.target.value as Campaign['status'])}>
              {['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Appointment type" required><TextInput value={draft.appointmentType} onChange={e => set('appointmentType', e.target.value)} /></Field>
        </div>
        <Field label="Offer title" required><TextInput value={draft.offerTitle} onChange={e => set('offerTitle', e.target.value)} /></Field>
        <Field label="Offer description" required><TextArea rows={2} value={draft.offerDescription} onChange={e => set('offerDescription', e.target.value)} /></Field>
        <Field label="Offer script" hint="The exact pitch the agent uses when the caller is interested." required>
          <TextArea rows={3} value={draft.offerScript} onChange={e => set('offerScript', e.target.value)} />
        </Field>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Eligible locations</p>
          <div className="flex flex-wrap gap-2">
            {locations.length === 0 && <p className="text-xs text-t3">Add locations in the Clinic Profile tab first.</p>}
            {locations.map(loc => {
              const on = draft.eligibleLocationIds.includes(loc.id);
              return (
                <button key={loc.id} type="button" onClick={() => toggleLocation(loc.id)}
                  className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${on ? 'border-indigo bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] bg-[var(--s3)] text-t3'}`}>
                  {on ? <Check className="w-3 h-3 inline mr-1" /> : null}{loc.name}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Booking rules</p>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Slot length (min)"><TextInput type="number" value={rules.slotDurationMinutes ?? ''} onChange={e => setRule('slotDurationMinutes', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            <Field label="Lead time (hrs)"><TextInput type="number" value={rules.leadTimeHours ?? ''} onChange={e => setRule('leadTimeHours', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            <Field label="Max per day"><TextInput type="number" value={rules.maxPerDay ?? ''} onChange={e => setRule('maxPerDay', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            <Field label="Hours start"><TextInput placeholder="08:00" value={rules.hoursStart ?? ''} onChange={e => setRule('hoursStart', e.target.value || undefined)} /></Field>
            <Field label="Hours end"><TextInput placeholder="17:00" value={rules.hoursEnd ?? ''} onChange={e => setRule('hoursEnd', e.target.value || undefined)} /></Field>
            <Field label="Available days" hint="Comma separated">
              <TextInput placeholder="Monday, Tuesday…" value={(rules.availableDays ?? []).join(', ')} onChange={e => setRule('availableDays', e.target.value.split(',').map(d => d.trim()).filter(Boolean))} />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Toggle checked={draft.smsConfirmation} onChange={v => set('smsConfirmation', v)} label="SMS confirmation" />
          <Toggle checked={draft.emailConfirmation} onChange={v => set('emailConfirmation', v)} label="Email confirmation" />
        </div>

        <SaveBar dirty={dirty} busy={busy} onSave={ensureAgentAndSave} savedAt={savedAt} />
      </div>
    </div>
  );
}
