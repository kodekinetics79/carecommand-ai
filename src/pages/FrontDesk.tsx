import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CalendarCheck2, Loader2, Phone, PhoneIncoming, PhoneOutgoing, Siren } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { Select } from '../components/ui/Field';
import { useSession } from '../hooks/useSession';
import { hasPermission } from '../lib/access';
import { useFrontDeskPoll, notifyFrontDeskMutated } from '../hooks/useFrontDeskPoll';
import { isBusy, useMutationState } from '../hooks/useMutationState';
import { describeFailure, type ResourceFailure } from '../lib/resourceState';
import { resolveTimezone } from '../lib/clinicTime';
import { formatCallDuration, formatClinicTime } from '../lib/frontDeskTime';
import {
  criticalSignal, frontDeskApi, normalizeTaskRow, openCountOf, summarizeNeedsAction,
  RECEPTIONIST_DEPLOYMENT_WORKFLOW, RECEPTIONIST_SAFETY_WORKFLOW,
  type AppointmentRequestRow, type CallLogListRow, type CallLogSummary, type FrontDeskTaskRow,
  type OverviewKpis, type ReceptionistTaskKind,
} from '../lib/frontDesk';
import type { Clinic } from '../lib/receptionist';
import { ReceptionistTaskCard, type TaskCardPermissions } from '../components/receptionist/ReceptionistTaskCard';
import { CriticalSignalBanner } from '../components/receptionist/CriticalSignalBanner';
import { ServiceStatusLane } from '../components/receptionist/ServiceStatusLane';
import { ShiftReport } from '../components/receptionist/ShiftReport';
import { CallDrawer } from '../components/receptionist/CallDrawer';
import { BookItDialog } from '../components/receptionist/BookItDialog';
import { AfterHoursCard } from '../components/receptionist/AfterHoursCard';
import { MutationNotice } from '../components/receptionist/MutationNotice';
import { formatEnumLabel } from '../components/receptionist/helpers';

// ===========================================================================
// The front desk queue (design-C4 §3).
//
// Lanes of work a human still owes a caller, plus the recent calls that
// produced them. Every lane loads on its own and reports its own outcome: a
// lane that FAILED says so and offers a retry, and never renders as "nothing
// to do" — an empty queue and an unreachable queue are different facts.
//
// Day-2 corrections (E5, E11, E12, E13, E14 and SF-2):
//   - Service status is the FIRST lane. The task that says the receptionist is
//     off the air used to be filed under a workflow this page did not read.
//   - Every tile is a server count, never `rows.length`. A lane capped at 50
//     used to publish "50" beside a header badge showing more, which teaches
//     staff not to trust the queue — and the queue is the product.
//   - Lanes refresh on the SAME 20 s tick as the summary, so a lane and the
//     badge above it can never disagree by a poll interval.
//   - A truncated lane says "showing N of M" and offers Load more.
//   - Manual retries and refreshes carry a generation, so a response for the
//     clinic you just switched away from is dropped rather than painted under
//     the new clinic's heading and timezone.
//   - A call can be opened and read.
// ===========================================================================

type LaneState = 'loading' | 'ready' | 'error';

interface Source<T> {
  rows: T[];
  state: LaneState;
  failure: ResourceFailure | null;
  nextCursor: string | null;
  /** A background refresh that failed: the rows below are the last good ones. */
  refreshFailure: ResourceFailure | null;
}

const EMPTY: Source<never> = { rows: [], state: 'loading', failure: null, nextCursor: null, refreshFailure: null };

const EMERGENCY_KINDS: ReceptionistTaskKind[] = ['emergency'];
const CALLBACK_KINDS: ReceptionistTaskKind[] = ['message', 'human_handoff', 'missed_call'];
const TASK_PAGE = 50;
const REQUEST_PAGE = 25;
const CALL_PAGE = 20;

