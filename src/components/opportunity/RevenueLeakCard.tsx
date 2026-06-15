import { AlertTriangle } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import ConfidenceBadge from '../workflow/ConfidenceBadge';
import type { RevenueLeak } from '../../lib/opportunityService';

const CAT_LABEL: Record<string, string> = {
  'inactive-patients': 'Inactive patients', 'no-show': 'No-shows', 'front-desk': 'Front desk',
  'insurance': 'Insurance', 'payments': 'Payments', 'reputation': 'Reputation', 'scheduling': 'Scheduling',
};

export default function RevenueLeakCard({ leak, selected, onSelect }: { leak: RevenueLeak; selected: boolean; onSelect: (l: RevenueLeak) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(leak)}
      aria-pressed={selected ? 'true' : 'false'}
      className={`hover-lift w-full text-left rounded-xl border p-3.5 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--indigo)] focus-visible:outline-offset-2 ${
        selected ? 'border-[var(--indigo)] bg-[var(--indigo-soft)] ring-1 ring-[var(--indigo-mid)]' : 'border-[var(--b1)] bg-[var(--s1)] hover:border-[var(--b2)]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-v shrink-0" aria-hidden="true" />
          <span className="text-[10px] font-bold uppercase tracking-wide text-t3 truncate">{CAT_LABEL[leak.category] ?? leak.category}</span>
        </div>
        <span className="text-sm font-bold text-t1 shrink-0 tabular-nums">{formatCurrency(leak.estimatedValue)}</span>
      </div>
      <p className="text-[13px] font-semibold text-t1 mt-1 leading-tight">{leak.source}</p>
      <p className="text-[11px] text-t2 mt-0.5 leading-relaxed line-clamp-2">{leak.evidence}</p>
      <div className="flex items-center gap-2 mt-2">
        <ConfidenceBadge value={leak.confidence} size="xs" />
        <span className="text-[10px] text-t3">{leak.branch}</span>
      </div>
    </button>
  );
}
