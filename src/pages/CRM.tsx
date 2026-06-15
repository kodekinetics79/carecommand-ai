import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Kanban, Users, Layers3, Megaphone, ListTodo, Radio, XCircle, Workflow,
  Search, Sparkles, Zap, Flame, ArrowRight, Crown, ChevronUp, ChevronDown,
} from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import ConfirmationModal from '../components/workflow/ConfirmationModal';
import CRMMetricsStrip from '../components/crm/CRMMetricsStrip';
import PipelineBoard from '../components/crm/PipelineBoard';
import SmartSegmentCard from '../components/crm/SmartSegmentCard';
import ConsentBadgeGroup from '../components/crm/ConsentBadgeGroup';
import LeadScoreExplanationDrawer from '../components/crm/LeadScoreExplanationDrawer';
import PatientGrowthDrawer from '../components/crm/PatientGrowthDrawer';
import AutomationRulesPanel from '../components/crm/AutomationRulesPanel';
import { formatCurrency } from '../utils/formatters';
import { crmService, type CrmLead, type CrmPatient, type CtaId, type CommandMetrics, type SmartSegment } from '../lib/crmService';

type TabKey = 'command' | 'pipeline' | 'intelligence' | 'segments' | 'campaigns' | 'tasks' | 'sources' | 'lost' | 'automation';
type PatientSortKey = 'name' | 'value' | 'churn';
const TABS: Array<{ key: TabKey; label: string; icon: React.ElementType }> = [
  { key: 'command', label: 'Command View', icon: LayoutDashboard },
  { key: 'pipeline', label: 'Pipeline', icon: Kanban },
  { key: 'intelligence', label: 'Patient Intelligence', icon: Users },
  { key: 'segments', label: 'Smart Segments', icon: Layers3 },
  { key: 'campaigns', label: 'Campaign ROI', icon: Megaphone },
  { key: 'tasks', label: 'Tasks & Follow-ups', icon: ListTodo },
  { key: 'sources', label: 'Sources & Attribution', icon: Radio },
  { key: 'lost', label: 'Lost Reasons', icon: XCircle },
  { key: 'automation', label: 'Automation Rules', icon: Workflow },
];

