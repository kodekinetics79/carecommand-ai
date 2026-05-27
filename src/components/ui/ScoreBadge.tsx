interface ScoreBadgeProps {
  score: number;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  label?: string;
}

function getScoreStyle(score: number) {
  if (score >= 80) return { cls: 'badge badge-emerald', dot: 'bg-[var(--emerald)]', label: 'Excellent' };
  if (score >= 60) return { cls: 'badge badge-amber',   dot: 'bg-[var(--amber)]',   label: 'Good' };
  if (score >= 40) return { cls: 'badge badge-amber',   dot: 'bg-[var(--amber)]',   label: 'Fair' };
  return           { cls: 'badge badge-red',             dot: 'bg-[var(--red)]',     label: 'Needs Attention' };
}

export default function ScoreBadge({ score, size = 'md', showLabel = false, label }: ScoreBadgeProps) {
  const style = getScoreStyle(score);
  const sizeClass = size === 'sm' ? 'text-[10px] px-2 py-0.5' : size === 'lg' ? 'text-sm px-4 py-1.5' : 'text-xs px-3 py-1';

  return (
    <span className={`inline-flex items-center gap-1.5 font-semibold rounded-full ${sizeClass} ${style.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {score}{showLabel && <span className="opacity-70">· {label || style.label}</span>}
    </span>
  );
}
