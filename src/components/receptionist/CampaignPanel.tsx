import { useCallback, useEffect, useState } from 'react';
import { Bot, Trash2, Check, Megaphone, Link2 } from 'lucide-react';
import { Field, TextInput, TextArea, Select, Toggle } from '../ui/Field';
import { receptionistApi as api, CAMPAIGN_TYPES, type Clinic, type Campaign, type Agent } from '../../lib/receptionist';
import {
  channelUsable, deploymentApi, useReceptionistCatalog, withCurrentOption,
  type AgentRow, type ChannelStatus, type ConfirmationChannels, type ReadinessResponse, type RetellStatusResponse,
} from '../../lib/receptionistDeployment';
import { ApiError } from '../../lib/api';
import { describeFailure, receivedData, type ResourceFailure } from '../../lib/resourceState';
import { useResource } from '../../hooks/useResource';
import { isBusy, savedAtOf, useMutationState } from '../../hooks/useMutationState';
import { formatEnumLabel } from './helpers';
import { ConfirmedButton, SaveBar } from './shared';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';
import { AgentEditor } from './AgentEditor';
import { ReadinessChecklist } from './ReadinessChecklist';
import { CampaignActions } from './CampaignActions';
import { GoLiveCard } from './GoLiveCard';

// ===== Campaign Panel (agent + campaign) ===================================

const CHANNEL_BADGE: Record<ChannelStatus['status'], string> = {
  live: 'badge badge-emerald', mock: 'badge badge-violet', configured_pending: 'badge badge-amber', unconfigured: 'badge badge-amber',
};

function ChannelToggle({ label, channel, checked, onChange }: {
  label: string; channel: ChannelStatus | null; checked: boolean; onChange: (next: boolean) => void;
}) {
  // A toggle for a channel that cannot deliver would promise a confirmation
  // no patient receives; it stays disabled with the server's own reason.
  const usable = channelUsable(channel);
  const disabled = channel !== null && !usable;
  return (
    <div className="space-y-1">
      <div className={disabled ? 'opacity-50' : undefined} aria-disabled={disabled || undefined}>
        <Toggle checked={checked} onChange={next => { if (!disabled) onChange(next); }} label={label} />
      </div>
      {channel && (
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
          <span className={CHANNEL_BADGE[channel.status]}>{channel.status.replaceAll('_', ' ')}</span>
          {channel.detail}
        </p>
      )}
    </div>
  );
}

