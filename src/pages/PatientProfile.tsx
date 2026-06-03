import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Star, ShieldCheck, MessageSquare, CalendarDays, TrendingUp, AlertCircle, Sparkles, Zap, CheckCircle2, Mail, Phone, Clock } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { patients, appointments, doctors, branches } from '../data/seedData';
import { formatCurrency, formatDate } from '../utils/formatters';
import { apiRequest } from '../lib/api';
import { mapAppointment, mapPatient, type ApiPatient } from '../lib/apiAdapters';
import { checkEligibility, type EligibilityVerification } from '../lib/revenueProtection';

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
  const fallbackPatient = patients.find(p => p.id === id);
  const [patient, setPatient] = useState(fallbackPatient);
  const [loading, setLoading] = useState(!fallbackPatient);
  const [liveVisitHistory, setLiveVisitHistory] = useState<typeof appointments>([]);
  const [eligibilityHistory, setEligibilityHistory] = useState<EligibilityVerification[]>([]);
  const [policyRow, setPolicyRow] = useState<{
    payerName: string;
    memberId: string;
    groupNumber?: string | null;
    verifiedAt?: string | null;
    verificationStatus: string;
  } | null>(null);
  const [taskState, setTaskState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [insuranceAction, setInsuranceAction] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [insuranceError, setInsuranceError] = useState<string | null>(null);
  const [acceptedPayers, setAcceptedPayers] = useState<{ id: string; name: string }[]>([]);
  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyForm, setPolicyForm] = useState({ payerId: '', planName: '', memberId: '', groupNumber: '' });
  const visitHistory = useMemo(() => appointments.filter(a => a.patientId === id), [id]);
  const assignedDoctor = doctors.find(d => d.id === patient?.assignedDoctorId);
  const branch = branches.find(b => b.id === patient?.branchId);

  useEffect(() => {
    if (!id) return;
    let active = true;
    apiRequest<ApiPatient>(`/v1/patients/${id}`)
      .then(row => {
        if (!active) return;
        setPatient(mapPatient(row));
        setLiveVisitHistory(row.appointments?.map(mapAppointment) ?? []);
        setEligibilityHistory(row.eligibilityVerifications?.map(item => ({
          id: item.id,
          branchId: row.branchId,
          branchName: branch?.name ?? '—',
          patientId: id,
          patientName: `${row.firstName} ${row.lastName}`,
          appointmentId: item.appointmentId ?? null,
          payerId: item.payerId ?? null,
          payerName: item.payer?.name ?? '—',
          policyId: null,
          memberId: item.policy?.memberId ?? null,
          providerMode: item.providerMode === 'mock' ? 'mock' : 'sandbox',
          coverageStatus: item.coverageStatus,
          planName: item.planName,
          copay: Number(item.copay),
          deductibleRemaining: Number(item.deductibleRemaining),
          coinsurance: Number(item.coinsurance),
          coverageActive: item.coverageActive,
          eligibilityMessage: item.eligibilityMessage,
          payerReference: item.payerReference ?? null,
          checkedAt: item.checkedAt,
          priorAuthRequired: item.priorAuthRequired,
          recommendedAction: item.recommendedAction,
          riskLevel: item.riskLevel,
          revenueAtRisk: item.revenueAtRisk,
        })) ?? []);
        setPolicyRow(row.patientInsurancePolicies?.[0] ? {
          payerName: row.patientInsurancePolicies[0].payer?.name ?? '—',
          memberId: row.patientInsurancePolicies[0].memberId,
          groupNumber: row.patientInsurancePolicies[0].groupNumber ?? null,
          verifiedAt: row.patientInsurancePolicies[0].verifiedAt ?? null,
          verificationStatus: row.patientInsurancePolicies[0].verificationStatus,
        } : null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [id, branch?.name]);

  useEffect(() => {
    let active = true;
    apiRequest<{ id: string; name: string }[]>('/v1/insurance/accepted')
      .then(rows => { if (active) setAcceptedPayers(rows); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function savePolicy() {
    if (!patient) return;
    const payer = acceptedPayers.find(p => p.id === policyForm.payerId);
    if (!payer || !policyForm.memberId.trim()) {
      setInsuranceError('Select an insurer and enter a member ID.');
      return;
    }
    setPolicySaving(true);
    setInsuranceError(null);
    try {
      await apiRequest('/v1/insurance/policies', {
        method: 'POST',
        body: JSON.stringify({
          patientId: patient.id,
          payerId: payer.id,
          planName: policyForm.planName.trim() || `${payer.name} Plan`,
          memberId: policyForm.memberId.trim(),
          groupNumber: policyForm.groupNumber.trim() || undefined,
        }),
      });
      setPolicyForm({ payerId: '', planName: '', memberId: '', groupNumber: '' });
      setShowPolicyForm(false);
      await refreshPatient();
    } catch (err) {
      setInsuranceError(err instanceof Error ? err.message : 'Failed to save insurance');
    } finally {
      setPolicySaving(false);
    }
  }

  async function refreshPatient() {
    if (!id) return;
    const row = await apiRequest<ApiPatient>(`/v1/patients/${id}`);
    setPatient(mapPatient(row));
    setLiveVisitHistory(row.appointments?.map(mapAppointment) ?? []);
    setEligibilityHistory(row.eligibilityVerifications?.map(item => ({
      id: item.id,
      branchId: row.branchId,
      branchName: branch?.name ?? '—',
      patientId: id,
      patientName: `${row.firstName} ${row.lastName}`,
      appointmentId: item.appointmentId ?? null,
      payerId: item.payerId ?? null,
      payerName: item.payer?.name ?? '—',
      policyId: null,
      memberId: item.policy?.memberId ?? null,
      providerMode: item.providerMode === 'mock' ? 'mock' : 'sandbox',
      coverageStatus: item.coverageStatus,
      planName: item.planName,
      copay: Number(item.copay),
      deductibleRemaining: Number(item.deductibleRemaining),
      coinsurance: Number(item.coinsurance),
      coverageActive: item.coverageActive,
      eligibilityMessage: item.eligibilityMessage,
      payerReference: item.payerReference ?? null,
      checkedAt: item.checkedAt,
      priorAuthRequired: item.priorAuthRequired,
      recommendedAction: item.recommendedAction,
      riskLevel: item.riskLevel,
      revenueAtRisk: item.revenueAtRisk,
    })) ?? []);
    setPolicyRow(row.patientInsurancePolicies?.[0] ? {
      payerName: row.patientInsurancePolicies[0].payer?.name ?? '—',
      memberId: row.patientInsurancePolicies[0].memberId,
      groupNumber: row.patientInsurancePolicies[0].groupNumber ?? null,
      verifiedAt: row.patientInsurancePolicies[0].verifiedAt ?? null,
      verificationStatus: row.patientInsurancePolicies[0].verificationStatus,
    } : null);
  }

  async function createFollowUpTask() {
    if (!patient) return;
    setTaskState('saving');
    try {
      await apiRequest(`/v1/patients/${patient.id}/follow-up-task`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setTaskState('saved');
    } catch {
      setTaskState('idle');
    }
  }

  async function verifyNow() {
    if (!patient) return;
    const latestAppointment = visibleVisitHistory.find(visit => visit.status !== 'completed' && visit.status !== 'canceled') ?? visibleVisitHistory[0];
    if (!latestAppointment) {
      setInsuranceError('No appointment available to verify.');
      return;
    }
    setInsuranceAction('saving');
    setInsuranceError(null);
    try {
      await checkEligibility({
        patientId: patient.id,
        appointmentId: latestAppointment.id,
        branchId: patient.branchId,
        serviceType: latestAppointment.service,
      });
      await refreshPatient();
      setInsuranceAction('saved');
    } catch (err) {
      setInsuranceError(err instanceof Error ? err.message : 'Unable to verify insurance');
      setInsuranceAction('idle');
    }
  }

  if (!patient) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          {loading ? <Clock className="w-8 h-8 text-t3 mx-auto mb-2 animate-pulse" /> : <AlertCircle className="w-8 h-8 text-t3 mx-auto mb-2" />}
          <p className="text-sm text-t3">{loading ? 'Loading customer profile…' : 'Customer not found.'}</p>
        </div>
      </div>
    );
  }

  const lc = lifecycleConfig[patient.lifecycleStage];
  const visibleVisitHistory = liveVisitHistory.length > 0 ? liveVisitHistory : visitHistory;
  const totalSpend = visibleVisitHistory.reduce((s, v) => s + v.value, 0);
  const latestEligibility = eligibilityHistory[0] ?? null;
  const coverageActive = latestEligibility?.coverageActive ?? policyRow?.verificationStatus === 'verified';
  const normalizedCoverage = (latestEligibility?.coverageStatus ?? policyRow?.verificationStatus ?? 'Not Verified').toUpperCase();
  const coverageLabel = normalizedCoverage === 'ACTIVE'
    ? 'Active'
    : normalizedCoverage === 'INACTIVE'
      ? 'Inactive'
      : normalizedCoverage === 'VERIFIED'
        ? 'Active'
        : normalizedCoverage;

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
          <button type="button" onClick={() => void createFollowUpTask()} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo-soft)] border border-[var(--b2)] px-3 py-2 text-xs font-semibold text-indigo hover:bg-[var(--s3)] transition">
            <Zap className="w-3.5 h-3.5" /> {taskState === 'saving' ? 'Creating task…' : taskState === 'saved' ? 'Task created' : 'Create follow-up task'}
          </button>
          <button type="button" onClick={() => navigate('/scheduling')} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition">
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
          <BentoCard title="Service History" subtitle={`${visibleVisitHistory.length} visits · ${formatCurrency(totalSpend)} total`} headerRight={<TrendingUp className="w-4 h-4 text-t3" />}>
            {visibleVisitHistory.length > 0 ? (
              <div className="space-y-2.5">
                {visibleVisitHistory.map((visit) => (
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

          <BentoCard title="Patient Insurance" subtitle="Verify coverage, payer, and member details" headerRight={<ShieldCheck className="w-4 h-4 text-emerald-v" />}>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Payer</p>
                <p className="text-xs font-bold text-t1">{policyRow?.payerName ?? latestEligibility?.payerName ?? '—'}</p>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Member ID</p>
                <p className="text-xs font-bold text-t1">{policyRow?.memberId ?? latestEligibility?.memberId ?? '—'}</p>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Group Number</p>
                <p className="text-xs font-bold text-t1">{policyRow?.groupNumber ?? '—'}</p>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Coverage Status</p>
                <span className={`badge ${coverageActive ? 'badge-emerald' : 'badge-amber'}`}>{coverageLabel}</span>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Last Verified</p>
                <p className="text-xs font-bold text-t1">{formatDate(policyRow?.verifiedAt ?? latestEligibility?.checkedAt ?? undefined)}</p>
              </div>
              {latestEligibility && (
                <>
                  <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                    <p className="text-xs text-t3">Copay</p>
                    <p className="text-xs font-bold text-t1">{formatCurrency(latestEligibility.copay)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                    <p className="text-xs text-t3">Deductible</p>
                    <p className="text-xs font-bold text-t1">{formatCurrency(latestEligibility.deductibleRemaining)}</p>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                    <p className="text-xs text-t3">Auth</p>
                    <p className="text-xs font-bold text-t1">{latestEligibility.priorAuthRequired ? 'Required' : 'Not Required'}</p>
                  </div>
                </>
              )}
              {insuranceError && <p className="text-[11px] text-red-v">{insuranceError}</p>}

              {showPolicyForm ? (
                <div className="p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
                  <select aria-label="Insurer" value={policyForm.payerId} onChange={e => setPolicyForm(f => ({ ...f, payerId: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]">
                    <option value="">Select insurer…</option>
                    {acceptedPayers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input value={policyForm.memberId} onChange={e => setPolicyForm(f => ({ ...f, memberId: e.target.value }))} placeholder="Member ID" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                  <div className="grid grid-cols-2 gap-2">
                    <input value={policyForm.groupNumber} onChange={e => setPolicyForm(f => ({ ...f, groupNumber: e.target.value }))} placeholder="Group (optional)" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                    <input value={policyForm.planName} onChange={e => setPolicyForm(f => ({ ...f, planName: e.target.value }))} placeholder="Plan (optional)" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" disabled={policySaving} onClick={() => void savePolicy()} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">{policySaving ? 'Saving…' : 'Save insurance'}</button>
                    <button type="button" onClick={() => setShowPolicyForm(false)} className="px-3 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)]">Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setShowPolicyForm(true)} className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition">
                  <ShieldCheck className="w-3.5 h-3.5" /> {policyRow ? 'Update insurance' : 'Add insurance'}
                </button>
              )}

              <button type="button" onClick={() => void verifyNow()} className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition">
                <ShieldCheck className="w-3.5 h-3.5" />
                {insuranceAction === 'saving' ? 'Verifying…' : insuranceAction === 'saved' ? 'Verified' : 'Verify Now'}
              </button>
              <div className="space-y-2 pt-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Eligibility History</p>
                {eligibilityHistory.length === 0 ? (
                  <p className="text-xs text-t3">No eligibility history yet.</p>
                ) : (
                  eligibilityHistory.map(item => (
                    <div key={item.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-t1">{item.coverageStatus}</p>
                        <span className={`badge ${item.coverageActive ? 'badge-emerald' : 'badge-amber'}`}>{item.riskLevel ?? 'LOW'}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-t3">{formatDate(item.checkedAt)}</p>
                      <p className="mt-1 text-[11px] text-t3">{item.recommendedAction ?? item.eligibilityMessage}</p>
                    </div>
                  ))
                )}
              </div>
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
          <BentoCard title="Engagement Snapshot" subtitle="Automated insight" headerRight={<Sparkles className="w-4 h-4 text-violet-v" />}>
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
            <button type="button" onClick={() => navigate('/reviews')} className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-[var(--violet-soft)] border border-[var(--b2)] text-xs font-semibold text-violet-v hover:bg-[var(--s3)] transition-colors">
              <Star className="w-3.5 h-3.5" /> Request review from this customer
            </button>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
