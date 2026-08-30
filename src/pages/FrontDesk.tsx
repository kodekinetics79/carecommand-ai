import { useCallback, useEffect, useMemo, useState } from 'react';
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
  frontDeskApi, summarizeNeedsAction,
  type AppointmentRequestRow, type CallLogListRow, type FrontDeskTaskRow, type ReceptionistTaskKind,
} from '../lib/frontDesk';
import type { Clinic } from '../lib/receptionist';
import { ReceptionistTaskCard, type TaskCardPermissions } from '../components/receptionist/ReceptionistTaskCard';
import { CriticalSignalBanner } from '../components/receptionist/CriticalSignalBanner';
import { BookItDialog } from '../components/receptionist/BookItDialog';
import { AfterHoursSlot } from '../components/receptionist/AfterHoursSlot';
import { MutationNotice } from '../components/receptionist/MutationNotice';
import { formatEnumLabel } from '../components/receptionist/helpers';

// ===========================================================================
// The front desk queue (design-C4 §3).
//
// Four lanes of work a human still owes a caller, plus the recent calls that
// produced them. Every lane loads on its own and reports its own outcome: a
// lane that FAILED says so and offers a retry, and never renders as "nothing
// to do" — an empty queue and an unreachable queue are different facts.
// ===========================================================================

type LaneState = 'loading' | 'ready' | 'error';

interface Source<T> { rows: T[]; state: LaneState; failure: ResourceFailure | null }

const EMPTY: Source<never> = { rows: [], state: 'loading', failure: null };

const EMERGENCY_KINDS: ReceptionistTaskKind[] = ['emergency'];
const CALLBACK_KINDS: ReceptionistTaskKind[] = ['message', 'human_handoff', 'missed_call'];

