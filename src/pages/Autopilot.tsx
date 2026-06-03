import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, Bot, CheckCircle2, Clock3,
  DollarSign, FileCheck2, Pause, Play, ShieldCheck, Sparkles, Users,
  WandSparkles, Zap,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { apiRequest } from '../lib/api';
import { formatCurrency } from '../utils/formatters';

type ApprovalStatus = 'pending' | 'approved' | 'dismissed';
type ApiApprovalStatus = 'PENDING' | 'APPROVED' | 'DISMISSED' | 'EXECUTED' | 'FAILED';

interface ApiApproval {
  id: string;
  title: string;
  reason: string;
  payload: { scope?: string; value?: string };
  confidence: number;
  status: ApiApprovalStatus;
}

const playbooks = [
  { id: 'slot-fill', name: 'Empty Slot Rescue', trigger: 'Cancellation or under-utilised diary', action: 'Match waitlist, score fit, send consent-safe offer', recovered: formatCurrency(8420), runs: 34, success: 76, status: 'live', icon: CalendarIcon },
  { id: 'missed-call', name: 'Missed Call Recovery', trigger: 'Call unanswered for 90 seconds', action: 'Identify intent, send WhatsApp/SMS, offer booking', recovered: formatCurrency(5880), runs: 51, success: 63, status: 'live', icon: PhoneIcon },
  { id: 'winback', name: 'Customer Winback', trigger: 'High-value customer inactive for 90 days', action: 'Build personal outreach journey with branch offer', recovered: formatCurrency(12900), runs: 187, success: 18, status: 'live', icon: Users },
  { id: 'review', name: 'Reputation Flywheel', trigger: 'Positive post-visit signal detected', action: 'Request review, route detractors to private recovery', recovered: '42 reviews', runs: 96, success: 44, status: 'draft', icon: WandSparkles },
];

const initialApprovals = [
  { id: 'a1', title: 'Activate Westside weekday slot-fill offer', reason: `31 empty slots detected · estimated ${formatCurrency(6200)} at risk`, scope: 'Send to 84 matched customers', value: formatCurrency(6200), confidence: 91, risk: 'Low risk', status: 'pending' as ApprovalStatus },
  { id: 'a2', title: 'Escalate 14 customers for personal follow-up', reason: 'High LTV customers need a human touch after two automated attempts', scope: 'Create tasks for branch coordinators', value: formatCurrency(4800), confidence: 86, risk: 'Human review', status: 'pending' as ApprovalStatus },
  { id: 'a3', title: 'Pause Northgate reminder experiment', reason: 'Opt-out rate increased 1.8% after the second reminder variant', scope: 'Stop variant B and preserve the control', value: 'Protect trust', confidence: 94, risk: 'Recommended', status: 'pending' as ApprovalStatus },
];

const auditTrail = [
  { time: '10:42', event: 'Booked Charlotte Davies into released Downtown slot', actor: 'Empty Slot Rescue', result: `+${formatCurrency(320)}`, type: 'success' },
  { time: '10:36', event: 'Suppressed outreach: marketing consent not present', actor: 'Consent Guardrail', result: 'Blocked', type: 'guardrail' },
  { time: '10:18', event: 'Recovered missed call with WhatsApp booking link', actor: 'Missed Call Recovery', result: `+${formatCurrency(180)}`, type: 'success' },
  { time: '09:54', event: 'Created personal follow-up task for branch coordinator', actor: 'Customer Winback', result: 'Human step', type: 'human' },
  { time: '09:31', event: 'Filled cancellation from priority waitlist match', actor: 'Empty Slot Rescue', result: `+${formatCurrency(480)}`, type: 'success' },
];

function CalendarIcon({ className }: { className?: string }) {
  return <Clock3 className={className} />;
}

function PhoneIcon({ className }: { className?: string }) {
  return <Activity className={className} />;
}

