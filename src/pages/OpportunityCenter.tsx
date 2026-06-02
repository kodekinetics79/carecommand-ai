import { ArrowRight, AlertTriangle, BarChart3, Bolt, CheckCircle2, CircleDollarSign, ListTodo, Sparkles, Target, TrendingUp } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { formatCurrency } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { mapOpportunity, mapRevenueLeak, type ApiOpportunity, type ApiRevenueLeak } from '../lib/apiAdapters';
import type { Opportunity, RevenueLeak } from '../types';

const leakPreview: RevenueLeak[] = [
  {
    id: 'demo-leak-1',
    branchId: 'b2',
    branchName: 'Westside Family Clinic',
    category: 'unfilled-slots',
    source: 'Schedule capacity analysis',
    evidence: '31 empty slots detected on the Westside schedule',
    estimatedValue: 6200,
    confidence: 87,
    status: 'open',
    workflowStatus: 'queued',
    suggestedAction: 'Run a weekday fill campaign with SMS follow-up.',
    ownerName: 'Front Desk',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'demo-leak-2',
    branchId: 'b1',
    branchName: 'Downtown Medical Centre',
    category: 'missed-calls',
    source: 'Missed call queue',
    evidence: '23 inbound calls missed before follow-up',
    estimatedValue: 3450,
    confidence: 91,
    status: 'open',
    workflowStatus: 'needs-action',
    suggestedAction: 'Launch a 5-minute callback playbook and assign the front desk.',
    ownerName: 'Owner',
    createdAt: new Date().toISOString(),
  },
];

const opportunityPreview: Opportunity[] = [
  {
    id: 'demo-opp-1',
    branchId: 'b2',
    branchName: 'Westside Family Clinic',
    title: 'Fill weekday gaps',
    source: 'Schedule capacity analysis',
    category: 'slot-fill',
    trigger: '31 open slots on Westside',
    automationSteps: ['detect gaps', 'send short-notice offer', 'assign callback task'],
    expectedRevenue: 6200,
    actualRevenue: 0,
    roi: 5.7,
    confidence: 89,
    effortLevel: 'low',
    urgency: 'high',
    status: 'ready',
    ownerApprovalRequired: true,
    recommendedAction: 'Launch a limited-time promotion and open same-day booking.',
    ownerName: 'Owner',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'demo-opp-2',
    branchId: 'b1',
    branchName: 'Downtown Medical Centre',
    title: 'Win back inactive patients',
    source: 'Customer reactivation model',
    category: 'reactivation',
    trigger: '90-day inactivity cohort',
    automationSteps: ['segment cohort', 'verify consent', 'send multi-step winback'],
    expectedRevenue: 18700,
    actualRevenue: 0,
    roi: 8.4,
    confidence: 86,
    effortLevel: 'medium',
    urgency: 'high',
    status: 'ready',
    ownerApprovalRequired: true,
    recommendedAction: 'Approve the inactive-patient campaign and dispatch recovery messaging.',
    ownerName: 'Owner',
    createdAt: new Date().toISOString(),
  },
];

function scoreClass(confidence: number) {
  if (confidence >= 85) return 'text-emerald-v bg-[var(--emerald-soft)]';
  if (confidence >= 70) return 'text-amber-v bg-[var(--amber-soft)]';
  return 'text-red-v bg-[var(--red-soft)]';
}

