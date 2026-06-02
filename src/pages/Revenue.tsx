import { TrendingUp, DollarSign, Phone, Megaphone, AlertCircle, ArrowRight, Zap, BarChart3 } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import RevenueChart from '../components/charts/RevenueChart';
import BranchComparisonChart from '../components/charts/BranchComparisonChart';
import { revenueData, branchRevenue, serviceRevenue } from '../data/mockRevenue';
import { formatCurrency } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { mapRevenueSnapshot, type ApiRevenueSnapshot } from '../lib/apiAdapters';

const lostOpportunities = [
  { label: 'Missed calls — unrecovered', value: 3450, action: 'Launch AI follow-up' },
  { label: 'Empty slots — unfilled this week', value: 6200, action: 'Fill with slot campaign' },
  { label: 'Inactive customers — no outreach', value: 18700, action: 'Run winback campaign' },
  { label: 'Unpaid invoices >30 days', value: 1150, action: 'Send payment reminder' },
];

type BarColor = 'blue' | 'violet' | 'emerald' | 'red' | 'teal';
const revenueFallback = revenueData.map((row, index) => ({ ...row, id: `demo-revenue-${index}` })).reverse();

export default function Revenue() {
  const { data: revenueRecords, source } = useApiResource<ApiRevenueSnapshot, typeof revenueFallback[number]>('/v1/revenue-snapshots?limit=100', revenueFallback, mapRevenueSnapshot);
  const latest = revenueRecords[0] ?? revenueRecords[revenueRecords.length - 1] ?? revenueFallback.at(-1)!;
  const prev = revenueRecords[1] ?? revenueRecords[revenueRecords.length - 2] ?? latest;
  const revGrowth = prev.revenue > 0 ? Math.round(((latest.revenue - prev.revenue) / prev.revenue) * 100) : 0;
  const recoveredGrowth = prev.recovered > 0 ? Math.round(((latest.recovered - prev.recovered) / prev.recovered) * 100) : 0;
  const waterfall: { label: string; value: number; color: BarColor; positive: boolean }[] = [
    { label: 'Gross Revenue', value: latest.revenue, color: 'blue', positive: true },
    { label: '+ Campaign Revenue', value: latest.campaigns, color: 'violet', positive: true },
    { label: '+ Automation Recovery', value: latest.recovered, color: 'emerald', positive: true },
    { label: '− Lost Opportunities', value: latest.lost, color: 'red', positive: false },
    { label: 'Net Revenue', value: latest.revenue + latest.campaigns + latest.recovered - latest.lost, color: 'teal', positive: true },
  ];
  const maxWaterfall = Math.max(...waterfall.map(item => Math.abs(item.value)));

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="RevenuePulse"
        subtitle="CFO-level revenue intelligence — recovery, attribution, branch comparison, and lost opportunity tracking."
        badge={source === 'live' ? 'Live DB' : 'Demo'}
        badgeColor={source === 'live' ? 'emerald' : 'blue'}
        actions={
          <div className="flex gap-2">
            <button type="button" className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] transition">
              <BarChart3 className="w-4 h-4" /> Export Report
            </button>
            <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
              <Zap className="w-4 h-4" /> Recover Lost Revenue
            </button>
          </div>
        }
      />

      {/* KPI Strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard title="Monthly Revenue" value={formatCurrency(latest.revenue)} subtitle="This month" trend={revGrowth} icon={<TrendingUp className="w-4 h-4" />} accent="blue" />
        <StatCard title="Revenue Recovered" value={formatCurrency(latest.recovered)} subtitle="By automation" trend={recoveredGrowth} icon={<DollarSign className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Campaign Attribution" value={formatCurrency(latest.campaigns)} subtitle="This month" trend={18} icon={<Megaphone className="w-4 h-4" />} accent="violet" />
        <StatCard title="Missed-Call Recovery" value="£3,840" subtitle="AI follow-up this month" trend={48} icon={<Phone className="w-4 h-4" />} accent="cyan" />
        <StatCard title="Lost Opportunities" value={formatCurrency(latest.lost)} subtitle="This month" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Recovery Rate" value="72%" subtitle="Of identified opportunities" trend={5} icon={<TrendingUp className="w-4 h-4" />} accent="amber" />
      </div>

      {/* Charts row */}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
        <BentoCard title="Revenue Performance" subtitle="6-month recovery & growth trend" headerRight={
          <span className="badge badge-violet">+18% campaign revenue</span>
        }>
          <RevenueChart />
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
        <BentoCard title="Branch Revenue Comparison" subtitle="vs target this month" headerRight={
          <span className="text-xs font-semibold text-t3">{formatCurrency(branchRevenue.reduce((s, b) => s + b.revenue, 0))} total</span>
        }>
          <BranchComparisonChart />
          <div className="mt-4 space-y-3">
            {branchRevenue.map((b) => {
              const pct = Math.round((b.revenue / b.target) * 100);
              const growth = Math.round(((b.revenue - b.lastMonth) / b.lastMonth) * 100);
              return (
                <div key={b.name}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold text-t1">{b.name}</p>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${growth >= 0 ? 'text-emerald-v bg-[var(--emerald-soft)]' : 'text-red-v bg-[var(--red-soft)]'}`}>
                        {growth >= 0 ? '+' : ''}{growth}%
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs font-bold text-t1">{formatCurrency(b.revenue)}</span>
                      <span className="text-[10px] text-t3 ml-1">/ {formatCurrency(b.target)} target</span>
                    </div>
                  </div>
                  <ProgressBar value={b.revenue} max={b.target} color={pct >= 90 ? 'emerald' : pct >= 70 ? 'amber' : 'red'} />
                </div>
              );
            })}
          </div>
        </BentoCard>

        <div className="space-y-4">
          {/* Service category revenue */}
          <BentoCard title="Service Category Revenue" subtitle="This month breakdown">
            <div className="space-y-3">
              {serviceRevenue.map((s) => (
                <div key={s.service}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-xs font-semibold text-t1 truncate">{s.service}</p>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-t3">{s.percent}%</span>
                      <span className="text-xs font-bold text-t1">{formatCurrency(s.revenue)}</span>
                    </div>
                  </div>
                  <ProgressBar value={s.percent} />
                </div>
              ))}
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
                  <button type="button" className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2.5 py-1.5 rounded-lg hover:opacity-80 transition-colors">
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
              {revenueRecords.map((row) => (
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

      {/* AI Revenue Summary */}
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-5">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-[var(--indigo-soft)] flex items-center justify-center shrink-0">
            <TrendingUp className="w-5 h-5 text-indigo" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-bold uppercase tracking-widest text-blue-v mb-1">AI Revenue Insight</p>
            <p className="text-t1 font-semibold leading-relaxed mb-3">
              Your network recovered £27,200 through automation this month — up 12% vs last month.
              The biggest untapped opportunity is £18,700 from inactive customers who haven't been contacted.
              Running a winback campaign today could convert 34 bookings within 14 days.
            </p>
            <button type="button" className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo hover:opacity-80 transition-colors">
              Launch winback campaign <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
