import { Sparkles, ArrowUpRight, Megaphone, Shield, ShieldAlert, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import { useCountUp } from '../../hooks/useCountUp';
import { formatCurrency } from '../../utils/formatters';
import type { DashboardSummary } from '../../lib/dashboardService';

export interface SparkPoint { label: string; value: number }

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

/**
 * Command Deck — the cockpit's slim hero band. One glance carries: the day's
 * narrative + risk read (left), the hero revenue figure with a real sparkline
 * (center-right, clickable → full report), and three actionable stat chips.
 */
export default function CommandDeck({
  summary, spark, onNavigate,
}: {
  summary: DashboardSummary;
  /** Chronological monthly revenue points; sparkline hides when < 2 (never faked). */
  spark: SparkPoint[];
  onNavigate: (route: string) => void;
}) {
  const risk = riskFrom(summary);
  const RiskIcon = risk.icon;
  const hero = useCountUp(summary.networkRevenue);
  const trend = summary.networkRevenueTrend ?? null;
  const TrendIcon = trend != null && trend < 0 ? TrendingDown : TrendingUp;

  const chips: Array<{ label: string; value: string; dot: string; route: string }> = [
    { label: 'Auto-recovered', value: formatCurrency(summary.revenueRecovered), dot: 'bg-[var(--emerald)]', route: '/revenue-protection' },
    { label: 'Open opportunity', value: formatCurrency(summary.activeOpportunities), dot: 'bg-[var(--violet)]', route: '/opportunities' },
    { label: 'Awaiting approval', value: String(summary.pendingApprovals), dot: 'bg-[var(--blue)]', route: '/autopilot' },
  ];

  return (
    <section className="command-deck px-5 py-4 h-full" aria-label="Today's briefing">
      <div className="command-deck-grid" aria-hidden="true" />

      <div className="relative grid gap-x-8 gap-y-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        {/* Narrative + actions */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--emerald)] live-dot" aria-hidden="true" />
            <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-indigo">Today's briefing</p>
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ${riskStyles[risk.level]}`}>
              <RiskIcon className="w-3 h-3" aria-hidden="true" /> Risk: {risk.label}
            </span>
          </div>
          <h2 className="text-[16.5px] font-bold text-t1 leading-snug tracking-tight">
            {formatCurrency(summary.revenueRecovered)} recovered this month — {formatCurrency(summary.activeOpportunities)} still on the table.
          </h2>
          <div className="flex flex-wrap items-center gap-2.5 mt-3">
            <button type="button" onClick={() => onNavigate('/advisory')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 transition">
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> Ask Advisors
            </button>
            <button type="button" onClick={() => onNavigate('/campaigner')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-t1 hover:bg-[var(--s2)] transition">
              <Megaphone className="w-3.5 h-3.5 text-t3" aria-hidden="true" /> Launch Campaign
            </button>
          </div>
        </div>

        {/* Hero figure + sparkline — the whole block opens the full report */}
        <button type="button" onClick={() => onNavigate('/revenue')}
          className="text-left xl:text-right xl:border-l xl:border-[var(--b1)] xl:pl-6 group cursor-pointer"
          aria-label={`Network revenue this month ${formatCurrency(summary.networkRevenue)} — open full report`}>
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-t3 group-hover:text-t2 transition">
            Network revenue · this month <ArrowUpRight className="w-3 h-3 inline-block opacity-0 group-hover:opacity-100 transition" aria-hidden="true" />
          </p>
          <div className="flex items-baseline gap-2 xl:justify-end mt-1">
            <p className="hero-figure">{formatCurrency(hero)}</p>
            {trend != null && (
              <span className={`inline-flex items-center gap-0.5 text-[12px] font-bold ${trend >= 0 ? 'text-emerald-v' : 'text-red-v'}`}>
                <TrendIcon className="w-3.5 h-3.5" aria-hidden="true" />
                {trend > 0 ? '+' : ''}{trend}%
                <span className="sr-only"> versus previous period</span>
              </span>
            )}
          </div>
          {spark.length >= 2 && (
            <div className="mt-1.5 xl:ml-auto w-[220px] max-w-full">
              <Sparkline points={spark} />
              <p className="spark-caption text-[10px] text-t3 mt-0.5">Monthly revenue · last {spark.length} periods</p>
            </div>
          )}
        </button>

      </div>

      {/* Actionable stat chips — full-width row so labels never truncate */}
      <div className="deck-chips relative grid gap-2.5 sm:grid-cols-3 mt-4">
        {chips.map(c => (
          <button key={c.label} type="button" onClick={() => onNavigate(c.route)}
            className="deck-chip text-left cursor-pointer group hover:border-[var(--b2)]" aria-label={`${c.label}: ${c.value} — open`}>
            <span className={`deck-dot ${c.dot}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 flex items-baseline gap-2">
              <span className="text-[14px] font-bold text-t1 leading-tight whitespace-nowrap">{c.value}</span>
              <span className="text-[10.5px] text-t3 truncate">{c.label}</span>
            </span>
            <ArrowUpRight className="hidden 2xl:block w-3.5 h-3.5 text-t3 opacity-0 group-hover:opacity-100 transition shrink-0" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

/** 2px line, ~8% area wash, ≥8px end-dot with a 2px surface ring — real data only. */
function Sparkline({ points }: { points: SparkPoint[] }) {
  const w = 220, h = 40, pad = 5;
  const vals = points.map(p => p.value);
  const min = Math.min(...vals);
  const range = Math.max(...vals) - min || 1;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (points.length - 1);
  const y = (v: number) => pad + (h - pad * 2) * (1 - (v - min) / range);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-10" role="img"
      aria-label={`Monthly revenue trend from ${points[0].label} to ${last.label}, latest ${formatCurrency(last.value)}`}>
      <path d={`${line} L${x(points.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`} fill="var(--indigo)" opacity={0.08} />
      <path d={line} fill="none" stroke="var(--indigo)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(points.length - 1)} cy={y(last.value)} r={4} fill="var(--indigo)" stroke="#FFFFFF" strokeWidth={2} />
    </svg>
  );
}
