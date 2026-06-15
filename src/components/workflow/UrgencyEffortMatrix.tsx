import type { Urgency, Effort } from '../../lib/opportunityService';

// Compact urgency × effort positioning. "Quick win" = high urgency + low effort.
const RANK: Record<string, number> = { high: 2, medium: 1, low: 0 };

export default function UrgencyEffortMatrix({ urgency, effort }: { urgency: Urgency; effort: Effort }) {
  const quadrant = (() => {
    const u = RANK[urgency], e = RANK[effort];
    if (u >= 1 && e === 0) return { label: 'Quick win', cls: 'badge-emerald' };
    if (u >= 1 && e >= 1) return { label: 'Major project', cls: 'badge-amber' };
    if (u === 0 && e === 0) return { label: 'Fill-in', cls: 'badge-blue' };
    return { label: 'Deprioritize', cls: 'badge-blue' };
  })();
  return (
    <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-t3">Urgency × Effort</span>
        <span className={`badge ${quadrant.cls}`}>{quadrant.label}</span>
      </div>
      <div className="flex items-center gap-3 mt-1.5 text-[11px]">
        <span className="text-t2">Urgency: <span className="font-semibold capitalize text-t1">{urgency}</span></span>
        <span className="text-t2">Effort: <span className="font-semibold capitalize text-t1">{effort}</span></span>
      </div>
    </div>
  );
}
