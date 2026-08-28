import { ChevronRight, Building2, User } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import ConfidenceBadge from '../workflow/ConfidenceBadge';
import ApprovalStatusBadge from '../workflow/ApprovalStatusBadge';
import EmptyStatePremium from '../ui/EmptyStatePremium';
import { Sparkles } from 'lucide-react';
import type { Opportunity } from '../../lib/opportunityService';

const URGENCY: Record<string, string> = { high: 'badge-red', medium: 'badge-amber', low: 'badge-blue' };

export function OpportunityRankingCard({ opportunity, rank, selected, onOpen }: { opportunity: Opportunity; rank: number; selected: boolean; onOpen: (o: Opportunity) => void }) {
  const o = opportunity;
  return (
    <button
      type="button" onClick={() => onOpen(o)} aria-pressed={selected ? 'true' : 'false'}
      className={`hover-lift w-full text-left rounded-xl border p-3.5 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--indigo)] focus-visible:outline-offset-2 ${
        selected ? 'border-[var(--indigo)] bg-[var(--indigo-soft)] ring-1 ring-[var(--indigo-mid)]' : 'border-[var(--b1)] bg-[var(--s1)] hover:border-[var(--b2)]'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="grid place-items-center w-7 h-7 rounded-lg bg-[var(--s3)] text-[12px] font-bold text-t2 shrink-0 tabular-nums">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[13px] font-bold text-t1 leading-tight">{o.title}</p>
            <span className="text-sm font-bold text-emerald-v shrink-0 tabular-nums">{formatCurrency(o.expectedRevenue)}</span>
          </div>
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1.5 text-[10px] text-t3">
            <span className="inline-flex items-center gap-1"><Building2 className="w-3 h-3" aria-hidden="true" />{o.branch || '—'}</span>
            <span className="inline-flex items-center gap-1"><User className="w-3 h-3" aria-hidden="true" />{o.owner}</span>
            <span>· {o.department}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-2">
            <ConfidenceBadge value={o.confidence} size="xs" />
            <span className={`badge ${URGENCY[o.urgency]}`}>{o.urgency} urgency</span>
            <ApprovalStatusBadge state={o.approval} />
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-t3 shrink-0 self-center" aria-hidden="true" />
      </div>
    </button>
  );
}

export default function OpportunityRankingPanel({ opportunities, loading, selectedId, onOpen, onCreate }: {
  opportunities: Opportunity[]; loading?: boolean; selectedId: string | null;
  onOpen: (o: Opportunity) => void; onCreate: () => void;
}) {
  if (loading) return <div className="space-y-2.5">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton-line h-24 rounded-xl" />)}</div>;
  if (opportunities.length === 0) {
    return <EmptyStatePremium icon={<Sparkles className="w-5 h-5" />} title="No ranked opportunities"
      description="When CareCommand detects recoverable revenue, ranked recovery actions appear here." cta={{ label: 'Launch a campaign', onClick: onCreate }} />;
  }
  return (
    <div className="space-y-2.5">
      {opportunities.map((o, i) => <OpportunityRankingCard key={o.id} opportunity={o} rank={i + 1} selected={selectedId === o.id} onOpen={onOpen} />)}
    </div>
  );
}
