import { Flame, TrendingDown, CircleCheck } from 'lucide-react';
import type { ProviderUtilization, CapacityBand } from '../../lib/dashboardService';

const BAND: Record<CapacityBand, { label: string; bar: string; chip: string; icon: typeof Flame }> = {
  overbooked: { label: 'Overbooked', bar: 'pf-red', chip: 'badge-red', icon: Flame },
  ideal: { label: 'Ideal', bar: 'pf-emerald', chip: 'badge-emerald', icon: CircleCheck },
  underutilized: { label: 'Underutilized', bar: 'pf-amber', chip: 'badge-amber', icon: TrendingDown },
};

// Default export so it can be React.lazy()-imported and code-split.
export default function ProviderUtilizationPanel({ providers }: { providers: ProviderUtilization[] }) {
  const counts = providers.reduce((acc, p) => { acc[p.band]++; return acc; }, { overbooked: 0, ideal: 0, underutilized: 0 } as Record<CapacityBand, number>);
  return (
    <div className="space-y-3">
      {/* Capacity summary */}
      <div className="grid grid-cols-3 gap-2">
        {(['overbooked', 'ideal', 'underutilized'] as CapacityBand[]).map(b => {
          const Icon = BAND[b].icon;
          return (
            <div key={b} className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-2 text-center">
              <Icon className={`w-4 h-4 mx-auto mb-0.5 ${b === 'overbooked' ? 'text-red-v' : b === 'ideal' ? 'text-emerald-v' : 'text-amber-v'}`} aria-hidden="true" />
              <p className="text-base font-bold text-t1 tabular-nums">{counts[b]}</p>
              <p className="text-[10px] text-t3">{BAND[b].label}</p>
            </div>
          );
        })}
      </div>

      {/* Ranked utilization heat list */}
      <ol className="space-y-2">
        {providers.slice(0, 8).map((p, i) => (
          <li key={p.id} className="flex items-center gap-2.5">
            <span className="w-4 text-[11px] font-bold text-t3 tabular-nums shrink-0">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] font-semibold text-t1 truncate">{p.name} <span className="text-t3 font-normal">· {p.specialty}</span></p>
                <span className="text-[11px] font-bold text-t2 tabular-nums shrink-0">{p.utilization}%</span>
              </div>
              <div className="prog-track md mt-1"><div className={`prog-fill ${BAND[p.band].bar}`} style={{ width: `${Math.min(100, p.utilization)}%` }} /></div>
            </div>
            <span className={`badge ${BAND[p.band].chip} shrink-0`}>{BAND[p.band].label}</span>
          </li>
        ))}
        {providers.length === 0 && <li className="text-xs text-t3 py-3 text-center">No provider data available.</li>}
      </ol>
    </div>
  );
}
