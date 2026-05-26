interface ScoreBadgeProps {
  score: number;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  label?: string;
}

function getScoreStyle(score: number) {
  if (score >= 80) return { ring: 'ring-emerald-500/30', bar: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', label: 'Excellent' };
  if (score >= 60) return { ring: 'ring-amber-500/30', bar: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', label: 'Good' };
  if (score >= 40) return { ring: 'ring-orange-500/30', bar: 'bg-orange-500', text: 'text-orange-700', bg: 'bg-orange-50', label: 'Fair' };
  return { ring: 'ring-red-500/30', bar: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', label: 'Needs Attention' };
}

export default function ScoreBadge({ score, size = 'md', showLabel = false, label }: ScoreBadgeProps) {
  const style = getScoreStyle(score);
  const sizeClass = size === 'sm' ? 'text-[11px] px-2 py-0.5' : size === 'lg' ? 'text-sm px-4 py-1.5' : 'text-xs px-3 py-1';

  return (
    <span className={`inline-flex items-center gap-1.5 font-semibold rounded-full ring-1 ${sizeClass} ${style.bg} ${style.text} ${style.ring}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.bar}`} />
      {score}{showLabel && <span className="opacity-70">· {label || style.label}</span>}
    </span>
  );
}
