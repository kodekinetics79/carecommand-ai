import { useState } from 'react';
import { FileText, Clock, CheckCircle2, Archive, AlertCircle, Sparkles, Upload } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { useApiResource } from '../hooks/useApiResource';
import { apiRequest } from '../lib/api';
import { mapPartnerReport, type ApiPartnerReport } from '../lib/apiAdapters';

interface ApiBranchOption { id: string; name: string }

const statusConfig: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  'ordered':         { label: 'Ordered',       color: 'text-blue-v',    bg: 'badge badge-blue',    icon: <Clock className="w-3 h-3" /> },
  'sample-collected':{ label: 'Collected',      color: 'text-violet-v',  bg: 'badge badge-violet',  icon: <FileText className="w-3 h-3" /> },
  'pending-result':  { label: 'Pending',        color: 'text-amber-v',   bg: 'badge badge-amber',   icon: <Clock className="w-3 h-3" /> },
  'result-received': { label: 'Received',       color: 'text-emerald-v', bg: 'badge badge-emerald', icon: <CheckCircle2 className="w-3 h-3" /> },
  'doctor-reviewed': { label: 'Reviewed',       color: 'text-t2',        bg: 'badge badge-blue',    icon: <Archive className="w-3 h-3" /> },
};

export default function Labs() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data: reportRecords, source, error, reload } = useApiResource<ApiPartnerReport, ReturnType<typeof mapPartnerReport>>('/v1/partner-reports?limit=100', [], mapPartnerReport);
  const { data: branchOptions } = useApiResource<ApiBranchOption, ApiBranchOption>('/v1/branches?limit=100', [], row => row);
  const loadError = error;
  const openCount = reportRecords.filter(order => order.status !== 'doctor-reviewed').length;
  const urgentCount = reportRecords.filter(order => order.urgency === 'urgent').length;
  const receivedCount = reportRecords.filter(order => order.status === 'result-received').length;
  const reviewedCount = reportRecords.filter(order => order.status === 'doctor-reviewed').length;
  const actionNotes = [
    urgentCount > 0 ? { title: `${urgentCount} urgent report${urgentCount === 1 ? '' : 's'} need review`, desc: 'Assign these live priority reports for operational review.', urgency: 'high' } : null,
    receivedCount > 0 ? { title: `${receivedCount} result${receivedCount === 1 ? '' : 's'} ready for provider review`, desc: 'These live reports have results and are not yet marked reviewed.', urgency: 'medium' } : null,
    openCount > 0 ? { title: `${openCount} open report${openCount === 1 ? '' : 's'} in the workflow`, desc: 'Monitor pending documents and follow up with the responsible provider.', urgency: 'medium' } : null,
  ].filter((note): note is { title: string; desc: string; urgency: string } => note !== null);

  async function markReviewed(orderId: string, summary?: string) {
    setBusyId(orderId);
    try {
      await apiRequest(`/v1/partner-reports/${orderId}/review`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'doctor-reviewed', summary }),
      });
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Documents & Partner Reports"
        subtitle="Uploaded customer documents, external partner reports, and review workflows across all branches."
        badge={loadError ? 'Live Data Error' : `${urgentCount} Urgent · ${source === 'live' ? 'Live DB' : 'Loading'}`}
        badgeColor="red"
        actions={
          <button type="button" onClick={() => document.getElementById('upload-zone')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition">
            <Upload className="w-4 h-4" /> Upload Document
          </button>
        }
      />

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Partner report data could not be loaded from the live API: {loadError}
        </div>
      )}

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
            {reportRecords.map((order) => {
              const sc = statusConfig[order.status];
              const branch = branchOptions.find(b => b.id === order.branchId);
              const isUrgent = order.urgency === 'urgent';
              return (
                <div key={order.id} className={`p-4 rounded-2xl border transition-all hover:bg-[var(--s3)] ${
                  isUrgent ? 'border-[var(--b2)] bg-[var(--red-soft)]' :
                  order.status === 'result-received' ? 'border-[var(--b1)] bg-[var(--emerald-soft)]' :
                  'border-[var(--b1)]'
                }`}>
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-t1">{order.testName}</p>
                        {isUrgent && <span className="badge badge-red">Urgent</span>}
                      </div>
                      <p className="text-[11px] text-t3 mt-0.5">{order.patientName} · {branch?.name.split(' ')[0]} · {order.lab}</p>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${sc.bg}`}>
                      {sc.icon}{sc.label}
                    </span>
                  </div>

                  {order.resultSummary && (
                    <div className="mt-2 p-2.5 rounded-xl bg-[var(--s3)] border border-[var(--b1)]">
                      <p className="text-[10px] font-bold text-t3 mb-0.5">Internal note</p>
                      <p className="text-[11px] text-t2">{order.resultSummary}</p>
                    </div>
                  )}
                  {order.reviewedAt && (
                    <p className="mt-2 text-[10px] text-t3">Reviewed by {order.reviewedBy ?? 'a clinician'} · {new Date(order.reviewedAt).toLocaleString()}</p>
                  )}

                  <div className="flex items-center justify-between gap-3 mt-2">
                    <p className="text-[10px] text-t3">Provider: {order.doctorName}</p>
                    <div className="flex items-center gap-2">
                      {order.status === 'result-received' && (
                        <button
                          type="button"
                          disabled={busyId === order.id}
                          onClick={() => markReviewed(order.id, order.resultSummary)}
                          className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2.5 py-1 rounded-lg hover:bg-[var(--s3)] transition-colors disabled:opacity-60"
                        >
                          <CheckCircle2 className="w-3 h-3" /> Mark reviewed
                        </button>
                      )}
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
              {actionNotes.length === 0 && <p className="text-xs text-t3">No live report actions require attention.</p>}
              {actionNotes.map((note) => (
                <div key={note.title} className={`p-3.5 rounded-xl border transition-all ${note.urgency === 'high' ? 'border-[var(--b2)] bg-[var(--red-soft)]' : 'border-[var(--b1)] bg-[var(--amber-soft)]'}`}>
                  <p className="text-xs font-bold text-t1 mb-1 leading-tight">{note.title}</p>
                  <p className="text-[11px] text-t3 mb-2">{note.desc}</p>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Status breakdown */}
          <BentoCard title="Status Breakdown" subtitle="All documents by stage">
            <div className="space-y-2">
              {(['ordered', 'sample-collected', 'pending-result', 'result-received', 'doctor-reviewed'] as const).map((status) => {
                const count = reportRecords.filter(o => o.status === status).length;
                const sc = statusConfig[status];
                return (
                  <div key={status} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${sc.color}`}>
                      {sc.icon}{sc.label}
                    </span>
                    <span className="text-sm font-bold text-t1">{count}</span>
                  </div>
                );
              })}
            </div>
            {reportRecords.length === 0 && <p className="text-xs text-t3 mt-3">No live partner reports returned for this clinic.</p>}
          </BentoCard>

          {/* Upload zone */}
          <div id="upload-zone" className="rounded-2xl border-2 border-dashed border-[var(--b2)] p-5 text-center hover:border-[var(--b3)] transition-colors cursor-pointer">
            <Upload className="w-6 h-6 text-t3 mx-auto mb-2" />
            <p className="text-xs font-semibold text-t2 mb-1">Upload partner report</p>
            <p className="text-[11px] text-t3">PDF, DOCX, or image · Max 20MB</p>
          </div>
        </div>
      </div>
    </div>
  );
}