export default function OpportunityCenter() {
  const { data: revenueLeaks, source: leakSource } = useApiResource<ApiRevenueLeak, RevenueLeak>(
    '/v1/revenue-leaks?limit=20',
    leakPreview,
    mapRevenueLeak,
  );
  const { data: opportunities, source: opportunitySource } = useApiResource<ApiOpportunity, Opportunity>(
    '/v1/opportunities?limit=20',
    opportunityPreview,
    mapOpportunity,
  );

  const recoverableValue = revenueLeaks.reduce((sum, leak) => sum + leak.estimatedValue, 0);
  const expectedRevenue = opportunities.reduce((sum, opportunity) => sum + opportunity.expectedRevenue, 0);
  const avgConfidence = Math.round((revenueLeaks.reduce((sum, leak) => sum + leak.confidence, 0) + opportunities.reduce((sum, opportunity) => sum + opportunity.confidence, 0)) / Math.max(revenueLeaks.length + opportunities.length, 1));
  const approvalCount = opportunities.filter(opportunity => opportunity.ownerApprovalRequired).length;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Opportunity Center"
        subtitle="Leak detector, recovery queue, and ranked growth actions for the network."
        badge={opportunitySource === 'live' || leakSource === 'live' ? 'Live DB' : 'Demo'}
        badgeColor={opportunitySource === 'live' || leakSource === 'live' ? 'emerald' : 'blue'}
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Sparkles className="w-4 h-4" /> Run opportunity scan
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard title="Recoverable Value" value={formatCurrency(recoverableValue)} subtitle="Open revenue leaks" icon={<CircleDollarSign className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Open Leaks" value={revenueLeaks.length} subtitle="Needs action" icon={<AlertTriangle className="w-4 h-4" />} accent="red" />
        <StatCard title="Opportunities" value={opportunities.length} subtitle="Ranked actions" icon={<Target className="w-4 h-4" />} accent="violet" />
        <StatCard title="Expected Revenue" value={formatCurrency(expectedRevenue)} subtitle="Pipeline upside" icon={<TrendingUp className="w-4 h-4" />} accent="blue" />
        <StatCard title="Avg Confidence" value={`${avgConfidence}%`} subtitle="Across signals" icon={<BarChart3 className="w-4 h-4" />} accent="amber" />
        <StatCard title="Approval Needed" value={approvalCount} subtitle="Governed actions" icon={<CheckCircle2 className="w-4 h-4" />} accent="cyan" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <BentoCard title="Revenue Leak Detector" subtitle="What happened, why it matters, and what to do next" headerRight={
          <span className="badge badge-red">{formatCurrency(recoverableValue)} at risk</span>
        }>
          <div className="space-y-3">
            {revenueLeaks.map((leak) => (
              <div key={leak.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-bold text-t1">{leak.source}</p>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${scoreClass(leak.confidence)}`}>{leak.confidence}% confidence</span>
                      <span className="badge badge-amber">{leak.workflowStatus}</span>
                    </div>
                    <p className="text-xs text-t3 mt-1">{leak.branchName} · {leak.category}</p>
                    <p className="text-sm text-t2 mt-2 leading-relaxed">{leak.evidence}</p>
                    <p className="text-xs text-t3 mt-2">Owner: {leak.ownerName ?? 'Unassigned'}{leak.patientName ? ` · Patient: ${leak.patientName}` : ''}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-red-v">{formatCurrency(leak.estimatedValue)}</p>
                    <p className="text-[10px] text-t3 uppercase tracking-widest">{leak.status}</p>
                  </div>
                </div>
                <div className="mt-3">
                  <ProgressBar value={leak.confidence} color={leak.confidence >= 85 ? 'emerald' : leak.confidence >= 70 ? 'amber' : 'red'} />
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-t2"><span className="font-semibold text-t1">Suggested action:</span> {leak.suggestedAction}</p>
                  <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 transition">
                    <Bolt className="w-3.5 h-3.5" /> Execute workflow
                  </button>
                </div>
              </div>
            ))}
          </div>
        </BentoCard>

        <BentoCard title="Opportunity Ranking" subtitle="Ranked by value, urgency, and confidence" headerRight={
          <span className="badge badge-violet">Top priority queue</span>
        }>
          <div className="space-y-2.5">
            {opportunities.map((opportunity, index) => {
              const confidenceColor = opportunity.confidence >= 85 ? 'emerald' : opportunity.confidence >= 70 ? 'amber' : 'red';
              return (
                <div key={opportunity.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-bold text-t3 uppercase tracking-widest">#{index + 1}</span>
                        <p className="text-sm font-bold text-t1">{opportunity.title}</p>
                        {opportunity.ownerApprovalRequired && <span className="badge badge-amber">Approval</span>}
                      </div>
                      <p className="text-xs text-t3 mt-1">{opportunity.branchName} · {opportunity.source}</p>
                      <p className="text-xs text-t2 mt-2">Trigger: {opportunity.trigger}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-lg font-bold text-t1">{formatCurrency(opportunity.expectedRevenue)}</p>
                      <p className="text-[10px] text-t3">Expected revenue</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-xs font-bold text-t1">{opportunity.urgency}</p>
                      <p className="text-[10px] text-t3">Urgency</p>
                    </div>
                    <div>
                      <p className="text-xs font-bold text-t1">{opportunity.effortLevel}</p>
                      <p className="text-[10px] text-t3">Effort</p>
                    </div>
                    <div>
                      <p className={`text-xs font-bold ${confidenceColor === 'emerald' ? 'text-emerald-v' : confidenceColor === 'amber' ? 'text-amber-v' : 'text-red-v'}`}>{opportunity.confidence}%</p>
                      <p className="text-[10px] text-t3">Confidence</p>
                    </div>
                  </div>
                  <div className="mt-3">
                    <ProgressBar value={opportunity.confidence} color={confidenceColor as 'emerald' | 'amber' | 'red'} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-t2"><span className="font-semibold text-t1">Recommended action:</span> {opportunity.recommendedAction}</p>
                    <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo-soft)] px-3 py-1.5 text-[11px] font-semibold text-indigo hover:opacity-90 transition">
                      <ListTodo className="w-3.5 h-3.5" /> Approve action
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </BentoCard>
      </div>

      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-5">
        <div className="flex items-start gap-4">
          <div className="w-9 h-9 rounded-xl bg-[var(--indigo-soft)] flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-indigo" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-bold uppercase tracking-widest text-blue-v mb-1">AI Opportunity Brief</p>
            <p className="text-t1 font-semibold leading-relaxed mb-3">
              The highest-value leak is the inactive-patient cohort, followed by unused capacity on Westside.
              Both are high-confidence, low-friction moves and should sit at the top of the owner queue.
              The system is already surfacing approval-required actions separately from auto-executable recovery jobs.
            </p>
            <button type="button" className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo hover:opacity-80 transition-colors">
              Open full opportunity queue <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
