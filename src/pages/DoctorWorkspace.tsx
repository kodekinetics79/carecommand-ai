import { useNavigate } from 'react-router-dom';
import { Star, TrendingUp, Users, CalendarDays, ArrowRight, Sparkles, Award, Clock } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { doctors, branches } from '../data/seedData';
import { useApiResource } from '../hooks/useApiResource';
import { mapProviderProfile, type ApiProviderProfile } from '../lib/apiAdapters';
import { formatCurrency } from '../utils/formatters';

export default function DoctorWorkspace() {
  const navigate = useNavigate();
  const { data: providerRecords, source } = useApiResource<ApiProviderProfile, typeof doctors[number]>('/v1/providers/overview?limit=100', doctors, mapProviderProfile);
  const totalRevenue = providerRecords.reduce((s, d) => s + d.revenueThisMonth, 0);
  const avgUtilization = providerRecords.length > 0 ? Math.round(providerRecords.reduce((s, d) => s + d.utilization, 0) / providerRecords.length) : 0;
  const avgRating = providerRecords.length > 0 ? (providerRecords.reduce((s, d) => s + d.rating, 0) / providerRecords.length).toFixed(1) : '0.0';

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Provider Productivity"
        subtitle="Utilisation, appointment volume, repeat customer rates, and review performance across all providers."
        badge={`${source === 'live' ? 'Live DB' : 'Demo'} · ${providerRecords.length} providers`}
        badgeColor={source === 'live' ? 'emerald' : 'blue'}
        actions={
          <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Sparkles className="w-4 h-4" /> Generate Productivity Report
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Total Providers" value={providerRecords.length} subtitle="Across all branches" icon={<Users className="w-4 h-4" />} accent="blue" />
        <StatCard title="Avg Utilisation" value={`${avgUtilization}%`} subtitle="Network capacity" trend={4} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Network Revenue" value={formatCurrency(totalRevenue)} subtitle="This month" trend={8} icon={<CalendarDays className="w-4 h-4" />} accent="violet" />
        <StatCard title="Avg Rating" value={avgRating} subtitle="Customer satisfaction" trend={2} icon={<Star className="w-4 h-4" />} accent="amber" />
      </div>

      {/* Provider table */}
      <BentoCard title="Provider Performance Dashboard" subtitle="All providers · This month">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--b1)]">
                {['Provider', 'Branch', 'Utilisation', 'Appts Today', 'Monthly Revenue', 'Repeat Rate', 'Rating', 'Follow-up Rate'].map(h => (
                  <th key={h} className="text-left py-2 px-3 text-[10px] font-bold uppercase tracking-widest text-t3 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--b0)]">
              {providerRecords.map((doc) => {
                const branch = branches.find(b => b.id === doc.branchId);
                return (
                  <tr key={doc.id} className="hover:bg-[var(--s3)] transition-colors group">
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                          {doc.name.split(' ').slice(-1)[0][0]}
                        </div>
                        <div>
                          <p className="text-xs font-bold text-t1 group-hover:text-indigo transition-colors">{doc.name}</p>
                          <p className="text-[10px] text-t3">{doc.specialty}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-xs text-t3 whitespace-nowrap">{branch?.name.split(' ')[0]}</td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16">
                          <ProgressBar value={doc.utilization} size="xs" />
                        </div>
                        <span className="text-xs font-bold text-t2">{doc.utilization}%</span>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-xs font-semibold text-t1">{doc.appointmentsToday}</td>
                    <td className="py-3 px-3 text-xs font-bold text-t1">{formatCurrency(doc.revenueThisMonth)}</td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-1.5">
                        <div className="w-12">
                          <ProgressBar value={doc.repeatVisitRate} size="xs" />
                        </div>
                        <span className="text-xs font-semibold text-t2">{doc.repeatVisitRate}%</span>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                        <span className="text-xs font-bold text-t1">{doc.rating}</span>
                        <span className="text-[10px] text-t3">({doc.reviewCount})</span>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <span className={`badge ${
                        doc.followUpRate >= 85 ? 'badge-emerald' :
                        doc.followUpRate >= 70 ? 'badge-amber' :
                        'badge-red'
                      }`}>{doc.followUpRate}%</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </BentoCard>

      {/* Top performers */}
      <div className="grid gap-4 lg:grid-cols-2">
        <BentoCard title="Top Performers" subtitle="Ranked by revenue this month" headerRight={<Award className="w-4 h-4 text-amber-500" />}>
          <div className="space-y-3">
            {[...providerRecords].sort((a, b) => b.revenueThisMonth - a.revenueThisMonth).slice(0, 5).map((doc, i) => (
              <div key={doc.id} className="flex items-center gap-3">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                  i === 0 ? 'badge badge-amber' : i === 1 ? 'badge badge-blue' : i === 2 ? 'badge badge-amber' : 'badge badge-blue'
                }`}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-t1">{doc.name}</p>
                  <p className="text-[10px] text-t3">{doc.specialty}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold text-t1">{formatCurrency(doc.revenueThisMonth)}</p>
                  <p className="text-[10px] text-t3">{doc.appointmentsThisMonth} appts</p>
                </div>
              </div>
            ))}
          </div>
        </BentoCard>

        <BentoCard title="Follow-Up Opportunities" subtitle="Providers with low review request rates" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
          <div className="space-y-3">
            {providerRecords.filter(d => d.followUpRate < 80).map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)]">
                <div>
                  <p className="text-xs font-bold text-t1">{doc.name}</p>
                  <p className="text-[10px] text-t3">{doc.repeatVisitRate}% repeat rate · {doc.reviewCount} reviews</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-amber-v">{doc.followUpRate}%</span>
                  <button type="button" onClick={() => navigate('/reviews')} className="text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2 py-1 rounded-lg hover:bg-[var(--s3)] transition-colors flex items-center gap-1">
                    <Clock className="w-3 h-3" /> Request reviews
                  </button>
                </div>
              </div>
            ))}
            {providerRecords.filter(d => d.followUpRate < 80).length === 0 && (
              <p className="text-sm text-t3 text-center py-4">All providers meeting follow-up targets.</p>
            )}
          </div>
          <button type="button" onClick={() => navigate('/campaigner')} className="mt-3 w-full flex items-center justify-center gap-1 text-xs font-semibold text-indigo py-2 border border-dashed border-[var(--b2)] rounded-xl hover:bg-[var(--s3)] transition-colors">
            Launch review campaign for all providers <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </BentoCard>
      </div>
    </div>
  );
}
