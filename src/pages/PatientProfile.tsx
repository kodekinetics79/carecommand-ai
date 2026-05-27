import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Star, ShieldCheck, MessageSquare, CalendarDays, TrendingUp, AlertCircle, Sparkles, Zap, CheckCircle2, Mail, Phone, Clock } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { patients } from '../data/mockPatients';
import { appointments } from '../data/mockAppointments';
import { doctors, branches } from '../data/mockClinics';
import { formatCurrency, formatDate } from '../utils/formatters';

const lifecycleConfig: Record<string, { label: string; color: string; bg: string }> = {
  new:      { label: 'New',      color: 'text-indigo',    bg: 'badge badge-blue' },
  active:   { label: 'Active',   color: 'text-emerald-v', bg: 'badge badge-emerald' },
  retained: { label: 'Retained', color: 'text-violet-v',  bg: 'badge badge-violet' },
  'at-risk':{ label: 'At Risk',  color: 'text-amber-v',   bg: 'badge badge-amber' },
  inactive: { label: 'Inactive', color: 'text-red-v',     bg: 'badge badge-red' },
};

const channelIcon: Record<string, React.ReactNode> = {
  whatsapp: <MessageSquare className="w-3.5 h-3.5 text-emerald-v" />,
  email:    <Mail className="w-3.5 h-3.5 text-indigo" />,
  sms:      <Phone className="w-3.5 h-3.5 text-violet-v" />,
  call:     <Phone className="w-3.5 h-3.5 text-amber-v" />,
};

const commsTimeline = [
  { date: '05 May 2026', message: 'SMS reminder sent for follow-up appointment.', type: 'sms' },
  { date: '15 Apr 2026', message: 'WhatsApp check-in for treatment progress.', type: 'whatsapp' },
  { date: '22 Mar 2026', message: 'Email education series started.', type: 'email' },
];

