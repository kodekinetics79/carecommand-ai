import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CreditCard,
  DollarSign,
  ExternalLink,
  FileBadge2,
  ShieldCheck,
  Sparkles,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import StatCard from '../components/ui/StatCard';
import ProgressBar from '../components/ui/ProgressBar';
import ModuleTabs from '../components/ui/ModuleTabs';
import ConfirmationModal from '../components/workflow/ConfirmationModal';
import { formatCurrency } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import {
  checkEligibility,
  createDepositRule,
  createPaymentLink,
  fetchAppointmentVerificationQueue,
  fetchRevenueProtectionIntegrationStatus,
  fetchRevenueProtectionOverview,
  markEligibilityVerified,
  updateAlertStatus,
  updateDepositRequirementStatus,
  updateDepositRule,
  updatePaymentStatus,
  updatePriorAuthStatus,
  type DepositRequirement,
  type DepositRule,
  type EligibilityVerification,
  type PatientInsurancePolicy,
  type PriorAuthorization,
  type RevenueProtectionAlert,
  type RevenueProtectionIntegrationStatus,
  type RevenueProtectionOverview,
  type AppointmentVerificationQueueRow,
} from '../lib/revenueProtection';

type ClinicOption = { id: string; name: string; location: string };
type PaymentActionRow = {
  id: string;
  branchId: string;
  branchName: string;
  patientId?: string | null;
  patientName: string;
  appointmentId?: string | null;
  appointmentService?: string | null;
  paymentRequestId?: string | null;
  amount?: number;
  recommendedCollectAmount?: number;
  currency?: string;
  status?: string;
  reason: string;
  mode?: string;
  paymentUrl?: string | null;
  providerReference?: string | null;
  dueAt?: string | null;
};

const clinicOptions: ClinicOption[] = [{ id: 'all', name: 'All clinics', location: 'Network-wide' }];

const advisorPrompts = [
  { label: 'Which appointments should require deposits?', question: 'Which appointments should require deposits?', advisorType: 'revenue' as const },
  { label: 'Which patients should pay before arrival?', question: 'Which patients should pay before arrival?', advisorType: 'revenue' as const },
  { label: 'Which patients today have insurance risk?', question: 'Which patients today have insurance risk?', advisorType: 'operations' as const },
  { label: 'Which prior authorizations need action?', question: 'Which prior authorizations need action?', advisorType: 'operations' as const },
  { label: 'Where are we risking denials?', question: 'Where are we risking denials?', advisorType: 'competitor' as const },
  { label: 'Which failed payments need follow-up?', question: 'Which failed payments need follow-up?', advisorType: 'front-desk' as const },
  { label: 'How much revenue can we protect today?', question: 'How much revenue can we protect today?', advisorType: 'revenue' as const },
];

function riskBadgeClass(status: string) {
  const value = status.toLowerCase();
  if (value.includes('inactive') || value.includes('failed') || value.includes('denied') || value.includes('high')) return 'badge badge-red';
  if (value.includes('uncertain') || value.includes('pending') || value.includes('submitted') || value.includes('follow')) return 'badge badge-amber';
  return 'badge badge-emerald';
}

function modeBanner(status: RevenueProtectionIntegrationStatus | null) {
  if (!status) return 'Mock Mode';
  const insuranceLabel = status.insurance.label;
  const paymentLabel = status.payment.label;
  if (insuranceLabel === paymentLabel) return insuranceLabel;
  return `${insuranceLabel} · ${paymentLabel}`;
}

function estimateForVerification(overview: RevenueProtectionOverview | null, verification: EligibilityVerification) {
  return overview?.patientResponsibilityEstimates.find(item => item.eligibilityVerificationId === verification.id) ?? null;
}

function estimateForQueueRow(overview: RevenueProtectionOverview | null, row: AppointmentVerificationQueueRow) {
  return overview?.patientResponsibilityEstimates.find(item => item.patientId === row.patientId && item.appointmentId === row.id) ?? null;
}

function useRevenueProtectionData(selectedClinicId: 'all' | string) {
  const [overview, setOverview] = useState<RevenueProtectionOverview | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<RevenueProtectionIntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadIndex, setReloadIndex] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetchRevenueProtectionOverview(selectedClinicId === 'all' ? undefined : selectedClinicId),
      fetchRevenueProtectionIntegrationStatus(),
    ])
      .then(([nextOverview, nextStatus]) => {
        if (!active) return;
        setOverview(nextOverview);
        setIntegrationStatus(nextStatus);
      })
      .catch(loadError => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : 'Unable to load revenue protection');
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedClinicId, reloadIndex]);

  return {
    overview,
    integrationStatus,
    loading,
    error,
    reload: useCallback(() => {
      setLoading(true);
      setError(null);
      setReloadIndex(current => current + 1);
    }, []),
  };
}

