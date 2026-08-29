import { useEffect } from 'react';
import { X, TrendingUp, TrendingDown, Sparkles, Clock, Radio } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import type { CrmLead, ScoreBand } from '../../lib/crmService';

// Tone follows the band the SERVER assigned from the tenant's configured
// `scoreBandHigh` / `scoreBandMid`. It used to be `score >= 70 ... >= 40` here,
// so the colour and the threshold could disagree with each other.
const BAND_TONE: Record<ScoreBand, string> = {
  high: 'text-emerald-v', medium: 'text-amber-v', low: 'text-red-v', unscored: 'text-t3',
};

export default function LeadScoreExplanationDrawer({ lead, onClose }: { lead: CrmLead; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const positives = lead.scoreDrivers.filter(d => d.positive);
  const negatives = lead.scoreDrivers.filter(d => !d.positive);
  const tone = BAND_TONE[lead.scoreBand];

  return (
    <div className="fixed inset-0 z-[55] flex justify-end" role="dialog" aria-modal="true" aria-label="Lead score explanation">
      <button type="button" aria-label="Close" title="Close" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-sm glass-surface h-full overflow-y-auto animate-fade-up">
        <header className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-[var(--b1)] glass-surface-head">
          <div className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-violet-v" /><h2 className="text-sm font-bold text-t1">Why this score?</h2></div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-t3 hover:text-t1"><X className="w-5 h-5" /></button>
        </header>
        <div className="p-5 space-y-4">
          <div className="text-center rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4">
            <p className={`text-3xl font-bold tabular-nums ${tone}`}>{lead.score ?? '—'}</p>
            <p className="text-[11px] text-t2">Rule-based priority · not AI, and not validated against outcomes</p>
            <p className="text-[12px] font-semibold text-t1 mt-1">{lead.name}</p>
          </div>

          {lead.scoreUnavailableReason && (
            <div role="note" className="rounded-xl border border-amber-soft bg-amber-soft p-3">
              <p className="text-[12px] font-semibold text-amber-v">{lead.scoreUnavailableReason}</p>
            </div>
          )}

          <Section title="Positive drivers" icon={<TrendingUp className="w-3.5 h-3.5 text-emerald-v" />}>
            {positives.length ? positives.map((d, i) => <DriverRow key={i} label={d.label} weight={d.weight} positive />) : <p className="text-[12px] text-t2">Nothing in this lead is pushing the score up yet.</p>}
          </Section>
          <Section title="Negative drivers" icon={<TrendingDown className="w-3.5 h-3.5 text-red-v" />}>
            {negatives.length ? negatives.map((d, i) => <DriverRow key={i} label={d.label} weight={d.weight} positive={false} />) : <p className="text-[12px] text-t2">Nothing in this lead is pulling the score down.</p>}
          </Section>

          <div className="rounded-xl border border-[var(--indigo-mid)] bg-[var(--indigo-soft)] p-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-indigo mb-1">Suggested next step · rule-based</p>
            <p className="text-[13px] font-semibold text-t1">
              {lead.nextBestAction?.label ?? 'No suggestion: this lead\u2019s recorded stage is not one the ranking rules cover.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Fact label="Recorded estimated value" value={formatCurrency(lead.estimatedValue)} />
            <Fact label="Last activity" value={`${lead.ageDays}d ago`} />
            <Fact label="Recorded lead channel" value={lead.bestChannel} icon={<Radio className="w-3 h-3" />} />
            <Fact label="Suggested review time" value={lead.bestTime} icon={<Clock className="w-3 h-3" />} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-t3 mb-1.5">{icon} {title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
function DriverRow({ label, weight, positive }: { label: string; weight: number; positive: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--b1)] px-3 py-1.5">
      <span className="text-[12px] text-t2">{label}</span>
      <span className={`text-[11px] font-bold tabular-nums ${positive ? 'text-emerald-v' : 'text-red-v'}`}>{positive ? '+' : ''}{weight}</span>
    </div>
  );
}
function Fact({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-t3 flex items-center gap-1">{icon}{label}</p>
      <p className="text-[12px] font-semibold text-t1 mt-0.5">{value}</p>
    </div>
  );
}
