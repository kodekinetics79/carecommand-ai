import type { ReactNode } from 'react';

// Premium empty state — icon, headline, supporting copy, and a clear CTA.
export default function EmptyStatePremium({
  icon, title, description, cta, secondary,
}: {
  icon: ReactNode; title: string; description: string;
  cta?: { label: string; onClick: () => void };
  secondary?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10 rounded-2xl border border-dashed border-[var(--b2)] bg-[var(--s2)]">
      <div className="w-12 h-12 rounded-2xl bg-[var(--indigo-soft)] grid place-items-center text-indigo mb-3">{icon}</div>
      <p className="text-sm font-bold text-t1">{title}</p>
      <p className="text-[12px] text-t3 mt-1 max-w-sm leading-relaxed">{description}</p>
      {cta && (
        <button type="button" onClick={cta.onClick}
          className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
          {cta.label}
        </button>
      )}
      {secondary && <div className="mt-2">{secondary}</div>}
    </div>
  );
}
