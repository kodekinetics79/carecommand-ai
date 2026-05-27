type RiskLevel = 'high' | 'medium' | 'low' | 'critical';

interface RiskBadgeProps {
  level: RiskLevel;
  label?: string;
  size?: 'sm' | 'md';
}

const styles: Record<RiskLevel, { cls: string; dot: string }> = {
  critical: { cls: 'badge badge-red', dot: 'bg-[var(--red)] animate-pulse' },
  high:     { cls: 'badge badge-red', dot: 'bg-[var(--red)]' },
  medium:   { cls: 'badge badge-amber', dot: 'bg-[var(--amber)]' },
  low:      { cls: 'badge badge-blue', dot: 'bg-[var(--blue)]' },
};

const labels: Record<RiskLevel, string> = {
  critical: 'Critical',
  high: 'High Risk',
  medium: 'Medium',
  low: 'Low',
};

export default function RiskBadge({ level, label, size = 'md' }: RiskBadgeProps) {
  const s = styles[level];
  const sizeClass = size === 'sm' ? 'text-[10px] px-2 py-0.5' : 'text-[11px] px-2.5 py-1';

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold uppercase tracking-wide ${sizeClass} ${s.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
      {label || labels[level]}
    </span>
  );
}
