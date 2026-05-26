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
  title, subtitle, children, headerRight, footer, className = '', noPadding = false, highlight = false,
}: BentoCardProps) {
  return (
    <div className={`
      bg-white rounded-2xl border shadow-sm
      ${highlight ? 'border-blue-200/60 bg-gradient-to-br from-blue-50/30 to-white' : 'border-slate-200/80'}
      ${className}
    `}>
      {(title || subtitle || headerRight) && (
        <div className={`flex items-start justify-between gap-3 ${noPadding ? 'px-5 pt-5' : 'px-5 pt-5'}`}>
          <div>
            {subtitle && <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-0.5">{subtitle}</p>}
            {title && <h3 className="text-sm font-bold text-slate-900">{title}</h3>}
          </div>
          {headerRight && <div className="shrink-0">{headerRight}</div>}
        </div>
      )}
      <div className={noPadding ? '' : 'p-5 pt-4'}>
        {children}
      </div>
      {footer && (
        <div className="px-5 pb-4 pt-2 border-t border-slate-100">
          {footer}
        </div>
      )}
    </div>
  );
}
