import { HelpCircle, Phone, Send, FileText, CheckCircle2, RotateCcw, Trophy, Ban, Clock, AlertTriangle } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import ConsentBadgeGroup from './ConsentBadgeGroup';
import { STAGES, STAGE_LABEL, type CrmLead, type CrmPipeline, type Stage, type CtaId, type ScoreBand } from '../../lib/crmService';

const CTA_ICON: Record<CtaId, typeof Phone> = {
  call_now: Phone, send_booking_link: Send, send_deposit_link: Send, send_intake_form: FileText,
  confirm_visit: CheckCircle2, send_follow_up: Send, launch_winback: RotateCcw, recover_lost: RotateCcw,
  mark_retained: Trophy, mark_lost: Ban,
};
const STAGE_DOT: Record<Stage, string> = {
  'new-inquiry': 'bg-blue-500', contacted: 'bg-cyan-500', booked: 'bg-violet-500', visited: 'bg-emerald-500',
  'follow-up': 'bg-amber-500', retained: 'bg-emerald-600', lost: 'bg-red-500',
};

// Tone and risk read the band the SERVER assigned from GrowthPolicy. They used
// to be `score >= 70` and `score < 40` written into this component, which meant a
// tenant that retuned its thresholds retuned nothing a user could see.
const BAND_TONE: Record<ScoreBand, string> = {
  high: 'text-emerald-v bg-emerald-soft',
  medium: 'text-amber-v bg-amber-soft',
  low: 'text-red-v bg-red-soft',
  unscored: 'text-t3 bg-[var(--s3)]',
};

function riskBadge(lead: CrmLead): { label: string; cls: string } | null {
  if (lead.knownStage === 'lost') return { label: 'Lost', cls: 'badge-red' };
  if (lead.scoreBand === 'unscored') return { label: 'Unscored', cls: 'badge-amber' };
  if (lead.scoreBand === 'low') return { label: 'At risk', cls: 'badge-red' };
  if (lead.goingCold) return { label: 'Going cold', cls: 'badge-amber' };
  return null;
}

export interface PipelineHandlers {
  onOpenProfile: (l: CrmLead) => void;
  onWhyScore: (l: CrmLead) => void;
  onAction: (l: CrmLead, cta: CtaId) => void;
}

