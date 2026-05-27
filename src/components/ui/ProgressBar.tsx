interface ProgressBarProps {
  value: number;
  max?: number;
  color?: 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'teal' | 'cyan' | 'indigo';
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

export default function ProgressBar({ value, max = 100, color, size = 'sm', className = '' }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, Math.round((value / Math.max(max, 1)) * 100)));
  const auto = !color ? (pct >= 70 ? 'emerald' : pct >= 40 ? 'amber' : 'red') : color;
  const sizeCls = size === 'md' ? 'md' : 'sm';
  return (
    <div className={`prog-track ${sizeCls} ${className}`}>
      <div className={`prog-fill pf-${auto}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
