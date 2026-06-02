import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, CalendarDays, DollarSign, Phone, Sparkles, TrendingUp,
  Users, Zap, AlertCircle, CheckCircle2, BarChart3, Star, Clock
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import InsightCard from '../components/ui/InsightCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import RevenueChart from '../components/charts/RevenueChart';
import UtilizationChart from '../components/charts/UtilizationChart';
import { branches } from '../data/mockClinics';
import { appointments } from '../data/mockAppointments';
import { patients } from '../data/mockPatients';
import { radarAlerts } from '../data/mockRadar';
import { campaigns } from '../data/mockCampaigns';
import { formatCurrency } from '../utils/formatters';
import { apiRequest } from '../lib/api';
import { useApiResource } from '../hooks/useApiResource';
import { mapCampaign, type ApiCampaign } from '../lib/apiAdapters';

const todayDate = '2025-05-26';
const todayAppts = appointments.filter(a => a.date === todayDate).length;
const activeCustomers = patients.filter(p => p.lifecycleStage === 'active' || p.lifecycleStage === 'retained').length;
const revenueRecovered = 27200;
const missedCallRecovery = 19;
const noShowRisk = appointments.filter(a => a.status === 'risky' || a.status === 'no-show').length;
const totalRevenue = branches.reduce((s, b) => s + b.revenue, 0);
const avgHealthScore = Math.round(branches.reduce((s, b) => s + b.healthScore, 0) / branches.length);

interface DashboardSummary {
  generatedAt: string;
  networkRevenue: number;
  revenueRecovered: number;
  activeCustomers: number;
  todaysAppointments: number;
  noShowRisk: number;
  callsRecovered: number;
  missedCalls: number;
  activeOpportunities: number;
  pendingApprovals: number;
}

const fallbackSummary: DashboardSummary = {
  generatedAt: new Date().toISOString(),
  networkRevenue: totalRevenue,
  revenueRecovered,
  activeCustomers,
  todaysAppointments: todayAppts,
  noShowRisk,
  callsRecovered: missedCallRecovery,
  missedCalls: 23,
  activeOpportunities: 28350,
  pendingApprovals: 1,
};

const priorityActions = [
  { id: 'p1', title: 'Run 90-day inactive customer campaign', description: '187 customers eligible. Historical conversion: 18%. Est. £18,700 in recoverable revenue.', impact: '£18,700', urgency: 'high' as const, action: 'Activate Winback Campaign', icon: <Users className="w-3.5 h-3.5" /> },
  { id: 'p2', title: 'Westside has 31 empty slots this week', description: 'At £200/slot, £6,200 is at risk. Recommend limited weekday offer for skin services.', impact: '£6,200', urgency: 'high' as const, action: 'Create Slot-Fill Campaign', icon: <CalendarDays className="w-3.5 h-3.5" /> },
  { id: 'p3', title: '23 missed calls still uncontacted', description: '42 calls this month. AI recovered 19. 23 remain — est. £3,450 in lost opportunity.', impact: '£3,450', urgency: 'medium' as const, action: 'Review Missed-Call Queue', icon: <Phone className="w-3.5 h-3.5" /> },
  { id: 'p4', title: 'Dr. Mitchell: high repeat rate, low reviews', description: '78% repeat-visit rate. Only 12 review requests sent vs 89 consultations. Est. 28 new reviews.', impact: 'Reputation', urgency: 'medium' as const, action: 'Launch Review Campaign', icon: <Star className="w-3.5 h-3.5" /> },
  { id: 'p5', title: '14 follow-up opportunities not yet rebooked', description: "Post-service customers who haven't scheduled their next visit. Est. value: £4,800.", impact: '£4,800', urgency: 'low' as const, action: 'Assign Follow-Up Tasks', icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
];

const actionRoute: Record<string, string> = {
  p1: '/campaigner',
  p2: '/scheduling',
  p3: '/ai-receptionist',
  p4: '/reviews',
  p5: '/staff',
};

const urgencyClass: Record<'high' | 'medium' | 'low', string> = {
  high: 'urgency-high',
  medium: 'urgency-medium',
  low: 'urgency-low',
};
const urgencyDot: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-[var(--red)]',
  medium: 'bg-[var(--amber)]',
  low: 'bg-[var(--emerald)]',
};

