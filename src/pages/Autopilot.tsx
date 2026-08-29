import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Activity, AlertTriangle, ArrowRight, Bot, CheckCircle2, Clock3,
  FileCheck2, Inbox, RefreshCw, ShieldCheck, Sparkles, Users,
  WandSparkles, Zap,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import ResourceSection from '../components/ui/ResourceSection';
import { apiRequest } from '../lib/api';
import { fetchList } from '../lib/apiAdapters';
import { useResource } from '../hooks/useResource';
import { receivedData } from '../lib/resourceState';
import { formatCurrency } from '../utils/formatters';

type ApiApprovalStatus = 'PENDING' | 'APPROVED' | 'DISMISSED' | 'EXECUTED' | 'FAILED';

/**
 * Everything in here is operator-entered configuration on the playbook row.
 * Nothing in the codebase ever writes `runs`, `outcomeValue`, `successRate`,
 * `monthlyHoursSaved` or `guardrailBlocks` — no worker, no route, no seed. They
 * are settings someone typed, so this screen presents them as settings and
 * never as measurements of what the automation did.
 */
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

/**
 * What the server actually answers when an action is approved.
 *
 * `POST /approvals/:id/approve` returns the approval plus a dispatch record.
 * `queued` means a background job was accepted; `pending_dispatch` means the
 * approval is stored and retryable but nothing has been handed to a worker
 * (this is the deliberate outcome when queues are disabled in the runtime);
 * `dispatch_failed` means the enqueue was reconciled as failed. The screen used
 * to discard this body entirely and hardcode a green "Approved for execution".
 */
type DispatchState = 'queued' | 'pending_dispatch' | 'dispatch_failed';
interface DispatchCapability {
  available: boolean;
  mode: 'background_queue' | 'manual_retry_required';
  reason: string | null;
}
interface ApproveResponse {
  id: string;
  status: ApiApprovalStatus;
  dispatch: { capability: DispatchCapability; state: DispatchState };
}
interface DispatchResponse {
  id: string;
  status: ApiApprovalStatus;
  dispatch: { state: DispatchState; attemptId?: string; reason?: string };
}

/** The outcome of a decision this session made, as the server reported it. */
type Decision =
  | { kind: 'dismissed' }
  | { kind: 'approved'; dispatch: DispatchState; capability?: DispatchCapability };

const ICONS: Record<string, React.ElementType> = {
  clock: Clock3, activity: Activity, users: Users, wand: WandSparkles,
};
const iconFor = (key?: string) => ICONS[key ?? ''] ?? Bot;

function fmtTime(iso?: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const loadPlaybooks = '/v1/autopilot/playbooks';
const loadPending = '/v1/autopilot/approvals?status=PENDING';
const loadExecuted = '/v1/autopilot/approvals?status=EXECUTED';

/**
 * The activity trail is one claim built from two queries, so it is one
 * resource: if either half fails the panel says the trail could not be loaded
 * rather than presenting the surviving half as the whole record. Module scope,
 * because useResource keys a request by the identity of its loader.
 */
const loadTrail = async (signal: AbortSignal): Promise<ApiApproval[]> => {
  const [executedRows, approvedRows] = await Promise.all([
    fetchList<ApiApproval>(loadExecuted, signal),
    fetchList<ApiApproval>('/v1/autopilot/approvals?status=APPROVED', signal),
  ]);
  return [...executedRows, ...approvedRows]
    .sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? ''))
    .slice(0, 6);
};

