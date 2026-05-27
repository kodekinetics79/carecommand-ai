import type { ReactNode } from 'react';

interface BentoCardProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  headerRight?: ReactNode;
  footer?: ReactNode;
  className?: string;
  noPadding?: boolean;
  highlight?: boolean;
}

export default function BentoCard({
  title, subtitle, children, headerRight, footer,
  className = '', noPadding = false,
}: BentoCardProps) {
  return (
    <div className={`cc-card ${className}`}>
      {(title || subtitle || headerRight) && (
        <div className="bento-header">
          <div className="min-w-0">
            {subtitle && <p className="bento-sub">{subtitle}</p>}
            {title   && <h3 className="bento-title">{title}</h3>}
          </div>
          {headerRight && <div className="shrink-0 text-t3">{headerRight}</div>}
        </div>
      )}
      <div className={noPadding ? '' : 'bento-body'}>
        {children}
      </div>
      {footer && (
        <div className="bento-footer">{footer}</div>
      )}
    </div>
  );
}
