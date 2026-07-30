import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Loader2, Check, X, PenLine, DollarSign } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import { apiRequest } from '../lib/api';

interface Requirement { key: string; label: string; met: boolean }
interface ReadinessRow {
  patientId: string; patientName: string; status: string; missing: string[]; requirements: Requirement[];
  readingDays: number; reviewMinutes: number; communicationFlag: boolean; providerSignoffAt: string | null; minReadingDays: number;
}

const STATUS_BADGE: Record<string, string> = { READY: 'badge-emerald', NEEDS_REVIEW: 'badge-amber', MISSING_REQUIREMENTS: 'badge-red' };
const STATUS_LABEL: Record<string, string> = { READY: 'Ready', NEEDS_REVIEW: 'Needs review', MISSING_REQUIREMENTS: 'Missing requirements' };

export default function RpmBillingReadiness() {
  const [rows, setRows] = useState<ReadinessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await apiRequest<ReadinessRow[]>('/v1/connected-care/rpm-readiness')); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load RPM readiness'); }
    finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function signoff(patientId: string) {
    const kind = 'signoff';
    setBusy(`${patientId}-${kind}`);
    try {
      await apiRequest(`/v1/connected-care/rpm-readiness/${patientId}/signoff`, { method: 'POST' });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); }
    finally { setBusy(null); }
  }

  const readyCount = rows.filter(r => r.status === 'READY').length;

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="badge badge-emerald inline-flex items-center gap-1"><DollarSign className="w-3 h-3" />{readyCount} billing-ready</span>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition"><RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh</button>
      </div>
      {error && <div className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[13px] text-amber-v">{error}</div>}

      <BentoCard title="RPM Billing Readiness" subtitle="Operational readiness only — never auto-submits a claim. Provider signoff required.">
        {loading ? <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton-line h-28 rounded-xl" />)}</div>
          : rows.length === 0 ? <EmptyStatePremium icon={<DollarSign className="w-5 h-5" />} title="No RPM enrollments" description="Enroll patients in an RPM program to track billing readiness here." />
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
                    <span className="text-[11px] text-t3">Review minutes and communications are accepted only from source-attributed clinical sessions.</span>
                    <button type="button" disabled={busy === `${r.patientId}-signoff` || !!r.providerSignoffAt} onClick={() => signoff(r.patientId)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy === `${r.patientId}-signoff` ? <Loader2 className="w-3 h-3 animate-spin" /> : <PenLine className="w-3 h-3" />} Provider signoff</button>
                  </div>
                </div>
              ))}
            </div>
          )}
      </BentoCard>
    </div>
  );
}
