import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { branchRevenue } from '../../data/mockRevenue';

const colors = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444'];

export default function BranchComparisonChart() {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={branchRevenue} margin={{ top: 5, right: 10, left: -10, bottom: 0 }} barSize={28}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} tickFormatter={v => `£${(v/1000).toFixed(0)}k`} />
        <Tooltip
          contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', fontSize: 12 }}
          formatter={(v: any) => [`£${(v/1000).toFixed(1)}k`, 'Revenue']}
        />
        <Bar dataKey="revenue" radius={[6, 6, 0, 0]}>
          {branchRevenue.map((_, i) => <Cell key={i} fill={colors[i]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
