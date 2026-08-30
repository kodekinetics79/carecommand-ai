import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, PhoneIncoming, PhoneOutgoing, X } from 'lucide-react';
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

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="h-full w-full max-w-md overflow-y-auto border-l border-[var(--b1)] bg-[var(--s2)] p-5 shadow-xl space-y-4 outline-none">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-bold text-t1 inline-flex items-center gap-2">
            {inbound ? <PhoneIncoming className="h-4 w-4 text-indigo" aria-hidden="true" /> : <PhoneOutgoing className="h-4 w-4 text-violet-v" aria-hidden="true" />}
            Call detail
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-t3 hover:bg-[var(--s3)]"><X className="h-4 w-4" /></button>
        </div>

        {state === 'loading' && (
          <p role="status" aria-busy="true" className="py-6 text-center text-xs text-t3">
            <Loader2 className="mr-1.5 inline h-4 w-4 animate-spin" aria-hidden="true" />Loading the call…
          </p>
        )}

        {state === 'error' && (
          <div role="alert" className="rounded-xl border border-red-v/40 bg-[var(--red-soft)] px-3 py-2.5 text-xs text-red-v">
            <p className="font-semibold">This call could not be opened.</p>
            <p className="mt-0.5">{failure?.message ?? 'The request did not complete.'} Nothing about the call is shown, because nothing was read.</p>
          </div>
        )}

        {state === 'ready' && call && (
          <div className="space-y-3 text-xs text-t2">
            <div className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-3 space-y-1">
              <p className="text-sm font-bold text-t1">{call.callerName ?? 'Unknown caller'}</p>
              <p className="text-[11px] text-t3">
                {formatEnumLabel(call.direction)} · {formatEnumLabel(call.outcome)} · {formatCallDuration(call.durationSeconds)}
              </p>
              <p className="text-[11px] text-t3">{formatClinicDateTime(call.startedAt ?? call.createdAt, tz) || 'Start time not recorded'} ({tz})</p>
            </div>

            <section aria-label="What the AI recorded" className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wide text-t3">What the AI recorded</p>
              <p className="rounded-xl border border-[var(--b1)] p-2.5 text-t2">
                {call.transcriptSummary ?? call.providerSummary?.text ?? 'No summary was recorded for this call.'}
              </p>
              <p className="text-[10px] text-t3">
                Source: {call.providerSummary ? 'provider call analysis' : call.transcriptSummary ? 'stored call summary' : 'none stored'}.
              </p>
            </section>

            <section aria-label="Transcript" className="rounded-xl border border-amber-v/40 bg-[var(--amber-soft)] p-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Transcript</p>
              <p className="mt-1 text-[11px] text-t2">
                Word-for-word transcripts are not retained in this release. What the AI was permitted to say is fixed by the
                deployed prompt; what it recorded about this call is the summary above. Do not read the absence of a
                transcript as an empty call.
              </p>
            </section>

            <section aria-label="Consent and recording" className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Consent and recording</p>
              <p>Recording consent: {call.recordingConsentStatus ? formatEnumLabel(String(call.recordingConsentStatus)) : 'not recorded'}</p>
              <p>
                Recording: {call.recordingAccess === 'available' ? 'an authorized link exists'
                  : call.recordingAccess === 'restricted' ? 'exists, but your role cannot open it'
                    : call.recordingAccess === 'purged' ? 'purged under the retention workflow'
                      : 'none stored'}
              </p>
            </section>

            <section aria-label="What this call produced" className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wide text-t3">What this call produced</p>
              {call.appointments?.length
                ? call.appointments.map(item => <p key={item.id}>Appointment: {item.service} · {formatClinicDateTime(item.startsAt, tz)} · {formatEnumLabel(item.status)}</p>)
                : <p className="text-t3">No appointment was booked on this call.</p>}
              {call.appointmentRequests?.length
                ? call.appointmentRequests.map(item => <p key={item.id}>Request: {item.requestedService ?? 'unspecified service'} · {formatEnumLabel(item.status)}</p>)
                : null}
              {(call.staffTasks ?? call.handoffReferences)?.length
                ? (call.staffTasks ?? call.handoffReferences)!.map(item => <p key={item.id}>Task: {item.title} · {formatEnumLabel(item.status)}</p>)
                : <p className="text-t3">No front-desk task was filed from this call.</p>}
            </section>

            <p className="text-[10px] text-t3">
              Review status: {formatEnumLabel(call.reviewStatus ?? 'UNREVIEWED')}.{' '}
              <a href={`/receptionist-studio?tab=activity&callId=${call.id}`} className="font-semibold text-indigo hover:underline">
                Open the full review in Studio
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
