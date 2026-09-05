import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, AlertCircle, Plus, UserPlus, CheckCircle2, PlayCircle, MapPin, ChevronDown } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { apiRequest } from '../lib/api';
import { mapStaffProfile, mapStaffTask, type ApiStaffProfile, type ApiStaffTask } from '../lib/apiAdapters';
import { normalizeTaskRow, TASK_OUTCOME_CODES, TASK_OUTCOME_LABEL, type TaskOutcomeCode } from '../lib/frontDesk';
import { clinicTimeToUtc, resolveTimezone } from '../lib/clinicTime';
import { formatClinicDateTime, formatRelativeDue } from '../lib/frontDeskTime';
import { ReceptionistTaskCard } from '../components/receptionist/ReceptionistTaskCard';
import { hasPermission } from '../lib/access';
import { useSession } from '../hooks/useSession';
import { getSelectedClinicId } from '../lib/session';
import type { StaffMember } from '../types';

type StaffView = StaffMember & { branch?: string; updatedAt: string };
type TaskView = ReturnType<typeof mapStaffTask>;
interface Assignee { id: string; displayName: string; role: string }
interface BranchOption { id: string; name: string; location: string; timezone: string; active: boolean }
interface TaskPage { data: ApiStaffTask[]; nextCursor: string | null }
interface StaffOverviewPage {
  data: ApiStaffProfile[];
  nextCursor: string | null;
  measurement: { source: string; automatedAggregation: boolean; limitation: string };
}

/** The page asks for this many tasks. Counts below are labelled as covering only these. */
const TASK_PAGE_SIZE = 100;

const statusStyles: Record<TaskView['status'], { label: string; badge: string }> = {
  open: { label: 'Open', badge: 'badge badge-blue' },
  'in-progress': { label: 'In Progress', badge: 'badge badge-amber' },
  completed: { label: 'Completed', badge: 'badge badge-emerald' },
  canceled: { label: 'Canceled', badge: 'badge badge-red' },
};