function LaneShell({ title, subtitle, total, shown, state, failure, refreshFailure, onRetry, emptyText, onLoadMore, loadingMore, children }: {
  title: string; subtitle: string;
  /** The authoritative count from the server. Null when it is not known. */
  total: number | null;
  /** How many rows this lane actually has in hand. */
  shown: number;
  state: LaneState;
  failure: ResourceFailure | null;
  refreshFailure: ResourceFailure | null;
  onRetry: () => void;
  emptyText: string;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  children: React.ReactNode;
}) {
  const truncated = total !== null && shown < total;
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-t1">{title}{state === 'ready' && total !== null ? ` (${total})` : ''}</h2>
          <p className="text-[11px] text-t3">{subtitle}</p>
        </div>
      </div>
      {state === 'loading' && (
        <p role="status" aria-live="polite" aria-busy="true" className="rounded-xl border border-[var(--b1)] px-3 py-4 text-center text-xs text-t3">
          <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading {title.toLowerCase()}…
        </p>
      )}
      {state === 'error' && (
        <div role="alert" className="rounded-xl border border-red-v/40 bg-[var(--red-soft)] px-3 py-2.5 text-xs text-red-v">
          <p className="font-semibold">{title} could not be loaded.</p>
          <p className="mt-0.5">{failure?.message ?? 'The request did not complete.'} Do not read this as an empty queue.</p>
          <button type="button" onClick={onRetry} className="mt-1.5 rounded-lg border border-red-v/40 px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--s2)]">Retry</button>
        </div>
      )}
      {state === 'ready' && refreshFailure && (
        <p role="status" className="rounded-lg border border-amber-v/40 bg-[var(--amber-soft)] px-2.5 py-1.5 text-[11px] font-semibold text-t2">
          The last refresh of {title.toLowerCase()} failed ({refreshFailure.message}). These rows may be out of date.
        </p>
      )}
      {state === 'ready' && shown === 0 && <p className="rounded-xl border border-[var(--b1)] px-3 py-4 text-center text-xs text-t3">{emptyText}</p>}
      {state === 'ready' && shown > 0 && <div className="space-y-2">{children}</div>}
      {state === 'ready' && truncated && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2">
          <p className="text-[11px] text-t3">Showing {shown} of {total}.</p>
          {onLoadMore
            ? (
              <button type="button" disabled={loadingMore} onClick={onLoadMore}
                className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )
            : <p className="text-[11px] text-t3">The rest are not loadable from this lane.</p>}
        </div>
      )}
    </section>
  );
}

