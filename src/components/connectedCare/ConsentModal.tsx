import { useCallback, useEffect, useId, useState } from 'react';
import { Loader2, X, ShieldCheck, ShieldOff } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { RPM_CONSENT_SCRIPT } from './consentScript';

/**
 * Capture or withdraw RPM consent, with the consent language on screen.
 *
 * What this replaces: a single unlabelled "Consent" button that always posted
 * granted:true with method hardcoded to 'verbal'. Three problems with that.
 * The method was a fabricated fact — the system asserted that verbal consent
 * was obtained when no human had said so. There was no way to see whether
 * consent already existed, and no way to withdraw it. And because every consent
 * write mutates billing evidence, clicking it a second time silently withdrew a
 * physician's attestation, with no confirmation and no feedback to explain why
 * nothing appeared to happen.
 *
 * Cost-sharing is on screen because that is the stated purpose of the consent
 * requirement: the patient must be told they may owe a copay for a service that
 * involves no visit. The clinic's own script belongs here too — the text shown
 * is what the staff member is attesting they conveyed.
 */

const METHODS = [
  { value: 'verbal', label: 'Verbal — read to the patient and confirmed' },
  { value: 'written', label: 'Written — signed form on file' },
  { value: 'portal', label: 'Patient portal — accepted online' },
  { value: 'esign', label: 'Electronic signature' },
] as const;

interface ConsentRecord {
  id: string;
  consentType: string;
  granted: boolean;
  method: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
}

interface Props {
  patientId: string;
  patientName: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function ConsentModal({ patientId, patientName, onClose, onSaved }: Props) {
  const titleId = useId();
  const [current, setCurrent] = useState<ConsentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<string>('verbal');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show the state BEFORE offering the action. Staff previously had no way to
  // know whether consent existed, so the only safe-feeling move was to click
  // again — which is exactly the click that destroyed an attestation.
  useEffect(() => {
    let active = true;
    apiRequest<ConsentRecord[]>(`/v1/connected-care/consent?patientId=${encodeURIComponent(patientId)}`)
      .then(rows => { if (active) { setCurrent(rows.find(r => r.consentType === 'rpm') ?? null); setLoadError(null); } })
      .catch(e => { if (active) setLoadError(e instanceof Error ? e.message : 'Could not read current consent'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [patientId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useCallback(async (granted: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/v1/connected-care/consent', {
        method: 'POST',
        body: JSON.stringify({ patientId, consentType: 'rpm', granted, method: granted ? method : undefined }),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record consent');
      setBusy(false);
    }
  }, [patientId, method, onSaved, onClose]);

  const alreadyGranted = Boolean(current?.granted);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="w-full max-w-lg rounded-2xl border border-[var(--b1)] bg-[var(--s1)] shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--b1)] p-4">
          <div>
            <h2 id={titleId} className="text-[15px] font-bold text-t1">RPM consent</h2>
            <p className="text-[12px] text-t2 mt-0.5">{patientName}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-t3 hover:bg-[var(--s3)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-t3 mb-1">Current state</p>
            {loading ? (
              <p className="text-[12px] text-t3">Reading current consent…</p>
            ) : loadError ? (
              <p role="alert" className="text-[12px] text-amber-v">{loadError}</p>
            ) : alreadyGranted ? (
              <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-emerald-v">
                <ShieldCheck className="w-4 h-4" />
                Granted{current?.method ? ` · ${current.method}` : ''}
                {current?.grantedAt ? ` · ${new Date(current.grantedAt).toLocaleDateString()}` : ''}
              </p>
            ) : (
              <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-t2">
                <ShieldOff className="w-4 h-4 text-t3" />
                {current ? 'Withdrawn' : 'No consent on record'}
              </p>
            )}
          </div>

          <div>
            <p className="text-[11px] font-semibold text-t2 mb-1.5">What the patient must be told</p>
            <ul className="space-y-1.5 rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
              {RPM_CONSENT_SCRIPT.map(line => (
                <li key={line} className="text-[12px] leading-relaxed text-t2">• {line}</li>
              ))}
            </ul>
          </div>

          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-t2">How was consent obtained?</span>
            <select value={method} onChange={e => setMethod(e.target.value)} disabled={alreadyGranted}
              className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-[13px] text-t1 outline-none focus:border-[var(--b3)] disabled:opacity-60">
              {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>

          {!alreadyGranted && (
            <label className="flex items-start gap-2 text-[12px] text-t2">
              <input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} className="mt-0.5" />
              <span>I read the above to the patient, including that they may owe a copay, and they agreed.</span>
            </label>
          )}

          <div className="rounded-lg border border-[var(--b1)] bg-[var(--amber-soft)] p-2.5 text-[11px] text-amber-v">
            Consent is part of billing evidence. Changing it withdraws any provider attestation for the current period, which must then be given again.
          </div>

          {error && <div role="alert" className="rounded-lg border border-[var(--b1)] bg-[var(--amber-soft)] p-2.5 text-[12px] text-amber-v">{error}</div>}

          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-[var(--b1)] px-3 py-2 text-[13px] font-semibold text-t2 hover:bg-[var(--s3)]">Cancel</button>
            {alreadyGranted ? (
              <button type="button" disabled={busy} onClick={() => void save(false)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldOff className="w-4 h-4" />} Withdraw consent
              </button>
            ) : (
              <button type="button" disabled={busy || !acknowledged} onClick={() => void save(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} Record consent
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
