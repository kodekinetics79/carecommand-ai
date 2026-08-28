import { Flame, TrendingDown, CircleCheck } from 'lucide-react';
import type { ProviderUtilization, CapacityBand } from '../../lib/dashboardService';

const BAND: Record<CapacityBand, { label: string; bar: string; chip: string; dot: string; icon: typeof Flame }> = {
  overbooked: { label: 'Overbooked', bar: 'pf-red', chip: 'badge-red', dot: 'bg-[var(--red)]', icon: Flame },
  ideal: { label: 'Ideal', bar: 'pf-emerald', chip: 'badge-emerald', dot: 'bg-[var(--emerald)]', icon: CircleCheck },
  underutilized: { label: 'Underutilized', bar: 'pf-amber', chip: 'badge-amber', dot: 'bg-[var(--amber)]', icon: TrendingDown },
};
const BAND_ORDER: CapacityBand[] = ['overbooked', 'ideal', 'underutilized'];

// Default export so it can be React.lazy()-imported and code-split.
export default function ProviderUtilizationPanel({ providers }: { providers: ProviderUtilization[] }) {
  const counts = providers.reduce((acc, p) => { acc[p.band]++; return acc; }, { overbooked: 0, ideal: 0, underutilized: 0 } as Record<CapacityBand, number>);
  const total = providers.length;

  if (total === 0) {
    return <p className="text-xs text-t3 py-6 text-center">No provider data available.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Capacity mix — one stacked ratio strip; the surface gap separates
          segments, and the legend beneath carries icon + label + count so
          state never rides on color alone. */}
      <div>
        <div className="cap-bar" role="img"
          aria-label={`Capacity mix: ${counts.overbooked} overbooked, ${counts.ideal} ideal, ${counts.underutilized} underutilized of ${total} providers`}>
          {BAND_ORDER.map(b => counts[b] > 0 && (
            <div key={b} className={`cap-seg ${BAND[b].bar}`} style={{ width: `${(counts[b] / total) * 100}%` }} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
          {BAND_ORDER.map(b => {
            const Icon = BAND[b].icon;
            return (
              <span key={b} className="inline-flex items-center gap-1.5 text-[11px] text-t2">
                <span className={`w-2 h-2 rounded-full ${BAND[b].dot}`} aria-hidden="true" />
                <Icon className="w-3 h-3 text-t3" aria-hidden="true" />
                {BAND[b].label} <strong className="text-t1 font-bold">{counts[b]}</strong>
              </span>
            );
          })}
        </div>
      </div>

      {/* Ranked utilization — thin rounded bars, values right-aligned
          (tabular figures: this is a column of numbers). */}
      <ol className="space-y-2.5">
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
      </ol>
    </div>
  );
}
