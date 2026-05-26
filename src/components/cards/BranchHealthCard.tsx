import type { Branch } from '../../types';
import { formatCurrency } from '../../utils/formatters';
import { Phone, CalendarDays, Users, TrendingUp } from 'lucide-react';

interface BranchHealthCardProps {
  branch: Branch;
}

const getHealthColor = (score: number) => {
  if (score >= 75) return { bar: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50' };
  if (score >= 55) return { bar: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50' };
  return { bar: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50' };
};

export default function BranchHealthCard({ branch }: BranchHealthCardProps) {
  const health = getHealthColor(branch.healthScore);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold text-slate-900 leading-tight">{branch.name}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{branch.location}</p>
        </div>
        <div className={`px-2.5 py-1 rounded-full text-xs font-bold ${health.bg} ${health.text}`}>
          {branch.healthScore}/100
        </div>
      </div>

      {/* Health Bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs text-slate-500 mb-1">
          <span>Branch Health</span>
          <span>{branch.utilization}% utilised</span>
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${health.bar}`} style={{ width: `${branch.healthScore}%` }} />
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-3.5 h-3.5 text-slate-400" />
          <div>
            <div className="text-xs font-bold text-slate-900">{branch.todayAppointments}</div>
            <div className="text-[10px] text-slate-500">Today</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <TrendingUp className="w-3.5 h-3.5 text-slate-400" />
          <div>
            <div className="text-xs font-bold text-slate-900">{formatCurrency(branch.revenue)}</div>
            <div className="text-[10px] text-slate-500">This month</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Phone className="w-3.5 h-3.5 text-red-400" />
          <div>
            <div className="text-xs font-bold text-red-600">{branch.missedCalls}</div>
            <div className="text-[10px] text-slate-500">Missed calls</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Users className="w-3.5 h-3.5 text-slate-400" />
          <div>
            <div className="text-xs font-bold text-slate-900">{branch.openSlots}</div>
            <div className="text-[10px] text-slate-500">Open slots</div>
          </div>
        </div>
      </div>
    </div>
  );
}
