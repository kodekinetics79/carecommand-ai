import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  badge?: string;
  badgeColor?: 'blue' | 'emerald' | 'amber' | 'red' | 'violet';
}

export default function PageHeader({ title, subtitle, actions, badge, badgeColor = 'blue' }: PageHeaderProps) {
  return (
    <div className="page-header mb-6 flex flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-3 mb-1 flex-wrap">
          <h1 className="page-title text-xl font-bold tracking-tight text-t1">{title}</h1>
          {badge && (
            <span className={`badge ph-badge-${badgeColor}`}>{badge}</span>
          )}
        </div>
        {subtitle && <p className="page-subtitle text-xs text-t3 leading-relaxed max-w-2xl">{subtitle}</p>}
      </div>
      {actions && (
        <div className="page-actions flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
          {actions}
        </div>
      )}
    </div>
  );
}