export default function Autopilot() {
  const navigate = useNavigate();
  const playbooks = useResource<ApiPlaybook[]>(loadPlaybooks);
  const approvals = useResource<ApiApproval[]>(loadPending);
  const activity = useResource<ApiApproval[]>(loadTrail);

  const [selectedId, setSelectedId] = useState<string>('');
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const playbookRows = receivedData(playbooks.state);
  const pendingRows = receivedData(approvals.state);

  const liveCount = playbookRows?.filter(p => p.status === 'LIVE').length ?? null;
  const pendingCount = pendingRows?.filter(a => a.status === 'PENDING' && !decisions[a.id]).length ?? null;
  const selected = playbookRows?.find(p => p.id === selectedId)
    ?? (selectedId === '' ? playbookRows?.[0] ?? null : null);

  const refreshTrail = () => activity.reload();

  const updateApproval = async (id: string, decision: 'approve' | 'dismiss') => {
    setError(null);
    setPendingAction(id);
    try {
      if (decision === 'dismiss') {
        await apiRequest(`/v1/autopilot/approvals/${id}/dismiss`, { method: 'POST' });
        setDecisions(current => ({ ...current, [id]: { kind: 'dismissed' } }));
      } else {
        // Read what the server actually did with the approval instead of
        // assuming it will run.
        const result = await apiRequest<ApproveResponse>(`/v1/autopilot/approvals/${id}/approve`, { method: 'POST' });
        setDecisions(current => ({
          ...current,
          [id]: { kind: 'approved', dispatch: result.dispatch?.state ?? 'pending_dispatch', capability: result.dispatch?.capability },
        }));
      }
      // The activity panel next door is a record of decisions; it goes stale the
      // moment one is made here.
      refreshTrail();
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Unable to update approval');
    } finally {
      setPendingAction(null);
    }
  };

  const retryDispatch = async (id: string) => {
    setError(null);
    setPendingAction(id);
    try {
      const result = await apiRequest<DispatchResponse>(`/v1/autopilot/approvals/${id}/dispatch`, { method: 'POST' });
      setDecisions(current => {
        const existing = current[id];
        const capability = existing?.kind === 'approved' ? existing.capability : undefined;
        return { ...current, [id]: { kind: 'approved', dispatch: result.dispatch?.state ?? 'pending_dispatch', capability } };
      });
      refreshTrail();
    } catch (dispatchError) {
      setError(dispatchError instanceof Error ? dispatchError.message : 'Unable to request dispatch');
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="CareFlow Autopilot"
        subtitle="Review configured automation playbooks, approval requests, and recorded activity."
        badge={
          playbooks.state.status === 'loading' ? 'Loading playbooks'
            : playbooks.state.status === 'error' ? 'Data unavailable'
              : `${liveCount ?? 0} active playbook${liveCount === 1 ? '' : 's'}`
        }
        badgeColor={playbooks.state.status === 'error' ? 'red' : playbooks.state.status === 'loading' ? 'blue' : (liveCount ?? 0) > 0 ? 'violet' : 'blue'}
      />

      {error && <div role="alert" className="rounded-2xl border border-[var(--red-soft)] bg-[var(--red-soft)] px-4 py-3 text-sm text-red-v">{error}</div>}

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
            {/* The headline used to read "…include N runs and $X in associated
                outcome value", where both figures were summed straight out of
                playbook config JSON that nothing ever writes. It now counts the
                records themselves, which is something the response really says. */}
            <ResourceSection
              label="Automation overview"
              state={playbooks.state}
              onRetry={playbooks.reload}
              lines={2}
              rowClassName="h-6 rounded-lg"
              isEmpty={() => false}
            >
              {rows => (
                <h2 className="max-w-3xl text-xl font-bold leading-snug text-t1">
                  {rows.length === 0
                    ? 'No automation playbooks are configured for this workspace yet.'
                    : `${rows.length} automation playbook${rows.length === 1 ? '' : 's'} configured, ${rows.filter(p => p.status === 'LIVE').length} of them active.`}
                </h2>
              )}
            </ResourceSection>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-t2">
              Everything on this page is stored configuration and recorded approval activity. Playbook settings describe what an automation is set up to do; they are not evidence of what it has done.
            </p>
          </div>
          <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-5 py-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-indigo">Configured execution level</p>
            <ResourceSection
              label="Execution level"
              state={playbooks.state}
              onRetry={playbooks.reload}
              lines={1}
              rowClassName="h-8 rounded-lg"
              compact
              isEmpty={() => false}
            >
              {rows => (
                <p className="mt-1 text-2xl font-bold text-t1">
                  {rows.length === 0 ? 'Not set' : `Level ${Math.max(1, ...rows.map(p => p.config.autonomyLevel ?? 1))}`}
                </p>
              )}
            </ResourceSection>
            <p className="text-xs text-t3">Stored setting; it does not prove unattended execution</p>
          </div>
        </div>
      </div>

      {/* Counts of records that were actually returned. The previous four tiles
          — Associated value, Recorded runs, Estimated time, Rule blocks — were
          sums of operator-typed config fields presented as outcomes. */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <ResourceSection
          label="Playbook counts"
          state={playbooks.state}
          onRetry={playbooks.reload}
          className="col-span-2"
          compact
          loading={<>{[0, 1].map(i => <div key={i} className="skeleton-line h-24 rounded-2xl" />)}</>}
          isEmpty={() => false}
        >
          {rows => (
            <>
              <StatCard title="Playbooks configured" value={rows.length} subtitle="Stored playbook records" icon={<Bot className="w-4 h-4" />} accent="violet" />
              <StatCard title="Active playbooks" value={rows.filter(p => p.status === 'LIVE').length} subtitle="Status LIVE on the stored record" icon={<Zap className="w-4 h-4" />} accent="emerald" />
            </>
          )}
        </ResourceSection>
        <ResourceSection
          label="Approval queue count"
          state={approvals.state}
          onRetry={approvals.reload}
          compact
          loading={<div className="skeleton-line h-24 rounded-2xl" />}
          isEmpty={() => false}
        >
          {rows => <StatCard title="Awaiting approval" value={rows.filter(a => a.status === 'PENDING').length} subtitle="Requests returned as PENDING" icon={<Inbox className="w-4 h-4" />} accent="amber" />}
        </ResourceSection>
        <ResourceSection
          label="Recorded activity count"
          state={activity.state}
          onRetry={refreshTrail}
          compact
          loading={<div className="skeleton-line h-24 rounded-2xl" />}
          isEmpty={() => false}
        >
          {rows => <StatCard title="Recorded decisions" value={rows.length} subtitle="Most recent approved or executed records" icon={<Activity className="w-4 h-4" />} accent="blue" />}
        </ResourceSection>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_390px]">
        <div className="space-y-4">
          <BentoCard
            title="Automation playbooks"
            subtitle="Configured triggers and actions"
            headerRight={liveCount === null ? undefined : <span className="badge badge-violet">{liveCount} active</span>}
          >
            <ResourceSection
              label="Automation playbooks"
              state={playbooks.state}
              onRetry={playbooks.reload}
              lines={2}
              rowClassName="h-40 rounded-2xl"
              empty={{
                icon: <Bot className="w-5 h-5" />,
                title: 'No playbooks configured',
                description: 'The playbook feed loaded successfully and this workspace has no automation playbooks configured yet.',
              }}
            >
              {rows => (
                <div className="grid gap-3 sm:grid-cols-2">
                  {rows.map(pb => {
                    const Icon = iconFor(pb.config.icon);
                    const isSelected = pb.id === (selected?.id ?? '');
                    const outcome = pb.config.outcomeValue != null ? formatCurrency(pb.config.outcomeValue) : (pb.config.outcomeLabel ?? 'Not set');
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
                        {/* Labelled for what they are. These three fields are
                            typed into the playbook by an operator; no run of
                            this automation ever updates them. */}
                        <div className="mt-3 border-t border-[var(--b1)] pt-3">
                          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-t3">Operator-entered settings · not measured</p>
                          <div className="grid grid-cols-3 gap-2">
                            <div><p className="text-xs font-bold text-t1">{outcome}</p><p className="text-[10px] text-t3">Value setting</p></div>
                            <div><p className="text-xs font-bold text-t1">{pb.config.runs ?? 'Not set'}</p><p className="text-[10px] text-t3">Runs setting</p></div>
                            <div><p className="text-xs font-bold text-t1">{pb.config.successRate != null ? `${pb.config.successRate}%` : 'Not set'}</p><p className="text-[10px] text-t3">Rate setting</p></div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </ResourceSection>
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
            headerRight={pendingCount === null ? undefined : <span className="badge badge-amber">{pendingCount} pending</span>}
          >
            <ResourceSection
              label="Approval inbox"
              state={approvals.state}
              onRetry={approvals.reload}
              lines={2}
              rowClassName="h-32 rounded-xl"
              empty={{
                icon: <Inbox className="w-5 h-5" />,
                title: 'No decisions awaiting approval',
                description: 'The approval queue loaded successfully and nothing is waiting on you right now.',
              }}
            >
              {rows => (
                <div className="space-y-3">
                  {rows.map(item => {
                    const decision = decisions[item.id];
                    const busy = pendingAction === item.id;
                    return (
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
                        {decision
                          ? <DecisionOutcome decision={decision} busy={busy} onRetry={() => void retryDispatch(item.id)} />
                          : item.status === 'PENDING' ? (
                            <div className="mt-3 flex gap-2">
                              <button type="button" disabled={busy} onClick={() => void updateApproval(item.id, 'approve')} className="flex-1 rounded-lg bg-[var(--indigo)] px-2 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-40">{busy ? 'Working…' : 'Approve'}</button>
                              <button type="button" disabled={busy} onClick={() => void updateApproval(item.id, 'dismiss')} className="rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t3 hover:bg-[var(--s3)] disabled:opacity-40">Dismiss</button>
                            </div>
                          ) : (
                            <p className="mt-3 text-[11px] font-bold text-t3">Recorded as {item.status.toLowerCase()}</p>
                          )}
                      </div>
                    );
                  })}
                </div>
              )}
            </ResourceSection>
          </BentoCard>

          <BentoCard title="Recorded approval activity" subtitle="Recent approved or executed records returned by the API" headerRight={<Activity className="w-4 h-4 text-indigo" />}>
            <ResourceSection
              label="Recorded approval activity"
              state={activity.state}
              onRetry={refreshTrail}
              lines={3}
              rowClassName="h-8 rounded-lg"
              empty={{
                icon: <Activity className="w-5 h-5" />,
                title: 'No approval activity recorded',
                description: 'The activity feed loaded successfully and no approved or executed action has been recorded for this workspace yet.',
              }}
            >
              {rows => (
                <div className="space-y-3">
                  {rows.map(item => {
                    const kind = item.payload.kind ?? 'success';
                    return (
                      <div key={item.id} className="flex items-start gap-2.5">
                        <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${kind === 'success' ? 'bg-[var(--emerald)]' : kind === 'guardrail' ? 'bg-[var(--amber)]' : 'bg-[var(--indigo)]'}`} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-semibold leading-tight text-t1">{item.title}</p>
                          <p className="mt-0.5 text-[10px] text-t3">{fmtTime(item.reviewedAt)} · {item.playbook?.name ?? 'Autopilot'}</p>
                        </div>
                        {item.payload.value && (
                          <span className={`text-[10px] font-bold shrink-0 ${kind === 'success' ? 'text-emerald-v' : kind === 'guardrail' ? 'text-amber-v' : 'text-indigo'}`}>{item.payload.value}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </ResourceSection>
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

/**
 * Says what the server did with the decision, one line per real state.
 *
 * "Approved" and "will run" are different claims, and only `queued` supports the
 * second one. `pending_dispatch` and `dispatch_failed` both mean no worker holds
 * this action, so neither may be painted green — and `dispatch_failed` gets the
 * retry endpoint the API has always exposed.
 */
function DecisionOutcome({ decision, busy, onRetry }: { decision: Decision; busy: boolean; onRetry: () => void }) {
  if (decision.kind === 'dismissed') {
    return <p className="mt-3 flex items-center gap-1 text-[11px] font-bold text-t3"><CheckCircle2 className="w-3.5 h-3.5" /> Dismissed</p>;
  }

  if (decision.dispatch === 'queued') {
    return (
      <div className="mt-3">
        <p className="flex items-center gap-1 text-[11px] font-bold text-emerald-v"><CheckCircle2 className="w-3.5 h-3.5" /> Approved and queued for execution</p>
        <p className="mt-1 text-[10px] leading-snug text-t3">A background job accepted this action. Execution is confirmed only when it appears in the recorded activity.</p>
      </div>
    );
  }

  if (decision.dispatch === 'pending_dispatch') {
    // Retrying only helps if a queue exists to accept the job; when the runtime
    // reports queueing unavailable, offering a retry button would be theatre.
    const retryable = decision.capability?.available === true;
    return (
      <div className="mt-3">
        <p className="flex items-center gap-1 text-[11px] font-bold text-amber-v"><Clock3 className="w-3.5 h-3.5" /> Approved · not dispatched</p>
        <p className="mt-1 text-[10px] leading-snug text-t3">
          {decision.capability?.reason ?? 'The approval is stored and retryable, but no execution job has been accepted for it. Nothing will run until one is.'}
        </p>
        {retryable && (
          <button type="button" disabled={busy} onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2.5 py-1 text-[10px] font-semibold text-t1 transition hover:bg-[var(--s2)] disabled:opacity-40">
            <RefreshCw className="w-3 h-3" /> {busy ? 'Requesting…' : 'Request dispatch'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3">
      <p className="flex items-center gap-1 text-[11px] font-bold text-red-v"><AlertTriangle className="w-3.5 h-3.5" /> Approved · dispatch failed</p>
      <p className="mt-1 text-[10px] leading-snug text-t3">The approval was recorded, but handing it to a worker failed. No execution is queued for this action.</p>
      <button type="button" disabled={busy} onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2.5 py-1 text-[10px] font-semibold text-t1 transition hover:bg-[var(--s2)] disabled:opacity-40">
        <RefreshCw className="w-3 h-3" /> {busy ? 'Retrying…' : 'Retry dispatch'}
      </button>
    </div>
  );
}
