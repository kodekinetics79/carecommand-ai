import { ArrowRight, Megaphone, Sparkles } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import type { CampaignROI } from '../../lib/dashboardService';
import EmptyStatePremium from '../ui/EmptyStatePremium';

const STATUS_BADGE: Record<string, string> = {
  active: 'badge-emerald', running: 'badge-emerald', completed: 'badge-blue',
  draft: 'badge-amber', scheduled: 'badge-violet', approval_required: 'badge-amber', paused: 'badge-blue',
};

export default function CampaignROIPanel({ campaigns, onViewAll, onCreate }: { campaigns: CampaignROI[]; onViewAll: () => void; onCreate: () => void }) {
  if (campaigns.length === 0) {
    return (
      <EmptyStatePremium
        icon={<Megaphone className="w-5 h-5" />}
        title="No campaigns yet"
        description="Launch a reactivation or recall campaign to start recovering revenue from inactive patients."
        cta={{ label: 'Create your first campaign', onClick: onCreate }}
      />
    );
  }
  return (
    <div className="space-y-2.5">
      {campaigns.map(c => {
        const launched = c.audienceSize > 0 || c.revenue > 0;
        return (
          <div key={c.id} className="hover-lift rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-[13px] font-semibold text-t1 truncate">{c.name}</p>
                <span className={`badge ${STATUS_BADGE[c.status] ?? 'badge-blue'} shrink-0`}>{c.status.replace(/_/g, ' ')}</span>
              </div>
              {launched
                ? <p className="text-sm font-bold text-t1 shrink-0 tabular-nums">{formatCurrency(c.revenue)}</p>
                : <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-v shrink-0"><Sparkles className="w-3 h-3" /> {c.nextAction}</span>}
            </div>

            {launched ? (
              <div className="flex items-center gap-3 text-[11px] text-t3 mt-1.5">
                <span>{c.audienceSize} patients</span>
                <span>·</span>
                <span className="text-emerald-v font-semibold">{c.conversionRate}% booked</span>
                <span>·</span>
                <span>{c.booked} appointments</span>
              </div>
            ) : (
              <div className="flex items-center gap-4 text-[11px] mt-2">
                <Stat label="Est. audience" value={c.estimatedAudience != null ? `${c.estimatedAudience} patients` : '—'} />
                <Stat label="Est. recoverable" value={c.estimatedRecoverable != null ? formatCurrency(c.estimatedRecoverable) : '—'} accent />
              </div>
            )}
          </div>
        );
      })}
      <button type="button" onClick={onViewAll} className="w-full inline-flex items-center justify-center gap-1 text-[12px] font-semibold text-indigo py-2 hover:opacity-80 transition">
        View all campaigns <ArrowRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-t3">{label}</p>
      <p className={`text-[12px] font-bold ${accent ? 'text-emerald-v' : 'text-t1'}`}>{value}</p>
    </div>
  );
}
