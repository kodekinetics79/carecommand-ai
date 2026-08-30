import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Clock, Phone, AlertCircle, Sparkles, ArrowRight, Plus, UserPlus, CheckCircle2, PlayCircle } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { apiRequest } from '../lib/api';
import { mapStaffProfile, mapStaffTask, type ApiStaffProfile, type ApiStaffTask } from '../lib/apiAdapters';
import { normalizeTaskRow } from '../lib/frontDesk';
import { resolveTimezone } from '../lib/clinicTime';
import { formatClinicDateTime, formatRelativeDue } from '../lib/frontDeskTime';
import { ReceptionistTaskCard } from '../components/receptionist/ReceptionistTaskCard';
import { hasPermission } from '../lib/access';
import { useSession } from '../hooks/useSession';
import type { StaffMember } from '../types';

type StaffView = StaffMember & { branch?: string };
type TaskView = ReturnType<typeof mapStaffTask>;
interface Assignee { id: string; displayName: string; role: string }

/** The page asks for this many tasks. Counts below are labelled as covering only these. */
const TASK_PAGE_SIZE = 100;

const statusStyles: Record<TaskView['status'], { label: string; badge: string; border: string }> = {
  open: { label: 'Open', badge: 'badge badge-blue', border: 'border-l-blue-500' },
  'in-progress': { label: 'In Progress', badge: 'badge badge-amber', border: 'border-l-amber-500' },
  completed: { label: 'Completed', badge: 'badge badge-emerald', border: 'border-l-emerald-500' },
  canceled: { label: 'Canceled', badge: 'badge badge-red', border: 'border-l-red-500' },
};

const priorityStyles = {
  critical: { badge: 'badge badge-red', border: 'border-l-red-500' },
  high: { badge: 'badge badge-red', border: 'border-l-red-500' },
  medium: { badge: 'badge badge-amber', border: 'border-l-amber-500' },
  normal: { badge: 'badge badge-amber', border: 'border-l-amber-500' },
  low: { badge: 'badge badge-blue', border: 'border-l-[var(--b2)]' },
};

type QueueFilter = 'live' | 'mine' | 'unassigned' | 'all';
const QUEUE_FILTERS: Array<{ id: QueueFilter; label: string }> = [
  { id: 'live', label: 'Open & in progress' },
  { id: 'mine', label: 'Mine' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'all', label: 'All' },
];

