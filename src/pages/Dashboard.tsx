import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  CalendarDays, Users, AlertCircle, Phone, Coins, Globe, Gauge, LineChart, BarChart3,
} from 'lucide-react';
import { usePreferences, CURRENCIES, LANGUAGES } from '../lib/preferences';
import BentoCard from '../components/ui/BentoCard';
import SkeletonPanel from '../components/ui/SkeletonPanel';
import CommandDeck from '../components/dashboard/CommandDeck';
import StatTile from '../components/dashboard/StatTile';
import PriorityActionRail from '../components/dashboard/PriorityActionRail';
import ActionDrawer from '../components/dashboard/ActionDrawer';
import BranchHealthCard from '../components/dashboard/BranchHealthCard';
import CampaignROIPanel from '../components/dashboard/CampaignROIPanel';
import { useApiResource } from '../hooks/useApiResource';
import { mapRevenueSnapshot, type ApiRevenueSnapshot } from '../lib/apiAdapters';
import RevenueChart, { type RevenueChartRow } from '../components/charts/RevenueChart';
import {
  dashboardService,
  type DashboardSummary, type BranchHealth, type ProviderUtilization, type CampaignROI, type PriorityAction,
} from '../lib/dashboardService';

// Heavy panels are code-split so they don't bloat the route bundle.
const ProviderUtilizationPanel = lazy(() => import('../components/dashboard/ProviderUtilizationPanel'));

