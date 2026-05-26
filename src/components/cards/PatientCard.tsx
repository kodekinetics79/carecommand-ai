import type { Patient } from '../../types';
import { getRiskBg, formatRelativeDate, formatCurrency } from '../../utils/formatters';
import { Link } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';

const lifecycleColors: Record<string, string> = {
  new: 'bg-blue-50 text-blue-700',
  active: 'bg-emerald-50 text-emerald-700',
  'at-risk': 'bg-amber-50 text-amber-700',
  inactive: 'bg-red-50 text-red-600',
  lost: 'bg-slate-100 text-slate-500',
  retained: 'bg-violet-50 text-violet-700',
};

interface PatientCardProps {
  patient: Patient;
}

export default function PatientCard({ patient }: PatientCardProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-sm font-bold shrink-0">
          {patient.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
        </div>
        <div className="flex-1 min-w-0">
          <Link to={`/patients/${patient.id}`} className="text-sm font-semibold text-slate-900 hover:text-blue-600 transition-colors truncate block">
            {patient.name}
          </Link>
          <div className="text-xs text-slate-500">{patient.age}y · {patient.gender}</div>
        </div>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${lifecycleColors[patient.lifecycleStage]}`}>
          {patient.lifecycleStage.replace('-', ' ')}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Last visit: {formatRelativeDate(patient.lastVisit)}</span>
        <span className={`font-semibold px-2 py-0.5 rounded-full text-[10px] ${getRiskBg(patient.churnRisk)}`}>
          Risk {patient.churnRisk}%
        </span>
      </div>
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
        <span className="text-xs text-slate-500">LTV: <span className="font-semibold text-slate-800">{formatCurrency(patient.lifetimeValue)}</span></span>
        <button className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium">
          <MessageSquare className="w-3 h-3" />
          Contact
        </button>
      </div>
    </div>
  );
}
