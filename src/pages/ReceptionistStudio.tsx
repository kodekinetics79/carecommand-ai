import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Bot, Building2, Plus, Sparkles, Phone, PhoneOff, Megaphone, ListChecks, Eye, Code2, Activity, Loader2, AlertCircle, PhoneOutgoing, BookOpen } from 'lucide-react';
import { receptionistApi as api, type Campaign, type Overview } from '../lib/receptionist';
import { blockerLabel, receptionistClinicApi, type ClinicRow } from '../lib/receptionistClinic';
import { describeFailure } from '../lib/resourceState';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import FormDialog from '../components/workflow/FormDialog';
import { formatEnumLabel } from '../components/receptionist/helpers';
import { EmptyState } from '../components/receptionist/shared';
import { ClinicPanel } from '../components/receptionist/ClinicPanel';
import { CreateClinicDialog } from '../components/receptionist/CreateClinicDialog';
import { KnowledgePanel } from '../components/receptionist/KnowledgePanel';
import { LocalePackPanel } from '../components/receptionist/LocalePackPanel';
import { CampaignPanel } from '../components/receptionist/CampaignPanel';
import { IntakeBuilder } from '../components/receptionist/IntakeBuilder';
import { PreviewPanel } from '../components/receptionist/PreviewPanel';
import { RetellPanel } from '../components/receptionist/RetellPanel';
import { ActivityPanel } from '../components/receptionist/ActivityPanel';
import { OutboundPanel } from '../components/receptionist/outbound/OutboundPanel';

type Tab = 'clinic' | 'knowledge' | 'campaign' | 'intake' | 'preview' | 'retell' | 'outbound' | 'activity';

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'clinic', label: 'Clinic Profile', icon: Building2 },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'campaign', label: 'Agent & Campaign', icon: Megaphone },
  { id: 'intake', label: 'Intake Builder', icon: ListChecks },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'retell', label: 'RetellAI Export', icon: Code2 },
  { id: 'outbound', label: 'Outbound Calls', icon: PhoneOutgoing },
  { id: 'activity', label: 'Activity', icon: Activity },
];

function isTab(value: string | null): value is Tab {
  return TABS.some(tab => tab.id === value);
}

