import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Users, Layers3, Workflow,
  Search, Sparkles, Zap, Flame, ChevronUp, ChevronDown, AlertTriangle,
} from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import ConfirmationModal from '../components/workflow/ConfirmationModal';
import ModuleTabs from '../components/ui/ModuleTabs';
import CRMMetricsStrip from '../components/crm/CRMMetricsStrip';
import PipelineBoard from '../components/crm/PipelineBoard';
import SmartSegmentCard from '../components/crm/SmartSegmentCard';
import ConsentBadgeGroup from '../components/crm/ConsentBadgeGroup';
import LeadScoreExplanationDrawer from '../components/crm/LeadScoreExplanationDrawer';
import PatientGrowthDrawer from '../components/crm/PatientGrowthDrawer';
import AutomationRulesPanel from '../components/crm/AutomationRulesPanel';
import { formatCurrency } from '../utils/formatters';
import {
  crmService, PATIENT_PAGE_SIZE,
  type CommandMetrics, type CrmLead, type CrmPatient, type CrmPipeline, type CtaId, type SegmentPreview,
} from '../lib/crmService';

type TabKey = 'command' | 'pipeline' | 'intelligence' | 'segments' | 'automation';
type PatientSortKey = 'name' | 'value' | 'churn';
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'command', label: 'Command View' },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'intelligence', label: 'Patient Intelligence' },
  { key: 'segments', label: 'Smart Segments' },
  { key: 'automation', label: 'Automation Rules' },
];

const LOAD_ERROR = 'CRM data is unavailable. No empty-pipeline, consent, or value conclusions can be drawn until the service responds.';

