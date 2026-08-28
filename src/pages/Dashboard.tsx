import { lazy, Suspense, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  CalendarDays, Users, AlertCircle, Phone, Coins, Globe, Gauge, LineChart, BarChart3, MapPin, TrendingUp,
} from 'lucide-react';
import { usePreferences, CURRENCIES, LANGUAGES } from '../lib/preferences';
import BentoCard from '../components/ui/BentoCard';
import ResourceSection from '../components/ui/ResourceSection';
import CommandDeck from '../components/dashboard/CommandDeck';
import StatTile from '../components/dashboard/StatTile';
import PriorityActionRail from '../components/dashboard/PriorityActionRail';
import ActionDrawer from '../components/dashboard/ActionDrawer';
import BranchHealthCard from '../components/dashboard/BranchHealthCard';
import CampaignROIPanel from '../components/dashboard/CampaignROIPanel';
import { apiRequest } from '../lib/api';
import { receivedData } from '../lib/resourceState';
import { useResource } from '../hooks/useResource';
import { mapRevenueSnapshot, type ApiRevenueSnapshot } from '../lib/apiAdapters';
import RevenueChart, { type RevenueChartRow } from '../components/charts/RevenueChart';
import {
  dashboardService,
  type DashboardSummary, type BranchHealth, type ProviderUtilization, type CampaignROI, type PriorityAction,
} from '../lib/dashboardService';

// Heavy panels are code-split so they don't bloat the route bundle.
const ProviderUtilizationPanel = lazy(() => import('../components/dashboard/ProviderUtilizationPanel'));

// Module-scope loaders: useResource keys a request by the identity of its
// source, so these must not be re-created on every render.
const loadSummary = () => dashboardService.getSummary();
const loadBranchHealth = () => dashboardService.getBranchHealth();
const loadProviderUtilization = () => dashboardService.getProviderUtilization();
const loadCampaignROI = () => dashboardService.getCampaignROI();
const loadPriorityActions = () => dashboardService.getPriorityActions();
const loadRevenueSnapshots = async (signal: AbortSignal): Promise<RevenueChartRow[]> => {
  const response = await apiRequest<ApiRevenueSnapshot[] | { data: ApiRevenueSnapshot[] }>('/v1/revenue-snapshots?limit=100', { signal });
  return (Array.isArray(response) ? response : response.data).map(mapRevenueSnapshot);
};

/**
 * Dashboard — single-viewport cockpit. On desktop everything fits one screen
 * (the page never scrolls); dense lists scroll inside their own panels. Below
 * xl it degrades to a normal stacked page.
 *
 * Every panel owns its own request state, so a failed panel says which feed
 * failed and offers a retry while its neighbours keep working. No panel prints
 * a figure, an average or an empty queue that it did not actually receive.
 */