export default function PatientProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const patient = patients.find(p => p.id === id);
  const visitHistory = useMemo(() => appointments.filter(a => a.patientId === id), [id]);
  const assignedDoctor = doctors.find(d => d.id === patient?.assignedDoctorId);
  const branch = branches.find(b => b.id === patient?.branchId);

  if (!patient) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="w-8 h-8 text-t3 mx-auto mb-2" />
          <p className="text-sm text-t3">Customer not found.</p>
        </div>
      </div>
    );
  }

  const lc = lifecycleConfig[patient.lifecycleStage];
  const totalSpend = visitHistory.reduce((s, v) => s + v.value, 0);

  return (
    <div className="space-y-6 pb-8">
      {/* Back nav + header */}
      <div className="flex items-start gap-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          title="Go back"
          aria-label="Go back"
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition shrink-0"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-10 h-10 rounded-full bg-[var(--indigo-soft)] flex items-center justify-center text-indigo text-sm font-bold shrink-0">
              {patient.name.split(' ').map(n => n[0]).join('')}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-t1">{patient.name}</h1>
                <span className={lc?.bg}>{lc?.label}</span>
                {patient.familyAccountId && <span className="badge badge-violet">Family Account</span>}
              </div>
              <p className="text-xs text-t3 mt-0.5">Age {patient.age} · {patient.gender} · {branch?.name}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo-soft)] border border-[var(--b2)] px-3 py-2 text-xs font-semibold text-indigo hover:bg-[var(--s3)] transition">
            <Zap className="w-3.5 h-3.5" /> Quick outreach
          </button>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition">
            <CalendarDays className="w-3.5 h-3.5" /> Book appointment
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <div className="p-4 rounded-2xl border border-[var(--b1)] bg-[var(--s2)]">
          <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-1">Lifetime Value</p>
          <p className="text-xl font-bold text-t1">{formatCurrency(patient.lifetimeValue)}</p>
          <p className="text-[10px] text-t3">{patient.visitCount} visits total</p>
        </div>
        <div className={`p-4 rounded-2xl border ${patient.churnRisk >= 60 ? 'border-[var(--red-soft)] bg-[var(--red-soft)]' : 'border-[var(--b1)] bg-[var(--s2)]'}`}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-1">Churn Risk</p>
          <p className={`text-xl font-bold ${patient.churnRisk >= 60 ? 'text-red-v' : patient.churnRisk >= 30 ? 'text-amber-v' : 'text-emerald-v'}`}>{patient.churnRisk}%</p>
          <ProgressBar value={patient.churnRisk} color={patient.churnRisk >= 60 ? 'red' : patient.churnRisk >= 30 ? 'amber' : 'emerald'} size="xs" />
        </div>
        <div className="p-4 rounded-2xl border border-[var(--b1)] bg-[var(--s2)]">
          <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-1">Outstanding</p>
          <p className={`text-xl font-bold ${patient.outstandingBalance > 0 ? 'text-red-v' : 'text-emerald-v'}`}>
            {patient.outstandingBalance > 0 ? formatCurrency(patient.outstandingBalance) : 'Clear'}
          </p>
          <p className="text-[10px] text-t3">{patient.outstandingBalance > 0 ? 'Payment pending' : 'No outstanding balance'}</p>
        </div>
        <div className="p-4 rounded-2xl border border-[var(--b1)] bg-[var(--s2)]">
          <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-1">Last Visit</p>
          <p className="text-base font-bold text-t1">{formatDate(patient.lastVisit)}</p>
          {patient.nextVisit && <p className="text-[10px] text-emerald-v font-semibold">Next: {formatDate(patient.nextVisit)}</p>}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Main content */}
        <div className="space-y-4">
          {/* Visit history */}
          <BentoCard title="Service History" subtitle={`${visitHistory.length} visits · ${formatCurrency(totalSpend)} total`} headerRight={<TrendingUp className="w-4 h-4 text-t3" />}>
            {visitHistory.length > 0 ? (
              <div className="space-y-2.5">
                {visitHistory.map((visit) => (
                  <div key={visit.id} className="flex items-start justify-between gap-3 p-3.5 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-[var(--indigo)] shrink-0 mt-1" />
                      <div>
                        <p className="text-sm font-bold text-t1">{visit.service}</p>
                        <p className="text-[11px] text-t3">{formatDate(visit.date)} · {visit.doctorName}</p>
                        <span className="text-[10px] font-semibold text-t3 capitalize">{visit.status}</span>
                      </div>
                    </div>
                    <p className="text-sm font-bold text-t1 shrink-0">{formatCurrency(visit.value)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-t3 text-center py-6">No visit history found.</p>
            )}
          </BentoCard>

          {/* Communication timeline */}
          <BentoCard title="Communication Timeline" subtitle="Recent outreach history">
            <div className="space-y-2.5">
              {commsTimeline.map((item) => (
                <div key={item.date} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                  <div className="w-6 h-6 rounded-full bg-[var(--s3)] flex items-center justify-center shrink-0">
                    {channelIcon[item.type] ?? <MessageSquare className="w-3 h-3 text-t3" />}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-t2">{item.date}</p>
                    <p className="text-[11px] text-t3">{item.message}</p>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Customer info */}
          <BentoCard title="Customer Details" subtitle="Profile & preferences">
            <div className="space-y-2.5">
              {[
                { label: 'Branch', value: branch?.name ?? '—' },
                { label: 'Assigned Provider', value: assignedDoctor?.name ?? '—' },
                { label: 'Preferred Channel', value: patient.preferredChannel.toUpperCase() },
                { label: 'Total Visits', value: `${patient.visitCount} visits` },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)] last:border-0">
                  <p className="text-xs text-t3">{item.label}</p>
                  <p className="text-xs font-bold text-t1">{item.value}</p>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Consent status */}
          <BentoCard title="Consent & Channels" subtitle="Communication permissions" headerRight={<ShieldCheck className="w-4 h-4 text-emerald-v" />}>
            <div className="space-y-2">
              {[
                { label: 'SMS', granted: patient.consentStatus.sms },
                { label: 'WhatsApp', granted: patient.consentStatus.whatsapp },
                { label: 'Email', granted: patient.consentStatus.email },
                { label: 'Marketing', granted: patient.consentStatus.marketing },
              ].map((ch) => (
                <div key={ch.label} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-[var(--b1)]">
                  <p className="text-xs font-semibold text-t2">{ch.label}</p>
                  {ch.granted
                    ? <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-v"><CheckCircle2 className="w-3 h-3" /> Opted in</span>
                    : <span className="flex items-center gap-1 text-[10px] font-bold text-t3"><Clock className="w-3 h-3" /> Not consented</span>
                  }
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Tags */}
          {patient.tags.length > 0 && (
            <BentoCard title="Tags" subtitle="Customer classification">
              <div className="flex flex-wrap gap-2">
                {patient.tags.map((tag) => (
                  <span key={tag} className="badge badge-blue capitalize">{tag.replace('-', ' ')}</span>
                ))}
              </div>
            </BentoCard>
          )}

          {/* AI snapshot */}
          <BentoCard title="AI Engagement Snapshot" subtitle="Automated insight" headerRight={<Sparkles className="w-4 h-4 text-violet-v" />}>
            <p className="text-xs text-t2 leading-relaxed mb-3">
              {patient.name} is a <strong className="text-t1">{patient.lifecycleStage.replace('-', ' ')}</strong> customer with strong lifetime value. Recent service history suggests an ideal opportunity for a follow-up campaign and review request.
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[11px] text-t2"><ShieldCheck className="w-3.5 h-3.5 text-emerald-v shrink-0" /> No consent issues detected</div>
              <div className="flex items-center gap-2 text-[11px] text-t2"><CalendarDays className="w-3.5 h-3.5 text-indigo shrink-0" /> Follow-up task pending for service rebook</div>
              {patient.churnRisk >= 60 && (
                <div className="flex items-center gap-2 text-[11px] text-red-v"><AlertCircle className="w-3.5 h-3.5 shrink-0" /> High churn risk — prioritise outreach</div>
              )}
              {!patient.consentStatus.marketing && (
                <div className="flex items-center gap-2 text-[11px] text-amber-v"><AlertCircle className="w-3.5 h-3.5 shrink-0" /> No marketing consent — limit to transactional messages</div>
              )}
            </div>
            <button type="button" className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-[var(--violet-soft)] border border-[var(--b2)] text-xs font-semibold text-violet-v hover:bg-[var(--s3)] transition-colors">
              <Star className="w-3.5 h-3.5" /> Request review from this customer
            </button>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
