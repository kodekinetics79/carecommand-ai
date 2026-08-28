import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';

// Confirmation modal. When `requireReason` is set, the confirm button stays
// disabled until a reason is entered (used for dismiss/snooze — the reason is
// passed to onConfirm and recorded in the audit metadata server-side).
export default function ConfirmationModal({
  title, message, confirmLabel, tone = 'indigo', requireReason = false, onConfirm, onClose,
}: {
  title: string; message: string; confirmLabel: string;
  tone?: 'indigo' | 'red' | 'amber'; requireReason?: boolean;
  onConfirm: (reason: string) => Promise<void> | void; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const btn = tone === 'red' ? 'bg-[var(--red)]' : tone === 'amber' ? 'bg-[var(--amber)]' : 'bg-[var(--indigo)]';
  async function go() {
    if (requireReason && reason.trim().length < 3) { setErr('A reason is required.'); return; }
    setBusy(true); setErr(null);
    try { await onConfirm(reason.trim()); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Action failed'); setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" title="Close" onClick={onClose} className="absolute inset-0 bg-black/45 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-md glass-surface rounded-2xl p-5 animate-fade-up">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            {tone !== 'indigo' && <AlertTriangle className={`w-4 h-4 ${tone === 'red' ? 'text-red-v' : 'text-amber-v'}`} aria-hidden="true" />}
            <h2 className="text-sm font-bold text-t1">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-t3 hover:text-t1"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-[13px] text-t2 leading-relaxed">{message}</p>
        {requireReason && (
          <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required, recorded in the audit trail)…"
            className="mt-3 w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)] min-h-16" />
        )}
        {err && <p className="text-[12px] text-red-v mt-2">{err}</p>}
        <div className="flex gap-2 mt-4">
          <button type="button" disabled={busy} onClick={go} className={`inline-flex items-center gap-1.5 rounded-xl ${btn} px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50`}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} {confirmLabel}
          </button>
          <button type="button" onClick={onClose} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)]">Cancel</button>
        </div>
      </div>
    </div>
  );
}
