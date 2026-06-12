import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

const inputClass =
  'w-full rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-sm text-t1 outline-none focus:border-indigo placeholder:text-t3 disabled:opacity-50';

export function Field({ label, hint, children, required }: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-bold uppercase tracking-wide text-t3">
        {label}{required && <span className="text-red-v"> *</span>}
      </span>
      {children}
      {hint && <span className="block text-[10px] text-t3 leading-snug">{hint}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} leading-relaxed ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
        checked ? 'border-indigo bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] bg-[var(--s3)] text-t3'
      }`}
    >
      <span className={`relative h-4 w-7 rounded-full transition-colors ${checked ? 'bg-indigo' : 'bg-[var(--b2)]'}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${checked ? 'left-3.5' : 'left-0.5'}`} />
      </span>
      {label}
    </button>
  );
}
