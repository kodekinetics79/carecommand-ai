import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { formatCurrency } from '../../utils/formatters';

const colors = ['#4F46E5', '#D97706', '#059669', '#DC2626'];

export interface BranchComparisonRow {
  name: string;
  revenue: number;
}

interface BranchComparisonChartProps {
  data: BranchComparisonRow[];
}

export default function BranchComparisonChart({ data }: BranchComparisonChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-xl border border-dashed border-[var(--b1)] text-xs text-t3">
        No live branch revenue data available.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 5, right: 10, left: -10, bottom: 0 }} barSize={28}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E5EAF0" vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} tickFormatter={v => formatCurrency(Number(v))} />
        <Tooltip
          contentStyle={{ background: '#FFFFFF', border: '1px solid #E5EAF0', borderRadius: '12px', fontSize: 12, color: '#111827', boxShadow: '0 8px 24px rgba(15,23,42,0.1)' }}
          formatter={(value) => [formatCurrency(Number(value)), 'Revenue']}
        />
        <Bar dataKey="revenue" radius={[6, 6, 0, 0]}>
          {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
