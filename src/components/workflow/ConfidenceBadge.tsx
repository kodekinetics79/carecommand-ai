import { Gauge } from 'lucide-react';

// Confidence uses green (success) per the design system. Always paired with a
// label + icon (never color-only).
export default function ConfidenceBadge({ value, size = 'sm' }: { value: number; size?: 'sm' | 'xs' }) {
  const tone = value >= 80 ? 'text-emerald-v bg-emerald-soft' : value >= 60 ? 'text-amber-v bg-amber-soft' : 'text-t2 bg-[var(--s3)]';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-bold ${tone} ${size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'}`}>
      <Gauge className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} aria-hidden="true" />
      {value}% confidence
    </span>
  );
}
