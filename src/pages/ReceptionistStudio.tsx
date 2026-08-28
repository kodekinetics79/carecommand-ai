import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot, Building2, Plus, Trash2, Save, Sparkles, Phone,
  GripVertical, ChevronUp, ChevronDown, Copy, Check, ShieldCheck, PhoneOff,
  Megaphone, ListChecks, Eye, Code2, Activity, MapPin, Loader2, AlertCircle,
  PhoneCall, PhoneOutgoing, CalendarClock, CircleCheck, CircleAlert,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import { Field, TextInput, TextArea, Select, Toggle } from '../components/ui/Field';
import {
  receptionistApi as api,
  FIELD_CATALOG, VOICE_OPTIONS, TONE_OPTIONS, LANGUAGE_OPTIONS, CAMPAIGN_TYPES, TIMEZONE_OPTIONS,
  OUTBOUND_REQUIRED_FIELDS,
  type Clinic, type Campaign, type IntakeField, type Agent, type FieldType,
  type PromptResult, type RetellConfig, type CallLog, type AppointmentRequest, type OptOut, type Overview,
  type RetellStatus, type OutboundCampaign, type OutboundRequiredField, type OutboundBookingMode,
  type CallTarget, type BookingRequest, type BookingRequestStatus, type OutboundCampaignInput,
} from '../lib/receptionist';

type Tab = 'clinic' | 'campaign' | 'intake' | 'preview' | 'retell' | 'outbound' | 'activity';

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'clinic', label: 'Clinic Profile', icon: Building2 },
  { id: 'campaign', label: 'Agent & Campaign', icon: Megaphone },
  { id: 'intake', label: 'Intake Builder', icon: ListChecks },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'retell', label: 'RetellAI Export', icon: Code2 },
  { id: 'outbound', label: 'Outbound Calls', icon: PhoneOutgoing },
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
            {tab === 'outbound' && (
              activeClinic ? <OutboundPanel key={activeClinic.id} clinic={activeClinic} />
                : <EmptyState text="Create a clinic profile first to configure outbound calling." />
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

// ===========================================================================
// Outbound calling panel: Retell setup status, campaign builder, target list,
// test-call launcher, call logs, and the appointment-request review queue.
// ===========================================================================

const requestBadge: Record<BookingRequestStatus, string> = {
  PENDING_REVIEW: 'badge badge-amber', BOOKED: 'badge badge-emerald', REJECTED: 'badge badge-red',
  MISSING_INFO: 'badge badge-violet', DUPLICATE: 'badge badge-blue',
};

const EMPTY_CAMPAIGN: OutboundCampaignInput = {
  clinicId: '', name: '', script: '', requiredFields: ['firstName', 'lastName', 'phone'],
  consentText: '', humanHandoffInstruction: '', bookingMode: 'APPOINTMENT_REQUEST_ONLY',
  defaultBranchId: '', defaultService: '', quietHoursStart: '', quietHoursEnd: '', maxRetryAttempts: 1,
};

function OutboundPanel({ clinic }: { clinic: Clinic }) {
  const [status, setStatus] = useState<RetellStatus | null>(null);
  const [campaigns, setCampaigns] = useState<OutboundCampaign[]>([]);
  const [requests, setRequests] = useState<BookingRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [st, camps, reqs] = await Promise.all([
      api.retellStatus().catch(() => null),
      api.listOutboundCampaigns(clinic.id).catch(() => [] as OutboundCampaign[]),
      api.listBookingRequests().catch(() => [] as BookingRequest[]),
    ]);
    setStatus(st);
    setCampaigns(camps);
    setRequests(reqs);
    setSelectedId(prev => (prev && camps.some(c => c.id === prev) ? prev : camps[0]?.id ?? ''));
    setLoading(false);
  }, [clinic.id]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [st, camps, reqs] = await Promise.all([
        api.retellStatus().catch(() => null),
        api.listOutboundCampaigns(clinic.id).catch(() => [] as OutboundCampaign[]),
        api.listBookingRequests().catch(() => [] as BookingRequest[]),
      ]);
      if (!active) return;
      setStatus(st);
      setCampaigns(camps);
      setRequests(reqs);
      setSelectedId(prev => (prev && camps.some(c => c.id === prev) ? prev : camps[0]?.id ?? ''));
      setLoading(false);
    })();
    return () => { active = false; };
  }, [clinic.id]);

  const selected = campaigns.find(c => c.id === selectedId) ?? null;

  if (loading) return <div className="cc-card p-10 text-center text-sm text-t3"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;

  return (
    <div className="space-y-5">
      <RetellStatusCard status={status} />

      <div className="grid lg:grid-cols-[260px_1fr] gap-5">
        {/* Campaign list */}
        <div className="cc-card p-3 space-y-1.5 h-max">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[11px] font-bold uppercase tracking-wide text-t3">Campaigns</span>
            <button type="button" aria-label="New outbound campaign" title="New outbound campaign" onClick={() => { setCreating(true); setSelectedId(''); }} className="text-indigo hover:opacity-80"><Plus className="w-4 h-4" /></button>
          </div>
          {campaigns.length === 0 && !creating && <p className="px-1 py-3 text-xs text-t3">No outbound campaigns yet.</p>}
          {campaigns.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => { setSelectedId(c.id); setCreating(false); }}
              className={`w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${selectedId === c.id && !creating ? 'bg-[var(--s2)] text-t1' : 'text-t2 hover:bg-[var(--s2)]'}`}
            >
              <span className="block font-semibold truncate">{c.name}</span>
              <span className="text-[10px] text-t3">{c.status} · {c._count?.targets ?? 0} targets · {c._count?.callLogs ?? 0} calls</span>
            </button>
          ))}
        </div>

        {/* Builder / detail */}
        <div className="space-y-5">
          {creating && (
            <CampaignBuilder
              clinicId={clinic.id}
              onCancel={() => setCreating(false)}
              onSaved={async (id) => { setCreating(false); await reload(); setSelectedId(id); }}
            />
          )}
          {!creating && selected && (
            <CampaignDetail key={selected.id} campaign={selected} status={status} onChanged={reload} />
          )}
          {!creating && !selected && (
            <div className="cc-card p-10 text-center text-sm text-t3">Select a campaign or create one to configure outbound calls.</div>
          )}
        </div>
      </div>

      <BookingRequestQueue requests={requests} onChanged={reload} />
    </div>
  );
}

