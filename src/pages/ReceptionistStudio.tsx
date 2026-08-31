import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Bot, Building2, Plus, Phone, PhoneOff, Megaphone, ListChecks, Eye, Rocket, Activity, Loader2, AlertCircle, PhoneOutgoing, BookOpen, ShieldCheck, Timer } from 'lucide-react';
import { receptionistApi as api, type Campaign } from '../lib/receptionist';
import { blockerLabel, receptionistClinicApi, type ClinicRow } from '../lib/receptionistClinic';
import {
  deploymentApi, formatCount, formatRate, formatSeconds, resolveStudioTab, serviceStatus,
  studioTabAttention, studioReadyFraction,
  type GoLivePrerequisite, type OverviewKpis, type ReadinessResponse, type VoiceLineStatusResponse, type StudioTab,
} from '../lib/receptionistDeployment';
import { useResource } from '../hooks/useResource';
import { describeFailure, receivedData } from '../lib/resourceState';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import FormDialog from '../components/workflow/FormDialog';
import { formatEnumLabel } from '../components/receptionist/helpers';
import { EmptyState } from '../components/receptionist/shared';
import { LoadFailureNotice } from '../components/receptionist/MutationNotice';
import { ClinicPanel } from '../components/receptionist/ClinicPanel';
import { CreateClinicDialog } from '../components/receptionist/CreateClinicDialog';
import { KnowledgePanel } from '../components/receptionist/KnowledgePanel';
import { LocalePackPanel } from '../components/receptionist/LocalePackPanel';
import { CampaignPanel } from '../components/receptionist/CampaignPanel';
import { IntakeBuilder } from '../components/receptionist/IntakeBuilder';
import { PreviewPanel } from '../components/receptionist/PreviewPanel';
import { GoLivePanel } from '../components/receptionist/GoLivePanel';
import { ActivityPanel } from '../components/receptionist/ActivityPanel';
import { GoLiveCard, ServiceStatusStrip } from '../components/receptionist/GoLiveCard';
import { OutboundPanel } from '../components/receptionist/outbound/OutboundPanel';

/**
 * Two doors, not three: the Front Desk is where staff work a live queue, and
 * this Studio is where the receptionist is configured and taken live. The tab
 * that once carried the voice supplier's name in its label is **Go live** —
 * publish, line check — because that is what an owner comes here to do, and
 * because it is the tab id the server's remediation catalogue has been
 * pointing at all along (`fixTab: 'deploy'`, 25 entries). The supplier's
 * console procedure that used to sit under it is now support-only.
 *
 * The id list and the alias map live in `lib/receptionistDeployment.ts`, with
 * the readiness keys: they are a contract with the server, not page trivia.
 */
type Tab = StudioTab;

const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: 'clinic', label: 'Clinic Profile', icon: Building2 },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'campaign', label: 'Agent & Campaign', icon: Megaphone },
  { id: 'intake', label: 'Intake Builder', icon: ListChecks },
  { id: 'preview', label: 'Preview', icon: Eye },
  { id: 'deploy', label: 'Go live', icon: Rocket },
  { id: 'outbound', label: 'Outbound Calls', icon: PhoneOutgoing },
  { id: 'activity', label: 'Activity', icon: Activity },
];

/** A KPI tile that prints the server's definition beside the number and an em dash when it has none. */
function KpiCard({ title, value, subtitle, definition, icon, accent }: {
  title: string; value: string; subtitle?: string; definition?: string;
  icon: React.ReactNode; accent: 'blue' | 'emerald' | 'violet' | 'amber' | 'red' | 'cyan' | 'indigo';
}) {
  return (
    <div title={definition} data-kpi={title}>
      <StatCard title={title} value={value} subtitle={subtitle ?? definition} icon={icon} accent={accent} />
    </div>
  );
}

