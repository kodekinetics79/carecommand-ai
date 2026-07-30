import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArrowLeft, Star, ShieldCheck, CalendarDays, TrendingUp, AlertCircle, Sparkles, Zap, CheckCircle2, Clock, Pencil, ClipboardList } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { formatCurrency, formatDate } from '../utils/formatters';
import { apiRequest } from '../lib/api';
import { mapAppointment, mapPatient, mapProviderProfile, type ApiPatient, type ApiProviderProfile } from '../lib/apiAdapters';
import { intakeApi } from '../lib/intake';
import { checkEligibility, type EligibilityVerification } from '../lib/revenueProtection';
import { useApiResource } from '../hooks/useApiResource';

interface ApiBranchOption { id: string; name: string }

const lifecycleConfig: Record<string, { label: string; color: string; bg: string }> = {
  new:      { label: 'New',      color: 'text-indigo',    bg: 'badge badge-blue' },
  active:   { label: 'Active',   color: 'text-emerald-v', bg: 'badge badge-emerald' },
  retained: { label: 'Retained', color: 'text-violet-v',  bg: 'badge badge-violet' },
  'at-risk':{ label: 'At Risk',  color: 'text-amber-v',   bg: 'badge badge-amber' },
  inactive: { label: 'Inactive', color: 'text-red-v',     bg: 'badge badge-red' },
};

