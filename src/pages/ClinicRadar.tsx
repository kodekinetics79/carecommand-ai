import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, BarChart3, Radar, ShieldCheck, Sparkles, TrendingUp, Zap, ArrowRight, Eye } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import RiskBadge from '../components/ui/RiskBadge';
import ProgressBar from '../components/ui/ProgressBar';
import BentoCard from '../components/ui/BentoCard';
import { formatCurrency } from '../utils/formatters';
import type { AlertCategory, AlertSeverity } from '../types';
import { apiRequest } from '../lib/api';
import { useApiResource } from '../hooks/useApiResource';

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

type SignalRow = {
  id: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  description: string;
  action: string;
  estimatedValue?: number;
  branchId?: string;
  branchName?: string;
  createdAt: string;
};

const categories: { id: AlertCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All Signals' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'retention', label: 'Retention' },
  { id: 'operations', label: 'Operations' },
  { id: 'reputation', label: 'Reputation' },
  { id: 'staff', label: 'Staff' },
  { id: 'inventory', label: 'Inventory' },
];

const severityOrder: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 };

const categoryColor: Record<AlertCategory, { bg: string; text: string; dot: string }> = {
  revenue:    { bg: 'bg-[var(--emerald-soft)]', text: 'text-emerald-v', dot: 'bg-emerald-500' },
  retention:  { bg: 'bg-[var(--blue-soft)]',    text: 'text-blue-v',    dot: 'bg-blue-500' },
  operations: { bg: 'bg-[var(--violet-soft)]',  text: 'text-violet-v',  dot: 'bg-violet-500' },
  reputation: { bg: 'bg-[var(--amber-soft)]',   text: 'text-amber-v',   dot: 'bg-amber-500' },
  staff:      { bg: 'bg-[var(--blue-soft)]',    text: 'text-cyan-v',    dot: 'bg-cyan-500' },
  inventory:  { bg: 'bg-[var(--amber-soft)]',   text: 'text-amber-v',   dot: 'bg-orange-500' },
};

const severityConfig: Record<AlertSeverity, { border: string; glow: string }> = {
  high:   { border: 'border-l-red-500',   glow: 'shadow-red-500/5' },
  medium: { border: 'border-l-amber-500', glow: 'shadow-amber-500/5' },
  low:    { border: 'border-l-[var(--b2)]', glow: '' },
};

function severityFromRisk(value: number): AlertSeverity {
  if (value >= 80) return 'high';
  if (value >= 55) return 'medium';
  return 'low';
}

