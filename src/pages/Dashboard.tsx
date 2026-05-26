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

const todayDate = '2025-05-26';
const todayAppts = appointments.filter(a => a.date === todayDate).length;
const activeCustomers = patients.filter(p => p.lifecycleStage === 'active' || p.lifecycleStage === 'retained').length;
const revenueRecovered = 27200;
const missedCallRecovery = 19;
const noShowRisk = appointments.filter(a => a.status === 'risky' || a.status === 'no-show').length;
const totalRevenue = branches.reduce((s, b) => s + b.revenue, 0);
const avgHealthScore = Math.round(branches.reduce((s, b) => s + b.healthScore, 0) / branches.length);

const priorityActions = [
  { id: 'p1', title: 'Run 90-day inactive customer campaign', description: '187 customers eligible. Historical conversion: 18%. Est. £18,700 in recoverable revenue.', impact: '£18,700', urgency: 'high' as const, action: 'Activate Winback Campaign', icon: <Users className="w-3.5 h-3.5" /> },
  { id: 'p2', title: 'Westside has 31 empty slots this week', description: 'At £200/slot, £6,200 is at risk. Recommend limited weekday offer for skin services.', impact: '£6,200', urgency: 'high' as const, action: 'Create Slot-Fill Campaign', icon: <CalendarDays className="w-3.5 h-3.5" /> },
  { id: 'p3', title: '23 missed calls still uncontacted', description: '42 calls this month. AI recovered 19. 23 remain — est. £3,450 in lost opportunity.', impact: '£3,450', urgency: 'medium' as const, action: 'Review Missed-Call Queue', icon: <Phone className="w-3.5 h-3.5" /> },
  { id: 'p4', title: 'Dr. Mitchell: high repeat rate, low reviews', description: '78% repeat-visit rate. Only 12 review requests sent vs 89 consultations. Est. 28 new reviews.', impact: 'Reputation', urgency: 'medium' as const, action: 'Launch Review Campaign', icon: <Star className="w-3.5 h-3.5" /> },
  { id: 'p5', title: '14 follow-up opportunities not yet rebooked', description: 'Post-service customers who haven\'t scheduled their next visit. Est. value: £4,800.', impact: '£4,800', urgency: 'low' as const, action: 'Assign Follow-Up Tasks', icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
];

const urgencyBorder = { high: 'border-l-red-500', medium: 'border-l-amber-500', low: 'border-l-emerald-500' };
const urgencyDot = { high: 'bg-red-500', medium: 'bg-amber-500', low: 'bg-emerald-500' };

function getHealthColor(score: number) {
  if (score >= 75) return { text: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' };
  if (score >= 55) return { text: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' };
  return { text: 'text-red-600', bg: 'bg-red-50 border-red-200' };
}

export default function Dashboard() {
  return (
    <div className="space-y-6 pb-8">
      {/* Page Header */}
      <PageHeader
        title="Command Center"
        subtitle="Growth cockpit for your multi-location clinic network · 26 May 2026"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 hover:opacity-95 transition">
            <Sparkles className="w-4 h-4" /> AI Briefing
          </button>
        }
      />

      {/* Hero Growth Briefing */}
      <div className="relative rounded-2xl overflow-hidden border border-blue-200/40 bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 p-6 shadow-xl">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(99,102,241,0.15),_transparent_60%)]" />
        <div className="relative flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-blue-400" />
              <p className="text-xs font-bold uppercase tracking-widest text-blue-400">Today's Growth Briefing</p>
            </div>
            <h2 className="text-xl font-bold text-white mb-1 leading-snug">
              £{(revenueRecovered / 1000).toFixed(0)}K recovered this month · £28,350 in active opportunities
            </h2>
            <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
              AI detected <span className="text-white font-medium">5 revenue signals</span> today. Westside has 31 empty slots at risk, 23 missed calls need follow-up, and your 90-day winback campaign can generate £18,700 this week.
            </p>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-2">
            <div className="text-right">
              <p className="text-2xl font-bold text-white tabular-nums">{formatCurrency(totalRevenue)}</p>
              <p className="text-xs text-slate-400">Network revenue this month</p>
            </div>
            <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors">
              View full report <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* KPI Strip — 6 stats */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard title="Network Revenue" value={formatCurrency(totalRevenue)} subtitle="This month" trend={12} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Revenue Recovered" value={formatCurrency(revenueRecovered)} subtitle="By automation" trend={23} icon={<DollarSign className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Today's Appointments" value={todayAppts} subtitle="Across all branches" icon={<CalendarDays className="w-4 h-4" />} accent="blue" />
        <StatCard title="Active Customers" value={activeCustomers} subtitle="Engaged base" trend={4} icon={<Users className="w-4 h-4" />} accent="violet" />
        <StatCard title="No-Show Risk" value={noShowRisk} subtitle="Flagged today" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Calls Recovered" value={`${missedCallRecovery}/42`} subtitle="AI follow-up rate" trend={48} icon={<Phone className="w-4 h-4" />} accent="cyan" />
      </div>

      {/* Main Bento Grid */}
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">

        {/* Left column */}
        <div className="space-y-4">

          {/* Branch Health Grid */}
          <BentoCard title="Branch Health Scores" subtitle="Live branch intelligence" headerRight={
            <span className="text-xs font-semibold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">Avg {avgHealthScore}/100</span>
          }>
            <div className="grid gap-3 sm:grid-cols-2">
              {branches.map((branch) => {
                const h = getHealthColor(branch.healthScore);
                return (
                  <div key={branch.id} className={`rounded-xl border p-4 ${h.bg}`}>
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div>
                        <p className="text-sm font-bold text-slate-900 leading-tight">{branch.name}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5">{branch.location}</p>
                      </div>
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${h.text} bg-white/80`}>{branch.healthScore}</span>
                    </div>
                    <div className="mb-3">
                      <ProgressBar value={branch.healthScore} color={branch.healthScore >= 75 ? 'emerald' : branch.healthScore >= 55 ? 'amber' : 'red'} />
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-sm font-bold text-slate-900">{branch.utilization}%</p>
                        <p className="text-[10px] text-slate-500">Utilised</p>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-900">{branch.todayAppointments}</p>
                        <p className="text-[10px] text-slate-500">Today</p>
                      </div>
                      <div>
                        <p className={`text-sm font-bold ${branch.missedCalls > 10 ? 'text-red-600' : 'text-slate-900'}`}>{branch.missedCalls}</p>
                        <p className="text-[10px] text-slate-500">Missed calls</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </BentoCard>

          {/* Charts Row */}
          <div className="grid gap-4 lg:grid-cols-2">
            <BentoCard title="Provider Utilisation" subtitle="Capacity heatmap" headerRight={
              <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">Avg 72%</span>
            }>
              <UtilizationChart />
            </BentoCard>
            <BentoCard title="Revenue Performance" subtitle="Recovery & growth trends" headerRight={
              <span className="text-xs font-semibold text-violet-700 bg-violet-50 border border-violet-200 px-2.5 py-1 rounded-full">+18% campaign revenue</span>
            }>
              <RevenueChart />
            </BentoCard>
          </div>

          {/* Campaign ROI */}
          <BentoCard title="Active Campaign ROI" subtitle="Campaign performance" headerRight={
            <button type="button" className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1">View all <ArrowRight className="w-3 h-3" /></button>
          }>
            <div className="space-y-3">
              {campaigns.slice(0, 3).map((c) => {
                const convRate = c.audienceSize > 0 ? Math.round((c.booked / c.audienceSize) * 100) : 0;
                return (
                  <div key={c.id} className="flex items-center gap-4 p-3 rounded-xl border border-slate-100 hover:border-slate-200 hover:bg-slate-50/50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-sm font-semibold text-slate-900 truncate">{c.name}</p>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          c.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                          c.status === 'completed' ? 'bg-slate-100 text-slate-600' :
                          'bg-amber-100 text-amber-700'
                        }`}>{c.status}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-slate-500">
                        <span>{c.audienceSize} audience</span>
                        <span>·</span>
                        <span className="text-emerald-600 font-medium">{convRate}% booked</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-slate-900">£{c.revenue.toLocaleString()}</p>
                      <p className="text-[10px] text-slate-400">Revenue</p>
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
          <BentoCard title="Owner's Priority List" subtitle="AI-recommended actions" headerRight={
            <span className="flex items-center gap-1 text-[10px] font-bold text-violet-600 bg-violet-50 px-2 py-1 rounded-full">
              <Sparkles className="w-3 h-3" /> AI
            </span>
          }>
            <div className="space-y-2.5">
              {priorityActions.map((item) => (
                <div key={item.id} className={`rounded-xl border border-slate-200 p-3.5 border-l-2 hover:shadow-sm transition-all cursor-pointer ${urgencyBorder[item.urgency]}`}>
                  <div className="flex items-start gap-2.5 mb-2">
                    <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${urgencyDot[item.urgency]}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-slate-900 leading-tight">{item.title}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{item.description}</p>
                    </div>
                    {item.impact && (
                      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full shrink-0 border border-emerald-100">{item.impact}</span>
                    )}
                  </div>
                  <button type="button" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-[11px] font-semibold hover:bg-blue-700 transition-colors">
                    <Zap className="w-3 h-3" />
                    {item.action}
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* AI Insights */}
          <BentoCard title="Key Growth Signals" subtitle="ClinicRadar AI · Live" headerRight={
            <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full animate-pulse-soft">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Live
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
              <button type="button" className="w-full text-center text-xs font-semibold text-blue-600 hover:text-blue-700 py-2 border border-dashed border-blue-200 rounded-xl hover:bg-blue-50 transition-colors flex items-center justify-center gap-1.5">
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
                { name: 'Sarah O\'Brien', branch: 'Northgate', time: '3.2 min', score: 78, ok: true },
                { name: 'Jake Williams', branch: 'Westside', time: '6.4 min', score: 49, ok: false },
                { name: 'Amara Osei', branch: 'Southbank', time: '4.7 min', score: 61, ok: true },
              ].map((s) => (
                <div key={s.name} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center text-[10px] font-bold text-slate-600 shrink-0">
                    {s.name.split(' ').map(n => n[0]).join('')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-xs font-semibold text-slate-900">{s.name}</p>
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3 h-3 text-slate-400" />
                        <span className={`text-xs font-bold ${s.ok ? 'text-slate-600' : 'text-red-600'}`}>{s.time}</span>
                      </div>
                    </div>
                    <ProgressBar value={s.score} />
                  </div>
                  <span className={`text-[11px] font-bold shrink-0 ${s.ok ? 'text-slate-500' : 'text-red-600'}`}>{s.score}</span>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
