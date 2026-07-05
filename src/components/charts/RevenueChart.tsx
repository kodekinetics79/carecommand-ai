import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useApiResource } from '../../hooks/useApiResource';
import { mapRevenueSnapshot, type ApiRevenueSnapshot } from '../../lib/apiAdapters';
import { formatCurrency } from '../../utils/formatters';

type RevenueChartRow = {
  id: string;
  month: string;
  revenue: number;
  recovered: number;
  lost: number;
  campaigns: number;
};

interface RevenueChartProps {
  data?: RevenueChartRow[];
}

function RevenueChartView({ data, emptyMessage }: { data: RevenueChartRow[]; emptyMessage: string }) {
  if (data.length === 0) {
    return <div className="flex h-[220px] items-center justify-center rounded-xl border border-dashed border-[var(--b1)] text-xs text-t3">{emptyMessage}</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#4F46E5" stopOpacity={0.15} />
            <stop offset="95%" stopColor="#4F46E5" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="recGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#059669" stopOpacity={0.12} />
            <stop offset="95%" stopColor="#059669" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#E5EAF0" />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} tickFormatter={v => formatCurrency(Number(v))} />
        <Tooltip
          contentStyle={{ background: '#FFFFFF', border: '1px solid #E5EAF0', borderRadius: '12px', fontSize: 12, color: '#111827', boxShadow: '0 8px 24px rgba(15,23,42,0.1)' }}
          formatter={(value, name) => [formatCurrency(Number(value)), name === 'revenue' ? 'Revenue' : name === 'recovered' ? 'Recovered' : 'Campaign']}
        />
        <Area type="monotone" dataKey="revenue" stroke="#4F46E5" strokeWidth={2} fill="url(#revGrad)" name="revenue" />
        <Area type="monotone" dataKey="recovered" stroke="#059669" strokeWidth={2} fill="url(#recGrad)" name="recovered" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export default function RevenueChart({ data }: RevenueChartProps) {
  if (data) {
    return <RevenueChartView data={data} emptyMessage="No revenue data available." />;
  }
  // Hooks cannot sit below a conditional return, so the live-fetching variant
  // is its own component (identical behavior: the hook only ran on this path).
  return <LiveRevenueChart />;
}

function LiveRevenueChart() {
  const { data: liveData, source, loading, error } = useApiResource<ApiRevenueSnapshot, RevenueChartRow>(
    '/v1/revenue-snapshots?limit=100',
    [],
    mapRevenueSnapshot,
  );
  const chartData = liveData;

  if (loading && chartData.length === 0) {
    return <div className="flex h-[220px] items-center justify-center rounded-xl border border-dashed border-[var(--b1)] text-xs text-t3">Loading live revenue snapshots...</div>;
  }

  const emptyMessage = error ? `Revenue chart unavailable: ${error}` : source === 'offline' ? 'No live revenue snapshots returned.' : 'No revenue data available.';
  return <RevenueChartView data={chartData} emptyMessage={emptyMessage} />;
}