const priorityStyles = {
  critical: { badge: 'badge badge-red' },
  high: { badge: 'badge badge-red' },
  medium: { badge: 'badge badge-amber' },
  normal: { badge: 'badge badge-amber' },
  low: { badge: 'badge badge-blue' },
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
  const [branches, setBranches] = useState<BranchOption[]>([]);
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
  const [nextTaskCursor, setNextTaskCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [completionTask, setCompletionTask] = useState<{ id: string; title: string } | null>(null);
  const [completionOutcome, setCompletionOutcome] = useState<TaskOutcomeCode | ''>('');
  const [completionNote, setCompletionNote] = useState('');
  const [measurementNote, setMeasurementNote] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const response = await apiRequest<TaskPage>(`/v1/tasks?limit=${TASK_PAGE_SIZE}`);
      setTaskRows(extractRows(response));
      setNextTaskCursor(response.nextCursor);
      setTasksState('ready');
      setTasksError(null);
    } catch (error) {
      setTasksState('error');
      setTasksError(errorText(error, 'Unable to load the task queue'));
    }
  }, []);

  const loadMoreTasks = useCallback(async () => {
    if (!nextTaskCursor || loadingMore) return;
    setLoadingMore(true);
    setRowError(null);
    try {
      const response = await apiRequest<TaskPage>(`/v1/tasks?limit=${TASK_PAGE_SIZE}&cursor=${encodeURIComponent(nextTaskCursor)}`);
      setTaskRows(current => [...current, ...response.data.filter(row => !current.some(existing => existing.id === row.id))]);
      setNextTaskCursor(response.nextCursor);
    } catch (error) {
      setRowError(errorText(error, 'Unable to load the next tasks'));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextTaskCursor]);

  useEffect(() => {
    void (async () => { await loadTasks(); })();
  }, [loadTasks]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await apiRequest<StaffOverviewPage>('/v1/staff/overview?limit=100');
        if (!active) return;
        setStaffRecords(extractRows(response).map(row => mapStaffProfile(row)));
        setMeasurementNote(response.measurement.limitation);
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
    let active = true;
    void (async () => {
      try {
        const response = await apiRequest<{ data: BranchOption[] }>('/v1/branches?limit=100');
        if (active) setBranches(response.data.filter(branch => branch.active));
      } catch {
        if (active) setBranches([]);
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
  const queueTruncated = tasksReady && Boolean(nextTaskCursor);

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

  const setStatus = (taskId: string, status: 'IN_PROGRESS') =>
    mutateTask(taskId, `/v1/staff/tasks/${taskId}/status`, { status }, 'Unable to update this task');

  const setAssignment = (taskId: string, assignedToId: string | null) =>
    mutateTask(taskId, `/v1/staff/tasks/${taskId}/assignment`, { assignedToId }, 'Unable to change who owns this task');

  async function completeGenericTask() {
    if (!completionTask || !completionOutcome) return;
    await mutateTask(
      completionTask.id,
      `/v1/staff/tasks/${completionTask.id}/status`,
      { status: 'COMPLETED', outcomeCode: completionOutcome, ...(completionNote.trim() ? { outcomeNote: completionNote.trim() } : {}) },
      'Unable to complete this task',
    );
    setCompletionTask(null);
    setCompletionOutcome('');
    setCompletionNote('');
  }

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
          branches={branches}
          initialBranchId={getSelectedClinicId() ?? user?.branchId ?? ''}
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
            subtitle={queueTruncated ? `${taskRecords.length} highest-priority due tasks loaded — more are available` : `${taskRecords.length} task${taskRecords.length === 1 ? '' : 's'} loaded for the selected clinic`}
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
                  <div key={task.id} className={`rounded-xl border border-[var(--b1)] p-3.5 transition-colors ${task.overdue ? 'bg-[var(--red-soft)]' : 'bg-white/80 hover:bg-white'}`}>
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-t1">{task.title}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <span className={priorityStyle.badge}>{task.priority}</span>
                          <span className={statusStyle.badge}>{statusStyle.label}</span>
                          <span className={`text-[10px] font-semibold ${task.overdue ? 'text-red-v' : 'text-t3'}`} title={formatClinicDateTime(task.dueAt, task.clinic?.timezone ?? viewerTimezone)}>
                            {formatRelativeDue(task.dueAt).label}
                          </span>
                          <span className="min-w-0 break-words text-[10px] text-t3">· {task.branch} · {task.assignee ?? 'Unassigned'}</span>
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
                        <button type="button" disabled={busy} onClick={() => { setCompletionTask({ id: task.id, title: task.title }); setCompletionOutcome(''); setCompletionNote(''); }}
                          className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[10px] font-semibold text-t2 hover:bg-[var(--s2)] transition disabled:opacity-50">
                          <CheckCircle2 className="w-3 h-3" /> Complete…
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
                          <label className="inline-flex min-w-0 w-full max-w-full items-center gap-1 text-[10px] text-t3 sm:w-auto">
                            <span className="sr-only">Assign “{task.title}” to</span>
                            <select
                              value={task.assignedToId ?? ''}
                              disabled={busy}
                              onChange={e => void setAssignment(task.id, e.target.value || null)}
                              className="min-w-0 w-full max-w-full rounded-lg border border-[var(--b1)] bg-transparent px-2 py-1 text-[10px] font-semibold text-t2 outline-none disabled:opacity-50 sm:w-auto sm:max-w-[14rem]"
                            >
                              <option value="">Unassigned</option>
                              {assignees.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
                            </select>
                          </label>
                        )}
                      </div>
                    )}
                    {completionTask?.id === task.id && (
                      <div className="mt-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3" role="group" aria-label={`Complete ${task.title}`}>
                        <p className="text-xs font-semibold text-t1">Record the outcome before closing</p>
                        <p className="mt-0.5 text-[10px] text-t3">Completion is final. Choose what happened so the next shift has an auditable handoff.</p>
                        <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,180px)_1fr]">
                          <select aria-label={`Outcome for ${task.title}`} value={completionOutcome} onChange={event => setCompletionOutcome(event.target.value as TaskOutcomeCode | '')}
                            className="rounded-lg border border-[var(--b1)] bg-white px-2.5 py-2 text-xs text-t1 outline-none">
                            <option value="">Choose outcome</option>
                            {TASK_OUTCOME_CODES.filter(code => code !== 'booked').map(code => <option key={code} value={code}>{TASK_OUTCOME_LABEL[code]}</option>)}
                          </select>
                          <input aria-label={`Completion note for ${task.title}`} value={completionNote} onChange={event => setCompletionNote(event.target.value)} maxLength={500}
                            placeholder="Optional handoff note" className="rounded-lg border border-[var(--b1)] bg-white px-2.5 py-2 text-xs text-t1 outline-none" />
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button type="button" disabled={!completionOutcome || busy} onClick={() => void completeGenericTask()} className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50">Confirm completion</button>
                          <button type="button" onClick={() => setCompletionTask(null)} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[10px] font-semibold text-t2">Keep open</button>
                        </div>
                      </div>
                    )}
                    {!terminal && !canWorkTasks && (
                      <p className="mt-2 text-[10px] text-t3">Your role can read this queue but not change a task.</p>
                    )}
                  </div>
                );
              })}
              {nextTaskCursor && (
                <div className="pt-2 text-center">
                  <button type="button" disabled={loadingMore} onClick={() => void loadMoreTasks()} className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--b1)] px-4 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50">
                    <ChevronDown className="h-3.5 w-3.5" /> {loadingMore ? 'Loading more…' : 'Load next 100 tasks'}
                  </button>
                </div>
              )}
            </div>
          </BentoCard>

          <BentoCard title="Recorded Staff Profile Snapshots" subtitle="Context only — no automated ranking">
            <div role="note" className="mb-3 rounded-xl border border-[var(--amber-soft)] bg-[var(--amber-soft)] px-3 py-2 text-[11px] leading-relaxed text-amber-v">
              {measurementNote ?? 'Measurement provenance is unavailable. Do not use these rows for staff evaluation.'}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--b1)]">
                    {['Staff Member', 'Clinic', 'Response Time', 'Conversion', 'Missed Calls', 'Follow-up', 'Last stored'].map(header => (
                      <th key={header} className="text-left py-2 px-2 text-[10px] font-bold uppercase tracking-widest text-t3 whitespace-nowrap">{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--b0)]">
                  {staffRecords.map(member => {
                    const branchName = member.branch ?? 'Branch not recorded';
                    return (
                      <tr key={member.id} className="hover:bg-[var(--s3)] transition-colors group">
                        <td className="py-2.5 px-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-[var(--indigo-soft)] flex items-center justify-center text-indigo text-[10px] font-bold shrink-0">
                              {member.name.split(' ').map(n => n[0]).join('')}
                            </div>
                            <div>
                              <p className="text-xs font-bold text-t1 group-hover:text-indigo transition-colors">{member.name}</p>
                              <p className="text-[10px] text-t3">{member.role}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 text-xs text-t3">{branchName}</td>
                        <td className="py-2.5 px-2 text-xs font-semibold text-t1">{member.responseTime} min</td>
                        <td className="py-2.5 px-2 text-xs font-bold text-t1">{member.bookingConversionRate}%</td>
                        <td className="py-2.5 px-2 text-xs font-semibold text-t2">{member.missedCalls}</td>
                        <td className="py-2.5 px-2 text-xs font-semibold text-t2">{member.followUpRate}%</td>
                        <td className="py-2.5 px-2 text-[10px] text-t3">{formatClinicDateTime(member.updatedAt, viewerTimezone)}</td>
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

          <BentoCard title="Measurement Status" subtitle="What this page can prove">
            <div className="space-y-2 text-xs text-t2">
              <p className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-v" /> Task counts and task states come from the live stored queue.</p>
              <p className="flex items-start gap-2"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-v" /> Staff response and conversion values are profile snapshots without an automated calculation pipeline.</p>
              <p className="text-[10.5px] leading-relaxed text-t3">Ranking, coaching, and threshold alerts remain unavailable until measurement periods, denominators, source events, and per-clinic shared-staff attribution are implemented.</p>
            </div>
          </BentoCard>
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
function NewTaskForm({ assignees: initialAssignees, branches, initialBranchId, onCancel, onCreated }: {
  assignees: Assignee[]; branches: BranchOption[]; initialBranchId: string; onCancel: () => void; onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('medium');
  const [assignedToId, setAssignedToId] = useState('');
  const [branchId, setBranchId] = useState(() => initialBranchId || branches[0]?.id || '');
  const [clinicAssignees, setClinicAssignees] = useState(initialAssignees);
  const [dueAt, setDueAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim().length < 2) { setError('Give the task a title of at least 2 characters.'); return; }
    if (!branchId) { setError('Select the clinic that owns this task.'); return; }
    const branch = branches.find(option => option.id === branchId);
    if (!branch) { setError('The selected clinic is no longer available.'); return; }
    let dueInstant: Date | null = null;
    if (dueAt) {
      const [dateISO, time] = dueAt.split('T');
      dueInstant = clinicTimeToUtc(dateISO, time, branch.timezone);
      if (Number.isNaN(dueInstant.getTime())) { setError('Enter a valid due date and time.'); return; }
    }
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          priority,
          branchId,
          ...(assignedToId ? { assignedToId } : {}),
          ...(dueInstant ? { dueAt: dueInstant.toISOString() } : {}),
        }),
      });
      await onCreated();
    } catch (e) {
      setError(errorText(e, 'The task was not created.'));
      setSaving(false);
    }
  }

  async function changeBranch(nextBranchId: string) {
    setBranchId(nextBranchId);
    setAssignedToId('');
    try {
      const rows = await apiRequest<Assignee[]>(`/v1/staff/assignees?branchId=${encodeURIComponent(nextBranchId)}`);
      setClinicAssignees(rows);
    } catch {
      setClinicAssignees([]);
    }
  }

  const selectedBranch = branches.find(branch => branch.id === branchId);

  return (
    <form onSubmit={submit} className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 space-y-3">
      <div className="flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t2">
        <MapPin className="h-4 w-4 shrink-0 text-indigo" />
        <span className="font-semibold">Clinic-owned work</span>
        <span className="text-t3">A clinic is required; unscoped tasks are not shared across locations.</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[2fr_1fr_1fr_1fr_1fr]">
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
          <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Clinic</span>
          <select value={branchId} onChange={e => void changeBranch(e.target.value)} required
            className="mt-1 w-full rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-sm text-t1 outline-none">
            <option value="">Select clinic</option>
            {branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Assign to</span>
          <select value={assignedToId} onChange={e => setAssignedToId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-sm text-t1 outline-none">
            <option value="">Leave unassigned</option>
            {clinicAssignees.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Due</span>
          <input type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-sm text-t1 outline-none" />
          {selectedBranch && <span className="mt-1 block text-[9.5px] text-t3">{selectedBranch.timezone}</span>}
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
