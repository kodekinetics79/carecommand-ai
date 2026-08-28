import { useNavigate } from 'react-router-dom';
import { TrendingUp, DollarSign, Phone, Megaphone, AlertCircle, ArrowRight, Zap, BarChart3 } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import RevenueChart from '../components/charts/RevenueChart';
import BranchComparisonChart from '../components/charts/BranchComparisonChart';
import type { Appointment, Doctor } from '../types';
import { formatCurrency } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { mapAppointment, mapProviderProfile, mapRevenueSnapshot, type ApiAppointment, type ApiProviderProfile, type ApiRevenueSnapshot } from '../lib/apiAdapters';

const lostOpportunities = [
  { label: 'Missed calls — unrecovered', value: 3450, action: 'Launch follow-up' },
  { label: 'Empty slots — unfilled this week', value: 6200, action: 'Fill with slot campaign' },
  { label: 'Inactive customers — no outreach', value: 18700, action: 'Run winback campaign' },
  { label: 'Unpaid invoices >30 days', value: 1150, action: 'Send payment reminder' },
];

type BarColor = 'blue' | 'violet' | 'emerald' | 'red' | 'teal';
interface BranchOption { id: string; name: string }

type RevenueRow = ReturnType<typeof mapRevenueSnapshot>;

export default function Revenue() {
  const navigate = useNavigate();
  const { data: revenueRecords, source: revenueSource, error: revenueError } = useApiResource<ApiRevenueSnapshot, RevenueRow>('/v1/revenue-snapshots?limit=100', [], mapRevenueSnapshot);
  const { data: branchOptions, source: branchSource } = useApiResource<BranchOption, BranchOption>('/v1/branches?limit=100', [], row => row);
  const { data: providerRecords, source: providerSource } = useApiResource<ApiProviderProfile, Doctor>('/v1/providers/overview?limit=100', [], mapProviderProfile);
  const { data: appointmentRecords, source: appointmentSource } = useApiResource<ApiAppointment, Appointment>('/v1/appointments?limit=100', [], mapAppointment);
  const loadError = revenueError;
  const liveReady = revenueSource === 'live' && branchSource === 'live' && providerSource === 'live' && appointmentSource === 'live';

  function exportReport() {
    const header = ['Month', 'Revenue', 'Campaigns', 'Recovered', 'Lost'];
    const lines = revenueRecords.map(r => [r.month, r.revenue, r.campaigns, r.recovered, r.lost].join(','));
    const csv = [header.join(','), ...lines].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `revenue-report-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
  const latest = revenueRecords[0] ?? null;
  const prev = revenueRecords[1] ?? latest;
  const revGrowth = latest && prev && prev.revenue > 0 ? Math.round(((latest.revenue - prev.revenue) / prev.revenue) * 100) : 0;
  const recoveredGrowth = latest && prev && prev.recovered > 0 ? Math.round(((latest.recovered - prev.recovered) / prev.recovered) * 100) : 0;
  const branchRevenue = branchOptions.map(branch => {
    const branchProviders = providerRecords.filter(provider => provider.branchId === branch.id);
    const revenue = Math.round(branchProviders.reduce((sum, provider) => sum + provider.revenueThisMonth, 0));
    return { name: branch.name, revenue };
  }).filter(branch => branch.revenue > 0);
  const totalBranchRevenue = branchRevenue.reduce((sum, branch) => sum + branch.revenue, 0);
  const serviceRevenue = appointmentRecords.reduce((acc, appointment) => {
    const key = appointment.service || 'Uncategorized';
    const current = acc.get(key) ?? 0;
    acc.set(key, current + appointment.value);
    return acc;
  }, new Map<string, number>());
  const serviceRows = Array.from(serviceRevenue.entries())
    .map(([service, revenue]) => ({ service, revenue }))
    .sort((a, b) => b.revenue - a.revenue);
  const waterfall: { label: string; value: number; color: BarColor; positive: boolean }[] = [
    { label: 'Gross Revenue', value: latest?.revenue ?? 0, color: 'blue', positive: true },
    { label: '+ Campaign Revenue', value: latest?.campaigns ?? 0, color: 'violet', positive: true },
    { label: '+ Automation Recovery', value: latest?.recovered ?? 0, color: 'emerald', positive: true },
    { label: '− Lost Opportunities', value: latest?.lost ?? 0, color: 'red', positive: false },
    { label: 'Net Revenue', value: (latest?.revenue ?? 0) + (latest?.campaigns ?? 0) + (latest?.recovered ?? 0) - (latest?.lost ?? 0), color: 'teal', positive: true },
  ];
  const maxWaterfall = Math.max(...waterfall.map(item => Math.abs(item.value)), 1);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="RevenuePulse"
        subtitle="CFO-level revenue intelligence — recovery, attribution, branch mix, and live opportunity tracking."
        badge={loadError ? 'Live Data Error' : liveReady ? 'Live DB' : 'Loading'}
        badgeColor={loadError ? 'red' : liveReady ? 'emerald' : 'blue'}
        actions={
          <div className="flex gap-2">
            <button type="button" onClick={exportReport} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] transition">
              <BarChart3 className="w-4 h-4" /> Export Report
            </button>
            <button type="button" onClick={() => navigate('/opportunities')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
              <Zap className="w-4 h-4" /> Recover Lost Revenue
            </button>
          </div>
        }
      />

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Revenue data could not be loaded from the live API: {loadError}
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard title="Monthly Revenue" value={formatCurrency(latest?.revenue ?? 0)} subtitle="This month" trend={revGrowth} icon={<TrendingUp className="w-4 h-4" />} accent="blue" />
        <StatCard title="Revenue Recovered" value={formatCurrency(latest?.recovered ?? 0)} subtitle="By automation" trend={recoveredGrowth} icon={<DollarSign className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Campaign Attribution" value={formatCurrency(latest?.campaigns ?? 0)} subtitle="This month" trend={18} icon={<Megaphone className="w-4 h-4" />} accent="violet" />
        <StatCard title="Missed-Call Recovery" value={formatCurrency(3840)} subtitle="Follow-up this month" trend={48} icon={<Phone className="w-4 h-4" />} accent="cyan" />
        <StatCard title="Lost Opportunities" value={formatCurrency(latest?.lost ?? 0)} subtitle="This month" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Recovery Rate" value="72%" subtitle="Of identified opportunities" trend={5} icon={<TrendingUp className="w-4 h-4" />} accent="amber" />
      </div>

      {/* Charts row */}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
        <BentoCard title="Revenue Performance" subtitle="6-month recovery & growth trend" headerRight={
          <span className="badge badge-violet">{revenueRecords.length ? '+ live revenue snapshots' : 'No snapshots yet'}</span>
        }>
          <RevenueChart data={revenueRecords} />
        </BentoCard>

        {/* Revenue waterfall */}
        <BentoCard title="Revenue Waterfall" subtitle="This month breakdown">
          <div className="space-y-2.5">
            {waterfall.map((w) => {
              const pct = Math.round((Math.abs(w.value) / maxWaterfall) * 100);
              return (
                <div key={w.label}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-xs font-medium text-t2">{w.label}</p>
                    <p className={`text-xs font-bold ${w.positive ? 'text-t1' : 'text-red-v'}`}>
                      {w.positive ? '' : '−'}{formatCurrency(Math.abs(w.value))}
                    </p>
                  </div>
                  <ProgressBar value={pct} color={w.color} size="md" />
                </div>
              );
            })}
          </div>
        </BentoCard>
      </div>

      {/* Branch comparison + Service breakdown */}
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <BentoCard title="Branch Revenue Mix" subtitle="Live provider revenue by branch" headerRight={
          <span className="text-xs font-semibold text-t3">{formatCurrency(totalBranchRevenue)} total</span>
        }>
          <BranchComparisonChart data={branchRevenue} />
          <div className="mt-4 space-y-3">
            {branchRevenue.length === 0 ? (
              <p className="text-xs text-t3 py-2">No live branch revenue data returned yet.</p>
            ) : branchRevenue.map((branch) => {
              const share = totalBranchRevenue > 0 ? Math.round((branch.revenue / totalBranchRevenue) * 100) : 0;
              return (
                <div key={branch.name}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-xs font-semibold text-t1">{branch.name}</p>
                    <div className="text-right">
                      <span className="text-xs font-bold text-t1">{formatCurrency(branch.revenue)}</span>
                      <span className="text-[10px] text-t3 ml-1">{share}% of branch revenue</span>
                    </div>
                  </div>
                  <ProgressBar value={share} />
                </div>
              );
            })}
          </div>
        </BentoCard>

        <div className="space-y-4">
          {/* Service category revenue */}
          <BentoCard title="Service Category Revenue" subtitle="Live appointment value by service">
            <div className="space-y-3">
              {serviceRows.length === 0 ? (
                <p className="text-xs text-t3 py-2">No live appointment revenue is available to break down by service.</p>
              ) : (() => {
                const totalServiceRevenue = serviceRows.reduce((sum, service) => sum + service.revenue, 0);
                return serviceRows.map((s) => {
                  const share = totalServiceRevenue > 0 ? Math.round((s.revenue / totalServiceRevenue) * 100) : 0;
                  return (
                    <div key={s.service}>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <p className="text-xs font-semibold text-t1 truncate">{s.service}</p>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] text-t3">{share}%</span>
                          <span className="text-xs font-bold text-t1">{formatCurrency(s.revenue)}</span>
                        </div>
                      </div>
                      <ProgressBar value={share} />
                    </div>
                  );
                });
              })()}
            </div>
          </BentoCard>

          {/* Lost opportunity tracker */}
          <BentoCard title="Lost Opportunity Tracker" subtitle="Recoverable revenue" headerRight={
            <span className="badge badge-red">
              {formatCurrency(lostOpportunities.reduce((s, o) => s + o.value, 0))} at risk
            </span>
          }>
            <div className="space-y-2.5">
              {lostOpportunities.map((opp) => (
                <div key={opp.label} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-t1">{opp.label}</p>
                    <p className="text-xs font-bold text-red-v">{formatCurrency(opp.value)}</p>
                  </div>
                  <button type="button" onClick={() => navigate('/opportunities')} className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2.5 py-1.5 rounded-lg hover:opacity-80 transition-colors">
                    <Zap className="w-3 h-3" />
                    {opp.action}
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>

      {/* Monthly trend table */}
      <BentoCard title="Monthly Revenue Trend" subtitle="6-month history">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--b1)]">
                {['Month', 'Revenue', 'Recovered', 'Campaign', 'Lost', 'Net'].map(h => (
                  <th key={h} className="text-left py-2 px-3 text-[10px] font-bold uppercase tracking-widest text-t3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--b0)]">
              {revenueRecords.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 px-3 text-center text-xs text-t3">No live revenue snapshots returned for this clinic.</td>
                </tr>
              ) : revenueRecords.map((row) => (
                <tr key={row.month} className="hover:bg-[var(--s3)] transition-colors">
                  <td className="py-2.5 px-3 text-xs font-semibold text-t2">{row.month}</td>
                  <td className="py-2.5 px-3 text-xs font-bold text-t1">{formatCurrency(row.revenue)}</td>
                  <td className="py-2.5 px-3 text-xs font-semibold text-emerald-v">+{formatCurrency(row.recovered)}</td>
                  <td className="py-2.5 px-3 text-xs font-semibold text-violet-v">+{formatCurrency(row.campaigns)}</td>
                  <td className="py-2.5 px-3 text-xs font-semibold text-red-v">−{formatCurrency(row.lost)}</td>
                  <td className="py-2.5 px-3 text-xs font-bold text-t1">{formatCurrency(row.revenue + row.campaigns + row.recovered - row.lost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </BentoCard>

      {/* Revenue Action Plan */}
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-5">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-[var(--indigo-soft)] flex items-center justify-center shrink-0">
            <TrendingUp className="w-5 h-5 text-indigo" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-bold uppercase tracking-widest text-blue-v mb-1">Revenue Action Plan</p>
            <p className="text-t1 font-semibold leading-relaxed mb-3">
              Your network recovered {formatCurrency(27200)} through automation this month — up 12% vs last month.
              The biggest untapped opportunity is {formatCurrency(18700)} from inactive customers who haven't been contacted.
              Running a winback campaign today could convert 34 bookings within 14 days.
            </p>
            <button type="button" onClick={() => navigate('/campaigner')} className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo hover:opacity-80 transition-colors">
              Launch winback campaign <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
