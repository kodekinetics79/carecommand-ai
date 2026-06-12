import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, Mail, Sparkles, Users2, TrendingDown, Phone, MessageSquare, Globe, Zap,
  Flame, ChevronRight, X, Trophy, GaugeCircle, Target, Layers, Clock,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import ProgressBar from '../components/ui/ProgressBar';
import BentoCard from '../components/ui/BentoCard';
import RiskBadge from '../components/ui/RiskBadge';
import { leads, patients, campaigns } from '../data/seedData';
import { formatCurrency, formatDate, formatRelativeDate } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { mapLead, mapPatient, type ApiAppointment, type ApiLead, type ApiPatient } from '../lib/apiAdapters';
import { apiRequest } from '../lib/api';

type Lead = typeof leads[number];
type ApiPatientDetail = Omit<ApiPatient, 'appointments' | 'consentEvents' | 'patientInsurancePolicies' | 'eligibilityVerifications' | 'priorAuthorizations'> & {
  consentEvents?: Array<{ purpose: 'SMS' | 'WHATSAPP' | 'EMAIL' | 'MARKETING'; granted: boolean; occurredAt?: string | null }>;
  appointments?: ApiAppointment[];
  patientInsurancePolicies?: Array<{
    id: string;
    payerId?: string | null;
    memberId: string;
    groupNumber?: string | null;
    payer?: { name: string } | null;
    verificationStatus: string;
    verifiedAt?: string | null;
    active: boolean;
  }>;
  eligibilityVerifications?: Array<{
    id: string;
    appointmentId?: string | null;
    payerId?: string | null;
    payer?: { name: string } | null;
    policy?: { memberId: string; groupNumber?: string | null } | null;
    coverageStatus: string;
    coverageActive: boolean;
    planName: string;
    copay: string;
    deductibleRemaining: string;
    coinsurance: string;
    eligibilityMessage: string;
    payerReference?: string | null;
    checkedAt: string;
    providerMode: string;
    priorAuthRequired?: boolean;
    recommendedAction?: string;
    riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
    revenueAtRisk?: number;
  }>;
  priorAuthorizations?: Array<{ id: string; status: string; serviceName: string; notes?: string | null; dueAt?: string | null; payer?: { name: string } | null }>;
  firstName: string;
  lastName: string;
};

type CustomerTimelineItem = {
  id: string;
  date: string;
  title: string;
  detail: string;
  kind: 'visit' | 'consent' | 'insurance' | 'authorization';
};
const stageOrder = ['new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained'] as const;
const stages = [...stageOrder, 'lost'] as const;
type Stage = typeof stages[number];

const stageConfig: Record<Stage, { label: string; color: string; bg: string; dot: string }> = {
  'new-inquiry': { label: 'New Inquiry', color: 'text-blue-v', bg: 'bg-[var(--blue-soft)]', dot: 'bg-blue-500' },
  'contacted': { label: 'Contacted', color: 'text-cyan-v', bg: 'bg-[var(--blue-soft)]', dot: 'bg-cyan-500' },
  'booked': { label: 'Booked', color: 'text-violet-v', bg: 'bg-[var(--violet-soft)]', dot: 'bg-violet-500' },
  'visited': { label: 'Visited', color: 'text-emerald-v', bg: 'bg-[var(--emerald-soft)]', dot: 'bg-emerald-500' },
  'follow-up': { label: 'Follow-up', color: 'text-amber-v', bg: 'bg-[var(--amber-soft)]', dot: 'bg-amber-500' },
  'retained': { label: 'Retained', color: 'text-emerald-v', bg: 'bg-[var(--emerald-soft)]', dot: 'bg-emerald-600' },
  'lost': { label: 'Lost', color: 'text-red-v', bg: 'bg-[var(--red-soft)]', dot: 'bg-red-500' },
};

const channelIcon: Record<string, React.ReactNode> = {
  whatsapp: <MessageSquare className="w-3 h-3" />,
  call: <Phone className="w-3 h-3" />,
  email: <Mail className="w-3 h-3" />,
  sms: <MessageSquare className="w-3 h-3" />,
  push: <Globe className="w-3 h-3" />,
  website: <Globe className="w-3 h-3" />,
};

const NOW = Date.now();
const daysSince = (date: string) => Math.max(0, Math.floor((NOW - new Date(date).getTime()) / 86400000));

