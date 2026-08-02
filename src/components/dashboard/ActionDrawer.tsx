import { useEffect } from 'react';
import { X, Megaphone, ArrowRight } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import { type PriorityAction, type Severity } from '../../lib/dashboardService';

const SEV_BADGE: Record<Severity, string> = { critical: 'badge-red', high: 'badge-amber', medium: 'badge-blue', low: 'badge-emerald' };
const CATEGORY_LABEL: Record<string, string> = {
  revenue: 'Revenue', no_shows: 'No-shows', missed_calls: 'Missed calls', insurance: 'Insurance',
  payments: 'Payments', device_alerts: 'Device alerts', reputation: 'Reputation',
};

export default function ActionDrawer({ action, onClose, onNavigate }: { action: PriorityAction; onClose: () => void; onNavigate: (route: string) => void }) {
  // Esc closes; lock focus into the drawer for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={action.title}>
      <button type="button" aria-label="Close panel" title="Close panel" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-md glass-surface h-full overflow-y-auto animate-fade-up flex flex-col">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--b1)] glass-surface-head">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`badge ${SEV_BADGE[action.severity]}`}>{action.severity}</span>
              <span className="badge badge-blue">{CATEGORY_LABEL[action.category] ?? action.category}</span>
            </div>
            <h2 className="text-base font-bold text-t1 leading-tight">{action.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-t3 hover:text-t1"><X className="w-5 h-5" /></button>
        </header>

        <div className="p-5 space-y-4 flex-1">
          {action.description && <p className="text-[13px] text-t2 leading-relaxed">{action.description}</p>}

          <div className="grid grid-cols-2 gap-3">
            <Detail label="Revenue impact" value={action.revenueImpact != null ? formatCurrency(action.revenueImpact) : '—'} />
            <Detail label="Owner" value={action.owner} />
            <Detail label="Due" value={action.dueDate ? new Date(action.dueDate).toLocaleDateString() : 'No due date'} />
          </div>

        </div>

        <footer className="p-5 border-t border-[var(--b1)] bg-[var(--s1)] space-y-2">
          <button type="button" onClick={() => onNavigate(action.cta.route)}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--indigo)] px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition">
            <Megaphone className="w-4 h-4" /> {action.cta.label} <ArrowRight className="w-4 h-4" />
          </button>
        </footer>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-t3">{label}</p>
      <p className="text-sm font-semibold text-t1">{value}</p>
    </div>
  );
}