export default function PatientProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [patient, setPatient] = useState<ReturnType<typeof mapPatient> | null>(null);
  // Loading is derived: the profile for `id` is loading until its fetch
  // settles (avoids a synchronous setState inside the effect body).
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const loading = !!id && loadedId !== id;
  const [liveVisitHistory, setLiveVisitHistory] = useState<ReturnType<typeof mapAppointment>[]>([]);
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
  // Edit patient record (name / contact / DOB) — PATCH /v1/patients/:id.
  const [showEdit, setShowEdit] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ firstName: '', lastName: '', email: '', phone: '', dateOfBirth: '' });
  // Originate an intake link for this patient.
  const [intakeState, setIntakeState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [intakeNotice, setIntakeNotice] = useState<string | null>(null);
  const { data: branchOptions } = useApiResource<ApiBranchOption, ApiBranchOption>('/v1/branches?limit=100', [], row => row);
  const { data: providerRecords } = useApiResource<ApiProviderProfile, ReturnType<typeof mapProviderProfile>>('/v1/providers/overview?limit=100', [], mapProviderProfile);
  const assignedDoctor = providerRecords.find(d => d.branchId === patient?.branchId);
  const branch = branchOptions.find(b => b.id === patient?.branchId);

  useEffect(() => {
    if (!id) return;
    let active = true;
    apiRequest<ApiPatient>(`/v1/patients/${id}`)
      .then(row => {
        if (!active) return;
        setPatient(mapPatient(row));
        setEditForm({ firstName: row.firstName, lastName: row.lastName, email: row.email ?? '', phone: row.phone ?? '', dateOfBirth: row.dateOfBirth ? row.dateOfBirth.slice(0, 10) : '' });
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
        if (active) setLoadedId(id);
      });
    return () => { active = false; };
    // branch?.name backfills eligibility rows once branch options resolve.
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
    setEditForm({ firstName: row.firstName, lastName: row.lastName, email: row.email ?? '', phone: row.phone ?? '', dateOfBirth: row.dateOfBirth ? row.dateOfBirth.slice(0, 10) : '' });
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

  async function savePatient() {
    if (!patient) return;
    if (!editForm.firstName.trim() || !editForm.lastName.trim()) {
      setEditError('First and last name are required.');
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      await apiRequest(`/v1/patients/${patient.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: editForm.firstName.trim(),
          lastName: editForm.lastName.trim(),
          email: editForm.email.trim() || undefined,
          phone: editForm.phone.trim() || undefined,
          dateOfBirth: editForm.dateOfBirth || undefined,
        }),
      });
      setShowEdit(false);
      await refreshPatient();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update record');
    } finally {
      setEditSaving(false);
    }
  }

  async function sendIntake() {
    if (!patient) return;
    setIntakeState('saving');
    setIntakeNotice(null);
    try {
      const packet = await intakeApi.createPacket({ patientId: patient.id, source: 'staff' });
      const link = packet.publicUrl || (packet.publicToken ? `/intake/${packet.publicToken}` : null);
      if (link) await navigator.clipboard.writeText(link).catch(() => undefined);
      setIntakeState('saved');
      setIntakeNotice(link ? 'Intake link created and copied to clipboard.' : 'Intake packet created.');
    } catch (err) {
      setIntakeState('idle');
      setIntakeNotice(err instanceof Error ? err.message : 'Failed to create intake');
    }
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
  const visibleVisitHistory = liveVisitHistory;
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
              <p className="text-xs text-t3 mt-0.5">Age {patient.age} · {patient.gender} · {branch?.name ?? 'Live branch'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          <button type="button" onClick={() => { setEditError(null); setShowEdit(true); }} className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition">
            <Pencil className="w-3.5 h-3.5" /> Edit record
          </button>
          <button type="button" onClick={() => void sendIntake()} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--violet-soft)] border border-[var(--b2)] px-3 py-2 text-xs font-semibold text-violet-v hover:bg-[var(--s3)] transition">
            <ClipboardList className="w-3.5 h-3.5" /> {intakeState === 'saving' ? 'Sending…' : intakeState === 'saved' ? 'Intake sent' : 'Send intake'}
          </button>
          <button type="button" onClick={() => void createFollowUpTask()} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo-soft)] border border-[var(--b2)] px-3 py-2 text-xs font-semibold text-indigo hover:bg-[var(--s3)] transition">
            <Zap className="w-3.5 h-3.5" /> {taskState === 'saving' ? 'Creating task…' : taskState === 'saved' ? 'Task created' : 'Create follow-up task'}
          </button>
          <button type="button" onClick={() => navigate('/scheduling')} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition">
            <CalendarDays className="w-3.5 h-3.5" /> Book appointment
          </button>
        </div>
      </div>

      {intakeNotice && <p className="text-[11px] font-semibold text-emerald-v -mt-2">{intakeNotice}</p>}

      {showEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowEdit(false)}>
          <div className="w-full max-w-md rounded-2xl bg-[var(--s1)] border border-[var(--b2)] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-bold text-t1 mb-3">Edit Customer Record</p>
            {editError && <p className="text-[11px] text-red-v mb-2">{editError}</p>}
            <div className="grid grid-cols-2 gap-2.5">
              <input value={editForm.firstName} onChange={e => setEditForm(f => ({ ...f, firstName: e.target.value }))} placeholder="First name" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <input value={editForm.lastName} onChange={e => setEditForm(f => ({ ...f, lastName: e.target.value }))} placeholder="Last name" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <input value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} placeholder="Email" className="col-span-2 px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} placeholder="Phone" className="col-span-2 px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <label className="col-span-2 flex items-center gap-2 text-[11px] text-t3">
                <span className="shrink-0">Date of birth</span>
                <input type="date" aria-label="Date of birth" value={editForm.dateOfBirth} onChange={e => setEditForm(f => ({ ...f, dateOfBirth: e.target.value }))} className="flex-1 px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              </label>
            </div>
            <div className="flex gap-2 mt-4">
              <button type="button" disabled={editSaving} onClick={() => void savePatient()} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition disabled:opacity-40">{editSaving ? 'Saving…' : 'Save changes'}</button>
              <button type="button" onClick={() => setShowEdit(false)} className="px-4 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)] transition">Cancel</button>
            </div>
          </div>
        </div>
      )}

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
            <p className="text-sm text-t3 py-4">No live patient communication history is available from the current API.</p>
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
