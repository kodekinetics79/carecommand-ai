import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { branchRevenue } from '../../data/mockRevenue';

const colors = ['#4F46E5', '#D97706', '#059669', '#DC2626'];

export default function BranchComparisonChart() {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={branchRevenue} margin={{ top: 5, right: 10, left: -10, bottom: 0 }} barSize={28}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E5EAF0" vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} tickFormatter={v => `£${(v/1000).toFixed(0)}k`} />
        <Tooltip
          contentStyle={{ background: '#FFFFFF', border: '1px solid #E5EAF0', borderRadius: '12px', fontSize: 12, color: '#111827', boxShadow: '0 8px 24px rgba(15,23,42,0.1)' }}
          formatter={(value) => [`£${(Number(value) / 1000).toFixed(1)}k`, 'Revenue']}
        />
        <Bar dataKey="revenue" radius={[6, 6, 0, 0]}>
          {branchRevenue.map((_, i) => <Cell key={i} fill={colors[i]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
