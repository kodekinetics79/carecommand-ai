import { useEffect, useState } from 'react';
import { X, Megaphone, MessageSquare, PhoneCall, CalendarPlus, Send, Users, Clock3, Ban, CheckCircle2 } from 'lucide-react';
import OpportunityDetailPanel from './OpportunityDetailPanel';
import ConfirmationModal from '../workflow/ConfirmationModal';
import { opportunityService, type Opportunity, type WorkflowVerb } from '../../lib/opportunityService';

type CtaTone = 'indigo' | 'amber' | 'red';
interface Cta { id: string; label: string; icon: typeof Megaphone; tone: CtaTone; confirm: { title: string; message: string }; verb?: WorkflowVerb; route?: string }

function ctasFor(o: Opportunity): Cta[] {
  const out: Cta[] = [];
  if (o.approval === 'pending_approval') out.push({ id: 'approve', label: 'Approve Campaign', icon: CheckCircle2, tone: 'indigo', verb: 'approve_campaign', confirm: { title: 'Approve campaign?', message: `This approves "${o.title}" for execution and removes the approval hold.` } });
  if (o.category === 'inactive-patients' || o.category === 'reputation') out.push({ id: 'recovery', label: 'Build Recovery Campaign', icon: MessageSquare, tone: 'indigo', route: '/campaigner', confirm: { title: 'Open Campaigner?', message: 'Build and approve a consent-checked recovery campaign before any message is sent.' } });
  if (o.category === 'front-desk') out.push({ id: 'callback', label: 'Assign Callback Queue', icon: PhoneCall, tone: 'indigo', verb: 'assign_callback', confirm: { title: 'Assign callback queue?', message: 'Uncontacted callers will be routed to the front-desk callback queue.' } });
  if (o.category === 'no-show' || o.category === 'scheduling') out.push({ id: 'fill', label: 'Build Schedule Fill Campaign', icon: CalendarPlus, tone: 'indigo', route: '/campaigner', confirm: { title: 'Open Campaigner?', message: 'Build and approve a schedule-fill campaign before any outreach occurs.' } });
  out.push({ id: 'frontdesk', label: 'Send to Front Desk', icon: Send, tone: 'amber', verb: 'send_front_desk', confirm: { title: 'Send to front desk?', message: 'This assigns the action to the branch front-desk team.' } });
  return out;
}

export default function OpportunityActionDrawer({ opportunity, onClose, onChanged, onNavigate }: {
  opportunity: Opportunity; onClose: () => void; onChanged: (o: Opportunity) => void; onNavigate: (route: string) => void;
}) {
  const [confirm, setConfirm] = useState<Cta | null>(null);
  const [reasonAction, setReasonAction] = useState<{ kind: 'dismiss' | 'snooze' } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !confirm && !reasonAction) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirm, reasonAction]);

  const ctas = ctasFor(opportunity);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={opportunity.title}>
      <button type="button" aria-label="Close panel" title="Close panel" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-lg glass-surface h-full overflow-y-auto animate-fade-up flex flex-col">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--b1)] glass-surface-head">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wider text-t3">{opportunity.department} · {opportunity.branch}</p>
            <h2 className="text-base font-bold text-t1 leading-tight mt-0.5">{opportunity.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-t3 hover:text-t1 shrink-0"><X className="w-5 h-5" /></button>
        </header>

        <div className="p-5 flex-1">
          <OpportunityDetailPanel opportunity={opportunity} />
        </div>

        <footer className="p-5 border-t border-[var(--b1)] bg-[var(--s1)] space-y-2">
          {ctas.map(c => {
            const Icon = c.icon;
            const cls = c.tone === 'amber' ? 'border border-[rgba(217,119,6,0.3)] text-amber-v hover:bg-amber-soft' : 'bg-[var(--indigo)] text-white hover:opacity-90';
            return (
              <button key={c.id} type="button" onClick={() => setConfirm(c)} className={`w-full inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${cls}`}>
                <Icon className="w-4 h-4" /> {c.label}
              </button>
            );
          })}
          <button type="button" onClick={() => onNavigate('/patients')} className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-[var(--b1)] px-4 py-2.5 text-sm font-semibold text-t2 hover:bg-[var(--s2)] transition">
            <Users className="w-4 h-4" /> Open Patient List
          </button>
          <div className="grid grid-cols-2 gap-2 pt-1">
            <SmallBtn icon={Clock3} label="Snooze" onClick={() => setReasonAction({ kind: 'snooze' })} />
            <SmallBtn icon={Ban} label="Dismiss" onClick={() => setReasonAction({ kind: 'dismiss' })} />
          </div>
        </footer>
      </div>

      {confirm && (
        <ConfirmationModal
          title={confirm.confirm.title} message={confirm.confirm.message} confirmLabel={confirm.label} tone={confirm.tone}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            if (confirm.route) { onNavigate(confirm.route); return; }
            if (confirm.verb) { const updated = await opportunityService.runWorkflow(opportunity.id, confirm.verb); onChanged(updated); }
          }}
        />
      )}
      {reasonAction && (
        <ConfirmationModal
          title={reasonAction.kind === 'dismiss' ? 'Dismiss opportunity?' : 'Snooze opportunity?'}
          message={reasonAction.kind === 'dismiss' ? 'This removes the opportunity from the active queue. A reason is recorded in the audit trail.' : 'This hides the opportunity temporarily. A reason is recorded in the audit trail.'}
          confirmLabel={reasonAction.kind === 'dismiss' ? 'Dismiss' : 'Snooze'} tone={reasonAction.kind === 'dismiss' ? 'red' : 'amber'} requireReason
          onClose={() => setReasonAction(null)}
          onConfirm={async () => { const updated = await opportunityService.setStatus(opportunity.id, reasonAction.kind === 'dismiss' ? 'dismissed' : 'snoozed'); onChanged(updated); }}
        />
      )}
    </div>
  );
}

function SmallBtn({ icon: Icon, label, onClick }: { icon: typeof Clock3; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex flex-col items-center gap-1 rounded-lg border border-[var(--b1)] py-2 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] transition">
      <Icon className="w-4 h-4" /> {label}
    </button>
  );
}
