import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: number;
  trendLabel?: string;
  icon?: ReactNode;
  iconColor?: string;
  accent?: 'blue' | 'emerald' | 'violet' | 'amber' | 'red' | 'cyan';
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const accents = {
  blue: { icon: 'bg-blue-100 text-blue-600', border: 'border-blue-500/30', glow: 'shadow-blue-500/5' },
  emerald: { icon: 'bg-emerald-100 text-emerald-600', border: 'border-emerald-500/30', glow: 'shadow-emerald-500/5' },
  violet: { icon: 'bg-violet-100 text-violet-600', border: 'border-violet-500/30', glow: 'shadow-violet-500/5' },
  amber: { icon: 'bg-amber-100 text-amber-600', border: 'border-amber-500/30', glow: 'shadow-amber-500/5' },
  red: { icon: 'bg-red-100 text-red-600', border: 'border-red-500/30', glow: 'shadow-red-500/5' },
  cyan: { icon: 'bg-cyan-100 text-cyan-600', border: 'border-cyan-500/30', glow: 'shadow-cyan-500/5' },
};

export default function StatCard({
  title, value, subtitle, trend, trendLabel, icon, iconColor,
  accent = 'blue', onClick, size = 'md', className = '',
}: StatCardProps) {
  const a = accents[accent];
  const isLg = size === 'lg';

  return (
    <div
      onClick={onClick}
      className={`
        group relative bg-white rounded-2xl border border-slate-200/80 p-5
        shadow-sm hover:shadow-md transition-all duration-200
        ${onClick ? 'cursor-pointer hover:-translate-y-0.5' : ''}
        ${className}
      `}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider leading-tight">{title}</p>
        {icon && (
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${iconColor || a.icon}`}>
            {icon}
          </div>
        )}
      </div>

      <div className={`font-bold text-slate-900 mb-1.5 tabular-nums ${isLg ? 'text-3xl' : 'text-2xl'}`}>
        {value}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {trend !== undefined && (
          <span className={`inline-flex items-center gap-0.5 text-xs font-semibold rounded-full px-2 py-0.5 ${
            trend >= 0 ? 'text-emerald-700 bg-emerald-50' : 'text-red-600 bg-red-50'
          }`}>
            {trend >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {Math.abs(trend)}%
          </span>
        )}
        {(subtitle || trendLabel) && (
          <p className="text-xs text-slate-400">{subtitle || trendLabel}</p>
        )}
      </div>
    </div>
  );
}
