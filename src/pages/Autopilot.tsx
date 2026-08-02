import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Activity, AlertTriangle, ArrowRight, Bot, CheckCircle2, Clock3,
  DollarSign, FileCheck2, Loader2, ShieldCheck, Sparkles, Users,
  WandSparkles, Zap,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { apiRequest } from '../lib/api';
import { formatCurrency } from '../utils/formatters';

type ApiApprovalStatus = 'PENDING' | 'APPROVED' | 'DISMISSED' | 'EXECUTED' | 'FAILED';

interface PlaybookConfig {
  autonomyLevel?: number; icon?: string; trigger?: string; action?: string;
  runs?: number; successRate?: number; outcomeValue?: number; outcomeLabel?: string;
  monthlyHoursSaved?: number; guardrailBlocks?: number;
}
interface ApiPlaybook {
  id: string; key: string; name: string; description: string;
  status: 'LIVE' | 'DRAFT' | 'PAUSED'; config: PlaybookConfig;
}
interface ApiApproval {
  id: string; title: string; reason: string;
  payload: { scope?: string; value?: string; kind?: string };
  confidence: number; status: ApiApprovalStatus; reviewedAt?: string | null;
  playbook?: { key: string; name: string } | null;
}

const ICONS: Record<string, React.ElementType> = {
  clock: Clock3, activity: Activity, users: Users, wand: WandSparkles,
};
const iconFor = (key?: string) => ICONS[key ?? ''] ?? Bot;