export default function RevenueProtection() {
  const navigate = useNavigate();
  const { data: branchOptions } = useApiResource<ClinicOption, ClinicOption>('/v1/branches?limit=100', [], row => row);
  const [selectedClinicId, setSelectedClinicId] = useState<'all' | string>('all');
  const [section, setSection] = useState<'insurance' | 'payments'>('insurance');
  const { overview, integrationStatus, loading, error, reload } = useRevenueProtectionData(selectedClinicId);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [appointmentQueue, setAppointmentQueue] = useState<AppointmentVerificationQueueRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [waiverTarget, setWaiverTarget] = useState<DepositRequirement | null>(null);
  const [ruleDraft, setRuleDraft] = useState({
    name: 'Same-day deposit',
    ruleType: 'same-day',
    description: 'Collect a deposit for same-day appointments.',
    amountValue: 75,
  });

  const paymentLinkCount = overview?.paymentRequests.filter(item => item.status === 'link_sent').length ?? 0;
  const activeCoverageCount = appointmentQueue.filter(item => item.coverageActive).length;
  const verifiedPolicies = overview?.patientInsurancePolicies.filter(item => item.verificationStatus === 'verified').length ?? 0;
  const openAlerts = overview?.revenueProtectionAlerts.filter(item => item.status !== 'resolved').length ?? 0;
  const depositCollectedCount = overview?.depositRequirements.filter(item => item.status === 'collected').length ?? 0;
  const depositWaivedCount = overview?.depositRequirements.filter(item => item.status === 'waived').length ?? 0;

  useEffect(() => {
    let active = true;
    void (async () => {
      setQueueLoading(true);
      setQueueError(null);
      try {
        const result = await fetchAppointmentVerificationQueue(selectedClinicId === 'all' ? undefined : selectedClinicId);
        if (!active) return;
        setAppointmentQueue(result.appointments);
      } catch (loadError) {
        if (!active) return;
        setQueueError(loadError instanceof Error ? loadError.message : 'Unable to load insurance verification queue');
      } finally {
        if (active) setQueueLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedClinicId, reload]);

  // Several endpoints refuse work truthfully with HTTP 200 and a status envelope
  // (e.g. {status:'setup_required'}). apiRequest only throws on !response.ok, so
  // those refusals used to be reported to the user as "Updated successfully"
  // while nothing happened. Treat them as failures, not successes.
  function serverRefusal(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null;
    const envelope = result as { status?: unknown; message?: unknown };
    if (typeof envelope.status !== 'string') return null;
    if (envelope.status === 'setup_required') {
      return 'This provider is not connected yet, so nothing was changed. Your administrator needs to finish setting it up.';
    }
    if (envelope.status === 'not_configured' || envelope.status === 'failed') {
      return typeof envelope.message === 'string' && envelope.message
        ? envelope.message
        : 'The provider could not complete this request, so nothing was changed.';
    }
    return null;
  }

  async function withRefresh<T>(key: string, action: () => Promise<T>) {
    setActionBusy(key);
    setMessage(null);
    setActionError(null);
    try {
      const result = await action();
      const refusal = serverRefusal(result);
      if (refusal) {
        setActionError(refusal);
        await reload();
        return result;
      }
      setMessage('Updated successfully');
      await reload();
      return result;
    } catch (actionError) {
      const text = actionError instanceof Error ? actionError.message : 'Action failed';
      setActionError(text);
      throw actionError;
    } finally {
      setActionBusy(null);
    }
  }

  const handleRunEligibility = async (row: PatientInsurancePolicy) => {
    await withRefresh(`eligibility-${row.id}`, () => checkEligibility({
      patientId: row.patientId,
      branchId: row.branchId,
      payerId: row.payerId ?? undefined,
    }));
  };

  const handleVerifyInsurance = async (row: AppointmentVerificationQueueRow) => {
    await withRefresh(`verify-${row.id}`, () => checkEligibility({
      patientId: row.patientId,
      appointmentId: row.id,
      branchId: row.branchId,
      serviceType: row.serviceType,
    }));
  };

  const handleMarkVerified = async (row: EligibilityVerification) => {
    await withRefresh(`verified-${row.id}`, () => markEligibilityVerified(row.id));
  };

  const handleRequestDeposit = async (row: EligibilityVerification) => {
    const estimate = estimateForVerification(overview, row);
    const amount = estimate?.recommendedCollectAmount ?? Math.max(row.copay, 50);
    await withRefresh(`deposit-${row.id}`, () => createPaymentLink({
      patientId: row.patientId,
      appointmentId: row.appointmentId ?? undefined,
      branchId: row.branchId,
      amount,
      reason: `Deposit request for ${row.patientName}`,
      createDepositRequirement: true,
    }));
  };

  const handleSendPaymentLink = async (row: PaymentActionRow) => {
    await withRefresh(`link-${row.id}`, () => createPaymentLink({
      patientId: row.patientId ?? undefined,
      appointmentId: row.appointmentId ?? undefined,
      branchId: row.branchId,
      amount: row.amount ?? row.recommendedCollectAmount ?? 0,
      reason: 'Patient responsibility payment link',
      createDepositRequirement: true,
    }));
  };

  // `source` is explicit because the two call sites pass different id types:
  // the payment queue's row.id IS a PaymentRequest id, while the deposit queue's
  // row.id is a DepositRequirement id. Inferring this from the optional
  // paymentRequestId silently routed payment rows into the deposit table.
  const handleMarkPaymentCollected = async (row: PaymentActionRow, source: 'payment' | 'deposit') => {
    await withRefresh(`collected-${row.id}`, () => {
      if (source === 'payment') {
        return updatePaymentStatus(row.id, 'collected', row.providerReference ?? undefined);
      }
      if (row.paymentRequestId) {
        return updatePaymentStatus(row.paymentRequestId, 'collected', row.providerReference ?? undefined);
      }
      return updateDepositRequirementStatus(row.id, {
        status: 'collected',
        collectedAmount: row.amount ?? row.recommendedCollectAmount ?? 0,
        reason: row.reason,
      });
    });
  };

  const handleFlagFollowUp = async (row: PaymentActionRow) => {
    await withRefresh(`followup-${row.id}`, () => updatePaymentStatus(row.id, 'follow_up_required'));
  };

  const handleWaiveDeposit = async (row: DepositRequirement, reason: string) => {
    await withRefresh(`waive-${row.id}`, () => updateDepositRequirementStatus(row.id, { status: 'waived', waiverReason: reason, reason: row.reason }));
  };

  const handleCreateRule = async () => {
    await withRefresh('create-rule', () => createDepositRule({
      branchId: selectedClinicId === 'all' ? null : selectedClinicId,
      name: ruleDraft.name,
      ruleType: ruleDraft.ruleType,
      description: ruleDraft.description,
      active: true,
      depositRequired: true,
      amountType: 'fixed',
      amountValue: ruleDraft.amountValue,
      refundable: true,
      cancellationWindowHours: 24,
      appliesToNewPatients: false,
      appliesToHighNoShowRisk: true,
      appliesToPremiumServices: false,
      appliesToSameDayAppointments: true,
      appliesToExemptPatients: false,
      sortOrder: (overview?.depositRules.length ?? 0) + 1,
    }));
  };

  const handleToggleRule = async (row: DepositRule) => {
    await withRefresh(`toggle-${row.id}`, () => updateDepositRule(row.id, { active: !row.active }));
  };

  const handleUpdateAlert = async (row: RevenueProtectionAlert) => {
    await withRefresh(`alert-${row.id}`, () => updateAlertStatus(row.id, {
      status: 'task_created',
      createRecoveryTask: true,
      taskTitle: `${row.title} recovery`,
      taskPriority: row.severity === 'high' ? 'high' : 'medium',
    }));
  };

  const handlePriorAuthStatus = async (row: PriorAuthorization, status: string) => {
    await withRefresh(`pa-${row.id}-${status}`, () => updatePriorAuthStatus(row.id, status, row.notes ?? undefined));
  };

  const openAdvisory = (question: string) => {
    navigate('/advisory', { state: { question, advisorType: 'revenue' } });
  };

  return (
    <div className="space-y-3 pb-6">
      {/* Slim toolbar — the topbar breadcrumb carries the page title. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`badge ph-badge-${integrationStatus?.insurance.mode === 'mock' && integrationStatus?.payment.mode === 'mock' ? 'amber' : 'emerald'}`}>{integrationStatus ? modeBanner(integrationStatus) : 'Loading'}</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => navigate('/advisory')} className="inline-flex items-center gap-2 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition">
            <Sparkles className="w-4 h-4 text-t3" /> Ask Advisors
          </button>
          <button type="button" onClick={() => navigate('/crm')} className="inline-flex items-center gap-2 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition">
            <ExternalLink className="w-4 h-4 text-t3" /> Open CRM
          </button>
          <button type="button" onClick={() => navigate('/opportunities')} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[13px] font-semibold text-white hover:opacity-90 transition">
            <AlertTriangle className="w-4 h-4" /> Revenue Leaks
          </button>
        </div>
      </div>

      {/* Compact status + scope bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-t1"><ShieldCheck className="w-4 h-4 text-indigo" /> Revenue protection</span>
          <span className="text-[12px] text-t3">{integrationStatus?.insurance.label ?? 'Mock Mode'} · {integrationStatus?.payment.label ?? 'Mock Mode'} · {openAlerts} open alert{openAlerts === 1 ? '' : 's'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={selectedClinicId} onChange={e => setSelectedClinicId(e.target.value)} aria-label="Clinic scope"
            className="rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-xs text-t1 outline-none">
            {[...clinicOptions, ...branchOptions].map(clinic => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
          </select>
          <button type="button" onClick={() => void reload()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          {loading && <span className="badge badge-blue">Loading</span>}
        </div>
      </div>
      {(message || error || actionError) && (
        <p className={`text-xs font-semibold ${error || actionError ? 'text-red-v' : 'text-indigo'}`}>{actionError ?? error ?? message}</p>
      )}

      <div className="grid gap-3 grid-cols-2 xl:grid-cols-7">
        <StatCard title="Payments Due Today" value={overview?.summary.paymentsDueToday ?? 0} subtitle="Copay / deposit queue" icon={<CreditCard className="w-4 h-4" />} accent="blue" />
        <StatCard title="Open Payment Requests" value={formatCurrency(overview?.summary.copaysExpected ?? 0)} subtitle="Not final patient balances" icon={<DollarSign className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Deposits Recorded" value={formatCurrency(overview?.summary.depositsCollected ?? 0)} subtitle="Provider or staff status" icon={<Wallet className="w-4 h-4" />} accent="violet" />
        <StatCard title="Unpaid Balances" value={formatCurrency(overview?.summary.unpaidBalances ?? 0)} subtitle="At risk balances" icon={<AlertTriangle className="w-4 h-4" />} accent="red" />
        <StatCard title="Failed Payments" value={overview?.summary.failedPayments ?? 0} subtitle="Needs follow-up" icon={<FileBadge2 className="w-4 h-4" />} accent="amber" />
        <StatCard title="Net Recorded Collections" value={formatCurrency(overview?.summary.revenueProtected ?? 0)} subtitle="Transactions plus manual deposits" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="At Risk" value={formatCurrency(overview?.summary.revenueAtRisk ?? 0)} subtitle="Open alerts" icon={<AlertTriangle className="w-4 h-4" />} accent="red" />
      </div>

      <div className="w-fit">
        <ModuleTabs
          tabs={[{ id: 'insurance', label: 'Insurance & Eligibility' }, { id: 'payments', label: 'Payments & Deposits' }]}
          activeTab={section}
          onChange={id => setSection(id as 'insurance' | 'payments')}
          ariaLabel="Revenue protection sections"
        />
      </div>

      <div>
        <div className={`space-y-3 ${section === 'insurance' ? '' : 'hidden'}`}>
          <BentoCard title="Appointment Eligibility Queue" subtitle="Appointments awaiting a payer response or staff review">
            {queueError && <p className="mb-3 text-xs text-red-v">{queueError}</p>}
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-t3">Queue status</p>
                <p className="mt-2 text-sm font-semibold text-t1">{queueLoading ? 'Loading queue…' : `${activeCoverageCount}/${appointmentQueue.length} with an active response`}</p>
                <p className="mt-1 text-xs text-t3">This table reflects the same saved insurance workflow used in Scheduling and Patient Profile.</p>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-t3">Mode</p>
                <p className="mt-2 text-sm font-semibold text-t1">{modeBanner(integrationStatus)}</p>
                <p className="mt-1 text-xs text-t3">Mock Mode appears whenever Stedi or payment providers are not configured.</p>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-t3">Open alerts</p>
                <p className="mt-2 text-sm font-semibold text-t1">{openAlerts}</p>
                <p className="mt-1 text-xs text-t3">An inactive payer response creates an operational follow-up alert. It is not a final coverage or claim decision.</p>
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--b1)]">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--s3)] text-xs uppercase tracking-widest text-t3">
                    <tr>
                      <th className="px-4 py-3">Patient</th>
                      <th className="px-4 py-3">Appointment</th>
                      <th className="px-4 py-3">Payer</th>
                      <th className="px-4 py-3">Member ID</th>
                      <th className="px-4 py-3">Eligibility</th>
                      <th className="px-4 py-3">Copay</th>
                      <th className="px-4 py-3">Deductible</th>
                      <th className="px-4 py-3">Prior Auth</th>
                      <th className="px-4 py-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {appointmentQueue.map(row => {
                      const estimate = estimateForQueueRow(overview, row);
                      return (
                        <tr key={row.id} className="border-t border-[var(--b1)] bg-[var(--s2)]">
                          <td className="px-4 py-3 text-t1">
                            <p className="font-semibold">{row.patientName}</p>
                            <p className="text-xs text-t3">{row.branchName}</p>
                          </td>
                          <td className="px-4 py-3 text-t2">
                            <p className="font-semibold">{new Date(row.appointmentTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
                            <p className="text-xs text-t3">{row.serviceType}</p>
                          </td>
                          <td className="px-4 py-3 text-t2">{row.payerName}</td>
                          <td className="px-4 py-3 text-t2">{row.memberId}</td>
                          <td className="px-4 py-3">
                            <span className={riskBadgeClass(row.coverageStatus)}>{row.eligibilityStatus}</span>
                            <p className="mt-2 text-xs text-t3 leading-relaxed">{row.recommendedAction}</p>
                          </td>
                          <td className="px-4 py-3 text-t2">{row.eligibilityStatus === 'Active' ? formatCurrency(row.copay) : '—'}</td>
                          <td className="px-4 py-3 text-t2">{row.eligibilityStatus === 'Active' ? formatCurrency(row.deductibleRemaining) : '—'}</td>
                          <td className="px-4 py-3"><span className={riskBadgeClass(row.priorAuthStatus)}>{row.priorAuthStatus}</span></td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={actionBusy === `verify-${row.id}`}
                                onClick={() => void handleVerifyInsurance(row)}
                                className="rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition disabled:opacity-50"
                              >
                                {actionBusy === `verify-${row.id}` ? 'Requesting…' : 'Request Payer Response'}
                              </button>
                              <button
                                type="button"
                                onClick={() => navigate(`/patients/${row.patientId}`)}
                                className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition"
                              >
                                Open Patient
                              </button>
                              {estimate && <span className="badge badge-blue">Suggested request {formatCurrency(estimate.recommendedCollectAmount)}</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!queueLoading && appointmentQueue.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-sm text-t3">
                          No appointments are waiting for verification in this clinic scope.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </BentoCard>

          <BentoCard title="Insurance Workflow Overview" subtitle="Payers, policy records, and latest response status">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-xs font-bold uppercase tracking-widest text-t3">Latest payer responses</p>
                  <span className="badge badge-emerald">{activeCoverageCount}/{overview?.eligibilityVerifications.length ?? 0} active responses</span>
                </div>
                <ProgressBar value={Math.min(100, Math.round((activeCoverageCount / Math.max(overview?.eligibilityVerifications.length ?? 1, 1)) * 100))} color="emerald" />
                <p className="mt-2 text-xs text-t3">Policies with a recorded verification status: {verifiedPolicies}. Eligibility is not a payment guarantee.</p>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-t3 mb-2">Accepted payers</p>
                <div className="flex flex-wrap gap-2">
                  {overview?.insurancePayers.map(payer => (
                    <span key={payer.id} className="badge badge-blue">
                      {payer.name}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-xs text-t3">Sandbox or mock mode is clearly labelled above.</p>
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--b1)]">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--s3)] text-xs uppercase tracking-widest text-t3">
                    <tr>
                      <th className="px-4 py-3">Patient</th>
                      <th className="px-4 py-3">Policy</th>
                      <th className="px-4 py-3">Payer</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(overview?.patientInsurancePolicies ?? []).map(policy => (
                      <tr key={policy.id} className="border-t border-[var(--b1)] bg-[var(--s2)]">
                        <td className="px-4 py-3 text-t1">
                          <p className="font-semibold">{policy.patientName}</p>
                          <p className="text-xs text-t3">{policy.branchName}</p>
                        </td>
                        <td className="px-4 py-3 text-t2">
                          <p className="font-semibold">{policy.planName}</p>
                          <p className="text-xs text-t3">{policy.memberId}</p>
                        </td>
                        <td className="px-4 py-3 text-t2">{policy.payerName}</td>
                        <td className="px-4 py-3"><span className={riskBadgeClass(policy.verificationStatus)}>{policy.verificationStatus}</span></td>
                        <td className="px-4 py-3">
                          <button type="button" disabled={actionBusy === `eligibility-${policy.id}`} onClick={() => void handleRunEligibility(policy)} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--indigo-soft)] transition disabled:opacity-50">
                            <RefreshCw className="w-3.5 h-3.5" /> {actionBusy === `eligibility-${policy.id}` ? 'Running…' : 'Run Eligibility Check'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </BentoCard>

          <BentoCard title="Eligibility Work Queue" subtitle="Point-in-time payer responses and staff actions">
            <div className="overflow-hidden rounded-2xl border border-[var(--b1)]">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--s3)] text-xs uppercase tracking-widest text-t3">
                    <tr>
                      <th className="px-4 py-3">Patient</th>
                      <th className="px-4 py-3">Coverage</th>
                      <th className="px-4 py-3">Copay</th>
                      <th className="px-4 py-3">Deductible</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(overview?.eligibilityVerifications ?? []).map(row => {
                      const estimate = estimateForVerification(overview, row);
                      return (
                        <tr key={row.id} className="border-t border-[var(--b1)] bg-[var(--s2)]">
                          <td className="px-4 py-3">
                            <p className="font-semibold text-t1">{row.patientName}</p>
                            <p className="text-xs text-t3">{row.branchName} · {row.payerName}</p>
                          </td>
                          <td className="px-4 py-3">
                            <span className={riskBadgeClass(row.coverageStatus)}>{row.coverageStatus}</span>
                            <p className="mt-2 text-xs text-t3 leading-relaxed">{row.eligibilityMessage}</p>
                          </td>
                          <td className="px-4 py-3 text-t2">{formatCurrency(row.copay)}</td>
                          <td className="px-4 py-3 text-t2">{formatCurrency(row.deductibleRemaining)}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-2">
                              <button type="button" disabled={actionBusy === `verified-${row.id}`} onClick={() => void handleMarkVerified(row)} className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition disabled:opacity-50">
                                {actionBusy === `verified-${row.id}` ? 'Saving…' : 'Record Staff Review'}
                              </button>
                              <button type="button" disabled={actionBusy === `deposit-${row.id}`} onClick={() => void handleRequestDeposit(row)} className="rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition disabled:opacity-50">
                                {actionBusy === `deposit-${row.id}` ? 'Creating…' : 'Create Payment Link'}
                              </button>
                              <button type="button" onClick={() => navigate(`/patients/${row.patientId}`)} className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition">
                                Open Patient
                              </button>
                              {estimate && (
                                <span className="badge badge-blue">
                                  Suggested request {formatCurrency(estimate.recommendedCollectAmount)}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </BentoCard>

          <BentoCard title="Prior Authorization Tracker" subtitle="Track workflow and payer decisions; approval does not guarantee claim payment">
            <div className="overflow-hidden rounded-2xl border border-[var(--b1)]">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--s3)] text-xs uppercase tracking-widest text-t3">
                    <tr>
                      <th className="px-4 py-3">Patient</th>
                      <th className="px-4 py-3">Service</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Due</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(overview?.priorAuthorizations ?? []).map(row => (
                      <tr key={row.id} className="border-t border-[var(--b1)] bg-[var(--s2)]">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-t1">{row.patientName}</p>
                          <p className="text-xs text-t3">{row.branchName} · {row.payerName}</p>
                        </td>
                        <td className="px-4 py-3 text-t2">{row.serviceName}</td>
                        <td className="px-4 py-3"><span className={riskBadgeClass(row.status)}>{row.status}</span></td>
                        <td className="px-4 py-3 text-t2">{row.dueAt ? new Date(row.dueAt).toLocaleDateString() : '—'}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            {['pending', 'submitted', 'approved', 'needs_action', 'resolved'].map(status => (
                              <button
                                key={status}
                                type="button"
                                disabled={actionBusy === `pa-${row.id}-${status}`}
                                onClick={() => void handlePriorAuthStatus(row, status)}
                                className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition disabled:opacity-50"
                              >
                                {actionBusy === `pa-${row.id}-${status}` ? 'Saving…' : status}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </BentoCard>

          <BentoCard title="Patient Responsibility Estimates" subtitle="Planning values only; final responsibility depends on payer adjudication and clinic policy">
            <div className="overflow-hidden rounded-2xl border border-[var(--b1)]">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--s3)] text-xs uppercase tracking-widest text-t3">
                    <tr>
                      <th className="px-4 py-3">Patient</th>
                      <th className="px-4 py-3">Estimate</th>
                      <th className="px-4 py-3">Reason</th>
                      <th className="px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(overview?.patientResponsibilityEstimates ?? []).map(row => (
                      <tr key={row.id} className="border-t border-[var(--b1)] bg-[var(--s2)]">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-t1">{row.patientName}</p>
                          <p className="text-xs text-t3">{row.branchName} · {row.appointmentService ?? 'No appointment'}</p>
                        </td>
                        <td className="px-4 py-3 text-t2 space-y-1">
                          <p>Insurance: {formatCurrency(row.estimatedInsurancePortion)}</p>
                          <p>Patient: {formatCurrency(row.estimatedPatientResponsibility)}</p>
                          <p className="font-semibold text-emerald-v">Suggested payment request: {formatCurrency(row.recommendedCollectAmount)}</p>
                        </td>
                        <td className="px-4 py-3 text-xs text-t3 leading-relaxed">{row.reason}</td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            disabled={actionBusy === `link-${row.id}`}
                            onClick={() => void handleSendPaymentLink(row)}
                            className="rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition disabled:opacity-50"
                          >
                            {actionBusy === `link-${row.id}` ? 'Creating…' : 'Create Payment Link'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </BentoCard>
        </div>

        <div className={`space-y-3 ${section === 'payments' ? '' : 'hidden'}`}>
          <BentoCard title="Payment Command Center" subtitle="Create payment requests, review provider or staff-recorded status, and follow up on failures">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-t3">Integration status</p>
                <div className="mt-2 space-y-2 text-sm text-t1">
                  <p>{integrationStatus?.payment.label ?? 'Mock Mode'}</p>
                  <p className="text-xs text-t3">Configured: {integrationStatus?.payment.configured ? 'Yes' : 'No'}</p>
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-t3">Summary</p>
                <div className="mt-2 space-y-1 text-sm text-t1">
                  <p>{paymentLinkCount} payment requests with links</p>
                  <p>{depositCollectedCount} deposits recorded as collected</p>
                  <p>{depositWaivedCount} deposits waived</p>
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {(overview?.paymentRequests ?? []).map(row => (
                <div key={row.id} className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-t1">{row.patientName}</p>
                        <span className={riskBadgeClass(row.status)}>{row.status}</span>
                      </div>
                      <p className="text-xs text-t3 mt-1">{row.branchName} · {row.appointmentService ?? row.reason}</p>
                      <p className="text-xs text-t3 mt-2">Mode: {row.mode} · Ref: {row.providerReference ?? '—'}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-t1">{formatCurrency(row.amount)}</p>
                      <p className="text-xs text-t3">{row.currency}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={actionBusy === `collected-${row.id}`}
                      onClick={() => void handleMarkPaymentCollected(row, 'payment')}
                      className="rounded-xl bg-[var(--emerald)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition disabled:opacity-50"
                    >
                      {actionBusy === `collected-${row.id}` ? 'Saving…' : 'Record Staff-Confirmed Collection'}
                    </button>
                    <button
                      type="button"
                      disabled={actionBusy === `followup-${row.id}`}
                      onClick={() => void handleFlagFollowUp(row)}
                      className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition disabled:opacity-50"
                    >
                      {actionBusy === `followup-${row.id}` ? 'Saving…' : 'Flag Front Desk Follow-Up'}
                    </button>
                    <button
                      type="button"
                      disabled={!row.paymentUrl}
                      title={row.paymentUrl ? 'Open secure payment page' : 'No payment page is available for this request'}
                      onClick={() => { if (row.paymentUrl) window.open(row.paymentUrl, '_blank', 'noopener,noreferrer'); }}
                      className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition"
                    >
                      Open Link
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Deposit Rule Engine" subtitle="Define when deposits are required and how much to collect">
            <div className="grid gap-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <input aria-label="Deposit rule name" value={ruleDraft.name} onChange={e => setRuleDraft(prev => ({ ...prev, name: e.target.value }))} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Rule name" />
                <input aria-label="Deposit rule type" value={ruleDraft.ruleType} onChange={e => setRuleDraft(prev => ({ ...prev, ruleType: e.target.value }))} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Rule type" />
              </div>
              <input aria-label="Deposit rule description" value={ruleDraft.description} onChange={e => setRuleDraft(prev => ({ ...prev, description: e.target.value }))} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Description" />
              <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
                <input aria-label="Deposit amount" type="number" min="0" value={ruleDraft.amountValue} onChange={e => setRuleDraft(prev => ({ ...prev, amountValue: Number(e.target.value) }))} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm text-t1 outline-none" placeholder="Amount" />
                <button type="button" disabled={actionBusy === 'create-rule'} onClick={() => void handleCreateRule()} className="rounded-xl bg-[var(--indigo)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 transition disabled:opacity-50">
                  {actionBusy === 'create-rule' ? 'Saving…' : 'Create Rule'}
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {(overview?.depositRules ?? []).map(row => (
                <div key={row.id} className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-t1">{row.name}</p>
                        <span className={riskBadgeClass(row.active ? 'active' : 'inactive')}>{row.active ? 'active' : 'inactive'}</span>
                      </div>
                      <p className="text-xs text-t3 mt-1">{row.description}</p>
                      <p className="text-xs text-t3 mt-2">{row.branchName ?? 'Network-wide'} · {row.ruleType}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-t1">
                        {row.amountType === 'percentage' ? `${row.amountValue}%` : formatCurrency(row.amountValue)}
                      </p>
                      <p className="text-xs text-t3">{row.refundable ? 'Refundable' : 'Non-refundable'}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={actionBusy === `toggle-${row.id}`}
                      onClick={() => void handleToggleRule(row)}
                      className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition disabled:opacity-50"
                    >
                      {actionBusy === `toggle-${row.id}` ? 'Saving…' : row.active ? 'Disable Rule' : 'Enable Rule'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Payment Work Queue" subtitle="Deposit requests, staff-recorded statuses, and follow-up work">
            <div className="space-y-2">
              {(overview?.depositRequirements ?? []).map(row => (
                <div key={row.id} className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-t1">{row.patientName}</p>
                        <span className={riskBadgeClass(row.status)}>{row.status}</span>
                      </div>
                      <p className="text-xs text-t3 mt-1">{row.branchName} · {row.appointmentService ?? row.depositRuleName ?? 'Deposit request'}</p>
                      <p className="text-xs text-t3 mt-2">{row.reason}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-t1">{formatCurrency(row.requiredAmount)}</p>
                      <p className="text-xs text-t3">Collected {formatCurrency(row.collectedAmount)}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={actionBusy === `waive-${row.id}`}
                      onClick={() => setWaiverTarget(row)}
                      className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition disabled:opacity-50"
                    >
                      {actionBusy === `waive-${row.id}` ? 'Saving…' : 'Waive Deposit with Reason'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSendPaymentLink({
                        id: row.id,
                        branchId: row.branchId,
                        branchName: row.branchName,
                        patientId: row.patientId,
                        patientName: row.patientName,
                      appointmentId: row.appointmentId ?? undefined,
                      appointmentService: row.appointmentService ?? undefined,
                      paymentRequestId: row.paymentRequestId ?? null,
                      amount: row.requiredAmount,
                        currency: 'USD',
                        status: row.status,
                        reason: row.reason,
                        mode: row.mode,
                        paymentUrl: undefined,
                        providerReference: undefined,
                        dueAt: row.dueAt ?? undefined,
                      })}
                      className="rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition"
                    >
                      Create Payment Link
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleMarkPaymentCollected({
                        id: row.id,
                        branchId: row.branchId,
                        branchName: row.branchName,
                        patientId: row.patientId,
                        patientName: row.patientName,
                        appointmentId: row.appointmentId,
                        appointmentService: row.appointmentService,
                        paymentRequestId: row.paymentRequestId ?? null,
                        amount: row.requiredAmount,
                        currency: 'USD',
                        status: row.status,
                        reason: row.reason,
                        mode: row.mode,
                        paymentUrl: null,
                        providerReference: null,
                        dueAt: row.dueAt,
                      }, 'deposit')}
                      className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition"
                    >
                      Record Staff-Confirmed Collection
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Revenue Protection Alerts" subtitle="Turn risk into action">
            <div className="space-y-2">
              {(overview?.revenueProtectionAlerts ?? []).map(row => (
                <div key={row.id} className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-t1">{row.title}</p>
                        <span className={riskBadgeClass(row.severity)}>{row.severity}</span>
                      </div>
                      <p className="text-xs text-t3 mt-1">{row.branchName} · {row.patientName}</p>
                      <p className="text-xs text-t3 mt-2 leading-relaxed">{row.description}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-t1">{formatCurrency(row.estimatedValue)}</p>
                      <p className="text-xs text-t3">{row.status}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={actionBusy === `alert-${row.id}`}
                      onClick={() => void handleUpdateAlert(row)}
                      className="rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition disabled:opacity-50"
                    >
                      {actionBusy === `alert-${row.id}` ? 'Saving…' : 'Convert Leak to Recovery Task'}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate(row.actionLink ?? '/opportunities')}
                      className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs font-semibold text-t1 hover:bg-[var(--s2)] transition"
                    >
                      Open Related Module
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="AI Advisory Prompts" subtitle="Ask the built-in advisory team with this revenue context">
            <div className="grid gap-2 md:grid-cols-2">
              {advisorPrompts.map(prompt => (
                <button
                  key={prompt.label}
                  type="button"
                  onClick={() => openAdvisory(prompt.question)}
                  className="flex items-start justify-between gap-3 rounded-2xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-3 text-left transition hover:bg-[var(--s3)]"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-t1">{prompt.label}</p>
                    <p className="mt-1 text-xs text-t3 leading-relaxed">Open the Advisory Room with live revenue protection context.</p>
                  </div>
                  <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-indigo" />
                </button>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
      {waiverTarget && (
        <ConfirmationModal
          title="Waive this deposit?"
          message={`Waive the ${formatCurrency(waiverTarget.requiredAmount)} deposit for ${waiverTarget.patientName}. The reason is recorded with the deposit status.`}
          confirmLabel="Waive deposit"
          tone="amber"
          requireReason
          reasonLabel="Waiver reason"
          onClose={() => setWaiverTarget(null)}
          onConfirm={reason => handleWaiveDeposit(waiverTarget, reason)}
        />
      )}
    </div>
  );
}