export default function CRM() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('command');
  const [metrics, setMetrics] = useState<CommandMetrics | null>(null);
  const [pipeline, setPipeline] = useState<CrmPipeline | null>(null);
  const [segments, setSegments] = useState<SegmentPreview | null>(null);
  const [patients, setPatients] = useState<CrmPatient[]>([]);
  const [patientsTruncated, setPatientsTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [patientsLoading, setPatientsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [patientSearch, setPatientSearch] = useState('');
  const [sort, setSort] = useState<{ key: PatientSortKey; dir: 'asc' | 'desc' }>({ key: 'churn', dir: 'desc' });

  // Drawers / modals
  const [scoreLead, setScoreLead] = useState<CrmLead | null>(null);
  const [profile, setProfile] = useState<{ lead?: CrmLead; patient?: CrmPatient } | null>(null);
  const [reasonModal, setReasonModal] = useState<CrmLead | null>(null);
  const [commsModal, setCommsModal] = useState<{ lead: CrmLead; cta: CtaId } | null>(null);

  // The at-risk threshold the server used, so the table never restates one.
  const churnRiskHigh = metrics?.policy.churnRiskHigh ?? null;

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const [m, p, s] = await Promise.all([
        crmService.getMetrics(),
        crmService.getPipeline(),
        crmService.getSegments(),
      ]);
      if (signal.cancelled) return;
      setMetrics(m); setPipeline(p); setSegments(s); setLoadError(null);
    } catch {
      if (!signal.cancelled) setLoadError(LOAD_ERROR);
    } finally {
      if (!signal.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void (async () => { await load(signal); })();
    return () => { signal.cancelled = true; };
  }, [load]);

  // Patient lookup runs on the SERVER. It used to filter the hundred rows that
  // happened to be in memory, so "No patients found" was a claim about a page.
  const loadPatients = useCallback(async (signal: { cancelled: boolean }, search: string, threshold: number | null) => {
    try {
      const page = await crmService.listPatients({ search, churnRiskHigh: threshold });
      if (signal.cancelled) return;
      setPatients(page.patients);
      setPatientsTruncated(page.truncated);
    } catch {
      if (!signal.cancelled) setLoadError(LOAD_ERROR);
    } finally {
      if (!signal.cancelled) setPatientsLoading(false);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    const timer = setTimeout(() => {
      setPatientsLoading(true);
      void loadPatients(signal, patientSearch, churnRiskHigh);
    }, patientSearch ? 250 : 0);
    return () => { signal.cancelled = true; clearTimeout(timer); };
  }, [patientSearch, churnRiskHigh, loadPatients]);

  async function reload() {
    const signal = { cancelled: false };
    setLoading(true);
    await load(signal);
    await loadPatients(signal, patientSearch, churnRiskHigh);
  }

  // Tenant-wide priority, ranked by the server across every open lead — not the
  // top of whichever page loaded.
  const hotLeads = pipeline?.priority ?? [];
  const activeSegments = useMemo(() => (segments?.segments ?? []).filter(s => s.patientCount > 0), [segments]);

  const CTA_LABEL: Record<string, string> = { send_booking_link: 'Send booking link', send_deposit_link: 'Send deposit link', send_intake_form: 'Send intake form', send_follow_up: 'Send follow-up', confirm_visit: 'Confirm visit' };

  async function onAction(lead: CrmLead, cta: CtaId) {
    if (cta === 'call_now') { if (lead.phone) window.location.assign(`tel:${lead.phone}`); return; }
    if (cta === 'mark_retained') { await crmService.setStage(lead.id, 'retained'); await reload(); return; }
    if (cta === 'mark_lost') { setReasonModal(lead); return; }
    if (cta === 'launch_winback' || cta === 'recover_lost') { navigate('/campaigner'); return; }
    // Communication CTAs use the live consent/suppression-checked send route.
    setCommsModal({ lead, cta });
  }

  const handlers = { onOpenProfile: (l: CrmLead) => setProfile({ lead: l }), onWhyScore: (l: CrmLead) => setScoreLead(l), onAction };

  // Sorting reorders the loaded page only, which is why the caption below says so.
  const patientsSorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...patients].sort((a, b) => {
      const cmp = sort.key === 'name' ? a.name.localeCompare(b.name)
        : sort.key === 'value' ? a.lifetimeValue - b.lifetimeValue
        : a.churnRisk - b.churnRisk;
      return cmp * dir;
    });
  }, [patients, sort]);
  const toggleSort = (key: PatientSortKey) =>
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' });

  return (
    <div className="space-y-5 pb-8 animate-fade-up">
      {/* Slim toolbar — the topbar breadcrumb carries the page title. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-t3">Patient growth, retention &amp; revenue recovery</p>
        <button type="button" onClick={() => navigate('/campaigner')} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition">
          <Sparkles className="w-4 h-4" /> Create Campaign Draft
        </button>
      </div>

      <div className="overflow-x-auto">
        <ModuleTabs
          tabs={TABS.map(item => ({ id: item.key, label: item.label }))}
          activeTab={tab}
          onChange={id => setTab(id as TabKey)}
          ariaLabel="CRM sections"
        />
      </div>

      {loadError ? (
        <BentoCard title="CRM data unavailable" subtitle="The service did not return a complete CRM dataset">
          <div role="alert" className="rounded-xl border border-red-soft bg-red-soft p-4">
            <p className="text-sm font-semibold text-red-v">{loadError}</p>
            <button type="button" onClick={() => void reload()} className="mt-3 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-xs font-semibold text-t1 hover:bg-[var(--s2)]">Retry</button>
          </div>
        </BentoCard>
      ) : loading || !metrics || !pipeline || !segments ? <div className="space-y-3" aria-label="Loading CRM data">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton-line h-16 rounded-xl" />)}</div> : <div className="animate-fade-up">
        {tab === 'command' && (
          <div className="space-y-4">
            <CRMMetricsStrip m={metrics} onNavigate={navigate} />
            <BentoCard
              title="Rule-based planning suggestions"
              subtitle={`Leads ordered by an unvalidated fixed planning heuristic across all ${metrics.basis.openLeadCount.toLocaleString()} open leads`}
              headerRight={<span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-v"><Sparkles className="w-3.5 h-3.5" /> Not an AI prediction</span>}>
              {hotLeads.length === 0
                ? <EmptyStatePremium icon={<Flame className="w-5 h-5" />} title="No priority leads in this workspace" description={`No open lead scores ${metrics.policy.hotLeadScore} or above on the rule-based planning heuristic. Every lead was checked, not just a loaded page. This is not an AI prediction.`} />
                : <div className="space-y-2">{hotLeads.map(l => (
                  <div key={l.id} className="hover-lift flex items-center gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
                    <span className="grid place-items-center w-9 h-9 rounded-lg bg-emerald-soft text-emerald-v text-[12px] font-bold shrink-0">{l.score ?? '—'}</span>
                    <button type="button" onClick={() => setProfile({ lead: l })} className="min-w-0 flex-1 text-left">
                      <p className="text-[13px] font-bold text-t1 truncate">{l.name} <span className="text-t3 font-normal">· {l.service}</span></p>
                      <p className="text-[11px] text-t3">{formatCurrency(l.estimatedValue)} · {l.source} · {l.ageDays}d</p>
                    </button>
                    {l.nextBestAction && (
                      <button type="button" onClick={() => onAction(l, l.nextBestAction!.cta)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 shrink-0"><Zap className="w-3 h-3" /> {l.nextBestAction.label.slice(0, 22)}</button>
                    )}
                  </div>
                ))}</div>}
            </BentoCard>
          </div>
        )}

        {tab === 'pipeline' && (
          <BentoCard title="Patient Growth Pipeline" subtitle="New Inquiry → Contacted → Booked → Visited → Follow-up → Retained">
            <PipelineBoard pipeline={pipeline} {...handlers} />
          </BentoCard>
        )}

        {tab === 'intelligence' && (
          <BentoCard title="Patient Intelligence" subtitle="Retention risk, value & consent across your patient base"
            headerRight={
              <div className="flex items-center gap-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1.5 w-56">
                <Search className="w-3.5 h-3.5 text-t3 shrink-0" aria-hidden="true" />
                <input value={patientSearch} onChange={e => setPatientSearch(e.target.value)} aria-label="Search patients"
                  placeholder="Search patients…" className="w-full bg-transparent text-xs text-t1 outline-none placeholder:text-t3" />
              </div>
            }>
            <p className="text-[11px] text-t3 mb-2">
              Search runs against every patient record in this workspace, not the rows below.
              {' '}This workspace has {metrics.basis.patientCount.toLocaleString()} patients.
            </p>
            {patientsTruncated && (
              <p role="status" className="mb-2 inline-flex items-start gap-1.5 rounded-lg border border-amber-soft bg-amber-soft px-3 py-2 text-[11px] font-semibold text-amber-v">
                <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
                Showing the first {PATIENT_PAGE_SIZE} matching records. Sorting reorders these {PATIENT_PAGE_SIZE} only — narrow the search to see the rest.
              </p>
            )}
            {patientsLoading ? <div className="space-y-2" aria-label="Loading patients">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton-line h-12 rounded-lg" />)}</div>
              : patientsSorted.length === 0 ? <EmptyStatePremium icon={<Users className="w-5 h-5" />} title="No patients found" description={patientSearch ? `No patient in this workspace matches “${patientSearch}”.` : 'Patient records will appear here.'} />
              : <div className="overflow-x-auto rounded-xl border border-[var(--b1)]">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-[var(--s2)] border-b border-[var(--b1)]">
                      <SortableTh label="Patient" active={sort.key === 'name'} dir={sort.dir} onClick={() => toggleSort('name')} />
                      <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-t3">Lifecycle</th>
                      <th className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-t3">Consent</th>
                      <SortableTh label="Lifetime value" align="right" active={sort.key === 'value'} dir={sort.dir} onClick={() => toggleSort('value')} />
                      <SortableTh label="Churn risk" align="right" active={sort.key === 'churn'} dir={sort.dir} onClick={() => toggleSort('churn')} />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--b1)]">
                    {patientsSorted.map(p => (
                      <tr key={p.id} onClick={() => setProfile({ patient: p })} tabIndex={0}
                        onKeyDown={e => { if (e.key === 'Enter') setProfile({ patient: p }); }}
                        className="cursor-pointer hover:bg-[var(--s2)] focus-visible:bg-[var(--s2)] outline-none transition-colors">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-8 h-8 rounded-full logo-user grid place-items-center text-[10px] font-bold text-white shrink-0">{p.name.split(' ').map(s => s[0]).slice(0, 2).join('')}</div>
                            <span className="text-[13px] font-semibold text-t1 truncate">{p.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-[12px] text-t2 capitalize whitespace-nowrap">{p.lifecycleStage.toLowerCase().replace('_', ' ')}</td>
                        <td className="px-4 py-2.5"><ConsentBadgeGroup consent={p.consent} compact /></td>
                        <td className="px-4 py-2.5 text-right text-[13px] font-bold text-t1 tabular-nums whitespace-nowrap">{formatCurrency(p.lifetimeValue)}</td>
                        {/* The at-risk band is the server's, against the tenant's configured churnRiskHigh. */}
                        <td className="px-4 py-2.5 text-right whitespace-nowrap"><span className={`badge ${p.atRisk ? 'badge-red' : 'badge-emerald'}`}>{p.churnRisk}%</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
          </BentoCard>
        )}

        {tab === 'segments' && (
          <div>
            <p className="text-[12px] text-t3 mb-3">
              Rule-based candidate groups counted across every patient in this workspace. Membership is not contact eligibility;
              consent and suppression are verified during campaign preview and dispatch.
            </p>
            {activeSegments.length === 0
              ? <EmptyStatePremium icon={<Layers3 className="w-5 h-5" />} title="No candidate groups in this workspace" description="No patient in this workspace matches any configured candidate group. Groups appear as patients become inactive or at risk." />
              : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{activeSegments.map(s => <SmartSegmentCard key={s.key} segment={s} recoverablePercent={segments.policy.recoverableLtvPercent} onCreateCampaign={() => navigate('/campaigner')} />)}</div>}
          </div>
        )}

        {tab === 'automation' && (
          <BentoCard title="Automation Rules" subtitle="Trigger → action rules for patient growth" headerRight={<span className="inline-flex items-center gap-1 text-[11px] font-bold text-violet-v"><Workflow className="w-3.5 h-3.5" /> Configured rules</span>}>
            <AutomationRulesPanel onNavigate={navigate} />
          </BentoCard>
        )}
      </div>}

      {/* Drawers */}
      {scoreLead && <LeadScoreExplanationDrawer lead={scoreLead} onClose={() => setScoreLead(null)} />}
      {profile && <PatientGrowthDrawer lead={profile.lead} patient={profile.patient} onClose={() => setProfile(null)} onNavigate={(r) => { setProfile(null); navigate(r); }} />}

      {/* Modals */}
      {reasonModal && (
        <ConfirmationModal title="Mark lead as lost?" message={`Record why "${reasonModal.name}" was lost. This is captured for lost-reason intelligence.`} confirmLabel="Mark lost" tone="red" requireReason
          onClose={() => setReasonModal(null)}
          onConfirm={async (reason) => { await crmService.setStage(reasonModal.id, 'lost', reason); await reload(); }}
        />
      )}
      {commsModal && (
        <ConfirmationModal title={CTA_LABEL[commsModal.cta] ?? 'Send communication'} message={`Request ${CTA_LABEL[commsModal.cta]?.toLowerCase() ?? 'a message'} to ${commsModal.lead.name}. Stored badges are not authorization; the server verifies current consent and suppression evidence at dispatch and blocks ineligible contact.`} confirmLabel="Verify & request send" tone="indigo"
          onClose={() => setCommsModal(null)}
          onConfirm={async () => { await crmService.sendComms(commsModal.lead.id, commsModal.cta); }}
        />
      )}
    </div>
  );
}

function SortableTh({ label, active, dir, onClick, align = 'left' }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; align?: 'left' | 'right' }) {
  return (
    <th className="px-4 py-2.5">
      <button type="button" onClick={onClick}
        className={`inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${active ? 'text-t1' : 'text-t3 hover:text-t2'} ${align === 'right' ? 'flex-row-reverse w-full justify-start' : ''}`}>
        {label}
        {active
          ? (dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)
          : <ChevronDown className="w-3 h-3 opacity-30" />}
      </button>
    </th>
  );
}
