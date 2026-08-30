import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Field, Select, TextArea, TextInput } from '../ui/Field';
import { receptionistApi as api, type OptOut } from '../../lib/receptionist';
import {
  frontDeskApi, type AppointmentRequestRow, type CallDirection, type CallLogDetail, type CallLogListRow,
  type CallLogSummary, type ReviewStatus,
} from '../../lib/frontDesk';
import { describeFailure, type ResourceFailure } from '../../lib/resourceState';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { notifyFrontDeskMutated } from '../../hooks/useFrontDeskPoll';
import { useSession } from '../../hooks/useSession';
import { hasPermission } from '../../lib/access';
import { resolveTimezone } from '../../lib/clinicTime';
import { formatCallDuration, formatClinicDateTime, formatClinicTime } from '../../lib/frontDeskTime';
import ModuleTabs from '../ui/ModuleTabs';
import { formatEnumLabel, maskedProviderId, outcomeBadge } from './helpers';
import { ConfirmedButton } from './shared';
import { BookItDialog } from './BookItDialog';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';

type ActivityPart = 'calls' | 'requests' | 'optouts';
type PartState = 'loading' | 'ready' | 'error';

const OUTCOMES = ['BOOKED', 'ESCALATED', 'NOT_INTERESTED', 'NO_ANSWER', 'VOICEMAIL', 'OPTED_OUT', 'FAILED', 'IN_PROGRESS'] as const;
const REVIEW_STATUSES: ReviewStatus[] = ['UNREVIEWED', 'DRAFT', 'REVIEWED', 'SIGNED_OFF'];
const PAGE_SIZE = 25;

interface CallFilters {
  direction: CallDirection | '';
  outcome: string[];
  reviewStatus: ReviewStatus[];
  handoff: 'open' | 'none' | '';
  from: string;
  to: string;
}

const DEFAULT_FILTERS: CallFilters = { direction: '', outcome: [], reviewStatus: [], handoff: '', from: '', to: '' };

// ===== Activity Panel ======================================================
//
// The Studio's record of what the agent actually did: the call queue (filtered
// the way a reviewer works it), the booking requests a caller is still waiting
// on, and the do-not-contact list. Every list settles on its own — a part that
// FAILED is named with a Retry, and never rendered as "nothing here".