const lifecycleConfig: Record<string, { label: string; badgeClass: string }> = {
  active: { label: 'Active', badgeClass: 'badge badge-emerald' },
  retained: { label: 'Retained', badgeClass: 'badge badge-emerald' },
  'at-risk': { label: 'At Risk', badgeClass: 'badge badge-amber' },
  inactive: { label: 'Inactive', badgeClass: 'badge badge-red' },
  new: { label: 'New', badgeClass: 'badge badge-blue' },
  lost: { label: 'Lost', badgeClass: 'badge badge-blue' },
};

const stageIntent: Record<Stage, number> = {
  'new-inquiry': 6, contacted: 16, booked: 32, visited: 36, 'follow-up': 26, retained: 40, lost: 0,
};

function scoreLead(lead: Lead, maxValue: number): number {
  const valueScore = maxValue > 0 ? (lead.estimatedValue / maxValue) * 40 : 0;
  const intent = stageIntent[lead.stage as Stage] ?? 0;
  const d = daysSince(lead.createdAt);
  const recency = d <= 2 ? 20 : d <= 7 ? 14 : d <= 14 ? 8 : d <= 30 ? 4 : 0;
  return Math.min(100, Math.round(valueScore + intent + recency));
}
const tempOf = (score: number) => (score >= 70 ? 'hot' : score >= 45 ? 'warm' : 'cold');
const tempBadge: Record<string, string> = { hot: 'badge badge-red', warm: 'badge badge-amber', cold: 'badge badge-blue' };

function buildCustomerTimeline(row: ApiPatientDetail): CustomerTimelineItem[] {
  const items: CustomerTimelineItem[] = [];

  row.appointments?.forEach((appointment, index) => {
    items.push({
      id: `appt-${appointment.id}-${index}`,
      date: appointment.startsAt,
      title: appointment.service,
      detail: `${appointment.status.replace('_', ' ').toLowerCase()} · ${appointment.channel.toLowerCase()} · ${formatCurrency(Number(appointment.value))}`,
      kind: 'visit',
    });
  });

  row.consentEvents?.forEach((event, index) => {
    if (!event.occurredAt) return;
    items.push({
      id: `consent-${event.purpose}-${index}`,
      date: event.occurredAt,
      title: `${event.purpose} consent ${event.granted ? 'granted' : 'revoked'}`,
      detail: event.granted ? 'Ready for outreach and campaign automation.' : 'Restricted from campaign outreach for this channel.',
      kind: 'consent',
    });
  });

  row.eligibilityVerifications?.forEach((verification, index) => {
    items.push({
      id: `elig-${verification.id}-${index}`,
      date: verification.checkedAt,
      title: `Eligibility ${verification.coverageStatus.toLowerCase()}`,
      detail: `${verification.payer?.name ?? 'Unknown payer'} · ${formatCurrency(Number(verification.copay))} copay · ${verification.recommendedAction ?? verification.eligibilityMessage}`,
      kind: 'insurance',
    });
  });

  row.priorAuthorizations?.forEach((auth, index) => {
    if (!auth.dueAt) return;
    items.push({
      id: `auth-${auth.id}-${index}`,
      date: auth.dueAt,
      title: `Prior auth ${auth.status.toLowerCase()}`,
      detail: `${auth.serviceName} · ${auth.payer?.name ?? 'Unknown payer'}${auth.notes ? ` · ${auth.notes}` : ''}`,
      kind: 'authorization',
    });
  });

  return items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function campaignReadinessLabel(patient: ReturnType<typeof mapPatient>, detail: ApiPatientDetail | null) {
  const tags = detail?.tags ?? patient.tags;
  const consentReady = patient.consentStatus.marketing || patient.consentStatus.whatsapp || patient.consentStatus.sms;
  const readiness: string[] = [];
  if (patient.preferredChannel) readiness.push(`${patient.preferredChannel.toUpperCase()}-first`);
  if (consentReady) readiness.push('Consent ready');
  if (patient.outstandingBalance > 0) readiness.push(`Collect ${formatCurrency(patient.outstandingBalance)} first`);
  if (tags.length > 0) readiness.push(tags.slice(0, 3).join(' · '));
  return readiness;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)]">
      <p className="text-[10px] font-bold uppercase tracking-widest text-t3">{label}</p>
      <p className="text-sm font-semibold text-t1 mt-1 truncate">{value}</p>
    </div>
  );
}

