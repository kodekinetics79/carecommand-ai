import type { ReactNode } from 'react';
import { ChevronRight, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { useCountUp } from '../../hooks/useCountUp';
import type { MetricAccent } from './PremiumMetricCard';

const ICON_BG: Record<MetricAccent, string> = {
  emerald: 'stat-icon-emerald', blue: 'stat-icon-blue', violet: 'stat-icon-violet',
  amber: 'stat-icon-amber', red: 'stat-icon-red', cyan: 'stat-icon-cyan', indigo: 'stat-icon-indigo',
};
const METER_FILL: Record<MetricAccent, string> = {
  emerald: 'pf-emerald', blue: 'pf-blue', violet: 'pf-violet',
  amber: 'pf-amber', red: 'pf-red', cyan: 'pf-cyan', indigo: 'pf-indigo',
};

export interface StatTileProps {
  label: string;
  value: number;
  /** Renders the animated numeric value; e.g. formatCurrency or n => `${n}` */
  format?: (n: number) => string;
  subtitle?: string;
  icon: ReactNode;
  accent?: MetricAccent;
  /** Real period-over-period % only — null hides the delta (never faked). */
  trend?: number | null;
  /** Ratio 0–1 renders a thin meter under the value (e.g. calls recovered / total). */
  meter?: number;
  onClick?: () => void;
}

/**
 * KPI ribbon tile — stat-tile contract: label · value (proportional figures,
 * large digits look loose in tabular) · optional real delta · optional meter.
 * The whole tile is the hit target; the chevron appears on hover as the
 * "this goes somewhere" affordance.
 */
export default function StatTile({
  label, value, format = n => String(Math.round(n)), subtitle, icon, accent = 'indigo', trend = null, meter, onClick,
}: StatTileProps) {
  const animated = useCountUp(value);
  const TrendIcon = trend == null ? Minus : trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;
  const trendCls = trend == null || trend === 0 ? 'text-t3' : trend > 0 ? 'text-emerald-v' : 'text-red-v';
  const Comp = onClick ? 'button' : 'div';

  return (
    <Comp {...(onClick ? { type: 'button' as const, onClick } : {})} className="stat-tile group">
      <div className="flex items-center justify-between gap-2">
        <div className={`stat-icon ${ICON_BG[accent]}`}>{icon}</div>
        {trend != null ? (
          <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold ${trendCls}`}>
            <TrendIcon className="w-3 h-3" aria-hidden="true" />
            {trend > 0 ? '+' : ''}{trend}%
            <span className="sr-only"> versus previous period</span>
          </span>
        ) : onClick ? (
          <ChevronRight className="w-4 h-4 text-t3 stat-tile-go" aria-hidden="true" />
        ) : null}
      </div>
      <p className="text-[20px] font-bold text-t1 tracking-tight leading-none mt-2">{format(animated)}</p>
      {meter != null && (
        <div className="prog-track sm mt-1.5" role="presentation">
          <div className={`prog-fill ${METER_FILL[accent]}`} style={{ width: `${Math.max(0, Math.min(100, meter * 100))}%` }} />
        </div>
      )}
      <p className="text-[11.5px] font-semibold text-t2 mt-1.5 leading-tight">{label}<span className="sr-only">.</span> {subtitle && <span className="tile-sub font-normal text-t3">· {subtitle}</span>}</p>
    </Comp>
  );
}
