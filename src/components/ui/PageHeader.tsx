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
    <div className="flex items-start justify-between gap-4 mb-6">
      <div className="min-w-0">
        <div className="flex items-center gap-3 mb-1 flex-wrap">
          <h1 className="text-xl font-bold tracking-tight text-t1">{title}</h1>
          {badge && (
            <span className={`badge ph-badge-${badgeColor}`}>{badge}</span>
          )}
        </div>
        {subtitle && <p className="text-xs text-t3 leading-relaxed max-w-2xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
