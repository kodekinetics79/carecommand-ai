import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: number; // percent change, positive = up
  trendLabel?: string;
  icon?: ReactNode;
  iconBg?: string;
  highlight?: 'green' | 'red' | 'amber' | 'blue' | 'violet';
  onClick?: () => void;
}

const highlightBorders: Record<string, string> = {
  green: 'border-t-emerald-500',
  red: 'border-t-red-500',
  amber: 'border-t-amber-500',
  blue: 'border-t-blue-500',
  violet: 'border-t-violet-500',
};

export default function MetricCard({ title, value, subtitle, trend, trendLabel, icon, iconBg, highlight, onClick }: MetricCardProps) {
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow ${onClick ? 'cursor-pointer' : ''} ${highlight ? `border-t-2 ${highlightBorders[highlight]}` : ''}`}
    >
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{title}</p>
        {icon && (
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${iconBg || 'bg-slate-100'}`}>
            {icon}
          </div>
        )}
      </div>
      <div className="text-2xl font-bold text-slate-900 mb-1">{value}</div>
      <div className="flex items-center gap-1.5">
        {trend !== undefined && (
          <div className={`flex items-center gap-0.5 text-xs font-medium ${trend >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
            {trend >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {Math.abs(trend)}%
          </div>
        )}
        {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
        {trendLabel && <p className="text-xs text-slate-400">{trendLabel}</p>}
      </div>
    </div>
  );
}