function fmtTime(iso?: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Autopilot() {
  const navigate = useNavigate();
  const [playbooks, setPlaybooks] = useState<ApiPlaybook[]>([]);
  const [approvals, setApprovals] = useState<ApiApproval[]>([]);
  const [trail, setTrail] = useState<ApiApproval[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [pb, pending, executed, approved] = await Promise.all([
          apiRequest<ApiPlaybook[]>('/v1/autopilot/playbooks'),
          apiRequest<ApiApproval[]>('/v1/autopilot/approvals?status=PENDING').catch(() => []),
          apiRequest<ApiApproval[]>('/v1/autopilot/approvals?status=EXECUTED').catch(() => []),
          apiRequest<ApiApproval[]>('/v1/autopilot/approvals?status=APPROVED').catch(() => []),
        ]);
        if (!active) return;
        setPlaybooks(pb);
        setApprovals(pending);
        setTrail([...executed, ...approved].sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '')).slice(0, 6));
        setSelectedId(pb[0]?.id ?? '');
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load automation configuration');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const kpis = useMemo(() => {
    const sum = (f: (c: PlaybookConfig) => number) => playbooks.reduce((s, p) => s + (f(p.config) || 0), 0);
    return {
      valueRecovered: sum(c => c.outcomeValue ?? 0),
      agentActions: sum(c => c.runs ?? 0),
      hoursSaved: sum(c => c.monthlyHoursSaved ?? 0),
      guardrailBlocks: sum(c => c.guardrailBlocks ?? 0),
      live: playbooks.filter(p => p.status === 'LIVE').length,
      executionLevel: Math.max(1, ...playbooks.map(p => p.config.autonomyLevel ?? 1)),
    };
  }, [playbooks]);

  const pendingCount = approvals.filter(a => a.status === 'PENDING').length;
  const selected = playbooks.find(p => p.id === selectedId) ?? null;

  const updateApproval = async (id: string, decision: 'approve' | 'dismiss') => {
    setError(null);
    try {
      await apiRequest(`/v1/autopilot/approvals/${id}/${decision}`, { method: 'POST' });
      setApprovals(cur => cur.map(a => a.id === id ? { ...a, status: decision === 'approve' ? 'APPROVED' : 'DISMISSED' } : a));
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Unable to update approval');
    }
  };

  if (loading) return <div className="cc-card p-12 text-center" role="status" aria-live="polite" aria-busy="true"><Loader2 className="inline w-6 h-6 animate-spin text-indigo" /> <span className="sr-only">Loading automation records…</span></div>;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="CareFlow Autopilot"
        subtitle="Review configured automation playbooks, approval requests, and recorded activity."
        badge={`${kpis.live} active playbook${kpis.live === 1 ? '' : 's'}`}
        badgeColor={kpis.live > 0 ? 'violet' : 'blue'}
      />

      {error && <div role="alert" className="rounded-2xl border border-[var(--red-soft)] bg-[var(--red-soft)] px-4 py-3 text-sm text-red-v">Automation data is unavailable. {error}</div>}

      <div role="note" className="rounded-2xl border border-[var(--amber-soft)] bg-[var(--amber-soft)] px-4 py-3 text-xs text-amber-v">
        A tenant-wide pause control is not available on this page. Use the approved operational runbook before changing or stopping an active automation.
      </div>

      <div className="autopilot-hero">
        <div className="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo" />
              <p className="text-xs font-bold uppercase tracking-widest text-indigo">Automation overview</p>
            </div>
            <h2 className="max-w-3xl text-xl font-bold leading-snug text-t1">
              Current playbook records include {kpis.agentActions} runs and {formatCurrency(kpis.valueRecovered)} in associated outcome value.
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-t2">
              Values shown here come from stored playbook configuration and activity records. Review the source workflow before treating them as realized outcomes.
            </p>
          </div>
          <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-5 py-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-indigo">Configured execution level</p>
            <p className="mt-1 text-2xl font-bold text-t1">Level {kpis.executionLevel}</p>
            <p className="text-xs text-t3">Stored setting; it does not prove unattended execution</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Associated value" value={formatCurrency(kpis.valueRecovered)} subtitle="Stored playbook values" icon={<DollarSign className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Recorded runs" value={String(kpis.agentActions)} subtitle={`Across ${playbooks.length} playbooks`} icon={<Bot className="w-4 h-4" />} accent="violet" />
        <StatCard title="Estimated time" value={`${kpis.hoursSaved}h`} subtitle="Configured monthly estimate" icon={<Clock3 className="w-4 h-4" />} accent="blue" />
        <StatCard title="Rule blocks" value={String(kpis.guardrailBlocks)} subtitle="Stored block count" icon={<ShieldCheck className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_390px]">
        <div className="space-y-4">
          <BentoCard
            title="Automation playbooks"
            subtitle="Configured triggers, actions, and stored metrics"
            headerRight={<span className="badge badge-violet">{kpis.live} active</span>}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {playbooks.map(pb => {
                const Icon = iconFor(pb.config.icon);
                const isSelected = pb.id === selectedId;
                const outcome = pb.config.outcomeValue ? formatCurrency(pb.config.outcomeValue) : (pb.config.outcomeLabel ?? '—');
                return (
                  <button
                    key={pb.id}
                    type="button"
                    onClick={() => setSelectedId(pb.id)}
                    className={`text-left rounded-2xl border p-4 transition-all ${
                      isSelected ? 'border-[var(--indigo)] bg-[var(--indigo-soft)] shadow-sm' : 'border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)]'
                    }`}
                  >
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--s3)] text-indigo"><Icon className="w-4 h-4" /></div>
                      <span className={pb.status === 'LIVE' ? 'badge badge-violet' : 'badge badge-blue'}>{pb.status === 'LIVE' ? 'active' : pb.status.toLowerCase()}</span>
                    </div>
                    <p className="text-sm font-bold text-t1">{pb.name}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-t3">{pb.config.action ?? pb.description}</p>
                    <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--b1)] pt-3">
                      <div><p className="text-xs font-bold text-t1">{outcome}</p><p className="text-[10px] text-t3">Associated value</p></div>
                      <div><p className="text-xs font-bold text-t1">{pb.config.runs ?? '—'}</p><p className="text-[10px] text-t3">Recorded runs</p></div>
                      <div><p className="text-xs font-bold text-t1">{pb.config.successRate != null ? `${pb.config.successRate}%` : '—'}</p><p className="text-[10px] text-t3">Configured rate</p></div>
                    </div>
                  </button>
                );
              })}
              {playbooks.length === 0 && <p className="text-xs text-t3 py-4">No playbooks configured.</p>}
            </div>
          </BentoCard>

          {selected && (
            <BentoCard title="Playbook decision design" subtitle="How the selected playbook is configured to evaluate an action" headerRight={<FileCheck2 className="w-4 h-4 text-indigo" />}>
              <div className="space-y-3">
                {[
                  { label: '1 · Detect', text: selected.config.trigger ?? selected.description, icon: Activity, color: 'text-blue-v bg-[var(--blue-soft)]' },
                  { label: '2 · Verify', text: 'Check communication consent, branch rules, capacity, and suppression windows.', icon: ShieldCheck, color: 'text-emerald-v bg-[var(--emerald-soft)]' },
                  { label: '3 · Decide', text: 'Rank the next-best action by patient fit, recorded signals, and operational load.', icon: Sparkles, color: 'text-violet-v bg-[var(--violet-soft)]' },
                  { label: '4 · Act or escalate', text: selected.config.action ?? selected.description, icon: Zap, color: 'text-amber-v bg-[var(--amber-soft)]' },
                ].map(step => {
                  const Icon = step.icon;
                  return (
                    <div key={step.label} className="flex items-start gap-3 rounded-xl border border-[var(--b1)] p-3">
                      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${step.color}`}><Icon className="w-4 h-4" /></div>
                      <div>
                        <p className="text-xs font-bold text-t1">{step.label}</p>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-t3">{step.text}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </BentoCard>
          )}
        </div>

        <div className="space-y-4">
          <BentoCard
            title="Approval Inbox"
            subtitle="Higher-impact decisions need you"
            headerRight={<span className="badge badge-amber">{pendingCount} pending</span>}
          >
            <div className="space-y-3">
              {approvals.map(item => (
                <div key={item.id} className="rounded-xl border border-[var(--b1)] p-3.5">
                  <div className="mb-1.5 flex items-start justify-between gap-2">
                    <p className="text-xs font-bold leading-tight text-t1">{item.title}</p>
                    {item.payload.value && <span className="badge badge-emerald shrink-0">{item.payload.value}</span>}
                  </div>
                  <p className="text-[11px] leading-relaxed text-t3">{item.reason}</p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px]">
                    <span className="font-semibold text-t2">{item.payload.scope ?? item.playbook?.name ?? 'Governed agent action'}</span>
                    <span className="font-bold text-violet-v">Stored score {item.confidence}%</span>
                  </div>
                  <div className="mt-2"><ProgressBar value={item.confidence} color="violet" size="xs" /></div>
                  {item.status === 'PENDING' ? (
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={() => void updateApproval(item.id, 'approve')} className="flex-1 rounded-lg bg-[var(--indigo)] px-2 py-1.5 text-[11px] font-semibold text-white hover:opacity-90">Approve</button>
                      <button type="button" onClick={() => void updateApproval(item.id, 'dismiss')} className="rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t3 hover:bg-[var(--s3)]">Dismiss</button>
                    </div>
                  ) : (
                    <p className={`mt-3 flex items-center gap-1 text-[11px] font-bold ${item.status === 'APPROVED' ? 'text-emerald-v' : 'text-t3'}`}>
                      <CheckCircle2 className="w-3.5 h-3.5" /> {item.status === 'APPROVED' ? 'Approved for execution' : 'Dismissed'}
                    </p>
                  )}
                </div>
              ))}
              {approvals.length === 0 && <p className="text-xs text-t3 py-3">No decisions awaiting approval.</p>}
            </div>
          </BentoCard>

          <BentoCard title="Recorded approval activity" subtitle="Recent approved or executed records returned by the API" headerRight={<Activity className="w-4 h-4 text-indigo" />}>
            <div className="space-y-3">
              {trail.map(item => {
                const kind = item.payload.kind ?? 'success';
                return (
                  <div key={item.id} className="flex items-start gap-2.5">
                    <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${kind === 'success' ? 'bg-[var(--emerald)]' : kind === 'guardrail' ? 'bg-[var(--amber)]' : 'bg-[var(--indigo)]'}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold leading-tight text-t1">{item.title}</p>
                      <p className="mt-0.5 text-[10px] text-t3">{fmtTime(item.reviewedAt)} · {item.playbook?.name ?? 'Autopilot'}</p>
                    </div>
                    <span className={`text-[10px] font-bold shrink-0 ${kind === 'success' ? 'text-emerald-v' : kind === 'guardrail' ? 'text-amber-v' : 'text-indigo'}`}>{item.payload.value}</span>
                  </div>
                );
              })}
              {trail.length === 0 && <p className="text-xs text-t3 py-2">No automated actions recorded yet.</p>}
            </div>
            <button type="button" onClick={() => navigate('/control-plane')} className="mt-4 flex w-full items-center justify-center gap-1 rounded-xl border border-dashed border-[var(--b2)] py-2 text-xs font-semibold text-indigo hover:bg-[var(--s3)]">
              View full audit log <ArrowRight className="w-3 h-3" />
            </button>
          </BentoCard>

          <div className="rounded-2xl border border-[var(--amber-soft)] bg-[var(--amber-soft)] p-4">
            <div className="mb-1.5 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-v" />
              <p className="text-xs font-bold text-amber-v">Scope boundary</p>
            </div>
            <p className="text-[11px] leading-relaxed text-t2">
              Autopilot is not intended to provide clinical advice, diagnosis, treatment changes, or consent exceptions. Verify each playbook and its integrations before activation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