export default function Dashboard() {
  const navigate = useNavigate();
  const [drawerAction, setDrawerAction] = useState<PriorityAction | null>(null);

  const summary = useResource<DashboardSummary>(loadSummary);
  const branches = useResource<BranchHealth[]>(loadBranchHealth);
  const providers = useResource<ProviderUtilization[]>(loadProviderUtilization);
  const campaigns = useResource<CampaignROI[]>(loadCampaignROI);
  const actions = useResource<PriorityAction[]>(loadPriorityActions);
  // One snapshots fetch feeds both the deck sparkline and the revenue chart.
  const snapshots = useResource<RevenueChartRow[]>(loadRevenueSnapshots);

  // The sparkline hides below two points, so an unavailable feed reads as an
  // absent sparkline rather than a flat line that was never measured.
  const snapshotRows = receivedData(snapshots.state) ?? [];
  const spark = [...snapshotRows]
    .sort((a, b) => (a.periodTs ?? 0) - (b.periodTs ?? 0))
    .map(s => ({ label: s.month, value: s.revenue }));

  const receivedSummary = receivedData(summary.state);
  const reportDate = receivedSummary ? new Date(receivedSummary.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  const receivedBranches = receivedData(branches.state);
  const avgHealth = receivedBranches && receivedBranches.length > 0
    ? Math.round(receivedBranches.reduce((s, b) => s + b.healthScore, 0) / receivedBranches.length)
    : null;

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
        <ResourceSection
          label="Dashboard summary"
          state={summary.state}
          onRetry={summary.reload}
          loading={<div className="skeleton-line h-full min-h-[132px] rounded-2xl" />}
        >
          {data => <CommandDeck summary={data} spark={spark} onNavigate={navigate} />}
        </ResourceSection>
      </div>

      {/* KPI ribbon */}
      <div className="dash-kpis grid gap-2.5 grid-cols-2 lg:grid-cols-4">
        <ResourceSection
          label="Today's key figures"
          state={summary.state}
          onRetry={summary.reload}
          className="col-span-full"
          loading={<>{[0, 1, 2, 3].map(i => <div key={i} className="skeleton-line h-[92px] rounded-xl" />)}</>}
        >
          {data => (
            <>
              <StatTile label="Today's appointments" value={data.todaysAppointments} subtitle="Across your scope" icon={<CalendarDays className="w-4 h-4" />} accent="blue" onClick={() => navigate('/scheduling')} />
              <StatTile label="Active patients" value={data.activeCustomers} subtitle="Engaged base" icon={<Users className="w-4 h-4" />} accent="cyan" onClick={() => navigate('/patients')} />
              <StatTile label="No-show flags" value={data.noShowRisk} subtitle="Appointments flagged today" icon={<AlertCircle className="w-4 h-4" />} accent="red" onClick={() => navigate('/scheduling')} />
              <StatTile label="Call conversations with staff reply evidence" value={data.callsRecovered}
                format={n => `${Math.round(n)}/${data.callsRecovered + data.missedCalls}`}
                meter={data.callsRecovered + data.missedCalls > 0 ? data.callsRecovered / (data.callsRecovered + data.missedCalls) : 0}
                subtitle="Provider-accepted staff replies / accepted + unread; delivery not implied" icon={<Phone className="w-4 h-4" />} accent="amber" onClick={() => navigate('/ai-receptionist')} />
            </>
          )}
        </ResourceSection>
      </div>

      {/* Visualization row — money + capacity */}
      <div className="dash-viz">
        <BentoCard className="cockpit-card" title="Revenue snapshot trend" subtitle="Recorded revenue and associated-value fields"
          headerRight={<LineChart className="w-4 h-4 text-violet-v" aria-hidden="true" />}>
          <ResourceSection
            label="Revenue snapshots"
            state={snapshots.state}
            onRetry={snapshots.reload}
            loading={<div className="skeleton-line h-full min-h-[150px] rounded-xl" />}
            empty={{
              icon: <TrendingUp className="w-5 h-5" />,
              title: 'No revenue snapshots recorded',
              description: 'The snapshot feed loaded successfully and this workspace has no recorded revenue snapshots yet.',
            }}
          >
            {rows => <RevenueChart data={rows} fitParent />}
          </ResourceSection>
        </BentoCard>
        <BentoCard className="cockpit-card" title="Provider Capacity" subtitle="Recorded utilization, ordered highest to lowest"
          headerRight={<Gauge className="w-4 h-4 text-indigo" aria-hidden="true" />}>
          <ResourceSection
            label="Provider capacity"
            state={providers.state}
            onRetry={providers.reload}
            loading={<div className="skeleton-line h-full min-h-[140px] rounded-xl" />}
            empty={{
              icon: <Gauge className="w-5 h-5" />,
              title: 'No providers recorded',
              description: 'The provider feed loaded successfully and this workspace has no provider utilization records.',
            }}
          >
            {rows => (
              <Suspense fallback={<div className="skeleton-line h-full min-h-[140px] rounded-xl" />}>
                <ProviderUtilizationPanel providers={rows} />
              </Suspense>
            )}
          </ResourceSection>
        </BentoCard>
      </div>

      {/* Operations row — locations + growth */}
      <div className="dash-ops">
        <BentoCard className="cockpit-card" title="Branch Capacity Planning" subtitle="Unvalidated fixed index from utilization and recorded ratings"
          headerRight={avgHealth != null ? <span className="text-xs font-semibold text-t3 bg-[var(--s3)] px-2.5 py-1 rounded-full">Planning avg {avgHealth}/100</span> : undefined}>
          <ResourceSection
            label="Branch capacity"
            state={branches.state}
            onRetry={branches.reload}
            loading={<div className="space-y-2.5"><div className="skeleton-line h-20 rounded-xl" /><div className="skeleton-line h-20 rounded-xl" /></div>}
            empty={{
              icon: <MapPin className="w-5 h-5" />,
              title: 'No branches recorded',
              description: 'The branch feed loaded successfully and this workspace has no branch records.',
            }}
          >
            {rows => (
              <div className="space-y-2.5">
                {rows.map(b => <BranchHealthCard key={b.id} branch={b} onOpen={() => navigate('/scheduling')} />)}
              </div>
            )}
          </ResourceSection>
        </BentoCard>
        <BentoCard className="cockpit-card" title="Campaign performance evidence" subtitle="Stored audience, booking, and associated-value fields; causation not established"
          headerRight={<button type="button" onClick={() => navigate('/campaigner')} className="text-xs font-semibold text-indigo hover:opacity-75 inline-flex items-center gap-1"><BarChart3 className="w-3.5 h-3.5" aria-hidden="true" /> All campaigns</button>}>
          <ResourceSection
            label="Campaign performance"
            state={campaigns.state}
            onRetry={campaigns.reload}
            loading={<div className="space-y-2.5">{[0, 1, 2].map(i => <div key={i} className="skeleton-line h-16 rounded-xl" />)}</div>}
            // The panel owns the "no campaigns yet" claim and its create CTA.
            isEmpty={() => false}
          >
            {rows => <CampaignROIPanel campaigns={rows} onViewAll={() => navigate('/campaigner')} onCreate={() => navigate('/campaigner')} />}
          </ResourceSection>
        </BentoCard>
      </div>

      {/* Priority queue — full-height rail, scrolls internally */}
      <div className="dash-rail">
        <ResourceSection
          label="Priority queue"
          state={actions.state}
          onRetry={actions.reload}
          loading={<PriorityActionRail actions={[]} loading onOpen={setDrawerAction} onCta={openCta} onCreateCampaign={() => navigate('/campaigner')} />}
          // An empty queue is the rail's own claim, made only on a real response.
          isEmpty={() => false}
        >
          {rows => (
            <PriorityActionRail
              actions={rows}
              onOpen={setDrawerAction}
              onCta={openCta}
              onCreateCampaign={() => navigate('/campaigner')}
            />
          )}
        </ResourceSection>
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