function branchCls(score: number) {
  if (score >= 75) return 'branch-ok';
  if (score >= 55) return 'branch-warn';
  return 'branch-crit';
}
function branchScoreColor(score: number) {
  if (score >= 75) return 'text-emerald-v';
  if (score >= 55) return 'text-amber-v';
  return 'text-red-v';
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState(fallbackSummary);
  const [summarySource, setSummarySource] = useState<'live' | 'demo'>('demo');
  const { data: campaignRecords } = useApiResource<ApiCampaign, typeof campaigns[number]>('/v1/campaigns?limit=3', campaigns, mapCampaign);

  useEffect(() => {
    let active = true;
    apiRequest<DashboardSummary>('/v1/dashboard/summary')
      .then(row => {
        if (!active) return;
        setSummary(row);
        setSummarySource('live');
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const reportDate = new Date(summary.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const totalCalls = summary.callsRecovered + summary.missedCalls;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Command Center"
        subtitle={`Growth cockpit for your multi-location clinic network · ${reportDate}`}
        badge={summarySource === 'live' ? 'Live DB' : 'Demo'}
        badgeColor={summarySource === 'live' ? 'emerald' : 'blue'}
        actions={
          <button type="button" onClick={() => navigate('/clinic-radar')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(99,102,241,0.25)] hover:opacity-90 transition-opacity">
            <Sparkles className="w-4 h-4" /> AI Briefing
          </button>
        }
      />

      {/* Hero Growth Briefing */}
      <div className="hero-panel">
        <div className="relative flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-indigo-200" />
              <p className="text-xs font-bold uppercase tracking-widest text-indigo-200">Today's Growth Briefing</p>
            </div>
            <h2 className="text-xl font-bold text-white mb-1 leading-snug">
              £{(summary.revenueRecovered / 1000).toFixed(0)}K recovered this month · {formatCurrency(summary.activeOpportunities)} in active opportunities
            </h2>
            <p className="text-sm text-white/70 leading-relaxed max-w-2xl">
              Your live operating data shows <span className="text-white font-medium">{summary.pendingApprovals} governed AI action{summary.pendingApprovals === 1 ? '' : 's'}</span> awaiting review and {summary.missedCalls} missed calls needing follow-up. Preview intelligence below shows the richer network model as more records arrive.
            </p>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-2">
            <div className="text-right">
              <p className="text-2xl font-bold text-white tabular-nums">{formatCurrency(summary.networkRevenue)}</p>
              <p className="text-xs text-white/65">Network revenue this month</p>
            </div>
            <button type="button" onClick={() => navigate('/revenue')} className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-200 hover:text-white transition-colors">
              View full report <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* KPI Strip — 6 stats */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard title="Network Revenue" value={formatCurrency(summary.networkRevenue)} subtitle="Latest snapshot" icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Revenue Recovered" value={formatCurrency(summary.revenueRecovered)} subtitle="By automation" icon={<DollarSign className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Today's Appointments" value={summary.todaysAppointments} subtitle="Across your scope" icon={<CalendarDays className="w-4 h-4" />} accent="blue" />
        <StatCard title="Active Customers" value={summary.activeCustomers} subtitle="Engaged base" icon={<Users className="w-4 h-4" />} accent="violet" />
        <StatCard title="No-Show Risk" value={summary.noShowRisk} subtitle="Flagged today" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Calls Recovered" value={`${summary.callsRecovered}/${totalCalls}`} subtitle="AI follow-up queue" icon={<Phone className="w-4 h-4" />} accent="cyan" />
      </div>

      {/* Main Bento Grid */}
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">

        {/* Left column */}
        <div className="space-y-4">

          {/* Branch Health Grid */}
          <BentoCard title="Branch Health Scores" subtitle="Network intelligence preview" headerRight={
            <span className="text-xs font-semibold text-t3 bg-[var(--s3)] px-2.5 py-1 rounded-full">Avg {avgHealthScore}/100</span>
          }>
            <div className="grid gap-3 sm:grid-cols-2">
              {branches.map((branch) => (
                <div key={branch.id} className={`rounded-xl p-4 ${branchCls(branch.healthScore)}`}>
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <p className="text-sm font-bold text-t1 leading-tight">{branch.name}</p>
                      <p className="text-[11px] text-t3 mt-0.5">{branch.location}</p>
                    </div>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full bg-[var(--s3)] ${branchScoreColor(branch.healthScore)}`}>{branch.healthScore}</span>
                  </div>
                  <div className="mb-3">
                    <ProgressBar value={branch.healthScore} color={branch.healthScore >= 75 ? 'emerald' : branch.healthScore >= 55 ? 'amber' : 'red'} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-sm font-bold text-t1">{branch.utilization}%</p>
                      <p className="text-[10px] text-t3">Utilised</p>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-t1">{branch.todayAppointments}</p>
                      <p className="text-[10px] text-t3">Today</p>
                    </div>
                    <div>
                      <p className={`text-sm font-bold ${branch.missedCalls > 10 ? 'text-red-v' : 'text-t1'}`}>{branch.missedCalls}</p>
                      <p className="text-[10px] text-t3">Missed calls</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Charts Row */}
          <div className="grid gap-4 lg:grid-cols-2">
            <BentoCard title="Provider Utilisation" subtitle="Capacity heatmap" headerRight={
              <span className="badge badge-emerald">Avg 72%</span>
            }>
              <UtilizationChart />
            </BentoCard>
            <BentoCard title="Revenue Performance" subtitle="Recovery & growth trends" headerRight={
              <span className="badge badge-violet">+18% campaign revenue</span>
            }>
              <RevenueChart />
            </BentoCard>
          </div>

          {/* Campaign ROI */}
          <BentoCard title="Active Campaign ROI" subtitle="Campaign performance" headerRight={
            <button type="button" onClick={() => navigate('/campaigner')} className="text-xs font-semibold text-indigo hover:opacity-75 flex items-center gap-1 transition-opacity">
              View all <ArrowRight className="w-3 h-3" />
            </button>
          }>
            <div className="space-y-3">
              {campaignRecords.slice(0, 3).map((c) => {
                const convRate = c.audienceSize > 0 ? Math.round((c.booked / c.audienceSize) * 100) : 0;
                return (
                  <div key={c.id} className="flex items-center gap-4 p-3 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-semibold text-t1 truncate">{c.name}</p>
                        <span className={`badge ${
                          c.status === 'active' ? 'badge-emerald' :
                          c.status === 'completed' ? 'badge-blue' :
                          'badge-amber'
                        }`}>{c.status}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-t3">
                        <span>{c.audienceSize} audience</span>
                        <span>·</span>
                        <span className="text-emerald-v font-medium">{convRate}% booked</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-t1">£{c.revenue.toLocaleString()}</p>
                      <p className="text-[10px] text-t3">Revenue</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </BentoCard>
        </div>

        {/* Right column */}
        <div className="space-y-4">

          {/* Owner's Priority List */}
          <BentoCard title="Owner's Priority List" subtitle="AI recommendation preview" headerRight={
            <span className="flex items-center gap-1 text-[10px] font-bold text-violet-v bg-[var(--violet-soft)] px-2 py-1 rounded-full">
              <Sparkles className="w-3 h-3" /> AI
            </span>
          }>
            <div className="space-y-2.5">
              {priorityActions.map((item) => (
                <div key={item.id} className={`rounded-xl p-3.5 cursor-pointer hover:opacity-90 transition-opacity ${urgencyClass[item.urgency]}`}>
                  <div className="flex items-start gap-2.5 mb-2">
                    <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${urgencyDot[item.urgency]}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-t1 leading-tight">{item.title}</p>
                      <p className="text-[11px] text-t3 mt-0.5 leading-relaxed">{item.description}</p>
                    </div>
                    {item.impact && (
                      <span className="badge badge-emerald shrink-0">{item.impact}</span>
                    )}
                  </div>
                  <button type="button" onClick={() => navigate(actionRoute[item.id] ?? '/autopilot')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--indigo)] text-white text-[11px] font-semibold hover:opacity-90 transition-opacity">
                    <Zap className="w-3 h-3" />
                    {item.action}
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* AI Growth Signals */}
          <BentoCard title="Key Growth Signals" subtitle="ClinicRadar AI · Preview" headerRight={
            <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-v bg-[var(--emerald-soft)] px-2 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--emerald)]" /> Live
            </span>
          }>
            <div className="space-y-2.5">
              {radarAlerts.slice(0, 4).map((alert) => (
                <InsightCard
                  key={alert.id}
                  title={alert.title}
                  description={alert.description}
                  impact={alert.estimatedValue ? `£${alert.estimatedValue.toLocaleString()}` : undefined}
                  variant={alert.severity === 'high' ? 'risk' : alert.category === 'revenue' ? 'opportunity' : 'info'}
                  action="Take action"
                  confidence={alert.severity === 'high' ? 88 : alert.severity === 'medium' ? 72 : 61}
                />
              ))}
              <button type="button" onClick={() => navigate('/clinic-radar')} className="w-full text-center text-xs font-semibold text-indigo py-2 border border-dashed border-[var(--indigo-mid)] rounded-xl hover:bg-[var(--indigo-soft)] transition-colors flex items-center justify-center gap-1.5">
                <BarChart3 className="w-3.5 h-3.5" />
                View all 15 signals in ClinicRadar AI
              </button>
            </div>
          </BentoCard>

          {/* Staff SLA */}
          <BentoCard title="Staff Response SLA" subtitle="Front desk performance">
            <div className="space-y-3">
              {[
                { name: 'Emily Watts', branch: 'Downtown', time: '1.8 min', score: 94, ok: true },
                { name: "Sarah O'Brien", branch: 'Northgate', time: '3.2 min', score: 78, ok: true },
                { name: 'Jake Williams', branch: 'Westside', time: '6.4 min', score: 49, ok: false },
                { name: 'Amara Osei', branch: 'Southbank', time: '4.7 min', score: 61, ok: true },
              ].map((s) => (
                <div key={s.name} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-[var(--indigo-soft)] border border-[var(--indigo-mid)] flex items-center justify-center text-[10px] font-bold text-indigo shrink-0">
                    {s.name.split(' ').map(n => n[0]).join('')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-xs font-semibold text-t1">{s.name}</p>
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3 h-3 text-t3" />
                        <span className={`text-xs font-bold ${s.ok ? 'text-t2' : 'text-red-v'}`}>{s.time}</span>
                      </div>
                    </div>
                    <ProgressBar value={s.score} />
                  </div>
                  <span className={`text-[11px] font-bold shrink-0 ${s.ok ? 'text-t3' : 'text-red-v'}`}>{s.score}</span>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
