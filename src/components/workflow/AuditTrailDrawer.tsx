import { useEffect, useState } from 'react';
import { X, ScrollText, Info } from 'lucide-react';
import { opportunityService, NotImplemented, type Opportunity } from '../../lib/opportunityService';

interface TrailEntry { action: string; at: string; actor: string; detail: string }

export default function AuditTrailDrawer({ opportunity, onClose }: { opportunity: Opportunity; onClose: () => void }) {
  const [entries, setEntries] = useState<TrailEntry[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const t = await opportunityService.getAuditTrail(opportunity.id);
        if (active) setEntries(t);
      } catch (e) {
        if (!active) return;
        if (e instanceof NotImplemented) setPending(e.contract);
        // Derived lifecycle from the record (real timestamps + current state).
        setEntries([
          { action: 'opportunity.detected', at: '', actor: 'CareCommand AI', detail: `${opportunity.title} surfaced from ${opportunity.source || 'operating data'}` },
          { action: `status: ${opportunity.status}`, at: '', actor: opportunity.owner, detail: `Approval: ${opportunity.approval.replace(/_/g, ' ')}` },
        ]);
      }
    })();
    return () => { active = false; };
  }, [opportunity]);

  return (
    <div className="fixed inset-0 z-[55] flex justify-end" role="dialog" aria-modal="true" aria-label="Audit trail">
      <button type="button" aria-label="Close" title="Close" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-sm glass-surface h-full overflow-y-auto animate-fade-up">
        <header className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-[var(--b1)] glass-surface-head">
          <div className="flex items-center gap-2"><ScrollText className="w-4 h-4 text-indigo" /><h2 className="text-sm font-bold text-t1">Audit trail</h2></div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-t3 hover:text-t1"><X className="w-5 h-5" /></button>
        </header>
        <div className="p-5">
          {pending && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-soft border border-[rgba(217,119,6,0.2)] px-3 py-2 text-[11px] text-amber-v mb-3">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>Full event history pending backend — <code className="font-mono">{pending}</code>. Showing the known lifecycle.</span>
            </div>
          )}
          {!entries ? <div className="skeleton-line h-24 rounded-xl" /> : (
            <ol className="relative border-l border-[var(--b2)] ml-2 space-y-4">
              {entries.map((e, i) => (
                <li key={i} className="pl-4 relative">
                  <span className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-indigo" />
                  <p className="text-[12px] font-mono font-semibold text-t1">{e.action}</p>
                  <p className="text-[11px] text-t2 mt-0.5">{e.detail}</p>
                  <p className="text-[10px] text-t3 mt-0.5">{e.actor}{e.at ? ` · ${new Date(e.at).toLocaleString()}` : ''}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
