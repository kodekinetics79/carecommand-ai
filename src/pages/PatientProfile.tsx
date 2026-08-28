import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArrowLeft, Star, ShieldCheck, CalendarDays, TrendingUp, AlertCircle, Sparkles, Zap, Clock, Pencil, ClipboardList } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import FormDialog from '../components/workflow/FormDialog';
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
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  const [profileLoadAttempt, setProfileLoadAttempt] = useState(0);
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
  const [payerOptions, setPayerOptions] = useState<{ id: string; name: string }[]>([]);
  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyForm, setPolicyForm] = useState({ payerId: '', planName: '', memberId: '', groupNumber: '' });

  function maskMemberId(value?: string | null) {
    const normalized = value?.trim();
    if (!normalized) return '—';
    const visible = normalized.slice(-4);
    return normalized.length <= 4 ? `••••${visible}` : `${'•'.repeat(Math.min(8, normalized.length - 4))}${visible}`;
  }
  // Edit patient record (name / contact / DOB) — PATCH /v1/patients/:id.
  const [showEdit, setShowEdit] = useState(false);
  const [editDefaults, setEditDefaults] = useState({ firstName: '', lastName: '', email: '', phone: '', dateOfBirth: '' });
  // Originate an intake link for this patient.
  const [intakeState, setIntakeState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [intakeNotice, setIntakeNotice] = useState<{ kind: 'success' | 'warning' | 'error'; text: string } | null>(null);
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
        setProfileLoadError(null);
        setPatient(mapPatient(row));
        setEditDefaults({ firstName: row.firstName, lastName: row.lastName, email: row.email ?? '', phone: row.phone ?? '', dateOfBirth: row.dateOfBirth?.slice(0, 10) ?? '' });
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
      .catch(() => {
        if (active) setProfileLoadError('Patient profile data is unavailable. Try again or return to Patients.');
      })
      .finally(() => {
        if (active) setLoadedId(id);
      });
    return () => { active = false; };
    // branch?.name backfills eligibility rows once branch options resolve.
  }, [id, branch?.name, profileLoadAttempt]);

  useEffect(() => {
    let active = true;
    apiRequest<{ id: string; name: string }[]>('/v1/insurance/accepted')
      .then(rows => { if (active) setPayerOptions(rows); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function savePolicy() {
    if (!patient) return;
    const payer = payerOptions.find(p => p.id === policyForm.payerId);
    if (!payer || !policyForm.planName.trim() || !policyForm.memberId.trim()) {
      setInsuranceError('Select a payer and enter the plan name and member ID exactly as recorded on the policy.');
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
          planName: policyForm.planName.trim(),
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
    setEditDefaults({ firstName: row.firstName, lastName: row.lastName, email: row.email ?? '', phone: row.phone ?? '', dateOfBirth: row.dateOfBirth?.slice(0, 10) ?? '' });
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

  async function savePatient(values: Record<string, string>) {
    if (!patient) throw new Error('Patient record is unavailable.');
    if (!values.firstName?.trim() || !values.lastName?.trim()) throw new Error('First and last name are required.');
    await apiRequest(`/v1/patients/${patient.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email?.trim() || undefined,
        phone: values.phone?.trim() || undefined,
        dateOfBirth: values.dateOfBirth || undefined,
      }),
    });
    await refreshPatient();
  }

  async function sendIntake() {
    if (!patient) return;
    setIntakeState('saving');
    setIntakeNotice(null);
    try {
      const packet = await intakeApi.createPacket({ patientId: patient.id, source: 'staff' });
      const link = packet.publicUrl || (packet.publicToken ? `/intake/${packet.publicToken}` : null);
      let copied = false;
      if (link) {
        try {
          await navigator.clipboard.writeText(link);
          copied = true;
        } catch {
          copied = false;
        }
      }
      setIntakeState('saved');
      setIntakeNotice(link
        ? copied
          ? { kind: 'success', text: 'Intake link created and copied to the clipboard. No message was sent.' }
          : { kind: 'warning', text: 'Intake link created, but it was not copied. Open Patient Intake to retrieve it. No message was sent.' }
        : { kind: 'warning', text: 'Intake packet created, but no shareable link was returned. No message was sent.' });
    } catch {
      setIntakeState('idle');
      setIntakeNotice({ kind: 'error', text: 'The intake link could not be created. Try again; no message was sent.' });
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" role="status" aria-live="polite" aria-busy="true">
        <div className="text-center">
          <Clock className="w-8 h-8 text-t3 mx-auto mb-2 animate-pulse" />
          <p className="text-sm text-t3">Loading patient profile…</p>
        </div>
      </div>
    );
  }

  if (profileLoadError) {
    return (
      <div className="flex items-center justify-center h-64">
        <div role="alert" className="max-w-md rounded-2xl border border-red-v/30 bg-[var(--red-soft)] p-5 text-center">
          <AlertCircle className="w-8 h-8 text-red-v mx-auto mb-2" />
          <p className="text-sm font-semibold text-red-v">{profileLoadError}</p>
          <div className="mt-3 flex justify-center gap-2">
            <button type="button" onClick={() => { setProfileLoadError(null); setLoadedId(null); setProfileLoadAttempt(value => value + 1); }} className="rounded-lg bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white">Try again</button>
            <button type="button" onClick={() => navigate('/patients')} className="rounded-lg border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2">Return to Patients</button>
          </div>
        </div>
      </div>
    );
  }

  if (!patient) {
    return <div role="status" className="flex h-64 items-center justify-center text-sm text-t3">No patient record was returned.</div>;
  }

  const lc = lifecycleConfig[patient.lifecycleStage];
  const visibleVisitHistory = liveVisitHistory;
  const totalSpend = visibleVisitHistory.reduce((s, v) => s + v.value, 0);
  const latestEligibility = eligibilityHistory[0] ?? null;
  const coverageActive = latestEligibility?.coverageActive === true;
  const normalizedCoverage = latestEligibility?.coverageStatus?.toUpperCase();
  const coverageLabel = normalizedCoverage === 'ACTIVE'
    ? 'Active response'
    : normalizedCoverage === 'INACTIVE'
      ? 'Inactive response'
      : normalizedCoverage
        ? `${normalizedCoverage.replaceAll('_', ' ').toLowerCase()} response`
        : policyRow
          ? `Policy status: ${policyRow.verificationStatus.replaceAll('_', ' ').toLowerCase()}`
          : 'Not checked';

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
              <p className="text-xs text-t3 mt-0.5">{patient.age === null ? 'Date of birth not recorded' : `Age ${patient.age}`} · {branch?.name ?? 'Assigned branch'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          <button type="button" onClick={() => setShowEdit(true)} className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition">
            <Pencil className="w-3.5 h-3.5" /> Edit record
          </button>
          <button type="button" disabled={intakeState === 'saving'} onClick={() => void sendIntake()} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--violet-soft)] border border-[var(--b2)] px-3 py-2 text-xs font-semibold text-violet-v hover:bg-[var(--s3)] transition disabled:opacity-50">
            <ClipboardList className="w-3.5 h-3.5" /> {intakeState === 'saving' ? 'Creating link…' : intakeState === 'saved' ? 'Intake link created' : 'Create intake link'}
          </button>
          <button type="button" onClick={() => void createFollowUpTask()} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo-soft)] border border-[var(--b2)] px-3 py-2 text-xs font-semibold text-indigo hover:bg-[var(--s3)] transition">
            <Zap className="w-3.5 h-3.5" /> {taskState === 'saving' ? 'Creating task…' : taskState === 'saved' ? 'Task created' : 'Create follow-up task'}
          </button>
          <button type="button" onClick={() => navigate('/scheduling')} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition">
            <CalendarDays className="w-3.5 h-3.5" /> Open scheduling
          </button>
        </div>
      </div>

      {intakeNotice && <p role={intakeNotice.kind === 'error' ? 'alert' : 'status'} aria-live="polite" className={`text-[11px] font-semibold -mt-2 ${intakeNotice.kind === 'success' ? 'text-emerald-v' : intakeNotice.kind === 'warning' ? 'text-amber-v' : 'text-red-v'}`}>{intakeNotice.text}</p>}

      {showEdit && (
        <FormDialog
          title="Edit patient record"
          message="Update contact and identity details stored in this patient record."
          submitLabel="Save changes"
          fields={[
            { name: 'firstName', label: 'First name', initialValue: editDefaults.firstName, required: true },
            { name: 'lastName', label: 'Last name', initialValue: editDefaults.lastName, required: true },
            { name: 'email', label: 'Email', type: 'email', initialValue: editDefaults.email },
            { name: 'phone', label: 'Phone', type: 'tel', initialValue: editDefaults.phone },
            { name: 'dateOfBirth', label: 'Date of birth', type: 'date', initialValue: editDefaults.dateOfBirth },
          ]}
          onSubmit={savePatient}
          onClose={() => setShowEdit(false)}
        />
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
          <p className="text-base font-bold text-t1">{patient.lastVisit ? formatDate(patient.lastVisit) : 'No completed visit recorded'}</p>
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
            <p className="text-sm text-t3 py-4">Communication history is unavailable on this page. Do not infer that no contact occurred.</p>
          </BentoCard>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Patient info */}
          <BentoCard title="Patient Details" subtitle="Profile and communication preferences">
            <div className="space-y-2.5">
              {[
                { label: 'Branch', value: branch?.name ?? '—' },
                { label: 'Assigned Provider', value: assignedDoctor?.name ?? '—' },
                { label: 'Preferred channel', value: patient.preferredChannel?.toUpperCase() ?? 'None recorded' },
                { label: 'Total Visits', value: `${patient.visitCount} visits` },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)] last:border-0">
                  <p className="text-xs text-t3">{item.label}</p>
                  <p className="text-xs font-bold text-t1">{item.value}</p>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Patient Insurance" subtitle="Policy details and point-in-time eligibility results; not a coverage or payment guarantee" headerRight={<ShieldCheck className="w-4 h-4 text-emerald-v" />}>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Payer</p>
                <p className="text-xs font-bold text-t1">{policyRow?.payerName ?? latestEligibility?.payerName ?? '—'}</p>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Member ID</p>
                <p className="text-xs font-bold text-t1">{maskMemberId(policyRow?.memberId ?? latestEligibility?.memberId)}</p>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Group Number</p>
                <p className="text-xs font-bold text-t1">{policyRow?.groupNumber ?? '—'}</p>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Eligibility Response</p>
                <span className={`badge ${coverageActive ? 'badge-emerald' : 'badge-amber'}`}>{coverageLabel}</span>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--b1)]">
                <p className="text-xs text-t3">Last Checked</p>
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
                    <p className="text-xs text-t3">Prior Authorization Response</p>
                    <p className="text-xs font-bold text-t1">{latestEligibility.priorAuthRequired ? 'Reported as required' : 'Not reported as required'}</p>
                  </div>
                </>
              )}
              {insuranceError && <p className="text-[11px] text-red-v">{insuranceError}</p>}

              {showPolicyForm ? (
                <div className="p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
                  <select aria-label="Insurer" value={policyForm.payerId} onChange={e => setPolicyForm(f => ({ ...f, payerId: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]">
                    <option value="">Select insurer…</option>
                    {payerOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input value={policyForm.memberId} onChange={e => setPolicyForm(f => ({ ...f, memberId: e.target.value }))} placeholder="Member ID" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                  <div className="grid grid-cols-2 gap-2">
                    <input value={policyForm.groupNumber} onChange={e => setPolicyForm(f => ({ ...f, groupNumber: e.target.value }))} placeholder="Group (optional)" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                    <input value={policyForm.planName} onChange={e => setPolicyForm(f => ({ ...f, planName: e.target.value }))} placeholder="Plan name" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" disabled={policySaving} onClick={() => void savePolicy()} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">{policySaving ? 'Saving…' : 'Save policy details'}</button>
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
                {insuranceAction === 'saving' ? 'Checking…' : insuranceAction === 'saved' ? 'Eligibility response recorded' : 'Run Eligibility Check'}
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
                      <p className="mt-1 text-[11px] text-t3">{item.eligibilityMessage || 'No payer message recorded.'}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </BentoCard>

          {/* Historical channel settings are not purpose-specific outreach authority. */}
          <BentoCard title="Recorded channel preferences" subtitle="Historical settings · not purpose-specific outreach authority" headerRight={<AlertCircle className="w-4 h-4 text-amber-v" />}>
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
                    ? <span className="flex items-center gap-1 text-[10px] font-bold text-amber-v"><AlertCircle className="w-3 h-3" /> Prior affirmative record</span>
                    : <span className="flex items-center gap-1 text-[10px] font-bold text-t3"><Clock className="w-3 h-3" /> No affirmative record</span>
                  }
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Tags */}
          {patient.tags.length > 0 && (
            <BentoCard title="Tags" subtitle="Patient record classification">
              <div className="flex flex-wrap gap-2">
                {patient.tags.map((tag) => (
                  <span key={tag} className="badge badge-blue capitalize">{tag.replace('-', ' ')}</span>
                ))}
              </div>
            </BentoCard>
          )}

          {/* Fact-based snapshot */}
          <BentoCard title="Engagement Snapshot" subtitle="Recorded profile facts; no outreach recommendation" headerRight={<Sparkles className="w-4 h-4 text-violet-v" />}>
            <p className="text-xs text-t2 leading-relaxed mb-3">
              {patient.name} has a recorded lifecycle stage of <strong className="text-t1">{patient.lifecycleStage.replace('-', ' ')}</strong>, {patient.visitCount} recorded visit{patient.visitCount === 1 ? '' : 's'}, and a stored lifetime value of {formatCurrency(patient.lifetimeValue)}.
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[11px] text-t2"><AlertCircle className="w-3.5 h-3.5 text-amber-v shrink-0" /> Historical channel settings are listed above. Verify current purpose-specific authority and suppression status before contact.</div>
              <div className="flex items-center gap-2 text-[11px] text-t2"><CalendarDays className="w-3.5 h-3.5 text-indigo shrink-0" /> This page does not infer whether follow-up is clinically or operationally appropriate.</div>
              {patient.churnRisk >= 60 && (
                <div className="flex items-center gap-2 text-[11px] text-amber-v"><AlertCircle className="w-3.5 h-3.5 shrink-0" /> Stored churn score is high. Review purpose, appropriateness, and contact authority before taking action.</div>
              )}
              {!patient.consentStatus.marketing && (
                <div className="flex items-center gap-2 text-[11px] text-amber-v"><AlertCircle className="w-3.5 h-3.5 shrink-0" /> No affirmative marketing record is shown. This does not authorize another message type.</div>
              )}
            </div>
            <button type="button" onClick={() => navigate('/reviews')} className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-[var(--violet-soft)] border border-[var(--b2)] text-xs font-semibold text-violet-v hover:bg-[var(--s3)] transition-colors">
              <Star className="w-3.5 h-3.5" /> Open review workflow
            </button>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
