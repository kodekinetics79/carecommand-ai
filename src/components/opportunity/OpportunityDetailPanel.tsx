import { Cpu, ShieldAlert, Users, Coins } from 'lucide-react';
import { formatCurrency } from '../../utils/formatters';
import ConfidenceBadge from '../workflow/ConfidenceBadge';
import ApprovalStatusBadge from '../workflow/ApprovalStatusBadge';
import UrgencyEffortMatrix from '../workflow/UrgencyEffortMatrix';
import type { Opportunity, Band } from '../../lib/opportunityService';

const bandCls = (b: Band) => b === 'high' ? 'text-red-v' : b === 'medium' ? 'text-amber-v' : 'text-emerald-v';
const bandLabel = (b: Band) => b.charAt(0).toUpperCase() + b.slice(1);

export default function OpportunityDetailPanel({ opportunity }: { opportunity: Opportunity }) {
  const o = opportunity;
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-t2 leading-relaxed">{o.recommendedAction || o.trigger}</p>

      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Expected revenue" value={formatCurrency(o.expectedRevenue)} strong />
        <Field label="ROI" value={`${o.roi}×`} />
        <FieldNode label="Confidence"><ConfidenceBadge value={o.confidence} size="xs" /></FieldNode>
        <FieldNode label="Approval"><ApprovalStatusBadge state={o.approval} /></FieldNode>
        <Field label="Owner" value={o.owner} />
        <Field label="Department" value={o.department} />
        <Field label="Due date" value={o.dueDate ? new Date(o.dueDate).toLocaleDateString() : '—'} />
        <Field label="SLA" value={o.slaHours != null ? `${o.slaHours}h` : '—'} />
      </div>

      <UrgencyEffortMatrix urgency={o.urgency} effort={o.effort} />

      <div className="grid grid-cols-2 gap-2.5">
        <Signal icon={<Coins className="w-3.5 h-3.5" />} label="Cost to execute" value={bandLabel(o.costToExecute)} cls={o.costToExecute === 'low' ? 'text-emerald-v' : bandCls(o.costToExecute)} />
        <Signal icon={<Users className="w-3.5 h-3.5" />} label="Patient impact" value={bandLabel(o.patientImpact)} cls={o.patientImpact === 'high' ? 'text-emerald-v' : 'text-t1'} />
        <Signal icon={<ShieldAlert className="w-3.5 h-3.5" />} label="Compliance risk" value={bandLabel(o.complianceRisk)} cls={bandCls(o.complianceRisk)} />
        <Signal icon={<Cpu className="w-3.5 h-3.5" />} label="Automation" value={o.automationEligible ? 'Eligible' : 'Manual'} cls={o.automationEligible ? 'text-emerald-v' : 'text-t2'} />
      </div>

      {o.steps.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-t3 mb-1.5">Execution path</p>
          <ol className="flex flex-wrap items-center gap-1.5">
            {o.steps.map((s, i) => (
              <li key={i} className="inline-flex items-center gap-1.5">
                <span className="rounded-md bg-[var(--s3)] px-2 py-1 text-[11px] font-medium text-t2 capitalize">{s}</span>
                {i < o.steps.length - 1 && <span className="text-t3">→</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-t3">{label}</p>
      <p className={`${strong ? 'text-sm font-bold text-emerald-v' : 'text-[13px] font-semibold text-t1'} truncate`}>{value}</p>
    </div>
  );
}
function FieldNode({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-t3 mb-1">{label}</p>
      {children}
    </div>
  );
}
function Signal({ icon, label, value, cls }: { icon: React.ReactNode; label: string; value: string; cls: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--b1)] px-3 py-2">
      <span className="text-t3">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-t3">{label}</p>
        <p className={`text-[12px] font-bold ${cls}`}>{value}</p>
      </div>
    </div>
  );
}
