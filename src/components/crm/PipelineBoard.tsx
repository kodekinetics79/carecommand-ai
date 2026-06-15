import { HelpCircle, Phone, Send, FileText, CheckCircle2, RotateCcw, Trophy, Ban, Clock } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import ConsentBadgeGroup from './ConsentBadgeGroup';
import { STAGES, STAGE_LABEL, type CrmLead, type Stage, type CtaId } from '../../lib/crmService';

const CTA_ICON: Record<CtaId, typeof Phone> = {
  call_now: Phone, send_booking_link: Send, send_deposit_link: Send, send_intake_form: FileText,
  confirm_visit: CheckCircle2, send_follow_up: Send, launch_winback: RotateCcw, recover_lost: RotateCcw,
  mark_retained: Trophy, mark_lost: Ban,
};
const STAGE_DOT: Record<Stage, string> = {
  'new-inquiry': 'bg-blue-500', contacted: 'bg-cyan-500', booked: 'bg-violet-500', visited: 'bg-emerald-500',
  'follow-up': 'bg-amber-500', retained: 'bg-emerald-600', lost: 'bg-red-500',
};

function scoreTone(s: number) { return s >= 70 ? 'text-emerald-v bg-emerald-soft' : s >= 40 ? 'text-amber-v bg-amber-soft' : 'text-red-v bg-red-soft'; }
function riskBadge(lead: CrmLead): { label: string; cls: string } | null {
  if (lead.stage === 'lost') return { label: 'Lost', cls: 'badge-red' };
  if (lead.score < 40) return { label: 'At risk', cls: 'badge-red' };
  if (lead.ageDays > 14 && ['new-inquiry', 'contacted'].includes(lead.stage)) return { label: 'Going cold', cls: 'badge-amber' };
  return null;
}

export interface PipelineHandlers {
  onOpenProfile: (l: CrmLead) => void;
  onWhyScore: (l: CrmLead) => void;
  onAction: (l: CrmLead, cta: CtaId) => void;
}

export function PipelineLeadCard({ lead, ...h }: { lead: CrmLead } & PipelineHandlers) {
  const risk = riskBadge(lead);
  const CtaIcon = CTA_ICON[lead.nextBestAction.cta];
  return (
    <div className="hover-lift rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={() => h.onOpenProfile(lead)} className="text-left min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-[var(--indigo)] rounded">
          <p className="text-[13px] font-bold text-t1 leading-tight truncate">{lead.name}</p>
          <p className="text-[11px] text-t3 truncate">{lead.service || '—'}</p>
        </button>
        <button type="button" onClick={() => h.onWhyScore(lead)} title="Why this score?" aria-label={`Why score ${lead.score}? Open explanation`}
          className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-bold shrink-0 ${scoreTone(lead.score)}`}>
          {lead.score}<HelpCircle className="w-2.5 h-2.5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap mt-1.5 text-[10px] text-t3">
        <span className="font-bold text-emerald-v">{formatCurrency(lead.estimatedValue)}</span>
        <span>· {lead.source}</span>
        <span className="inline-flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" aria-hidden="true" />{lead.ageDays}d</span>
        <span>· {lead.owner}</span>
      </div>

      <div className="flex items-center justify-between gap-2 mt-2">
        <ConsentBadgeGroup consent={lead.consent} compact />
        {risk && <span className={`badge ${risk.cls}`}>{risk.label}</span>}
      </div>

      <div className="mt-2.5 flex items-center gap-1.5">
        <button type="button" onClick={() => h.onAction(lead, lead.nextBestAction.cta)}
          className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--indigo)] px-2 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 transition">
          <CtaIcon className="w-3 h-3" aria-hidden="true" /> {lead.nextBestAction.label.length > 22 ? lead.nextBestAction.label.slice(0, 20) + '…' : lead.nextBestAction.label}
        </button>
        {lead.stage !== 'retained' && lead.stage !== 'lost' && (
          <button type="button" onClick={() => h.onAction(lead, 'mark_lost')} title="Mark lost (reason required)" aria-label="Mark lost"
            className="inline-flex items-center justify-center rounded-lg border border-[var(--b1)] w-7 h-7 text-t3 hover:text-red-v hover:border-red-v/30 transition shrink-0">
            <Ban className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function PipelineColumn({ stage, leads, ...h }: { stage: Stage; leads: CrmLead[] } & PipelineHandlers) {
  const value = leads.reduce((s, l) => s + l.estimatedValue, 0);
  return (
    <div className="w-[248px] shrink-0 flex flex-col rounded-xl border border-[var(--b1)] glass-lane">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--b1)] glass-lane-head">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full ${STAGE_DOT[stage]}`} aria-hidden="true" />
          <p className="text-[11px] font-bold uppercase tracking-wide text-t2 truncate">{STAGE_LABEL[stage]}</p>
          <span className="text-[10px] font-bold text-t2 bg-[var(--s4)] rounded-full px-1.5 py-0.5 tabular-nums shrink-0">{leads.length}</span>
        </div>
        <span className="text-[10px] font-semibold text-t3 tabular-nums shrink-0">{formatCurrency(value)}</span>
      </div>
      <div className="p-2 space-y-2 min-h-[64px] flex-1">
        {leads.length === 0 ? <div className="rounded-lg border border-dashed border-[var(--b2)] py-6 text-center text-[11px] text-t3">No leads</div>
          : [...leads].sort((a, b) => b.score - a.score).map(l => <PipelineLeadCard key={l.id} lead={l} {...h} />)}
      </div>
    </div>
  );
}

export default function PipelineBoard({ leads, loading, ...h }: { leads: CrmLead[]; loading?: boolean } & PipelineHandlers) {
  if (loading) return <div className="flex gap-3 overflow-x-auto pb-2">{STAGES.map(s => <div key={s} className="w-[248px] shrink-0 rounded-xl border border-[var(--b1)] glass-lane p-2 space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="skeleton-line h-28 rounded-lg" />)}</div>)}</div>;
  const byStage = (s: Stage) => leads.filter(l => l.stage === s);
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {STAGES.map(s => <PipelineColumn key={s} stage={s} leads={byStage(s)} {...h} />)}
    </div>
  );
}
