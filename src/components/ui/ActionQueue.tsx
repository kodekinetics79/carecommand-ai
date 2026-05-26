import { Zap, ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';

interface ActionItem {
  id: string;
  title: string;
  description: string;
  impact?: string;
  urgency?: 'high' | 'medium' | 'low';
  action: string;
  icon?: ReactNode;
  onAction?: () => void;
}

interface ActionQueueProps {
  items: ActionItem[];
  title?: string;
  subtitle?: string;
  maxItems?: number;
}

const urgencyStyles = {
  high: 'border-l-red-500',
  medium: 'border-l-amber-500',
  low: 'border-l-emerald-500',
};

export default function ActionQueue({ items, title, subtitle, maxItems = 5 }: ActionQueueProps) {
  return (
    <div>
      {(title || subtitle) && (
        <div className="mb-4">
          {subtitle && <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-0.5">{subtitle}</p>}
          {title && <h3 className="text-sm font-bold text-slate-900">{title}</h3>}
        </div>
      )}
      <div className="space-y-2.5">
        {items.slice(0, maxItems).map((item) => (
          <div
            key={item.id}
            className={`rounded-xl border border-slate-200 p-4 border-l-2 hover:shadow-sm transition-all ${item.urgency ? urgencyStyles[item.urgency] : 'border-l-blue-500'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                {item.icon && (
                  <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center shrink-0 text-slate-600">
                    {item.icon}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 leading-tight">{item.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.description}</p>
                </div>
              </div>
              {item.impact && (
                <span className="shrink-0 text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">{item.impact}</span>
              )}
            </div>
            <button
              onClick={item.onAction}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors"
            >
              <Zap className="w-3 h-3" />
              {item.action}
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