export default function FrontDesk() {
  const { user } = useSession();
  const canWork = hasPermission(user, 'staff:task-status');
  const canReadArtifacts = hasPermission(user, 'receptionist:call-artifacts:read');
  const canBook = hasPermission(user, 'appointment:write') && hasPermission(user, 'receptionist:booking-review');
  const canOpenStudio = hasPermission(user, 'receptionist:manage');
  const can: TaskCardPermissions = useMemo(
    () => ({ work: canWork, readArtifacts: canReadArtifacts, book: canBook }),
    [canWork, canReadArtifacts, canBook],
  );

  const [clinics, setClinics] = useState<Source<Clinic>>(EMPTY);
  const [clinicId, setClinicId] = useState('');
  const [tasks, setTasks] = useState<Source<FrontDeskTaskRow>>(EMPTY);
  const [deployment, setDeployment] = useState<Source<FrontDeskTaskRow>>(EMPTY);
  const [requests, setRequests] = useState<Source<AppointmentRequestRow>>(EMPTY);
  const [unreviewed, setUnreviewed] = useState<Source<CallLogListRow>>(EMPTY);
  const [recent, setRecent] = useState<Source<CallLogListRow>>(EMPTY);
  const [callSummary, setCallSummary] = useState<{ data: CallLogSummary | null; state: LaneState; failure: ResourceFailure | null }>({ data: null, state: 'loading', failure: null });
  const [kpis, setKpis] = useState<{ data: OverviewKpis | null; state: LaneState; failure: ResourceFailure | null }>({ data: null, state: 'loading', failure: null });
  const [bookingRequest, setBookingRequest] = useState<AppointmentRequestRow | null>(null);
  const [openCallId, setOpenCallId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const rejectState = useMutationState();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const summary = useFrontDeskPoll({ enabled: canReadArtifacts });
  const needsAction = summarizeNeedsAction(summary.state === 'ready' ? summary.data : null);
  const critical = criticalSignal(summary.state === 'ready' ? summary.data : null);

  const clinic = clinics.rows.find(row => row.id === clinicId) ?? clinics.rows[0] ?? null;
  const timezone = resolveTimezone(clinic?.timezone ?? null);

  /**
   * E14. Every manual path (retry, refresh-after-mutation, load-more) captures
   * the generation it started in. A clinic switch bumps it, so a response that
   * was already in flight cannot repaint clinic A's rows under clinic B's
   * heading — with clinic B's timezone formatting every timestamp.
   */
  const generation = useRef(0);

  // Each loader RETURNS its outcome instead of writing state, so the effects
  // below only ever setState after an await. `settled` turns a promise into a
  // Source: a rejection becomes an `error` state carrying the real cause, never
  // an empty list.
  async function settled<T>(load: () => Promise<{ data: T[]; nextCursor: string | null }>): Promise<Source<T>> {
    try {
      const page = await load();
      return { rows: page.data, state: 'ready', failure: null, nextCursor: page.nextCursor, refreshFailure: null };
    } catch (error) {
      return { rows: [], state: 'error', failure: describeFailure(error), nextCursor: null, refreshFailure: null };
    }
  }

  /**
   * A refresh must not blank a lane that is already showing good rows: a 20 s
   * background poll that fails is a staleness fact, not an emptiness fact.
   */
  function mergeRefresh<T>(current: Source<T>, next: Source<T>): Source<T> {
    if (next.state === 'ready') return next;
    if (current.state === 'ready') return { ...current, refreshFailure: next.failure };
    return next;
  }

  const fetchClinics = useCallback(() => settled(async () => ({ data: await frontDeskApi.listClinics(), nextCursor: null })), []);
  // NOTE: the task lanes are TENANT-wide, like the summary that counts them.
  // `/v1/tasks` has no clinicId filter yet (Package D14), so scoping them here
  // client-side would put a clinic-scoped lane under a tenant-wide tile. The
  // header says which surfaces the selector reaches rather than implying it
  // reaches all of them.
  // Every task row goes through `normalizeTaskRow`, which is what derives the
  // receptionist view from raw metadata when the server did not project one —
  // the case for the deployment-attention task until D9 lands.
  const fetchTasks = useCallback(
    (cursor?: string) => settled(async () => {
      const page = await frontDeskApi.listTasks({ workflow: RECEPTIONIST_SAFETY_WORKFLOW, status: ['OPEN', 'IN_PROGRESS'], limit: TASK_PAGE, cursor });
      return { data: page.data.map(normalizeTaskRow), nextCursor: page.nextCursor };
    }),
    [],
  );
  // D9 has not landed everywhere: the re-verify worker still files deployment
  // attention under its own workflow. Read that workflow too, so the Service
  // status lane is populated whether the task arrives in the old shape or the
  // new one. Rows are de-duplicated by id below.
  const fetchDeployment = useCallback(
    () => settled(async () => {
      const page = await frontDeskApi.listTasks({ workflow: RECEPTIONIST_DEPLOYMENT_WORKFLOW, status: ['OPEN', 'IN_PROGRESS'], limit: TASK_PAGE });
      return { data: page.data.map(normalizeTaskRow), nextCursor: page.nextCursor };
    }),
    [],
  );
  const fetchRequests = useCallback(
    (forClinic: string, cursor?: string) => settled(() => frontDeskApi.listAppointmentRequests({ clinicId: forClinic || undefined, status: ['PENDING_REVIEW', 'MISSING_INFO'], limit: REQUEST_PAGE, cursor })),
    [],
  );
  const fetchUnreviewed = useCallback(
    (forClinic: string, cursor?: string) => settled(() => frontDeskApi.listCallLogs({ clinicId: forClinic || undefined, reviewStatus: ['UNREVIEWED'], direction: 'inbound', limit: CALL_PAGE, cursor })),
    [],
  );
  const fetchRecent = useCallback(
    (forClinic: string) => settled(() => frontDeskApi.listCallLogs({ clinicId: forClinic || undefined, limit: 25 })),
    [],
  );

  const fetchCallSummary = useCallback(async (forClinic: string) => {
    try {
      // This count labels the inbound-only unreviewed lane below, so its server
      // denominator must carry the same direction filter. Without it the tile
      // counted every unreviewed outbound campaign call too, then told staff
      // those extra rows were mysteriously "not loadable from this lane".
      return { data: await frontDeskApi.callLogSummary({ clinicId: forClinic || undefined, direction: 'inbound' }), state: 'ready' as const, failure: null };
    } catch (error) {
      return { data: null, state: 'error' as const, failure: describeFailure(error) };
    }
  }, []);

  const fetchKpis = useCallback(async (forClinic: string) => {
    try {
      return { data: await frontDeskApi.overview({ clinicId: forClinic || undefined, period: 'today' }), state: 'ready' as const, failure: null };
    } catch (error) {
      return { data: null, state: 'error' as const, failure: describeFailure(error) };
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const next = await fetchClinics();
      if (!active) return;
      setClinics(next);
      if (next.state === 'ready') setClinicId(current => current || next.rows[0]?.id || '');
    })();
    return () => { active = false; };
  }, [fetchClinics]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [nextTasks, nextDeployment] = await Promise.all([fetchTasks(), fetchDeployment()]);
      if (!active) return;
      setTasks(nextTasks);
      setDeployment(nextDeployment);
    })();
    return () => { active = false; };
  }, [fetchTasks, fetchDeployment]);

  useEffect(() => {
    if (clinics.state === 'loading') return;
    let active = true;
    void (async () => {
      const [nextRequests, nextUnreviewed, nextRecent, nextCallSummary, nextKpis] = await Promise.all([
        fetchRequests(clinicId), fetchUnreviewed(clinicId), fetchRecent(clinicId), fetchCallSummary(clinicId), fetchKpis(clinicId),
      ]);
      if (!active) return;
      setRequests(nextRequests);
      setUnreviewed(nextUnreviewed);
      setRecent(nextRecent);
      setCallSummary(nextCallSummary);
      setKpis(nextKpis);
    })();
    return () => { active = false; };
  }, [clinicId, clinics.state, fetchRequests, fetchUnreviewed, fetchRecent, fetchCallSummary, fetchKpis]);

  /** Marks a source as loading from an EVENT (retry, clinic change) and re-fetches it. */
  const markLoading = <T,>(setter: React.Dispatch<React.SetStateAction<Source<T>>>) =>
    setter(current => ({ ...current, state: 'loading', refreshFailure: null }));

  const retry = useCallback(async (which: 'tasks' | 'deployment' | 'requests' | 'unreviewed' | 'recent') => {
    const at = generation.current;
    const guard = <T,>(setter: React.Dispatch<React.SetStateAction<Source<T>>>, next: Source<T>) => {
      if (at === generation.current) setter(next);
    };
    if (which === 'tasks') { markLoading(setTasks); guard(setTasks, await fetchTasks()); return; }
    if (which === 'deployment') { markLoading(setDeployment); guard(setDeployment, await fetchDeployment()); return; }
    if (which === 'requests') { markLoading(setRequests); guard(setRequests, await fetchRequests(clinicId)); return; }
    if (which === 'unreviewed') { markLoading(setUnreviewed); guard(setUnreviewed, await fetchUnreviewed(clinicId)); return; }
    markLoading(setRecent);
    guard(setRecent, await fetchRecent(clinicId));
  }, [fetchTasks, fetchDeployment, fetchRequests, fetchUnreviewed, fetchRecent, clinicId]);

  /**
   * Re-read everything. Used after a mutation and on every shared 20 s tick, so
   * the lanes and the header badge are always one observation of the same
   * moment rather than two observations 20 s apart.
   */
  const refreshAll = useCallback(async (options: { background?: boolean } = {}) => {
    const at = generation.current;
    const [nextTasks, nextDeployment, nextRequests, nextUnreviewed, nextRecent, nextCallSummary, nextKpis] = await Promise.all([
      fetchTasks(), fetchDeployment(), fetchRequests(clinicId), fetchUnreviewed(clinicId), fetchRecent(clinicId),
      fetchCallSummary(clinicId), fetchKpis(clinicId),
    ]);
    if (at !== generation.current) return;
    if (options.background) {
      setTasks(current => mergeRefresh(current, nextTasks));
      setDeployment(current => mergeRefresh(current, nextDeployment));
      setRequests(current => mergeRefresh(current, nextRequests));
      setUnreviewed(current => mergeRefresh(current, nextUnreviewed));
      setRecent(current => mergeRefresh(current, nextRecent));
    } else {
      setTasks(nextTasks);
      setDeployment(nextDeployment);
      setRequests(nextRequests);
      setUnreviewed(nextUnreviewed);
      setRecent(nextRecent);
    }
    if (nextCallSummary.state === 'ready' || !options.background) setCallSummary(nextCallSummary);
    if (nextKpis.state === 'ready' || !options.background) setKpis(nextKpis);
    if (!options.background) await summary.refresh();
  }, [fetchTasks, fetchDeployment, fetchRequests, fetchUnreviewed, fetchRecent, fetchCallSummary, fetchKpis, clinicId, summary]);

  /**
   * E13. The lanes ride the summary's own 20 s tick instead of loading once and
   * then sitting still: a live desk showing "3 need action · 1 critical" beside
   * an Emergencies lane showing 0 teaches staff not to trust the queue.
   */
  const lastTick = useRef<string | null>(null);
  const tick = summary.state === 'ready' ? summary.data?.generatedAt ?? null : null;
  useEffect(() => {
    if (!tick) return;
    if (lastTick.current === null) { lastTick.current = tick; return; }
    if (lastTick.current === tick) return;
    lastTick.current = tick;
    void refreshAll({ background: true });
    // `refreshAll` changes identity with the clinic; the tick is what drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  async function loadMore(which: 'tasks' | 'requests' | 'unreviewed') {
    const at = generation.current;
    const source = which === 'tasks' ? tasks : which === 'requests' ? requests : unreviewed;
    if (!source.nextCursor) return;
    setLoadingMore(which);
    const next = which === 'tasks' ? await fetchTasks(source.nextCursor)
      : which === 'requests' ? await fetchRequests(clinicId, source.nextCursor)
        : await fetchUnreviewed(clinicId, source.nextCursor);
    setLoadingMore(null);
    if (at !== generation.current) return;
    if (next.state !== 'ready') {
      // A failed "load more" must not blank the page it already has: it reports
      // the failure and leaves the rows and the cursor exactly where they were.
      const failure = next.failure;
      if (which === 'tasks') setTasks(current => ({ ...current, refreshFailure: failure }));
      else if (which === 'requests') setRequests(current => ({ ...current, refreshFailure: failure }));
      else setUnreviewed(current => ({ ...current, refreshFailure: failure }));
      return;
    }
    function append<T extends { id: string }>(current: Source<T>, incoming: T[], cursor: string | null): Source<T> {
      const known = new Set(current.rows.map(row => row.id));
      return {
        ...current,
        rows: [...current.rows, ...incoming.filter(row => !known.has(row.id))],
        nextCursor: cursor,
        refreshFailure: null,
      };
    }
    const cursor = next.nextCursor;
    if (which === 'tasks') setTasks(current => append(current, next.rows as FrontDeskTaskRow[], cursor));
    else if (which === 'requests') setRequests(current => append(current, next.rows as AppointmentRequestRow[], cursor));
    else setUnreviewed(current => append(current, next.rows as CallLogListRow[], cursor));
  }

  const kindOf = (task: FrontDeskTaskRow) => task.receptionist?.kind ?? null;
  // Both shapes, one lane, no duplicates.
  const deploymentRows = useMemo(() => {
    const seen = new Set<string>();
    return [...tasks.rows.filter(row => row.receptionist?.kind === 'deployment_attention'), ...deployment.rows].filter(row => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
  }, [tasks.rows, deployment.rows]);
  const deploymentState: LaneState = tasks.state === 'error' && deployment.state === 'error' ? 'error'
    : tasks.state === 'ready' || deployment.state === 'ready' ? 'ready'
      : 'loading';

  const emergencies = tasks.rows.filter(task => EMERGENCY_KINDS.includes(kindOf(task) as ReceptionistTaskKind));
  const callbacks = tasks.rows
    .filter(task => CALLBACK_KINDS.includes(kindOf(task) as ReceptionistTaskKind))
    .sort((left, right) => (left.dueAt ?? '9999').localeCompare(right.dueAt ?? '9999'));
  const otherTasks = tasks.rows.filter(task => {
    const kind = kindOf(task);
    return kind !== null && kind !== 'deployment_attention'
      && !EMERGENCY_KINDS.includes(kind as ReceptionistTaskKind) && !CALLBACK_KINDS.includes(kind as ReceptionistTaskKind);
  });

  // E13: one number per fact. Every tile and every lane header is a SERVER
  // count — `openByKind` for tasks, the call-log summary for calls and
  // requests. `rows.length` is what a page truncated to 50 knows, not what is
  // true, and publishing it as the count is how "Booking requests 50" appeared
  // beside a header badge showing 60.
  const summaryData = summary.state === 'ready' ? summary.data : null;
  const emergencyTotal = openCountOf(summaryData, EMERGENCY_KINDS);
  const callbackTotal = openCountOf(summaryData, CALLBACK_KINDS);
  const otherTotal = openCountOf(summaryData, ['call_denied', 'ai_declined', 'tool_failure', 'identity_locked', 'booking_review']);
  const requestTotal = callSummary.state === 'ready' ? callSummary.data?.pendingRequests ?? null : null;
  const unreviewedTotal = callSummary.state === 'ready' ? callSummary.data?.unreviewed ?? null : null;

  async function rejectRequest(id: string) {
    const reason = rejectReason.trim();
    if (reason.length < 5) return;
    const done = await rejectState.run(() => frontDeskApi.rejectAppointmentRequest(id, reason), { successMessage: 'Request rejected' });
    if (done) {
      setRejectingId(null);
      setRejectReason('');
      notifyFrontDeskMutated();
      await refreshAll();
    }
  }

  const headerBadge = !canReadArtifacts ? 'Restricted view'
    : summary.state === 'error' ? 'Queue unavailable'
      : summary.state === 'loading' ? 'Loading'
        : `${needsAction.count} need action · ${critical.count}${critical.exact ? '' : '+'} critical`;

  return (
    <div className="space-y-5 pb-8">
      <PageHeader
        title="Front Desk"
        subtitle="Every caller the AI could not finish with. A task stays open until a person closes it."
        badge={headerBadge}
        badgeColor={summary.state === 'error' ? 'red' : critical.count > 0 ? 'red' : 'blue'}
        actions={
          <div className="flex items-center gap-2">
            {clinics.rows.length > 1 && (
              <label className="text-[11px] text-t3">
                <span className="sr-only">Clinic</span>
                <Select
                  value={clinicId}
                  onChange={event => {
                    generation.current += 1;
                    setClinicId(event.target.value);
                    markLoading(setRequests); markLoading(setUnreviewed); markLoading(setRecent);
                    setCallSummary({ data: null, state: 'loading', failure: null });
                    setKpis({ data: null, state: 'loading', failure: null });
                  }}
                  aria-label="Clinic"
                >
                  {clinics.rows.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
                </Select>
              </label>
            )}
            {canOpenStudio && (
              <a href="/receptionist-studio" className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)]">Studio</a>
            )}
          </div>
        }
      />

      {clinics.rows.length > 1 && (
        <p className="text-[11px] text-t3">
          The clinic selector scopes calls, booking requests and the shift report. Task lanes and the header count are
          tenant-wide for every clinic you can see — the task list has no clinic filter yet, and a clinic-scoped lane
          under a tenant-wide count would be worse than saying so.
        </p>
      )}

      {summary.state === 'error' && (
        <div role="alert" className="rounded-2xl border border-red-v/40 bg-[var(--red-soft)] px-4 py-3 text-sm text-red-v">
          The queue summary could not be loaded, so no count or badge is shown. {summary.error?.message}
        </div>
      )}

      <ServiceStatusLane
        rows={deploymentRows}
        state={deploymentState}
        failure={deployment.failure ?? tasks.failure}
        timezone={timezone}
        can={can}
        onRetry={() => { void retry('deployment'); void retry('tasks'); }}
        onChanged={() => refreshAll()}
      />

      <CriticalSignalBanner
        summary={summaryData}
        timezone={timezone}
        canAcknowledge={canWork}
        onAcknowledged={() => refreshAll()}
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Emergencies" value={emergencyTotal ?? '—'} subtitle={emergencyTotal === null ? 'Unavailable' : 'Open and unresolved'} icon={<Siren className="h-4 w-4" />} accent="red" />
        <StatCard title="Callbacks due" value={callbackTotal ?? '—'} subtitle={callbackTotal === null ? 'Unavailable' : 'Messages and handoffs'} icon={<Phone className="h-4 w-4" />} accent="amber" />
        <StatCard title="Booking requests" value={requestTotal ?? '—'} subtitle={requestTotal === null ? 'Unavailable' : 'Waiting on review'} icon={<CalendarCheck2 className="h-4 w-4" />} accent="violet" />
        <StatCard title="Unreviewed calls" value={unreviewedTotal ?? '—'} subtitle={unreviewedTotal === null ? 'Unavailable' : 'Inbound, not yet read'} icon={<PhoneIncoming className="h-4 w-4" />} accent="blue" />
      </div>

      <ShiftReport
        kpis={kpis.data}
        state={kpis.state}
        failure={kpis.failure}
        summary={summaryData}
        timezone={timezone}
        onRetry={() => { void (async () => { setKpis({ data: null, state: 'loading', failure: null }); setKpis(await fetchKpis(clinicId)); })(); }}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <div className="space-y-5">
          <LaneShell
            title="Emergencies & urgent" subtitle="Acknowledge first — the AI cannot close these."
            total={tasks.state === 'ready' ? emergencyTotal ?? emergencies.length : null} shown={emergencies.length}
            state={tasks.state} failure={tasks.failure} refreshFailure={tasks.refreshFailure}
            onRetry={() => void retry('tasks')} emptyText="No emergency or urgent-clinical task is open."
            onLoadMore={tasks.nextCursor ? () => void loadMore('tasks') : undefined} loadingMore={loadingMore === 'tasks'}
          >
            {emergencies.map(task => (
              <ReceptionistTaskCard key={task.id} task={task} timezone={timezone} can={can} onChanged={() => refreshAll()}
                onOpenCall={setOpenCallId} />
            ))}
          </LaneShell>

          <LaneShell
            title="Callbacks due" subtitle="Messages, handoffs and missed calls, soonest due first."
            total={tasks.state === 'ready' ? callbackTotal ?? callbacks.length : null} shown={callbacks.length}
            state={tasks.state} failure={tasks.failure} refreshFailure={tasks.refreshFailure}
            onRetry={() => void retry('tasks')} emptyText="No caller is waiting on a callback."
            onLoadMore={tasks.nextCursor ? () => void loadMore('tasks') : undefined} loadingMore={loadingMore === 'tasks'}
          >
            {callbacks.map(task => (
              <ReceptionistTaskCard key={task.id} task={task} timezone={timezone} can={can} onChanged={() => refreshAll()}
                onOpenCall={setOpenCallId} />
            ))}
          </LaneShell>

          <LaneShell
            title="Booking requests" subtitle="A caller asked for a time. Nothing is booked until you book it."
            total={requests.state === 'ready' ? requestTotal ?? requests.rows.length : null} shown={requests.rows.length}
            state={requests.state} failure={requests.failure} refreshFailure={requests.refreshFailure}
            onRetry={() => void retry('requests')} emptyText="No booking request is waiting for review."
            onLoadMore={requests.nextCursor ? () => void loadMore('requests') : undefined} loadingMore={loadingMore === 'requests'}
          >
            {requests.rows.map(request => (
              <article key={request.id} aria-label={`Booking request from ${request.collectedName ?? 'unknown caller'}`} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3.5 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-t1 truncate">{request.collectedName ?? request.callLog?.callerName ?? 'Unknown caller'}</p>
                    <p className="text-[11px] text-t3">
                      {request.requestedService ?? 'Service not stated'}
                      {request.requestedDateTime ? ` · asked for ${formatClinicTime(request.requestedDateTime, timezone)}` : ' · no preferred time'}
                      {request.collectedPhoneMasked ? ` · ${request.collectedPhoneMasked}` : ''}
                    </p>
                    {request.missingFields.length > 0 && <p className="text-[11px] text-amber-v">Missing: {request.missingFields.join(', ')}</p>}
                  </div>
                  <span className="badge badge-amber shrink-0">{formatEnumLabel(request.status)}</span>
                </div>
                {canBook ? (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setBookingRequest(request)} aria-label={`Book it for ${request.collectedName ?? 'this caller'}`}
                      className="rounded-lg bg-indigo px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90">Book it</button>
                    <button type="button" onClick={() => { setRejectingId(current => current === request.id ? null : request.id); setRejectReason(''); rejectState.reset(); }}
                      aria-expanded={rejectingId === request.id} aria-label={`Reject request from ${request.collectedName ?? 'this caller'}`}
                      className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]">Reject</button>
                    {request.callLogId && (
                      <button type="button" onClick={() => setOpenCallId(request.callLogId!)} aria-label={`Open the call from ${request.collectedName ?? 'this caller'}`}
                        className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]">Open call</button>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] text-t3">Your role can read this request but not book or reject it.</p>
                )}
                {rejectingId === request.id && (
                  <form onSubmit={event => { event.preventDefault(); void rejectRequest(request.id); }} className="space-y-1.5">
                    <label className="block space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Reason <span className="text-red-v">*</span></span>
                      <textarea value={rejectReason} onChange={event => setRejectReason(event.target.value)} rows={2} maxLength={1000}
                        aria-label={`Reason for rejecting ${request.collectedName ?? 'this request'}`}
                        className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t1 outline-none focus:border-indigo" />
                    </label>
                    <button type="submit" disabled={isBusy(rejectState.state) || rejectReason.trim().length < 5}
                      className="rounded-lg bg-red-v px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-50">Reject request</button>
                    {rejectReason.trim().length < 5 && <p className="text-[10px] text-t3">A rejection needs a reason of at least 5 characters; the caller is owed one.</p>}
                  </form>
                )}
                <MutationNotice state={rejectingId === request.id ? rejectState.state : { status: 'idle' }} />
              </article>
            ))}
          </LaneShell>

          <LaneShell
            title="Unreviewed calls" subtitle="Inbound calls nobody has read yet. Open one to read what the AI recorded."
            total={unreviewed.state === 'ready' ? unreviewedTotal ?? unreviewed.rows.length : null} shown={unreviewed.rows.length}
            state={unreviewed.state} failure={unreviewed.failure} refreshFailure={unreviewed.refreshFailure}
            onRetry={() => void retry('unreviewed')} emptyText="Every inbound call has been reviewed."
            onLoadMore={unreviewed.nextCursor ? () => void loadMore('unreviewed') : undefined} loadingMore={loadingMore === 'unreviewed'}
          >
            {unreviewed.rows.map(call => <CallRow key={call.id} call={call} timezone={timezone} onOpen={setOpenCallId} />)}
          </LaneShell>

          {otherTasks.length > 0 && (
            <LaneShell
              title="Other receptionist tasks" subtitle="Refusals, tool failures and locked identities the agent recorded."
              total={tasks.state === 'ready' ? otherTotal ?? otherTasks.length : null} shown={otherTasks.length}
              state={tasks.state} failure={tasks.failure} refreshFailure={tasks.refreshFailure}
              onRetry={() => void retry('tasks')} emptyText="Nothing else is open."
              onLoadMore={tasks.nextCursor ? () => void loadMore('tasks') : undefined} loadingMore={loadingMore === 'tasks'}
            >
              {otherTasks.map(task => <ReceptionistTaskCard key={task.id} task={task} timezone={timezone} can={can} onChanged={() => refreshAll()} onOpenCall={setOpenCallId} />)}
            </LaneShell>
          )}
        </div>

        <div className="space-y-4">
          <BentoCard title="Recent calls" subtitle={clinic ? `${clinic.name} · ${timezone}` : 'All clinics'}>
            {recent.state === 'loading' && <p role="status" aria-busy="true" className="py-4 text-center text-xs text-t3"><Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading recent calls…</p>}
            {recent.state === 'error' && (
              <div role="alert" className="rounded-xl border border-red-v/40 bg-[var(--red-soft)] px-3 py-2 text-xs text-red-v">
                <p className="font-semibold">Recent calls could not be loaded.</p>
                <p className="mt-0.5">{recent.failure?.message}</p>
                <button type="button" onClick={() => void retry('recent')} className="mt-1.5 rounded-lg border border-red-v/40 px-2.5 py-1 text-[11px] font-semibold text-red-v">Retry</button>
              </div>
            )}
            {recent.state === 'ready' && recent.rows.length === 0 && <p className="py-4 text-center text-xs text-t3">No call has been recorded for this clinic yet.</p>}
            {recent.state === 'ready' && recent.rows.length > 0 && (
              <div className="space-y-2">{recent.rows.map(call => <CallRow key={call.id} call={call} timezone={timezone} onOpen={setOpenCallId} />)}</div>
            )}
          </BentoCard>

          <AfterHoursCard />

          <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
            <p className="text-xs font-bold text-t1 inline-flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5 text-amber-v" aria-hidden="true" /> How you are notified</p>
            <p className="mt-1 text-[11px] leading-relaxed text-t3">
              This page and the sidebar badge refresh every 20 seconds while a tab is open. There is no SMS, email, push or
              phone escalation for front-desk tasks in this release — if nobody has this open, nobody is alerted.
            </p>
          </div>
        </div>
      </div>

      {bookingRequest && (
        <BookItDialog
          request={bookingRequest}
          timezone={timezone}
          onClose={() => setBookingRequest(null)}
          onBooked={async () => { setBookingRequest(null); await refreshAll(); }}
        />
      )}

      {openCallId && (
        <CallDrawer callId={openCallId} timezone={timezone} onClose={() => setOpenCallId(null)} />
      )}
    </div>
  );
}

