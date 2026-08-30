import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertCircle, BarChart3, Filter, Radar, Sparkles, Store, TrendingUp, Zap, ArrowRight } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import RiskBadge from '../components/ui/RiskBadge';
import BentoCard from '../components/ui/BentoCard';
import ModuleTabs from '../components/ui/ModuleTabs';
import ResourceSection from '../components/ui/ResourceSection';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import type { AlertCategory, AlertSeverity } from '../types';
import { fetchList } from '../lib/apiAdapters';
import { LOADING_STATE, receivedData, type ResourceState } from '../lib/resourceState';
import { useResource } from '../hooks/useResource';
import { formatRatingThreshold, growthPolicyProvenance, loadGrowthPolicy, type GrowthPolicy } from '../lib/growthPolicy';

interface ApiBranchOption { id: string; name: string }

interface ApiCompetitorRadar {
  id: string;
  name: string;
  distanceKm: string;
  googleRating: string;
  reviewVolume: number;
  complaintThemes: string[];
  activeOffers: string[];
  localRankTrend: string;
  weaknessSummary: string;
  opportunityAlert: string;
  marketOpeningRecommendation: string;
  createdAt: string;
  branch: { name: string };
  insights: Array<{ theme: string; complaintCount: number; summary: string }>;
}

interface ApiReputationCase {
  id: string;
  branchId: string;
  branch: { name: string };
  patient?: { firstName: string; lastName: string } | null;
  badReviewRisk: number;
  complaintCategory: string;
  unresolvedComplaint: string;
  workflowStatus: string;
  recoveryWorkflow: string;
  suggestedReply: string;
  npsScore: number;
  publicTrend: string;
  staffComplaintDetected: boolean;
  createdAt: string;
}

interface ReputationResponse {
  summary: {
    unresolvedCases: number;
    avgBadReviewRisk: number;
    avgNpsScore: number;
    pendingReviewRequests: number;
  };
  cases: ApiReputationCase[];
  reviewRequests: Array<{ id: string }>;
}

/** The only two categories this screen can actually produce. */
type RadarCategory = Extract<AlertCategory, 'reputation' | 'operations'>;

type SignalRow = {
  id: string;
  category: RadarCategory;
  severity: AlertSeverity;
  title: string;
  description: string;
  action: string;
  branchId?: string;
  branchName?: string;
  createdAt: string;
};

/**
 * ClinicRadar builds signals from exactly two feeds: reputation cases and the
 * competitor radar. The filter row used to advertise Revenue, Retention, Staff
 * and Inventory as well — four buttons that could never match a row, because
 * nothing on this page ever emits those categories. Only the reachable ones are
 * offered.
 */
const categories: { id: RadarCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All Signals' },
  { id: 'reputation', label: 'Reputation' },
  { id: 'operations', label: 'Operations' },
];

const severityOrder: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 };

const categoryColor: Record<RadarCategory, { bg: string; text: string; dot: string }> = {
  operations: { bg: 'bg-[var(--violet-soft)]', text: 'text-violet-v', dot: 'bg-violet-500' },
  reputation: { bg: 'bg-[var(--amber-soft)]',  text: 'text-amber-v',  dot: 'bg-amber-500' },
};

const severityConfig: Record<AlertSeverity, { border: string; glow: string }> = {
  high:   { border: 'border-l-red-500',   glow: 'shadow-red-500/5' },
  medium: { border: 'border-l-amber-500', glow: 'shadow-amber-500/5' },
  low:    { border: 'border-l-[var(--b2)]', glow: '' },
};

/**
 * Reputation severity, from the tenant's configured bands.
 *
 * This screen used to classify `badReviewRisk` at a hardcoded `>= 80` / `>= 55`
 * while the server's advisory engine classified the SAME field at `>= 60`
 * (server/modules/advisory/service.ts:308) — two layers, one concept, three
 * numbers, and no way for a clinic to see which one it was reading. The bands
 * are now GrowthPolicy's, so the classification is the tenant's own rule.
 * Advisory still has its own literal and is the remaining divergence.
 *
 * Both bounds are INCLUSIVE LOWER bounds (server/modules/growth/defaults.ts).
 */
