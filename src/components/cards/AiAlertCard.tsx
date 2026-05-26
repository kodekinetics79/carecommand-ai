import type { RadarAlert } from '../../types';
import { getSeverityBg, getSeverityDot } from '../../utils/formatters';
import { Zap, X, DollarSign } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';

interface AiAlertCardProps {
  alert: RadarAlert;
  onDismiss?: (id: string) => void;
  onAction?: (alert: RadarAlert) => void;
}

const categoryColors: Record<string, string> = {
  revenue: 'text-emerald-600 bg-emerald-50',
  operations: 'text-blue-600 bg-blue-50',
  retention: 'text-violet-600 bg-violet-50',
  reputation: 'text-amber-600 bg-amber-50',
  staff: 'text-slate-600 bg-slate-100',
  inventory: 'text-orange-600 bg-orange-50',
};

export default function AiAlertCard({ alert, onDismiss, onAction }: AiAlertCardProps) {
  return (
    <div className={`border rounded-xl p-4 ${getSeverityBg(alert.severity)} relative`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${getSeverityDot(alert.severity)}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md ${categoryColors[alert.category] || 'text-slate-600 bg-slate-100'}`}>
              {alert.category}
            </span>
          </div>
          <h4 className="text-sm font-semibold text-slate-900 mb-1 leading-snug">{alert.title}</h4>
          <p className="text-xs text-slate-600 leading-relaxed mb-3">{alert.description}</p>
          {alert.estimatedValue && (
            <div className="flex items-center gap-1 text-emerald-700 text-xs font-semibold mb-2">
              <DollarSign className="w-3 h-3" />
              Estimated value: {formatCurrency(alert.estimatedValue)}
            </div>
          )}
          <button
            onClick={() => onAction?.(alert)}
            className="flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:text-blue-800 bg-white border border-blue-200 px-3 py-1.5 rounded-lg transition-colors"
          >
            <Zap className="w-3 h-3" />
            {alert.action}
          </button>
        </div>
        {onDismiss && (
          <button onClick={() => onDismiss(alert.id)} className="text-slate-400 hover:text-slate-600 transition-colors mt-0.5">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
