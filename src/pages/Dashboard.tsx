import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp, DollarSign, CalendarDays, Users, AlertCircle, Phone,
  Coins, Globe, Sparkles, Gauge, BarChart3, LineChart,
} from 'lucide-react';
import { usePreferences, CURRENCIES, LANGUAGES } from '../lib/preferences';
import BentoCard from '../components/ui/BentoCard';
import SkeletonPanel from '../components/ui/SkeletonPanel';
import PremiumMetricCard from '../components/dashboard/PremiumMetricCard';
import AIBriefingCard from '../components/dashboard/AIBriefingCard';
import PriorityActionRail from '../components/dashboard/PriorityActionRail';
import ActionDrawer from '../components/dashboard/ActionDrawer';
import BranchHealthCard from '../components/dashboard/BranchHealthCard';
import CampaignROIPanel from '../components/dashboard/CampaignROIPanel';
import { formatCurrency } from '../utils/formatters';
import {
  dashboardService,
  type DashboardSummary, type BranchHealth, type ProviderUtilization, type CampaignROI, type PriorityAction,
} from '../lib/dashboardService';

// Charts / heavy panels are code-split so they don't bloat the route bundle.
const ProviderUtilizationPanel = lazy(() => import('../components/dashboard/ProviderUtilizationPanel'));
const RevenueChart = lazy(() => import('../components/charts/RevenueChart'));