export default function CRM() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('command');
  const [leads, setLeads] = useState<CrmLead[]>([]);
  const [patients, setPatients] = useState<CrmPatient[]>([]);
  const [loading, setLoading] = useState(true);
  const [patientSearch, setPatientSearch] = useState('');
  const [sort, setSort] = useState<{ key: PatientSortKey; dir: 'asc' | 'desc' }>({ key: 'churn', dir: 'desc' });

  // Drawers / modals
  const [scoreLead, setScoreLead] = useState<CrmLead | null>(null);
  const [profile, setProfile] = useState<{ lead?: CrmLead; patient?: CrmPatient } | null>(null);
  const [reasonModal, setReasonModal] = useState<CrmLead | null>(null);
  const [commsModal, setCommsModal] = useState<{ lead: CrmLead; cta: CtaId } | null>(null);

  async function reload() {
    const [l, p] = await Promise.all([crmService.getLeads().catch(() => []), crmService.getPatients().catch(() => [])]);
    setLeads(l); setPatients(p);
  }
  useEffect(() => {
    let a = true;
    void (async () => { const [l, p] = await Promise.all([crmService.getLeads().catch(() => []), crmService.getPatients().catch(() => [])]); if (a) { setLeads(l); setPatients(p); setLoading(false); } })();
    return () => { a = false; };
  }, []);

  const metrics: CommandMetrics = useMemo(() => crmService.commandMetrics(leads, patients, null), [leads, patients]);
  const segments: SmartSegment[] = useMemo(() => crmService.smartSegments(patients), [patients]);
  const hotLeads = useMemo(() => leads.filter(l => l.score >= 70 && l.stage !== 'lost' && l.stage !== 'retained').sort((a, b) => b.score - a.score).slice(0, 6), [leads]);

  const CTA_LABEL: Record<string, string> = { send_booking_link: 'Send booking link', send_deposit_link: 'Send deposit link', send_intake_form: 'Send intake form', send_follow_up: 'Send follow-up', confirm_visit: 'Confirm visit' };

  async function onAction(lead: CrmLead, cta: CtaId) {
    if (cta === 'call_now') { if (lead.phone) window.location.assign(`tel:${lead.phone}`); return; }
    if (cta === 'mark_retained') { await crmService.setStage(lead.id, 'retained'); await reload(); return; }
    if (cta === 'mark_lost') { setReasonModal(lead); return; }
    if (cta === 'launch_winback' || cta === 'recover_lost') { navigate('/campaigner'); return; }
    // comms CTAs → confirm (consent-checked send is a typed TODO)
    setCommsModal({ lead, cta });
  }

  const handlers = { onOpenProfile: (l: CrmLead) => setProfile({ lead: l }), onWhyScore: (l: CrmLead) => setScoreLead(l), onAction };

  const patientsSorted = useMemo(() => {
    const q = patientSearch.toLowerCase();
    const rows = patients.filter(p => p.name.toLowerCase().includes(q));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return rows.sort((a, b) => {
      const cmp = sort.key === 'name' ? a.name.localeCompare(b.name)
        : sort.key === 'value' ? a.lifetimeValue - b.lifetimeValue
        : a.churnRisk - b.churnRisk;
      return cmp * dir;
    });
  }, [patients, patientSearch, sort]);
  const toggleSort = (key: PatientSortKey) =>
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' });

  return (
    <div className="space-y-5 pb-8 animate-fade-up">
      {/* Slim toolbar — the topbar breadcrumb carries the page title. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-t3">Patient growth, retention &amp; revenue recovery</p>
        <button type="button" onClick={() => navigate('/campaigner')} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition">
          <Sparkles className="w-4 h-4" /> Launch Campaign
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 overflow-x-auto bg-[var(--s1)] border border-[var(--b1)] p-1 rounded-xl shadow-sm" role="tablist" aria-label="CRM sections">
        {TABS.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key ? 'true' : 'false'} onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${tab === t.key ? 'bg-[var(--indigo)] text-white shadow-sm' : 'text-t3 hover:text-t1 hover:bg-[var(--s3)]'}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      <div className="animate-fade-up">
        {tab === 'command' && (
          <div className="space-y-4">
            <CRMMetricsStrip m={metrics} onNavigate={navigate} />
            <BentoCard title="AI next-best actions" subtitle="Highest-intent leads to action now" headerRight={<span className="inline-flex items-center gap-1 text-[11px] font-bold text-violet-v"><Sparkles className="w-3.5 h-3.5" /> AI-ranked</span>}>
              {loading ? <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton-line h-14 rounded-xl" />)}</div>
                : hotLeads.length === 0 ? <EmptyStatePremium icon={<Flame className="w-5 h-5" />} title="No hot leads right now" description="High-intent leads (score ≥ 70) will surface here for immediate action." />
                : <div className="space-y-2">{hotLeads.map(l => (
                  <div key={l.id} className="hover-lift flex items-center gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
                    <span className="grid place-items-center w-9 h-9 rounded-lg bg-emerald-soft text-emerald-v text-[12px] font-bold shrink-0">{l.score}</span>
                    <button type="button" onClick={() => setProfile({ lead: l })} className="min-w-0 flex-1 text-left">
                      <p className="text-[13px] font-bold text-t1 truncate">{l.name} <span className="text-t3 font-normal">· {l.service}</span></p>
                      <p className="text-[11px] text-t3">{formatCurrency(l.estimatedValue)} · {l.source} · {l.ageDays}d</p>
                    </button>
                    <button type="button" onClick={() => onAction(l, l.nextBestAction.cta)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 shrink-0"><Zap className="w-3 h-3" /> {l.nextBestAction.label.slice(0, 22)}</button>
                  </div>
                ))}</div>}
            </BentoCard>
          </div>
        )}

        {tab === 'pipeline' && (
          <BentoCard title="Patient Growth Pipeline" subtitle="New Inquiry → Contacted → Booked → Visited → Follow-up → Retained">
            <PipelineBoard leads={leads} loading={loading} {...handlers} />
          </BentoCard>
        )}

        {tab === 'intelligence' && (
          <BentoCard title="Patient Intelligence" subtitle="Retention risk, value & consent across your patient base"
            headerRight={
              <div className="flex items-center gap-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1.5 w-56">
                <Search className="w-3.5 h-3.5 text-t3 shrink-0" />
                <input value={patientSearch} onChange={e => setPatientSearch(e.target.value)} placeholder="Search patients…" className="w-full bg-transparent text-xs text-t1 outline-none placeholder:text-t3" />
              </div>
            }>
            {loading ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton-line h-12 rounded-lg" />)}</div>
              : patientsSorted.length === 0 ? <EmptyStatePremium icon={<Users className="w-5 h-5" />} title="No patients found" description={patientSearch ? 'No patients match your search.' : 'Patient records will appear here.'} />
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
                        <td className="px-4 py-2.5 text-right whitespace-nowrap"><span className={`badge ${p.churnRisk >= 50 ? 'badge-red' : 'badge-emerald'}`}>{p.churnRisk}%</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
          </BentoCard>
        )}

        {tab === 'segments' && (
          <div>
            <p className="text-[12px] text-t3 mb-3">AI-built reactivation & retention segments — consent-aware, with recoverable value and recommended offers.</p>
            {loading ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton-line h-52 rounded-2xl" />)}</div>
              : segments.length === 0 ? <EmptyStatePremium icon={<Layers3 className="w-5 h-5" />} title="No actionable segments yet" description="As patients become inactive or at-risk, AI segments with recoverable value appear here." />
              : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{segments.map(s => <SmartSegmentCard key={s.id} segment={s} onCreateCampaign={() => navigate('/campaigner')} />)}</div>}
          </div>
        )}

        {tab === 'campaigns' && <ContractTab title="Campaign ROI funnel" contract="GET /v1/crm/campaigns/:id/roi" note="The full funnel (sent → delivered → opened → clicked → booked → visited → paid → revenue/cost/ROI) and the unconverted follow-up list need a campaign delivery-metrics route. Launch and approve flows already work in the Reactivation engine." onGo={() => navigate('/reactivation')} goLabel="Open Reactivation engine" />}
        {tab === 'tasks' && <ContractTab title="Tasks & Follow-ups" contract="GET /v1/tasks (CRM-scoped view)" note="Staff tasks exist (Staff Workflow). A CRM-scoped follow-up queue with SLA + owner + auto-assignment rules is pending." onGo={() => navigate('/staff')} goLabel="Open Staff Workflow" />}
        {tab === 'sources' && <ContractTab title="Sources & Attribution" contract="GET /v1/crm/sources" note="Per-source performance (leads, booked, visited, revenue, LTV, cost-per-booking, no-show rate, ROI) needs a lead-source → appointment/revenue attribution route." />}
        {tab === 'lost' && <ContractTab title="Lost Reason Intelligence" contract="GET /v1/crm/lost-reasons" note="Lost-reason tracking (price, no response, competitor, insurance, no slot, missed call, deposit unpaid, not eligible) needs a Lead.lostReason field + aggregation route. The pipeline already captures a reason when a lead is marked lost." />}
        {tab === 'automation' && (
          <BentoCard title="Automation Rules" subtitle="Trigger → action engine for patient growth" headerRight={<span className="inline-flex items-center gap-1 text-[11px] font-bold text-violet-v"><Workflow className="w-3.5 h-3.5" /> Live engine</span>}>
            <AutomationRulesPanel onNavigate={navigate} />
          </BentoCard>
        )}
      </div>

      {/* Drawers */}
      {scoreLead && <LeadScoreExplanationDrawer lead={scoreLead} onClose={() => setScoreLead(null)} />}
      {profile && <PatientGrowthDrawer lead={profile.lead} patient={profile.patient} onClose={() => setProfile(null)} onNavigate={(r) => { setProfile(null); navigate(r); }} />}

      {/* Modals */}
      {reasonModal && (
        <ConfirmationModal title="Mark lead as lost?" message={`Record why "${reasonModal.name}" was lost. This is captured for lost-reason intelligence.`} confirmLabel="Mark lost" tone="red" requireReason
          onClose={() => setReasonModal(null)}
          onConfirm={async () => { await crmService.setStage(reasonModal.id, 'lost'); await reload(); }}
        />
      )}
      {commsModal && (
        <ConfirmationModal title={CTA_LABEL[commsModal.cta] ?? 'Send communication'} message={`This will ${CTA_LABEL[commsModal.cta]?.toLowerCase() ?? 'message'} to ${commsModal.lead.name} using a consent-checked channel.`} confirmLabel="Send" tone="indigo"
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

function ContractTab({ title, contract, note, onGo, goLabel }: { title: string; contract: string; note: string; onGo?: () => void; goLabel?: string }) {
  return (
    <BentoCard title={title} subtitle="Backend contract pending — no dead controls until the route exists">
      <div className="rounded-xl border border-dashed border-[var(--b2)] bg-[var(--s2)] p-5">
        <div className="flex items-center gap-2 mb-2"><Crown className="w-4 h-4 text-[var(--gold-ink)]" /><p className="text-sm font-bold text-t1">{title}</p></div>
        <p className="text-[13px] text-t2 leading-relaxed max-w-2xl">{note}</p>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <code className="rounded-md bg-[var(--s3)] px-2 py-1 text-[11px] font-mono text-t2">{contract}</code>
          {onGo && <button type="button" onClick={onGo} className="inline-flex items-center gap-1 text-[12px] font-semibold text-indigo hover:opacity-80">{goLabel} <ArrowRight className="w-3.5 h-3.5" /></button>}
        </div>
      </div>
    </BentoCard>
  );
}
