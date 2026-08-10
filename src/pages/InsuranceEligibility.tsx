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
  copay: number; deductibleRemaining: number; coinsurance: number; message: string; payerReference: string | null;
  maskedMemberId: string | null; providerMode: string; checkedAt: string; effectiveFrom?: string | null; expiresAt?: string | null;
}
interface HistoryRow {
  id: string; patientName: string; coverageStatus: string; planName: string; payerName: string;
  copay: number; deductibleRemaining: number; coinsurance: number; providerMode: string; checkedAt: string; effectiveFrom?: string | null; expiresAt?: string | null;
}

const STATUS: Record<string, { cls: string; icon: ElementType; label: string }> = {
  ACTIVE: { cls: 'badge-emerald', icon: ShieldCheck, label: 'Payer reports active' },
  INACTIVE: { cls: 'badge-red', icon: ShieldX, label: 'Payer reports inactive' },
  NEEDS_REVIEW: { cls: 'badge-amber', icon: ShieldAlert, label: 'Needs review' },
  ERROR: { cls: 'badge-red', icon: AlertTriangle, label: 'Error' },
};
function fmt(iso: string): string { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

export default function InsuranceEligibility() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [patients, setPatients] = useState<CrmPatient[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ patientId: '', payerName: '', memberId: '', planName: '' });
  const [result, setResult] = useState<EligibilityResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try { setHistory(await apiRequest<HistoryRow[]>('/v1/insurance/eligibility/history')); } catch { /* non-fatal */ }
  }, []);
  const load = useCallback(async () => {
    try {
      const [prov, pats] = await Promise.all([
        apiRequest<ProviderRow[]>('/v1/insurance/providers'),
        crmService.getPatients().catch(() => [] as CrmPatient[]),
      ]);
      setProviders(prov); setPatients(pats);
      await loadHistory();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [loadHistory]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const stedi = providers.find(p => p.key === 'stedi');
  const canCheck = !!stedi && (stedi.status === 'SANDBOX' || stedi.status === 'ACTIVE');
  const valid = form.patientId && form.payerName.trim().length >= 2 && form.memberId.trim().length >= 2;

  async function check() {
    if (!valid) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const input = { patientId: form.patientId, payerName: form.payerName.trim(), memberId: form.memberId.trim(), planName: form.planName.trim() || undefined };
      const res = await runEligibilityAction('insurance_v1', input, key => apiRequest<EligibilityResult>('/v1/insurance/eligibility/check', {
        method: 'POST', headers: eligibilityRequestHeaders(key), body: JSON.stringify(input),
      }));
      setResult(res);
      await loadHistory();
    } catch (e) { setError(e instanceof Error ? e.message : 'Eligibility check failed'); }
    finally { setBusy(false); }
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
                    <span className={`badge ${meta.cls} inline-flex items-center gap-1 text-[12px]`}><Icon className="w-3.5 h-3.5" />{meta.label}</span>
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
                    <Row label="Copay" value={formatCurrency(result.copay)} />
                    <Row label="Deductible remaining" value={formatCurrency(result.deductibleRemaining)} />
                    <Row label="Coinsurance" value={`${result.coinsurance}%`} />
                    <Row label="Payer reference" value={result.payerReference ?? '—'} mono />
                    <Row label="Coverage effective" value={result.effectiveFrom ? fmt(result.effectiveFrom) : 'Unknown — payer did not provide'} />
                    <Row label="Coverage end" value={result.expiresAt ? fmt(result.expiresAt) : 'Unknown — payer did not provide'} />
                  </div>
                </div>
              );
            })()}
        </BentoCard>
      </div>

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
                        <td className="px-4 py-2 whitespace-nowrap"><span className={`badge ${meta.cls}`}>{meta.label}</span></td>
                        <td className="px-4 py-2 text-right text-[12px] text-t1 tabular-nums whitespace-nowrap">{formatCurrency(h.copay)}</td>
                        <td className="px-4 py-2 text-right text-[12px] text-t1 tabular-nums whitespace-nowrap">{formatCurrency(h.deductibleRemaining)}</td>
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
