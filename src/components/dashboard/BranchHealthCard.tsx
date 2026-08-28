import { ArrowUpRight, Activity } from 'lucide-react';
import ProgressBar from '../ui/ProgressBar';
import { formatCurrency } from '../../utils/formatters';
import type { BranchHealth } from '../../lib/dashboardService';

function tier(score: number): { color: 'emerald' | 'amber' | 'red'; label: string } {
  if (score >= 75) return { color: 'emerald', label: 'Healthy' };
  if (score >= 55) return { color: 'amber', label: 'Watch' };
  return { color: 'red', label: 'At risk' };
}
const scoreText: Record<string, string> = { emerald: 'text-emerald-v', amber: 'text-amber-v', red: 'text-red-v' };

export default function BranchHealthCard({ branch, onOpen }: { branch: BranchHealth; onOpen: (b: BranchHealth) => void }) {
  const t = tier(branch.healthScore);
  return (
    <div
      role="button" tabIndex={0}
      onClick={() => onOpen(branch)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(branch); } }}
      aria-label={`Open ${branch.name} command center — health ${branch.healthScore}, ${t.label}`}
      className="hover-lift cursor-pointer rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--indigo)] focus-visible:outline-offset-2"
    >
      <div className="flex items-start justify-between gap-2 mb-2.5">
        <div className="min-w-0">
          <p className="text-sm font-bold text-t1 leading-tight truncate">{branch.name}</p>
          <p className="text-[11px] text-t3 mt-0.5 truncate">{branch.location}</p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-lg font-bold tabular-nums ${scoreText[t.color]}`}>{branch.healthScore}</p>
          <p className="text-[10px] font-semibold text-t3">{t.label}</p>
        </div>
      </div>

      <ProgressBar value={branch.healthScore} color={t.color} size="md" />

      <div className="grid grid-cols-4 gap-2 mt-3 text-center">
        <Metric value={`${branch.utilization}%`} label="Utilised" />
        <Metric value={String(branch.appointmentsToday)} label="Today" />
        <Metric value={String(branch.providers)} label="Providers" />
        <Metric value={formatCurrency(branch.monthlyRevenue)} label="Revenue" />
      </div>

      <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-[var(--b1)]">
        <span className="inline-flex items-center gap-1 text-[10px] text-t3">
          <Activity className="w-3 h-3" aria-hidden="true" /> Staff load {branch.staffLoad != null ? `${branch.staffLoad}%` : '—'}
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo">
          Open Command Center <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px] font-bold text-t1 truncate">{value}</p>
      <p className="text-[10px] text-t3">{label}</p>
    </div>
  );
}