/**
 * One call in a list: direction, outcome, consent, handoff, review state —
 * masked phone only. It is a BUTTON: a lane called "Inbound calls nobody has
 * read yet" has to offer a way to read one (E5).
 */
function CallRow({ call, timezone, onOpen }: { call: CallLogListRow; timezone: string; onOpen: (callId: string) => void }) {
  const inbound = call.direction === 'inbound';
  const name = call.callerName ?? call.callerPhoneMasked ?? 'Unknown caller';
  return (
    <button
      type="button"
      onClick={() => onOpen(call.id)}
      aria-label={`Call with ${name}`}
      className="flex w-full items-start justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5 text-left hover:bg-[var(--s3)] focus:outline-none focus:ring-2 focus:ring-indigo"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {inbound ? <PhoneIncoming className="h-3.5 w-3.5 shrink-0 text-indigo" aria-label="Inbound" /> : <PhoneOutgoing className="h-3.5 w-3.5 shrink-0 text-violet-v" aria-label="Outbound" />}
          <p className="truncate text-sm font-semibold text-t1">{name}</p>
          {call.patient && <span className="badge badge-emerald shrink-0">Patient</span>}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-t3">{call.transcriptSummary ?? 'No summary recorded.'}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="badge badge-blue">{formatEnumLabel(call.outcome)}</span>
          {call.recordingConsentStatus && <span className="badge badge-violet">Consent: {formatEnumLabel(call.recordingConsentStatus)}</span>}
          {call.openHandoffCount > 0 && <span className="badge badge-red">{call.openHandoffCount} open handoff{call.openHandoffCount === 1 ? '' : 's'}</span>}
          {call.reviewStatus !== 'SIGNED_OFF' && <span className="badge badge-amber">{formatEnumLabel(call.reviewStatus)}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[11px] font-semibold text-t2">{formatCallDuration(call.durationSeconds)}</p>
        <p className="text-[10px] text-t3">{formatClinicTime(call.startedAt ?? call.createdAt, timezone)}</p>
      </div>
    </button>
  );
}