export default function Dashboard() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [branches, setBranches] = useState<BranchHealth[]>([]);
  const [providers, setProviders] = useState<ProviderUtilization[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignROI[]>([]);
  const [actions, setActions] = useState<PriorityAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionsLoading, setActionsLoading] = useState(true);
  const [drawerAction, setDrawerAction] = useState<PriorityAction | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [s, b, p, c] = await Promise.all([
        dashboardService.getSummary().catch(() => null),
        dashboardService.getBranchHealth().catch(() => []),
        dashboardService.getProviderUtilization().catch(() => []),
        dashboardService.getCampaignROI().catch(() => []),
      ]);
      if (!active) return;
      setSummary(s); setBranches(b); setProviders(p); setCampaigns(c); setLoading(false);
    })();
    void (async () => {
      const a = await dashboardService.getPriorityActions().catch(() => []);
      if (active) { setActions(a); setActionsLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  const reportDate = summary ? new Date(summary.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const avgHealth = branches.length ? Math.round(branches.reduce((s, b) => s + b.healthScore, 0) / branches.length) : 0;
  const openCta = (a: PriorityAction) => navigate(a.cta.route);

  return (
    <div className="space-y-4 pb-4 animate-fade-up">
      {/* Slim toolbar — the topbar carries the page title; this row holds context + actions. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-t3">{reportDate ? `Network overview · updated ${reportDate}` : 'Network overview'}</p>
        <div className="flex flex-wrap items-center gap-2">
          <CurrencyLanguagePicker />
          <button type="button" onClick={() => navigate('/opportunities')} className="inline-flex items-center gap-2 rounded-lg border border-[var(--b1)] bg-white px-3.5 py-2 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition">
            <AlertCircle className="w-4 h-4 text-t3" /> Revenue Leaks
          </button>
          <button type="button" onClick={() => navigate('/campaigner')} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition">
            <Sparkles className="w-4 h-4" /> Launch Campaign
          </button>
        </div>
      </div>

      {/* PRIMARY OBJECT — AI Briefing */}
      {summary ? (
        <AIBriefingCard summary={summary} onAskAdvisors={() => navigate('/advisory')} onViewReport={() => navigate('/revenue')} />
      ) : (
        <div className="skeleton-line h-44 rounded-2xl" />
      )}

      {/* KPIs — 3 primary + 4 secondary, compact for single-screen density */}
      {loading || !summary ? (
        <div className="grid gap-2.5 grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="skeleton-line h-24 rounded-xl" />)}</div>
      ) : (
        <div className="space-y-2.5">
          <div className="grid gap-2.5 grid-cols-2 lg:grid-cols-3">
            {/* Trends are null until /v1/dashboard/summary returns prior-period deltas — no faked trends. */}
            <PremiumMetricCard primary label="Network revenue" value={summary.networkRevenue} format={formatCurrency} subtitle="This month" icon={<TrendingUp className="w-4 h-4" />} accent="emerald" trend={summary.networkRevenueTrend ?? null} onClick={() => navigate('/revenue')} />
            <PremiumMetricCard primary label="Revenue recovered" value={summary.revenueRecovered} format={formatCurrency} subtitle="By automation" icon={<DollarSign className="w-4 h-4" />} accent="indigo" trend={summary.revenueRecoveredTrend ?? null} onClick={() => navigate('/revenue-protection')} />
            <PremiumMetricCard primary label="Open opportunity" value={summary.activeOpportunities} format={formatCurrency} subtitle="Actionable now" icon={<Sparkles className="w-4 h-4" />} accent="violet" trend={summary.activeOpportunitiesTrend ?? null} onClick={() => navigate('/opportunities')} />
          </div>
          <div className="grid gap-2.5 grid-cols-2 lg:grid-cols-4">
            <PremiumMetricCard label="Today's appointments" value={summary.todaysAppointments} subtitle="Across your scope" icon={<CalendarDays className="w-4 h-4" />} accent="blue" onClick={() => navigate('/scheduling')} />
            <PremiumMetricCard label="Active patients" value={summary.activeCustomers} subtitle="Engaged base" icon={<Users className="w-4 h-4" />} accent="cyan" onClick={() => navigate('/patients')} />
            <PremiumMetricCard label="Patients at risk" value={summary.noShowRisk} subtitle="No-show flagged today" icon={<AlertCircle className="w-4 h-4" />} accent="red" onClick={() => navigate('/scheduling')} />
            <PremiumMetricCard label="Calls recovered" value={summary.callsRecovered} format={n => `${Math.round(n)}/${summary.callsRecovered + summary.missedCalls}`} subtitle="Follow-up queue" icon={<Phone className="w-4 h-4" />} accent="amber" onClick={() => navigate('/ai-receptionist')} />
          </div>
        </div>
      )}

      {/* MAIN GRID */}
      <div className="grid gap-3 xl:grid-cols-[1fr_360px] items-start">
        {/* Left column */}
        <div className="space-y-3 min-w-0">
          {/* Branch health */}
          <BentoCard title="Branch Health" subtitle="Network-wide operating health · derived from provider capacity"
            headerRight={<span className="text-xs font-semibold text-t3 bg-[var(--s3)] px-2.5 py-1 rounded-full">Avg {avgHealth}/100</span>}>
            {loading ? (
              <div className="grid gap-3 sm:grid-cols-2"><div className="skeleton-line h-40 rounded-2xl" /><div className="skeleton-line h-40 rounded-2xl" /></div>
            ) : branches.length === 0 ? (
              <p className="text-xs text-t3 py-4 text-center">No branch data available.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {branches.map(b => <BranchHealthCard key={b.id} branch={b} onOpen={() => navigate('/scheduling')} />)}
              </div>
            )}
          </BentoCard>

          {/* Provider utilization (lazy) + Revenue trend (lazy) */}
          <div className="grid gap-4 lg:grid-cols-2">
            <BentoCard title="Provider Capacity" subtitle="Utilization ranking" headerRight={<Gauge className="w-4 h-4 text-indigo" />}>
              {loading ? <div className="skeleton-line h-56 rounded-xl" /> : (
                <Suspense fallback={<div className="skeleton-line h-56 rounded-xl" />}>
                  <ProviderUtilizationPanel providers={providers} />
                </Suspense>
              )}
            </BentoCard>
            <BentoCard title="Revenue Performance" subtitle="Recovery & growth trends" headerRight={<LineChart className="w-4 h-4 text-violet-v" />}>
              <Suspense fallback={<div className="skeleton-line h-56 rounded-xl" />}>
                <RevenueChart />
              </Suspense>
            </BentoCard>
          </div>

          {/* Campaign ROI */}
          <BentoCard title="Campaign ROI" subtitle="Reactivation & recall performance"
            headerRight={<button type="button" onClick={() => navigate('/campaigner')} className="text-xs font-semibold text-indigo hover:opacity-75 inline-flex items-center gap-1"><BarChart3 className="w-3.5 h-3.5" /> All campaigns</button>}>
            {loading ? <SkeletonPanel rows={3} className="!border-0 !shadow-none !p-0" />
              : <CampaignROIPanel campaigns={campaigns} onViewAll={() => navigate('/campaigner')} onCreate={() => navigate('/campaigner')} />}
          </BentoCard>
        </div>

        {/* Right column — sticky priority rail */}
        <div className="sticky-rail">
          <PriorityActionRail
            actions={actions}
            loading={actionsLoading}
            onOpen={setDrawerAction}
            onCta={openCta}
            onCreateCampaign={() => navigate('/campaigner')}
          />
        </div>
      </div>

      {drawerAction && <ActionDrawer action={drawerAction} onClose={() => setDrawerAction(null)} onNavigate={(r) => { setDrawerAction(null); navigate(r); }} />}
    </div>
  );
}

function CurrencyLanguagePicker() {
  const { currency, language, setCurrency, setLanguage } = usePreferences();
  const selectCls = 'appearance-none rounded-lg border border-[var(--b1)] bg-white pl-7 pr-6 py-2 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] cursor-pointer outline-none';
  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Coins className="w-4 h-4 text-t3 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
        <select aria-label="Display currency" value={currency} onChange={e => setCurrency(e.target.value)} className={selectCls}>
          {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
        </select>
      </div>
      <div className="relative">
        <Globe className="w-4 h-4 text-t3 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
        <select aria-label="Language" value={language} onChange={e => setLanguage(e.target.value)} className={selectCls}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </div>
    </div>
  );
}
