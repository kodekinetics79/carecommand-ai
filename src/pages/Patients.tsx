import { useMemo, useState } from 'react';
import { Search, Users, AlertCircle, TrendingUp, Heart, Sparkles, ArrowRight, ShieldCheck, UserPlus, Filter } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { patients } from '../data/mockPatients';
import { branches } from '../data/mockClinics';
import { formatCurrency } from '../utils/formatters';

const lifecycleConfig: Record<string, { label: string; color: string; bg: string }> = {
  new:      { label: 'New',      color: 'text-blue-700',    bg: 'bg-blue-100' },
  active:   { label: 'Active',   color: 'text-emerald-700', bg: 'bg-emerald-100' },
  retained: { label: 'Retained', color: 'text-violet-700',  bg: 'bg-violet-100' },
  'at-risk':{ label: 'At Risk',  color: 'text-amber-700',   bg: 'bg-amber-100' },
  inactive: { label: 'Inactive', color: 'text-red-700',     bg: 'bg-red-100' },
};

const familyCount = patients.filter(p => p.familyAccountId).length;
const highRisk = patients.filter(p => p.churnRisk >= 60).length;
const activeCount = patients.filter(p => p.lifecycleStage === 'active' || p.lifecycleStage === 'retained').length;
const avgLTV = Math.round(patients.reduce((s, p) => s + p.lifetimeValue, 0) / patients.length);

const segments = [
  { label: 'High LTV (>£4,000)', count: patients.filter(p => p.lifetimeValue > 4000).length, color: 'emerald' as const },
  { label: 'At-risk churn', count: patients.filter(p => p.churnRisk >= 60).length, color: 'red' as const },
  { label: 'Inactive (90d+)', count: patients.filter(p => p.lifecycleStage === 'inactive').length, color: 'amber' as const },
  { label: 'Marketing consented', count: patients.filter(p => p.consentStatus.marketing).length, color: 'blue' as const },
  { label: 'Family accounts', count: familyCount, color: 'violet' as const },
];

