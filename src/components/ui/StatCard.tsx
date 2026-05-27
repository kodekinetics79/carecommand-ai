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
  accent?: 'blue' | 'emerald' | 'violet' | 'amber' | 'red' | 'cyan' | 'indigo';
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export default function StatCard({
  title, value, subtitle, trend, trendLabel, icon,
  accent = 'blue', onClick, size = 'md', className = '',
}: StatCardProps) {
  return (
    <div
      onClick={onClick}
      className={`cc-card p-4 flex flex-col gap-3 ${onClick ? 'cursor-pointer' : ''} ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        {icon && (
          <div className={`stat-icon stat-icon-${accent}`}>{icon}</div>
        )}
        {trend !== undefined && (
          <span className={`ml-auto ${trend >= 0 ? 'trend-up' : 'trend-down'}`}>
            {trend >= 0 ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>

      <div>
        <p className={`font-bold tabular-nums leading-none tracking-tight text-t1 ${size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl'}`}>
          {value}
        </p>
        <p className="text-[11px] font-medium mt-1.5 text-t3">{title}</p>
        {(subtitle ?? trendLabel) && (
          <p className="text-[10px] mt-0.5 text-t3">{subtitle ?? trendLabel}</p>
        )}
      </div>
    </div>
  );
}
