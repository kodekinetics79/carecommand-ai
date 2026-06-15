import { Sparkles, ArrowRight, ShieldAlert, ShieldCheck, Shield } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import type { DashboardSummary } from '../../lib/dashboardService';

type RiskLevel = 'low' | 'elevated' | 'high';
function riskFrom(summary: DashboardSummary): { level: RiskLevel; label: string; icon: typeof Shield } {
  const score = summary.noShowRisk * 2 + summary.missedCalls;
  if (score >= 50) return { level: 'high', label: 'High', icon: ShieldAlert };
  if (score >= 25) return { level: 'elevated', label: 'Elevated', icon: Shield };
  return { level: 'low', label: 'Low', icon: ShieldCheck };
}
const riskStyles: Record<RiskLevel, string> = {
  low: 'text-emerald-700 bg-emerald-50 ring-emerald-600/20',
  elevated: 'text-amber-700 bg-amber-50 ring-amber-600/20',
  high: 'text-red-700 bg-red-50 ring-red-600/20',
};

export default function AIBriefingCard({
  summary, onAskAdvisors, onViewReport,
}: {
  summary: DashboardSummary; onAskAdvisors: () => void; onViewReport: () => void;
}) {
  const risk = riskFrom(summary);
  const RiskIcon = risk.icon;
  const stats: Array<{ label: string; value: string; accent?: boolean }> = [
    { label: 'Recovered revenue', value: formatCurrency(summary.revenueRecovered), accent: true },
    { label: 'Open opportunity', value: formatCurrency(summary.activeOpportunities) },
    { label: 'Network revenue', value: formatCurrency(summary.networkRevenue) },
    { label: 'Priority actions', value: String(summary.pendingApprovals) },
  ];

  return (
    <section className="ai-briefing" aria-label="Today's AI Briefing">
      <div className="ai-briefing-glow" aria-hidden="true" />
      <div className="relative flex flex-col lg:flex-row lg:items-end justify-between gap-6">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-[var(--indigo-soft)] ring-1 ring-[var(--indigo-mid)]">
              <Sparkles className="w-3 h-3 text-indigo" aria-hidden="true" />
            </span>
            <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-indigo">Today's AI Briefing</p>
          </div>
          <h2 className="text-xl font-bold text-t1 leading-snug tracking-tight">
            {formatCurrency(summary.revenueRecovered)} recovered this month, with {formatCurrency(summary.activeOpportunities)} in open opportunity.
          </h2>
          <p className="text-[12.5px] text-t2 leading-relaxed mt-1.5">
            {summary.pendingApprovals} governed action{summary.pendingApprovals === 1 ? '' : 's'} await review and {summary.missedCalls} missed calls need follow-up.
            Open the advisory team for a revenue, growth, front-desk, or operations read-out.
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-3.5">
            <button type="button" onClick={onAskAdvisors}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition">
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> Ask Advisors
            </button>
            <button type="button" onClick={onViewReport}
              className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-indigo hover:opacity-75 transition">
              View full report <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Primary metrics + risk level */}
        <div className="shrink-0 w-full lg:w-auto">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 lg:text-right">
            {stats.map(s => (
              <div key={s.label}>
                <p className={`text-lg font-bold tabular-nums ${s.accent ? 'text-indigo' : 'text-t1'}`}>{s.value}</p>
                <p className="text-[10px] uppercase tracking-wider text-t3">{s.label}</p>
              </div>
            ))}
          </div>
          <div className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-bold ring-1 ${riskStyles[risk.level]}`}>
            <RiskIcon className="w-3.5 h-3.5" aria-hidden="true" />
            Risk level: {risk.label}
          </div>
        </div>
      </div>
    </section>
  );
}
