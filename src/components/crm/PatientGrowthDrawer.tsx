import { useEffect, useState } from 'react';
import { X, User, Mail, Phone, CalendarDays, ShieldCheck, CreditCard, Sparkles, Tag } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import ConsentBadgeGroup from './ConsentBadgeGroup';
import { apiRequest } from '../../lib/api';
import type { CrmLead, CrmPatient } from '../../lib/crmService';

interface PatientDetail {
  appointments?: Array<{ id: string; service: string; startsAt: string; status: string }>;
  patientInsurancePolicies?: Array<{ payerName: string; planName: string }>;
  eligibilityVerifications?: Array<{ status: string }>;
}

export default function PatientGrowthDrawer({ lead, patient, onClose, onNavigate }: {
  lead?: CrmLead; patient?: CrmPatient; onClose: () => void; onNavigate: (route: string) => void;
}) {
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const subjectName = patient?.name ?? lead?.name ?? 'Record';
  const isPatient = !!patient;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!patient) return;
    let a = true;
    void (async () => { try { const d = await apiRequest<PatientDetail>(`/v1/patients/${patient.id}`); if (a) setDetail(d); } catch { /* ignore */ } })();
    return () => { a = false; };
  }, [patient]);

  const consent = patient?.consent ?? lead?.consent ?? { email: true, sms: true, whatsapp: false, voice: true, marketing: false, doNotContact: false, campaignReady: false };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${subjectName} growth profile`}>
      <button type="button" aria-label="Close panel" title="Close panel" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-md glass-surface h-full overflow-y-auto animate-fade-up flex flex-col">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--b1)] glass-surface-head">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full logo-user grid place-items-center text-[12px] font-bold text-white shrink-0">{subjectName.split(' ').map(s => s[0]).slice(0, 2).join('')}</div>
            <div className="min-w-0">
              <p className="text-base font-bold text-t1 leading-tight truncate">{subjectName}</p>
              <span className={`badge ${isPatient ? 'badge-emerald' : 'badge-blue'}`}>{isPatient ? 'Patient' : 'Lead'}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-t3 hover:text-t1 shrink-0"><X className="w-5 h-5" /></button>
        </header>

        <div className="p-5 space-y-4 flex-1">
          {/* Identity + contact */}
          <Block icon={<User className="w-3.5 h-3.5" />} title="Identity & contact">
            <Row icon={<Mail className="w-3.5 h-3.5" />} label="Email" value={patient?.email ?? lead?.email ?? '—'} />
            <Row icon={<Phone className="w-3.5 h-3.5" />} label="Phone" value={patient?.phone ?? lead?.phone ?? '—'} />
            <Row icon={<Sparkles className="w-3.5 h-3.5" />} label="Source" value={lead?.source ?? 'Existing patient'} />
            <Row icon={<Tag className="w-3.5 h-3.5" />} label={isPatient ? 'Treatment interest' : 'Service interest'} value={lead?.service ?? (patient?.tags.join(', ') || '—')} />
          </Block>

          {/* Consent */}
          <Block icon={<ShieldCheck className="w-3.5 h-3.5" />} title="Consent & communication">
            <ConsentBadgeGroup consent={consent} />
            <p className="text-[11px] text-t3 mt-2">Preferred channel: <span className="font-semibold text-t2">{lead?.bestChannel ?? (consent.whatsapp ? 'WhatsApp' : consent.sms ? 'SMS' : 'Email')}</span></p>
          </Block>

          {/* Value + risk */}
          <div className="grid grid-cols-2 gap-2.5">
            {isPatient ? <>
              <Metric label="Lifetime value" value={formatCurrency(patient!.lifetimeValue)} accent />
              <Metric label="Churn risk" value={`${patient!.churnRisk}%`} danger={patient!.churnRisk >= 50} />
              <Metric label="Last visit" value={patient!.lastVisit ? new Date(patient!.lastVisit).toLocaleDateString() : '—'} />
              <Metric label="Next visit" value={patient!.nextVisit ? new Date(patient!.nextVisit).toLocaleDateString() : 'Not booked'} />
            </> : <>
              <Metric label="AI score" value={String(lead!.score)} accent={lead!.score >= 70} />
              <Metric label="Estimated value" value={formatCurrency(lead!.estimatedValue)} />
              <Metric label="Stage" value={lead!.stage.replace('-', ' ')} />
              <Metric label="Age" value={`${lead!.ageDays}d`} />
            </>}
          </div>

          {/* Appointment history (real, patient only) */}
          {isPatient && (
            <Block icon={<CalendarDays className="w-3.5 h-3.5" />} title="Appointment history">
              {detail === null ? <div className="skeleton-line h-10 rounded-lg" />
                : detail.appointments?.length ? detail.appointments.slice(0, 4).map(a => (
                  <div key={a.id} className="flex items-center justify-between text-[11px] py-1 border-b border-[var(--b0)] last:border-0">
                    <span className="text-t2">{a.service}</span>
                    <span className="text-t3">{new Date(a.startsAt).toLocaleDateString()} · {a.status.toLowerCase()}</span>
                  </div>
                )) : <p className="text-[11px] text-t3">No appointments on record.</p>}
            </Block>
          )}

          {/* Insurance readiness (real, patient only) */}
          {isPatient && (
            <Block icon={<CreditCard className="w-3.5 h-3.5" />} title="Insurance & payment">
              {detail?.patientInsurancePolicies?.length
                ? <p className="text-[12px] text-t2">{detail.patientInsurancePolicies[0].payerName} · {detail.patientInsurancePolicies[0].planName}{detail.eligibilityVerifications?.length ? ` · eligibility ${detail.eligibilityVerifications[0].status}` : ''}</p>
                : <p className="text-[11px] text-t3">No insurance policy on file.</p>}
            </Block>
          )}

        </div>

        <footer className="p-5 border-t border-[var(--b1)] bg-[var(--s1)] grid grid-cols-2 gap-2">
          <button type="button" onClick={() => onNavigate('/patients' + (isPatient ? `/${patient!.id}` : ''))} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-[var(--b1)] px-3 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)] transition">
            <User className="w-4 h-4" /> Full record
          </button>
          <button type="button" onClick={() => onNavigate('/campaigner')} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--indigo)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Sparkles className="w-4 h-4" /> Next best action
          </button>
        </footer>
      </div>
    </div>
  );
}

function Block({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">{icon} {title}</p>
      {children}
    </div>
  );
}
function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="inline-flex items-center gap-1.5 text-[11px] text-t3">{icon}{label}</span>
      <span className="text-[12px] font-semibold text-t1 truncate max-w-[60%]">{value}</span>
    </div>
  );
}
function Metric({ label, value, accent, danger }: { label: string; value: string; accent?: boolean; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-t3">{label}</p>
      <p className={`text-[13px] font-bold capitalize ${danger ? 'text-red-v' : accent ? 'text-emerald-v' : 'text-t1'}`}>{value}</p>
    </div>
  );
}
