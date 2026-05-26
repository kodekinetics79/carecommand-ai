interface ProgressBarProps {
  value: number;
  max?: number;
  color?: 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'teal' | 'cyan';
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

const colorClass = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  teal: 'bg-teal-500',
  cyan: 'bg-cyan-500',
};

const sizeClass = {
  xs: 'h-1',
  sm: 'h-1.5',
  md: 'h-2',
};

function autoColor(pct: number): 'emerald' | 'amber' | 'red' {
  if (pct >= 75) return 'emerald';
  if (pct >= 50) return 'amber';
  return 'red';
}

export default function ProgressBar({ value, max = 100, color, size = 'sm', className = '' }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const resolvedColor = color ?? autoColor(pct);
  return (
    <div className={`bg-slate-100 rounded-full overflow-hidden ${sizeClass[size]} ${className}`}>
      <div
        className={`h-full rounded-full progress-bar ${colorClass[resolvedColor]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
