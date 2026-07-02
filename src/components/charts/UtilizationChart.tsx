import { RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer } from 'recharts';
import { useApiResource } from '../../hooks/useApiResource';
import { mapProviderProfile, type ApiProviderProfile } from '../../lib/apiAdapters';

export default function UtilizationChart() {
  const { data: providerRecords } = useApiResource<ApiProviderProfile, ReturnType<typeof mapProviderProfile>>('/v1/providers/overview?limit=8', [], mapProviderProfile);
  const data = providerRecords.slice(0, 8).map(d => ({
    name: d.name.replace('Dr. ', '').split(' ')[0],
    utilization: d.utilization,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <RadarChart data={data}>
        <PolarGrid stroke="#E5EAF0" />
        <PolarAngleAxis dataKey="name" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
        <Radar name="Utilization" dataKey="utilization" stroke="#4F46E5" fill="#4F46E5" fillOpacity={0.1} strokeWidth={2} />
      </RadarChart>
    </ResponsiveContainer>
  );
}
