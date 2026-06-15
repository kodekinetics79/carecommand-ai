import { CheckCircle2, Clock3, Minus } from 'lucide-react';
import type { ApprovalState } from '../../lib/opportunityService';

// Amber = needs approval/warning; green = approved/success; gray = n/a.
const MAP: Record<ApprovalState, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  approved: { label: 'Approved', cls: 'badge-emerald', icon: CheckCircle2 },
  pending_approval: { label: 'Needs approval', cls: 'badge-amber', icon: Clock3 },
  not_required: { label: 'No approval needed', cls: 'badge-blue', icon: Minus },
};

export default function ApprovalStatusBadge({ state }: { state: ApprovalState }) {
  const m = MAP[state];
  const Icon = m.icon;
  return <span className={`badge ${m.cls}`}><Icon className="w-3 h-3" aria-hidden="true" /> {m.label}</span>;
}