/**
 * Dashboard — single-viewport cockpit. On desktop everything fits one screen
 * (the page never scrolls); dense lists scroll inside their own panels. Below
 * xl it degrades to a normal stacked page.
 */
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

  // One snapshots fetch feeds both the deck sparkline and the revenue chart.
  const { data: snapshots, loading: snapshotsLoading } = useApiResource<ApiRevenueSnapshot, RevenueChartRow>(
    '/v1/revenue-snapshots?limit=100',
    [],
    mapRevenueSnapshot,
  );
  const spark = [...snapshots]
    .sort((a, b) => (a.periodTs ?? 0) - (b.periodTs ?? 0))
    .map(s => ({ label: s.month, value: s.revenue }));

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
    <div className="dash-cockpit animate-fade-up">
      {/* Context bar — date + display preferences. Actions live in the deck. */}
      <div className="dash-bar flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-t3">{reportDate ? `Network overview · updated ${reportDate}` : 'Network overview'}</p>
        <CurrencyLanguagePicker />
      </div>

      {/* Command deck — hero band */}
      <div className="dash-deck">
        {summary
          ? <CommandDeck summary={summary} spark={spark} onNavigate={navigate} />
          : <div className="skeleton-line h-full min-h-[132px] rounded-2xl" />}
      </div>

      {/* KPI ribbon */}
      <div className="dash-kpis grid gap-2.5 grid-cols-2 lg:grid-cols-4">
        {loading || !summary ? (
          [0, 1, 2, 3].map(i => <div key={i} className="skeleton-line h-[92px] rounded-xl" />)
        ) : (
          <>
            <StatTile label="Today's appointments" value={summary.todaysAppointments} subtitle="Across your scope" icon={<CalendarDays className="w-4 h-4" />} accent="blue" onClick={() => navigate('/scheduling')} />
            <StatTile label="Active patients" value={summary.activeCustomers} subtitle="Engaged base" icon={<Users className="w-4 h-4" />} accent="cyan" onClick={() => navigate('/patients')} />
            <StatTile label="Patients at risk" value={summary.noShowRisk} subtitle="No-show flagged today" icon={<AlertCircle className="w-4 h-4" />} accent="red" onClick={() => navigate('/scheduling')} />
            <StatTile label="Calls recovered" value={summary.callsRecovered}
              format={n => `${Math.round(n)}/${summary.callsRecovered + summary.missedCalls}`}
              meter={summary.callsRecovered + summary.missedCalls > 0 ? summary.callsRecovered / (summary.callsRecovered + summary.missedCalls) : 0}
              subtitle="Follow-up queue" icon={<Phone className="w-4 h-4" />} accent="amber" onClick={() => navigate('/ai-receptionist')} />
          </>
        )}
      </div>

      {/* Visualization row — money + capacity */}
      <div className="dash-viz">
        <BentoCard className="cockpit-card" title="Revenue Performance" subtitle="Recovery & growth trend"
          headerRight={<LineChart className="w-4 h-4 text-violet-v" aria-hidden="true" />}>
          <RevenueChart data={snapshots} loading={snapshotsLoading} fitParent />
        </BentoCard>
        <BentoCard className="cockpit-card" title="Provider Capacity" subtitle="Utilization mix & ranking"
          headerRight={<Gauge className="w-4 h-4 text-indigo" aria-hidden="true" />}>
          {loading ? <div className="skeleton-line h-full min-h-[140px] rounded-xl" /> : (
            <Suspense fallback={<div className="skeleton-line h-full min-h-[140px] rounded-xl" />}>
              <ProviderUtilizationPanel providers={providers} />
            </Suspense>
          )}
        </BentoCard>
      </div>

      {/* Operations row — locations + growth */}
      <div className="dash-ops">
        <BentoCard className="cockpit-card" title="Branch Health" subtitle="Derived from live provider capacity"
          headerRight={branches.length > 0 ? <span className="text-xs font-semibold text-t3 bg-[var(--s3)] px-2.5 py-1 rounded-full">Avg {avgHealth}/100</span> : undefined}>
          {loading ? (
            <div className="space-y-2.5"><div className="skeleton-line h-20 rounded-xl" /><div className="skeleton-line h-20 rounded-xl" /></div>
          ) : branches.length === 0 ? (
            <p className="text-xs text-t3 py-4 text-center">No branch data available.</p>
          ) : (
            <div className="space-y-2.5">
              {branches.map(b => <BranchHealthCard key={b.id} branch={b} onOpen={() => navigate('/scheduling')} />)}
            </div>
          )}
        </BentoCard>
        <BentoCard className="cockpit-card" title="Campaign ROI" subtitle="Reactivation & recall performance"
          headerRight={<button type="button" onClick={() => navigate('/campaigner')} className="text-xs font-semibold text-indigo hover:opacity-75 inline-flex items-center gap-1"><BarChart3 className="w-3.5 h-3.5" aria-hidden="true" /> All campaigns</button>}>
          {loading ? <SkeletonPanel rows={3} className="!border-0 !shadow-none !p-0" />
            : <CampaignROIPanel campaigns={campaigns} onViewAll={() => navigate('/campaigner')} onCreate={() => navigate('/campaigner')} />}
        </BentoCard>
      </div>

      {/* Priority queue — full-height rail, scrolls internally */}
      <div className="dash-rail">
        <PriorityActionRail
          actions={actions}
          loading={actionsLoading}
          onOpen={setDrawerAction}
          onCta={openCta}
          onCreateCampaign={() => navigate('/campaigner')}
        />
      </div>

      {drawerAction && <ActionDrawer action={drawerAction} onClose={() => setDrawerAction(null)} onNavigate={(r) => { setDrawerAction(null); navigate(r); }} />}
    </div>
  );
}

function CurrencyLanguagePicker() {
  const { currency, language, setCurrency, setLanguage } = usePreferences();
  const selectCls = 'appearance-none rounded-lg border border-[var(--b1)] bg-white pl-7 pr-6 py-1.5 text-[12px] font-semibold text-t1 hover:bg-[var(--s2)] cursor-pointer outline-none';
  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Coins className="w-3.5 h-3.5 text-t3 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
        <select aria-label="Display currency" value={currency} onChange={e => setCurrency(e.target.value)} className={selectCls}>
          {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
        </select>
      </div>
      <div className="relative">
        <Globe className="w-3.5 h-3.5 text-t3 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
        <select aria-label="Language" value={language} onChange={e => setLanguage(e.target.value)} className={selectCls}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </div>
    </div>
  );
}
