import { ArrowUpRight, CircleCheck, CircleAlert, TriangleAlert } from 'lucide-react';
import HealthRing, { type RingTone } from './HealthRing';
import { formatCurrency } from '../../utils/formatters';
import type { BranchHealth } from '../../lib/dashboardService';

function tier(score: number): { tone: RingTone; label: string; chip: string; icon: typeof CircleCheck } {
  if (score >= 75) return { tone: 'emerald', label: 'Planning range', chip: 'badge-emerald', icon: CircleCheck };
  if (score >= 55) return { tone: 'amber', label: 'Review', chip: 'badge-amber', icon: CircleAlert };
  return { tone: 'red', label: 'Priority review', chip: 'badge-red', icon: TriangleAlert };
}

export default function BranchHealthCard({ branch, onOpen }: { branch: BranchHealth; onOpen: (b: BranchHealth) => void }) {
  const t = tier(branch.healthScore);
  const TierIcon = t.icon;
  return (
    <div
      role="button" tabIndex={0}
      onClick={() => onOpen(branch)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(branch); } }}
      aria-label={`Open ${branch.name} command center — unvalidated capacity planning index ${branch.healthScore}, ${t.label}`}
      className="hover-lift group cursor-pointer rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--indigo)] focus-visible:outline-offset-2"
    >
      <div className="flex items-center gap-3.5">
        <div className="shrink-0"><HealthRing value={branch.healthScore} tone={t.tone} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13.5px] font-bold text-t1 leading-tight truncate">{branch.name}</p>
            <span className={`badge ${t.chip} shrink-0`}>
              <TierIcon className="w-3 h-3" aria-hidden="true" /> {t.label}
            </span>
          </div>
          <p className="text-[11px] text-t3 mt-0.5 truncate">{branch.location}</p>
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1.5 text-[11px] text-t2">
            <span><strong className="text-t1 font-bold">{branch.utilization}%</strong> utilised</span>
            <span><strong className="text-t1 font-bold">{branch.appointmentsToday}</strong> today</span>
            <span><strong className="text-t1 font-bold">{branch.providers}</strong> providers</span>
            <span><strong className="text-t1 font-bold">{formatCurrency(branch.monthlyRevenue)}</strong> / mo</span>
          </div>
        </div>
        <ArrowUpRight className="w-4 h-4 text-t3 opacity-0 group-hover:opacity-100 transition shrink-0" aria-hidden="true" />
      </div>
    </div>
  );
}
