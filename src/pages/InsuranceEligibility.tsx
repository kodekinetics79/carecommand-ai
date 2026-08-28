import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, ShieldCheck, ShieldX, ShieldAlert, AlertTriangle, Loader2, Search, Settings2, History } from 'lucide-react';
import type { ElementType } from 'react';
import BentoCard from '../components/ui/BentoCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import { apiRequest } from '../lib/api';
import { crmService, type CrmPatient } from '../lib/crmService';
import { formatCurrency } from '../utils/formatters';
import { eligibilityRequestHeaders, runEligibilityAction } from '../lib/eligibilityIdempotency';

interface ProviderRow { key: string; displayName: string; status: string; mode: string }
interface EligibilityResult {
  verificationId: string; status: string; coverageActive: boolean; planName: string; payerName: string;
  copay: number | null; deductibleRemaining: number | null; coinsurance: number | null; message: string; payerReference: string | null;
  maskedMemberId: string | null; providerMode: string; simulated: boolean; decisionSource: string;
  checkedAt: string; effectiveFrom?: string | null; expiresAt?: string | null;
}
interface HistoryRow {
  id: string; patientName: string; coverageStatus: string; planName: string; payerName: string;
  copay: number | null; deductibleRemaining: number | null; coinsurance: number | null; providerMode: string;
  decisionSource: string; checkedAt: string; effectiveFrom?: string | null; expiresAt?: string | null;
}
interface ReconciliationRow {
  id: string; patientName: string; providerKey: string; providerMode: string; status: string; operatorState: string;
  reconciliationReason: string | null; reconciliationGeneration: number; providerCallMayHaveOccurred: boolean;
  providerRetrievalSupported: boolean; noAutomaticPayerRetry: boolean; ageSeconds: number; canReconcile: boolean;
  payerName: string; planName: string; requestedServiceType: string; requestedServiceAt: string | null;
  requestTime: string; lastAttemptAt: string; resultSource: string | null; resultStatus: string | null;
  resultCheckedAt: string | null; resultMessage: string | null;
  manualEvidenceOutcome: string | null; manualEvidenceSource: string | null; manualEvidenceReference: string | null;
  manualEvidenceVerifiedAt: string | null; manualCopay: number | null; manualDeductibleRemaining: number | null;
  manualCoinsurance: number | null;
  auditTrail: Array<{ action: string; occurredAt: string; actorName: string | null }>;
  reconciliationTask?: { status: string; assignedToId: string | null; assignedTo?: { displayName: string } | null } | null;
}

