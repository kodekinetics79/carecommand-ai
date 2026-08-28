import { Users, Megaphone, Radio } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import type { SmartSegment } from '../../lib/crmService';

export default function SmartSegmentCard({ segment, onCreateCampaign }: { segment: SmartSegment; onCreateCampaign: (s: SmartSegment) => void }) {
  const s = segment;
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
        <Stat label="Planning value (30%)" value={formatCurrency(s.recoverableValue)} accent />
        <Stat label="Assumed booking rate" value={`${s.planningBookingRate}%`} />
        <Stat label="Suggested channel" value={s.planningChannel} icon={<Radio className="w-3 h-3" />} />
        <Stat label="Assumed cost" value={s.planningCost === 0 ? '$0 assumed' : formatCurrency(s.planningCost)} />
      </div>

      <div className="mt-3 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2">
        <p className="text-[10px] uppercase tracking-wide text-t3">Planning idea</p>
        <p className="text-[12px] font-semibold text-t1">{s.planningOffer}</p>
        <p className="text-[10px] text-amber-v mt-1">{s.assumptionNotice}</p>
      </div>

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

function Stat({ label, value, accent, icon }: { label: string; value: string; accent?: boolean; icon?: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-t3 flex items-center gap-1">{icon}{label}</p>
      <p className={`text-[12px] font-bold ${accent ? 'text-emerald-v' : 'text-t1'}`}>{value}</p>
    </div>
  );
}