export default function ReceptionistStudio() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [clinics, setClinics] = useState<ClinicRow[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [overview, setOverview] = useState<OverviewKpis | null>(null);
  const [overviewFailure, setOverviewFailure] = useState<string | null>(null);
  const [activeClinicId, setActiveClinicId] = useState<string>('');
  const [activeCampaignId, setActiveCampaignId] = useState<string>('');
  const [deploying, setDeploying] = useState(false);

  // E3 — every parameter the server's fix links carry. Reading only `tab` is
  // what made a Fix link open the wrong clinic's campaign on a two-clinic
  // tenant. `clinicId` stays accepted so links printed before the rename work.
  const requestedTab = searchParams.get('tab');
  const requestedClinicId = searchParams.get('clinic') ?? searchParams.get('clinicId');
  const requestedCampaignId = searchParams.get('campaign');
  const requestedAgentId = searchParams.get('agent');
  const requestedCallId = searchParams.get('callId');
  const tab: Tab = resolveStudioTab(requestedTab) ?? 'clinic';

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
    const rows = await receptionistClinicApi.listClinics();
    setClinics(rows);
    setActiveClinicId(prev => requestedClinicId && rows.some(row => row.id === requestedClinicId)
      ? requestedClinicId
      : prev && rows.some(r => r.id === prev) ? prev : rows[0]?.id ?? '');
    return rows;
  }, [requestedClinicId]);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await deploymentApi.overview());
      setOverviewFailure(null);
    } catch (cause) {
      // A failed KPI read must read as unavailable, never as a clinic with no calls.
      setOverviewFailure(describeFailure(cause).message);
    }
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
        if (active) await loadOverview();
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [loadClinics, loadOverview]);

  useEffect(() => {
    let active = true;
    (activeClinicId ? api.listCampaigns(activeClinicId) : Promise.resolve<Campaign[]>([])).then(rows => {
      if (!active) return;
      setCampaigns(rows);
      // A fix link naming a campaign (or the agent that campaign links) wins
      // over whatever was selected, so the operator lands on the row the
      // failure was about rather than the clinic's first campaign.
      setActiveCampaignId(prev => {
        const requested = (requestedCampaignId ? rows.find(r => r.id === requestedCampaignId) : undefined)
          ?? (requestedAgentId ? rows.find(r => r.agentId === requestedAgentId) : undefined);
        if (requested) return requested.id;
        return prev && rows.some(r => r.id === prev) ? prev : rows[0]?.id ?? '';
      });
      setError(null);
    }).catch(cause => {
      // A failed campaign list must not read as "No campaigns yet".
      if (active) setError(`Campaigns could not be loaded: ${describeFailure(cause).message}`);
    });
    return () => { active = false; };
  }, [activeClinicId, requestedCampaignId, requestedAgentId]);

  // --- The persistent go-live rail (SF-4) and status strip (SF-3) ------------
  const loadReadiness = useCallback(
    (signal: AbortSignal) => (activeCampaignId ? deploymentApi.readiness(activeCampaignId, signal) : Promise.resolve(null)),
    [activeCampaignId]);
  const readinessResource = useResource<ReadinessResponse | null>(loadReadiness);
  const railReadiness = receivedData(readinessResource.state) ?? null;
  const loadRailStatus = useCallback(
    (signal: AbortSignal) => (activeCampaignId ? deploymentApi.voiceLineStatus({ campaignId: activeCampaignId }, signal) : Promise.resolve(null)),
    [activeCampaignId]);
  const railStatusResource = useResource<VoiceLineStatusResponse | null>(loadRailStatus);
  const railStatus = receivedData(railStatusResource.state) ?? null;
  const reloadRail = readinessResource.reload;

  const prerequisites: GoLivePrerequisite[] = useMemo(
    () => (activeClinic?.readiness?.blockers ?? []).map(code => ({
      code,
      label: blockerLabel(code),
      fixHref: `/receptionist-studio?clinic=${encodeURIComponent(activeClinic!.id)}&tab=clinic`,
    })),
    [activeClinic]);

  // Where the outstanding work actually is. The server already says which tab
  // fixes each failing check; surfacing it here is the difference between a
  // strip of eight identical pills and a map of what is left to do.
  const attention = useMemo(() => studioTabAttention(railReadiness, prerequisites), [railReadiness, prerequisites]);
  const readyFraction = useMemo(() => studioReadyFraction(railReadiness), [railReadiness]);

  const status = serviceStatus({
    campaignStatus: activeCampaign?.status ?? 'DRAFT',
    readiness: railReadiness,
    verification: railStatus?.verification ?? null,
    deploying,
  });

  const refreshCampaigns = useCallback(async () => {
    await loadCampaigns(activeClinicId);
    readinessResource.reload();
    railStatusResource.reload();
  }, [loadCampaigns, activeClinicId, readinessResource, railStatusResource]);

  // A deep link that names a campaign this clinic does not hold must say so:
  // showing a different campaign under the failure's heading is exactly the
  // confusion the fix links were meant to end.
  const deepLinkMiss = requestedCampaignId && campaigns.length > 0 && !campaigns.some(row => row.id === requestedCampaignId)
    ? 'That link points at a campaign this clinic does not hold. Pick the clinic it belongs to on the left.'
    : requestedClinicId && clinics.length > 0 && !clinics.some(row => row.id === requestedClinicId)
      ? 'That link points at a clinic you cannot see. Pick a clinic on the left.'
      : null;

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

  const definitions = overview?.definitions ?? {};

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="Receptionist Studio"
        subtitle="Configure the clinic's AI receptionist, publish it to the voice line, and prove it can answer a real call."
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

      {deepLinkMiss && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-v/40 bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1">
          <AlertCircle className="w-4 h-4 text-amber-v" /> {deepLinkMiss}
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

      {/*
        SF-2 — the shift report. These are the kpi-v2 numbers with the server's
        own definition printed under each one. The header used to show "calls
        handled" over both directions and a booking rate over every call
        including zero-second no-answers, plus "0m 0s" where the truth was
        unknown. A rate with no denominator is an em dash here, never 0%.
      */}
      {overviewFailure && <LoadFailureNotice what="The receptionist KPIs" message={overviewFailure} onRetry={() => void loadOverview()} />}
      {overview && (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5" aria-label="Receptionist performance">
          <KpiCard
            title="Answered inbound" value={formatCount(overview.counts.answeredInbound)}
            definition={definitions.answeredInbound} icon={<Phone className="w-4 h-4" />} accent="blue"
          />
          <KpiCard
            title="Booking rate" value={formatRate(overview.rates.bookingRate)}
            subtitle={overview.rates.bookingRate === null ? 'Not enough data' : `${formatCount(overview.counts.booked)} booked`}
            definition={definitions.bookingRate} icon={<ShieldCheck className="w-4 h-4" />} accent="emerald"
          />
          <KpiCard
            title="Contained" value={formatRate(overview.rates.containedPct)}
            subtitle={overview.rates.containedPct === null ? 'Not enough data' : undefined}
            definition={definitions.containedPct} icon={<Bot className="w-4 h-4" />} accent="violet"
          />
          <KpiCard
            title="Avg call" value={formatSeconds(overview.aht)}
            subtitle={overview.aht === null ? 'Not enough data' : undefined}
            definition={definitions.aht} icon={<Timer className="w-4 h-4" />} accent="cyan"
          />
          <KpiCard
            title="Do-not-contact" value={formatCount(overview.counts.optedOut)}
            icon={<PhoneOff className="w-4 h-4" />} accent="red"
          />
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
            {/*
              SF-3 / SF-4. The strip and the rail sit above the tabs on every
              screen, so "is the line answering, and what is blocking it" is
              never more than one glance away, whichever tab is open.
            */}
            {activeCampaign && <ServiceStatusStrip status={status} />}
            {activeCampaign && tab !== 'campaign' && readinessResource.state.status === 'error' && (
              <LoadFailureNotice what="Activation readiness" message={readinessResource.state.failure.message} onRetry={reloadRail} />
            )}
            {activeCampaign && (tab === 'deploy' || tab === 'campaign') && (
              <GoLiveCard
                readiness={railReadiness}
                campaignStatus={activeCampaign.status}
                providerMode={railStatus?.providerMode ?? null}
                prerequisites={prerequisites}
                verification={railStatus?.verification ?? null}
                deploying={deploying}
              />
            )}

            {/*
              Setup progress. Eight tabs with no order and no state is the
              reason this module reads as hard to handle: nothing told anyone
              which steps were done or where the remaining work lived. Both
              facts were already on the server — every failing readiness row
              names the tab that fixes it — and simply were not shown.
            */}
            {readyFraction && (
              <div className="flex items-center gap-3">
                <div className="prog-track md flex-1" role="progressbar" aria-valuemin={0} aria-valuemax={readyFraction.total} aria-valuenow={readyFraction.passed} aria-label="Receptionist setup progress">
                  <div
                    className="prog-fill"
                    style={{
                      width: `${Math.round((readyFraction.passed / readyFraction.total) * 100)}%`,
                      background: readyFraction.passed === readyFraction.total ? 'var(--emerald)' : 'var(--indigo)',
                    }}
                  />
                </div>
                <span className="shrink-0 text-[11px] font-semibold text-t3 tabular-nums">
                  {readyFraction.passed === readyFraction.total
                    ? 'All checks ready'
                    : `${readyFraction.passed} of ${readyFraction.total} checks ready`}
                </span>
              </div>
            )}

            <div className="flex items-center gap-1 overflow-x-auto rounded-2xl border border-[var(--b1)] bg-[var(--s3)] p-1.5" role="tablist" aria-label="Receptionist Studio sections">
              {TABS.map((t, index) => {
                const Icon = t.icon;
                const outstanding = attention[t.id] ?? 0;
                return (
                  <button
                    key={t.id}
                    ref={element => { tabRefs.current[index] = element; }}
                    id={`receptionist-studio-tab-${t.id}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    aria-controls={`receptionist-studio-panel-${t.id}`}
                    aria-describedby={outstanding > 0 ? `receptionist-studio-tab-${t.id}-attention` : undefined}
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
                    className={`relative flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--indigo-glow)] ${tab === t.id ? 'bg-[var(--s0)] text-t1 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_4px_10px_rgba(15,23,42,0.05)]' : 'text-t3 hover:bg-[var(--s2)] hover:text-t2'}`}
                  >
                    <Icon className="w-3.5 h-3.5" /> {t.label}
                    {/*
                      A DOT, not a number, and it carries no text.
                      A count rendered inside the button became part of the tab's
                      own text — "Clinic Profile1" — which is what a screen
                      reader announces and what a label pin reads. The exact
                      count belongs in the readiness list, which names each item
                      and links to its fix; the strip only has to say "work is
                      here". Eight numbered tabs would be noise anyway.
                      The count is still spoken, via aria-describedby, from an
                      element outside this button.
                    */}
                    {outstanding > 0 && (
                      <span aria-hidden="true" className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-v" />
                    )}
                  </button>
                );
              })}
            </div>
            {/* Descriptions live outside the buttons so they change what is
                ANNOUNCED without changing what each tab is NAMED. */}
            <div className="sr-only">
              {TABS.map(t => {
                const outstanding = attention[t.id] ?? 0;
                if (outstanding === 0) return null;
                return (
                  <span key={t.id} id={`receptionist-studio-tab-${t.id}-attention`}>
                    {outstanding === 1 ? '1 item needs attention' : `${outstanding} items need attention`}
                  </span>
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
                <CampaignPanel key={activeCampaign.id} clinic={activeClinic} campaign={activeCampaign} onChanged={refreshCampaigns} />
              ) : <EmptyState text="No campaign selected. Create one to configure the agent and offer." onAction={handleCreateCampaign} actionLabel="New Campaign" />
            )}
            {tab === 'intake' && (
              activeCampaign ? <IntakeBuilder key={activeCampaign.id} campaign={activeCampaign} clinic={activeClinic!} onChanged={refreshCampaigns} />
                : <EmptyState text="Select or create a campaign to build its intake flow." />
            )}
            {tab === 'preview' && (
              activeCampaign ? <PreviewPanel key={activeCampaign.id} campaignId={activeCampaign.id} /> : <EmptyState text="Select a campaign to preview the generated agent." />
            )}
            {tab === 'deploy' && (
              activeCampaign
                ? (
                  <GoLivePanel
                    key={activeCampaign.id}
                    campaignId={activeCampaign.id}
                    campaignStatus={activeCampaign.status}
                    onDeployingChange={setDeploying}
                    onConfigure={selectTab}
                  />
                )
                : <EmptyState text="Select a campaign to deploy it and take the line live." />
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
