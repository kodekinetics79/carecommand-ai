import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { TrendingUp, DollarSign, ShieldCheck, Megaphone, AlertCircle, ArrowRight, Zap, BarChart3 } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import RevenueChart from '../components/charts/RevenueChart';
import BranchComparisonChart from '../components/charts/BranchComparisonChart';
import type { Appointment, Doctor } from '../types';
import { formatCurrency } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { apiRequest } from '../lib/api';
import { mapAppointment, mapProviderProfile, mapRevenueSnapshot, type ApiAppointment, type ApiProviderProfile, type ApiRevenueSnapshot } from '../lib/apiAdapters';

// Genuine revenue-protection aggregates from the DB (server computes these from real
// transactions/deposits/alerts). Used to drive the money tiles honestly.
interface RevenueProtectionSummary {
  revenueProtected: number;
  depositsCollected: number;
  unpaidBalances: number;
  revenueAtRisk: number;
  failedPayments: number;
}

type BarColor = 'blue' | 'violet' | 'emerald' | 'red' | 'teal';
interface BranchOption { id: string; name: string }

type RevenueRow = ReturnType<typeof mapRevenueSnapshot>;

export default function Revenue() {
  const navigate = useNavigate();
  const { data: revenueRecords, source: revenueSource, error: revenueError } = useApiResource<ApiRevenueSnapshot, RevenueRow>('/v1/revenue-snapshots?limit=100', [], mapRevenueSnapshot);
  const { data: branchOptions, source: branchSource, error: branchError } = useApiResource<BranchOption, BranchOption>('/v1/branches?limit=100', [], row => row);
  const { data: providerRecords, source: providerSource, error: providerError } = useApiResource<ApiProviderProfile, Doctor>('/v1/providers/overview?limit=100', [], mapProviderProfile);
  const { data: appointmentRecords, source: appointmentSource, error: appointmentError } = useApiResource<ApiAppointment, Appointment>('/v1/appointments?limit=100', [], mapAppointment);

  // Genuine DB-computed revenue-protection money aggregates (single object, not a list).
  const [rpSummary, setRpSummary] = useState<RevenueProtectionSummary | null>(null);
  const [rpLive, setRpLive] = useState(false);
  const [rpError, setRpError] = useState(false);
  useEffect(() => {
    let active = true;
    apiRequest<{ summary: RevenueProtectionSummary }>('/v1/revenue-protection/overview')
      .then(res => { if (!active) return; setRpSummary(res.summary); setRpLive(true); setRpError(false); })
      .catch(() => { if (!active) return; setRpSummary(null); setRpLive(false); setRpError(true); });
    return () => { active = false; };
  }, []);

  const loadError = revenueError || branchError || providerError || appointmentError || (rpError ? 'Unable to load revenue-protection totals' : null);
  // Report a complete load only when BOTH the snapshot feeds and the recorded-money
  // aggregates loaded successfully. Otherwise, keep the headline status in loading.
  const liveReady = revenueSource === 'live' && branchSource === 'live' && providerSource === 'live' && appointmentSource === 'live' && rpLive;
  const snapshotReady = revenueSource === 'live' && !revenueError;
  const branchReady = branchSource === 'live' && providerSource === 'live' && !branchError && !providerError;
  const appointmentReady = appointmentSource === 'live' && !appointmentError;

  function exportReport() {
    const header = ['Month', 'Revenue', 'Campaign-associated value', 'Other associated value', 'Recorded lost-opportunity value'];
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
  const liveLostOpportunities = [
    { label: 'Open unpaid balances', value: rpSummary?.unpaidBalances ?? 0, action: 'Review payment requests', route: '/revenue-protection' },
    { label: 'Revenue in open protection alerts', value: rpSummary?.revenueAtRisk ?? 0, action: 'Review alerts', route: '/revenue-protection' },
    { label: 'Lost opportunities in latest snapshot', value: latest?.lost ?? 0, action: 'Open opportunity center', route: '/opportunities' },
  ].filter(opportunity => opportunity.value > 0);
  const waterfall: { label: string; value: number; color: BarColor; positive: boolean }[] = [
    { label: 'Recorded revenue', value: latest?.revenue ?? 0, color: 'blue', positive: true },
    { label: '+ Campaign-associated field', value: latest?.campaigns ?? 0, color: 'violet', positive: true },
    { label: '+ Other associated-value field', value: latest?.recovered ?? 0, color: 'emerald', positive: true },
    { label: '− Recorded lost-opportunity value', value: latest?.lost ?? 0, color: 'red', positive: false },
    { label: 'Calculated total', value: (latest?.revenue ?? 0) + (latest?.campaigns ?? 0) + (latest?.recovered ?? 0) - (latest?.lost ?? 0), color: 'teal', positive: true },
  ];
  const maxWaterfall = Math.max(...waterfall.map(item => Math.abs(item.value)), 1);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="RevenuePulse"
        subtitle="Recorded revenue, associated-value fields, branch mix, and opportunity review. Values do not establish causal attribution."
        badge={loadError ? 'Data unavailable' : liveReady ? 'All data sources loaded' : 'Loading'}
        badgeColor={loadError ? 'red' : liveReady ? 'emerald' : 'blue'}
        actions={
          <div className="flex gap-2">
            <button type="button" onClick={exportReport} disabled={!snapshotReady} title={!snapshotReady ? 'Revenue snapshots are unavailable' : undefined} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] transition disabled:cursor-not-allowed disabled:opacity-50">
              <BarChart3 className="w-4 h-4" /> Export Report
            </button>
            <button type="button" onClick={() => navigate('/opportunities')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
              <Zap className="w-4 h-4" /> Open opportunities
            </button>
          </div>
        }
      />

      {loadError && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Some revenue sources are unavailable: {loadError}. Unavailable metrics are shown as —; do not interpret them as zero or as a healthy state.
        </div>
      )}

      {/* KPI Strip — money tiles are wired to real DB aggregates (revenue-protection
          /overview); snapshot tiles come from live revenue snapshots. No hardcoded money. */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard title="Monthly Revenue" value={snapshotReady && latest ? formatCurrency(latest.revenue) : '—'} subtitle={snapshotReady ? 'Latest stored snapshot' : 'Unavailable'} trend={snapshotReady && latest && prev ? revGrowth : undefined} icon={<TrendingUp className="w-4 h-4" />} accent="blue" />
        <StatCard title="Net Recorded Collections" value={rpLive && rpSummary ? formatCurrency(rpSummary.revenueProtected) : '—'} subtitle={rpLive ? 'Transactions plus manual deposits' : 'Unavailable'} icon={<ShieldCheck className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Recorded deposits" value={rpLive && rpSummary ? formatCurrency(rpSummary.depositsCollected) : '—'} subtitle={rpLive ? 'Checkout and staff records' : 'Unavailable'} icon={<DollarSign className="w-4 h-4" />} accent="violet" />
        <StatCard title="Open payment requests" value={rpLive && rpSummary ? formatCurrency(rpSummary.unpaidBalances) : '—'} subtitle={rpLive ? 'Recorded request amounts' : 'Unavailable'} icon={<Megaphone className="w-4 h-4" />} accent="cyan" />
        <StatCard title="Value in open alerts" value={rpLive && rpSummary ? formatCurrency(rpSummary.revenueAtRisk) : '—'} subtitle={rpLive ? 'Recorded protection-alert values' : 'Unavailable'} icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Failed payment requests" value={rpLive && rpSummary ? String(rpSummary.failedPayments) : '—'} subtitle={rpLive ? 'Recorded items needing follow-up' : 'Unavailable'} icon={<TrendingUp className="w-4 h-4" />} accent="amber" />
      </div>

      {/* Charts row */}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
        <BentoCard title="Revenue snapshot trend" subtitle="Six-month revenue and associated-value fields" headerRight={
          <span className="badge badge-violet">{snapshotReady ? 'Stored revenue snapshots' : 'Unavailable'}</span>
        }>
          <RevenueChart data={revenueRecords} />
        </BentoCard>

        {/* Revenue waterfall */}
        <BentoCard title="Recorded-value calculation" subtitle="Latest snapshot fields; not an attribution or reconciliation report">
          <div className="space-y-2.5">
            {snapshotReady && <p className="text-[11px] text-t3">The calculated total combines stored fields. It does not prove that campaigns or automation caused revenue, or that amounts were financially reconciled.</p>}
            {!snapshotReady ? <p className="text-xs text-t3 py-2">Revenue snapshot data is unavailable.</p> : waterfall.map((w) => {
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
        <BentoCard title="Branch Revenue Mix" subtitle="Recorded provider revenue by branch" headerRight={
          <span className="text-xs font-semibold text-t3">{branchReady ? `${formatCurrency(totalBranchRevenue)} total` : 'Unavailable'}</span>
        }>
          <BranchComparisonChart data={branchRevenue} />
          <div className="mt-4 space-y-3">
            {!branchReady ? (
              <p className="text-xs text-t3 py-2">Branch revenue data is unavailable.</p>
            ) : branchRevenue.length === 0 ? (
              <p className="text-xs text-t3 py-2">No branch revenue records are available yet.</p>
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
          <BentoCard title="Service Category Revenue" subtitle="Recorded appointment value by service">
            <div className="space-y-3">
              {!appointmentReady ? (
                <p className="text-xs text-t3 py-2">Appointment-value data is unavailable.</p>
              ) : serviceRows.length === 0 ? (
                <p className="text-xs text-t3 py-2">No recorded appointment value is available to break down by service.</p>
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

          <BentoCard title="Lost Opportunity Tracker" subtitle="Stored protection and snapshot figures" headerRight={
            <span className="badge badge-emerald">Stored records</span>
          }>
            <div className="space-y-2.5">
              {(!rpLive || !snapshotReady) ? <p className="text-xs text-t3 py-2">Opportunity totals are unavailable.</p> : liveLostOpportunities.length === 0 && <p className="text-xs text-t3 py-2">No lost-revenue opportunities are currently recorded.</p>}
              {rpLive && snapshotReady && liveLostOpportunities.map((opp) => (
                <div key={opp.label} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-t1">{opp.label}</p>
                    <p className="text-xs font-bold text-red-v">{formatCurrency(opp.value)}</p>
                  </div>
                  <button type="button" onClick={() => navigate(opp.route)} className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2.5 py-1.5 rounded-lg hover:opacity-80 transition-colors">
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
                {['Month', 'Revenue', 'Associated value', 'Campaign-associated', 'Lost-opportunity value', 'Calculated total'].map(h => (
                  <th key={h} className="text-left py-2 px-3 text-[10px] font-bold uppercase tracking-widest text-t3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--b0)]">
              {!snapshotReady ? (
                <tr>
                  <td colSpan={6} className="py-6 px-3 text-center text-xs text-t3">Revenue snapshot data is unavailable.</td>
                </tr>
              ) : revenueRecords.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 px-3 text-center text-xs text-t3">No revenue snapshots are available for this clinic.</td>
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
            <div className="flex items-center gap-2 mb-1">
              <p className="text-xs font-bold uppercase tracking-widest text-blue-v">Revenue Action Plan</p>
              <span className="badge badge-amber">Illustrative example</span>
            </div>
            <p className="text-t1 font-semibold leading-relaxed mb-3">
              Example scenario (not current clinic figures): a network may record additional associated value after operational follow-up and an approved outreach campaign.
              This is not a forecast or causal attribution. Define the measurement period and validate every assumption with finance before using it for planning.
            </p>
            <button type="button" onClick={() => navigate('/campaigner')} className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo hover:opacity-80 transition-colors">
              Review campaign setup <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
