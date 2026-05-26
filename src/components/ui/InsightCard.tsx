import type { ReactNode } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';

interface InsightCardProps {
  title: string;
  description: string;
  impact?: string;
  confidence?: number;
  action?: string;
  onAction?: () => void;
  icon?: ReactNode;
  variant?: 'default' | 'opportunity' | 'risk' | 'info';
  className?: string;
}

const variants = {
  default: { border: 'border-slate-200', bg: 'bg-white', accent: 'bg-blue-600', badge: 'bg-slate-100 text-slate-600' },
  opportunity: { border: 'border-emerald-200/60', bg: 'bg-gradient-to-br from-emerald-50/80 to-white', accent: 'bg-emerald-600', badge: 'bg-emerald-100 text-emerald-700' },
  risk: { border: 'border-red-200/60', bg: 'bg-gradient-to-br from-red-50/60 to-white', accent: 'bg-red-500', badge: 'bg-red-100 text-red-700' },
  info: { border: 'border-blue-200/60', bg: 'bg-gradient-to-br from-blue-50/60 to-white', accent: 'bg-blue-600', badge: 'bg-blue-100 text-blue-700' },
};

export default function InsightCard({
  title, description, impact, confidence, action, onAction, icon,
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
            <p className="text-sm font-semibold text-slate-900 leading-tight">{title}</p>
            {impact && (
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${v.badge}`}>{impact}</span>
            )}
          </div>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">{description}</p>
          <div className="flex items-center justify-between gap-3">
            {confidence !== undefined && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wide">AI confidence</span>
                <div className="flex gap-0.5">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className={`w-5 h-1.5 rounded-full ${i < Math.round(confidence / 20) ? 'bg-blue-500' : 'bg-slate-200'}`} />
                  ))}
                </div>
                <span className="text-[10px] font-semibold text-slate-500">{confidence}%</span>
              </div>
            )}
            {action && (
              <button
                onClick={onAction}
                className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 transition-colors"
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