export default function Autopilot() {
  const navigate = useNavigate();
  const [isPaused, setIsPaused] = useState(false);
  const [approvals, setApprovals] = useState(initialApprovals);
  const [selectedPlaybook, setSelectedPlaybook] = useState(playbooks[0].id);

  const pendingApprovals = useMemo(() => approvals.filter(item => item.status === 'pending').length, [approvals]);

  useEffect(() => {
    let active = true;
    apiRequest<ApiApproval[]>('/v1/autopilot/approvals?status=PENDING')
      .then(rows => {
        if (!active || rows.length === 0) return;
        setApprovals(rows.map(row => ({
          id: row.id,
          title: row.title,
          reason: row.reason,
          scope: row.payload.scope ?? 'Governed agent action',
          value: row.payload.value ?? 'Review',
          confidence: row.confidence,
          risk: 'Human review',
          status: row.status.toLowerCase() as ApprovalStatus,
        })));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const updateApproval = async (id: string, status: ApprovalStatus) => {
    if (!id.startsWith('a')) {
      await apiRequest(`/v1/autopilot/approvals/${id}/${status === 'approved' ? 'approve' : 'dismiss'}`, { method: 'POST' });
    }
    setApprovals(current => current.map(item => item.id === id ? { ...item, status } : item));
  };

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="CareFlow Autopilot"
        subtitle="Guarded AI agents that detect, decide, act, and learn across your clinic network."
        badge={isPaused ? 'Paused' : 'Live Autopilot'}
        badgeColor={isPaused ? 'amber' : 'emerald'}
        actions={
          <button
            type="button"
            onClick={() => setIsPaused(current => !current)}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
              isPaused
                ? 'bg-[var(--indigo)] text-white hover:opacity-90'
                : 'border border-[var(--b2)] bg-[var(--s2)] text-t1 hover:bg-[var(--s3)]'
            }`}
          >
            {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            {isPaused ? 'Resume Autopilot' : 'Pause Autopilot'}
          </button>
        }
      />

      <div className="autopilot-hero">
        <div className="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-200" />
              <p className="text-xs font-bold uppercase tracking-widest text-indigo-200">Closed-loop growth engine</p>
            </div>
            <h2 className="max-w-3xl text-xl font-bold leading-snug text-white">
              CareFlow found {formatCurrency(11000)} in recoverable value and safely actioned 68% without adding front-desk work.
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/70">
              Unlike a passive dashboard, Autopilot connects revenue signals, consent rules, scheduling inventory, customer context, and staff escalation into one governed action layer.
            </p>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 backdrop-blur">
            <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-200">Autonomy level</p>
            <p className="mt-1 text-2xl font-bold text-white">Level 2</p>
            <p className="text-xs text-white/65">Low-risk actions automated</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Value Recovered" value={formatCurrency(27200)} subtitle="Autopilot this month" trend={23} icon={<DollarSign className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Agent Actions" value="368" subtitle="Across 4 playbooks" trend={18} icon={<Bot className="w-4 h-4" />} accent="violet" />
        <StatCard title="Human Time Saved" value="42.5h" subtitle="Estimated monthly" trend={31} icon={<Clock3 className="w-4 h-4" />} accent="blue" />
        <StatCard title="Guardrail Blocks" value="17" subtitle="Unsafe actions prevented" icon={<ShieldCheck className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_390px]">
        <div className="space-y-4">
          <BentoCard
            title="Agent Playbooks"
            subtitle="Outcome-driven automations"
            headerRight={<span className="badge badge-emerald"><span className="w-1.5 h-1.5 rounded-full bg-[var(--emerald)]" /> 3 live</span>}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {playbooks.map((playbook) => {
                const Icon = playbook.icon;
                const isSelected = playbook.id === selectedPlaybook;
                return (
                  <button
                    key={playbook.id}
                    type="button"
                    onClick={() => setSelectedPlaybook(playbook.id)}
                    className={`text-left rounded-2xl border p-4 transition-all ${
                      isSelected
                        ? 'border-[var(--indigo)] bg-[var(--indigo-soft)] shadow-sm'
                        : 'border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)]'
                    }`}
                  >
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--s3)] text-indigo">
                        <Icon className="w-4 h-4" />
                      </div>
                      <span className={playbook.status === 'live' ? 'badge badge-emerald' : 'badge badge-blue'}>{playbook.status}</span>
                    </div>
                    <p className="text-sm font-bold text-t1">{playbook.name}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-t3">{playbook.action}</p>
                    <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--b1)] pt-3">
                      <div><p className="text-xs font-bold text-t1">{playbook.recovered}</p><p className="text-[10px] text-t3">Outcome</p></div>
                      <div><p className="text-xs font-bold text-t1">{playbook.runs}</p><p className="text-[10px] text-t3">Runs</p></div>
                      <div><p className="text-xs font-bold text-t1">{playbook.success}%</p><p className="text-[10px] text-t3">Success</p></div>
                    </div>
                  </button>
                );
              })}
            </div>
          </BentoCard>

          <BentoCard title="Explainable Decision Trace" subtitle="Why the selected agent takes action" headerRight={<FileCheck2 className="w-4 h-4 text-indigo" />}>
            {playbooks.filter(playbook => playbook.id === selectedPlaybook).map(playbook => (
              <div key={playbook.id} className="space-y-3">
                {[
                  { label: '1 · Detect', text: playbook.trigger, icon: Activity, color: 'text-blue-v bg-[var(--blue-soft)]' },
                  { label: '2 · Verify', text: 'Check communication consent, branch rules, capacity, and suppression windows.', icon: ShieldCheck, color: 'text-emerald-v bg-[var(--emerald-soft)]' },
                  { label: '3 · Decide', text: 'Rank the next-best action by customer fit, likely outcome, and operational load.', icon: Sparkles, color: 'text-violet-v bg-[var(--violet-soft)]' },
                  { label: '4 · Act or escalate', text: playbook.action, icon: Zap, color: 'text-amber-v bg-[var(--amber-soft)]' },
                ].map(step => {
                  const Icon = step.icon;
                  return (
                    <div key={step.label} className="flex items-start gap-3 rounded-xl border border-[var(--b1)] p-3">
                      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${step.color}`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-t1">{step.label}</p>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-t3">{step.text}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </BentoCard>
        </div>

        <div className="space-y-4">
          <BentoCard
            title="Approval Inbox"
            subtitle="Higher-impact decisions need you"
            headerRight={<span className="badge badge-amber">{pendingApprovals} pending</span>}
          >
            <div className="space-y-3">
              {approvals.map(item => (
                <div key={item.id} className="rounded-xl border border-[var(--b1)] p-3.5">
                  <div className="mb-1.5 flex items-start justify-between gap-2">
                    <p className="text-xs font-bold leading-tight text-t1">{item.title}</p>
                    <span className="badge badge-emerald shrink-0">{item.value}</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-t3">{item.reason}</p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px]">
                    <span className="font-semibold text-t2">{item.scope}</span>
                    <span className="font-bold text-violet-v">{item.confidence}% confidence</span>
                  </div>
                  <div className="mt-2">
                    <ProgressBar value={item.confidence} color="violet" size="xs" />
                  </div>
                  {item.status === 'pending' ? (
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void updateApproval(item.id, 'approved')} className="flex-1 rounded-lg bg-[var(--indigo)] px-2 py-1.5 text-[11px] font-semibold text-white hover:opacity-90">
                        Approve
                      </button>
                      <button type="button" onClick={() => void updateApproval(item.id, 'dismissed')} className="rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t3 hover:bg-[var(--s3)]">
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <p className={`mt-3 flex items-center gap-1 text-[11px] font-bold ${item.status === 'approved' ? 'text-emerald-v' : 'text-t3'}`}>
                      <CheckCircle2 className="w-3.5 h-3.5" /> {item.status === 'approved' ? 'Approved for execution' : 'Dismissed'}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Live Audit Trail" subtitle="Every action stays explainable" headerRight={<Activity className="w-4 h-4 text-emerald-v" />}>
            <div className="space-y-3">
              {auditTrail.map(item => (
                <div key={`${item.time}-${item.event}`} className="flex items-start gap-2.5">
                  <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                    item.type === 'success' ? 'bg-[var(--emerald)]' : item.type === 'guardrail' ? 'bg-[var(--amber)]' : 'bg-[var(--indigo)]'
                  }`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold leading-tight text-t1">{item.event}</p>
                    <p className="mt-0.5 text-[10px] text-t3">{item.time} · {item.actor}</p>
                  </div>
                  <span className={`text-[10px] font-bold shrink-0 ${
                    item.type === 'success' ? 'text-emerald-v' : item.type === 'guardrail' ? 'text-amber-v' : 'text-indigo'
                  }`}>{item.result}</span>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => navigate('/control-plane')} className="mt-4 flex w-full items-center justify-center gap-1 rounded-xl border border-dashed border-[var(--b2)] py-2 text-xs font-semibold text-indigo hover:bg-[var(--s3)]">
              View full audit log <ArrowRight className="w-3 h-3" />
            </button>
          </BentoCard>

          <div className="rounded-2xl border border-[var(--amber-soft)] bg-[var(--amber-soft)] p-4">
            <div className="mb-1.5 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-v" />
              <p className="text-xs font-bold text-amber-v">Safe by design</p>
            </div>
            <p className="text-[11px] leading-relaxed text-t2">
              Clinical advice, diagnosis, treatment changes, and consent exceptions always remain outside Autopilot.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