const STATUS: Record<string, { cls: string; icon: ElementType }> = {
  ACTIVE: { cls: 'badge-emerald', icon: ShieldCheck },
  INACTIVE: { cls: 'badge-red', icon: ShieldX },
  NEEDS_REVIEW: { cls: 'badge-amber', icon: ShieldAlert },
  ERROR: { cls: 'badge-red', icon: AlertTriangle },
};
function fmt(iso: string): string { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function statusLabel(status: string, decisionSource?: string | null): string {
  if (status === 'NEEDS_REVIEW') return 'Needs review';
  if (status === 'ERROR') return 'Error';
  const state = status === 'ACTIVE' ? 'active' : status === 'INACTIVE' ? 'inactive' : status.toLowerCase().replaceAll('_', ' ');
  if (decisionSource === 'MANUAL_PAYER_EVIDENCE') return `Manually verified ${state}`;
  if (decisionSource === 'SIMULATED') return `Simulated ${state}`;
  if (decisionSource === 'PAYER_RESPONSE') return `Payer reports ${state}`;
  return `Eligibility ${state}`;
}
function formatBenefit(value: number | null): string { return value === null ? 'Unknown' : formatCurrency(value); }
function formatCoinsurance(value: number | null): string {
  if (value === null) return 'Unknown';
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(percent)}%`;
}
function sourceLabel(source: string | null | undefined): string {
  if (source === 'MANUAL_PAYER_EVIDENCE') return 'Manual payer evidence';
  if (source === 'PAYER_RESPONSE') return 'Electronic payer response';
  if (source === 'SIMULATED') return 'Sandbox simulation';
  return source ? source.toLowerCase().replaceAll('_', ' ') : 'No result yet';
}
const emptyEvidence = () => ({
  outcome: 'UNCERTAIN', source: 'PAYER_PORTAL', reference: '', verifiedAt: '', effectiveFrom: '', expiresAt: '',
  copay: '', deductibleRemaining: '', coinsurance: '', notes: '',
  patientMatches: false, policyMatches: false, payerMatches: false, serviceAndDateMatch: false,
});

export default function InsuranceEligibility() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [patients, setPatients] = useState<CrmPatient[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ patientId: '', payerName: '', memberId: '', planName: '', serviceType: '', serviceDate: '' });
  const [result, setResult] = useState<EligibilityResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconciliations, setReconciliations] = useState<ReconciliationRow[]>([]);
  const [reconciliationFilter, setReconciliationFilter] = useState<'unresolved' | 'in_flight' | 'manual_pending' | 'reconciled' | 'terminal' | 'all'>('unresolved');
  const [evidenceExecutionId, setEvidenceExecutionId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState(emptyEvidence);

  const loadHistory = useCallback(async () => {
    try { setHistory(await apiRequest<HistoryRow[]>('/v1/insurance/eligibility/history')); } catch { /* non-fatal */ }
  }, []);
  const loadReconciliations = useCallback(async (state = reconciliationFilter) => {
    try { setReconciliations(await apiRequest<ReconciliationRow[]>(`/v1/insurance/eligibility/executions/reconciliation?state=${state}&limit=100`)); } catch { /* entitlement/permission may hide this workflow */ }
  }, [reconciliationFilter]);
  const load = useCallback(async () => {
    try {
      const [prov, pats] = await Promise.all([
        apiRequest<ProviderRow[]>('/v1/insurance/providers'),
        crmService.getPatients().catch(() => [] as CrmPatient[]),
      ]);
      setProviders(prov); setPatients(pats);
      await Promise.all([loadHistory(), loadReconciliations()]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [loadHistory, loadReconciliations]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const stedi = providers.find(p => p.key === 'stedi');
  const canCheck = !!stedi && (stedi.status === 'SANDBOX' || stedi.status === 'ACTIVE');
  const valid = form.patientId && form.payerName.trim().length >= 2 && form.memberId.trim().length >= 2;

  async function check() {
    if (!valid) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const input = {
        patientId: form.patientId,
        payerName: form.payerName.trim(),
        memberId: form.memberId.trim(),
        planName: form.planName.trim() || undefined,
        serviceType: form.serviceType.trim() || undefined,
        serviceDate: form.serviceDate || undefined,
      };
      const res = await runEligibilityAction('insurance_v1', input, key => apiRequest<EligibilityResult>('/v1/insurance/eligibility/check', {
        method: 'POST', headers: eligibilityRequestHeaders(key), body: JSON.stringify(input),
      }));
      setResult(res);
      await loadHistory();
    } catch (e) { setError(e instanceof Error ? e.message : 'Eligibility check failed'); }
    finally { setBusy(false); }
  }

  async function claimReconciliation(row: ReconciliationRow) {
    setError(null);
    try {
      await apiRequest(`/v1/insurance/eligibility/executions/${row.id}/claim`, { method: 'POST', body: JSON.stringify({ expectedGeneration: row.reconciliationGeneration }) });
      await loadReconciliations();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to claim reconciliation'); }
  }

  async function resolveWithoutCoverage(row: ReconciliationRow, resolution: 'confirmed_not_submitted' | 'confirmed_failed') {
    const reason = window.prompt('Record the payer verification reason (minimum 8 characters):');
    if (!reason) return;
    try {
      await apiRequest(`/v1/insurance/eligibility/executions/${row.id}/reconcile`, { method: 'POST', body: JSON.stringify({ resolution, expectedGeneration: row.reconciliationGeneration, reason }) });
      await loadReconciliations();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to resolve reconciliation'); }
  }

  async function submitManualEvidence(row: ReconciliationRow) {
    try {
      const nullableNumber = (value: string) => value.trim() === '' ? null : Number(value);
      await apiRequest(`/v1/insurance/eligibility/executions/${row.id}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({
          resolution: 'confirmed_succeeded', expectedGeneration: row.reconciliationGeneration,
          reason: evidence.notes || 'Verified against payer evidence',
          evidence: {
            outcome: evidence.outcome, source: evidence.source, reference: evidence.reference,
            verifiedAt: evidence.verifiedAt, effectiveFrom: evidence.effectiveFrom || null, expiresAt: evidence.expiresAt || null,
            copay: nullableNumber(evidence.copay), deductibleRemaining: nullableNumber(evidence.deductibleRemaining), coinsurance: nullableNumber(evidence.coinsurance),
            notes: evidence.notes || undefined,
            attestation: {
              patientMatches: evidence.patientMatches, policyMatches: evidence.policyMatches,
              payerMatches: evidence.payerMatches, serviceAndDateMatch: evidence.serviceAndDateMatch,
            },
          },
        }),
      });
      setEvidenceExecutionId(null);
      setEvidence(emptyEvidence());
      await Promise.all([loadReconciliations(), loadHistory()]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to record payer evidence'); }
  }

  return (
    <div className="space-y-4 pb-6">
      {/* Provider status strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-t1"><ShieldCheck className="w-4 h-4 text-indigo" /> Eligibility providers</span>
          {providers.map(p => (
            <span key={p.key} className="text-[11.5px] text-t3">{p.displayName}: <span className={`font-semibold ${p.status === 'SANDBOX' || p.status === 'ACTIVE' ? 'text-emerald-v' : 'text-t3'}`}>{p.status.replace('_', ' ').toLowerCase()}</span></span>
          ))}
        </div>
        <a href="/integration-setup" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-indigo hover:underline"><Settings2 className="w-3.5 h-3.5" /> Integration setup</a>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_1fr] items-start">
        {/* Check form */}
        <BentoCard title="Request Eligibility Response" subtitle="270/271 via the configured Stedi mode · a point-in-time response, not a coverage or payment guarantee" headerRight={<BadgeCheck className="w-4 h-4 text-t3" />}>
          {!canCheck && !loading && (
            <div className="rounded-lg border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[12px] text-amber-v mb-3">Stedi is not configured. Enable the sandbox in Integration Setup to run checks.</div>
          )}
          <div className="space-y-2.5">
            <Field label="Patient">
              <select aria-label="Patient" value={form.patientId} onChange={e => setForm(f => ({ ...f, patientId: e.target.value }))} className={inputCls}>
                <option value="">Select a patient…</option>
                {patients.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Payer name"><input value={form.payerName} onChange={e => setForm(f => ({ ...f, payerName: e.target.value }))} placeholder="e.g. Aetna" className={inputCls} /></Field>
            <Field label="Member ID"><input value={form.memberId} onChange={e => setForm(f => ({ ...f, memberId: e.target.value }))} placeholder="e.g. AET-110293" autoComplete="off" className={inputCls} /></Field>
            <Field label="Plan name (optional)"><input value={form.planName} onChange={e => setForm(f => ({ ...f, planName: e.target.value }))} placeholder="e.g. Aetna Core Plus" className={inputCls} /></Field>
            <Field label="Requested service (optional)"><input value={form.serviceType} onChange={e => setForm(f => ({ ...f, serviceType: e.target.value }))} placeholder="e.g. Office visit" className={inputCls} /></Field>
            <Field label="Date of service (optional)"><input type="date" value={form.serviceDate} onChange={e => setForm(f => ({ ...f, serviceDate: e.target.value }))} className={inputCls} /></Field>
            {error && <p role="alert" className="rounded-lg bg-[var(--red-soft)] px-3 py-2 text-[12px] font-semibold text-red-v">{error}</p>}
            <button type="button" disabled={!valid || busy || !canCheck} onClick={check} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Request eligibility response
            </button>
            <p className="text-[10.5px] text-t3">Sandbox tip: member IDs ending <code className="font-mono">00</code> → inactive, <code className="font-mono">99</code> → needs review, starting <code className="font-mono">ERR</code> → error.</p>
          </div>
        </BentoCard>

        {/* Result */}
        <BentoCard title="Result" subtitle="Member ID is masked — full value is never returned to the browser">
          {!result ? <EmptyStatePremium icon={<BadgeCheck className="w-5 h-5" />} title="No response requested yet" description="Request an eligibility response to view payer-reported status and benefit information." />
            : (() => {
              const meta = STATUS[result.status] ?? STATUS.ERROR;
              const Icon = meta.icon;
              return (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className={`badge ${meta.cls} inline-flex items-center gap-1 text-[12px]`}><Icon className="w-3.5 h-3.5" />{statusLabel(result.status, result.decisionSource)}</span>
                    <span className="text-[11px] text-t3">{result.providerMode} · {fmt(result.checkedAt)}</span>
                  </div>
                  <p className="text-[13px] text-t2 leading-snug">{result.message}</p>
                  <p className="rounded-lg border border-[var(--b1)] bg-[var(--amber-soft)] px-3 py-2 text-[11px] text-amber-v">
                    Benefits can change. Copay, deductible, and coinsurance values are payer-reported information and may not equal the final patient responsibility after adjudication.
                  </p>
                  <div className="rounded-xl border border-[var(--b1)] divide-y divide-[var(--b1)]">
                    <Row label="Member ID" value={result.maskedMemberId ?? '—'} mono />
                    <Row label="Payer" value={result.payerName} />
                    <Row label="Plan" value={result.planName} />
                    <Row label="Evidence source" value={sourceLabel(result.decisionSource)} />
                    <Row label="Copay" value={formatBenefit(result.copay)} />
                    <Row label="Deductible remaining" value={formatBenefit(result.deductibleRemaining)} />
                    <Row label="Coinsurance" value={formatCoinsurance(result.coinsurance)} />
                    <Row label="Payer reference" value={result.payerReference ?? '—'} mono />
                    <Row label="Coverage effective" value={result.effectiveFrom ? fmt(result.effectiveFrom) : 'Unknown — payer did not provide'} />
                    <Row label="Coverage end" value={result.expiresAt ? fmt(result.expiresAt) : 'Unknown — payer did not provide'} />
                  </div>
                </div>
              );
            })()}
        </BentoCard>
      </div>

      <BentoCard title="Eligibility Reconciliation" subtitle="Server-held work queue · payer calls are never retried from this workflow" headerRight={<AlertTriangle className="w-4 h-4 text-amber-v" />}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <select value={reconciliationFilter} onChange={event => { const state = event.target.value as typeof reconciliationFilter; setReconciliationFilter(state); void loadReconciliations(state); }} className={inputCls} aria-label="Reconciliation filter">
            <option value="unresolved">Unresolved</option><option value="in_flight">Provider in flight</option><option value="manual_pending">Manual evidence pending</option><option value="reconciled">Reconciled</option><option value="terminal">Terminal</option><option value="all">All</option>
          </select>
          <button type="button" onClick={() => void loadReconciliations()} className="rounded-lg border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-indigo">Reload from server</button>
        </div>
        <p className="mb-3 rounded-lg bg-[var(--amber-soft)] px-3 py-2 text-[11px] text-amber-v">Do not submit a new payer request for these rows. Verify the existing attempt with the payer, then record only the evidence actually returned. Eligibility is not a payment guarantee.</p>
        {reconciliations.length === 0 ? <p className="py-4 text-center text-xs text-t3">No reconciliation work matches this filter.</p> : (
          <div className="space-y-2">
            {reconciliations.map(row => (
              <div key={row.id} className="rounded-xl border border-[var(--b1)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div><p className="text-sm font-semibold text-t1">{row.patientName}</p><p className="text-[11px] text-t3">{row.payerName} · {row.planName} · {row.operatorState.replaceAll('_', ' ')} · age {Math.floor(row.ageSeconds / 60)}m</p></div>
                  <span className="badge badge-amber">{row.status.replaceAll('_', ' ')}</span>
                </div>
                <div className="mt-2 grid gap-1 rounded-lg bg-[var(--s2)] p-2 text-[11px] text-t2 sm:grid-cols-2 lg:grid-cols-3">
                  <span><strong>Service:</strong> {row.requestedServiceType}</span>
                  <span><strong>Date of service:</strong> {row.requestedServiceAt ? fmt(row.requestedServiceAt) : 'Not specified'}</span>
                  <span><strong>Requested:</strong> {fmt(row.requestTime)}</span>
                  <span><strong>Last attempt:</strong> {fmt(row.lastAttemptAt)}</span>
                  <span><strong>Result source:</strong> {sourceLabel(row.resultSource)}</span>
                  <span><strong>Result status:</strong> {row.resultStatus ? statusLabel(row.resultStatus, row.resultSource) : 'No result yet'}</span>
                </div>
                <p className="mt-2 text-[11px] text-t2">{row.reconciliationReason ?? 'Awaiting server scan or provider outcome.'}</p>
                <p className="mt-1 text-[10px] text-red-v">Provider call may have occurred: {row.providerCallMayHaveOccurred ? 'yes' : 'no'} · verified response lookup: {row.providerRetrievalSupported ? 'available' : 'not supported'}</p>
                {row.resultMessage && <p className="mt-1 text-[10px] text-t3">Last recorded result: {row.resultMessage}</p>}
                {(row.manualEvidenceSource || row.manualEvidenceReference || row.manualEvidenceVerifiedAt) && (
                  <div className="mt-2 rounded-lg border border-[var(--b1)] px-2.5 py-2 text-[11px] text-t2">
                    <p className="font-semibold text-t1">Manual payer evidence</p>
                    <p>{sourceLabel('MANUAL_PAYER_EVIDENCE')} · {row.manualEvidenceSource?.replaceAll('_', ' ').toLowerCase() ?? 'source unavailable'} · reference {row.manualEvidenceReference ?? 'not recorded'}</p>
                    <p>Verified {row.manualEvidenceVerifiedAt ? fmt(row.manualEvidenceVerifiedAt) : 'time unavailable'} · outcome {row.manualEvidenceOutcome ?? 'unknown'}</p>
                    <p>Copay {formatBenefit(row.manualCopay)} · deductible {formatBenefit(row.manualDeductibleRemaining)} · coinsurance {formatCoinsurance(row.manualCoinsurance)}</p>
                  </div>
                )}
                {row.auditTrail.length > 0 && (
                  <details className="mt-2 rounded-lg border border-[var(--b1)] px-2.5 py-2 text-[11px] text-t2">
                    <summary className="cursor-pointer font-semibold text-t1">Execution audit history ({row.auditTrail.length})</summary>
                    <ol className="mt-2 space-y-1">
                      {row.auditTrail.map((entry, index) => <li key={`${entry.action}:${entry.occurredAt}:${index}`}><span className="font-medium">{entry.action.replaceAll('.', ' › ')}</span> · {fmt(entry.occurredAt)}{entry.actorName ? ` · ${entry.actorName}` : ''}</li>)}
                    </ol>
                  </details>
                )}
                {row.canReconcile && row.status === 'MANUAL_EVIDENCE_PENDING' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!row.reconciliationTask?.assignedToId ? <button type="button" onClick={() => void claimReconciliation(row)} className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white">Claim task</button> : <>
                      <button type="button" onClick={() => { setEvidence(emptyEvidence()); setEvidenceExecutionId(row.id); }} className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white">Record payer evidence</button>
                      <button type="button" onClick={() => void resolveWithoutCoverage(row, 'confirmed_not_submitted')} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold">Not submitted</button>
                      <button type="button" onClick={() => void resolveWithoutCoverage(row, 'confirmed_failed')} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-red-v">Confirmed failed</button>
                    </>}
                  </div>
                )}
                {evidenceExecutionId === row.id && (
                  <div className="mt-3 grid gap-2 rounded-lg bg-[var(--s2)] p-3 sm:grid-cols-2">
                    <Field label="Payer outcome"><select value={evidence.outcome} onChange={e => setEvidence(v => ({ ...v, outcome: e.target.value }))} className={inputCls}><option>ACTIVE</option><option>INACTIVE</option><option>UNCERTAIN</option></select></Field>
                    <Field label="Evidence source"><select value={evidence.source} onChange={e => setEvidence(v => ({ ...v, source: e.target.value }))} className={inputCls}><option>PAYER_PORTAL</option><option>PAYER_PHONE</option><option>PAYER_DOCUMENT</option></select></Field>
                    <Field label="Payer reference"><input value={evidence.reference} onChange={e => setEvidence(v => ({ ...v, reference: e.target.value }))} className={inputCls} /></Field>
                    <Field label="Verified at"><input type="datetime-local" value={evidence.verifiedAt} onChange={e => setEvidence(v => ({ ...v, verifiedAt: e.target.value }))} className={inputCls} /></Field>
                    <Field label="Coverage effective (optional)"><input type="date" value={evidence.effectiveFrom} onChange={e => setEvidence(v => ({ ...v, effectiveFrom: e.target.value }))} className={inputCls} /></Field>
                    <Field label="Coverage end (optional)"><input type="date" value={evidence.expiresAt} onChange={e => setEvidence(v => ({ ...v, expiresAt: e.target.value }))} className={inputCls} /></Field>
                    <Field label="Copay (unknown = blank)"><input inputMode="decimal" value={evidence.copay} onChange={e => setEvidence(v => ({ ...v, copay: e.target.value }))} className={inputCls} /></Field>
                    <Field label="Deductible remaining (unknown = blank)"><input inputMode="decimal" value={evidence.deductibleRemaining} onChange={e => setEvidence(v => ({ ...v, deductibleRemaining: e.target.value }))} className={inputCls} /></Field>
                    <Field label="Coinsurance 0–1 (unknown = blank)"><input inputMode="decimal" value={evidence.coinsurance} onChange={e => setEvidence(v => ({ ...v, coinsurance: e.target.value }))} className={inputCls} /></Field>
                    <Field label="Verification notes"><input value={evidence.notes} onChange={e => setEvidence(v => ({ ...v, notes: e.target.value }))} className={inputCls} /></Field>
                    <fieldset className="sm:col-span-2 space-y-1 rounded-lg border border-[var(--b1)] p-2">
                      <legend className="px-1 text-[11px] font-semibold text-t2">Required evidence match attestation</legend>
                      {([
                        ['patientMatches', 'Evidence matches this patient'],
                        ['policyMatches', 'Evidence matches this policy/member contract'],
                        ['payerMatches', 'Evidence came from the named payer'],
                        ['serviceAndDateMatch', 'Service and date of service match this request'],
                      ] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-[11px] text-t2"><input type="checkbox" checked={evidence[key]} onChange={event => setEvidence(value => ({ ...value, [key]: event.target.checked }))} />{label}</label>)}
                    </fieldset>
                    <div className="sm:col-span-2 flex gap-2"><button type="button" disabled={!evidence.reference || !evidence.verifiedAt || !evidence.patientMatches || !evidence.policyMatches || !evidence.payerMatches || !evidence.serviceAndDateMatch} onClick={() => void submitManualEvidence(row)} className="rounded-lg bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Attest matches and save</button><button type="button" onClick={() => setEvidenceExecutionId(null)} className="rounded-lg border border-[var(--b1)] px-3 py-2 text-xs">Cancel</button></div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </BentoCard>

      {/* History */}
      <BentoCard title="Eligibility Response History" subtitle="Stored point-in-time responses · this history view omits member IDs" headerRight={<History className="w-4 h-4 text-t3" />}>
        {loading ? <div className="skeleton-line h-24 rounded-lg" />
          : history.length === 0 ? <p className="text-xs text-t3 py-4 text-center">No eligibility checks yet.</p>
          : (
            <div className="overflow-x-auto rounded-xl border border-[var(--b1)]">
              <table className="w-full border-collapse text-left">
                <thead><tr className="bg-[var(--s2)] border-b border-[var(--b1)]">
                  <th className={thCls}>Patient</th><th className={thCls}>Payer / Plan</th><th className={thCls}>Status</th><th className={`${thCls} text-right`}>Copay</th><th className={`${thCls} text-right`}>Deductible</th><th className={thCls}>Checked</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--b1)]">
                  {history.map(h => {
                    const meta = STATUS[h.coverageStatus] ?? STATUS.ERROR;
                    return (
                      <tr key={h.id} className="hover:bg-[var(--s2)] transition-colors">
                        <td className="px-4 py-2 text-[13px] font-semibold text-t1 whitespace-nowrap">{h.patientName}</td>
                        <td className="px-4 py-2 text-[12px] text-t2 whitespace-nowrap">{h.payerName} <span className="text-t3">· {h.planName}</span></td>
                        <td className="px-4 py-2 whitespace-nowrap"><span className={`badge ${meta.cls}`}>{statusLabel(h.coverageStatus, h.decisionSource)}</span><p className="mt-1 text-[10px] text-t3">{sourceLabel(h.decisionSource)}</p></td>
                        <td className="px-4 py-2 text-right text-[12px] text-t1 tabular-nums whitespace-nowrap">{formatBenefit(h.copay)}</td>
                        <td className="px-4 py-2 text-right text-[12px] text-t1 tabular-nums whitespace-nowrap">{formatBenefit(h.deductibleRemaining)}</td>
                        <td className="px-4 py-2 text-[12px] text-t3 whitespace-nowrap">{fmt(h.checkedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </BentoCard>
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]';
const thCls = 'px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-t3';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1"><span className="text-[11px] font-semibold text-t2">{label}</span>{children}</label>;
}
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="flex items-center justify-between gap-3 px-3.5 py-2"><span className="text-[11px] font-semibold text-t3">{label}</span><span className={`text-[12px] text-t1 text-right ${mono ? 'font-mono' : 'font-medium'}`}>{value}</span></div>;
}
