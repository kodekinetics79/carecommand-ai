import { Users, Megaphone, Radio, EyeOff } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import type { SmartSegment } from '../../lib/crmService';

/**
 * A candidate group counted across the whole tenant in SQL, not filtered in the
 * browser over a hundred loaded rows.
 *
 * Two things the card now says out loud:
 *   * The planning cost is real money in a real currency. It used to be a count
 *     multiplied by a bare 0/1/3 and pushed through `formatCurrency`, so a
 *     40-patient Voice group displayed "$120" for every tenant on earth.
 *   * A patient with no recorded last visit is excluded from an inactivity
 *     window on purpose, by the `includeNeverVisited` setting — not by a 9999-day
 *     sentinel that silently failed every upper bound.
 */
export default function SmartSegmentCard({
  segment, recoverablePercent, onCreateCampaign,
}: { segment: SmartSegment; recoverablePercent: number; onCreateCampaign: (s: SmartSegment) => void }) {
  const s = segment;
  const excluded = !s.criteria.includeNeverVisited
    && (s.criteria.minInactiveDays !== null || s.criteria.maxInactiveDays !== null)
    && s.neverVisitedCandidates > 0;

  return (
    <div className="hover-lift rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-t1 leading-tight">{s.label}</p>
          <p className="text-[11px] text-t3 mt-0.5">{s.description}</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-lg bg-[var(--s3)] px-2 py-1 text-[12px] font-bold text-t1 shrink-0">
          <Users className="w-3.5 h-3.5 text-t3" aria-hidden="true" />{s.patientCount}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3">
        <Stat label={`Planning value (${recoverablePercent}%)`} value={formatCurrency(s.recoverableValue)} accent />
        <Stat label="Assumed booking rate" value={`${s.planningBookingRatePct}%`} />
        <Stat label="Suggested channel" value={s.planningChannel} icon={<Radio className="w-3 h-3" />} />
        <Stat
          label="Assumed cost"
          value={s.plannedCostMinor === null ? 'Not configured' : formatMinor(s.plannedCostMinor, s.currency)}
          muted={s.plannedCostMinor === null}
        />
      </div>
      {s.costUnavailableReason && <p className="text-[10px] text-t3 mt-1">{s.costUnavailableReason}</p>}

      <div className="mt-3 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2">
        <p className="text-[10px] uppercase tracking-wide text-t3">Planning idea</p>
        <p className="text-[12px] font-semibold text-t1">{s.planningOffer}</p>
        <p className="text-[10px] text-amber-v mt-1">{s.assumptionNotice}</p>
      </div>

      {excluded && (
        <p className="mt-2 inline-flex items-start gap-1.5 text-[10px] text-t3">
          <EyeOff className="w-3 h-3 mt-px shrink-0" aria-hidden="true" />
          Excludes {s.neverVisitedCandidates} patient{s.neverVisitedCandidates === 1 ? '' : 's'} with no recorded last visit.
          Turn on “include never visited” for this group to count them.
        </p>
      )}

      <div className="flex items-center justify-between gap-2 mt-3">
        <span className="text-[10px] font-semibold text-amber-v">Contact, suppression, and purpose-specific authority are checked in the governed campaign workflow</span>
        <button type="button" onClick={() => onCreateCampaign(s)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 transition">
          <Megaphone className="w-3.5 h-3.5" aria-hidden="true" /> Create campaign
        </button>
      </div>
    </div>
  );
}

/** Integer minor units in the currency the tenant configured — never a bare count. */
function formatMinor(minor: number, currency: string | null): string {
  const major = minor / 100;
  if (!currency) return formatCurrency(major);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(major);
}

function Stat({ label, value, accent, muted, icon }: { label: string; value: string; accent?: boolean; muted?: boolean; icon?: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-t3 flex items-center gap-1">{icon}{label}</p>
      <p className={`text-[12px] font-bold ${muted ? 'text-t3' : accent ? 'text-emerald-v' : 'text-t1'}`}>{value}</p>
    </div>
  );
}
