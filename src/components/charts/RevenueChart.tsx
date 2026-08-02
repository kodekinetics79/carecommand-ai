import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useApiResource } from '../../hooks/useApiResource';
import { mapRevenueSnapshot, type ApiRevenueSnapshot } from '../../lib/apiAdapters';
import { formatCurrency, formatCurrencyCompact } from '../../utils/formatters';

export type RevenueChartRow = {
  id: string;
  month: string;
  /** Sortable period timestamp — rows are plotted ascending on this. */
  periodTs?: number;
  revenue: number;
  recovered: number;
  lost: number;
  campaigns: number;
};

interface RevenueChartProps {
  data?: RevenueChartRow[];
  loading?: boolean;
  /** Fill the parent's height (cockpit panels) instead of the fixed 220px. */
  fitParent?: boolean;
}

const SERIES = [
  { key: 'revenue' as const, label: 'Revenue', color: '#4F46E5', swatch: 'bg-[var(--indigo)]' },
  { key: 'recovered' as const, label: 'Associated value field', color: '#059669', swatch: 'bg-[var(--emerald)]' },
];

function Frame({ fitParent, children }: { fitParent?: boolean; children: React.ReactNode }) {
  return <div className={fitParent ? 'flex h-full min-h-[150px] items-center justify-center' : 'flex h-[220px] items-center justify-center'}>{children}</div>;
}

function RevenueChartView({ data, emptyMessage, fitParent }: { data: RevenueChartRow[]; emptyMessage: string; fitParent?: boolean }) {
  if (data.length === 0) {
    return <Frame fitParent={fitParent}><div className="w-full h-full flex items-center justify-center rounded-xl border border-dashed border-[var(--b1)] text-xs text-t3">{emptyMessage}</div></Frame>;
  }
  // The API returns snapshots newest-first; time always reads left → right.
  const rows = [...data].sort((a, b) => (a.periodTs ?? 0) - (b.periodTs ?? 0));
  const last = rows[rows.length - 1];

  return (
    <div className={fitParent ? 'flex h-full min-h-[150px] flex-col' : ''}>
      {/* Legend — identity never rides on color alone; the latest value per
          series doubles as the selective direct label. */}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 mb-1.5 shrink-0">
        {SERIES.map(s => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-[11px] text-t2">
            <span className={`w-2.5 h-2.5 rounded-[3px] ${s.swatch}`} aria-hidden="true" />
            {s.label} <strong className="font-bold text-t1">{formatCurrency(last[s.key])}</strong>
          </span>
        ))}
      </div>
      <div className={fitParent ? 'flex-1 min-h-0' : ''}>
        <ResponsiveContainer width="100%" height={fitParent ? '100%' : 220}>
          <AreaChart data={rows} margin={{ top: 6, right: 12, left: -4, bottom: 0 }}>
            {/* Solid hairline grid, horizontal only — recessive, never dashed. */}
            <CartesianGrid stroke="#EEF1F6" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} width={52} axisLine={false} tickLine={false} tickFormatter={v => formatCurrencyCompact(Number(v))} />
            <Tooltip
              contentStyle={{ background: '#FFFFFF', border: '1px solid #E5EAF0', borderRadius: '12px', fontSize: 12, color: '#111827', boxShadow: '0 8px 24px rgba(15,23,42,0.1)' }}
              formatter={(value, name) => [formatCurrency(Number(value)), String(name)]}
            />
            {SERIES.map(s => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.label}
                stroke={s.color} strokeWidth={2} strokeLinecap="round"
                fill={s.color} fillOpacity={0.08}
                dot={false} activeDot={{ r: 4.5, fill: s.color, stroke: '#FFFFFF', strokeWidth: 2 }} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function RevenueChart({ data, loading, fitParent }: RevenueChartProps) {
  if (data) {
    if (loading && data.length === 0) {
      return <Frame fitParent={fitParent}><div className="w-full h-full skeleton-line rounded-xl" /></Frame>;
    }
    return <RevenueChartView data={data} emptyMessage="No revenue data available." fitParent={fitParent} />;
  }
  return <LiveRevenueChart fitParent={fitParent} />;
}

// Own component so the hook is called unconditionally (and the fetch only
// mounts when no data was passed in).
function LiveRevenueChart({ fitParent }: { fitParent?: boolean }) {
  const { data: liveData, source, loading: liveLoading, error } = useApiResource<ApiRevenueSnapshot, RevenueChartRow>(
    '/v1/revenue-snapshots?limit=100',
    [],
    mapRevenueSnapshot,
  );

  if (liveLoading && liveData.length === 0) {
    return <Frame fitParent={fitParent}><div className="w-full h-full flex items-center justify-center rounded-xl border border-dashed border-[var(--b1)] text-xs text-t3">Loading recorded revenue snapshots...</div></Frame>;
  }

  const emptyMessage = error ? `Revenue chart unavailable: ${error}` : source === 'offline' ? 'No recorded revenue snapshots were returned.' : 'No revenue data available.';
  return <RevenueChartView data={liveData} emptyMessage={emptyMessage} fitParent={fitParent} />;
}
