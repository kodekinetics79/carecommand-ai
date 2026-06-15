// Skeleton loader for panels — shimmer lines, reduced-motion aware (via CSS).
export default function SkeletonPanel({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={`cc-card p-4 ${className}`} aria-busy="true" aria-live="polite">
      <div className="skeleton-line h-4 w-1/3 mb-4" />
      <div className="space-y-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="skeleton-line h-9 w-9 rounded-lg shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="skeleton-line h-3 w-2/3" />
              <div className="skeleton-line h-2.5 w-1/2" />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
