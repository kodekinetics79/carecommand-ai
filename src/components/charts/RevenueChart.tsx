import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { revenueData } from '../../data/mockRevenue';

export default function RevenueChart() {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={revenueData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
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
        <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} axisLine={false} tickLine={false} tickFormatter={v => `£${(v/1000).toFixed(0)}k`} />
        <Tooltip
          contentStyle={{ background: '#FFFFFF', border: '1px solid #E5EAF0', borderRadius: '12px', fontSize: 12, color: '#111827', boxShadow: '0 8px 24px rgba(15,23,42,0.1)' }}
          formatter={(v: any, name: any) => [`£${(v/1000).toFixed(1)}k`, name === 'revenue' ? 'Revenue' : name === 'recovered' ? 'Recovered' : 'Campaign']}
        />
        <Area type="monotone" dataKey="revenue" stroke="#4F46E5" strokeWidth={2} fill="url(#revGrad)" name="revenue" />
        <Area type="monotone" dataKey="recovered" stroke="#059669" strokeWidth={2} fill="url(#recGrad)" name="recovered" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