function RetellStatusCard({ status }: { status: RetellStatus | null }) {
  if (!status) return null;
  const ok = status.configured;
  return (
    <div className={`cc-card p-4 border-l-4 ${ok ? 'border-l-emerald-v' : 'border-l-amber-v'}`}>
      <div className="flex items-start gap-3">
        {ok ? <CircleCheck className="w-5 h-5 text-emerald-v shrink-0" /> : <CircleAlert className="w-5 h-5 text-amber-v shrink-0" />}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-t1">Retell outbound calling {ok ? 'is ready' : 'needs setup'}</h3>
            {status.mock && <span className="badge badge-violet">mock mode</span>}
          </div>
          <p className="text-xs text-t3 mt-0.5">
            {ok
              ? 'Credentials are configured server-side. Launching a call will place a real outbound call via Retell.'
              : 'Set the missing environment variables on the server to enable live outbound calls. Secrets are never sent to the browser.'}
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            {status.checklist.map(item => (
              <span key={item.key} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${item.set ? 'border-[var(--b1)] text-t2' : 'border-amber-v/40 text-amber-v'}`}>
                {item.set ? <Check className="w-3 h-3 text-emerald-v" /> : <AlertCircle className="w-3 h-3" />}
                {item.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function RequiredFieldPicker({ value, onChange }: { value: OutboundRequiredField[]; onChange: (next: OutboundRequiredField[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {OUTBOUND_REQUIRED_FIELDS.map(f => {
        const on = value.includes(f.key);
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange(on ? value.filter(k => k !== f.key) : [...value, f.key])}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${on ? 'border-indigo bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] bg-[var(--s3)] text-t3'}`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function CampaignFormFields({ form, set }: { form: OutboundCampaignInput; set: (patch: Partial<OutboundCampaignInput>) => void }) {
  return (
    <>
      <Field label="Campaign name" required>
        <TextInput value={form.name} onChange={e => set({ name: e.target.value })} placeholder="June reactivation outreach" />
      </Field>
      <Field label="Call script" required hint="What the agent should say. Keep it scheduling-focused — the AI must not give medical advice.">
        <TextArea rows={4} value={form.script} onChange={e => set({ script: e.target.value })} placeholder="Hi, this is {{agent_name}} calling from {{clinic_name}}..." />
      </Field>
      <Field label="Required fields to collect" hint="The agent will route to staff review if any of these are missing.">
        <RequiredFieldPicker value={form.requiredFields ?? []} onChange={v => set({ requiredFields: v })} />
      </Field>
      <Field label="Consent / disclaimer text" hint="Spoken disclosure the agent reads at the start of the call.">
        <TextArea rows={2} value={form.consentText ?? ''} onChange={e => set({ consentText: e.target.value })} placeholder="This call may be recorded. You can opt out at any time." />
      </Field>
      <Field label="Human handoff instruction" hint="When the agent should transfer to a human.">
        <TextInput value={form.humanHandoffInstruction ?? ''} onChange={e => set({ humanHandoffInstruction: e.target.value })} placeholder="Transfer if the caller asks clinical questions." />
      </Field>
      <Field label="Booking mode" required hint="Direct booking only books when a branch, a valid time, and a free slot are all available; otherwise it routes to staff review.">
        <Select aria-label="Booking mode" value={form.bookingMode} onChange={e => set({ bookingMode: e.target.value as OutboundBookingMode })}>
          <option value="APPOINTMENT_REQUEST_ONLY">Appointment request only (staff books)</option>
          <option value="DIRECT_BOOKING_IF_SLOT_AVAILABLE">Direct booking if a slot is available</option>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default branch ID" hint="Required for direct booking.">
          <TextInput value={form.defaultBranchId ?? ''} onChange={e => set({ defaultBranchId: e.target.value })} placeholder="branch uuid (optional)" />
        </Field>
        <Field label="Default service">
          <TextInput value={form.defaultService ?? ''} onChange={e => set({ defaultService: e.target.value })} placeholder="Consultation" />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Quiet hours start"><TextInput value={form.quietHoursStart ?? ''} onChange={e => set({ quietHoursStart: e.target.value })} placeholder="21:00" /></Field>
        <Field label="Quiet hours end"><TextInput value={form.quietHoursEnd ?? ''} onChange={e => set({ quietHoursEnd: e.target.value })} placeholder="08:00" /></Field>
        <Field label="Max retries"><TextInput type="number" min={0} max={10} value={form.maxRetryAttempts ?? 1} onChange={e => set({ maxRetryAttempts: Number(e.target.value) })} /></Field>
      </div>
    </>
  );
}

function CampaignBuilder({ clinicId, onSaved, onCancel }: { clinicId: string; onSaved: (id: string) => void; onCancel: () => void }) {
  const [form, setForm] = useState<OutboundCampaignInput>({ ...EMPTY_CAMPAIGN, clinicId });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<OutboundCampaignInput>) => setForm(prev => ({ ...prev, ...patch }));

  async function save() {
    setSaving(true); setErr(null);
    try {
      const payload: OutboundCampaignInput = {
        ...form,
        clinicId,
        defaultBranchId: form.defaultBranchId || null,
        defaultService: form.defaultService || null,
        consentText: form.consentText || null,
        humanHandoffInstruction: form.humanHandoffInstruction || null,
        quietHoursStart: form.quietHoursStart || null,
        quietHoursEnd: form.quietHoursEnd || null,
      };
      const row = await api.createOutboundCampaign(payload);
      onSaved(row.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save campaign');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cc-card p-5 space-y-4">
      <h3 className="text-sm font-bold text-t1 flex items-center gap-2"><Megaphone className="w-4 h-4 text-indigo" /> New outbound campaign</h3>
      <CampaignFormFields form={form} set={set} />
      {err && <p className="text-xs text-red-v">{err}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={saving || !form.name || !form.script} onClick={save} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Create campaign
        </button>
        <button type="button" onClick={onCancel} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)]">Cancel</button>
      </div>
    </div>
  );
}

function CampaignDetail({ campaign, status, onChanged }: { campaign: OutboundCampaign; status: RetellStatus | null; onChanged: () => void }) {
  const [targets, setTargets] = useState<CallTarget[]>([]);
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [phone, setPhone] = useState('');
  const [firstName, setFirstName] = useState('');
  const [launchMsg, setLaunchMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [launching, setLaunching] = useState(false);

  const reloadDetail = useCallback(async () => {
    const [t, l] = await Promise.all([
      api.listTargets(campaign.id).catch(() => [] as CallTarget[]),
      api.listOutboundCallLogs(campaign.id).catch(() => [] as CallLog[]),
    ]);
    setTargets(t); setLogs(l);
  }, [campaign.id]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [t, l] = await Promise.all([
        api.listTargets(campaign.id).catch(() => [] as CallTarget[]),
        api.listOutboundCallLogs(campaign.id).catch(() => [] as CallLog[]),
      ]);
      if (!active) return;
      setTargets(t);
      setLogs(l);
    })();
    return () => { active = false; };
  }, [campaign.id]);

  async function launch(targetId?: string, toPhone?: string) {
    const dial = toPhone ?? phone;
    if (!dial) return;
    setLaunching(true); setLaunchMsg(null);
    try {
      const res = await api.launchCall(campaign.id, { phone: dial, firstName: firstName || undefined, targetId });
      if (res.status === 'setup_required') {
        setLaunchMsg({ kind: 'warn', text: `Retell not configured. Missing: ${res.missing.join(', ')}.` });
      } else if (res.status === 'launched') {
        setLaunchMsg({ kind: 'ok', text: `Call launched${res.mock ? ' (mock)' : ''} — call id ${res.callId}.` });
        setPhone('');
        await reloadDetail();
        onChanged();
      }
    } catch (e) {
      setLaunchMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Call failed to launch.' });
    } finally {
      setLaunching(false);
    }
  }

  const configured = status?.configured ?? false;

  return (
    <div className="space-y-5">
      <div className="cc-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1">{campaign.name}</h3>
          <span className="badge badge-blue">{campaign.status}</span>
        </div>
        <p className="text-xs text-t3 whitespace-pre-wrap">{campaign.script}</p>
        <div className="flex flex-wrap gap-1.5">
          {campaign.requiredFields.map(f => <span key={f} className="badge badge-violet">{f}</span>)}
          <span className="badge badge-blue">{campaign.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' ? 'Direct booking' : 'Request only'}</span>
        </div>
      </div>

      {/* Launch test call */}
      <div className="cc-card p-5 space-y-3">
        <h4 className="text-sm font-bold text-t1 flex items-center gap-2"><PhoneCall className="w-4 h-4 text-indigo" /> Launch a call</h4>
        {!configured && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-v/40 bg-amber-v/5 px-3 py-2 text-xs text-amber-v">
            <AlertCircle className="w-4 h-4" /> Retell isn’t configured — launching returns a setup-required notice instead of placing a call.
          </div>
        )}
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
          <Field label="Phone number"><TextInput value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 555 010 0000" /></Field>
          <Field label="First name (optional)"><TextInput value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Jordan" /></Field>
          <button type="button" disabled={launching || !phone} onClick={() => launch()} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 h-[38px]">
            {launching ? <Loader2 className="w-4 h-4 animate-spin" /> : <PhoneOutgoing className="w-4 h-4" />} Call
          </button>
        </div>
        {launchMsg && (
          <p className={`text-xs ${launchMsg.kind === 'ok' ? 'text-emerald-v' : launchMsg.kind === 'warn' ? 'text-amber-v' : 'text-red-v'}`}>{launchMsg.text}</p>
        )}
      </div>

      {/* Targets */}
      <TargetList campaign={campaign} targets={targets} onAdded={reloadDetail} onCall={(t) => launch(t.id, t.phone)} canCall={!launching} />

      {/* Call logs */}
      <div className="cc-card p-5">
        <h4 className="text-sm font-bold text-t1 mb-3 flex items-center gap-2"><Activity className="w-4 h-4 text-indigo" /> Call logs</h4>
        {logs.length === 0 ? <p className="text-xs text-t3">No calls placed yet.</p> : (
          <div className="space-y-1.5">
            {logs.map(l => (
              <div key={l.id} className="flex items-center justify-between rounded-lg border border-[var(--b1)] px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={outcomeBadge[l.outcome] ?? 'badge badge-blue'}>{l.outcome}</span>
                  <span className="text-t2">{l.callerName || l.callerPhone || '—'}</span>
                </div>
                <span className="text-t3 font-mono text-[10px]">{l.retellCallId ?? 'no call id'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TargetList({ campaign, targets, onAdded, onCall, canCall }: { campaign: OutboundCampaign; targets: CallTarget[]; onAdded: () => void; onCall: (t: CallTarget) => void; canCall: boolean }) {
  const [phone, setPhone] = useState('');
  const [first, setFirst] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function add() {
    if (!phone) return;
    setBusy(true);
    try {
      await api.addTargets(campaign.id, [{ phone, firstName: first || undefined }]);
      setPhone(''); setFirst('');
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: CallTarget) {
    if (!window.confirm(`Remove target ${target.phone}?`)) return;
    setDeletingId(target.id);
    try {
      await api.deleteTarget(campaign.id, target.id);
      onAdded();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="cc-card p-5 space-y-3">
      <h4 className="text-sm font-bold text-t1 flex items-center gap-2"><Phone className="w-4 h-4 text-indigo" /> Target list ({targets.length})</h4>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <Field label="Phone"><TextInput value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 555 010 0001" /></Field>
        <Field label="First name"><TextInput value={first} onChange={e => setFirst(e.target.value)} placeholder="Optional" /></Field>
        <button type="button" disabled={busy || !phone} onClick={add} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50 h-[38px]"><Plus className="w-4 h-4" /> Add</button>
      </div>
      {targets.length > 0 && (
        <div className="space-y-1.5">
              {targets.map(t => (
                <div key={t.id} className="flex items-center justify-between rounded-lg border border-[var(--b1)] px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="badge badge-blue">{t.status}</span>
                    <span className="text-t2">{[t.firstName, t.lastName].filter(Boolean).join(' ') || t.phone}</span>
                    <span className="text-t3">{t.phone}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" disabled={!canCall} onClick={() => onCall(t)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 font-semibold text-indigo hover:bg-[var(--s2)] disabled:opacity-50">
                      <PhoneOutgoing className="w-3 h-3" /> Call
                    </button>
                    <button
                      type="button"
                      disabled={busy || deletingId === t.id}
                      onClick={() => void remove(t)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 font-semibold text-red-v hover:bg-[var(--red-soft)] disabled:opacity-50"
                    >
                      {deletingId === t.id ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </div>
              ))}
        </div>
      )}
    </div>
  );
}

function BookingRequestQueue({ requests, onChanged }: { requests: BookingRequest[]; onChanged: () => void }) {
  async function update(id: string, status: BookingRequestStatus) {
    await api.updateBookingRequest(id, { status });
    onChanged();
  }
  return (
    <div className="cc-card p-5">
      <h3 className="text-sm font-bold text-t1 mb-3 flex items-center gap-2"><CalendarClock className="w-4 h-4 text-indigo" /> Appointment requests ({requests.length})</h3>
      {requests.length === 0 ? <p className="text-xs text-t3">No appointment requests collected yet. They appear here after calls complete.</p> : (
        <div className="space-y-2">
          {requests.map(r => (
            <div key={r.id} className="rounded-lg border border-[var(--b1)] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={requestBadge[r.status]}>{r.status.replace('_', ' ')}</span>
                  <span className="text-sm text-t1 font-semibold truncate">{r.collectedName || r.collectedPhone || 'Unknown contact'}</span>
                  {r.requestedService && <span className="text-xs text-t3 truncate">· {r.requestedService}</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {r.status === 'PENDING_REVIEW' && (
                    <>
                      <button type="button" onClick={() => update(r.id, 'BOOKED')} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-emerald-v hover:bg-[var(--s2)]">Mark booked</button>
                      <button type="button" onClick={() => update(r.id, 'REJECTED')} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--s2)]">Reject</button>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-t3">
                {r.requestedDateTime && <span>{new Date(r.requestedDateTime).toLocaleString()}</span>}
                {r.collectedPhone && <span>{r.collectedPhone}</span>}
                {r.missingFields.length > 0 && <span className="text-amber-v">Missing: {r.missingFields.join(', ')}</span>}
                {r.outcomeReason && <span className="italic">{r.outcomeReason}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
