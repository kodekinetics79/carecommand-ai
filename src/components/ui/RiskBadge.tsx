type RiskLevel = 'high' | 'medium' | 'low' | 'critical';

interface RiskBadgeProps {
  level: RiskLevel;
  label?: string;
  size?: 'sm' | 'md';
}

const styles: Record<RiskLevel, { bg: string; text: string; dot: string }> = {
  critical: { bg: 'bg-red-50 ring-1 ring-red-200', text: 'text-red-700', dot: 'bg-red-500 animate-pulse' },
  high: { bg: 'bg-red-50 ring-1 ring-red-200', text: 'text-red-700', dot: 'bg-red-400' },
  medium: { bg: 'bg-amber-50 ring-1 ring-amber-200', text: 'text-amber-700', dot: 'bg-amber-400' },
  low: { bg: 'bg-slate-100 ring-1 ring-slate-200', text: 'text-slate-600', dot: 'bg-slate-400' },
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
    <span className={`inline-flex items-center gap-1.5 rounded-full font-semibold uppercase tracking-wide ${sizeClass} ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
      {label || labels[level]}
    </span>
  );
}
