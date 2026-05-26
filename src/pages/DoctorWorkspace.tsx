import { Star, TrendingUp, Users, CalendarDays, ArrowRight, Sparkles, Award, Clock } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { doctors, branches } from '../data/mockClinics';
import { formatCurrency } from '../utils/formatters';

const totalRevenue = doctors.reduce((s, d) => s + d.revenueThisMonth, 0);
const avgUtilization = Math.round(doctors.reduce((s, d) => s + d.utilization, 0) / doctors.length);
const avgRating = (doctors.reduce((s, d) => s + d.rating, 0) / doctors.length).toFixed(1);

export default function DoctorWorkspace() {
  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Provider Productivity"
        subtitle="Utilisation, appointment volume, repeat customer rates, and review performance across all providers."
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition shadow-md shadow-blue-500/20">
            <Sparkles className="w-4 h-4" /> Generate Productivity Report
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Total Providers" value={doctors.length} subtitle="Across all branches" icon={<Users className="w-4 h-4" />} accent="blue" />
        <StatCard title="Avg Utilisation" value={`${avgUtilization}%`} subtitle="Network capacity" trend={4} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Network Revenue" value={formatCurrency(totalRevenue)} subtitle="This month" trend={8} icon={<CalendarDays className="w-4 h-4" />} accent="violet" />
        <StatCard title="Avg Rating" value={avgRating} subtitle="Customer satisfaction" trend={2} icon={<Star className="w-4 h-4" />} accent="amber" />
      </div>

      {/* Provider table */}
      <BentoCard title="Provider Performance Dashboard" subtitle="All providers · This month">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                {['Provider', 'Branch', 'Utilisation', 'Appts Today', 'Monthly Revenue', 'Repeat Rate', 'Rating', 'Follow-up Rate'].map(h => (
                  <th key={h} className="text-left py-2 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-400 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {doctors.map((doc) => {
                const branch = branches.find(b => b.id === doc.branchId);
                return (
                  <tr key={doc.id} className="hover:bg-slate-50 transition-colors group">
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                          {doc.name.split(' ').slice(-1)[0][0]}
                        </div>
                        <div>
                          <p className="text-xs font-bold text-slate-900 group-hover:text-blue-700 transition-colors">{doc.name}</p>
                          <p className="text-[10px] text-slate-400">{doc.specialty}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-xs text-slate-500 whitespace-nowrap">{branch?.name.split(' ')[0]}</td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16">
                          <ProgressBar value={doc.utilization} size="xs" />
                        </div>
                        <span className="text-xs font-bold text-slate-700">{doc.utilization}%</span>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-xs font-semibold text-slate-800">{doc.appointmentsToday}</td>
                    <td className="py-3 px-3 text-xs font-bold text-slate-900">{formatCurrency(doc.revenueThisMonth)}</td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-1.5">
                        <div className="w-12">
                          <ProgressBar value={doc.repeatVisitRate} size="xs" />
                        </div>
                        <span className="text-xs font-semibold text-slate-700">{doc.repeatVisitRate}%</span>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                        <span className="text-xs font-bold text-slate-900">{doc.rating}</span>
                        <span className="text-[10px] text-slate-400">({doc.reviewCount})</span>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                        doc.followUpRate >= 85 ? 'bg-emerald-100 text-emerald-700' :
                        doc.followUpRate >= 70 ? 'bg-amber-100 text-amber-700' :
                        'bg-red-100 text-red-600'
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
            {[...doctors].sort((a, b) => b.revenueThisMonth - a.revenueThisMonth).slice(0, 5).map((doc, i) => (
              <div key={doc.id} className="flex items-center gap-3">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                  i === 0 ? 'bg-amber-100 text-amber-700' : i === 1 ? 'bg-slate-100 text-slate-600' : i === 2 ? 'bg-orange-100 text-orange-700' : 'bg-slate-50 text-slate-500'
                }`}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-slate-900">{doc.name}</p>
                  <p className="text-[10px] text-slate-400">{doc.specialty}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-bold text-slate-900">{formatCurrency(doc.revenueThisMonth)}</p>
                  <p className="text-[10px] text-slate-400">{doc.appointmentsThisMonth} appts</p>
                </div>
              </div>
            ))}
          </div>
        </BentoCard>

        <BentoCard title="Follow-Up Opportunities" subtitle="Providers with low review request rates" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
          <div className="space-y-3">
            {doctors.filter(d => d.followUpRate < 80).map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-amber-100 bg-amber-50">
                <div>
                  <p className="text-xs font-bold text-slate-900">{doc.name}</p>
                  <p className="text-[10px] text-slate-500">{doc.repeatVisitRate}% repeat rate · {doc.reviewCount} reviews</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-amber-700">{doc.followUpRate}%</span>
                  <button type="button" className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-2 py-1 rounded-lg hover:bg-blue-100 transition-colors flex items-center gap-1">
                    <Clock className="w-3 h-3" /> Request reviews
                  </button>
                </div>
              </div>
            ))}
            {doctors.filter(d => d.followUpRate < 80).length === 0 && (
              <p className="text-sm text-slate-400 text-center py-4">All providers meeting follow-up targets.</p>
            )}
          </div>
          <button type="button" className="mt-3 w-full flex items-center justify-center gap-1 text-xs font-semibold text-blue-600 py-2 border border-dashed border-blue-200 rounded-xl hover:bg-blue-50 transition-colors">
            Launch review campaign for all providers <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </BentoCard>
      </div>
    </div>
  );
}