function extractRows<T>(payload: T[] | { data: T[] }) {
  return Array.isArray(payload) ? payload : payload.data;
}

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export default function StaffWorkflow() {
  const navigate = useNavigate();
  const { user } = useSession();
  const canAssignOthers = hasPermission(user, 'staff:write');
  const canWorkTasks = hasPermission(user, 'staff:task-status');
  // A receptionist row is only legible to a caller who may read call artifacts;
  // without the grant the server sends the restricted view and the card says so.
  const canReadCallArtifacts = hasPermission(user, 'receptionist:call-artifacts:read');
  const canBook = hasPermission(user, 'appointment:write') && hasPermission(user, 'receptionist:booking-review');
  const viewerTimezone = resolveTimezone(null);

  const [staffRecords, setStaffRecords] = useState<StaffView[]>([]);
  // The raw server rows are kept as well as the mapped view: the receptionist
  // card renders from the full C4 projection, the generic row from the view.
  const [taskRows, setTaskRows] = useState<ApiStaffTask[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  // Each source reports its own outcome. One failing panel must not blank the
  // others, and must never look like an empty result.
  const [tasksState, setTasksState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [staffState, setStaffState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>('live');
  const [composerOpen, setComposerOpen] = useState(false);

  const loadTasks = useCallback(async () => {
    try {
      const response = await apiRequest<ApiStaffTask[] | { data: ApiStaffTask[] }>(`/v1/tasks?limit=${TASK_PAGE_SIZE}`);
      setTaskRows(extractRows(response));
      setTasksState('ready');
      setTasksError(null);
    } catch (error) {
      setTasksState('error');
      setTasksError(errorText(error, 'Unable to load the task queue'));
    }
  }, []);

  useEffect(() => {
    void (async () => { await loadTasks(); })();
  }, [loadTasks]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await apiRequest<ApiStaffProfile[] | { data: ApiStaffProfile[] }>('/v1/staff/overview?limit=100');
        if (!active) return;
        setStaffRecords(extractRows(response).map(row => mapStaffProfile(row)));
        setStaffState('ready');
      } catch (error) {
        if (!active) return;
        setStaffState('error');
        setStaffError(errorText(error, 'Unable to load staff performance records'));
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!canAssignOthers) return;
    let active = true;
    void (async () => {
      try {
        const rows = await apiRequest<Assignee[]>('/v1/staff/assignees');
        if (active) setAssignees(rows);
      } catch {
        // Assignment to others simply stays unavailable; the roster is not
        // required to see, take, or complete work.
        if (active) setAssignees([]);
      }
    })();
    return () => { active = false; };
  }, [canAssignOthers]);

  const taskRecords = useMemo(() => taskRows.map(row => mapStaffTask(row)), [taskRows]);
  const rawTaskById = useMemo(() => new Map(taskRows.map(row => [row.id, row])), [taskRows]);

  const tasksReady = tasksState === 'ready';
  const staffReady = staffState === 'ready' && staffRecords.length > 0;
  const queueTruncated = tasksReady && taskRecords.length >= TASK_PAGE_SIZE;

  // Counts describe the loaded rows only, and are labelled that way.
  const counts = useMemo(() => ({
    open: taskRecords.filter(t => t.status === 'open').length,
    inProgress: taskRecords.filter(t => t.status === 'in-progress').length,
    overdue: taskRecords.filter(t => t.overdue).length,
    unassigned: taskRecords.filter(t => !t.assignedToId && (t.status === 'open' || t.status === 'in-progress')).length,
  }), [taskRecords]);

  const staffTotals = useMemo(() => {
    if (staffRecords.length === 0) return null;
    return {
      avgResponse: (staffRecords.reduce((sum, m) => sum + m.responseTime, 0) / staffRecords.length).toFixed(1),
      avgConversion: Math.round(staffRecords.reduce((sum, m) => sum + m.bookingConversionRate, 0) / staffRecords.length),
      totalMissed: staffRecords.reduce((sum, m) => sum + m.missedCalls, 0),
    };
  }, [staffRecords]);

  const visibleTasks = useMemo(() => {
    const live = (t: TaskView) => t.status === 'open' || t.status === 'in-progress';
    const rows = taskRecords.filter(t => {
      if (filter === 'live') return live(t);
      if (filter === 'mine') return live(t) && t.assignedToId === user?.id;
      if (filter === 'unassigned') return live(t) && !t.assignedToId;
      return true;
    });
    // Overdue first, then earliest due, then undated.
    return [...rows].sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.dueAt && b.dueAt) return a.dueAt.getTime() - b.dueAt.getTime();
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return 0;
    });
  }, [taskRecords, filter, user?.id]);

  /** Every row mutation goes through the server and then re-reads. No optimistic status. */
  async function mutateTask(taskId: string, path: string, body: unknown, failure: string) {
    setBusyTaskId(taskId);
    setRowError(null);
    try {
      const updated = await apiRequest<ApiStaffTask>(path, { method: 'PATCH', body: JSON.stringify(body) });
      setTaskRows(current => current.map(row => row.id === taskId ? updated : row));
    } catch (error) {
      setRowError(errorText(error, failure));
      // The row is left exactly as the server last described it.
      await loadTasks();
    } finally {
      setBusyTaskId(null);
    }
  }

  const setStatus = (taskId: string, status: 'IN_PROGRESS' | 'COMPLETED') =>
    mutateTask(taskId, `/v1/staff/tasks/${taskId}/status`, { status }, 'Unable to update this task');

  const setAssignment = (taskId: string, assignedToId: string | null) =>
    mutateTask(taskId, `/v1/staff/tasks/${taskId}/assignment`, { assignedToId }, 'Unable to change who owns this task');

  const underperformers = staffRecords.filter(m => m.bookingConversionRate < 55 || m.responseTime > 6);
  const responseThresholdExceptions = staffRecords.filter(m => m.responseTime > 6);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Staff Tasks"
        subtitle="The shared work queue. Every row here is a stored task: take it, hand it to a colleague, or close it."
        badge={tasksState === 'loading' ? 'Loading' : tasksState === 'error' ? 'Queue unavailable' : `${counts.open + counts.inProgress} live · ${counts.overdue} overdue`}
        badgeColor={tasksState === 'error' ? 'red' : counts.overdue > 0 ? 'red' : 'blue'}
        actions={canAssignOthers ? (
          <button type="button" onClick={() => setComposerOpen(open => !open)} aria-expanded={composerOpen}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Plus className="w-4 h-4" /> New task
          </button>
        ) : undefined}
      />

      {tasksState === 'error' && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          The task queue could not be loaded, so this page is not showing your clinic's work. Do not read it as an empty queue. {tasksError}
        </div>
      )}
      {rowError && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{rowError}</div>
      )}

      {composerOpen && canAssignOthers && (
        <NewTaskForm
          assignees={assignees}
          onCancel={() => setComposerOpen(false)}
          onCreated={async () => { setComposerOpen(false); await loadTasks(); }}
        />
      )}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Open" value={tasksReady ? counts.open : '—'} subtitle={tasksReady ? 'Loaded task records' : 'Unavailable'} icon={<AlertCircle className="w-4 h-4" />} accent="blue" />
        <StatCard title="In Progress" value={tasksReady ? counts.inProgress : '—'} subtitle={tasksReady ? 'Loaded task records' : 'Unavailable'} icon={<PlayCircle className="w-4 h-4" />} accent="amber" />
        <StatCard title="Overdue" value={tasksReady ? counts.overdue : '—'} subtitle={tasksReady ? 'Past due and still live' : 'Unavailable'} icon={<Clock className="w-4 h-4" />} accent="red" />
        <StatCard title="Unassigned" value={tasksReady ? counts.unassigned : '—'} subtitle={tasksReady ? 'Live work with no owner' : 'Unavailable'} icon={<UserPlus className="w-4 h-4" />} accent="violet" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <BentoCard
            title="Task Queue"
            subtitle={queueTruncated ? `Newest ${TASK_PAGE_SIZE} tasks — counts cover these only` : 'Tasks stored for your clinic'}
            headerRight={
              <div className="flex flex-wrap gap-1">
                {QUEUE_FILTERS.map(f => (
                  <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
                    className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition ${filter === f.id ? 'bg-[var(--indigo)] text-white' : 'text-t3 hover:bg-[var(--s3)]'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
            }
          >
            <div className="space-y-2.5">
              {tasksState === 'loading' ? (
                <p role="status" aria-live="polite" aria-busy="true" className="text-sm text-t3 py-4 text-center">Loading the task queue…</p>
              ) : tasksState === 'error' ? (
                <p className="text-sm text-t3 py-4 text-center">The queue is unavailable. Retry before assuming there is no work.</p>
              ) : visibleTasks.length === 0 ? (
                <p className="text-sm text-t3 py-4 text-center">
                  {taskRecords.length === 0
                    ? 'No tasks are stored for this clinic yet. Hand-offs from the Opportunity Center, AI Receptionist escalations, and insurance reviews land here.'
                    : `No task matches the “${QUEUE_FILTERS.find(f => f.id === filter)?.label}” filter. ${taskRecords.length} task${taskRecords.length === 1 ? '' : 's'} loaded in total.`}
                </p>
              ) : visibleTasks.map(task => {
                // A receptionist task is a caller waiting on a human. It gets the
                // front-desk card (caller, message, callback window, transfer
                // state, Acknowledge) instead of the generic title row.
                const rawRow = rawTaskById.get(task.id);
                if (task.receptionist && rawRow) {
                  return (
                    <ReceptionistTaskCard
                      key={task.id}
                      task={normalizeTaskRow(rawRow)}
                      timezone={task.clinic?.timezone ?? viewerTimezone}
                      variant="compact"
                      can={{ work: canWorkTasks, readArtifacts: canReadCallArtifacts, book: canBook }}
                      onChanged={async () => { await loadTasks(); }}
                    />
                  );
                }
                const priorityStyle = priorityStyles[task.priority as keyof typeof priorityStyles] ?? priorityStyles.low;
                const statusStyle = statusStyles[task.status] ?? statusStyles.open;
                const terminal = task.status === 'completed' || task.status === 'canceled';
                const busy = busyTaskId === task.id;
                const mine = task.assignedToId === user?.id;
                return (
                  <div key={task.id} className={`p-3.5 rounded-xl border border-l-2 transition-all ${priorityStyle.border} ${task.overdue ? 'border-[var(--b1)] bg-[var(--red-soft)]' : 'border-[var(--b1)]'}`}>
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-t1">{task.title}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span className={priorityStyle.badge}>{task.priority}</span>
                          <span className={statusStyle.badge}>{statusStyle.label}</span>
                          <span className={`text-[10px] font-semibold ${task.overdue ? 'text-red-v' : 'text-t3'}`} title={formatClinicDateTime(task.dueAt, task.clinic?.timezone ?? viewerTimezone)}>
                            {formatRelativeDue(task.dueAt).label}
                          </span>
                          <span className="text-[10px] text-t3">· {task.branch} · {task.assignee ?? 'Unassigned'}</span>
                          {task.origin && <span className="text-[10px] text-t3">· from {task.origin}</span>}
                        </div>
                      </div>
                      {terminal && <CheckCircle2 className="w-4 h-4 text-emerald-v shrink-0 mt-0.5" aria-hidden="true" />}
                    </div>

                    {!terminal && canWorkTasks && (
                      <div className="flex flex-wrap items-center gap-2 mt-2.5">
                        {task.status === 'open' && (
                          <button type="button" disabled={busy} onClick={() => void setStatus(task.id, 'IN_PROGRESS')}
                            className="inline-flex items-center gap-1 rounded-lg bg-[var(--indigo-soft)] px-2.5 py-1 text-[10px] font-semibold text-indigo hover:bg-[var(--s3)] transition disabled:opacity-50">
                            <PlayCircle className="w-3 h-3" /> Start
                          </button>
                        )}
                        <button type="button" disabled={busy} onClick={() => void setStatus(task.id, 'COMPLETED')}
                          className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[10px] font-semibold text-t2 hover:bg-[var(--s2)] transition disabled:opacity-50">
                          <CheckCircle2 className="w-3 h-3" /> Complete
                        </button>
                        {mine ? (
                          <button type="button" disabled={busy} onClick={() => void setAssignment(task.id, null)}
                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[10px] font-semibold text-t2 hover:bg-[var(--s2)] transition disabled:opacity-50">
                            Give back
                          </button>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => void setAssignment(task.id, user?.id ?? null)}
                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[10px] font-semibold text-t2 hover:bg-[var(--s2)] transition disabled:opacity-50">
                            <UserPlus className="w-3 h-3" /> {task.assignedToId ? 'Take over' : 'Take it'}
                          </button>
                        )}
                        {canAssignOthers && assignees.length > 0 && (
                          <label className="inline-flex items-center gap-1 text-[10px] text-t3">
                            <span className="sr-only">Assign “{task.title}” to</span>
                            <select
                              value={task.assignedToId ?? ''}
                              disabled={busy}
                              onChange={e => void setAssignment(task.id, e.target.value || null)}
                              className="rounded-lg border border-[var(--b1)] bg-transparent px-2 py-1 text-[10px] font-semibold text-t2 outline-none disabled:opacity-50"
                            >
                              <option value="">Unassigned</option>
                              {assignees.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
                            </select>
                          </label>
                        )}
                      </div>
                    )}
                    {!terminal && !canWorkTasks && (
                      <p className="mt-2 text-[10px] text-t3">Your role can read this queue but not change a task.</p>
                    )}
                  </div>
                );
              })}
            </div>
          </BentoCard>

          <BentoCard title="Staff Performance Leaderboard" subtitle="Response time & conversion ranking">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--b1)]">
                    {['Staff Member', 'Branch', 'Response Time', 'Conversion', 'Missed Calls', 'Follow-up', 'Score'].map(header => (
                      <th key={header} className="text-left py-2 px-2 text-[10px] font-bold uppercase tracking-widest text-t3 whitespace-nowrap">{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--b0)]">
                  {[...staffRecords].sort((a, b) => b.bookingConversionRate - a.bookingConversionRate).map(member => {
                    const branchName = member.branch ?? 'Branch not recorded';
                    const score = Math.round((member.bookingConversionRate * 0.4) + (member.followUpRate * 0.3) + (member.patientFeedbackScore * 10 * 0.3));
                    return (
                      <tr key={member.id} className="hover:bg-[var(--s3)] transition-colors group">
                        <td className="py-2.5 px-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-300 to-slate-400 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                              {member.name.split(' ').map(n => n[0]).join('')}
                            </div>
                            <div>
                              <p className="text-xs font-bold text-t1 group-hover:text-indigo transition-colors">{member.name}</p>
                              <p className="text-[10px] text-t3">{member.role}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 text-xs text-t3">{branchName.split(' ')[0]}</td>
                        <td className={`py-2.5 px-2 text-xs font-bold ${member.responseTime > 6 ? 'text-red-v' : member.responseTime > 4 ? 'text-amber-v' : 'text-emerald-v'}`}>{member.responseTime} min</td>
                        <td className="py-2.5 px-2 text-xs font-bold text-t1">{member.bookingConversionRate}%</td>
                        <td className={`py-2.5 px-2 text-xs font-bold ${member.missedCalls > 10 ? 'text-red-v' : 'text-t2'}`}>{member.missedCalls}</td>
                        <td className="py-2.5 px-2 text-xs font-semibold text-t2">{member.followUpRate}%</td>
                        <td className="py-2.5 px-2">
                          <span className={`badge ${score >= 75 ? 'badge-emerald' : score >= 55 ? 'badge-amber' : 'badge-red'}`}>{score}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {staffState === 'loading' && <p role="status" aria-live="polite" aria-busy="true" className="text-sm text-t3 text-center py-4">Loading staff records…</p>}
              {staffState === 'error' && <p className="text-sm text-t3 text-center py-4">Staff performance records are unavailable. {staffError}</p>}
              {staffState === 'ready' && staffRecords.length === 0 && (
                <p className="text-sm text-t3 text-center py-4">No staff profiles are recorded for this clinic, so no response time or conversion figure can be shown.</p>
              )}
            </div>
          </BentoCard>
        </div>

        <div className="space-y-4">
          <BentoCard title="Staff Response Metrics" subtitle="From recorded staff profiles">
            <div className="grid grid-cols-3 gap-2">
              <MetricTile label="Avg response" value={staffReady && staffTotals ? `${staffTotals.avgResponse} min` : '—'} />
              <MetricTile label="Conversion" value={staffReady && staffTotals ? `${staffTotals.avgConversion}%` : '—'} />
              <MetricTile label="Missed calls" value={staffReady && staffTotals ? String(staffTotals.totalMissed) : '—'} />
            </div>
            <p className="mt-2 text-[10.5px] text-t3 leading-relaxed">
              {staffReady
                ? `Averaged across ${staffRecords.length} recorded staff profile${staffRecords.length === 1 ? '' : 's'}.`
                : staffState === 'error'
                  ? 'Staff records could not be loaded. These are not measurements of zero.'
                  : 'No staff profiles are recorded for this clinic, so there is nothing to average. These are not measurements of zero.'}
            </p>
          </BentoCard>

          {underperformers.length > 0 && (
            <BentoCard title="Coaching Recommendations" subtitle="For underperforming staff" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
              <div className="space-y-3">
                {underperformers.map(member => (
                  <div key={member.id} className="p-3.5 rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)]">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-xs font-bold text-t1">{member.name}</p>
                      <span className="badge badge-amber">{member.bookingConversionRate}% conv.</span>
                    </div>
                    <div className="space-y-1 mb-3">
                      <div className="flex justify-between text-[10px] text-t3">
                        <span>Booking conversion</span><span className="font-semibold">{member.bookingConversionRate}%</span>
                      </div>
                      <ProgressBar value={member.bookingConversionRate} size="xs" />
                      <div className="flex justify-between text-[10px] text-t3">
                        <span>Response time</span><span className="font-semibold">{member.responseTime} min</span>
                      </div>
                      <ProgressBar value={Math.max(0, 100 - (member.responseTime * 10))} size="xs" />
                    </div>
                    <p className="text-[11px] text-t2 mb-2">
                      Coaching prompt: confirm the patient's identity, review the documented service context, and offer only an available time slot.
                    </p>
                    <button type="button" onClick={() => navigate('/autopilot')} className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo hover:opacity-80">
                      <Sparkles className="w-3 h-3" /> Open Autopilot <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </BentoCard>
          )}

          <div className="rounded-2xl border border-[var(--b1)] bg-[var(--red-soft)] p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-v shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-red-v">Response Threshold Review</p>
                <p className="text-xs text-t2 mt-0.5 leading-relaxed">
                  {responseThresholdExceptions.length > 0
                    ? `${responseThresholdExceptions.slice(0, 2).map(m => m.name).join(' and ')} exceed this page's 6-minute response-time review threshold in the loaded records. Review staffing and routing with the branch manager.`
                    : staffReady
                      ? "No loaded staff record exceeds this page's 6-minute response-time review threshold."
                      : 'Response-time records are unavailable, so no staff member can be assessed against the threshold.'}
                </p>
                {/* This button navigates. It does not switch routing on, so it no
                    longer says it does. */}
                <button type="button" onClick={() => navigate('/ai-receptionist')} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold badge badge-red px-3 py-1.5 rounded-lg hover:opacity-80 transition-colors">
                  <Phone className="w-3 h-3" /> Open AI Receptionist
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-2">
      <p className="text-sm font-bold text-t1 tabular-nums leading-none">{value}</p>
      <p className="text-[10px] text-t3 mt-1">{label}</p>
    </div>
  );
}

/** Real task creation: POST /v1/tasks. Requires staff:write, which the server re-checks. */
function NewTaskForm({ assignees, onCancel, onCreated }: {
  assignees: Assignee[]; onCancel: () => void; onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('medium');
  const [assignedToId, setAssignedToId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim().length < 2) { setError('Give the task a title of at least 2 characters.'); return; }
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          priority,
          ...(assignedToId ? { assignedToId } : {}),
          ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
        }),
      });
      await onCreated();
    } catch (e) {
      setError(errorText(e, 'The task was not created.'));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr]">
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Task</span>
          <input value={title} onChange={e => setTitle(e.target.value)} maxLength={240} placeholder="Call back the Tuesday no-shows"
            className="mt-1 w-full rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-sm text-t1 outline-none focus:border-indigo" />
        </label>
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Priority</span>
          <select value={priority} onChange={e => setPriority(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-sm text-t1 outline-none">
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Assign to</span>
          <select value={assignedToId} onChange={e => setAssignedToId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-sm text-t1 outline-none">
            <option value="">Leave unassigned</option>
            {assignees.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Due</span>
          <input type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-sm text-t1 outline-none" />
        </label>
      </div>
      {error && <p role="alert" className="text-[11px] font-semibold text-red-v">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 transition disabled:opacity-60">
          <Plus className="w-3.5 h-3.5" /> {saving ? 'Creating…' : 'Create task'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s2)] transition">Cancel</button>
      </div>
    </form>
  );
}
