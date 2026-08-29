import { useCallback, useState } from 'react';
import { Plus, Save, Copy, Check, Loader2 } from 'lucide-react';
import ConfirmationModal from '../workflow/ConfirmationModal';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-v" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export function EmptyState({ text, onAction, actionLabel }: { text: string; onAction?: () => void; actionLabel?: string }) {
  return (
    <div className="cc-card p-10 text-center">
      <p className="text-sm text-t3 mb-3">{text}</p>
      {onAction && actionLabel && (
        <button type="button" onClick={onAction} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
          <Plus className="w-4 h-4" /> {actionLabel}
        </button>
      )}
    </div>
  );
}

export function ConfirmedButton({
  children,
  dialogTitle,
  message,
  confirmLabel,
  tone = 'amber',
  requireReason = false,
  reasonLabel,
  disabled,
  className,
  buttonTitle,
  ariaLabel,
  onConfirm,
}: {
  children: React.ReactNode;
  dialogTitle: string;
  message: string;
  confirmLabel: string;
  tone?: 'indigo' | 'red' | 'amber';
  requireReason?: boolean;
  reasonLabel?: string;
  disabled?: boolean;
  className: string;
  buttonTitle?: string;
  ariaLabel?: string;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" disabled={disabled} title={buttonTitle} aria-label={ariaLabel} onClick={() => setOpen(true)} className={className}>{children}</button>
      {open && (
        <ConfirmationModal
          title={dialogTitle}
          message={message}
          confirmLabel={confirmLabel}
          tone={tone}
          requireReason={requireReason}
          reasonLabel={reasonLabel}
          onConfirm={onConfirm}
          onClose={close}
        />
      )}
    </>
  );
}

export function SaveBar({ dirty, busy, onSave, savedAt }: { dirty: boolean; busy: boolean; onSave: () => void; savedAt: number | null }) {
  return (
    <div className="flex items-center justify-end gap-3">
      {savedAt && !dirty && <span className="text-[11px] font-semibold text-emerald-v inline-flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Saved</span>}
      <button
        type="button"
        disabled={!dirty || busy}
        onClick={onSave}
        className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save changes
      </button>
    </div>
  );
}

export function SampleCard({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="cc-card p-5 space-y-2">
      <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2">{icon} {title}</h3>
      <p className="text-sm text-t2 leading-relaxed">{text}</p>
    </div>
  );
}

export function KV({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-t3">{label}</p>
      <p className={`text-xs text-t1 mt-0.5 break-words ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}
