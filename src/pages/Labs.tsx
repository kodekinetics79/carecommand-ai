import { FileText, Clock, CheckCircle2, Archive, AlertCircle, Sparkles, ArrowRight, Upload } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { labOrders } from '../data/mockLabs';
import { branches } from '../data/mockClinics';

const statusConfig: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  'ordered':         { label: 'Ordered',       color: 'text-blue-700',    bg: 'bg-blue-100',    icon: <Clock className="w-3 h-3" /> },
  'sample-collected':{ label: 'Collected',      color: 'text-violet-700',  bg: 'bg-violet-100',  icon: <FileText className="w-3 h-3" /> },
  'pending-result':  { label: 'Pending',        color: 'text-amber-700',   bg: 'bg-amber-100',   icon: <Clock className="w-3 h-3" /> },
  'result-received': { label: 'Received',       color: 'text-emerald-700', bg: 'bg-emerald-100', icon: <CheckCircle2 className="w-3 h-3" /> },
  'doctor-reviewed': { label: 'Reviewed',       color: 'text-slate-700',   bg: 'bg-slate-100',   icon: <Archive className="w-3 h-3" /> },
};

const openCount = labOrders.filter(o => o.status !== 'doctor-reviewed').length;
const urgentCount = labOrders.filter(o => o.urgency === 'urgent').length;
const receivedCount = labOrders.filter(o => o.status === 'result-received').length;
const reviewedCount = labOrders.filter(o => o.status === 'doctor-reviewed').length;

const aiNotes = [
  { title: '2 urgent reports need review today', desc: 'Grace Adeyemi and Amelia Foster have sample-collected reports flagged urgent. Assign for operational review.', urgency: 'high' },
  { title: 'Mohammed Al-Farsi result arrived', desc: 'Fasting Glucose + Kidney Function report received from TDL London. Ready for provider review and follow-up booking.', urgency: 'medium' },
  { title: 'Sarah Kimani OPG result pending action', desc: 'Dental X-Ray result received from in-house lab. No follow-up appointment booked yet.', urgency: 'medium' },
];

export default function Labs() {
  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Documents & Partner Reports"
        subtitle="Uploaded customer documents, external partner reports, and review workflows across all branches."
        badge={`${urgentCount} Urgent`}
        badgeColor="red"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition shadow-md shadow-blue-500/20">
            <Upload className="w-4 h-4" /> Upload Document
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Open Reports" value={openCount} subtitle="Awaiting review" icon={<FileText className="w-4 h-4" />} accent="blue" />
        <StatCard title="Urgent" value={urgentCount} subtitle="Priority review needed" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Results Received" value={receivedCount} subtitle="Ready for action" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Reviewed & Archived" value={reviewedCount} subtitle="Completed this week" icon={<Archive className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Document tracker */}
        <BentoCard title="Partner Report Tracker" subtitle="All documents · All branches">
          <div className="space-y-2.5">
            {labOrders.map((order) => {
              const sc = statusConfig[order.status];
              const branch = branches.find(b => b.id === order.branchId);
              const isUrgent = order.urgency === 'urgent';
              return (
                <div key={order.id} className={`p-4 rounded-2xl border transition-all hover:shadow-sm ${
                  isUrgent ? 'border-red-200 bg-red-50/40' :
                  order.status === 'result-received' ? 'border-emerald-200 bg-emerald-50/20' :
                  'border-slate-200'
                }`}>
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-slate-900">{order.testName}</p>
                        {isUrgent && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Urgent</span>}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">{order.patientName} · {branch?.name.split(' ')[0]} · {order.lab}</p>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${sc.bg} ${sc.color}`}>
                      {sc.icon}{sc.label}
                    </span>
                  </div>

                  {order.resultSummary && (
                    <div className="mt-2 p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                      <p className="text-[10px] font-bold text-slate-400 mb-0.5">Internal note</p>
                      <p className="text-[11px] text-slate-600">{order.resultSummary}</p>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 mt-2">
                    <p className="text-[10px] text-slate-400">Provider: {order.doctorName}</p>
                    <div className="flex items-center gap-2">
                      {order.status === 'result-received' && (
                        <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg hover:bg-blue-100 transition-colors">
                          <CheckCircle2 className="w-3 h-3" /> Mark reviewed
                        </button>
                      )}
                      <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 hover:text-slate-700 transition-colors">
                        <ArrowRight className="w-3 h-3" /> View
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </BentoCard>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* AI Notes */}
          <BentoCard title="AI Action Notes" subtitle="Automated workflow intelligence" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
            <div className="space-y-3">
              {aiNotes.map((note) => (
                <div key={note.title} className={`p-3.5 rounded-xl border transition-all ${note.urgency === 'high' ? 'border-red-200 bg-red-50/40' : 'border-amber-100 bg-amber-50/30'}`}>
                  <p className="text-xs font-bold text-slate-900 mb-1 leading-tight">{note.title}</p>
                  <p className="text-[11px] text-slate-500 mb-2">{note.desc}</p>
                  <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600 hover:text-blue-700">
                    <ArrowRight className="w-3 h-3" /> Take action
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Status breakdown */}
          <BentoCard title="Status Breakdown" subtitle="All documents by stage">
            <div className="space-y-2">
              {(['ordered', 'sample-collected', 'pending-result', 'result-received', 'doctor-reviewed'] as const).map((status) => {
                const count = labOrders.filter(o => o.status === status).length;
                const sc = statusConfig[status];
                return (
                  <div key={status} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${sc.color}`}>
                      {sc.icon}{sc.label}
                    </span>
                    <span className="text-sm font-bold text-slate-800">{count}</span>
                  </div>
                );
              })}
            </div>
          </BentoCard>

          {/* Upload zone */}
          <div className="rounded-2xl border-2 border-dashed border-slate-200 p-5 text-center hover:border-blue-300 transition-colors cursor-pointer">
            <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2" />
            <p className="text-xs font-semibold text-slate-700 mb-1">Upload partner report</p>
            <p className="text-[11px] text-slate-400">PDF, DOCX, or image · Max 20MB</p>
          </div>
        </div>
      </div>
    </div>
  );
}