export default function Patients() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeLifecycle, setActiveLifecycle] = useState<string>('all');

  const filtered = useMemo(() => {
    let list = patients;
    if (activeLifecycle !== 'all') list = list.filter(p => p.lifecycleStage === activeLifecycle);
    if (query) list = list.filter(p =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.phone.includes(query) ||
      p.email.toLowerCase().includes(query.toLowerCase())
    );
    return list;
  }, [query, activeLifecycle]);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Customer360"
        subtitle="Customer intelligence, lifecycle insights, consent-aware outreach, and LTV management."
        badge={`${highRisk} At Risk`}
        badgeColor="red"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition shadow-md shadow-blue-500/20">
            <UserPlus className="w-4 h-4" /> Add Customer
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Total Customers" value={patients.length} subtitle="All branches" icon={<Users className="w-4 h-4" />} accent="blue" />
        <StatCard title="Active & Retained" value={activeCount} subtitle="Engaged lifecycle" trend={4} icon={<Heart className="w-4 h-4" />} accent="emerald" />
        <StatCard title="At-Risk Churn" value={highRisk} subtitle="Score ≥60%" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Avg Lifetime Value" value={formatCurrency(avgLTV)} subtitle="Per customer" trend={6} icon={<TrendingUp className="w-4 h-4" />} accent="violet" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Main customer list */}
        <div className="space-y-4">
          {/* Search & filter */}
          <BentoCard title="Customer Records" subtitle="Search and filter all customers">
            {/* Lifecycle filter */}
            <div className="flex items-center gap-2 flex-wrap mb-4">
              {['all', 'new', 'active', 'retained', 'at-risk', 'inactive'].map((lc) => (
                <button
                  key={lc}
                  type="button"
                  onClick={() => setActiveLifecycle(lc)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all capitalize ${
                    activeLifecycle === lc
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {lc === 'all' ? 'All' : lifecycleConfig[lc]?.label ?? lc}
                  {lc !== 'all' && <span className="ml-1 opacity-70">({patients.filter(p => p.lifecycleStage === lc).length})</span>}
                </button>
              ))}
            </div>

            {/* Search */}
            <div className="relative mb-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                aria-label="Search customers by name, phone or email"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, phone or email…"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-4 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} title="Clear search" aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  <Filter className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Customer rows */}
            <div className="space-y-2">
              {filtered.slice(0, 15).map((patient) => {
                const lc = lifecycleConfig[patient.lifecycleStage];
                return (
                  <button
                    key={patient.id}
                    type="button"
                    onClick={() => navigate(`/patients/${patient.id}`)}
                    className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all hover:shadow-sm text-left ${
                      patient.churnRisk >= 60 ? 'border-red-100 hover:border-red-200' :
                      patient.lifecycleStage === 'inactive' ? 'border-amber-100 hover:border-amber-200' :
                      'border-slate-200 hover:border-blue-200'
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center text-slate-600 text-[10px] font-bold shrink-0">
                      {patient.name.split(' ').map(n => n[0]).join('')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-slate-900 truncate">{patient.name}</p>
                        {patient.familyAccountId && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 shrink-0">Family</span>}
                      </div>
                      <p className="text-[11px] text-slate-400 truncate">{patient.preferredChannel.toUpperCase()} · {patient.visitCount} visits · LTV {formatCurrency(patient.lifetimeValue)}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${lc?.bg} ${lc?.color}`}>{lc?.label}</span>
                      {patient.churnRisk >= 60 && <span className="text-[10px] font-bold text-red-600">{patient.churnRisk}% risk</span>}
                    </div>
                  </button>
                );
              })}
              {filtered.length > 15 && (
                <p className="text-xs text-slate-400 text-center py-2">{filtered.length - 15} more customers — refine search to filter</p>
              )}
              {filtered.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-6">No customers match your search.</p>
              )}
            </div>
          </BentoCard>
        </div>

        <div className="space-y-4">
          {/* Quick metrics */}
          <BentoCard title="Customer Intelligence" subtitle="Network-wide signals">
            <div className="space-y-3">
              {[
                { label: 'Preferred channel', value: 'WhatsApp', icon: <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> },
                { label: 'Marketing consent rate', value: '87%', icon: <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> },
                { label: 'Follow-up opportunities', value: '18 customers', icon: <Sparkles className="w-3.5 h-3.5 text-violet-500" /> },
                { label: 'Outstanding balances', value: formatCurrency(patients.reduce((s, p) => s + p.outstandingBalance, 0)), icon: <AlertCircle className="w-3.5 h-3.5 text-amber-500" /> },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-2">
                    {item.icon}
                    <p className="text-xs text-slate-600">{item.label}</p>
                  </div>
                  <p className="text-xs font-bold text-slate-900">{item.value}</p>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Segments */}
          <BentoCard title="Customer Segments" subtitle="AI-driven groups">
            <div className="space-y-2.5">
              {segments.map((seg) => (
                <div key={seg.label} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 transition-all">
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-slate-800 mb-1">{seg.label}</p>
                    <ProgressBar value={seg.count} max={patients.length} color={seg.color} size="xs" />
                  </div>
                  <span className="text-xs font-bold text-slate-700 shrink-0">{seg.count}</span>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Branch coverage */}
          <BentoCard title="Branch Coverage" subtitle="Customers per location">
            <div className="space-y-2.5">
              {branches.map((branch) => (
                <div key={branch.id} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                  <div>
                    <p className="text-xs font-bold text-slate-900">{branch.name.split(' ')[0]}</p>
                    <p className="text-[10px] text-slate-400">{branch.todayAppointments} appts today</p>
                  </div>
                  <span className="text-xs font-bold text-slate-700">{branch.patientCount}</span>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* AI outreach */}
          <div className="rounded-2xl bg-gradient-to-br from-violet-600 to-blue-600 p-4 text-white shadow-lg shadow-violet-500/20">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-violet-200" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-violet-200">AI Recommendation</p>
            </div>
            <p className="text-sm font-bold mb-1">18 customers ready for outreach</p>
            <p className="text-xs text-violet-200 mb-3">High-LTV customers with marketing consent who haven't been contacted in 60+ days.</p>
            <button type="button" className="w-full py-2 rounded-xl bg-white/20 hover:bg-white/30 text-white text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" /> Launch outreach campaign
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