export function CampaignPanel({ clinic, campaign, onChanged }: { clinic: Clinic; campaign: Campaign; onChanged: () => Promise<unknown> }) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsFailure, setAgentsFailure] = useState<ResourceFailure | null>(null);
  const [draft, setDraft] = useState<Campaign>(campaign);
  const saveState = useMutationState();
  const createAgentState = useMutationState();
  const removeState = useMutationState();
  const [newAgentName, setNewAgentName] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(campaign);
  const locations = clinic.locations ?? [];
  const staleLocationIds = draft.eligibleLocationIds.filter(id => !locations.some(location => location.id === id));
  const rules = draft.bookingRules ?? {};
  const busy = isBusy(saveState.state) || isBusy(createAgentState.state);

  const { catalog } = useReceptionistCatalog();
  const loadReadiness = useCallback((signal: AbortSignal) => deploymentApi.readiness(campaign.id, signal), [campaign.id]);
  const readinessResource = useResource<ReadinessResponse>(loadReadiness);
  const readiness = receivedData(readinessResource.state);
  const loadChannels = useCallback((signal: AbortSignal) => deploymentApi.confirmationChannels(signal), []);
  const channelsResource = useResource<ConfirmationChannels>(loadChannels);
  const channels = receivedData(channelsResource.state);
  const loadStatus = useCallback((signal: AbortSignal) => deploymentApi.retellStatus({ campaignId: campaign.id }, signal), [campaign.id]);
  const statusResource = useResource<RetellStatusResponse>(loadStatus);
  const providerStatus = receivedData(statusResource.state);

  const loadAgents = useCallback(async () => {
    try {
      const rows = await api.listAgents(clinic.id);
      setAgents(rows);
      setAgentsFailure(null);
    } catch (error) {
      setAgentsFailure(describeFailure(error));
    }
  }, [clinic.id]);

  useEffect(() => { void (async () => { await loadAgents(); })(); }, [loadAgents]);

  const set = <K extends keyof Campaign>(key: K, value: Campaign[K]) => setDraft(prev => ({ ...prev, [key]: value }));
  const setRule = (key: string, value: unknown) => setDraft(prev => ({ ...prev, bookingRules: { ...prev.bookingRules, [key]: value } }));

  const activeAgent = agents.find(a => a.id === draft.agentId) ?? null;

  const reloadReadiness = readinessResource.reload;
  const reloadStatus = statusResource.reload;

  async function refreshAll() {
    await onChanged();
    reloadReadiness();
    reloadStatus();
  }

  async function ensureAgentAndSave() {
    await saveState.run(async () => {
      // `status` is deliberately not sent: transitions go through
      // CampaignActions so the readiness gate is the only way in.
      await api.updateCampaign(campaign.id, {
        name: draft.name, campaignType: draft.campaignType, agentId: draft.agentId,
        offerTitle: draft.offerTitle, offerDescription: draft.offerDescription, offerScript: draft.offerScript,
        appointmentType: draft.appointmentType, bookingRules: draft.bookingRules, eligibleLocationIds: draft.eligibleLocationIds,
        smsConfirmation: draft.smsConfirmation, emailConfirmation: draft.emailConfirmation,
      });
      await refreshAll();
    });
  }

  // AgentEditor owns the mutation state for these: it shows the server's
  // code/message next to the provider evidence block. All of them must throw.
  async function saveAgent(patch: Partial<Agent>) {
    if (!activeAgent) throw new Error('Select an agent before saving.');
    const updated = await api.updateAgent(activeAgent.id, patch);
    const merged: AgentRow = { ...activeAgent, ...updated };
    setAgents(prev => prev.map(a => (a.id === updated.id ? { ...a, ...updated } : a)));
    reloadReadiness();
    reloadStatus();
    // Handed back so the editor refreshes its draft from what the server stored.
    return merged;
  }

  async function verifyAgent() {
    if (!activeAgent) return;
    try {
      const updated = await api.verifyAgentProvider(activeAgent.id);
      setAgents(prev => prev.map(a => (a.id === updated.id ? { ...a, ...updated } : a)));
      reloadReadiness();
      reloadStatus();
    } catch (error) {
      // A failed provider request still records a durable attempt state, and
      // the 409/503 body carries the row as `agent`. Show that state even
      // though the request failed, then let the editor show the cause.
      const row = error instanceof ApiError ? (error.details?.agent as AgentRow | undefined) : undefined;
      if (row && typeof row === 'object' && typeof row.id === 'string') {
        setAgents(prev => prev.map(a => (a.id === row.id ? row : a)));
      } else {
        await loadAgents();
      }
      throw error;
    }
  }

  async function adoptProviderValues() {
    if (!activeAgent) return;
    const updated = await deploymentApi.adoptProviderValues(activeAgent.id);
    setAgents(prev => prev.map(a => (a.id === updated.id ? { ...a, ...updated } : a)));
    reloadReadiness();
  }

  async function createNamedAgent() {
    const name = newAgentName.trim();
    if (!name) return;
    await createAgentState.run(async () => {
      const created = await api.createAgent({ clinicId: clinic.id, name });
      setAgents(prev => [...prev, created]);
      setDraft(prev => ({ ...prev, agentId: created.id }));
      setNewAgentName('');
    }, { successMessage: `Agent "${name}" created — save the campaign to link it.` });
  }

  async function deleteCampaign() {
    await removeState.run(async () => {
      await api.deleteCampaign(campaign.id);
      await onChanged();
    }, { rethrow: true });
  }

  function toggleLocation(id: string) {
    set('eligibleLocationIds', draft.eligibleLocationIds.includes(id)
      ? draft.eligibleLocationIds.filter(l => l !== id)
      : [...draft.eligibleLocationIds, id]);
  }

  const campaignTypeOptions = withCurrentOption(
    catalog?.campaignTypes.length ? catalog.campaignTypes : CAMPAIGN_TYPES.map(t => ({ id: t, label: formatEnumLabel(t) })),
    draft.campaignType,
  );

  return (
    <div className="space-y-4">
      <GoLiveCard readiness={readiness} campaignStatus={campaign.status} providerMode={providerStatus?.providerMode ?? catalog?.providerMode ?? null} />

      <div className="cc-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-t1">Activation</h3>
          <span className={`badge ${campaign.status === 'ACTIVE' ? 'badge-emerald' : campaign.status === 'PAUSED' ? 'badge-amber' : 'badge-blue'}`}>{formatEnumLabel(campaign.status)}</span>
        </div>
        {readinessResource.state.status === 'error' && (
          <LoadFailureNotice what="Activation readiness" message={readinessResource.state.failure.message} onRetry={readinessResource.reload} />
        )}
        {readiness && <ReadinessChecklist readiness={readiness} />}
        <CampaignActions campaign={campaign} readiness={readiness} onChanged={refreshAll} />
      </div>

      {/* Agent */}
      <div className="cc-card p-5 space-y-4">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Bot className="w-4 h-4 text-violet-v" /> Agent</h3>
        {agentsFailure && <LoadFailureNotice what="Agents" message={agentsFailure.message} onRetry={() => void loadAgents()} />}
        <Field label="Campaign agent" hint="Runnable campaigns require a fresh verified provider deployment.">
          <Select value={draft.agentId ?? ''} disabled={Boolean(agentsFailure)} onChange={e => set('agentId', e.target.value || null)}>
            <option value="">{agentsFailure ? 'Agents could not be loaded' : 'No agent linked (draft only)'}</option>
            {agents.map(row => <option key={row.id} value={row.id}>{row.name} · {row.providerStatus}</option>)}
          </Select>
        </Field>
        {activeAgent ? (
          <AgentEditor
            key={activeAgent.id}
            agent={activeAgent}
            onSave={saveAgent}
            onVerify={verifyAgent}
            onAdoptProviderValues={adoptProviderValues}
            referenced={campaign.agentId === activeAgent.id}
            verification={providerStatus?.verification ?? null}
            blockers={providerStatus?.blockers ?? []}
            providerMode={providerStatus?.providerMode ?? catalog?.providerMode ?? null}
            catalog={catalog}
          />
        ) : (
          <div className="space-y-2" data-testid="no-agent-linked">
            <div role="status" className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
              <p className="text-xs font-semibold text-t1 inline-flex items-center gap-1.5"><Link2 className="w-3.5 h-3.5 text-t3" /> No agent linked</p>
              <p className="text-[11px] text-t3 mt-0.5">
                This campaign has no receptionist yet, so it cannot answer or place calls. Name one below, or choose an existing agent above.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <TextInput aria-label="New agent name" placeholder="Enter a receptionist name" value={newAgentName} onChange={e => setNewAgentName(e.target.value)} />
              <button type="button" disabled={!newAgentName.trim() || busy || Boolean(agentsFailure)} onClick={createNamedAgent} className="rounded-xl bg-indigo px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Create agent</button>
            </div>
            <MutationNotice state={createAgentState.state} onRetry={newAgentName.trim() ? createNamedAgent : undefined} />
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
            disabled={isBusy(removeState.state) || campaign.status === 'ACTIVE'}
            buttonTitle={campaign.status === 'ACTIVE' ? 'Pause the campaign before deleting it.' : 'Delete the campaign'}
            onConfirm={deleteCampaign}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)] disabled:opacity-40"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </ConfirmedButton>
        </div>
        <MutationNotice state={removeState.state} showSaved={false} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Campaign name" required><TextInput value={draft.name} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="Campaign type">
            <Select aria-label="Campaign type" value={draft.campaignType} onChange={e => set('campaignType', e.target.value)}>
              {campaignTypeOptions.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
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
            {staleLocationIds.map(id => (
              <button key={id} type="button" onClick={() => toggleLocation(id)} title="Remove this deleted location reference, then save the campaign"
                className="rounded-xl border border-red-v/40 bg-[var(--red-soft)] px-3 py-1.5 text-xs font-semibold text-red-v">
                Remove deleted location · {id.slice(0, 8)}
              </button>
            ))}
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

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Confirmations</p>
          {channelsResource.state.status === 'error' && (
            <LoadFailureNotice what="Confirmation channel status" message={channelsResource.state.failure.message} onRetry={channelsResource.reload} className="mb-2" />
          )}
          <div className="flex flex-wrap gap-4">
            <ChannelToggle label="SMS confirmation" channel={channels?.sms ?? null} checked={draft.smsConfirmation} onChange={v => set('smsConfirmation', v)} />
            <ChannelToggle label="Email confirmation" channel={channels?.email ?? null} checked={draft.emailConfirmation} onChange={v => set('emailConfirmation', v)} />
          </div>
        </div>

        <MutationNotice state={saveState.state} showSaved={false} onRetry={dirty ? ensureAgentAndSave : undefined} />
        <SaveBar dirty={dirty} busy={busy} onSave={ensureAgentAndSave} savedAt={savedAtOf(saveState.state)} />
      </div>
    </div>
  );
}
