import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export default function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
      {icon && (
        <div className="w-12 h-12 rounded-2xl bg-[var(--s3)] flex items-center justify-center text-t3 mb-4">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-t2">{title}</p>
      {description && <p className="text-xs text-t3 mt-1 max-w-xs leading-relaxed">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