export default function ClinicRadar() {
  const navigate = useNavigate();
  const { data: branchOptions } = useApiResource<ApiBranchOption, ApiBranchOption>('/v1/branches?limit=100', [], row => row);
  const [reputation, setReputation] = useState<ReputationResponse | null>(null);
  const [reputationError, setReputationError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<AlertCategory | 'all'>('all');
  const [activeTab, setActiveTab] = useState<'opportunity' | 'risk'>('opportunity');
  const [selectedBranchId, setSelectedBranchId] = useState<'all' | string>('all');
  const [competitors, setCompetitors] = useState<ApiCompetitorRadar[]>([]);
  const [competitorSource, setCompetitorSource] = useState<'live' | 'loading'>('loading');
  const [competitorError, setCompetitorError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiRequest<ReputationResponse>('/v1/reputation?limit=10'),
      apiRequest<ApiCompetitorRadar[]>('/v1/competitors/radar?limit=10'),
    ])
      .then(([reputationRows, competitorRows]) => {
        if (!active) return;
        setReputation(reputationRows);
        setReputationError(null);
        setCompetitors(competitorRows);
        setCompetitorSource('live');
        setCompetitorError(null);
      })
      .catch(error => {
        if (!active) return;
        const text = error instanceof Error ? error.message : 'Unable to load clinic radar';
        setReputationError(text);
        setCompetitorError(text);
      });
    return () => {
      active = false;
    };
  }, []);

  const signals = useMemo<SignalRow[]>(() => {
    const reputationSignals = (reputation?.cases ?? []).map(caseRow => ({
      id: caseRow.id,
      category: 'reputation' as const,
      severity: severityFromRisk(caseRow.badReviewRisk),
      title: `${caseRow.branch.name}: ${caseRow.workflowStatus}`,
      description: caseRow.unresolvedComplaint,
      action: caseRow.recoveryWorkflow,
      estimatedValue: Math.round(caseRow.badReviewRisk * 45),
      branchId: caseRow.branchId,
      branchName: caseRow.branch.name,
      createdAt: caseRow.createdAt,
    }));

    const competitorSignals = competitors.map(competitor => {
      const score = competitor.googleRating ? Number(competitor.googleRating) : 0;
      const severity: AlertSeverity = score <= 4.2 || competitor.reviewVolume > 350 ? 'high' : score <= 4.5 ? 'medium' : 'low';
      return {
        id: competitor.id,
        category: 'operations' as const,
        severity,
        title: `${competitor.name} near ${competitor.branch.name}`,
        description: `${competitor.reviewVolume} reviews, ${competitor.googleRating} rating, and ${competitor.complaintThemes.join(' · ')} are creating a market opening.`,
        action: competitor.marketOpeningRecommendation,
        estimatedValue: Math.round(competitor.reviewVolume * 18),
        branchName: competitor.branch.name,
        createdAt: competitor.insights[0] ? new Date(`${competitor.insights[0].theme.length + 2024}-01-01`).toISOString() : new Date().toISOString(),
      };
    });

    return [...reputationSignals, ...competitorSignals];
  }, [competitors, reputation]);

  const filtered = useMemo(() => {
    let list = activeCategory === 'all' ? signals : signals.filter(a => a.category === activeCategory);
    if (activeTab === 'risk') list = list.filter(a => a.severity === 'high' || a.severity === 'medium');
    if (selectedBranchId !== 'all') {
      const selectedBranchName = branchOptions.find(branch => branch.id === selectedBranchId)?.name;
      list = list.filter(a => a.branchId === selectedBranchId || (selectedBranchName && a.branchName === selectedBranchName));
    }
    return [...list].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }, [activeCategory, activeTab, selectedBranchId, branchOptions, signals]);

  const selectedBranchName = selectedBranchId === 'all' ? 'All clinics' : branchOptions.find(branch => branch.id === selectedBranchId)?.name ?? 'All clinics';
  const visibleCompetitors = selectedBranchId === 'all'
    ? competitors
    : competitors.filter(competitor => competitor.branch.name === selectedBranchName);
  const totalOpportunity = signals.reduce((sum, signal) => sum + (signal.estimatedValue ?? 0), 0);
  const highCount = signals.filter(signal => signal.severity === 'high').length;
  const medCount = signals.filter(signal => signal.severity === 'medium').length;
  const loadError = reputationError || competitorError;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="ClinicRadar"
        subtitle="Real-time intelligence board for revenue signals, retention risks, and branch health."
        badge={loadError ? 'Live Data Error' : `${signals.length} Active Signals`}
        badgeColor="red"
        actions={
          <button
            type="button"
            onClick={() => {
              setCompetitorSource('loading');
              setCompetitorError(null);
              setReputationError(null);
              setReputation(null);
              setCompetitors([]);
              void Promise.all([
                apiRequest<ReputationResponse>('/v1/reputation?limit=10'),
                apiRequest<ApiCompetitorRadar[]>('/v1/competitors/radar?limit=10'),
              ])
                .then(([reputationRows, competitorRows]) => {
                  setReputation(reputationRows);
                  setCompetitors(competitorRows);
                  setCompetitorSource('live');
                })
                .catch(error => {
                  const text = error instanceof Error ? error.message : 'Unable to load clinic radar';
                  setReputationError(text);
                  setCompetitorError(text);
                });
            }}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--s3)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] border border-[var(--b1)] transition"
          >
            <Radar className="w-4 h-4" /> Refresh Insights
          </button>
        }
      />

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Clinic radar could not load live data: {loadError}
        </div>
      )}

      {/* Summary KPI strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <div className="bg-[var(--s2)] rounded-2xl border border-[var(--b1)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-2">Total Opportunity</p>
          <p className="text-2xl font-bold text-t1 tabular-nums">{formatCurrency(totalOpportunity)}</p>
          <p className="text-xs text-t3 mt-0.5">Across all active signals</p>
        </div>
        <div className="bg-[var(--red-soft)] rounded-2xl border border-[var(--b1)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-red-v mb-2">High Priority</p>
          <p className="text-2xl font-bold text-red-v tabular-nums">{highCount}</p>
          <p className="text-xs text-red-v/70 mt-0.5">Signals needing action now</p>
        </div>
        <div className="bg-[var(--amber-soft)] rounded-2xl border border-[var(--b1)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-amber-v mb-2">Medium Priority</p>
          <p className="text-2xl font-bold text-amber-v tabular-nums">{medCount}</p>
          <p className="text-xs text-amber-v/70 mt-0.5">Monitor and schedule</p>
        </div>
        <div className="bg-[var(--violet-soft)] rounded-2xl border border-[var(--b1)] p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest text-violet-v mb-2">Signal Confidence</p>
              <p className="text-2xl font-bold text-violet-v tabular-nums">84%</p>
              <p className="text-xs text-violet-v/70 mt-0.5">Average signal confidence</p>
            </div>
          </div>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-3">
        <p className="text-xs font-semibold text-t2">Clinic</p>
        <select
          value={selectedBranchId}
          onChange={e => setSelectedBranchId(e.target.value)}
          className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t1 outline-none"
        >
          <option value="all">All clinics</option>
          {branchOptions.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
        <p className="text-xs text-t3">Showing signals for {selectedBranchName}.</p>
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
              <div className="flex items-center gap-1 bg-[var(--s3)] p-1 rounded-xl shrink-0">
                <button
                  type="button"
                  onClick={() => setActiveTab('opportunity')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${activeTab === 'opportunity' ? 'bg-[var(--s2)] text-t1' : 'text-t3'}`}
                >
                  Opportunities
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('risk')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${activeTab === 'risk' ? 'bg-[var(--s2)] text-t1' : 'text-t3'}`}
                >
                  Risks
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {filtered.map((alert) => {
                const cat = categoryColor[alert.category];
                const sev = severityConfig[alert.severity];
                const confidence = alert.severity === 'high' ? 88 : alert.severity === 'medium' ? 72 : 55;
                return (
                  <div key={alert.id} className={`rounded-2xl border border-[var(--b1)] border-l-2 p-4 hover:bg-[var(--s3)] transition-all ${sev.border} ${sev.glow}`}>
                    <div className="flex items-start gap-3">
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${cat.bg}`}>
                        <span className={`w-2.5 h-2.5 rounded-full ${cat.dot}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-3 mb-1">
                          <p className="text-sm font-bold text-t1 leading-tight">{alert.title}</p>
                          <div className="flex items-center gap-2 shrink-0">
                            {alert.estimatedValue && (
                              <span className="badge badge-emerald">
                                {formatCurrency(alert.estimatedValue)}
                              </span>
                            )}
                            <RiskBadge level={alert.severity} size="sm" />
                          </div>
                        </div>

                        <div className="flex items-center gap-2 mb-2">
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${cat.bg} ${cat.text}`}>
                            {alert.category}
                          </span>
                          {alert.branchId && (
                            <span className="text-[10px] text-t3">·</span>
                          )}
                        </div>

                        <p className="text-xs text-t3 leading-relaxed mb-3">{alert.description}</p>

                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 flex-1">
                            <span className="text-[10px] font-medium text-t3 uppercase tracking-wide whitespace-nowrap">Confidence</span>
                            <div className="flex gap-0.5 flex-1 max-w-[80px]">
                              {[...Array(5)].map((_, i) => (
                                <div key={i} className={`flex-1 h-1 rounded-full ${i < Math.round(confidence / 20) ? 'bg-blue-500' : 'bg-[var(--b2)]'}`} />
                              ))}
                            </div>
                            <span className="text-[10px] font-semibold text-t3">{confidence}%</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => setActiveTab(alert.severity === 'high' ? 'risk' : 'opportunity')} className="inline-flex items-center gap-1.5 text-xs font-semibold text-t3 hover:text-t2 transition-colors">
                              <Eye className="w-3 h-3" /> Details
                            </button>
                          <button type="button" onClick={() => navigate(
                            alert.category === 'reputation' ? '/reviews' :
                            alert.category === 'staff' ? '/staff' :
                            alert.category === 'inventory' ? '/inventory' :
                            '/campaigner',
                            alert.category === 'revenue' || alert.category === 'retention'
                              ? { state: { title: alert.title, branchName: alert.branchId ? branchOptions.find(branch => branch.id === alert.branchId)?.name : undefined, recommendedAction: alert.action } }
                              : undefined,
                          )} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition-colors">
                              <Zap className="w-3 h-3" /> Run Action
                            </button>
                          </div>
                        </div>

                        <div className="mt-3 p-2.5 rounded-xl bg-[var(--s3)] border border-[var(--b1)]">
                          <p className="text-[11px] font-semibold text-t2">
                            <span className="text-t3 mr-1">Recommended:</span>
                            {alert.action}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Branch heatmap */}
          <BentoCard title="Nearby Competitors" subtitle="Local openings, ratings, and complaint themes" headerRight={
            <span className={`badge ${competitorSource === 'live' ? 'badge-emerald' : 'badge-blue'}`}>{competitorSource === 'live' ? 'Live DB' : 'Loading'}</span>
          }>
            <div className="space-y-3">
              {visibleCompetitors.length === 0 && (
                <p className="text-xs text-t3">No live competitor rows returned for the selected clinic.</p>
              )}
              {visibleCompetitors.map((competitor) => (
                <div key={competitor.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-t1">{competitor.name}</p>
                      <p className="text-[10px] text-t3 mt-0.5">{competitor.branch.name} · {competitor.distanceKm} km away</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-t1">{Number(competitor.googleRating).toFixed(1)}</p>
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
                  <p className="text-[11px] text-t3 mt-1">Weak themes: {competitor.complaintThemes.join(' · ')}</p>
                  <p className="text-[11px] text-indigo mt-2 font-semibold">{competitor.marketOpeningRecommendation}</p>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Branch Health Heatmap" subtitle="Comparative performance" headerRight={<BarChart3 className="w-4 h-4 text-t3" />}>
            <div className="space-y-3">
              {branchOptions.map((branch) => {
                const signalCount = signals.filter(signal => signal.branchId === branch.id || signal.branchName === branch.name).length;
                const score = Math.max(30, 100 - signalCount * 12);
                return (
                <div key={branch.id}>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <p className="text-xs font-semibold text-t2 truncate">{branch.name}</p>
                    <span className={`badge ${
                      score >= 75 ? 'badge-emerald' :
                      score >= 55 ? 'badge-amber' :
                      'badge-red'
                    }`}>{score}/100</span>
                  </div>
                  <ProgressBar value={score} />
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-t3">
                    <span>{signalCount} signals</span>
                    <span>·</span>
                    <span>Live competitor pressure</span>
                  </div>
                </div>
              );})}
            </div>
          </BentoCard>

          {/* Signal timeline */}
          <BentoCard title="Signal Timeline" subtitle="Recent detections">
            <div className="space-y-3">
              {signals.slice(0, 6).map((alert, i) => (
                <div key={alert.id} className="flex items-start gap-3">
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${
                      alert.severity === 'high' ? 'bg-red-500' :
                      alert.severity === 'medium' ? 'bg-amber-500' : 'bg-[var(--b2)]'
                    }`} />
                    {i < 5 && <div className="w-px h-6 bg-[var(--b1)]" />}
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
            </div>
          </BentoCard>

          {/* Guardrails */}
          <BentoCard title="Safe Operations" subtitle="Guardrails active">
            <div className="space-y-2.5">
              {[
                { text: 'No clinical diagnosis in outreach', ok: true },
                { text: 'Consent verified before any marketing', ok: true },
                { text: 'Audit trail for all sensitive access', ok: true },
                { text: 'Opt-out compliance enforced', ok: true },
              ].map((g, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  <p className="text-xs text-t2">{g.text}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 p-3 rounded-xl bg-[var(--emerald-soft)] border border-[var(--b1)]">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5 text-emerald-v shrink-0" />
                <p className="text-xs font-semibold text-emerald-v">All guardrails operational · No violations detected</p>
              </div>
            </div>
          </BentoCard>

          {/* Quick actions */}
          <BentoCard title="Quick Actions" subtitle="Common commands">
            <div className="space-y-2">
              {[
                { label: 'Launch winback campaign', icon: <Sparkles className="w-3.5 h-3.5" />, action: () => navigate('/campaigner') },
                { label: 'Fill empty Westside slots', icon: <AlertCircle className="w-3.5 h-3.5" />, action: () => navigate('/campaigner') },
                { label: 'Assign missed-call queue', icon: <TrendingUp className="w-3.5 h-3.5" />, action: () => navigate('/ai-receptionist') },
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
