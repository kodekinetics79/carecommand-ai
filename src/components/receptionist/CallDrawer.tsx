import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  ShieldAlert,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { frontDeskApi, type CallLogDetail } from '../../lib/frontDesk';
import { formatCallDuration, formatClinicDateTime } from '../../lib/frontDeskTime';
import { describeFailure, type ResourceFailure } from '../../lib/resourceState';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatEnumLabel } from './helpers';

// ===========================================================================
// Open a call from the Front Desk (E5).
//
// The lane is titled "Inbound calls nobody has read yet" and until today there
// was no way to read one: `CallRow` was a div, and `onOpenCall` was never
// passed to anything. This drawer is that missing read — it reuses the same
// audited detail fetch the Studio's Activity tab uses (`GET /call-logs/:id`),
// so no new endpoint and no new permission is involved.
//
// It does NOT show a transcript, because there is no transcript: the webhook
// persists `analysis.call_summary` and nothing else, and the transcript column
// is deferred. The drawer says that in plain words rather than leaving an empty
// panel that reads as "the AI said nothing".
// ===========================================================================

function getInitials(name?: string | null): string {
  if (!name || name === 'Unknown caller') return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

function getOutcomeBadgeClass(outcome?: string | null) {
  if (!outcome) return 'badge';
  const o = outcome.toLowerCase();
  if (o.includes('completed') || o.includes('resolved') || o.includes('booked')) {
    return 'badge-emerald';
  }
  if (o.includes('escalated') || o.includes('transferred')) {
    return 'badge-blue';
  }
  if (o.includes('opted_out') || o.includes('opted out') || o.includes('refused')) {
    return 'badge-amber';
  }
  if (o.includes('abandoned') || o.includes('failed') || o.includes('emergency')) {
    return 'badge-red';
  }
  return 'badge';
}

export function CallDrawer({ callId, timezone, onClose }: {
  callId: string;
  timezone: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [call, setCall] = useState<CallLogDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failure, setFailure] = useState<ResourceFailure | null>(null);

  useFocusTrap(dialogRef, { onClose });

  useEffect(() => {
    let active = true;
    void (async () => {
      setState('loading');
      setFailure(null);
      try {
        const detail = await frontDeskApi.getCallLog(callId);
        if (!active) return;
        setCall(detail);
        setState('ready');
      } catch (error) {
        if (!active) return;
        setCall(null);
        setFailure(describeFailure(error));
        setState('error');
      }
    })();
    return () => { active = false; };
  }, [callId]);

  const tz = timezone;
  const inbound = call?.direction === 'inbound';
  const callerDisplayName = call?.callerName ?? 'Unknown caller';

  const drawerElement = (
    <div
      className="fixed inset-0 z-[100] flex justify-end"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      {/* Backdrop overlay */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity animate-fade-in"
      />

      {/* Slide-out Drawer Panel */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-lg flex-col border-l border-[var(--b1)] bg-[var(--s1)] shadow-2xl animate-fade-up outline-none overflow-hidden z-10"
      >
        {/* Sticky Header */}
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--b1)] bg-[var(--s2)]/95 px-6 py-4.5 backdrop-blur-md">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
              inbound ? 'bg-[var(--indigo-soft)] text-indigo' : 'bg-purple-500/15 text-violet-v'
            }`}>
              {inbound ? (
                <PhoneIncoming className="h-5 w-5" aria-hidden="true" />
              ) : (
                <PhoneOutgoing className="h-5 w-5" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 id={titleId} className="text-base font-bold text-t1 tracking-tight truncate">
                  Call detail
                </h2>
                <span className="text-[10px] font-mono text-t3 px-1.5 py-0.5 rounded bg-[var(--s3)] border border-[var(--b1)]">
                  {callId.slice(-6)}
                </span>
              </div>
              <p className="text-xs text-t3 truncate">
                AI Receptionist Event Record
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-xl p-2 text-t3 hover:bg-[var(--s3)] hover:text-t1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--indigo)]"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {state === 'loading' && (
            <div role="status" aria-busy="true" className="flex flex-col items-center justify-center py-16 text-center text-xs text-t3">
              <Loader2 className="mb-3 h-7 w-7 animate-spin text-indigo" aria-hidden="true" />
              <p className="font-semibold text-t2">Loading the call…</p>
              <p className="text-[11px] text-t3 mt-0.5">Fetching audited call log details</p>
            </div>
          )}

          {state === 'error' && (
            <div role="alert" className="rounded-2xl border border-red-500/40 bg-[var(--red-soft)] p-4 text-xs text-red-v space-y-2">
              <div className="flex items-center gap-2 font-semibold text-sm">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-v" aria-hidden="true" />
                <span>This call could not be opened.</span>
              </div>
              <p className="leading-relaxed">
                {failure?.message ?? 'The request did not complete.'} Nothing about the call is shown, because nothing was read.
              </p>
            </div>
          )}

          {state === 'ready' && call && (
            <div className="space-y-4 text-xs text-t2">
              {/* Caller Profile Card */}
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 shadow-sm space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-[var(--b2)] text-sm font-bold text-t1">
                    {getInitials(call.callerName)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-bold text-t1 truncate leading-tight">
                      {callerDisplayName}
                    </h3>
                    <p className="text-[12px] text-t3 flex items-center gap-1.5 mt-0.5 font-mono">
                      <Phone className="h-3 w-3 text-t3" />
                      {call.callerPhoneMasked ?? 'Unlisted phone'}
                    </p>
                  </div>
                </div>

                {/* Metadata Badges */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[var(--b1)]">
                  <span className={`badge ${inbound ? 'badge-blue' : 'badge-purple'} inline-flex items-center gap-1`}>
                    {inbound ? <PhoneIncoming className="h-2.5 w-2.5" /> : <PhoneOutgoing className="h-2.5 w-2.5" />}
                    {formatEnumLabel(call.direction)}
                  </span>
                  <span className={`badge ${getOutcomeBadgeClass(call.outcome)}`}>
                    {formatEnumLabel(call.outcome)}
                  </span>
                  <span className="badge inline-flex items-center gap-1 text-t2">
                    <Clock className="h-2.5 w-2.5 text-t3" />
                    {formatCallDuration(call.durationSeconds)}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 text-[11px] text-t3">
                  <Calendar className="h-3 w-3 text-t3 shrink-0" />
                  <span>
                    {formatClinicDateTime(call.startedAt ?? call.createdAt, tz) || 'Start time not recorded'} ({tz})
                  </span>
                </div>
              </div>

              {/* What the AI recorded */}
              <section aria-label="What the AI recorded" className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 shadow-sm space-y-2.5">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-t3 inline-flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-indigo" />
                    What the AI recorded
                  </p>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--s3)] text-t3 border border-[var(--b1)]">
                    {call.providerSummary ? 'provider analysis' : 'stored summary'}
                  </span>
                </div>
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3 text-[13px] text-t1 leading-relaxed shadow-inner">
                  {call.transcriptSummary ?? call.providerSummary?.text ?? 'No summary was recorded for this call.'}
                </div>
                <p className="text-[10px] text-t3">
                  Source: {call.providerSummary ? 'provider call analysis' : call.transcriptSummary ? 'stored call summary' : 'none stored'}.
                </p>
              </section>

              {/* Transcript Policy Callout */}
              <section aria-label="Transcript" className="rounded-2xl border border-amber-500/30 bg-[var(--amber-soft)] p-4 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <ShieldAlert className="h-4 w-4 text-amber-v shrink-0" />
                  <p className="text-[11px] font-bold uppercase tracking-wider text-amber-v">
                    Transcript
                  </p>
                </div>
                <p className="text-[12px] text-t2 leading-relaxed">
                  Word-for-word transcripts are not retained in this release. What the AI was permitted to say is fixed by the
                  deployed prompt; what it recorded about this call is the summary above. Do not read the absence of a
                  transcript as an empty call.
                </p>
              </section>

              {/* Consent and Recording */}
              <section aria-label="Consent and recording" className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 shadow-sm space-y-2.5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-t3 inline-flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-t3" />
                  Consent and recording
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-[12px]">
                  <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-2.5">
                    <p className="text-[10px] uppercase font-semibold text-t3">Recording consent</p>
                    <p className="text-t1 font-medium mt-0.5">
                      {call.recordingConsentStatus ? formatEnumLabel(String(call.recordingConsentStatus)) : 'not recorded'}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-2.5">
                    <p className="text-[10px] uppercase font-semibold text-t3">Recording access</p>
                    <p className="text-t1 font-medium mt-0.5">
                      {call.recordingAccess === 'available' ? 'an authorized link exists'
                        : call.recordingAccess === 'restricted' ? 'exists, but your role cannot open it'
                          : call.recordingAccess === 'purged' ? 'purged under the retention workflow'
                            : 'none stored'}
                    </p>
                  </div>
                </div>
              </section>

              {/* What this call produced */}
              <section aria-label="What this call produced" className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 shadow-sm space-y-2.5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-t3 inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-v" />
                  What this call produced
                </p>
                <div className="space-y-2">
                  {call.appointments?.length ? (
                    call.appointments.map(item => (
                      <div key={item.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-2.5">
                        <div>
                          <p className="font-semibold text-t1 text-xs">Appointment: {item.service}</p>
                          <p className="text-[11px] text-t3">{formatClinicDateTime(item.startsAt, tz)}</p>
                        </div>
                        <span className="badge badge-emerald">{formatEnumLabel(item.status)}</span>
                      </div>
                    ))
                  ) : (
                    <p className="text-t3 text-xs">No appointment was booked on this call.</p>
                  )}

                  {call.appointmentRequests?.length ? (
                    call.appointmentRequests.map(item => (
                      <div key={item.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-2.5">
                        <p className="font-semibold text-t1 text-xs">Request: {item.requestedService ?? 'unspecified service'}</p>
                        <span className="badge badge-amber">{formatEnumLabel(item.status)}</span>
                      </div>
                    ))
                  ) : null}

                  {(call.staffTasks ?? call.handoffReferences)?.length ? (
                    (call.staffTasks ?? call.handoffReferences)!.map(item => (
                      <div key={item.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-2.5">
                        <p className="font-semibold text-t1 text-xs">Task: {item.title}</p>
                        <span className="badge badge-blue">{formatEnumLabel(item.status)}</span>
                      </div>
                    ))
                  ) : (
                    <p className="text-t3 text-xs">No front-desk task was filed from this call.</p>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>

        {/* Sticky Footer Action Bar */}
        {state === 'ready' && call && (
          <footer className="sticky bottom-0 z-10 border-t border-[var(--b1)] bg-[var(--s2)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-t3">
                <span>Review status: </span>
                <span className="font-semibold text-t1">{formatEnumLabel(call.reviewStatus ?? 'UNREVIEWED')}</span>
              </div>
              <a
                href={`/receptionist-studio?tab=activity&callId=${call.id}`}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--indigo)] px-4 py-2 text-xs font-semibold text-white shadow-sm hover:opacity-90 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--indigo)]"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open the full review in Studio
              </a>
            </div>
          </footer>
        )}
      </div>
    </div>
  );

  return createPortal(drawerElement, document.body);
}
