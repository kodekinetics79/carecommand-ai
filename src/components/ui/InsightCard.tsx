import type { ReactNode } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';

interface InsightCardProps {
  title: string;
  description: string;
  impact?: string;
  action?: string;
  onAction?: () => void;
  icon?: ReactNode;
  variant?: 'default' | 'opportunity' | 'risk' | 'info';
  className?: string;
}

const variants = {
  default:     { border: 'border-[var(--b1)]',                     bg: 'bg-[var(--s2)]',                         accent: 'bg-[var(--indigo)]',   badge: 'badge badge-blue' },
  opportunity: { border: 'border-[rgba(52,211,153,0.2)]',           bg: 'bg-[rgba(52,211,153,0.04)]',             accent: 'bg-[var(--emerald)]',  badge: 'badge badge-emerald' },
  risk:        { border: 'border-[rgba(248,113,113,0.2)]',          bg: 'bg-[rgba(248,113,113,0.04)]',            accent: 'bg-[var(--red)]',      badge: 'badge badge-red' },
  info:        { border: 'border-[rgba(96,165,250,0.2)]',           bg: 'bg-[rgba(96,165,250,0.04)]',             accent: 'bg-[var(--indigo)]',   badge: 'badge badge-blue' },
};

export default function InsightCard({
  title, description, impact, action, onAction, icon,
  variant = 'default', className = '',
}: InsightCardProps) {
  const v = variants[variant];

  return (
    <div className={`rounded-2xl border p-4 ${v.border} ${v.bg} ${className}`}>
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 text-white ${v.accent}`}>
          {icon || <Sparkles className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-1">
            <p className="text-sm font-semibold text-t1 leading-tight">{title}</p>
            {impact && (
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${v.badge}`}>{impact}</span>
            )}
          </div>
          <p className="text-xs text-t3 leading-relaxed mb-3">{description}</p>
          <div className="flex items-center justify-between gap-3">
            {action && (
              <button
                onClick={onAction}
                className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold text-indigo hover:opacity-75 transition-opacity"
              >
                {action}
                <ArrowRight className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
