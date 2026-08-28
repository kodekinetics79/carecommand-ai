import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleDollarSign, AlertTriangle, Target, Gauge, TrendingUp, Sparkles } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import BentoCard from '../components/ui/BentoCard';
import OpportunityMetricCard from '../components/opportunity/OpportunityMetricCard';
import RevenueLeakCard from '../components/opportunity/RevenueLeakCard';
import OpportunityRankingPanel from '../components/opportunity/OpportunityRankingPanel';
import OpportunityActionDrawer from '../components/opportunity/OpportunityActionDrawer';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import { formatCurrency } from '../utils/formatters';
import { opportunityService, type RevenueLeak, type Opportunity } from '../lib/opportunityService';

export default function OpportunityCenter() {
  const navigate = useNavigate();
  const [leaks, setLeaks] = useState<RevenueLeak[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLeak, setSelectedLeak] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Opportunity | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [l, o] = await Promise.all([opportunityService.listLeaks().catch(() => []), opportunityService.listOpportunities().catch(() => [])]);
      if (active) { setLeaks(l); setOpportunities(o); setLoading(false); }
    })();
    return () => { active = false; };
  }, []);

  const metrics = useMemo(() => {
    const recoverable = leaks.reduce((s, l) => s + l.estimatedValue, 0) + opportunities.reduce((s, o) => s + o.expectedRevenue, 0);
    const recovered = opportunities.reduce((s, o) => s + o.actualRevenue, 0);
    const confidences = opportunities.map(o => o.confidence).filter(Boolean);
    const avgConfidence = confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0;
    const pendingApproval = opportunities.filter(o => o.approval === 'pending_approval').length;
    return { recoverable, recovered, avgConfidence, openLeaks: leaks.filter(l => l.status === 'open').length, ranked: opportunities.length, pendingApproval };
  }, [leaks, opportunities]);

  // Reduce duplication: selecting a leak filters the ranked actions to its category.
  const leakCategory = selectedLeak ? leaks.find(l => l.id === selectedLeak)?.category : null;
  const rankedShown = leakCategory ? opportunities.filter(o => o.category === leakCategory) : opportunities;

  const onChanged = (updated: Opportunity) => {
    setOpportunities(prev => prev.map(o => o.id === updated.id ? updated : o));
    setDrawer(updated);
  };

  return (
    <div className="space-y-6 pb-8 animate-fade-up">
      <PageHeader
        title="Revenue Recovery Engine"
        subtitle="Detected leaks → ranked recovery actions → governed execution"
        actions={
          <button type="button" onClick={() => navigate('/revenue-protection')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(99,102,241,0.25)] hover:opacity-90 transition">
            <TrendingUp className="w-4 h-4" /> Revenue Protection
          </button>
        }
      />

      {/* Command metrics */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <OpportunityMetricCard primary label="Recoverable revenue" value={metrics.recoverable} format={formatCurrency} subtitle="Across leaks + opportunities" icon={<CircleDollarSign className="w-4 h-4" />} accent="emerald" />
        <OpportunityMetricCard label="Detected leaks" value={metrics.openLeaks} subtitle="Open problems" icon={<AlertTriangle className="w-4 h-4" />} accent="amber" />
        <OpportunityMetricCard label="Ranked opportunities" value={metrics.ranked} subtitle={`${metrics.pendingApproval} need approval`} icon={<Target className="w-4 h-4" />} accent="violet" />
        <OpportunityMetricCard label="Avg AI confidence" value={metrics.avgConfidence} format={n => `${Math.round(n)}%`} subtitle="Across recovery actions" icon={<Gauge className="w-4 h-4" />} accent="cyan" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[400px_1fr] items-start">
        {/* LEFT — Detected leaks (the problem) */}
        <BentoCard title="Detected Leaks" subtitle="Where revenue is escaping"
          headerRight={selectedLeak ? <button type="button" onClick={() => setSelectedLeak(null)} className="text-[11px] font-semibold text-indigo hover:opacity-80">Clear filter</button> : <span className="badge badge-amber">{metrics.openLeaks} open</span>}>
          {loading ? (
            <div className="space-y-2.5">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton-line h-24 rounded-xl" />)}</div>
          ) : leaks.length === 0 ? (
            <EmptyStatePremium icon={<AlertTriangle className="w-5 h-5" />} title="No revenue leaks detected" description="CareCommand continuously scans for missed revenue. Detected leaks will appear here." />
          ) : (
            <div className="space-y-2.5">
              {leaks.map(l => <RevenueLeakCard key={l.id} leak={l} selected={selectedLeak === l.id} onSelect={() => setSelectedLeak(selectedLeak === l.id ? null : l.id)} />)}
            </div>
          )}
        </BentoCard>

        {/* RIGHT — Ranked recovery actions (opportunity → workflow) */}
        <div className="sticky-rail">
          <BentoCard title="Ranked Recovery Actions" subtitle={leakCategory ? `Filtered to: ${leakCategory.replace(/-/g, ' ')}` : 'AI-ranked by recoverable value'}
            headerRight={<span className="inline-flex items-center gap-1 text-[11px] font-bold text-violet-v"><Sparkles className="w-3.5 h-3.5" /> AI-ranked</span>}>
            <OpportunityRankingPanel
              opportunities={rankedShown}
              loading={loading}
              selectedId={drawer?.id ?? null}
              onOpen={setDrawer}
              onCreate={() => navigate('/campaigner')}
            />
          </BentoCard>
        </div>
      </div>

      {drawer && (
        <OpportunityActionDrawer
          opportunity={drawer}
          onClose={() => setDrawer(null)}
          onChanged={onChanged}
          onNavigate={(r) => { setDrawer(null); navigate(r); }}
        />
      )}
    </div>
  );
}
