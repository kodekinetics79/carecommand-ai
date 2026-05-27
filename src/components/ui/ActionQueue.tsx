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

const urgencyStyles: Record<string, string> = {
  high: 'urgency-high',
  medium: 'urgency-medium',
  low: 'urgency-low',
};

export default function ActionQueue({ items, title, subtitle, maxItems = 5 }: ActionQueueProps) {
  return (
    <div>
      {(title || subtitle) && (
        <div className="mb-4">
          {subtitle && <p className="text-[10px] font-semibold uppercase tracking-widest text-t3 mb-0.5">{subtitle}</p>}
          {title && <h3 className="text-sm font-bold text-t1">{title}</h3>}
        </div>
      )}
      <div className="space-y-2.5">
        {items.slice(0, maxItems).map((item) => (
          <div
            key={item.id}
            className={`rounded-xl p-4 ${item.urgency ? urgencyStyles[item.urgency] : 'border border-[var(--indigo-mid)] bg-[var(--indigo-soft)]'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                {item.icon && (
                  <div className="w-7 h-7 rounded-lg bg-[var(--s3)] flex items-center justify-center shrink-0 text-t2">
                    {item.icon}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-t1 leading-tight">{item.title}</p>
                  <p className="text-xs text-t3 mt-0.5 leading-relaxed">{item.description}</p>
                </div>
              </div>
              {item.impact && (
                <span className="badge badge-emerald shrink-0">{item.impact}</span>
              )}
            </div>
            <button
              onClick={item.onAction}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition-opacity"
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
