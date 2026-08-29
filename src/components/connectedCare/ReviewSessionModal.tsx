import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, Play, Square, X, ShieldCheck } from 'lucide-react';
import { apiRequest } from '../../lib/api';

/**
 * Capture one clinical review session against the RPM billing period.
 *
 * The endpoint behind this has existed and been tested for a while; nothing in
 * the product ever called it, so review minutes were permanently zero and no
 * patient could satisfy the treatment-management requirement. This is that
 * missing screen.
 *
 * Time is MEASURED, never estimated. The timer records real start and end
 * instants and the server recomputes the duration from them — it does not trust
 * a client-supplied minute count. Competing products impute minutes from event
 * counts ("a call happened, add five"); an imputed number cannot answer an
 * auditor asking what was actually done.
 *
 * Two fields are required because a duration alone fails an audit: an activity
 * narrative (a bare "reviewed RPM data" is explicitly not accepted) and the
 * communication modality, since only a LIVE interactive contact can support a
 * management code. Non-live options are offered deliberately — staff should be
 * able to log a voicemail honestly rather than pick the option that pays.
 */

const MODALITIES = [
  { value: 'live_phone', label: 'Live phone call', live: true },
  { value: 'video', label: 'Video visit', live: true },
  { value: 'live_chat', label: 'Live chat', live: true },
  { value: 'text_message', label: 'Text message', live: false },
  { value: 'voicemail', label: 'Voicemail left', live: false },
  { value: 'secure_message', label: 'Secure message', live: false },
  { value: 'none', label: 'No patient contact this session', live: false },
] as const;

const MIN_SESSION_MS = 60_000;

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface Props {
  patientId: string;
  patientName: string;
  onClose: () => void;
  onRecorded: () => void;
}

export default function ReviewSessionModal({ patientId, patientName, onClose, onRecorded }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stoppedAt, setStoppedAt] = useState<Date | null>(null);
  const [narrative, setNarrative] = useState('');
  const [modality, setModality] = useState<string>('live_phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tick off the real clock rather than accumulating an interval, so a
  // throttled background tab cannot under-count the session actually worked.
  useEffect(() => {
    if (!startedAt || stoppedAt) return;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt.getTime()), 250);
    return () => clearInterval(id);
  }, [startedAt, stoppedAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selected = MODALITIES.find(m => m.value === modality);
  const tooShort = elapsedMs < MIN_SESSION_MS;
  const narrativeTooShort = narrative.trim().length < 12;
  const canSubmit = Boolean(stoppedAt) && !tooShort && !narrativeTooShort && !busy;

  const submit = useCallback(async () => {
    if (!startedAt || !stoppedAt) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/v1/connected-care/rpm-readiness/${patientId}/review`, {
        method: 'PATCH',
        body: JSON.stringify({
          reviewEventId: crypto.randomUUID(),
          // Identifies this real-world encounter. Reusing it — for this patient
          // or by this clinician against another — is rejected as a duplicate.
          sourceRef: `cc-session-${startedAt.toISOString()}-${patientId.slice(0, 8)}`,
          provenance: 'DEVICE_SESSION',
          startedAt: startedAt.toISOString(),
          endedAt: stoppedAt.toISOString(),
          activityNarrative: narrative.trim(),
          communicationModality: modality,
        }),
      });
      onRecorded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record this review session');
      setBusy(false);
    }
  }, [startedAt, stoppedAt, patientId, narrative, modality, onRecorded, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="w-full max-w-lg rounded-2xl border border-[var(--b1)] bg-[var(--s1)] shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--b1)] p-4">
          <div>
            <h2 id={titleId} className="text-[15px] font-bold text-t1">Clinical review session</h2>
            <p className="text-[12px] text-t2 mt-0.5">{patientName}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-t3 hover:bg-[var(--s3)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-4 text-center">
            <p className="font-mono text-3xl font-bold tabular-nums text-t1" aria-live="polite">
              {formatElapsed(elapsedMs)}
            </p>
            <p className="text-[11px] text-t3 mt-1">
              {!startedAt ? 'Not started' : stoppedAt ? 'Session ended' : 'Recording — measured from the clock, not estimated'}
            </p>
            <div className="mt-3 flex items-center justify-center gap-2">
              {!startedAt && (
                <button type="button" onClick={() => { setStartedAt(new Date()); setElapsedMs(0); }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90">
                  <Play className="w-4 h-4" /> Start review
                </button>
              )}
              {startedAt && !stoppedAt && (
                <button type="button" onClick={() => { const now = new Date(); setStoppedAt(now); setElapsedMs(now.getTime() - startedAt.getTime()); }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90">
                  <Square className="w-4 h-4" /> Stop and log
                </button>
              )}
            </div>
            {stoppedAt && tooShort && (
              <p className="text-[11px] text-amber-v mt-2">
                Sessions under one minute are not recordable. Nothing has been logged.
              </p>
            )}
          </div>

          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-t2">What did you do? <span className="text-red-v">*</span></span>
            <textarea
              value={narrative}
              onChange={e => setNarrative(e.target.value)}
              rows={3}
              placeholder="e.g. Reviewed 7-day BP trend, discussed evening dosing, confirmed cuff placement."
              className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-[13px] text-t1 outline-none focus:border-[var(--b3)]"
            />
            <span className="text-[10px] text-t3">
              An auditor needs the activity, not just the duration &mdash; &ldquo;reviewed RPM data&rdquo; on its own is not accepted.
            </span>
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-semibold text-t2">Patient contact during this session</span>
            <select value={modality} onChange={e => setModality(e.target.value)}
              className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-[13px] text-t1 outline-none focus:border-[var(--b3)]">
              {MODALITIES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <span className={`text-[10px] ${selected?.live ? 'text-emerald-v' : 'text-t3'}`}>
              {selected?.live
                ? 'Live and interactive — this can support a treatment-management code.'
                : 'Recorded, but not a live interactive contact, so it cannot support a management code on its own.'}
            </span>
          </label>

          {error && <div role="alert" className="rounded-lg border border-[var(--b1)] bg-[var(--amber-soft)] p-2.5 text-[12px] text-amber-v">{error}</div>}

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="inline-flex items-center gap-1 text-[10px] text-t3">
              <ShieldCheck className="w-3 h-3" /> Recorded as append-only evidence against your account.
            </span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="rounded-lg border border-[var(--b1)] px-3 py-2 text-[13px] font-semibold text-t2 hover:bg-[var(--s3)]">Cancel</button>
              <button type="button" disabled={!canSubmit} onClick={() => void submit()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Record session
              </button>
            </div>
          </div>
          {stoppedAt && narrativeTooShort && (
            <p className="text-[11px] text-t3 text-right">Add a short description of the activity to record this session.</p>
          )}
        </div>
      </div>
    </div>
  );
}