function LaneShell({ title, subtitle, count, state, failure, onRetry, emptyText, children }: {
  title: string; subtitle: string; count: number | null; state: LaneState;
  failure: ResourceFailure | null; onRetry: () => void; emptyText: string; children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-t1">{title}{state === 'ready' && count !== null ? ` (${count})` : ''}</h2>
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
      {state === 'ready' && count === 0 && <p className="rounded-xl border border-[var(--b1)] px-3 py-4 text-center text-xs text-t3">{emptyText}</p>}
      {state === 'ready' && (count ?? 0) > 0 && <div className="space-y-2">{children}</div>}
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
  const [requests, setRequests] = useState<Source<AppointmentRequestRow>>(EMPTY);
  const [unreviewed, setUnreviewed] = useState<Source<CallLogListRow>>(EMPTY);
  const [recent, setRecent] = useState<Source<CallLogListRow>>(EMPTY);
  const [bookingRequest, setBookingRequest] = useState<AppointmentRequestRow | null>(null);
  const rejectState = useMutationState();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const summary = useFrontDeskPoll({ enabled: canReadArtifacts });
  const needsAction = summarizeNeedsAction(summary.state === 'ready' ? summary.data : null);

  const clinic = clinics.rows.find(row => row.id === clinicId) ?? clinics.rows[0] ?? null;
  const timezone = resolveTimezone(clinic?.timezone ?? null);

  // Each loader RETURNS its outcome instead of writing state, so the effects
  // below only ever setState after an await. `settled` turns a promise into a
  // Source: a rejection becomes an `error` state carrying the real cause, never
  // an empty list.
  async function settled<T>(load: () => Promise<T[]>): Promise<Source<T>> {
    try {
      return { rows: await load(), state: 'ready', failure: null };
    } catch (error) {
      return { rows: [], state: 'error', failure: describeFailure(error) };
    }
  }

  const fetchClinics = useCallback(() => settled(() => frontDeskApi.listClinics()), []);
  const fetchTasks = useCallback(
    () => settled(async () => (await frontDeskApi.listTasks({ workflow: 'receptionist_safety', status: ['OPEN', 'IN_PROGRESS'], limit: 100 })).data),
    [],
  );
  const fetchRequests = useCallback(
    (forClinic: string) => settled(async () => (await frontDeskApi.listAppointmentRequests({ clinicId: forClinic || undefined, status: ['PENDING_REVIEW', 'MISSING_INFO'], limit: 50 })).data),
    [],
  );
  const fetchUnreviewed = useCallback(
    (forClinic: string) => settled(async () => (await frontDeskApi.listCallLogs({ clinicId: forClinic || undefined, reviewStatus: ['UNREVIEWED'], direction: 'inbound', limit: 20 })).data),
    [],
  );
  const fetchRecent = useCallback(
    (forClinic: string) => settled(async () => (await frontDeskApi.listCallLogs({ clinicId: forClinic || undefined, limit: 25 })).data),
    [],
  );

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
      const next = await fetchTasks();
      if (active) setTasks(next);
    })();
    return () => { active = false; };
  }, [fetchTasks]);

  useEffect(() => {
    if (clinics.state === 'loading') return;
    let active = true;
    void (async () => {
      const [nextRequests, nextUnreviewed, nextRecent] = await Promise.all([
        fetchRequests(clinicId), fetchUnreviewed(clinicId), fetchRecent(clinicId),
      ]);
      if (!active) return;
      setRequests(nextRequests);
      setUnreviewed(nextUnreviewed);
      setRecent(nextRecent);
    })();
    return () => { active = false; };
  }, [clinicId, clinics.state, fetchRequests, fetchUnreviewed, fetchRecent]);

  /** Marks a source as loading from an EVENT (retry, clinic change) and re-fetches it. */
  const markLoading = <T,>(setter: React.Dispatch<React.SetStateAction<Source<T>>>) =>
    setter(current => ({ ...current, state: 'loading' }));

  const retry = useCallback(async (which: 'tasks' | 'requests' | 'unreviewed' | 'recent') => {
    if (which === 'tasks') { markLoading(setTasks); setTasks(await fetchTasks()); return; }
    if (which === 'requests') { markLoading(setRequests); setRequests(await fetchRequests(clinicId)); return; }
    if (which === 'unreviewed') { markLoading(setUnreviewed); setUnreviewed(await fetchUnreviewed(clinicId)); return; }
    markLoading(setRecent);
    setRecent(await fetchRecent(clinicId));
  }, [fetchTasks, fetchRequests, fetchUnreviewed, fetchRecent, clinicId]);

  const refreshAll = useCallback(async () => {
    const [nextTasks, nextRequests, nextUnreviewed, nextRecent] = await Promise.all([
      fetchTasks(), fetchRequests(clinicId), fetchUnreviewed(clinicId), fetchRecent(clinicId),
    ]);
    setTasks(nextTasks);
    setRequests(nextRequests);
    setUnreviewed(nextUnreviewed);
    setRecent(nextRecent);
    await summary.refresh();
  }, [fetchTasks, fetchRequests, fetchUnreviewed, fetchRecent, clinicId, summary]);

  const kindOf = (task: FrontDeskTaskRow) => task.receptionist?.kind ?? null;
  const emergencies = tasks.rows.filter(task => EMERGENCY_KINDS.includes(kindOf(task) as ReceptionistTaskKind));
  const callbacks = tasks.rows
    .filter(task => CALLBACK_KINDS.includes(kindOf(task) as ReceptionistTaskKind))
    .sort((left, right) => (left.dueAt ?? '9999').localeCompare(right.dueAt ?? '9999'));
  const otherTasks = tasks.rows.filter(task => {
    const kind = kindOf(task);
    return kind !== null && !EMERGENCY_KINDS.includes(kind as ReceptionistTaskKind) && !CALLBACK_KINDS.includes(kind as ReceptionistTaskKind);
  });

  async function rejectRequest(id: string) {
    const reason = rejectReason.trim();
    if (reason.length < 5) return;
    const done = await rejectState.run(() => frontDeskApi.rejectAppointmentRequest(id, reason), { successMessage: 'Request rejected' });
    if (done) {
      setRejectingId(null);
      setRejectReason('');
      notifyFrontDeskMutated();
      setRequests(await fetchRequests(clinicId));
    }
  }

  const headerBadge = !canReadArtifacts ? 'Restricted view'
    : summary.state === 'error' ? 'Queue unavailable'
      : summary.state === 'loading' ? 'Loading'
        : `${needsAction.count} need action · ${needsAction.critical} critical`;

  return (
    <div className="space-y-5 pb-8">
      <PageHeader
        title="Front Desk"
        subtitle="Every caller the AI could not finish with. A task stays open until a person closes it."
        badge={headerBadge}
        badgeColor={summary.state === 'error' ? 'red' : needsAction.critical > 0 ? 'red' : 'blue'}
        actions={
          <div className="flex items-center gap-2">
            {clinics.rows.length > 1 && (
              <label className="text-[11px] text-t3">
                <span className="sr-only">Clinic</span>
                <Select
                  value={clinicId}
                  onChange={event => {
                    setClinicId(event.target.value);
                    markLoading(setRequests); markLoading(setUnreviewed); markLoading(setRecent);
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

      {summary.state === 'error' && (
        <div role="alert" className="rounded-2xl border border-red-v/40 bg-[var(--red-soft)] px-4 py-3 text-sm text-red-v">
          The queue summary could not be loaded, so no count or badge is shown. {summary.error?.message}
        </div>
      )}

      <CriticalSignalBanner
        summary={summary.state === 'ready' ? summary.data : null}
        timezone={timezone}
        canAcknowledge={canWork}
        onAcknowledged={refreshAll}
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Emergencies" value={tasks.state === 'ready' ? emergencies.length : '—'} subtitle={tasks.state === 'ready' ? 'Open and unresolved' : 'Unavailable'} icon={<Siren className="h-4 w-4" />} accent="red" />
        <StatCard title="Callbacks due" value={tasks.state === 'ready' ? callbacks.length : '—'} subtitle={tasks.state === 'ready' ? 'Messages and handoffs' : 'Unavailable'} icon={<Phone className="h-4 w-4" />} accent="amber" />
        <StatCard title="Booking requests" value={requests.state === 'ready' ? requests.rows.length : '—'} subtitle={requests.state === 'ready' ? 'Waiting on review' : 'Unavailable'} icon={<CalendarCheck2 className="h-4 w-4" />} accent="violet" />
        <StatCard title="Unreviewed calls" value={unreviewed.state === 'ready' ? unreviewed.rows.length : '—'} subtitle={unreviewed.state === 'ready' ? 'Inbound, not yet read' : 'Unavailable'} icon={<PhoneIncoming className="h-4 w-4" />} accent="blue" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <div className="space-y-5">
          <LaneShell
            title="Emergencies & urgent" subtitle="Acknowledge first — the AI cannot close these."
            count={tasks.state === 'ready' ? emergencies.length : null} state={tasks.state} failure={tasks.failure}
            onRetry={() => void retry('tasks')} emptyText="No emergency or urgent-clinical task is open."
          >
            {emergencies.map(task => (
              <ReceptionistTaskCard key={task.id} task={task} timezone={timezone} can={can} onChanged={refreshAll} />
            ))}
          </LaneShell>

          <LaneShell
            title="Callbacks due" subtitle="Messages, handoffs and missed calls, soonest due first."
            count={tasks.state === 'ready' ? callbacks.length : null} state={tasks.state} failure={tasks.failure}
            onRetry={() => void retry('tasks')} emptyText="No caller is waiting on a callback."
          >
            {callbacks.map(task => (
              <ReceptionistTaskCard key={task.id} task={task} timezone={timezone} can={can} onChanged={refreshAll} />
            ))}
          </LaneShell>

          <LaneShell
            title="Booking requests" subtitle="A caller asked for a time. Nothing is booked until you book it."
            count={requests.state === 'ready' ? requests.rows.length : null} state={requests.state} failure={requests.failure}
            onRetry={() => void retry('requests')} emptyText="No booking request is waiting for review."
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
            title="Unreviewed calls" subtitle="Inbound calls nobody has read yet."
            count={unreviewed.state === 'ready' ? unreviewed.rows.length : null} state={unreviewed.state} failure={unreviewed.failure}
            onRetry={() => void retry('unreviewed')} emptyText="Every inbound call has been reviewed."
          >
            {unreviewed.rows.map(call => <CallRow key={call.id} call={call} timezone={timezone} />)}
          </LaneShell>

          {otherTasks.length > 0 && (
            <LaneShell
              title="Other receptionist tasks" subtitle="Refusals, tool failures and locked identities the agent recorded."
              count={otherTasks.length} state={tasks.state} failure={tasks.failure}
              onRetry={() => void retry('tasks')} emptyText="Nothing else is open."
            >
              {otherTasks.map(task => <ReceptionistTaskCard key={task.id} task={task} timezone={timezone} can={can} onChanged={refreshAll} />)}
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
              <div className="space-y-2">{recent.rows.map(call => <CallRow key={call.id} call={call} timezone={timezone} />)}</div>
            )}
          </BentoCard>

          <AfterHoursSlot clinicName={clinic?.name ?? null} />

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
    </div>
  );
}

/** One call in a list: direction, outcome, consent, handoff, review state — masked phone only. */
function CallRow({ call, timezone }: { call: CallLogListRow; timezone: string }) {
  const inbound = call.direction === 'inbound';
  const name = call.callerName ?? call.callerPhoneMasked ?? 'Unknown caller';
  return (
    <div aria-label={`Call with ${name}`} className="flex items-start justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
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
    </div>
  );
}