export function ActivityPanel({ clinicId, timezone }: { clinicId: string; timezone?: string }) {
  const { user } = useSession();
  const canBook = hasPermission(user, 'appointment:write') && hasPermission(user, 'receptionist:booking-review');
  const canReview = hasPermission(user, 'receptionist:booking-review');
  const canSignOffRole = hasPermission(user, 'receptionist:manage');

  const [sub, setSub] = useState<ActivityPart>('calls');
  const [clinicTimezone, setClinicTimezone] = useState<string | null>(timezone ?? null);
  const tz = resolveTimezone(clinicTimezone);

  // --- Calls ---------------------------------------------------------------
  const [filters, setFilters] = useState<CallFilters>(DEFAULT_FILTERS);
  const [calls, setCalls] = useState<CallLogListRow[]>([]);
  const [callsState, setCallsState] = useState<PartState>('loading');
  const [callsFailure, setCallsFailure] = useState<ResourceFailure | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [summary, setSummary] = useState<CallLogSummary | null>(null);
  const [summaryFailure, setSummaryFailure] = useState<ResourceFailure | null>(null);

  const [selectedCall, setSelectedCall] = useState<CallLogDetail | null>(null);
  const [callDetailLoading, setCallDetailLoading] = useState(false);
  const [callDetailError, setCallDetailError] = useState<string | null>(null);
  const reviewState = useMutationState();
  const reviewSaving = isBusy(reviewState.state);
  const [noteSummary, setNoteSummary] = useState('');
  const [staffCorrection, setStaffCorrection] = useState('');
  const [callerIntent, setCallerIntent] = useState('');
  const [actionsTaken, setActionsTaken] = useState('');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [unresolvedActions, setUnresolvedActions] = useState('');
  const [dirty, setDirty] = useState(false);

  // --- Requests / opt-outs --------------------------------------------------
  const [requests, setRequests] = useState<AppointmentRequestRow[]>([]);
  const [requestsState, setRequestsState] = useState<PartState>('loading');
  const [requestsFailure, setRequestsFailure] = useState<ResourceFailure | null>(null);
  const [bookingRequest, setBookingRequest] = useState<AppointmentRequestRow | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const rejectState = useMutationState();

  const [optOuts, setOptOuts] = useState<OptOut[]>([]);
  const [optOutsState, setOptOutsState] = useState<PartState>('loading');
  const [optOutsFailure, setOptOutsFailure] = useState<ResourceFailure | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revocationReason, setRevocationReason] = useState('');
  const [revocationAcknowledged, setRevocationAcknowledged] = useState(false);
  const revocationState = useMutationState();
  const revocationPending = isBusy(revocationState.state);

  const callQuery = useMemo(() => ({
    clinicId,
    ...(filters.direction ? { direction: filters.direction } : {}),
    ...(filters.outcome.length ? { outcome: filters.outcome } : {}),
    ...(filters.reviewStatus.length ? { reviewStatus: filters.reviewStatus } : {}),
    ...(filters.handoff ? { handoff: filters.handoff } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    limit: PAGE_SIZE,
  }), [clinicId, filters]);

  const fetchCalls = useCallback(async (cursor?: string) => {
    try {
      const page = await frontDeskApi.listCallLogs({ ...callQuery, ...(cursor ? { cursor } : {}) });
      return { ok: true as const, page };
    } catch (error) {
      return { ok: false as const, failure: describeFailure(error) };
    }
  }, [callQuery]);

  const fetchSummary = useCallback(async () => {
    try {
      return { ok: true as const, data: await frontDeskApi.callLogSummary({ clinicId, ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}) }) };
    } catch (error) {
      return { ok: false as const, failure: describeFailure(error) };
    }
  }, [clinicId, filters.from, filters.to]);

  const fetchRequests = useCallback(async () => {
    try {
      const page = await frontDeskApi.listAppointmentRequests({ clinicId, status: ['PENDING_REVIEW', 'MISSING_INFO'], limit: 50 });
      return { ok: true as const, rows: page.data };
    } catch (error) {
      return { ok: false as const, failure: describeFailure(error) };
    }
  }, [clinicId]);

  const fetchOptOuts = useCallback(async () => {
    try {
      return { ok: true as const, rows: await api.listOptOuts() };
    } catch (error) {
      return { ok: false as const, failure: describeFailure(error) };
    }
  }, []);

  // Clinic timezone: every timestamp below is the clinic's, so when the caller
  // did not pass one it is resolved from the clinic record itself.
  useEffect(() => {
    if (timezone) { return; }
    let active = true;
    void (async () => {
      try {
        const clinics = await frontDeskApi.listClinics();
        if (active) setClinicTimezone(clinics.find(row => row.id === clinicId)?.timezone ?? null);
      } catch {
        // The panel still renders; timestamps fall back to the viewer's zone.
        if (active) setClinicTimezone(null);
      }
    })();
    return () => { active = false; };
  }, [clinicId, timezone]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [callResult, summaryResult] = await Promise.all([fetchCalls(), fetchSummary()]);
      if (!active) return;
      if (callResult.ok) {
        setCalls(callResult.page.data);
        setNextCursor(callResult.page.nextCursor);
        setCallsState('ready');
        setCallsFailure(null);
      } else {
        setCalls([]);
        setNextCursor(null);
        setCallsState('error');
        setCallsFailure(callResult.failure);
      }
      if (summaryResult.ok) { setSummary(summaryResult.data); setSummaryFailure(null); }
      else { setSummary(null); setSummaryFailure(summaryResult.failure); }
    })();
    return () => { active = false; };
  }, [fetchCalls, fetchSummary]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [requestResult, optOutResult] = await Promise.all([fetchRequests(), fetchOptOuts()]);
      if (!active) return;
      if (requestResult.ok) { setRequests(requestResult.rows); setRequestsState('ready'); setRequestsFailure(null); }
      else { setRequests([]); setRequestsState('error'); setRequestsFailure(requestResult.failure); }
      if (optOutResult.ok) { setOptOuts(optOutResult.rows); setOptOutsState('ready'); setOptOutsFailure(null); }
      else { setOptOuts([]); setOptOutsState('error'); setOptOutsFailure(optOutResult.failure); }
    })();
    return () => { active = false; };
  }, [fetchRequests, fetchOptOuts]);

  async function reloadCalls() {
    setCallsState('loading');
    const result = await fetchCalls();
    if (result.ok) {
      setCalls(result.page.data); setNextCursor(result.page.nextCursor); setCallsState('ready'); setCallsFailure(null);
    } else {
      setCalls([]); setNextCursor(null); setCallsState('error'); setCallsFailure(result.failure);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    const result = await fetchCalls(nextCursor);
    setLoadingMore(false);
    if (result.ok) {
      // Rows already on screen stay: a failed "load more" must not blank the page.
      setCalls(current => [...current, ...result.page.data]);
      setNextCursor(result.page.nextCursor);
    } else {
      setCallsFailure(result.failure);
    }
  }

  async function reloadRequests() {
    setRequestsState('loading');
    const result = await fetchRequests();
    if (result.ok) { setRequests(result.rows); setRequestsState('ready'); setRequestsFailure(null); }
    else { setRequests([]); setRequestsState('error'); setRequestsFailure(result.failure); }
  }

  async function reloadOptOuts() {
    setOptOutsState('loading');
    const result = await fetchOptOuts();
    if (result.ok) { setOptOuts(result.rows); setOptOutsState('ready'); setOptOutsFailure(null); }
    else { setOptOuts([]); setOptOutsState('error'); setOptOutsFailure(result.failure); }
  }

  function hydrateReview(call: CallLogDetail) {
    setNoteSummary(call.operationalNotes?.summary ?? '');
    setStaffCorrection(call.operationalNotes?.correction ?? '');
    setCallerIntent(call.operationalNotes?.callerIntent ?? '');
    setActionsTaken(call.operationalNotes?.actionsTaken.join('\n') ?? '');
    setFollowUpNotes(call.operationalNotes?.followUpNotes ?? '');
    setUnresolvedActions(call.unresolvedActionItems?.join('\n') ?? '');
    setDirty(false);
  }

  async function openCall(callId: string) {
    setCallDetailLoading(true); setCallDetailError(null); reviewState.reset();
    try {
      const detail = await frontDeskApi.getCallLog(callId);
      setSelectedCall(detail);
      hydrateReview(detail);
    } catch (error) {
      setSelectedCall(null);
      setCallDetailError(describeFailure(error).message);
    } finally {
      setCallDetailLoading(false);
    }
  }

  async function saveReview(operation: 'SAVE_DRAFT' | 'MARK_REVIEWED' | 'SIGN_OFF') {
    if (!selectedCall || selectedCall.reviewStatus === 'SIGNED_OFF') return;
    const unresolved = unresolvedActions.split('\n').map(value => value.trim()).filter(Boolean);
    await reviewState.run(async () => {
      await api.updateCallReview(selectedCall.id, {
        operation,
        expectedRevision: selectedCall.reviewRevision ?? 0,
        operationalNotes: {
          summary: noteSummary.trim() || null,
          correction: staffCorrection.trim() || null,
          callerIntent: callerIntent.trim() || null,
          actionsTaken: actionsTaken.split('\n').map(value => value.trim()).filter(Boolean),
          followUpNotes: followUpNotes.trim() || null,
        },
        unresolvedActionItems: unresolved,
        ...(operation === 'SIGN_OFF' && unresolved.length > 0 ? { acknowledgeUnresolvedActions: true as const } : {}),
      });
      const detail = await frontDeskApi.getCallLog(selectedCall.id);
      setSelectedCall(detail);
      hydrateReview(detail);
      await reloadCalls();
    }, { successMessage: operation === 'SAVE_DRAFT' ? 'Draft saved' : operation === 'MARK_REVIEWED' ? 'Marked reviewed' : 'Signed off' });
  }

  async function rejectRequest(id: string) {
    const reason = rejectReason.trim();
    if (reason.length < 5) return;
    const done = await rejectState.run(() => frontDeskApi.rejectAppointmentRequest(id, reason), { successMessage: 'Request rejected' });
    if (done) { setRejectingId(null); setRejectReason(''); notifyFrontDeskMutated(); await reloadRequests(); }
  }

  async function revokeOptOut() {
    if (!revokingId || revocationReason.trim().length < 5 || !revocationAcknowledged) return;
    const id = revokingId;
    const revoked = await revocationState.run(async () => {
      await api.revokeOptOut(id, revocationReason.trim());
      await reloadOptOuts();
      return true;
    }, { successMessage: 'Authorized reactivation recorded' });
    if (revoked) { setRevokingId(null); setRevocationReason(''); setRevocationAcknowledged(false); }
  }

  const touch = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setDirty(true); };
  const signedOff = selectedCall?.reviewStatus === 'SIGNED_OFF';
  // The server states whether this caller may edit the review; the role check is
  // only the fallback for a payload that predates the capability block.
  const canEdit = (selectedCall?.reviewCapabilities?.canEdit ?? canReview) && !signedOff;
  const canSignOff = (selectedCall?.reviewCapabilities?.canSignOff ?? canSignOffRole)
    && selectedCall?.reviewStatus === 'REVIEWED' && !dirty;
  const filtersActive = filters.direction !== '' || filters.outcome.length > 0 || filters.reviewStatus.length > 0
    || filters.handoff !== '' || filters.from !== '' || filters.to !== '';

  return (
    <div className="cc-card p-5 space-y-4">
      <div className="w-fit">
        <ModuleTabs
          tabs={[
            { id: 'calls', label: 'Call logs', ...(callsState === 'ready' ? { count: calls.length } : {}) },
            { id: 'requests', label: 'Appointments', ...(requestsState === 'ready' ? { count: requests.length } : {}) },
            { id: 'optouts', label: 'Do-not-contact', ...(optOutsState === 'ready' ? { count: optOuts.length } : {}) },
          ]}
          activeTab={sub}
          onChange={id => setSub(id as ActivityPart)}
          ariaLabel="Activity record type"
        />
      </div>

      {sub === 'calls' && (
        <div className="space-y-3">
          <section aria-label="Call queue filters" className="grid gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Direction">
              <Select value={filters.direction} aria-label="Direction"
                onChange={event => setFilters(current => ({ ...current, direction: event.target.value as CallDirection | '' }))}>
                <option value="">Any direction</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </Select>
            </Field>
            <Field label="Handoff">
              <Select value={filters.handoff} aria-label="Handoff"
                onChange={event => setFilters(current => ({ ...current, handoff: event.target.value as CallFilters['handoff'] }))}>
                <option value="">Any</option>
                <option value="open">Has an open handoff</option>
                <option value="none">No handoff</option>
              </Select>
            </Field>
            <Field label="From" hint={`Clinic date (${tz})`}>
              <TextInput type="date" value={filters.from} aria-label="From date"
                onChange={event => setFilters(current => ({ ...current, from: event.target.value }))} />
            </Field>
            <Field label="To">
              <TextInput type="date" value={filters.to} aria-label="To date"
                onChange={event => setFilters(current => ({ ...current, to: event.target.value }))} />
            </Field>
            <fieldset className="sm:col-span-2 lg:col-span-2">
              <legend className="text-[11px] font-bold uppercase tracking-wide text-t3">Outcome</legend>
              <div className="mt-1 flex flex-wrap gap-1">
                {OUTCOMES.map(outcome => {
                  const on = filters.outcome.includes(outcome);
                  return (
                    <button key={outcome} type="button" aria-pressed={on} aria-label={`Outcome ${formatEnumLabel(outcome)}`}
                      onClick={() => setFilters(current => ({
                        ...current,
                        outcome: on ? current.outcome.filter(value => value !== outcome) : [...current.outcome, outcome],
                      }))}
                      className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition ${on ? 'bg-indigo text-white' : 'text-t3 hover:bg-[var(--s2)]'}`}>
                      {formatEnumLabel(outcome)}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <fieldset className="sm:col-span-2 lg:col-span-2">
              <legend className="text-[11px] font-bold uppercase tracking-wide text-t3">Review status</legend>
              <div className="mt-1 flex flex-wrap gap-1">
                {REVIEW_STATUSES.map(status => {
                  const on = filters.reviewStatus.includes(status);
                  return (
                    <button key={status} type="button" aria-pressed={on} aria-label={`Review ${formatEnumLabel(status)}`}
                      onClick={() => setFilters(current => ({
                        ...current,
                        reviewStatus: on ? current.reviewStatus.filter(value => value !== status) : [...current.reviewStatus, status],
                      }))}
                      className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition ${on ? 'bg-indigo text-white' : 'text-t3 hover:bg-[var(--s2)]'}`}>
                      {formatEnumLabel(status)}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            {filtersActive && (
              <button type="button" onClick={() => setFilters(DEFAULT_FILTERS)} className="justify-self-start rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2">Clear filters</button>
            )}
          </section>

          {summaryFailure ? (
            <p role="alert" className="rounded-lg border border-red-v/40 bg-[var(--red-soft)] px-3 py-2 text-[11px] text-red-v">
              Queue counts could not be loaded, so none are shown. {summaryFailure.message}
            </p>
          ) : summary ? (
            <dl aria-label="Call queue counts" className="grid grid-cols-2 gap-2 sm:grid-cols-6">
              {([
                ['Unreviewed', summary.unreviewed], ['Open handoffs', summary.openHandoffs],
                ['Inbound', summary.inbound], ['Outbound', summary.outbound],
                ['Booked', summary.booked], ['Pending requests', summary.pendingRequests],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-2.5 py-2">
                  <dt className="text-[10px] text-t3">{label}</dt>
                  <dd className="text-sm font-bold text-t1 tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {callsState === 'loading' && (
            <p role="status" aria-busy="true" className="py-4 text-center text-xs text-t3"><Loader2 className="mr-1.5 inline h-4 w-4 animate-spin" />Loading the call queue…</p>
          )}
          {callsState === 'error' && (
            <LoadFailureNotice what="Call logs" message={callsFailure?.message ?? 'The request did not complete.'} onRetry={() => void reloadCalls()} />
          )}
          {callsState === 'ready' && calls.length === 0 && (
            <p className="py-4 text-center text-xs text-t3">
              {filtersActive ? 'No call matches these filters.' : 'No calls logged yet. Calls appear here via the RetellAI webhook.'}
            </p>
          )}
          {calls.map(call => (
            <button key={call.id} type="button" onClick={() => void openCall(call.id)}
              aria-label={`Open call with ${call.callerName ?? call.callerPhoneMasked ?? 'unknown caller'}`}
              className="flex w-full items-start justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5 text-left hover:bg-[var(--s3)]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-semibold text-t1">{call.callerName ?? call.callerPhoneMasked ?? 'Unknown caller'}</p>
                  <span className={outcomeBadge[call.outcome] ?? 'badge badge-blue'}>{formatEnumLabel(call.outcome)}</span>
                  {call.openHandoffCount > 0 && <span className="badge badge-red">{call.openHandoffCount} open handoff{call.openHandoffCount === 1 ? '' : 's'}</span>}
                  <span className="badge badge-amber">{formatEnumLabel(call.reviewStatus)}</span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-t3">{call.transcriptSummary ?? '—'}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[11px] font-semibold text-t2">{formatCallDuration(call.durationSeconds)}</p>
                <p className="text-[10px] text-t3">{formatClinicTime(call.startedAt ?? call.createdAt, tz)}</p>
              </div>
            </button>
          ))}
          {nextCursor && callsState === 'ready' && (
            <button type="button" disabled={loadingMore} onClick={() => void loadMore()}
              className="w-full rounded-xl border border-dashed border-[var(--b2)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">
              {loadingMore ? 'Loading…' : 'Load more calls'}
            </button>
          )}

          {callDetailLoading && <p role="status" className="py-3 text-center text-xs text-t3"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading permission-aware call detail…</p>}
          {callDetailError && <p role="alert" className="rounded-xl border border-red-v/30 bg-[var(--red-soft)] p-3 text-xs text-red-v">{callDetailError}</p>}
          {selectedCall && !callDetailLoading && (
            <section aria-label="Selected call operational review" className="space-y-4 rounded-2xl border border-[var(--b1)] bg-[var(--s3)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-t1">Call operational review</p>
                  <p className="text-[11px] text-t3">Provider analysis and staff-authored notes remain separately attributed.</p>
                </div>
                <span className={signedOff ? 'badge badge-emerald' : selectedCall.reviewStatus === 'REVIEWED' ? 'badge badge-blue' : 'badge badge-amber'}>
                  {formatEnumLabel(selectedCall.reviewStatus ?? 'UNREVIEWED')} · revision {selectedCall.reviewRevision ?? 0}
                </span>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Provider call analysis</p>
                  <p className="mt-1 text-xs text-t2">{selectedCall.providerSummary?.text ?? 'No provider-derived summary is stored.'}</p>
                  <p className="mt-2 text-[10px] text-t3">Source: {selectedCall.providerSummary ? 'provider call analysis' : 'not available'}{selectedCall.providerSummary?.sourceCallId ? ` · call ${maskedProviderId(selectedCall.providerSummary.sourceCallId)}` : ''}</p>
                </div>
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Recording access</p>
                  <p className="mt-1 text-xs text-t2">
                    {selectedCall.recordingAccess === 'available' ? 'An authorized HTTPS recording link is available.'
                      : selectedCall.recordingAccess === 'restricted' ? 'A recording exists, but your role cannot open it.'
                        : selectedCall.recordingAccess === 'purged' ? 'The recording was purged under the retention workflow.'
                          : 'No usable recording is stored.'}
                  </p>
                  {selectedCall.recordingAccess === 'available' && selectedCall.recordingUrl && (
                    <a href={selectedCall.recordingUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-xs font-semibold text-indigo hover:underline">Open authorized recording</a>
                  )}
                </div>
              </div>

              {!canEdit && !signedOff && (
                <p className="rounded-lg border border-[var(--b1)] bg-[var(--amber-soft)] p-2.5 text-[11px] font-semibold text-t2">
                  Your role can read this review but not edit it.
                </p>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Staff operational summary" hint="Staff-entered; does not overwrite provider analysis.">
                  <TextArea value={noteSummary} onChange={event => touch(setNoteSummary)(event.target.value)} maxLength={2000} disabled={!canEdit} />
                </Field>
                <Field label="Staff correction" hint="Record a verified correction to provider-derived analysis; the original remains visible.">
                  <TextArea value={staffCorrection} onChange={event => touch(setStaffCorrection)(event.target.value)} maxLength={2000} disabled={!canEdit} />
                </Field>
                <Field label="Caller intent" hint="Staff-entered interpretation; verify before sign-off.">
                  <TextArea value={callerIntent} onChange={event => touch(setCallerIntent)(event.target.value)} maxLength={500} disabled={!canEdit} />
                </Field>
                <Field label="Actions taken" hint="One action per line.">
                  <TextArea value={actionsTaken} onChange={event => touch(setActionsTaken)(event.target.value)} maxLength={6200} disabled={!canEdit} />
                </Field>
                <Field label="Follow-up notes" hint="Staff-entered operational context only.">
                  <TextArea value={followUpNotes} onChange={event => touch(setFollowUpNotes)(event.target.value)} maxLength={1000} disabled={!canEdit} />
                </Field>
              </div>
              <p className="rounded-lg border border-[var(--b1)] bg-[var(--amber-soft)] p-2.5 text-[11px] text-t2">
                Record minimum-necessary operational facts. Do not enter card data, Social Security numbers, passwords, diagnoses, clinical risk judgments, or speculative labels. Use the proper clinical record for authorized clinical documentation.
              </p>
              <Field label="Unresolved action items" hint="One open item per line. Signed-off reviews retain these items as unresolved evidence.">
                <TextArea value={unresolvedActions} onChange={event => touch(setUnresolvedActions)(event.target.value)} maxLength={6200} disabled={!canEdit} />
              </Field>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Appointments</p>
                  {selectedCall.appointments?.length
                    ? selectedCall.appointments.map(item => (
                      <p key={item.id} className="mt-1 text-xs text-t2">
                        <a href="/scheduling" className="font-semibold text-indigo hover:underline">{item.service}</a> · {formatClinicDateTime(item.startsAt, tz)} · {formatEnumLabel(item.status)}
                      </p>
                    ))
                    : <p className="mt-1 text-xs text-t3">No canonical appointment linked.</p>}
                </div>
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Appointment requests</p>
                  {selectedCall.appointmentRequests?.length
                    ? selectedCall.appointmentRequests.map(item => (
                      <p key={item.id} className="mt-1 text-xs text-t2">{item.requestedService ?? 'Unspecified service'} · {formatEnumLabel(item.status)}{item.requestedDateTime ? ` · ${formatClinicDateTime(item.requestedDateTime, tz)}` : ''}</p>
                    ))
                    : <p className="mt-1 text-xs text-t3">No appointment request linked.</p>}
                </div>
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Human handoffs</p>
                  {/* `staffTasks` is the C4 name; `handoffReferences` stays readable for one cycle. */}
                  {(selectedCall.staffTasks ?? selectedCall.handoffReferences)?.length
                    ? (selectedCall.staffTasks ?? selectedCall.handoffReferences)!.map(item => (
                      <p key={item.id} className="mt-1 text-xs text-t2"><a href="/front-desk" className="font-semibold text-indigo hover:underline">{item.title}</a> · {formatEnumLabel(item.status)}</p>
                    ))
                    : <p className="mt-1 text-xs text-t3">No human-handoff task linked.</p>}
                </div>
              </div>

              {selectedCall.operationalNotes && (
                <p className="text-[10px] text-t3">
                  Staff-note source: staff entered by {selectedCall.operationalNotes.actor?.displayName ?? `user ${selectedCall.operationalNotes.actorUserId}`} at {formatClinicDateTime(selectedCall.operationalNotes.recordedAt, tz)}.
                </p>
              )}
              {selectedCall.reviewedAt && <p className="text-[10px] text-t3">Reviewed by {selectedCall.reviewedBy?.displayName ?? 'recorded user'} at {formatClinicDateTime(selectedCall.reviewedAt, tz)}.</p>}
              {selectedCall.signedOffAt && <p className="text-[10px] text-t3">Final sign-off by {selectedCall.signedOffBy?.displayName ?? 'recorded manager'} at {formatClinicDateTime(selectedCall.signedOffAt, tz)}.</p>}
              <MutationNotice state={reviewState.state} />
              {!signedOff && canEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" disabled={reviewSaving} onClick={() => void saveReview('SAVE_DRAFT')} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2 disabled:opacity-50">Save draft</button>
                  <button type="button" disabled={reviewSaving} onClick={() => void saveReview('MARK_REVIEWED')} className="rounded-lg bg-indigo px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Mark reviewed</button>
                  {canSignOff && (
                    <ConfirmedButton
                      dialogTitle="Finalize manager sign-off?"
                      message={unresolvedActions.split('\n').some(value => value.trim())
                        ? 'Unresolved action items remain. Signing off preserves and explicitly acknowledges them as still open; the review becomes final.'
                        : 'Confirm that the staff notes and linked actions were reviewed. The signed-off review becomes final.'}
                      confirmLabel="Finalize sign-off"
                      tone="amber"
                      disabled={reviewSaving}
                      onConfirm={() => saveReview('SIGN_OFF')}
                      className="rounded-lg bg-emerald-v px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                    >Final manager sign-off</ConfirmedButton>
                  )}
                  {selectedCall.reviewStatus === 'REVIEWED' && dirty && (
                    <span className="text-[11px] font-semibold text-amber-v">Edits require re-review before sign-off.</span>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {sub === 'requests' && (
        <div className="space-y-2">
          {requestsState === 'loading' && <p role="status" aria-busy="true" className="py-4 text-center text-xs text-t3"><Loader2 className="mr-1.5 inline h-4 w-4 animate-spin" />Loading appointment requests…</p>}
          {requestsState === 'error' && (
            <LoadFailureNotice what="Appointment requests" message={requestsFailure?.message ?? 'The request did not complete.'} onRetry={() => void reloadRequests()} />
          )}
          {requestsState === 'ready' && requests.length === 0 && <p className="py-4 text-center text-xs text-t3">No appointment request is waiting for review.</p>}
          {requests.map(request => (
            <div key={request.id} aria-label={`Appointment request from ${request.collectedName ?? 'unknown caller'}`} className="space-y-2 rounded-xl border border-[var(--b1)] px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-t1">{request.collectedName ?? request.callLog?.callerName ?? 'Unknown caller'}</p>
                    <span className="badge badge-amber">{formatEnumLabel(request.status)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-t3">
                    {request.requestedService ?? 'Service not stated'}
                    {request.requestedDateTime ? ` · asked for ${formatClinicDateTime(request.requestedDateTime, tz)}` : ' · no preferred time'}
                    {request.collectedPhoneMasked ? ` · ${request.collectedPhoneMasked}` : ''}
                  </p>
                  {request.missingFields.length > 0 && <p className="text-[11px] text-amber-v">Missing: {request.missingFields.join(', ')}</p>}
                </div>
                <p className="shrink-0 text-[10px] text-t3">{formatClinicDateTime(request.createdAt, tz)}</p>
              </div>
              {canBook ? (
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setBookingRequest(request)} aria-label={`Book it for ${request.collectedName ?? 'this caller'}`}
                    className="rounded-lg bg-indigo px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90">Book it</button>
                  <button type="button" aria-expanded={rejectingId === request.id} aria-label={`Reject request from ${request.collectedName ?? 'this caller'}`}
                    onClick={() => { setRejectingId(current => current === request.id ? null : request.id); setRejectReason(''); rejectState.reset(); }}
                    className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]">Reject</button>
                </div>
              ) : (
                <p className="text-[10px] text-t3">Your role can read this request but not book or reject it.</p>
              )}
              {rejectingId === request.id && (
                <form onSubmit={event => { event.preventDefault(); void rejectRequest(request.id); }} className="space-y-1.5">
                  <Field label="Reason" required hint="The caller is owed a reason; it is stored with the request.">
                    <TextArea value={rejectReason} onChange={event => setRejectReason(event.target.value)} maxLength={1000} rows={2}
                      aria-label={`Reason for rejecting ${request.collectedName ?? 'this request'}`} />
                  </Field>
                  <button type="submit" disabled={isBusy(rejectState.state) || rejectReason.trim().length < 5}
                    className="rounded-lg bg-red-v px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-50">Reject request</button>
                  <MutationNotice state={rejectState.state} />
                </form>
              )}
            </div>
          ))}
        </div>
      )}

      {sub === 'optouts' && (
        <div className="space-y-2">
          {optOutsState === 'loading' && <p role="status" aria-busy="true" className="py-4 text-center text-xs text-t3"><Loader2 className="mr-1.5 inline h-4 w-4 animate-spin" />Loading do-not-contact records…</p>}
          {optOutsState === 'error' && (
            <LoadFailureNotice what="Do-not-contact records" message={optOutsFailure?.message ?? 'The request did not complete.'} onRetry={() => void reloadOptOuts()} />
          )}
          {optOutsState === 'ready' && optOuts.length === 0 && <p className="py-4 text-center text-xs text-t3">No do-not-contact records.</p>}
          <MutationNotice state={revocationState.state} showSaved={!revokingId} />
          {optOuts.map(record => (
            <div key={record.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <ShieldCheck className="h-4 w-4 shrink-0 text-violet-v" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-t1">{record.contactPhone ?? record.contactEmail}</p>
                  <p className="truncate text-[11px] text-t3">{record.channel} · {record.reason ?? 'No reason given'}</p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Review do-not-contact revocation"
                title="Review reactivation"
                onClick={() => { setRevokingId(record.id); setRevocationReason(''); setRevocationAcknowledged(false); revocationState.reset(); }}
                className="shrink-0 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)]"
              >Review reactivation</button>
            </div>
          ))}
          {revokingId && (
            <div role="dialog" aria-label="Revoke do-not-contact suppression" className="space-y-3 rounded-xl border border-red-v/40 bg-[var(--red-soft)] p-4">
              <div>
                <p className="text-sm font-bold text-t1">Reactivate contact permission</p>
                <p className="mt-1 text-xs text-t3">Owner or admin authorization is required. This preserves the original do-not-contact record and adds revocation evidence; it does not delete history.</p>
              </div>
              <Field label="Reason for reactivation" required hint="Record the verified patient request or other authorized basis (5–500 characters).">
                <TextArea value={revocationReason} onChange={event => setRevocationReason(event.target.value)} maxLength={500} placeholder="Verified patient requested contact reactivation on…" />
              </Field>
              <label className="flex items-start gap-2 text-xs text-t2">
                <input type="checkbox" checked={revocationAcknowledged} onChange={event => setRevocationAcknowledged(event.target.checked)} className="mt-0.5" />
                <span>I confirm the reactivation was authorized and understand outbound contact may resume after this durable revocation is recorded.</span>
              </label>
              <div className="flex gap-2">
                <button type="button" disabled={revocationPending || revocationReason.trim().length < 5 || !revocationAcknowledged} onClick={() => void revokeOptOut()} className="rounded-lg bg-red-v px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                  {revocationPending ? 'Recording…' : 'Record authorized reactivation'}
                </button>
                <button type="button" disabled={revocationPending} onClick={() => { setRevokingId(null); revocationState.reset(); }} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {bookingRequest && (
        <BookItDialog
          request={bookingRequest}
          timezone={tz}
          onClose={() => setBookingRequest(null)}
          onBooked={async () => { setBookingRequest(null); await reloadRequests(); await reloadCalls(); }}
        />
      )}
    </div>
  );
}
