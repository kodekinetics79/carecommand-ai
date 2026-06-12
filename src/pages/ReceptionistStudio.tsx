import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot, Building2, Plus, Trash2, Save, Sparkles, Phone,
  GripVertical, ChevronUp, ChevronDown, Copy, Check, ShieldCheck, PhoneOff,
  Megaphone, ListChecks, Eye, Code2, Activity, MapPin, Loader2, AlertCircle,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import { Field, TextInput, TextArea, Select, Toggle } from '../components/ui/Field';
import {
  receptionistApi as api,
  FIELD_CATALOG, VOICE_OPTIONS, TONE_OPTIONS, LANGUAGE_OPTIONS, CAMPAIGN_TYPES, TIMEZONE_OPTIONS,
  type Clinic, type Campaign, type IntakeField, type Agent, type FieldType,
  type PromptResult, type RetellConfig, type CallLog, type AppointmentRequest, type OptOut, type Overview,
} from '../lib/receptionist';

type Tab = 'clinic' | 'campaign' | 'intake' | 'preview' | 'retell' | 'activity';

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'clinic', label: 'Clinic Profile', icon: Building2 },
  { id: 'campaign', label: 'Agent & Campaign', icon: Megaphone },
  { id: 'intake', label: 'Intake Builder', icon: ListChecks },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'retell', label: 'RetellAI Export', icon: Code2 },
  { id: 'activity', label: 'Activity', icon: Activity },
];

