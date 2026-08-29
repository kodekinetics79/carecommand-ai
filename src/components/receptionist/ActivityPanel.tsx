import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Field, TextArea } from '../ui/Field';
import { receptionistApi as api, type CallLog, type AppointmentRequest, type OptOut } from '../../lib/receptionist';
import ModuleTabs from '../ui/ModuleTabs';
import { formatEnumLabel, maskedPhone, maskedProviderId, outcomeBadge } from './helpers';
import { ConfirmedButton } from './shared';

// ===== Activity Panel ======================================================

export function ActivityPanel({ clinicId }: { clinicId: string }) {
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [selectedCall, setSelectedCall] = useState<CallLog | null>(null);
  const [callDetailLoading, setCallDetailLoading] = useState(false);
  const [callDetailError, setCallDetailError] = useState<string | null>(null);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [noteSummary, setNoteSummary] = useState('');
  const [staffCorrection, setStaffCorrection] = useState('');
  const [callerIntent, setCallerIntent] = useState('');
  const [actionsTaken, setActionsTaken] = useState('');
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [unresolvedActions, setUnresolvedActions] = useState('');
  const [requests, setRequests] = useState<AppointmentRequest[]>([]);
  const [optOuts, setOptOuts] = useState<OptOut[]>([]);
  const [sub, setSub] = useState<'calls' | 'requests' | 'optouts'>('calls');
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revocationReason, setRevocationReason] = useState('');
  const [revocationAcknowledged, setRevocationAcknowledged] = useState(false);
  const [revocationPending, setRevocationPending] = useState(false);
  const [revocationError, setRevocationError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, r, o] = await Promise.all([api.listCallLogs(clinicId), api.listAppointmentRequests(clinicId), api.listOptOuts()]);
    setCalls(c); setRequests(r); setOptOuts(o);
  }, [clinicId]);

  useEffect(() => {
    let active = true;
    (async () => {
      const [c, r, o] = await Promise.all([api.listCallLogs(clinicId), api.listAppointmentRequests(clinicId), api.listOptOuts()]);
      if (!active) return;
      setCalls(c); setRequests(r); setOptOuts(o);
    })();
    return () => { active = false; };
  }, [clinicId]);

  function hydrateReview(call: CallLog) {
    setNoteSummary(call.operationalNotes?.summary ?? '');
    setStaffCorrection(call.operationalNotes?.correction ?? '');
    setCallerIntent(call.operationalNotes?.callerIntent ?? '');
    setActionsTaken(call.operationalNotes?.actionsTaken.join('\n') ?? '');
    setFollowUpNotes(call.operationalNotes?.followUpNotes ?? '');
    setUnresolvedActions(call.unresolvedActionItems?.join('\n') ?? '');
  }

  async function openCall(callId: string) {
    setCallDetailLoading(true); setCallDetailError(null); setReviewError(null);
    try {
      const detail = await api.getCallLog(callId);
      setSelectedCall(detail);
      hydrateReview(detail);
    } catch (error) {
      setSelectedCall(null);
      setCallDetailError(error instanceof Error ? error.message : 'Call detail could not be loaded.');
    } finally {
      setCallDetailLoading(false);
    }
  }

  async function saveReview(operation: 'SAVE_DRAFT' | 'MARK_REVIEWED' | 'SIGN_OFF') {
    if (!selectedCall || selectedCall.reviewStatus === 'SIGNED_OFF') return;
    const unresolved = unresolvedActions.split('\n').map(value => value.trim()).filter(Boolean);
    setReviewSaving(true); setReviewError(null);
    try {
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
      const detail = await api.getCallLog(selectedCall.id);
      setSelectedCall(detail);
      hydrateReview(detail);
      await load();
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'The call review could not be saved. Reload the call before retrying.');
    } finally {
      setReviewSaving(false);
    }
  }

  async function revokeOptOut() {
    if (!revokingId || revocationReason.trim().length < 5 || !revocationAcknowledged) return;
    setRevocationPending(true); setRevocationError(null);
    try {
      await api.revokeOptOut(revokingId, revocationReason.trim());
      setRevokingId(null); setRevocationReason(''); setRevocationAcknowledged(false);
      await load();
    } catch (error) {
      setRevocationError(error instanceof Error ? error.message : 'Do-not-contact revocation was denied.');
    } finally {
      setRevocationPending(false);
    }
  }

  return (
    <div className="cc-card p-5 space-y-4">
      <div className="w-fit">
        <ModuleTabs
          tabs={[
            { id: 'calls', label: 'Call logs', count: calls.length },
            { id: 'requests', label: 'Appointments', count: requests.length },
            { id: 'optouts', label: 'Do-not-contact', count: optOuts.length },
          ]}
          activeTab={sub}
          onChange={id => setSub(id as typeof sub)}
          ariaLabel="Activity record type"
        />
      </div>

      {sub === 'calls' && (
        <div className="space-y-2">
          {calls.length === 0 && <p className="text-xs text-t3 py-4 text-center">No calls logged yet. Calls appear here via the RetellAI webhook.</p>}
          {calls.map(call => (
            <button key={call.id} type="button" onClick={() => void openCall(call.id)} className="w-full flex items-start justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5 text-left hover:bg-[var(--s3)]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-t1 truncate">{call.callerName ?? maskedPhone(call.callerPhone)}</p>
                  <span className={outcomeBadge[call.outcome] ?? 'badge badge-blue'}>{formatEnumLabel(call.outcome)}</span>
                </div>
                <p className="text-[11px] text-t3 truncate mt-0.5">{call.transcriptSummary ?? '—'}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[11px] font-semibold text-t2">{Math.floor(call.durationSeconds / 60)}m {call.durationSeconds % 60}s</p>
                <p className="text-[10px] text-t3">{call.startedAt ? new Date(call.startedAt).toLocaleString() : ''}</p>
              </div>
            </button>
          ))}
          {callDetailLoading && <p role="status" className="text-xs text-t3 py-3 text-center"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading permission-aware call detail…</p>}
          {callDetailError && <p role="alert" className="rounded-xl border border-red-v/30 bg-[var(--red-soft)] p-3 text-xs text-red-v">{callDetailError}</p>}
          {selectedCall && !callDetailLoading && (
            <section aria-label="Selected call operational review" className="rounded-2xl border border-[var(--b1)] bg-[var(--s3)] p-4 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-t1">Call operational review</p>
                  <p className="text-[11px] text-t3">Provider analysis and staff-authored notes remain separately attributed.</p>
                </div>
                <span className={selectedCall.reviewStatus === 'SIGNED_OFF' ? 'badge badge-emerald' : selectedCall.reviewStatus === 'REVIEWED' ? 'badge badge-blue' : 'badge badge-amber'}>
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

              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Staff operational summary" hint="Staff-entered; does not overwrite provider analysis.">
                  <TextArea value={noteSummary} onChange={event => setNoteSummary(event.target.value)} maxLength={2000} disabled={selectedCall.reviewStatus === 'SIGNED_OFF'} />
                </Field>
                <Field label="Staff correction" hint="Record a verified correction to provider-derived analysis; the original remains visible.">
                  <TextArea value={staffCorrection} onChange={event => setStaffCorrection(event.target.value)} maxLength={2000} disabled={selectedCall.reviewStatus === 'SIGNED_OFF'} />
                </Field>
                <Field label="Caller intent" hint="Staff-entered interpretation; verify before sign-off.">
                  <TextArea value={callerIntent} onChange={event => setCallerIntent(event.target.value)} maxLength={500} disabled={selectedCall.reviewStatus === 'SIGNED_OFF'} />
                </Field>
                <Field label="Actions taken" hint="One action per line.">
                  <TextArea value={actionsTaken} onChange={event => setActionsTaken(event.target.value)} maxLength={6200} disabled={selectedCall.reviewStatus === 'SIGNED_OFF'} />
                </Field>
                <Field label="Follow-up notes" hint="Staff-entered operational context only.">
                  <TextArea value={followUpNotes} onChange={event => setFollowUpNotes(event.target.value)} maxLength={1000} disabled={selectedCall.reviewStatus === 'SIGNED_OFF'} />
                </Field>
              </div>
              <p className="rounded-lg border border-[var(--b1)] bg-[var(--amber-soft)] p-2.5 text-[11px] text-t2">
                Record minimum-necessary operational facts. Do not enter card data, Social Security numbers, passwords, diagnoses, clinical risk judgments, or speculative labels. Use the proper clinical record for authorized clinical documentation.
              </p>
              <Field label="Unresolved action items" hint="One open item per line. Signed-off reviews retain these items as unresolved evidence.">
                <TextArea value={unresolvedActions} onChange={event => setUnresolvedActions(event.target.value)} maxLength={6200} disabled={selectedCall.reviewStatus === 'SIGNED_OFF'} />
              </Field>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Appointments</p>
                  {selectedCall.appointments?.length ? selectedCall.appointments.map(item => <p key={item.id} className="mt-1 text-xs text-t2"><a href="/scheduling" className="font-semibold text-indigo hover:underline">{item.service}</a> · {new Date(item.startsAt).toLocaleString()} · {formatEnumLabel(item.status)}</p>) : <p className="mt-1 text-xs text-t3">No canonical appointment linked.</p>}
                </div>
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Appointment requests</p>
                  {selectedCall.appointmentRequests?.length ? selectedCall.appointmentRequests.map(item => <p key={item.id} className="mt-1 text-xs text-t2">{item.requestedService ?? 'Unspecified service'} · {formatEnumLabel(item.status)}{item.requestedDateTime ? ` · ${new Date(item.requestedDateTime).toLocaleString()}` : ''}</p>) : <p className="mt-1 text-xs text-t3">No appointment request linked.</p>}
                </div>
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Human handoffs</p>
                  {selectedCall.handoffReferences?.length ? selectedCall.handoffReferences.map(item => <p key={item.id} className="mt-1 text-xs text-t2"><a href="/staff" className="font-semibold text-indigo hover:underline">{item.title}</a> · {formatEnumLabel(item.status)}</p>) : <p className="mt-1 text-xs text-t3">No human-handoff task linked.</p>}
                </div>
              </div>

              {selectedCall.operationalNotes && <p className="text-[10px] text-t3">Staff-note source: staff entered by user {selectedCall.operationalNotes.actorUserId} at {new Date(selectedCall.operationalNotes.recordedAt).toLocaleString()}.</p>}
              {selectedCall.reviewedAt && <p className="text-[10px] text-t3">Reviewed by {selectedCall.reviewedBy?.displayName ?? 'recorded user'} at {new Date(selectedCall.reviewedAt).toLocaleString()}.</p>}
              {selectedCall.signedOffAt && <p className="text-[10px] text-t3">Final sign-off by {selectedCall.signedOffBy?.displayName ?? 'recorded manager'} at {new Date(selectedCall.signedOffAt).toLocaleString()}.</p>}
              {reviewError && <p role="alert" className="text-xs text-red-v">{reviewError}</p>}
              {selectedCall.reviewStatus !== 'SIGNED_OFF' && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={reviewSaving} onClick={() => void saveReview('SAVE_DRAFT')} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2 disabled:opacity-50">Save draft</button>
                  <button type="button" disabled={reviewSaving} onClick={() => void saveReview('MARK_REVIEWED')} className="rounded-lg bg-indigo px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Mark reviewed</button>
                  {selectedCall.reviewCapabilities?.canSignOff && (
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
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {sub === 'requests' && (
        <div className="space-y-2">
          {requests.length === 0 && <p className="text-xs text-t3 py-4 text-center">No appointment requests yet.</p>}
          {requests.map(req => (
            <div key={req.id} className="flex items-start justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-t1 truncate">{req.contactName ?? req.contactPhone ?? 'Unknown'}</p>
                  <span className={`badge ${req.status === 'CONFIRMED' ? 'badge-emerald' : req.status === 'CANCELED' ? 'badge-red' : 'badge-blue'}`}>{formatEnumLabel(req.status)}</span>
                </div>
                <p className="text-[11px] text-t3 truncate mt-0.5">{req.bookedSlot || `${req.requestedDate ?? ''} ${req.requestedTime ?? ''}`.trim() || req.appointmentType || '—'}</p>
              </div>
              <p className="text-[10px] text-t3 shrink-0">{new Date(req.createdAt).toLocaleDateString()}</p>
            </div>
          ))}
        </div>
      )}

      {sub === 'optouts' && (
        <div className="space-y-2">
          {optOuts.length === 0 && <p className="text-xs text-t3 py-4 text-center">No do-not-contact records.</p>}
          {optOuts.map(o => (
            <div key={o.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
              <div className="min-w-0 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-violet-v shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-t1 truncate">{o.contactPhone ?? o.contactEmail}</p>
                  <p className="text-[11px] text-t3 truncate">{o.channel} · {o.reason ?? 'No reason given'}</p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Review do-not-contact revocation"
                title="Review reactivation"
                onClick={() => { setRevokingId(o.id); setRevocationReason(''); setRevocationAcknowledged(false); setRevocationError(null); }}
                className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)] shrink-0"
              >Review reactivation</button>
            </div>
          ))}
          {revokingId && (
            <div role="dialog" aria-label="Revoke do-not-contact suppression" className="rounded-xl border border-red-v/40 bg-[var(--red-soft)] p-4 space-y-3">
              <div>
                <p className="text-sm font-bold text-t1">Reactivate contact permission</p>
                <p className="text-xs text-t3 mt-1">Owner or admin authorization is required. This preserves the original do-not-contact record and adds revocation evidence; it does not delete history.</p>
              </div>
              <Field label="Reason for reactivation" required hint="Record the verified patient request or other authorized basis (5–500 characters).">
                <TextArea value={revocationReason} onChange={event => setRevocationReason(event.target.value)} maxLength={500} placeholder="Verified patient requested contact reactivation on…" />
              </Field>
              <label className="flex items-start gap-2 text-xs text-t2">
                <input type="checkbox" checked={revocationAcknowledged} onChange={event => setRevocationAcknowledged(event.target.checked)} className="mt-0.5" />
                <span>I confirm the reactivation was authorized and understand outbound contact may resume after this durable revocation is recorded.</span>
              </label>
              {revocationError && <p role="alert" className="text-xs text-red-v">{revocationError}</p>}
              <div className="flex gap-2">
                <button type="button" disabled={revocationPending || revocationReason.trim().length < 5 || !revocationAcknowledged} onClick={() => void revokeOptOut()} className="rounded-lg bg-red-v px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                  {revocationPending ? 'Recording…' : 'Record authorized reactivation'}
                </button>
                <button type="button" disabled={revocationPending} onClick={() => { setRevokingId(null); setRevocationError(null); }} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
