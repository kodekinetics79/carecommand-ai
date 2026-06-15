import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useCountUp } from '../../hooks/useCountUp';

export type MetricAccent = 'emerald' | 'blue' | 'violet' | 'amber' | 'red' | 'cyan' | 'indigo';

const ICON_BG: Record<MetricAccent, string> = {
  emerald: 'stat-icon-emerald', blue: 'stat-icon-blue', violet: 'stat-icon-violet',
  amber: 'stat-icon-amber', red: 'stat-icon-red', cyan: 'stat-icon-cyan', indigo: 'stat-icon-indigo',
};

export interface PremiumMetricCardProps {
  label: string;
  value: number;
  /** Renders the animated numeric value; e.g. formatCurrency or n => `${n}` */
  format?: (n: number) => string;
  subtitle?: string;
  icon: ReactNode;
  accent?: MetricAccent;
  /** Percentage trend vs previous period; null hides the indicator */
  trend?: number | null;
  /** Visual emphasis for primary KPIs */
  primary?: boolean;
  onClick?: () => void;
}

export default function PremiumMetricCard({
  label, value, format = n => String(Math.round(n)), subtitle, icon, accent = 'indigo', trend = null, primary = false, onClick,
}: PremiumMetricCardProps) {
  const animated = useCountUp(value);
  const TrendIcon = trend == null ? Minus : trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;
  const trendCls = trend == null ? 'text-t3' : trend > 0 ? 'text-emerald-v' : trend < 0 ? 'text-red-v' : 'text-t3';
  const Comp = onClick ? 'button' : 'div';

  return (
    <Comp
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`metric-card text-left w-full ${primary ? 'p-4' : 'p-3.5'} ${onClick ? 'cursor-pointer' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className={`stat-icon ${ICON_BG[accent]}`}>{icon}</div>
        {trend != null && (
          <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold ${trendCls}`}>
            <TrendIcon className="w-3 h-3" aria-hidden="true" />
            {trend > 0 ? '+' : ''}{trend}%
            <span className="sr-only"> versus previous period</span>
          </span>
        )}
      </div>
      <p className={`${primary ? 'text-2xl' : 'text-xl'} font-bold text-t1 tracking-tight tabular-nums mt-2`}>{format(animated)}</p>
      <p className="text-[12px] font-semibold text-t2 mt-0.5">{label}</p>
      {subtitle && <p className="text-[11px] text-t3 mt-0.5">{subtitle}</p>}
    </Comp>
  );
}