export function PipelineLeadCard({ lead, canAct = true, ...h }: { lead: CrmLead; canAct?: boolean } & PipelineHandlers) {
  const risk = riskBadge(lead);
  const action = lead.nextBestAction;
  const CtaIcon = action ? CTA_ICON[action.cta] : null;
  return (
    <div className="hover-lift rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={() => h.onOpenProfile(lead)} className="text-left min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-[var(--indigo)] rounded">
          <p className="text-[13px] font-bold text-t1 leading-tight truncate">{lead.name}</p>
          <p className="text-[11px] text-t3 truncate">{lead.service || '—'}</p>
        </button>
        <button type="button" onClick={() => h.onWhyScore(lead)} title={lead.score === null ? 'Why is there no score?' : 'Why this score?'}
          aria-label={lead.score === null ? `${lead.name} has no planning priority. Open explanation` : `Why score ${lead.score}? Open explanation`}
          className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-bold shrink-0 ${BAND_TONE[lead.scoreBand]}`}>
          {lead.score ?? '—'}<HelpCircle className="w-2.5 h-2.5" aria-hidden="true" />
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
        {canAct && action && CtaIcon ? (
          <button type="button" onClick={() => h.onAction(lead, action.cta)}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--indigo)] px-2 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 transition">
            <CtaIcon className="w-3 h-3" aria-hidden="true" /> {action.label.length > 22 ? action.label.slice(0, 20) + '…' : action.label}
          </button>
        ) : (
          // No suggested action rather than an invented one: the recorded stage
          // is not one the heuristic knows, so it has nothing to suggest.
          <span className="flex-1 rounded-lg border border-dashed border-[var(--b2)] px-2 py-1.5 text-center text-[11px] text-t3">No suggested action</span>
        )}
        {canAct && lead.knownStage !== 'retained' && lead.knownStage !== 'lost' && (
          <button type="button" onClick={() => h.onAction(lead, 'mark_lost')} title="Mark lost (reason required)" aria-label="Mark lost"
            className="inline-flex items-center justify-center rounded-lg border border-[var(--b1)] w-7 h-7 text-t3 hover:text-red-v hover:border-red-v/30 transition shrink-0">
            <Ban className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function PipelineColumn({ stage, label, dot, leads, total, ...h }: {
  stage: string; label: string; dot: string; leads: CrmLead[];
  total: { count: number; value: number };
  canAct?: boolean;
} & PipelineHandlers) {
  // The header reports the tenant-wide count and value the server computed. It
  // used to sum whichever leads happened to be in memory, so a lane's headline
  // value was a property of the page size.
  const hidden = total.count - leads.length;
  return (
    <div className="w-[248px] shrink-0 flex flex-col rounded-xl border border-[var(--b1)] glass-lane">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--b1)] glass-lane-head">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
          <p className="text-[11px] font-bold uppercase tracking-wide text-t2 truncate" title={label}>{label}</p>
          <span className="text-[10px] font-bold text-t2 bg-[var(--s4)] rounded-full px-1.5 py-0.5 tabular-nums shrink-0">{total.count}</span>
        </div>
        <span className="text-[10px] font-semibold text-t3 tabular-nums shrink-0">{formatCurrency(total.value)}</span>
      </div>
      <div className="p-2 space-y-2 min-h-[64px] flex-1">
        {leads.length === 0
          ? <div className="rounded-lg border border-dashed border-[var(--b2)] py-6 text-center text-[11px] text-t3">{total.count === 0 ? 'None in this stage' : `${total.count} in this stage, none loaded`}</div>
          : [...leads].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).map(l => <PipelineLeadCard key={l.id} lead={l} {...h} />)}
        {hidden > 0 && leads.length > 0 && (
          <p className="text-center text-[10px] text-t3" data-stage={stage}>{hidden} more in this stage not loaded</p>
        )}
      </div>
    </div>
  );
}

export default function PipelineBoard({ pipeline, loading, canAct = true, ...h }: { pipeline: CrmPipeline | null; loading?: boolean; canAct?: boolean } & PipelineHandlers) {
  if (loading || !pipeline) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGES.map(s => <div key={s} className="w-[248px] shrink-0 rounded-xl border border-[var(--b1)] glass-lane p-2 space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="skeleton-line h-28 rounded-lg" />)}</div>)}
      </div>
    );
  }

  const totalFor = (stage: string) => pipeline.stageTotals.find(t => t.stage === stage) ?? { count: 0, value: 0 };
  // Stages the heuristic does not know still exist in the data, so the board
  // shows them rather than dropping their leads off the screen entirely.
  const unknownStages = pipeline.stageTotals.filter(t => !t.known);

  return (
    <div className="space-y-2">
      {pipeline.truncated && (
        <p role="status" className="inline-flex items-start gap-1.5 rounded-lg border border-amber-soft bg-amber-soft px-3 py-2 text-[11px] font-semibold text-amber-v">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
          Showing {pipeline.returned.toLocaleString()} of {pipeline.total.toLocaleString()} leads. Lane counts and values below cover every lead; the cards do not.
        </p>
      )}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGES.map(s => (
          <PipelineColumn key={s} stage={s} label={STAGE_LABEL[s]} dot={STAGE_DOT[s]}
            leads={pipeline.leads.filter(l => l.knownStage === s)} total={totalFor(s)} canAct={canAct} {...h} />
        ))}
        {unknownStages.map(t => (
          <PipelineColumn key={t.stage} stage={t.stage} label={t.stage} dot="bg-slate-400"
            leads={pipeline.leads.filter(l => l.knownStage === null && l.stage === t.stage)}
            total={t} canAct={canAct} {...h} />
        ))}
      </div>
      {unknownStages.length > 0 && (
        <p className="text-[12px] leading-relaxed text-t2">
          {unknownStages.length === 1 ? 'One stage is' : `${unknownStages.length} stages are`} not part of the standard pipeline
          ({unknownStages.map(t => t.stage).join(', ')}). Their leads are shown here, but cannot be scored or given a suggested
          action until the recorded stage is one of the seven standard ones.
        </p>
      )}
    </div>
  );
}
