import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';

export interface FormDialogField {
  name: string;
  label: string;
  type?: 'text' | 'tel' | 'email' | 'date';
  placeholder?: string;
  initialValue?: string;
  required?: boolean;
  pattern?: string;
  help?: string;
}

export default function FormDialog({
  title,
  message,
  submitLabel,
  fields,
  onSubmit,
  onClose,
}: {
  title: string;
  message?: string;
  submitLabel: string;
  fields: FormDialogField[];
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
  onClose: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(field => [field.name, field.initialValue ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstInputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.trim()])));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to complete this action.');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={message ? messageId : undefined}>
      <button type="button" aria-label="Close" title="Close" onClick={onClose} className="absolute inset-0 bg-black/45 backdrop-blur-sm animate-fade-in" />
      <div ref={dialogRef} className="relative w-full max-w-md glass-surface rounded-2xl p-5 animate-fade-up">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-sm font-bold text-t1">{title}</h2>
            {message && <p id={messageId} className="mt-1 text-[13px] leading-relaxed text-t2">{message}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-t3 hover:text-t1"><X className="h-4 w-4" /></button>
        </div>
        <form className="space-y-3" onSubmit={submit}>
          {fields.map((field, index) => {
            const fieldId = `${titleId}-${field.name}`;
            const helpId = field.help ? `${fieldId}-help` : undefined;
            return (
              <label key={field.name} htmlFor={fieldId} className="block text-xs font-semibold text-t2">
                {field.label}{field.required ? ' *' : ''}
                <input
                  ref={index === 0 ? firstInputRef : undefined}
                  id={fieldId}
                  name={field.name}
                  type={field.type ?? 'text'}
                  required={field.required}
                  pattern={field.pattern}
                  placeholder={field.placeholder}
                  value={values[field.name] ?? ''}
                  aria-describedby={helpId}
                  onChange={event => setValues(current => ({ ...current, [field.name]: event.target.value }))}
                  className="mt-1.5 w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]"
                />
                {field.help && <span id={helpId} className="mt-1 block text-[11px] font-normal text-t3">{field.help}</span>}
              </label>
            );
          })}
          {error && <p role="alert" className="text-[12px] text-red-v">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {submitLabel}
            </button>
            <button type="button" disabled={busy} onClick={onClose} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