const outcomeBadge: Record<string, string> = {
  BOOKED: 'badge badge-emerald', NOT_INTERESTED: 'badge badge-amber', NO_ANSWER: 'badge badge-blue',
  VOICEMAIL: 'badge badge-blue', ESCALATED: 'badge badge-red', OPTED_OUT: 'badge badge-violet',
  FAILED: 'badge badge-red', IN_PROGRESS: 'badge badge-blue',
};

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-v" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export default function ReceptionistStudio() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activeClinicId, setActiveClinicId] = useState<string>('');
  const [activeCampaignId, setActiveCampaignId] = useState<string>('');
  const [tab, setTab] = useState<Tab>('clinic');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeClinic = clinics.find(c => c.id === activeClinicId) ?? null;
  const activeCampaign = campaigns.find(c => c.id === activeCampaignId) ?? null;

  const loadClinics = useCallback(async () => {
    const [rows, ov] = await Promise.all([api.listClinics(), api.overview().catch(() => null)]);
    setClinics(rows);
    if (ov) setOverview(ov);
    setActiveClinicId(prev => (prev && rows.some(r => r.id === prev) ? prev : rows[0]?.id ?? ''));
    return rows;
  }, []);

  const loadCampaigns = useCallback(async (clinicId: string) => {
    const rows = await (clinicId ? api.listCampaigns(clinicId) : Promise.resolve<Campaign[]>([]));
    setCampaigns(rows);
    setActiveCampaignId(prev => (prev && rows.some(r => r.id === prev) ? prev : rows[0]?.id ?? ''));
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await loadClinics();
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [loadClinics]);

  useEffect(() => {
    let active = true;
    (activeClinicId ? api.listCampaigns(activeClinicId) : Promise.resolve<Campaign[]>([])).then(rows => {
      if (!active) return;
      setCampaigns(rows);
      setActiveCampaignId(prev => (prev && rows.some(r => r.id === prev) ? prev : rows[0]?.id ?? ''));
    });
    return () => { active = false; };
  }, [activeClinicId]);

  async function handleCreateClinic() {
    const name = window.prompt('New clinic name?');
    if (!name) return;
    const clinic = await api.createClinic({ name, phone: '+1 (555) 000-0000' });
    await loadClinics();
    setActiveClinicId(clinic.id);
    setTab('clinic');
  }

  async function handleCreateCampaign() {
    if (!activeClinicId) return;
    const name = window.prompt('New campaign name?');
    if (!name) return;
    const campaign = await api.createCampaign({
      clinicId: activeClinicId,
      name,
      offerTitle: 'New offer',
      offerDescription: 'Describe the offer here.',
      offerScript: 'Introduce the offer warmly and ask if they would like to book.',
      appointmentType: 'Consultation',
      eligibleLocationIds: activeClinic?.locations?.map(l => l.id) ?? [],
    });
    await loadCampaigns(activeClinicId);
    setActiveCampaignId(campaign.id);
    setTab('campaign');
  }

  if (loading) {
    return <div className="flex items-center justify-center py-24 text-sm text-t3"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading Receptionist Studio…</div>;
  }

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="AI Receptionist Studio"
        subtitle="Configure a RetellAI-ready voice agent for any clinic — profile, campaign, intake flow, prompt, and live test config."
        badge={`${clinics.length} clinic${clinics.length === 1 ? '' : 's'}`}
        badgeColor="violet"
        actions={
          <button type="button" onClick={handleCreateClinic} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            <Plus className="w-4 h-4" /> New Clinic
          </button>
        }
      />

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--red-soft)] px-3 py-2 text-xs font-semibold text-red-v">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {overview && (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
          <StatCard title="Active Campaigns" value={`${overview.activeCampaigns}/${overview.totalCampaigns}`} icon={<Megaphone className="w-4 h-4" />} accent="violet" />
          <StatCard title="Calls Handled" value={String(overview.totalCalls)} icon={<Phone className="w-4 h-4" />} accent="blue" />
          <StatCard title="Booking Rate" value={`${overview.bookingRate}%`} subtitle={`${overview.booked} booked`} icon={<Sparkles className="w-4 h-4" />} accent="emerald" />
          <StatCard title="Avg Call" value={`${Math.floor(overview.avgDurationSeconds / 60)}m ${overview.avgDurationSeconds % 60}s`} icon={<Activity className="w-4 h-4" />} accent="cyan" />
          <StatCard title="Do-Not-Contact" value={String(overview.optOuts)} icon={<PhoneOff className="w-4 h-4" />} accent="red" />
        </div>
      )}

      {clinics.length === 0 ? (
        <div className="cc-card p-10 text-center">
          <Bot className="w-8 h-8 text-t3 mx-auto mb-3" />
          <p className="text-sm font-semibold text-t1 mb-1">No clinics configured yet</p>
          <p className="text-xs text-t3 mb-4">Create your first clinic to start building an AI receptionist.</p>
          <button type="button" onClick={handleCreateClinic} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            <Plus className="w-4 h-4" /> Create Clinic
          </button>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[260px_1fr]">
          {/* Left rail: clinic + campaign selectors */}
          <div className="space-y-4">
            <div className="cc-card p-3 space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Clinics</p>
                <button type="button" aria-label="Add clinic" title="Add clinic" onClick={handleCreateClinic} className="text-t3 hover:text-indigo"><Plus className="w-3.5 h-3.5" /></button>
              </div>
              {clinics.map(clinic => (
                <button
                  key={clinic.id}
                  type="button"
                  onClick={() => setActiveClinicId(clinic.id)}
                  className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${clinic.id === activeClinicId ? 'bg-[var(--violet-soft)] border border-[var(--b1)]' : 'hover:bg-[var(--s3)]'}`}
                >
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white shrink-0">
                    <Building2 className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-t1 truncate">{clinic.name}</p>
                    <p className="text-[10px] text-t3 truncate">{clinic.locations?.length ?? 0} location{(clinic.locations?.length ?? 0) === 1 ? '' : 's'} · {clinic._count?.campaigns ?? 0} campaign{(clinic._count?.campaigns ?? 0) === 1 ? '' : 's'}</p>
                  </div>
                </button>
              ))}
            </div>

            <div className="cc-card p-3 space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Campaigns</p>
                <button type="button" aria-label="Add campaign" title="Add campaign" onClick={handleCreateCampaign} className="text-t3 hover:text-indigo"><Plus className="w-3.5 h-3.5" /></button>
              </div>
              {campaigns.length === 0 && <p className="px-1 text-[11px] text-t3">No campaigns yet.</p>}
              {campaigns.map(campaign => (
                <button
                  key={campaign.id}
                  type="button"
                  onClick={() => setActiveCampaignId(campaign.id)}
                  className={`w-full rounded-xl px-2.5 py-2 text-left transition-colors ${campaign.id === activeCampaignId ? 'bg-[var(--blue-soft)] border border-[var(--b1)]' : 'hover:bg-[var(--s3)]'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-t1 truncate">{campaign.name}</p>
                    <span className={`badge ${campaign.status === 'ACTIVE' ? 'badge-emerald' : campaign.status === 'PAUSED' ? 'badge-amber' : 'badge-blue'}`}>{campaign.status}</span>
                  </div>
                  <p className="text-[10px] text-t3 truncate mt-0.5">{campaign.campaignType} · {campaign.intakeFields?.length ?? 0} fields</p>
                </button>
              ))}
            </div>
          </div>

          {/* Main editing surface */}
          <div className="space-y-4">
            <div className="flex items-center gap-1 overflow-x-auto rounded-xl bg-[var(--s3)] p-1">
              {TABS.map(t => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${tab === t.id ? 'bg-[var(--s2)] text-t1 shadow-sm' : 'text-t3 hover:text-t2'}`}
                  >
                    <Icon className="w-3.5 h-3.5" /> {t.label}
                  </button>
                );
              })}
            </div>

            {tab === 'clinic' && activeClinic && (
              <ClinicPanel key={activeClinic.id} clinic={activeClinic} onChanged={loadClinics} />
            )}
            {tab === 'campaign' && activeClinic && (
              activeCampaign ? (
                <CampaignPanel key={activeCampaign.id} clinic={activeClinic} campaign={activeCampaign} onChanged={() => loadCampaigns(activeClinicId)} />
              ) : <EmptyState text="No campaign selected. Create one to configure the agent and offer." onAction={handleCreateCampaign} actionLabel="New Campaign" />
            )}
            {tab === 'intake' && (
              activeCampaign ? <IntakeBuilder key={activeCampaign.id} campaign={activeCampaign} clinic={activeClinic!} onChanged={() => loadCampaigns(activeClinicId)} />
                : <EmptyState text="Select or create a campaign to build its intake flow." />
            )}
            {tab === 'preview' && (
              activeCampaign ? <PreviewPanel key={activeCampaign.id} campaignId={activeCampaign.id} /> : <EmptyState text="Select a campaign to preview the generated agent." />
            )}
            {tab === 'retell' && (
              activeCampaign ? <RetellPanel key={activeCampaign.id} campaignId={activeCampaign.id} /> : <EmptyState text="Select a campaign to export its RetellAI configuration." />
            )}
            {tab === 'activity' && activeClinic && (
              <ActivityPanel clinicId={activeClinic.id} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ text, onAction, actionLabel }: { text: string; onAction?: () => void; actionLabel?: string }) {
  return (
    <div className="cc-card p-10 text-center">
      <p className="text-sm text-t3 mb-3">{text}</p>
      {onAction && actionLabel && (
        <button type="button" onClick={onAction} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
          <Plus className="w-4 h-4" /> {actionLabel}
        </button>
      )}
    </div>
  );
}

function SaveBar({ dirty, busy, onSave, savedAt }: { dirty: boolean; busy: boolean; onSave: () => void; savedAt: number | null }) {
  return (
    <div className="flex items-center justify-end gap-3">
      {savedAt && !dirty && <span className="text-[11px] font-semibold text-emerald-v inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Saved</span>}
      <button
        type="button"
        disabled={!dirty || busy}
        onClick={onSave}
        className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save changes
      </button>
    </div>
  );
}

// ===== Clinic Panel ========================================================

function ClinicPanel({ clinic, onChanged }: { clinic: Clinic; onChanged: () => Promise<unknown> }) {
  const [draft, setDraft] = useState<Clinic>(clinic);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(clinic);
  const set = <K extends keyof Clinic>(key: K, value: Clinic[K]) => setDraft(prev => ({ ...prev, [key]: value }));

  async function save() {
    setBusy(true);
    try {
      await api.updateClinic(clinic.id, {
        name: draft.name, phone: draft.phone, logoUrl: draft.logoUrl, website: draft.website,
        addressLine: draft.addressLine, timezone: draft.timezone, defaultLanguage: draft.defaultLanguage,
        complianceDisclosure: draft.complianceDisclosure, humanFallbackNumber: draft.humanFallbackNumber,
        doNotContactPolicy: draft.doNotContactPolicy, active: draft.active,
      });
      await onChanged();
      setSavedAt(Date.now());
    } finally { setBusy(false); }
  }

  async function deleteClinic() {
    if (!window.confirm(`Delete clinic "${clinic.name}" and all its campaigns? This cannot be undone.`)) return;
    await api.deleteClinic(clinic.id);
    await onChanged();
  }

  return (
    <div className="space-y-4">
      <div className="cc-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1">Clinic Profile</h3>
          <button type="button" onClick={deleteClinic} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)]">
            <Trash2 className="w-3 h-3" /> Delete
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Clinic name" required><TextInput value={draft.name} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="Phone number" required><TextInput value={draft.phone} onChange={e => set('phone', e.target.value)} /></Field>
          <Field label="Website"><TextInput value={draft.website ?? ''} onChange={e => set('website', e.target.value)} placeholder="https://" /></Field>
          <Field label="Logo URL"><TextInput value={draft.logoUrl ?? ''} onChange={e => set('logoUrl', e.target.value)} placeholder="https://…/logo.png" /></Field>
          <Field label="Address"><TextInput value={draft.addressLine ?? ''} onChange={e => set('addressLine', e.target.value)} /></Field>
          <Field label="Human fallback number" hint="Used when a caller asks for a person or escalation is needed.">
            <TextInput value={draft.humanFallbackNumber ?? ''} onChange={e => set('humanFallbackNumber', e.target.value)} />
          </Field>
          <Field label="Timezone">
            <Select value={draft.timezone} onChange={e => set('timezone', e.target.value)}>
              {TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </Select>
          </Field>
          <Field label="Default language">
            <Select value={draft.defaultLanguage} onChange={e => set('defaultLanguage', e.target.value)}>
              {LANGUAGE_OPTIONS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Compliance disclosure" hint="Spoken at the very start of every call — must identify the agent as AI." required>
          <TextArea rows={2} value={draft.complianceDisclosure} onChange={e => set('complianceDisclosure', e.target.value)} />
        </Field>
        <Field label="Do-not-contact policy" hint="How the agent handles a request to stop being contacted.">
          <TextArea rows={2} value={draft.doNotContactPolicy} onChange={e => set('doNotContactPolicy', e.target.value)} />
        </Field>
        <SaveBar dirty={dirty} busy={busy} onSave={save} savedAt={savedAt} />
      </div>

      <LocationsEditor clinic={clinic} onChanged={onChanged} />
    </div>
  );
}

function LocationsEditor({ clinic, onChanged }: { clinic: Clinic; onChanged: () => Promise<unknown> }) {
  const locations = clinic.locations ?? [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim() || !address.trim()) return;
    setBusy(true);
    try {
      await api.createLocation({ clinicId: clinic.id, name: name.trim(), address: address.trim(), phone: phone.trim() || null });
      setName(''); setAddress(''); setPhone(''); setAdding(false);
      await onChanged();
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!window.confirm('Remove this location?')) return;
    await api.deleteLocation(id);
    await onChanged();
  }

  return (
    <div className="cc-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><MapPin className="w-4 h-4 text-indigo" /> Locations</h3>
        <button type="button" onClick={() => setAdding(a => !a)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)]">
          <Plus className="w-3 h-3" /> Add location
        </button>
      </div>
      {locations.length === 0 && !adding && <p className="text-xs text-t3">No locations yet. Add at least one so the agent can offer it.</p>}
      <div className="space-y-2">
        {locations.map(loc => (
          <div key={loc.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-t1 truncate">{loc.name}</p>
              <p className="text-[11px] text-t3 truncate">{loc.address}{loc.phone ? ` · ${loc.phone}` : ''}</p>
            </div>
            <button type="button" aria-label="Remove location" title="Remove location" onClick={() => remove(loc.id)} className="text-t3 hover:text-red-v shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
      {adding && (
        <div className="grid gap-2 md:grid-cols-3 rounded-xl border border-dashed border-[var(--b2)] p-3">
          <TextInput placeholder="Location name" value={name} onChange={e => setName(e.target.value)} />
          <TextInput placeholder="Address" value={address} onChange={e => setAddress(e.target.value)} />
          <div className="flex gap-2">
            <TextInput placeholder="Phone (optional)" value={phone} onChange={e => setPhone(e.target.value)} />
            <button type="button" disabled={busy} onClick={add} className="rounded-xl bg-indigo px-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Campaign Panel (agent + campaign) ===================================

function CampaignPanel({ clinic, campaign, onChanged }: { clinic: Clinic; campaign: Campaign; onChanged: () => Promise<unknown> }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draft, setDraft] = useState<Campaign>(campaign);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
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
      let agentId = draft.agentId;
      if (!agentId) {
        const created = await api.createAgent({ clinicId: clinic.id, name: 'Riley' });
        agentId = created.id;
        setAgents(prev => [...prev, created]);
      }
      await api.updateCampaign(campaign.id, {
        name: draft.name, campaignType: draft.campaignType, status: draft.status, agentId,
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

  async function deleteCampaign() {
    if (!window.confirm(`Delete campaign "${campaign.name}"?`)) return;
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
        {activeAgent ? (
          <AgentEditor key={activeAgent.id} agent={activeAgent} onSave={saveAgent} />
        ) : (
          <p className="text-xs text-t3">No agent linked yet — one named “Riley” will be created automatically when you save this campaign.</p>
        )}
      </div>

      {/* Campaign */}
      <div className="cc-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Megaphone className="w-4 h-4 text-indigo" /> Campaign</h3>
          <button type="button" onClick={deleteCampaign} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)]">
            <Trash2 className="w-3 h-3" /> Delete
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Campaign name" required><TextInput value={draft.name} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="Campaign type">
            <Select value={draft.campaignType} onChange={e => set('campaignType', e.target.value)}>
              {CAMPAIGN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
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

function AgentEditor({ agent, onSave }: { agent: Agent; onSave: (patch: Partial<Agent>) => Promise<void> }) {
  const [draft, setDraft] = useState<Agent>(agent);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(agent);
  const set = <K extends keyof Agent>(key: K, value: Agent[K]) => setDraft(prev => ({ ...prev, [key]: value }));

  async function save() {
    setBusy(true);
    try {
      await onSave({ name: draft.name, voice: draft.voice, tone: draft.tone, language: draft.language, persona: draft.persona, greetingOverride: draft.greetingOverride });
      setSavedAt(Date.now());
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Agent name" required><TextInput value={draft.name} onChange={e => set('name', e.target.value)} /></Field>
        <Field label="Voice">
          <Select value={draft.voice} onChange={e => set('voice', e.target.value)}>
            {VOICE_OPTIONS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
          </Select>
        </Field>
        <Field label="Tone">
          <Select value={draft.tone} onChange={e => set('tone', e.target.value)}>
            {[...new Set([draft.tone, ...TONE_OPTIONS])].map(t => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="Language">
          <Select value={draft.language} onChange={e => set('language', e.target.value)}>
            {LANGUAGE_OPTIONS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Persona" hint="Extra personality guidance for the agent."><TextArea rows={2} value={draft.persona ?? ''} onChange={e => set('persona', e.target.value)} /></Field>
      <Field label="Greeting override" hint="Optional first line. Falls back to the clinic disclosure if empty."><TextInput value={draft.greetingOverride ?? ''} onChange={e => set('greetingOverride', e.target.value)} /></Field>
      <SaveBar dirty={dirty} busy={busy} onSave={save} savedAt={savedAt} />
    </div>
  );
}

// ===== Intake Builder ======================================================

function IntakeBuilder({ campaign, clinic, onChanged }: { campaign: Campaign; clinic: Clinic; onChanged: () => Promise<unknown> }) {
  const [fields, setFields] = useState<IntakeField[]>(campaign.intakeFields ?? []);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const rows = await api.listIntakeFields(campaign.id);
    setFields(rows);
    await onChanged();
  }, [campaign.id, onChanged]);

  useEffect(() => { void api.listIntakeFields(campaign.id).then(setFields); }, [campaign.id]);

  const usedTypes = new Set(fields.map(f => f.fieldType));

  async function addField(type: FieldType) {
    const meta = FIELD_CATALOG.find(f => f.type === type)!;
    setBusy(true);
    try {
      const options = type === 'PREFERRED_LOCATION' ? (clinic.locations ?? []).map(l => l.name) : [];
      await api.createIntakeField({ campaignId: campaign.id, fieldType: type, label: meta.label, aiQuestion: meta.question, options, sortOrder: fields.length });
      await refresh();
    } finally { setBusy(false); }
  }

  async function move(index: number, dir: -1 | 1) {
    const next = [...fields];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setFields(next);
    await api.reorderIntakeFields(campaign.id, next.map(f => f.id));
    await onChanged();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
      <div className="cc-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><ListChecks className="w-4 h-4 text-indigo" /> Intake fields ({fields.length})</h3>
          <span className="text-[10px] text-t3">Collected in this order during the call</span>
        </div>
        {fields.length === 0 && <p className="text-xs text-t3 py-6 text-center">No fields yet. Add from the catalog →</p>}
        <div className="space-y-2">
          {fields.map((field, index) => (
            <IntakeFieldRow
              key={field.id}
              field={field}
              isFirst={index === 0}
              isLast={index === fields.length - 1}
              onMoveUp={() => move(index, -1)}
              onMoveDown={() => move(index, 1)}
              onChanged={refresh}
            />
          ))}
        </div>
      </div>

      <div className="cc-card p-4 space-y-3 lg:sticky lg:top-4 self-start">
        <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Field catalog</p>
        {['Identity', 'Contact', 'Scheduling', 'Clinical', 'Compliance', 'Custom'].map(group => (
          <div key={group} className="space-y-1.5">
            <p className="text-[10px] font-semibold text-t3">{group}</p>
            {FIELD_CATALOG.filter(f => f.group === group).map(f => {
              const isCustom = f.group === 'Custom';
              const disabled = busy || (!isCustom && usedTypes.has(f.type));
              return (
                <button key={f.type} type="button" disabled={disabled} onClick={() => addField(f.type)}
                  className="w-full flex items-center justify-between gap-2 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-left text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] hover:text-indigo disabled:opacity-30 disabled:hover:bg-transparent">
                  {f.label}
                  <Plus className="w-3 h-3 shrink-0" />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function IntakeFieldRow({ field, isFirst, isLast, onMoveUp, onMoveDown, onChanged }: {
  field: IntakeField; isFirst: boolean; isLast: boolean; onMoveUp: () => void; onMoveDown: () => void; onChanged: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<IntakeField>(field);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(field);
  const set = <K extends keyof IntakeField>(key: K, value: IntakeField[K]) => setDraft(prev => ({ ...prev, [key]: value }));
  const hasOptions = field.fieldType === 'CUSTOM_DROPDOWN' || field.fieldType === 'PREFERRED_LOCATION';

  async function save() {
    setBusy(true);
    try {
      await api.updateIntakeField(field.id, {
        label: draft.label, aiQuestion: draft.aiQuestion, validationRule: draft.validationRule,
        required: draft.required, confirmationRequired: draft.confirmationRequired, options: draft.options,
      });
      await onChanged();
      setExpanded(false);
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm(`Remove field "${field.label}"?`)) return;
    await api.deleteIntakeField(field.id);
    await onChanged();
  }

  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)]">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="flex flex-col">
          <button type="button" aria-label="Move field up" title="Move up" disabled={isFirst} onClick={onMoveUp} className="text-t3 hover:text-indigo disabled:opacity-20"><ChevronUp className="w-3.5 h-3.5" /></button>
          <button type="button" aria-label="Move field down" title="Move down" disabled={isLast} onClick={onMoveDown} className="text-t3 hover:text-indigo disabled:opacity-20"><ChevronDown className="w-3.5 h-3.5" /></button>
        </div>
        <GripVertical className="w-3.5 h-3.5 text-t3 shrink-0" />
        <button type="button" onClick={() => setExpanded(e => !e)} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-t1 truncate">{field.label}</p>
            {field.required ? <span className="badge badge-red">Required</span> : <span className="badge badge-blue">Optional</span>}
            {field.confirmationRequired && <span className="badge badge-violet">Confirm</span>}
          </div>
          <p className="text-[11px] text-t3 truncate mt-0.5">“{field.aiQuestion}”</p>
        </button>
        <button type="button" aria-label="Remove field" title="Remove field" onClick={remove} className="text-t3 hover:text-red-v shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
      {expanded && (
        <div className="border-t border-[var(--b1)] p-3 space-y-3">
          <Field label="Display label"><TextInput value={draft.label} onChange={e => set('label', e.target.value)} /></Field>
          <Field label="AI question wording"><TextArea rows={2} value={draft.aiQuestion} onChange={e => set('aiQuestion', e.target.value)} /></Field>
          <Field label="Validation rule" hint="Plain-language hint the agent uses to validate the answer.">
            <TextInput value={draft.validationRule ?? ''} onChange={e => set('validationRule', e.target.value)} />
          </Field>
          {hasOptions && (
            <Field label="Options" hint="Comma separated choices.">
              <TextInput value={draft.options.join(', ')} onChange={e => set('options', e.target.value.split(',').map(o => o.trim()).filter(Boolean))} />
            </Field>
          )}
          <div className="flex flex-wrap gap-3">
            <Toggle checked={draft.required} onChange={v => set('required', v)} label="Required" />
            <Toggle checked={draft.confirmationRequired} onChange={v => set('confirmationRequired', v)} label="Read back to confirm" />
          </div>
          <div className="flex justify-end">
            <button type="button" disabled={!dirty || busy} onClick={save} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save field
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== Preview Panel =======================================================

function PreviewPanel({ campaignId }: { campaignId: string }) {
  const [result, setResult] = useState<PromptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.getPrompt(campaignId).then(r => { if (active) setResult(r); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Failed'); });
    return () => { active = false; };
  }, [campaignId]);

  if (error) return <div className="cc-card p-6 text-sm text-red-v">{error}</div>;
  if (!result) return <div className="cc-card p-10 text-center text-sm text-t3"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Generating preview…</div>;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <SampleCard icon={<Sparkles className="w-4 h-4 text-violet-v" />} title="Sample greeting" text={result.samples.greeting} />
        <SampleCard icon={<Megaphone className="w-4 h-4 text-indigo" />} title="Sample pitch" text={result.samples.pitch} />
      </div>
      <div className="cc-card p-5 space-y-2">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><ListChecks className="w-4 h-4 text-indigo" /> Sample intake questions</h3>
        {result.samples.intakeQuestions.length === 0 ? <p className="text-xs text-t3">No intake fields configured.</p> : (
          <ol className="space-y-1.5">
            {result.samples.intakeQuestions.map((q, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-t2">
                <span className="w-5 h-5 rounded-full bg-[var(--indigo-soft)] text-indigo text-[10px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                {q}
              </li>
            ))}
          </ol>
        )}
      </div>
      <SampleCard icon={<Check className="w-4 h-4 text-emerald-v" />} title="Sample confirmation" text={result.samples.confirmation} />
      <div className="cc-card p-5 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Bot className="w-4 h-4 text-violet-v" /> Generated system prompt</h3>
          <CopyButton value={result.systemPrompt} label="Copy prompt" />
        </div>
        <pre className="max-h-[480px] overflow-auto rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-4 text-[12px] leading-relaxed text-t2 whitespace-pre-wrap font-mono">{result.systemPrompt}</pre>
      </div>
    </div>
  );
}

function SampleCard({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="cc-card p-5 space-y-2">
      <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2">{icon} {title}</h3>
      <p className="text-sm text-t2 leading-relaxed">{text}</p>
    </div>
  );
}

// ===== RetellAI Panel ======================================================

function RetellPanel({ campaignId }: { campaignId: string }) {
  const [config, setConfig] = useState<RetellConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.getRetellConfig(campaignId).then(r => { if (active) setConfig(r); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Failed'); });
    return () => { active = false; };
  }, [campaignId]);

  const fullJson = useMemo(() => (config ? JSON.stringify(config, null, 2) : ''), [config]);

  if (error) return <div className="cc-card p-6 text-sm text-red-v">{error}</div>;
  if (!config) return <div className="cc-card p-10 text-center text-sm text-t3"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Building RetellAI config…</div>;

  return (
    <div className="space-y-4">
      <div className="cc-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Code2 className="w-4 h-4 text-indigo" /> Test-call configuration</h3>
          <CopyButton value={fullJson} label="Copy full JSON" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <KV label="Voice ID" value={config.voiceId} />
          <KV label="Language" value={config.language} />
          <KV label="Begin message" value={config.beginMessage} mono={false} />
        </div>
        <Field label="Webhook URL">
          <div className="flex gap-2">
            <TextInput readOnly value={config.webhookUrl} className="font-mono text-xs" />
            <CopyButton value={config.webhookUrl} />
          </div>
        </Field>
      </div>

      <div className="cc-card p-5 space-y-2">
        <h3 className="text-sm font-bold text-t1">Dynamic variables</h3>
        <div className="grid gap-2 md:grid-cols-2">
          {Object.entries(config.dynamicVariables).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-1.5">
              <code className="text-[11px] font-semibold text-violet-v">{`{{${k}}}`}</code>
              <span className="text-[11px] text-t2 truncate">{v || '—'}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="cc-card p-5 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-t1">Booking function schema</h3>
            <CopyButton value={JSON.stringify(config.bookingFunction, null, 2)} />
          </div>
          <pre className="max-h-80 overflow-auto rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-3 text-[11px] leading-relaxed text-t2 font-mono">{JSON.stringify(config.bookingFunction, null, 2)}</pre>
        </div>
        <div className="cc-card p-5 space-y-2">
          <h3 className="text-sm font-bold text-t1">Call-outcome extraction fields</h3>
          <div className="space-y-1.5">
            {config.callOutcomeFields.map((f, i) => (
              <div key={i} className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
                <div className="flex items-center gap-2">
                  <code className="text-[11px] font-bold text-indigo">{String(f.name)}</code>
                  <span className="badge badge-blue">{String(f.type)}</span>
                </div>
                <p className="text-[11px] text-t3 mt-0.5">{String(f.description)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function KV({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-t3">{label}</p>
      <p className={`text-xs text-t1 mt-0.5 break-words ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

// ===== Activity Panel ======================================================

function ActivityPanel({ clinicId }: { clinicId: string }) {
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [requests, setRequests] = useState<AppointmentRequest[]>([]);
  const [optOuts, setOptOuts] = useState<OptOut[]>([]);
  const [sub, setSub] = useState<'calls' | 'requests' | 'optouts'>('calls');

  const load = useCallback(async () => {
    const [c, r, o] = await Promise.all([api.listCallLogs(clinicId), api.listAppointmentRequests(clinicId), api.listOptOuts()]);
    setCalls(c); setRequests(r); setOptOuts(o);
  }, [clinicId]);

  useEffect(() => {
    let active = true;
    (async () => {
      const [c, r, o] = await Promise.all([api.listCallLogs(clinicId), api.listAppointmentRequests(clinicId), api.listOptOuts()]);
      if (!active) return;
      setCalls(c); setRequests(r); setOptOuts(o);
    })();
    return () => { active = false; };
  }, [clinicId]);

  async function removeOptOut(id: string) {
    await api.deleteOptOut(id);
    await load();
  }

  return (
    <div className="cc-card p-5 space-y-4">
      <div className="flex items-center gap-1 rounded-xl bg-[var(--s3)] p-1 w-fit">
        {([['calls', `Call logs (${calls.length})`], ['requests', `Appointments (${requests.length})`], ['optouts', `Do-not-contact (${optOuts.length})`]] as const).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setSub(id)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${sub === id ? 'bg-[var(--s2)] text-t1 shadow-sm' : 'text-t3 hover:text-t2'}`}>{label}</button>
        ))}
      </div>

      {sub === 'calls' && (
        <div className="space-y-2">
          {calls.length === 0 && <p className="text-xs text-t3 py-4 text-center">No calls logged yet. Calls appear here via the RetellAI webhook.</p>}
          {calls.map(call => (
            <div key={call.id} className="flex items-start justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-t1 truncate">{call.callerName ?? call.callerPhone ?? 'Unknown caller'}</p>
                  <span className={outcomeBadge[call.outcome] ?? 'badge badge-blue'}>{call.outcome.replace(/_/g, ' ')}</span>
                </div>
                <p className="text-[11px] text-t3 truncate mt-0.5">{call.transcriptSummary ?? '—'}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[11px] font-semibold text-t2">{Math.floor(call.durationSeconds / 60)}m {call.durationSeconds % 60}s</p>
                <p className="text-[10px] text-t3">{call.startedAt ? new Date(call.startedAt).toLocaleString() : ''}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {sub === 'requests' && (
        <div className="space-y-2">
          {requests.length === 0 && <p className="text-xs text-t3 py-4 text-center">No appointment requests yet.</p>}
          {requests.map(req => (
            <div key={req.id} className="flex items-start justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-t1 truncate">{req.contactName ?? req.contactPhone ?? 'Unknown'}</p>
                  <span className={`badge ${req.status === 'CONFIRMED' ? 'badge-emerald' : req.status === 'CANCELED' ? 'badge-red' : 'badge-blue'}`}>{req.status}</span>
                </div>
                <p className="text-[11px] text-t3 truncate mt-0.5">{req.bookedSlot || `${req.requestedDate ?? ''} ${req.requestedTime ?? ''}`.trim() || req.appointmentType || '—'}</p>
              </div>
              <p className="text-[10px] text-t3 shrink-0">{new Date(req.createdAt).toLocaleDateString()}</p>
            </div>
          ))}
        </div>
      )}

      {sub === 'optouts' && (
        <div className="space-y-2">
          {optOuts.length === 0 && <p className="text-xs text-t3 py-4 text-center">No do-not-contact records.</p>}
          {optOuts.map(o => (
            <div key={o.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
              <div className="min-w-0 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-violet-v shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-t1 truncate">{o.contactPhone ?? o.contactEmail}</p>
                  <p className="text-[11px] text-t3 truncate">{o.channel} · {o.reason ?? 'No reason given'}</p>
                </div>
              </div>
              <button type="button" aria-label="Remove do-not-contact entry" title="Remove" onClick={() => removeOptOut(o.id)} className="text-t3 hover:text-red-v shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