export default function ReceptionistStudio() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activeClinicId, setActiveClinicId] = useState<string>('');
  const [activeCampaignId, setActiveCampaignId] = useState<string>('');
  const requestedTab = searchParams.get('tab');
  const requestedClinicId = searchParams.get('clinicId');
  const requestedCallId = searchParams.get('callId');
  const tab: Tab = isTab(requestedTab) ? requestedTab : 'clinic';
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createDialog, setCreateDialog] = useState<'clinic' | 'campaign' | null>(null);

  const activeClinic = clinics.find(c => c.id === activeClinicId) ?? null;
  const activeCampaign = campaigns.find(c => c.id === activeCampaignId) ?? null;

  const selectTab = useCallback((nextTab: Tab, replace = true) => {
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('tab', nextTab);
      return next;
    }, { replace });
  }, [setSearchParams]);
  const closeCreateDialog = useCallback(() => setCreateDialog(null), []);

  const loadClinics = useCallback(async () => {
    const [rows, ov] = await Promise.all([receptionistClinicApi.listClinics(), api.overview().catch(() => null)]);
    setClinics(rows);
    if (ov) setOverview(ov);
    setActiveClinicId(prev => requestedClinicId && rows.some(row => row.id === requestedClinicId)
      ? requestedClinicId
      : prev && rows.some(r => r.id === prev) ? prev : rows[0]?.id ?? '');
    return rows;
  }, [requestedClinicId]);

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
      setError(null);
    }).catch(cause => {
      // A failed campaign list must not read as "No campaigns yet".
      if (active) setError(`Campaigns could not be loaded: ${describeFailure(cause).message}`);
    });
    return () => { active = false; };
  }, [activeClinicId]);

  function handleCreateClinic() {
    setCreateDialog('clinic');
  }

  function handleCreateCampaign() {
    if (!activeClinicId) return;
    setCreateDialog('campaign');
  }

  if (loading) {
    return <div className="flex items-center justify-center py-24 text-sm text-t3"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading Receptionist Studio…</div>;
  }

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="AI Receptionist Studio"
        subtitle="Draft and export receptionist prompts, then link and verify the separately configured Retell deployment used for live calls."
        badge={`${clinics.length} clinic${clinics.length === 1 ? '' : 's'}`}
        badgeColor="violet"
        actions={
          <button type="button" onClick={handleCreateClinic} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            <Plus className="w-4 h-4" /> New Clinic
          </button>
        }
      />

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--red-soft)] px-3 py-2 text-xs font-semibold text-red-v">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {createDialog === 'clinic' && (
        <CreateClinicDialog
          onClose={closeCreateDialog}
          onCreated={async clinic => {
            await loadClinics();
            setActiveClinicId(clinic.id);
            selectTab('clinic');
          }}
        />
      )}

      {createDialog === 'campaign' && activeClinic && (
        <FormDialog
          title="Create receptionist campaign"
          message={`Create a truthful draft for ${activeClinic.name}. These details are used in the generated receptionist prompt; no calls are placed by this action.`}
          submitLabel="Create draft"
          fields={[
            { name: 'name', label: 'Internal campaign name', required: true, placeholder: 'New-patient scheduling' },
            { name: 'offerTitle', label: 'Caller-facing purpose', required: true, placeholder: 'Schedule a dental appointment' },
            { name: 'appointmentType', label: 'Appointment type', required: true, placeholder: 'New-patient exam' },
            { name: 'offerDescription', label: 'Approved scope', required: true, placeholder: 'Help callers request or book an eligible appointment.' },
            { name: 'offerScript', label: 'Approved opening after disclosure', required: true, placeholder: 'How can I help with scheduling today?' },
          ]}
          onClose={closeCreateDialog}
          onSubmit={async values => {
            const campaign = await api.createCampaign({
              clinicId: activeClinicId,
              name: values.name,
              offerTitle: values.offerTitle,
              offerDescription: values.offerDescription,
              offerScript: values.offerScript,
              appointmentType: values.appointmentType,
              eligibleLocationIds: activeClinic.locations?.map(location => location.id) ?? [],
            });
            await loadCampaigns(activeClinicId);
            setActiveCampaignId(campaign.id);
            selectTab('campaign');
          }}
        />
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
                    {(clinic.readiness?.blockers?.length ?? 0) > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1" aria-label={`${clinic.name} activation blockers`}>
                        {clinic.readiness!.blockers.map(blocker => (
                          <span key={blocker} className="badge badge-amber text-[9px]">{blockerLabel(blocker)}</span>
                        ))}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>

            <div className="cc-card p-3 space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Campaigns</p>
                <button type="button" aria-label="Add campaign" title="Add campaign" onClick={handleCreateCampaign} className="text-t3 hover:text-indigo"><Plus className="w-3.5 h-3.5" /></button>
              </div>
              {campaigns.length === 0 && !error && <p className="px-1 text-[11px] text-t3">No campaigns yet.</p>}
              {campaigns.map(campaign => (
                <button
                  key={campaign.id}
                  type="button"
                  onClick={() => setActiveCampaignId(campaign.id)}
                  className={`w-full rounded-xl px-2.5 py-2 text-left transition-colors ${campaign.id === activeCampaignId ? 'bg-[var(--blue-soft)] border border-[var(--b1)]' : 'hover:bg-[var(--s3)]'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-t1 truncate">{campaign.name}</p>
                    <span className={`badge ${campaign.status === 'ACTIVE' ? 'badge-emerald' : campaign.status === 'PAUSED' ? 'badge-amber' : 'badge-blue'}`}>{formatEnumLabel(campaign.status)}</span>
                  </div>
                  <p className="text-[10px] text-t3 truncate mt-0.5">{formatEnumLabel(campaign.campaignType)} · {campaign.intakeFields?.length ?? 0} fields</p>
                </button>
              ))}
            </div>
          </div>

          {/* Main editing surface */}
          <div className="space-y-4">
            <div className="flex items-center gap-1 overflow-x-auto rounded-xl bg-[var(--s3)] p-1" role="tablist" aria-label="Receptionist Studio sections">
              {TABS.map((t, index) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    ref={element => { tabRefs.current[index] = element; }}
                    id={`receptionist-studio-tab-${t.id}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    aria-controls={`receptionist-studio-panel-${t.id}`}
                    tabIndex={tab === t.id ? 0 : -1}
                    onClick={() => selectTab(t.id)}
                    onKeyDown={event => {
                      let nextIndex: number | null = null;
                      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % TABS.length;
                      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + TABS.length) % TABS.length;
                      if (event.key === 'Home') nextIndex = 0;
                      if (event.key === 'End') nextIndex = TABS.length - 1;
                      if (nextIndex == null) return;
                      event.preventDefault();
                      selectTab(TABS[nextIndex].id);
                      tabRefs.current[nextIndex]?.focus();
                    }}
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${tab === t.id ? 'bg-[var(--s2)] text-t1 shadow-sm' : 'text-t3 hover:text-t2'}`}
                  >
                    <Icon className="w-3.5 h-3.5" /> {t.label}
                  </button>
                );
              })}
            </div>

            <div
              id={`receptionist-studio-panel-${tab}`}
              role="tabpanel"
              aria-labelledby={`receptionist-studio-tab-${tab}`}
              tabIndex={0}
              className="space-y-4 outline-none"
            >
            {tab === 'clinic' && activeClinic && (
              <ClinicPanel key={activeClinic.id} clinic={activeClinic} onChanged={loadClinics} />
            )}
            {tab === 'knowledge' && (
              activeClinic
                ? <div key={activeClinic.id} className="space-y-4"><KnowledgePanel clinic={activeClinic} /><LocalePackPanel clinic={activeClinic} /></div>
                : <EmptyState text="Create a clinic profile first to teach the agent what it may say." />
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
              activeCampaign ? <RetellPanel key={activeCampaign.id} campaignId={activeCampaign.id} onConfigure={selectTab} /> : <EmptyState text="Select a campaign to export its RetellAI configuration." />
            )}
            {tab === 'outbound' && (
              activeClinic ? <OutboundPanel key={activeClinic.id} clinic={activeClinic} />
                : <EmptyState text="Create a clinic profile first to configure outbound calling." />
            )}
            {tab === 'activity' && activeClinic && (
              <ActivityPanel clinicId={activeClinic.id} initialCallId={requestedCallId} />
            )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
