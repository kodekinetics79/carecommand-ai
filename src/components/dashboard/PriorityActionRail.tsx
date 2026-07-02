import { useMemo, useState } from 'react';
import { ChevronRight, Zap, ShieldAlert, Flame, CircleDot } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import type { PriorityAction, ActionCategory, Severity } from '../../lib/dashboardService';
import EmptyStatePremium from '../ui/EmptyStatePremium';

const FILTERS: Array<{ id: 'all' | ActionCategory; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'revenue', label: 'Revenue' }, { id: 'no_shows', label: 'No-shows' },
  { id: 'missed_calls', label: 'Missed Calls' }, { id: 'insurance', label: 'Insurance' }, { id: 'payments', label: 'Payments' },
  { id: 'device_alerts', label: 'Device Alerts' }, { id: 'reputation', label: 'Reputation' },
];

const SEV: Record<Severity, { ring: string; dot: string; label: string; icon: typeof Flame }> = {
  critical: { ring: 'sev-critical', dot: 'text-red-v', label: 'Critical', icon: ShieldAlert },
  high: { ring: 'sev-high', dot: 'text-amber-v', label: 'High', icon: Flame },
  medium: { ring: 'sev-medium', dot: 'text-blue-v', label: 'Medium', icon: CircleDot },
  low: { ring: 'sev-low', dot: 'text-emerald-v', label: 'Low', icon: CircleDot },
};

/**
 * Priority queue — the cockpit's right rail. Fixed header (revenue at stake)
 * and filters; the queue itself scrolls internally so the page never does.
 */
export default function PriorityActionRail({
  actions, loading, onOpen, onCta, onCreateCampaign,
}: {
  actions: PriorityAction[]; loading?: boolean;
  onOpen: (a: PriorityAction) => void; onCta: (a: PriorityAction) => void; onCreateCampaign: () => void;
}) {
  const [filter, setFilter] = useState<'all' | ActionCategory>('all');
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: actions.length };
    for (const a of actions) c[a.category] = (c[a.category] ?? 0) + 1;
    return c;
  }, [actions]);
  const atStake = useMemo(() => actions.reduce((s, a) => s + (a.revenueImpact ?? 0), 0), [actions]);
  const rows = filter === 'all' ? actions : actions.filter(a => a.category === filter);

  return (
    <div className="cc-card h-full flex flex-col overflow-hidden">
      <div className="bento-header shrink-0">
        <div>
          <p className="bento-title">Priority Queue</p>
          <p className="text-[11px] text-t3 mt-0.5">AI-ranked by revenue impact</p>
        </div>
        {atStake > 0 && (
          <div className="text-right shrink-0">
            <p className="text-[15px] font-bold text-t1 leading-none">{formatCurrency(atStake)}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-t3 mt-0.5">at stake</p>
          </div>
        )}
      </div>

      {/* Filters — fixed above the scrolling queue */}
      <div className="px-3.5 pt-2.5 pb-1 flex flex-wrap gap-1.5 shrink-0" role="tablist" aria-label="Filter priority actions">
        {FILTERS.map(f => {
          const n = counts[f.id] ?? 0;
          const on = filter === f.id;
          if (f.id !== 'all' && n === 0) return null;
          return (
            <button key={f.id} type="button" role="tab" aria-selected={on} onClick={() => setFilter(f.id)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${on ? 'bg-[var(--indigo)] text-white' : 'bg-[var(--s3)] text-t2 hover:bg-[var(--s4)]'}`}>
              {f.label}{f.id === 'all' ? ` ${counts.all}` : ` ${n}`}
            </button>
          );
        })}
      </div>

      <div className="flex-auto min-h-0 overflow-y-auto px-3.5 py-2.5 space-y-2.5">
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton-line h-20 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyStatePremium icon={<Zap className="w-5 h-5" />} title="No open priorities here"
            description="Nothing needs attention in this category right now. Launch a campaign to keep momentum."
            cta={{ label: 'Launch a campaign', onClick: onCreateCampaign }} />
        ) : rows.map(a => <PriorityActionCard key={a.id} action={a} onOpen={onOpen} onCta={onCta} />)}
      </div>
    </div>
  );
}

export function PriorityActionCard({ action, onOpen, onCta }: { action: PriorityAction; onOpen: (a: PriorityAction) => void; onCta: (a: PriorityAction) => void }) {
  const sev = SEV[action.severity];
  const SevIcon = sev.icon;
  return (
    <div className={`rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3 transition-shadow hover:shadow-[0_4px_12px_rgba(15,23,42,0.07)] ${sev.ring}`}>
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={() => onOpen(action)} className="text-left min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <SevIcon className={`w-3.5 h-3.5 shrink-0 ${sev.dot}`} aria-hidden="true" />
            <span className="text-[10px] font-bold uppercase tracking-wide text-t3">{sev.label}</span>
          </div>
          <p className="text-[13px] font-bold text-t1 leading-tight mt-1">{action.title}</p>
        </button>
        {action.revenueImpact != null && (
          <div className="text-right shrink-0">
            <p className="text-[13px] font-bold text-t1 leading-none">{formatCurrency(action.revenueImpact)}</p>
            <p className="text-[9.5px] font-semibold uppercase tracking-wide text-t3 mt-0.5">impact</p>
          </div>
        )}
      </div>
      {action.description && <p className="text-[11px] text-t3 mt-1 leading-relaxed line-clamp-2">{action.description}</p>}
      <div className="flex items-center justify-between gap-2 mt-2">
        <span className="text-[10px] text-t3 inline-flex items-center gap-1 min-w-0">
          <Zap className="w-3 h-3 text-violet-v shrink-0" aria-hidden="true" />
          {action.aiConfidence}% confidence · <span className="truncate">{action.owner}</span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={() => onCta(action)}
            className="inline-flex items-center gap-1 rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 transition">
            {action.cta.label}
          </button>
          <button type="button" onClick={() => onOpen(action)} aria-label="View details"
            className="inline-flex items-center justify-center w-6 h-6 rounded-lg border border-[var(--b1)] text-t2 hover:text-t1 hover:bg-[var(--s2)] transition">
            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </span>
      </div>
    </div>
  );
}
