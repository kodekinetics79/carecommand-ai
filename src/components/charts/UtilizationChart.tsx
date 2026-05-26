import { RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer } from 'recharts';
import { doctors } from '../../data/mockClinics';

export default function UtilizationChart() {
  const data = doctors.slice(0, 8).map(d => ({
    name: d.name.replace('Dr. ', '').split(' ')[0],
    utilization: d.utilization,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <RadarChart data={data}>
        <PolarGrid stroke="#e2e8f0" />
        <PolarAngleAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} />
        <Radar name="Utilization" dataKey="utilization" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} strokeWidth={2} />
      </RadarChart>
    </ResponsiveContainer>
  );
}