export default function CRM() {
  const navigate = useNavigate();
  const [inactiveSegment, setInactiveSegment] = useState('60');
  const [searchQuery, setSearchQuery] = useState('');
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomerDetail, setSelectedCustomerDetail] = useState<ApiPatientDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const { data: leadRecords, source: leadSource, reload: reloadLeads } = useApiResource<ApiLead, Lead>('/v1/leads?limit=100', leads, mapLead);
  const { data: customerRecords } = useApiResource<ApiPatient, typeof patients[number]>('/v1/patients?limit=100', patients, mapPatient);

  async function createCampaign(name: string, goal: string, channels: string[] = ['WHATSAPP', 'EMAIL']) {
    setCreatingCampaign(true);
    try {
      await apiRequest('/v1/campaigns', { method: 'POST', body: JSON.stringify({ name, goal, status: 'DRAFT', channels, aiGenerated: true }) });
      navigate('/campaigner');
    } catch { setCreatingCampaign(false); }
  }
  async function setLeadStage(lead: Lead, stage: Stage) {
    setMovingId(lead.id);
    try {
      await apiRequest(`/v1/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ stage }) });
      reloadLeads();
    } finally { setMovingId(null); }
  }
  function advance(lead: Lead) {
    const idx = stageOrder.indexOf(lead.stage as typeof stageOrder[number]);
    if (idx >= 0 && idx < stageOrder.length - 1) void setLeadStage(lead, stageOrder[idx + 1]);
  }
  async function createFollowUpTask(patientId: string) {
    await apiRequest(`/v1/patients/${patientId}/follow-up-task`, { method: 'POST', body: JSON.stringify({}) });
  }

  const maxValue = useMemo(() => Math.max(1, ...leadRecords.map(l => l.estimatedValue)), [leadRecords]);
  const scored = useMemo(() => leadRecords.map(l => ({ ...l, score: scoreLead(l, maxValue) })), [leadRecords, maxValue]);

  const openLeads = scored.filter(l => l.stage !== 'lost' && l.stage !== 'retained');
  const openPipeline = openLeads.reduce((s, l) => s + l.estimatedValue, 0);
  const wonCount = scored.filter(l => l.stage === 'retained').length;
  const lostCount = scored.filter(l => l.stage === 'lost').length;
  const winRate = wonCount + lostCount > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : 0;
  const avgDeal = leadRecords.length > 0 ? Math.round(leadRecords.reduce((s, l) => s + l.estimatedValue, 0) / leadRecords.length) : 0;
  const hotLeads = scored.filter(l => l.score >= 70 && l.stage !== 'lost' && l.stage !== 'retained');

  const churnRisk = customerRecords.length > 0 ? Math.round(customerRecords.reduce((s, p) => s + p.churnRisk, 0) / customerRecords.length) : 0;
  const avgLTV = customerRecords.length > 0 ? Math.round(customerRecords.reduce((s, p) => s + p.lifetimeValue, 0) / customerRecords.length) : 0;
  const atRiskCount = customerRecords.filter(p => p.lifecycleStage === 'at-risk' || p.lifecycleStage === 'inactive').length;

  const byStage = useMemo(() => {
    const map = {} as Record<Stage, (Lead & { score: number })[]>;
    stages.forEach(s => { map[s] = []; });
    scored.forEach(l => { (map[l.stage as Stage] ?? map['new-inquiry']).push(l); });
    stages.forEach(s => map[s].sort((a, b) => b.score - a.score));
    return map;
  }, [scored]);

  // Conversion funnel: cumulative reach of each stage as a share of all leads.
  const funnel = useMemo(() => {
    const total = scored.length || 1;
    return stageOrder.map((s, i) => {
      const reached = stageOrder.slice(i).reduce((sum, st) => sum + byStage[st].length, 0);
      return { stage: s, reached, pct: Math.round((reached / total) * 100) };
    });
  }, [scored, byStage]);

  const inactiveCounts = useMemo(() => ({
    '30': customerRecords.filter(p => { const d = daysSince(p.lastVisit); return d > 30 && d <= 60; }).length,
    '60': customerRecords.filter(p => { const d = daysSince(p.lastVisit); return d > 60 && d <= 90; }).length,
    '90': customerRecords.filter(p => { const d = daysSince(p.lastVisit); return d > 90 && d <= 180; }).length,
    '180': customerRecords.filter(p => daysSince(p.lastVisit) > 180).length,
  }), [customerRecords]);

  const filteredPatients = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return customerRecords.filter(p => !q || p.name.toLowerCase().includes(q) || p.tags.some(t => t.includes(q)));
  }, [customerRecords, searchQuery]);
  const currentSelectedCustomerId = selectedCustomerId ?? filteredPatients[0]?.id ?? null;

  useEffect(() => {
    if (!currentSelectedCustomerId) {
      return;
    }
    let active = true;
    apiRequest<ApiPatientDetail>(`/v1/patients/${currentSelectedCustomerId}`)
      .then(row => {
        if (!active) return;
        setSelectedCustomerDetail(row);
      })
      .catch(err => {
        if (!active) return;
        setSelectedCustomerDetail(null);
        setDetailError(err instanceof Error ? err.message : 'Unable to load customer record');
      });
    return () => { active = false; };
  }, [currentSelectedCustomerId]);

  function exportSegment() {
    const rows = filteredPatients.map(p => [p.name, p.lifecycleStage, p.churnRisk, p.lifetimeValue, p.lastVisit]);
    const csv = [['Name', 'Lifecycle', 'Churn Risk', 'Lifetime Value', 'Last Visit'], ...rows]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'crm-segment.csv'; link.click();
    URL.revokeObjectURL(url);
  }

  function nextBestAction(p: typeof customerRecords[number]): string {
    if (p.outstandingBalance > 0) return `Collect ${formatCurrency(p.outstandingBalance)} balance`;
    if (p.lifecycleStage === 'inactive') return 'Send winback offer';
    if (p.lifecycleStage === 'at-risk') return 'Personal check-in call';
    if (p.churnRisk >= 50) return 'Schedule retention touch';
    return 'Invite to loyalty programme';
  }

  const selectedCustomer = useMemo(() => {
    if (selectedCustomerDetail?.id === currentSelectedCustomerId) return mapPatient(selectedCustomerDetail);
    return customerRecords.find(p => p.id === currentSelectedCustomerId) ?? null;
  }, [currentSelectedCustomerId, customerRecords, selectedCustomerDetail]);

  const selectedCustomerHistory = useMemo(() => {
    if (!selectedCustomerDetail || selectedCustomerDetail.id !== currentSelectedCustomerId) return [];
    return buildCustomerTimeline(selectedCustomerDetail);
  }, [currentSelectedCustomerId, selectedCustomerDetail]);

  const selectedCustomerCampaignSignals = useMemo(() => {
    if (!selectedCustomer) return [];
    return campaignReadinessLabel(selectedCustomer, selectedCustomerDetail);
  }, [selectedCustomer, selectedCustomerDetail]);

  const selectedInsurance = selectedCustomerDetail?.patientInsurancePolicies?.[0] ?? null;
  const selectedLatestEligibility = selectedCustomerDetail?.eligibilityVerifications?.[0] ?? null;
  const selectedLatestAuth = selectedCustomerDetail?.priorAuthorizations?.[0] ?? null;
  const detailLoading = Boolean(currentSelectedCustomerId && (!selectedCustomerDetail || selectedCustomerDetail.id !== currentSelectedCustomerId) && !detailError);
  const selectedAgeOfRecord = selectedCustomerHistory.length > 0
    ? formatRelativeDate(selectedCustomerHistory[0].date)
    : selectedCustomerDetail
      ? formatRelativeDate(selectedCustomerDetail.lastVisitAt ?? selectedCustomerDetail.appointments?.[0]?.startsAt ?? new Date().toISOString())
      : '—';

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="GrowthPulse CRM"
        subtitle="Intelligent lead pipeline, AI lead scoring, and lifecycle retention — move deals, not spreadsheets."
        badge={`${openLeads.length} open · ${hotLeads.length} hot · ${leadSource === 'live' ? 'Live DB' : 'Demo'}`}
        badgeColor="blue"
        actions={
          <div className="flex gap-2">
            <button type="button" onClick={exportSegment} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b2)] bg-[var(--s2)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] transition">
              <Mail className="w-4 h-4" /> Export Segment
            </button>
            <button type="button" disabled={creatingCampaign} onClick={() => createCampaign('New CRM Campaign', 'Custom campaign created from CRM')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition disabled:opacity-40">
              <Sparkles className="w-4 h-4" /> {creatingCampaign ? 'Creating…' : 'Create Campaign'}
            </button>
          </div>
        }
      />

      {/* KPI Row */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard title="Open Pipeline" value={formatCurrency(openPipeline)} subtitle={`${openLeads.length} active deals`} icon={<Layers className="w-4 h-4" />} accent="blue" />
        <StatCard title="Hot Leads" value={hotLeads.length} subtitle="Score ≥ 70" icon={<Flame className="w-4 h-4" />} accent="red" />
        <StatCard title="Win Rate" value={`${winRate}%`} subtitle={`${wonCount} won · ${lostCount} lost`} icon={<Trophy className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Avg Deal Size" value={formatCurrency(avgDeal)} subtitle="Per lead" icon={<Target className="w-4 h-4" />} accent="violet" />
        <StatCard title="Avg Churn Risk" value={`${churnRisk}%`} subtitle={`${atRiskCount} at risk`} icon={<TrendingDown className="w-4 h-4" />} accent="amber" />
        <StatCard title="Avg LTV" value={formatCurrency(avgLTV)} subtitle="Per customer" trend={8} icon={<Users2 className="w-4 h-4" />} accent="cyan" />
      </div>

      {/* Interactive pipeline (kanban) */}
      <BentoCard title="Sales Pipeline" subtitle="Drag deals forward — advance a lead to the next stage or mark it lost" headerRight={
        <button type="button" onClick={() => navigate('/patients')} className="text-xs font-semibold text-indigo flex items-center gap-1 hover:opacity-80">View customers <ArrowRight className="w-3 h-3" /></button>
      }>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stages.map(stage => {
            const cfg = stageConfig[stage];
            const items = byStage[stage];
            const value = items.reduce((s, l) => s + l.estimatedValue, 0);
            return (
              <div key={stage} className="w-[200px] shrink-0">
                <div className="flex items-center justify-between gap-2 px-1 mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                    <p className={`text-[11px] font-bold ${cfg.color}`}>{cfg.label}</p>
                    <span className="text-[10px] text-t3">{items.length}</span>
                  </div>
                  <span className="text-[10px] font-semibold text-t3">{formatCurrency(value)}</span>
                </div>
                <div className="space-y-2 min-h-[60px]">
                  {items.map(lead => {
                    const temp = tempOf(lead.score);
                    const canAdvance = stage !== 'retained' && stage !== 'lost';
                    return (
                      <div key={lead.id} className={`rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-2.5 ${movingId === lead.id ? 'opacity-50' : ''}`}>
                        <div className="flex items-start justify-between gap-1.5">
                          <p className="text-xs font-bold text-t1 leading-tight truncate">{lead.name}</p>
                          <span className={`${tempBadge[temp]} shrink-0 text-[9px]`}>{lead.score}</span>
                        </div>
                        <p className="text-[10px] text-t3 mt-0.5 truncate">{lead.service}</p>
                        <div className="flex items-center justify-between gap-1 mt-1.5">
                          <span className="inline-flex items-center gap-1 text-[10px] text-t3">{channelIcon[lead.channel] ?? <Phone className="w-3 h-3" />} {daysSince(lead.createdAt)}d</span>
                          <span className="text-[10px] font-bold text-emerald-v">{formatCurrency(lead.estimatedValue)}</span>
                        </div>
                        {canAdvance && (
                          <div className="flex items-center gap-1 mt-2">
                            <button type="button" disabled={movingId === lead.id} onClick={() => advance(lead)} className="flex-1 inline-flex items-center justify-center gap-0.5 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] py-1 rounded-md hover:opacity-80 disabled:opacity-40">
                              Advance <ChevronRight className="w-3 h-3" />
                            </button>
                            <button type="button" disabled={movingId === lead.id} onClick={() => void setLeadStage(lead, 'lost')} title="Mark lost" aria-label="Mark lost" className="p-1 rounded-md text-t3 hover:text-red-v hover:bg-[var(--red-soft)] disabled:opacity-40">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {items.length === 0 && <div className="rounded-xl border border-dashed border-[var(--b1)] py-4 text-center text-[10px] text-t3">Empty</div>}
                </div>
              </div>
            );
          })}
        </div>
      </BentoCard>

      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        {/* Left column */}
        <div className="space-y-4">
          {/* Priority leads (scored) */}
          <BentoCard title="Priority Leads" subtitle="Ranked by AI lead score — work the hottest first" headerRight={<Flame className="w-4 h-4 text-red-v" />}>
            <div className="space-y-2">
              {[...openLeads].sort((a, b) => b.score - a.score).slice(0, 6).map(lead => {
                const temp = tempOf(lead.score);
                return (
                  <div key={lead.id} className="flex items-center gap-3 p-3 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                    <div className="w-9 h-9 rounded-xl bg-[var(--s3)] flex items-center justify-center text-t2 shrink-0">{channelIcon[lead.channel] ?? <Phone className="w-3.5 h-3.5" />}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-t1 truncate">{lead.name}</p>
                        <span className={`${tempBadge[temp]} capitalize`}>{temp}</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${stageConfig[lead.stage as Stage].bg} ${stageConfig[lead.stage as Stage].color}`}>{stageConfig[lead.stage as Stage].label}</span>
                      </div>
                      <p className="text-[11px] text-t3 truncate">{lead.service} · via {lead.source} · {daysSince(lead.createdAt)}d old</p>
                      <div className="mt-1"><ProgressBar value={lead.score} color={temp === 'hot' ? 'red' : temp === 'warm' ? 'amber' : 'blue'} /></div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-bold text-emerald-v">{formatCurrency(lead.estimatedValue)}</p>
                      <button type="button" disabled={movingId === lead.id} onClick={() => advance(lead)} className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-semibold text-indigo hover:opacity-80 disabled:opacity-40">Advance <ChevronRight className="w-3 h-3" /></button>
                    </div>
                  </div>
                );
              })}
              {openLeads.length === 0 && <p className="text-xs text-t3 py-4 text-center">No open leads in the pipeline.</p>}
            </div>
          </BentoCard>

          {/* Customer intelligence with next-best-action */}
          <BentoCard title="Customer Intelligence" subtitle="Retention risk & next best action" headerRight={
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search customers..." className="text-xs px-3 py-1.5 border border-[var(--b1)] rounded-xl bg-[var(--s3)] text-t1 placeholder:text-t3 focus:outline-none focus:ring-2 focus:ring-[var(--indigo)] focus:border-transparent w-44" />
          }>
            <div className="space-y-2">
              {filteredPatients.slice(0, 8).map(p => {
                const lc = lifecycleConfig[p.lifecycleStage] || lifecycleConfig.active;
                return (
                  <div
                    key={p.id}
                    onClick={() => { setDetailError(null); setSelectedCustomerId(p.id); }}
                    role="button"
                    tabIndex={0}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all group text-left cursor-pointer ${currentSelectedCustomerId === p.id ? 'border-[var(--b2)] bg-[var(--blue-soft)]' : 'border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)]'}`}
                  >
                    <button type="button" onClick={event => { event.stopPropagation(); navigate(`/patients/${p.id}`); }} className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[11px] font-bold shrink-0">
                      {p.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={event => { event.stopPropagation(); navigate(`/patients/${p.id}`); }} className="text-sm font-semibold text-t1 group-hover:text-indigo transition-colors truncate">{p.name}</button>
                        <span className={lc.badgeClass}>{lc.label}</span>
                      </div>
                      <p className="text-[11px] text-indigo font-medium mt-0.5">→ {nextBestAction(p)}</p>
                      <p className="text-[10px] text-t3">Last seen {daysSince(p.lastVisit)}d ago · LTV {formatCurrency(p.lifetimeValue)} · {p.visitCount} visits</p>
                    </div>
                    <div className="text-right shrink-0">
                      <RiskBadge level={p.churnRisk >= 70 ? 'high' : p.churnRisk >= 40 ? 'medium' : 'low'} label={`${p.churnRisk}%`} size="sm" />
                    </div>
                    <button type="button" onClick={event => { event.stopPropagation(); void createFollowUpTask(p.id); }} className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2.5 py-1.5 rounded-lg hover:opacity-80 transition-colors">
                      <Sparkles className="w-3 h-3" /> Task
                    </button>
                  </div>
                );
              })}
            </div>
          </BentoCard>

          <BentoCard title="Customer Record" subtitle="Full history from day one · campaign-ready profile" headerRight={<Users2 className="w-4 h-4 text-t3" />}>
            {!selectedCustomer ? (
              <p className="text-xs text-t3 py-4 text-center">Select a customer to load their record.</p>
            ) : detailLoading ? (
              <p className="text-xs text-t3 py-4 text-center">Loading customer history…</p>
            ) : detailError ? (
              <div className="rounded-xl border border-[var(--b1)] bg-[var(--red-soft)] p-3 text-xs text-red-v">{detailError}</div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-lg font-bold text-t1">{selectedCustomer.name}</p>
                        <span className={lifecycleConfig[selectedCustomer.lifecycleStage]?.badgeClass ?? lifecycleConfig.active.badgeClass}>{lifecycleConfig[selectedCustomer.lifecycleStage]?.label ?? 'Active'}</span>
                      </div>
                      <p className="text-[11px] text-t3 mt-1">Record age {selectedAgeOfRecord} · {selectedCustomer.visitCount} visits · last visit {selectedCustomer.lastVisit}</p>
                    </div>
                    <RiskBadge level={selectedCustomer.churnRisk >= 70 ? 'high' : selectedCustomer.churnRisk >= 40 ? 'medium' : 'low'} label={`${selectedCustomer.churnRisk}%`} size="sm" />
                  </div>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <Field label="Preferred channel" value={selectedCustomer.preferredChannel.toUpperCase()} />
                  <Field label="LTV" value={formatCurrency(selectedCustomer.lifetimeValue)} />
                  <Field label="Outstanding" value={selectedCustomer.outstandingBalance > 0 ? formatCurrency(selectedCustomer.outstandingBalance) : 'Clear'} />
                  <Field label="Marketing consent" value={selectedCustomer.consentStatus.marketing ? 'Ready' : 'Restricted'} />
                </div>
              </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Field label="Primary tags" value={selectedCustomer.tags.length > 0 ? selectedCustomer.tags.slice(0, 4).map(tag => tag.replace('-', ' ')).join(' · ') : '—'} />
                  <Field label="Campaign window" value={selectedCustomer.nextVisit ? `Next visit ${formatDate(selectedCustomer.nextVisit)}` : 'Open for outreach'} />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Field label="Payer" value={selectedInsurance?.payer?.name ?? selectedLatestEligibility?.payer?.name ?? '—'} />
                  <Field label="Member ID" value={selectedInsurance?.memberId ?? selectedLatestEligibility?.policy?.memberId ?? '—'} />
                  <Field label="Coverage" value={selectedLatestEligibility?.coverageStatus ?? selectedInsurance?.verificationStatus ?? 'Not verified'} />
                  <Field label="Prior auth" value={selectedLatestAuth?.status ?? 'None'} />
                </div>

                <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-2">Campaign-ready signals</p>
                  <div className="flex flex-wrap gap-2">
                    {selectedCustomerCampaignSignals.map(signal => (
                      <span key={signal} className="badge badge-blue">{signal}</span>
                    ))}
                    {selectedCustomerCampaignSignals.length === 0 && <span className="text-xs text-t3">No campaign signals yet.</span>}
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-3">
                  <button type="button" onClick={() => void createFollowUpTask(selectedCustomer.id)} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--indigo-soft)] px-3 py-2 text-xs font-semibold text-indigo hover:bg-[var(--s3)] transition">
                    <Sparkles className="w-3.5 h-3.5" /> Create task
                  </button>
                  <button type="button" onClick={() => navigate(`/patients/${selectedCustomer.id}`)} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition">
                    Open profile
                  </button>
                  <button type="button" disabled={creatingCampaign} onClick={() => void createCampaign(`${selectedCustomer.name} retention`, `Retain ${selectedCustomer.name} using ${selectedCustomer.preferredChannel} and ${selectedCustomer.tags.slice(0, 3).join(', ') || 'personalised outreach'}`, selectedCustomer.preferredChannel === 'whatsapp' ? ['WHATSAPP', 'EMAIL'] : ['EMAIL', 'SMS'])} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition disabled:opacity-40">
                    <Zap className="w-3.5 h-3.5" /> {creatingCampaign ? 'Creating…' : 'Launch campaign'}
                  </button>
                </div>
              </div>
            )}
          </BentoCard>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          <BentoCard title="Customer History" subtitle="Chronological activity from day one" headerRight={<Clock className="w-4 h-4 text-t3" />}>
            {detailLoading ? (
              <p className="text-xs text-t3 py-4 text-center">Loading history…</p>
            ) : selectedCustomerHistory.length > 0 ? (
              <div className="space-y-3">
                {selectedCustomerHistory.map(item => (
                  <div key={item.id} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)]">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${item.kind === 'visit' ? 'bg-[var(--indigo-soft)]' : item.kind === 'insurance' ? 'bg-[var(--emerald-soft)]' : item.kind === 'authorization' ? 'bg-[var(--amber-soft)]' : 'bg-[var(--violet-soft)]'}`}>
                      <Clock className="w-3.5 h-3.5 text-t2" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-xs font-semibold text-t1">{item.title}</p>
                        <span className="text-[10px] text-t3">{formatDate(item.date)}</span>
                      </div>
                      <p className="text-[11px] text-t3 mt-0.5">{item.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-t3 py-4 text-center">No customer history yet.</p>
            )}
          </BentoCard>

          {/* Conversion funnel */}
          <BentoCard title="Conversion Funnel" subtitle="Where leads progress & drop off" headerRight={<GaugeCircle className="w-4 h-4 text-violet-v" />}>
            <div className="space-y-2.5">
              {funnel.map((row, i) => {
                const prev = i > 0 ? funnel[i - 1].reached : row.reached;
                const stepConv = prev > 0 ? Math.round((row.reached / prev) * 100) : 0;
                const cfg = stageConfig[row.stage];
                return (
                  <div key={row.stage}>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className={`text-xs font-semibold ${cfg.color}`}>{cfg.label}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-t3">{row.reached} ({row.pct}%)</span>
                        {i > 0 && <span className={`text-[10px] font-bold ${stepConv >= 60 ? 'text-emerald-v' : stepConv >= 30 ? 'text-amber-v' : 'text-red-v'}`}>{stepConv}%→</span>}
                      </div>
                    </div>
                    <ProgressBar value={row.pct} color={i >= 4 ? 'emerald' : i >= 2 ? 'violet' : 'blue'} />
                  </div>
                );
              })}
            </div>
          </BentoCard>

          {/* Reactivation segments */}
          <BentoCard title="Inactive Segments" subtitle="Reactivation opportunities">
            <div className="flex items-center gap-1 bg-[var(--s3)] p-1 rounded-xl mb-4">
              {['30', '60', '90', '180'].map(d => (
                <button key={d} type="button" onClick={() => setInactiveSegment(d)} className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${inactiveSegment === d ? 'bg-[var(--s2)] text-t1' : 'text-t3'}`}>{d}d+</button>
              ))}
            </div>
            <div className="space-y-2.5">
              {Object.entries(inactiveCounts).map(([range, count]) => {
                const estValue = count * avgLTV * 0.18;
                return (
                  <div key={range} className={`rounded-xl border p-3.5 transition-all ${inactiveSegment === range ? 'border-[var(--b2)] bg-[var(--blue-soft)]' : 'border-[var(--b1)]'}`}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-sm font-bold text-t1">{range}–{parseInt(range) === 180 ? '365' : parseInt(range) + 30}d inactive</p>
                      <span className="badge badge-blue">{count} customers</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-xs text-t2">Est. recoverable</p>
                      <p className="text-xs font-bold text-emerald-v">{formatCurrency(Math.round(estValue))}</p>
                    </div>
                    <button type="button" disabled={creatingCampaign} onClick={() => createCampaign(`Reactivation – ${range}d inactive`, `Win back ${count} customers inactive for ${range}+ days`, ['WHATSAPP', 'SMS', 'EMAIL'])} className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed border-[var(--b2)] text-xs font-semibold text-indigo hover:bg-[var(--s3)] transition-colors disabled:opacity-40">
                      <Zap className="w-3 h-3" /> Launch Reactivation
                    </button>
                  </div>
                );
              })}
            </div>
          </BentoCard>

          {/* Campaign ROI */}
          <BentoCard title="Recent Campaign ROI" subtitle="Campaign highlights">
            <div className="space-y-3">
              {campaigns.slice(0, 3).map(c => (
                <div key={c.id} className="p-3 rounded-xl border border-[var(--b1)]">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-xs font-bold text-t1 truncate">{c.name}</p>
                    <span className={`${c.status === 'active' ? 'badge badge-emerald' : c.status === 'completed' ? 'badge badge-blue' : 'badge badge-amber'}`}>{c.status}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div><p className="text-sm font-bold text-t1">{c.audienceSize}</p><p className="text-[10px] text-t3">Audience</p></div>
                    <div><p className="text-sm font-bold text-emerald-v">{c.booked}</p><p className="text-[10px] text-t3">Booked</p></div>
                    <div><p className="text-sm font-bold text-t1">{formatCurrency(c.revenue)}</p><p className="text-[10px] text-t3">Revenue</p></div>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