function severityFromRisk(value: number, policy: GrowthPolicy): AlertSeverity {
  if (value >= policy.reputationRiskHigh) return 'high';
  if (value >= policy.reputationRiskMedium) return 'medium';
  return 'low';
}

/**
 * Competitor.googleRating is `@default(0)`, so an unpopulated competitor row
 * arrives as "0". Reading that as a rating inverted the whole scale: a record
 * nobody had filled in scored below every threshold and self-reported as "High
 * Priority · Signals needing action now". An absent rating is not a bad rating,
 * so it is treated as absent and only the review volume can still raise the row.
 */
function competitorRating(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Competitor severity, from the tenant's configured bounds.
 *
 * `competitorRating*SeverityMax` are INCLUSIVE UPPER bounds (<=) and
 * `competitorReviewVolumeHigh` is the one EXCLUSIVE lower bound (>), which is
 * exactly what the retired `rating <= 4.2` / `<= 4.5` / `reviewVolume > 350`
 * literals did. The semantics are carried over with the numbers.
 */
function competitorSeverity(rating: number | null, reviewVolume: number, policy: GrowthPolicy): AlertSeverity {
  const highVolume = reviewVolume > policy.competitorReviewVolumeHigh;
  if (rating === null) return highVolume ? 'high' : 'low';
  if (rating <= policy.competitorRatingHighSeverityMax || highVolume) return 'high';
  if (rating <= policy.competitorRatingMediumSeverityMax) return 'medium';
  return 'low';
}

/**
 * How many rows of each feed this board asks for.
 *
 * A PAGE SIZE, not a clinic rule. It decides how much of each feed one screen
 * pulls, and no clinic would configure it — so it is named here rather than
 * pushed into GrowthPolicy, and the "Signals loaded" tile says the count is of
 * this page rather than of the workspace.
 */
const RADAR_PAGE_SIZE = 10;

/**
 * How many detections the timeline card shows. Also a page size: it is how many
 * rows fit in a sidebar card. The card says when it has cut the list.
 */
const TIMELINE_ROW_COUNT = 6;

// Module-scope loaders and paths: useResource keys a request by the identity of
// its source, so these must not be re-created on every render.
const loadBranches = (signal: AbortSignal) => fetchList<ApiBranchOption>('/v1/branches?limit=100', signal);
const loadCompetitors = (signal: AbortSignal) => fetchList<ApiCompetitorRadar>(`/v1/competitors/radar?limit=${RADAR_PAGE_SIZE}`, signal);
const REPUTATION_PATH = `/v1/reputation?limit=${RADAR_PAGE_SIZE}`;

/**
 * Two feeds, one claim. See the note on the twin helper in Reviews.tsx: a count
 * that spans both requests may only be shown once both have answered, otherwise
 * "4 signals loaded" quietly means "4 that we managed to load". Composes the
 * shared contract; worth lifting into lib/resourceState.ts when that file is
 * next open.
 */
function combineResourceStates<A, B, R>(
  a: ResourceState<A>,
  b: ResourceState<B>,
  merge: (a: A, b: B) => R,
): ResourceState<R> {
  if (a.status === 'error') return a;
  if (b.status === 'error') return b;
  if (a.status === 'loading' || b.status === 'loading') return LOADING_STATE;
  return { status: 'ready', data: merge(a.data, b.data), receivedAt: Math.max(a.receivedAt, b.receivedAt) };
}

/**
 * Three feeds, one claim.
 *
 * Every severity on this board is decided by the configured policy, so "2 high
 * priority signals" is not a fact until the reputation cases, the competitor
 * records AND the bands they are judged against have all arrived. Waiting on
 * the third is not pedantry: the same case is high under one tenant's bands and
 * medium under another's, so a count published before the bands land is a count
 * of the wrong thing rather than an early count of the right one.
 */
function combineThree<A, B, C, R>(
  a: ResourceState<A>,
  b: ResourceState<B>,
  c: ResourceState<C>,
  merge: (a: A, b: B, c: C) => R,
): ResourceState<R> {
  return combineResourceStates(
    combineResourceStates(a, b, (aValue, bValue) => [aValue, bValue] as const),
    c,
    ([aValue, bValue], cValue) => merge(aValue, bValue, cValue),
  );
}

export default function ClinicRadar() {
  const navigate = useNavigate();
  // Four independent requests rather than one Promise.all: a user who can read
  // reputation but not the competitor radar (or the reverse) now sees the half
  // they are entitled to, with a named failure and a retry beside the half they
  // are not, instead of the whole screen collapsing to a single error.
  const branches = useResource<ApiBranchOption[]>(loadBranches);
  const reputation = useResource<ReputationResponse>(REPUTATION_PATH);
  const competitors = useResource<ApiCompetitorRadar[]>(loadCompetitors);
  // The bands every severity on this page is decided by. A fourth feed, held to
  // the same contract: no band, no severity, and no count of severities.
  const policy = useResource<GrowthPolicy>(loadGrowthPolicy);

  const [activeCategory, setActiveCategory] = useState<RadarCategory | 'all'>('all');
  const [activeTab, setActiveTab] = useState<'all' | 'risk'>('all');
  const [selectedBranchId, setSelectedBranchId] = useState<'all' | string>('all');

  // Memoised so the empty-list fallback keeps one identity: it is a dependency
  // of the filter memo below, and a fresh [] on every render would re-run it.
  const branchOptions = useMemo(() => receivedData(branches.state) ?? [], [branches.state]);
  const receivedReputation = receivedData(reputation.state);
  const receivedCompetitors = receivedData(competitors.state);
  // Null until the policy answers. Every producer below is guarded on it, so an
  // unclassifiable row is never given a severity — not even a provisional one.
  const receivedPolicy = receivedData(policy.state);

  const reputationSignals = useMemo<SignalRow[]>(() => (receivedPolicy === null ? [] : (receivedReputation?.cases ?? []).map(caseRow => ({
    id: caseRow.id,
    category: 'reputation' as const,
    severity: severityFromRisk(caseRow.badReviewRisk, receivedPolicy),
    title: `${caseRow.branch.name}: ${caseRow.workflowStatus}`,
    description: caseRow.unresolvedComplaint,
    action: caseRow.recoveryWorkflow,
    branchId: caseRow.branchId,
    branchName: caseRow.branch.name,
    createdAt: caseRow.createdAt,
  }))), [receivedReputation, receivedPolicy]);

  const competitorSignals = useMemo<SignalRow[]>(() => (receivedPolicy === null ? [] : (receivedCompetitors ?? []).map(competitor => {
    const rating = competitorRating(competitor.googleRating);
    const themes = competitor.complaintThemes.join(' · ');
    return {
      id: competitor.id,
      category: 'operations' as const,
      severity: competitorSeverity(rating, competitor.reviewVolume, receivedPolicy),
      title: `${competitor.name} near ${competitor.branch.name}`,
      // States what the record holds. The old copy asserted that every
      // competitor row "is creating a market opening", including rows with no
      // rating on file.
      description: `${competitor.reviewVolume} reviews recorded, ${rating === null ? 'no rating on file' : `${rating.toFixed(1)} rating`}${themes ? `. Recorded complaint themes: ${themes}` : '.'}`,
      action: competitor.marketOpeningRecommendation,
      branchName: competitor.branch.name,
      createdAt: competitor.createdAt,
    };
  })), [receivedCompetitors, receivedPolicy]);

  const signals = useMemo(() => [...reputationSignals, ...competitorSignals], [competitorSignals, reputationSignals]);

  const filtered = useMemo(() => {
    let list = activeCategory === 'all' ? signals : signals.filter(a => a.category === activeCategory);
    if (activeTab === 'risk') list = list.filter(a => a.severity === 'high' || a.severity === 'medium');
    if (selectedBranchId !== 'all') {
      const branchName = branchOptions.find(branch => branch.id === selectedBranchId)?.name;
      list = list.filter(a => a.branchId === selectedBranchId || (branchName && a.branchName === branchName));
    }
    return [...list].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }, [activeCategory, activeTab, selectedBranchId, branchOptions, signals]);

  const selectedBranchName = selectedBranchId === 'all' ? 'All clinics' : branchOptions.find(branch => branch.id === selectedBranchId)?.name ?? 'All clinics';

  // The counts above the board are claims spanning every feed: a total drawn
  // from some of them is not a total, and a severity split drawn without the
  // bands is not a split, so all three have to answer first.
  const signalTotals = combineThree(reputation.state, competitors.state, policy.state, () => ({
    total: signals.length,
    high: signals.filter(signal => signal.severity === 'high').length,
    medium: signals.filter(signal => signal.severity === 'medium').length,
  }));
  const boardState = combineThree(reputation.state, competitors.state, policy.state, () => filtered);
  const timelineState = combineThree(reputation.state, competitors.state, policy.state, () => signals);
  const anyFeedFailed = reputation.state.status === 'error' || competitors.state.status === 'error';

  const reloadSignals = () => { reputation.reload(); competitors.reload(); policy.reload(); };

  const signalTabs = [
    { id: 'all', label: 'All signals' },
    { id: 'risk', label: 'Needs action' },
  ];

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="ClinicRadar"
        subtitle="Your reputation cases and nearby competitor records, ranked as signals so you can decide what to act on."
        badge={
          signalTotals.status === 'loading' ? 'Loading signals'
            : signalTotals.status === 'error' ? 'Data unavailable'
              : `${signals.length} signal${signals.length === 1 ? '' : 's'} loaded`
        }
        badgeColor={signalTotals.status === 'error' ? 'red' : signalTotals.status === 'loading' ? 'blue' : signals.some(s => s.severity === 'high') ? 'amber' : 'blue'}
        actions={
          <button
            type="button"
            onClick={reloadSignals}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--s3)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] border border-[var(--b1)] transition"
          >
            <Radar className="w-4 h-4" /> Refresh signals
          </button>
        }
      />

      {/* Summary KPI strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <ResourceSection
          label="Signal counts"
          state={signalTotals}
          onRetry={reloadSignals}
          className="col-span-2 sm:col-span-3"
          compact
          loading={<>{[0, 1, 2].map(i => <div key={i} className="skeleton-line h-28 rounded-2xl" />)}</>}
          isEmpty={() => false}
        >
          {totals => (
            <>
              <div className="bg-[var(--s2)] rounded-2xl border border-[var(--b1)] p-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-2">Signals loaded</p>
                <p className="text-2xl font-bold text-t1 tabular-nums">{totals.total}</p>
                <p className="text-xs text-t3 mt-0.5">Most recent {RADAR_PAGE_SIZE} reputation cases and {RADAR_PAGE_SIZE} competitor records</p>
              </div>
              <div className="bg-[var(--red-soft)] rounded-2xl border border-[var(--b1)] p-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-red-v mb-2">High Priority</p>
                <p className="text-2xl font-bold text-red-v tabular-nums">{totals.high}</p>
                <p className="text-xs text-red-v/70 mt-0.5">At or past your high-severity threshold</p>
              </div>
              <div className="bg-[var(--amber-soft)] rounded-2xl border border-[var(--b1)] p-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-amber-v mb-2">Medium Priority</p>
                <p className="text-2xl font-bold text-amber-v tabular-nums">{totals.medium}</p>
                <p className="text-xs text-amber-v/70 mt-0.5">At or past your medium-severity threshold</p>
              </div>
            </>
          )}
        </ResourceSection>

        {/* "0 open cases" is a safety claim, so it comes only from a response
            that actually said zero — never from a refresh in flight. */}
        <ResourceSection
          label="Open reputation cases"
          state={reputation.state}
          onRetry={reputation.reload}
          compact
          loading={<div className="skeleton-line h-28 rounded-2xl" />}
        >
          {data => (
            <div className="bg-[var(--violet-soft)] rounded-2xl border border-[var(--b1)] p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-violet-v mb-2">Open reputation cases</p>
              <p className="text-2xl font-bold text-violet-v tabular-nums">{data.summary.unresolvedCases}</p>
              <p className="text-xs text-violet-v/70 mt-0.5">Recorded as unresolved</p>
            </div>
          )}
        </ResourceSection>
      </div>

      {/* The bands every "High"/"Medium" on this page is asserted against,
          written out as the values actually used. They render only once the
          policy has answered: an unstated rule is bad, but a stated rule that
          is not the one being applied is worse. */}
      {receivedPolicy && (
        <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-3">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-t3">How these are classified</p>
          <p className="text-[13px] leading-relaxed text-t2">
            Reputation cases count as high at a recorded risk ≥ {receivedPolicy.reputationRiskHigh} and medium at ≥ {receivedPolicy.reputationRiskMedium}.
            {' '}Competitors count as high at a rating ≤ {formatRatingThreshold(receivedPolicy.competitorRatingHighSeverityMax)} or more than {receivedPolicy.competitorReviewVolumeHigh} reviews, and medium at a rating ≤ {formatRatingThreshold(receivedPolicy.competitorRatingMediumSeverityMax)}.
            {' '}{growthPolicyProvenance(receivedPolicy)}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-3">
        <p className="text-xs font-semibold text-t2">Clinic</p>
        <select
          aria-label="Clinic"
          value={selectedBranchId}
          onChange={e => setSelectedBranchId(e.target.value)}
          className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t1 outline-none"
        >
          <option value="all">All clinics</option>
          {branchOptions.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
        <p className="text-xs text-t2">Showing signals for {selectedBranchName}.</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Main alert board */}
        <div className="space-y-4">

          {/* Filters */}
          <div className="cc-card p-4">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2 flex-wrap">
                {categories.map(cat => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setActiveCategory(cat.id)}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                      activeCategory === cat.id
                        ? 'bg-[var(--indigo)] text-white'
                        : 'bg-[var(--s3)] text-t2 hover:bg-[var(--s3)] hover:text-t1'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
              {/* Was "Opportunities | Risks", where "Opportunities" applied no
                  filter at all. The pair is what it does: everything, or the
                  high and medium rows. */}
              <div className="shrink-0">
                <ModuleTabs tabs={signalTabs} activeTab={activeTab} onChange={id => setActiveTab(id as 'all' | 'risk')} ariaLabel="Signal severity" />
              </div>
            </div>

            {anyFeedFailed && reputation.state.status !== competitors.state.status && (
              <p role="status" className="mb-3 rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] px-3 py-2 text-[12px] leading-relaxed text-amber-v">
                {reputation.state.status === 'error' ? 'Reputation cases' : 'Competitor records'} did not load, so this board is showing only the {reputation.state.status === 'error' ? 'competitor' : 'reputation'} signals. It is not the full picture — refresh signals to fill it in.
              </p>
            )}

            <ResourceSection
              label="Signals"
              state={boardState}
              onRetry={reloadSignals}
              lines={3}
              rowClassName="h-28 rounded-2xl"
              // The board owns its own two empty claims below, which have to
              // tell "nothing recorded" apart from "nothing matches".
              isEmpty={() => false}
            >
              {rows => {
                if (rows.length === 0) {
                  const filtersActive = activeCategory !== 'all' || activeTab !== 'all' || selectedBranchId !== 'all';
                  return filtersActive ? (
                    <EmptyStatePremium
                      icon={<Filter className="w-5 h-5" />}
                      title="No signals match these filters"
                      description={`${signals.length} signal${signals.length === 1 ? ' is' : 's are'} loaded, and none match the current clinic, category and severity selection. Clear the filters to see all of them.`}
                      cta={{ label: 'Clear filters', onClick: () => { setActiveCategory('all'); setActiveTab('all'); setSelectedBranchId('all'); } }}
                    />
                  ) : (
                    <EmptyStatePremium
                      icon={<Radar className="w-5 h-5" />}
                      title="No signals recorded"
                      description="Both feeds loaded and this workspace has no reputation cases or competitor records on file. Nothing needs action right now — new cases and competitor records appear here as they are recorded."
                      cta={{ label: 'Refresh signals', onClick: reloadSignals }}
                    />
                  );
                }
                return (
                  <div className="space-y-3">
                    {rows.map((alert) => {
                      const cat = categoryColor[alert.category];
                      const sev = severityConfig[alert.severity];
                      return (
                        <div key={alert.id} className={`rounded-2xl border border-[var(--b1)] border-l-2 p-4 hover:bg-[var(--s3)] transition-all ${sev.border} ${sev.glow}`}>
                          <div className="flex items-start gap-3">
                            <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${cat.bg}`}>
                              <span className={`w-2.5 h-2.5 rounded-full ${cat.dot}`} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-3 mb-1">
                                <p className="text-sm font-bold text-t1 leading-tight">{alert.title}</p>
                                <RiskBadge level={alert.severity} size="sm" />
                              </div>

                              <div className="flex items-center gap-2 mb-2">
                                <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${cat.bg} ${cat.text}`}>
                                  {alert.category}
                                </span>
                                {alert.branchName && (
                                  <span className="text-[10px] text-t3">{alert.branchName}</span>
                                )}
                              </div>

                              <p className="text-[13px] text-t2 leading-relaxed mb-3">{alert.description}</p>

                              <div className="flex items-center justify-end gap-3">
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => navigate(alert.category === 'reputation' ? '/reviews' : '/campaigner')}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition-colors"
                                  >
                                    <Zap className="w-3 h-3" /> Review action
                                  </button>
                                </div>
                              </div>

                              <div className="mt-3 p-2.5 rounded-xl bg-[var(--s3)] border border-[var(--b1)]">
                                <p className="text-[12px] font-semibold leading-relaxed text-t2">
                                  <span className="text-t3 mr-1">Suggested next step:</span>
                                  {alert.action}
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            </ResourceSection>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          <BentoCard title="Nearby Competitors" subtitle="Ratings, offers, and complaint themes on file">
            <ResourceSection
              label="Competitor records"
              state={competitors.state}
              onRetry={competitors.reload}
              lines={2}
              rowClassName="h-32 rounded-xl"
              empty={{
                icon: <Store className="w-5 h-5" />,
                title: 'No competitor records',
                description: 'The competitor radar loaded and this workspace has no competitor records on file yet.',
              }}
            >
              {rows => {
                const visible = selectedBranchId === 'all' ? rows : rows.filter(competitor => competitor.branch.name === selectedBranchName);
                if (visible.length === 0) {
                  return (
                    <EmptyStatePremium
                      icon={<Filter className="w-5 h-5" />}
                      title="No competitors for this clinic"
                      description={`${rows.length} competitor record${rows.length === 1 ? ' is' : 's are'} loaded, and none are recorded against ${selectedBranchName}. Switch back to all clinics to see them.`}
                      cta={{ label: 'Show all clinics', onClick: () => setSelectedBranchId('all') }}
                    />
                  );
                }
                return (
                  <div className="space-y-3">
                    {visible.map((competitor) => {
                      const rating = competitorRating(competitor.googleRating);
                      return (
                        <div key={competitor.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-t1">{competitor.name}</p>
                              <p className="text-[10px] text-t3 mt-0.5">{competitor.branch.name} · {competitor.distanceKm} km away</p>
                            </div>
                            <div className="text-right shrink-0">
                              {/* An unset googleRating is "0" in the database,
                                  and Number('').toFixed(1) was rendering NaN. */}
                              {rating === null
                                ? <p className="text-[10px] font-semibold text-t3">No rating on file</p>
                                : <p className="text-sm font-bold text-t1">{rating.toFixed(1)}</p>}
                              <p className="text-[10px] text-t3">{competitor.reviewVolume} reviews</p>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {competitor.activeOffers.slice(0, 2).map(offer => (
                              <span key={offer} className="badge badge-blue">{offer}</span>
                            ))}
                          </div>
                          <p className="text-xs text-t2 mt-2">{competitor.weaknessSummary}</p>
                          <p className="text-[11px] text-amber-v mt-2">{competitor.opportunityAlert}</p>
                          {competitor.complaintThemes.length > 0 && (
                            <p className="text-[11px] text-t3 mt-1">Weak themes: {competitor.complaintThemes.join(' · ')}</p>
                          )}
                          <p className="text-[11px] text-indigo mt-2 font-semibold">{competitor.marketOpeningRecommendation}</p>
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            </ResourceSection>
          </BentoCard>

          <BentoCard title="Signals by branch" subtitle="Loaded signals, by clinic" headerRight={<BarChart3 className="w-4 h-4 text-t3" />}>
            <ResourceSection
              label="Signals by branch"
              state={combineResourceStates(branches.state, signalTotals, (branchRows) => branchRows)}
              onRetry={() => { branches.reload(); reloadSignals(); }}
              lines={3}
              rowClassName="h-12 rounded-xl"
              empty={{
                title: 'No clinics recorded',
                description: 'The clinic list loaded and this workspace has no clinic records to group signals by.',
              }}
            >
              {rows => (
                <div className="space-y-3">
                  {rows.map((branch) => {
                    const signalCount = signals.filter(signal => signal.branchId === branch.id || signal.branchName === branch.name).length;
                    return (
                      <div key={branch.id}>
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <p className="text-xs font-semibold text-t2 truncate">{branch.name}</p>
                          <span className={`badge ${signalCount > 0 ? 'badge-amber' : 'badge-blue'}`}>{signalCount} signal{signalCount === 1 ? '' : 's'}</span>
                        </div>
                        <p className="text-[12px] text-t2">{signalCount > 0 ? 'Open the source record before you act on it.' : 'No signals for this clinic in the loaded set.'}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </ResourceSection>
          </BentoCard>

          {/* Signal timeline */}
          <BentoCard title="Signal Timeline" subtitle="Recent detections">
            <ResourceSection
              label="Signal timeline"
              state={timelineState}
              onRetry={reloadSignals}
              lines={3}
              rowClassName="h-10 rounded-xl"
              empty={{
                icon: <Radar className="w-5 h-5" />,
                title: 'No detections recorded',
                description: 'Both feeds loaded and neither has a record to place on the timeline yet.',
              }}
            >
              {rows => {
                // One list drives both the rows and the connector. The
                // connector used to re-derive the cut with its own
                // `Math.min(rows.length, 6)`, so the two could disagree.
                const visible = rows.slice(0, TIMELINE_ROW_COUNT);
                return (
                  <div className="space-y-3">
                    {visible.map((alert, i) => (
                      <div key={alert.id} className="flex items-start gap-3">
                        <div className="flex flex-col items-center gap-1">
                          <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${
                            alert.severity === 'high' ? 'bg-red-500' :
                            alert.severity === 'medium' ? 'bg-amber-500' : 'bg-[var(--b2)]'
                          }`} />
                          {i < visible.length - 1 && <div className="w-px h-6 bg-[var(--b1)]" />}
                        </div>
                        <div className="flex-1 min-w-0 pb-1">
                          <p className="text-xs font-semibold text-t1 leading-tight">{alert.title.split(':')[0]}</p>
                          <p className="text-[10px] text-t3 mt-0.5">
                            {new Date(alert.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ·{' '}
                            {new Date(alert.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          </p>
                        </div>
                      </div>
                    ))}
                    {rows.length > visible.length && (
                      <p className="text-[11px] leading-snug text-t2">
                        Most recent {visible.length} of {rows.length} loaded detections.
                      </p>
                    )}
                  </div>
                );
              }}
            </ResourceSection>
          </BentoCard>

          {/* Decision checklist */}
          <BentoCard title="Before you act" subtitle="Checks for staff reviewing a signal">
            <div className="space-y-2.5">
              {[
                'Open the source record and confirm it is still current.',
                'Confirm authority, consent, and suppression status in the destination workflow before contacting anyone.',
                'Treat estimated or suggested language as guidance, not a verified outcome.',
                'Use the Control Plane to review the available audit and access evidence.',
              ].map((text, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-v shrink-0" />
                  <p className="text-[13px] leading-relaxed text-t2">{text}</p>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Quick actions */}
          <BentoCard title="Quick Actions" subtitle="Common commands">
            <div className="space-y-2">
              {[
                { label: 'Review win-back campaign setup', icon: <Sparkles className="w-3.5 h-3.5" />, action: () => navigate('/campaigner') },
                { label: 'Review scheduling gaps', icon: <AlertCircle className="w-3.5 h-3.5" />, action: () => navigate('/scheduling') },
                { label: 'Review missed-call queue', icon: <TrendingUp className="w-3.5 h-3.5" />, action: () => navigate('/ai-receptionist') },
              ].map((a) => (
                <button key={a.label} type="button" onClick={a.action} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all text-left group">
                  <div className="text-t3 group-hover:text-indigo transition-colors">{a.icon}</div>
                  <span className="text-xs font-semibold text-t2 group-hover:text-t1 transition-colors flex-1">{a.label}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-t3 group-hover:text-indigo transition-all" />
                </button>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
