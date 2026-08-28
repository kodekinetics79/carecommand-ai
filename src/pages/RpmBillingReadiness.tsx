import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Loader2, Check, X, PenLine, DollarSign } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import ConfirmationModal from '../components/workflow/ConfirmationModal';
import { apiRequest } from '../lib/api';

interface Requirement { key: string; label: string; met: boolean }
interface ReadinessRow {
  patientId: string; patientName: string; status: string; missing: string[]; requirements: Requirement[];
  readingDays: number; reviewMinutes: number; communicationFlag: boolean; providerSignoffAt: string | null; minReadingDays: number;
  evidenceVersion: string; evidenceHash: string; signoffAttestationRevision: string;
  qualifyingReadingCount: number; excludedReadingCount: number;
  deviceExceptions: Array<{ reason: string; count: number }>;
}

const STATUS_BADGE: Record<string, string> = { READY: 'badge-emerald', NEEDS_REVIEW: 'badge-amber', MISSING_REQUIREMENTS: 'badge-red' };
const STATUS_LABEL: Record<string, string> = { READY: 'Prerequisites recorded', NEEDS_REVIEW: 'Needs review', MISSING_REQUIREMENTS: 'Missing requirements' };

export default function RpmBillingReadiness() {
  const [rows, setRows] = useState<ReadinessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingSignoff, setPendingSignoff] = useState<ReadinessRow | null>(null);

  const load = useCallback(async () => {
    try { setRows(await apiRequest<ReadinessRow[]>('/v1/connected-care/rpm-readiness')); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load RPM readiness'); }
    finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function signoff(row: ReadinessRow) {
    const patientId = row.patientId;
    const kind = 'signoff';
    setBusy(`${patientId}-${kind}`);
    try {
      await apiRequest(`/v1/connected-care/rpm-readiness/${patientId}/signoff`, {
        method: 'POST',
        body: JSON.stringify({
          expectedEvidenceVersion: row.evidenceVersion,
          expectedEvidenceHash: row.evidenceHash,
          attestationRevision: row.signoffAttestationRevision,
        }),
      });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); throw e; }
    finally { setBusy(null); }
  }

  const readyCount = rows.filter(r => r.status === 'READY').length;

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="badge badge-emerald inline-flex items-center gap-1"><DollarSign className="w-3 h-3" />{readyCount} billing-review candidate{readyCount === 1 ? '' : 's'}</span>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition"><RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh</button>
      </div>
      {error && <div role="alert" className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[13px] text-amber-v">{error}</div>}

      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[11px] font-medium text-red-700">
        RPM records are not an emergency-monitoring service and must not be the sole basis for clinical decisions. Follow the clinic's approved escalation plan; for an emergency in the United States, call 911.
      </div>

      <BentoCard title="RPM Billing Evidence Review" subtitle="Recorded workflow prerequisites only — not coding, medical necessity, claim eligibility, or payment approval.">
        {loading ? <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton-line h-28 rounded-xl" />)}</div>
          : rows.length === 0 ? <EmptyStatePremium icon={<DollarSign className="w-5 h-5" />} title="No RPM enrollments" description="No RPM enrollment records were returned. Enrollment requires the clinic's approved RPM workflow." />
          : (
            <div className="space-y-3">
              {rows.map(r => (
                <div key={r.patientId} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-4">
                  <div className="flex items-start justify-between gap-3 mb-2.5">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-[14px] font-bold text-t1">{r.patientName}</p>
                        <span className={`badge ${STATUS_BADGE[r.status] ?? 'badge'}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                      </div>
                      <p className="text-[11px] text-t3 mt-0.5">{r.readingDays}/{r.minReadingDays} device-days · {r.reviewMinutes} review min · {r.communicationFlag ? 'communicated' : 'no comms'} · {r.providerSignoffAt ? 'signed off' : 'awaiting signoff'}</p>
                      <p className="text-[10px] text-t3 mt-1 font-mono">Evidence {r.evidenceVersion} · {r.evidenceHash.slice(0, 12)}… · {r.qualifyingReadingCount} linked reading{r.qualifyingReadingCount === 1 ? '' : 's'}</p>
                      {r.excludedReadingCount > 0 && <p className="text-[10px] text-amber-v mt-1">{r.excludedReadingCount} reading{r.excludedReadingCount === 1 ? '' : 's'} excluded: {r.deviceExceptions.map(item => `${item.reason.replaceAll('_', ' ')} (${item.count})`).join(', ')}</p>}
                    </div>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2 mb-3">
                    {r.requirements.map(req => (
                      <div key={req.key} className="flex items-center gap-2 text-[12px]">
                        {req.met ? <Check className="w-3.5 h-3.5 text-emerald-v shrink-0" /> : <X className="w-3.5 h-3.5 text-red-v shrink-0" />}
                        <span className={req.met ? 'text-t2' : 'text-t1 font-medium'}>{req.label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] text-t3">Source-attributed sessions support review. Coding/RCM staff must still validate the service, payer rules, and claim.</span>
                    <button type="button" disabled={busy === `${r.patientId}-signoff` || !!r.providerSignoffAt} onClick={() => setPendingSignoff(r)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy === `${r.patientId}-signoff` ? <Loader2 className="w-3 h-3 animate-spin" /> : <PenLine className="w-3 h-3" />} Review and attest</button>
                  </div>
                </div>
              ))}
            </div>
          )}
      </BentoCard>
      {pendingSignoff && (
        <ConfirmationModal
          title="Attest to reviewed RPM evidence"
          message={`I attest that I reviewed evidence ${pendingSignoff.evidenceVersion} (${pendingSignoff.evidenceHash.slice(0, 12)}…) displayed for ${pendingSignoff.patientName}. This records workflow evidence only and does not determine coding, medical necessity, claim eligibility, or payment.`}
          confirmLabel="Record attestation"
          tone="amber"
          onClose={() => setPendingSignoff(null)}
          onConfirm={() => signoff(pendingSignoff)}
        />
      )}
    </div>
  );
}
