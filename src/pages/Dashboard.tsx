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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [drawerAction, setDrawerAction] = useState<PriorityAction | null>(null);

  // One snapshots fetch feeds both the deck sparkline and the revenue chart.
  const { data: snapshots, loading: snapshotsLoading, error: snapshotsError } = useApiResource<ApiRevenueSnapshot, RevenueChartRow>(
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
      try {
        const [s, b, p, c] = await Promise.all([
          dashboardService.getSummary(),
          dashboardService.getBranchHealth(),
          dashboardService.getProviderUtilization(),
          dashboardService.getCampaignROI(),
        ]);
        if (!active) return;
        setSummary(s); setBranches(b); setProviders(p); setCampaigns(c); setLoadError(null);
      } catch {
        if (active) setLoadError('Dashboard summary and operational panels are unavailable. No zero or healthy-state conclusions should be drawn.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    void (async () => {
      try {
        const a = await dashboardService.getPriorityActions();
        if (active) { setActions(a); setActionsError(null); }
      } catch {
        if (active) setActionsError('Priority queue unavailable; an empty queue cannot be inferred.');
      } finally {
        if (active) setActionsLoading(false);
      }
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
          : loadError ? <UnavailablePanel message={loadError} /> : <div className="skeleton-line h-full min-h-[132px] rounded-2xl" />}
      </div>

      {/* KPI ribbon */}
      <div className="dash-kpis grid gap-2.5 grid-cols-2 lg:grid-cols-4">
        {loadError ? (
          <div role="alert" className="col-span-full rounded-xl border border-red-soft bg-red-soft p-4 text-sm font-semibold text-red-v">KPI data unavailable; zero values are not being shown.</div>
        ) : loading || !summary ? (
          [0, 1, 2, 3].map(i => <div key={i} className="skeleton-line h-[92px] rounded-xl" />)
        ) : (
          <>
            <StatTile label="Today's appointments" value={summary.todaysAppointments} subtitle="Across your scope" icon={<CalendarDays className="w-4 h-4" />} accent="blue" onClick={() => navigate('/scheduling')} />
            <StatTile label="Active patients" value={summary.activeCustomers} subtitle="Engaged base" icon={<Users className="w-4 h-4" />} accent="cyan" onClick={() => navigate('/patients')} />
            <StatTile label="No-show flags" value={summary.noShowRisk} subtitle="Appointments flagged today" icon={<AlertCircle className="w-4 h-4" />} accent="red" onClick={() => navigate('/scheduling')} />
            <StatTile label="Call conversations with staff reply evidence" value={summary.callsRecovered}
              format={n => `${Math.round(n)}/${summary.callsRecovered + summary.missedCalls}`}
              meter={summary.callsRecovered + summary.missedCalls > 0 ? summary.callsRecovered / (summary.callsRecovered + summary.missedCalls) : 0}
              subtitle="Provider-accepted staff replies / accepted + unread; delivery not implied" icon={<Phone className="w-4 h-4" />} accent="amber" onClick={() => navigate('/ai-receptionist')} />
          </>
        )}
      </div>

      {/* Visualization row — money + capacity */}
      <div className="dash-viz">
        <BentoCard className="cockpit-card" title="Revenue snapshot trend" subtitle="Recorded revenue and associated-value fields"
          headerRight={<LineChart className="w-4 h-4 text-violet-v" aria-hidden="true" />}>
          {snapshotsError ? <UnavailablePanel message="Revenue snapshots unavailable; no empty or zero trend is inferred." /> : <RevenueChart data={snapshots} loading={snapshotsLoading} fitParent />}
        </BentoCard>
        <BentoCard className="cockpit-card" title="Provider Capacity" subtitle="Recorded utilization, ordered highest to lowest"
          headerRight={<Gauge className="w-4 h-4 text-indigo" aria-hidden="true" />}>
          {loadError ? <UnavailablePanel message="Provider capacity data unavailable." /> : loading ? <div className="skeleton-line h-full min-h-[140px] rounded-xl" /> : (
            <Suspense fallback={<div className="skeleton-line h-full min-h-[140px] rounded-xl" />}>
              <ProviderUtilizationPanel providers={providers} />
            </Suspense>
          )}
        </BentoCard>
      </div>

      {/* Operations row — locations + growth */}
      <div className="dash-ops">
        <BentoCard className="cockpit-card" title="Branch Capacity Planning" subtitle="Unvalidated fixed index from utilization and recorded ratings"
          headerRight={branches.length > 0 ? <span className="text-xs font-semibold text-t3 bg-[var(--s3)] px-2.5 py-1 rounded-full">Planning avg {avgHealth}/100</span> : undefined}>
          {loadError ? <UnavailablePanel message="Branch data unavailable; no healthy or empty state is inferred." /> : loading ? (
            <div className="space-y-2.5"><div className="skeleton-line h-20 rounded-xl" /><div className="skeleton-line h-20 rounded-xl" /></div>
          ) : branches.length === 0 ? (
            <p className="text-xs text-t3 py-4 text-center">The loaded dataset contains no branches.</p>
          ) : (
            <div className="space-y-2.5">
              {branches.map(b => <BranchHealthCard key={b.id} branch={b} onOpen={() => navigate('/scheduling')} />)}
            </div>
          )}
        </BentoCard>
        <BentoCard className="cockpit-card" title="Campaign performance evidence" subtitle="Stored audience, booking, and associated-value fields; causation not established"
          headerRight={<button type="button" onClick={() => navigate('/campaigner')} className="text-xs font-semibold text-indigo hover:opacity-75 inline-flex items-center gap-1"><BarChart3 className="w-3.5 h-3.5" aria-hidden="true" /> All campaigns</button>}>
          {loadError ? <UnavailablePanel message="Campaign data unavailable; no campaign-performance conclusion is inferred." /> : loading ? <SkeletonPanel rows={3} className="!border-0 !shadow-none !p-0" />
            : <CampaignROIPanel campaigns={campaigns} onViewAll={() => navigate('/campaigner')} onCreate={() => navigate('/campaigner')} />}
        </BentoCard>
      </div>

      {/* Priority queue — full-height rail, scrolls internally */}
      <div className="dash-rail">
        {actionsError ? <UnavailablePanel message={actionsError} /> : <PriorityActionRail
          actions={actions}
          loading={actionsLoading}
          onOpen={setDrawerAction}
          onCta={openCta}
          onCreateCampaign={() => navigate('/campaigner')}
        />}
      </div>

      {drawerAction && <ActionDrawer action={drawerAction} onClose={() => setDrawerAction(null)} onNavigate={(r) => { setDrawerAction(null); navigate(r); }} />}
    </div>
  );
}

function UnavailablePanel({ message }: { message: string }) {
  return <div role="alert" className="flex h-full min-h-[96px] items-center justify-center rounded-xl border border-red-soft bg-red-soft p-4 text-center text-xs font-semibold text-red-v">{message}</div>;
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
