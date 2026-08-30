import { useState } from 'react';
import { CheckCircle2, MessageSquarePlus, Phone, PhoneCall, CalendarPlus, ExternalLink, Siren, UserRound } from 'lucide-react';
import {
  frontDeskApi, isLiveTask, isRestrictedView, needsAcknowledgement,
  TASK_KIND_LABEL, TASK_OUTCOME_CODES, TASK_OUTCOME_LABEL,
  type FrontDeskTaskRow, type ReceptionistTaskView, type TaskOutcomeCode,
} from '../../lib/frontDesk';
import { formatClinicDateTime, formatClinicTime, formatRelativeDue } from '../../lib/frontDeskTime';
import { notifyFrontDeskMutated } from '../../hooks/useFrontDeskPoll';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { MutationNotice } from './MutationNotice';
import { formatEnumLabel } from './helpers';

export interface TaskCardPermissions {
  /** staff:task-status — acknowledge, note, complete. */
  work: boolean;
  /** receptionist:call-artifacts:read — see the caller view and reveal the number to dial. */
  readArtifacts: boolean;
  /** appointment:write + receptionist:booking-review — Book it. */
  book: boolean;
}

export interface ReceptionistTaskCardProps {
  task: FrontDeskTaskRow;
  /** Clinic zone for every timestamp on the card. */
  timezone: string;
  can: TaskCardPermissions;
  variant?: 'full' | 'compact';
  /** Called after any server-confirmed mutation, with the row the server returned when it sent one. */
  onChanged: (updated?: FrontDeskTaskRow) => void | Promise<void>;
  /** Present when the caller can open a Book-it dialog for the linked appointment request. */
  onBookIt?: (task: FrontDeskTaskRow, appointmentRequestId: string) => void;
  onOpenCall?: (callLogId: string) => void;
  now?: Date;
}

const priorityBadge: Record<string, string> = {
  critical: 'badge badge-red', high: 'badge badge-red', medium: 'badge badge-amber', normal: 'badge badge-amber', low: 'badge badge-blue',
};

const transferLabel: Record<ReceptionistTaskView['transferStatus'], string | null> = {
  not_attempted: null,
  attempted: 'Transfer attempted · not confirmed connected',
  connected: 'Transfer connected',
  failed: 'Transfer failed',
  unknown: 'Transfer outcome unknown',
};

/**
 * One receptionist task (message, handoff, emergency, …) as the front desk
 * works it. Used on the Front Desk lanes and in the Staff Tasks queue.
 *
 * Phones: the card only ever renders the MASKED numbers the list carries.
 * "Call back" fetches the task detail (the audited reveal for
 * receptionist:call-artifacts:read holders) and offers a `tel:` link whose
 * visible text is still the masked number.
 */
export function ReceptionistTaskCard({ task, timezone, can, variant = 'full', onChanged, onBookIt, onOpenCall, now = new Date() }: ReceptionistTaskCardProps) {
  const view = task.receptionist;
  const restricted = isRestrictedView(view);
  const full = view && !restricted ? view as ReceptionistTaskView : null;
  const live = isLiveTask(task.status);
  const tz = task.clinic?.timezone ?? timezone;

  const action = useMutationState();
  const busy = isBusy(action.state);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [doneOpen, setDoneOpen] = useState(false);
  const [outcomeCode, setOutcomeCode] = useState<TaskOutcomeCode | ''>('');
  const [outcomeNote, setOutcomeNote] = useState('');
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [dial, setDial] = useState<{ href: string; masked: string } | null>(null);
  const [dialNotice, setDialNotice] = useState<string | null>(null);

  const due = formatRelativeDue(task.dueAt, now);
  const callerName = full?.callerName ?? null;
  const kindLabel = view ? (view.kind === 'restricted' ? 'Receptionist task' : TASK_KIND_LABEL[view.kind]) : null;
  const isEmergency = view?.kind === 'emergency';
  const isUrgentClinical = full?.kind === 'emergency' && full.reasonCategory === 'urgent_clinical';
  const latest = full?.messages.length ? full.messages[full.messages.length - 1] : null;
  const earlier = full && full.messages.length > 1 ? full.messages.slice(0, -1) : [];
  const ackNeeded = needsAcknowledgement(view) && !task.acknowledgedAt && live;
  const ariaSubject = callerName ?? task.title;

  async function acknowledge() {
    const updated = await action.run(() => frontDeskApi.acknowledgeTask(task.id), { successMessage: 'Acknowledged' });
    if (updated) { notifyFrontDeskMutated(); await onChanged(updated); }
  }

  async function revealAndDial() {
    setDialNotice(null);
    const detail = await action.run(() => frontDeskApi.getTask(task.id), { successMessage: 'Number ready to dial' });
    if (!detail) return;
    const number = detail.contact?.callbackPhone ?? detail.contact?.requestedCallbackPhone ?? detail.contact?.verifiedPhone ?? null;
    if (!number) { setDialNotice('No callback number is on record for this task.'); return; }
    const digits = number.replace(/[^\d+]/g, '');
    setDial({ href: `tel:${digits}`, masked: full?.callbackPhoneMasked ?? `***-***-${digits.slice(-4)}` });
  }

  async function addNote() {
    const text = noteText.trim();
    if (text.length < 1) return;
    const updated = await action.run(() => frontDeskApi.addTaskNote(task.id, text), { successMessage: 'Note added' });
    if (updated) { setNoteText(''); setNoteOpen(false); notifyFrontDeskMutated(); await onChanged(updated); }
  }

  async function complete() {
    if (!outcomeCode) return;
    const updated = await action.run(() => frontDeskApi.setTaskStatus(task.id, {
      status: 'COMPLETED', outcomeCode, ...(outcomeNote.trim() ? { outcomeNote: outcomeNote.trim() } : {}),
    }), { successMessage: 'Done' });
    if (updated) { setDoneOpen(false); notifyFrontDeskMutated(); await onChanged(updated); }
  }

  const border = isEmergency ? 'border-l-red-500' : due.overdue ? 'border-l-amber-500' : 'border-l-[var(--b2)]';

  return (
    <article
      aria-label={`${kindLabel ?? 'Task'}: ${ariaSubject}`}
      className={`rounded-xl border border-l-2 border-[var(--b1)] ${border} ${isEmergency && ackNeeded ? 'bg-[var(--red-soft)]' : 'bg-[var(--s2)]'} p-3.5 space-y-2.5`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-t1 truncate flex items-center gap-1.5">
            {isEmergency && <Siren className="h-4 w-4 text-red-v shrink-0" aria-hidden="true" />}
            {restricted ? task.title : (callerName ?? 'Unknown caller')}
          </p>
          {!restricted && callerName && <p className="text-[11px] text-t3 truncate">{task.title}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {kindLabel && <span className={isEmergency ? 'badge badge-red' : 'badge badge-indigo'}>{isUrgentClinical ? 'Urgent (clinical)' : kindLabel}</span>}
            {full?.reasonCategory && !isUrgentClinical && <span className="badge badge-amber">{formatEnumLabel(full.reasonCategory)}</span>}
            <span className={priorityBadge[task.priority.toLowerCase()] ?? 'badge badge-blue'}>{task.priority.toLowerCase()}</span>
            {live && (
              <span className={`text-[10px] font-semibold ${due.overdue ? 'text-red-v' : 'text-t3'}`}>{due.label}</span>
            )}
            {!live && <span className="badge badge-emerald">{formatEnumLabel(task.status)}{task.outcomeCode ? ` · ${TASK_OUTCOME_LABEL[task.outcomeCode] ?? task.outcomeCode}` : ''}</span>}
          </div>
        </div>
        <div className="text-right shrink-0 space-y-1">
          {!restricted && (
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${task.patient ? 'text-emerald-v' : 'text-t3'}`}>
              <UserRound className="h-3 w-3" aria-hidden="true" />
              {task.patient ? `Known patient · ${task.patient.firstName} ${task.patient.lastName}` : 'Not linked to a patient'}
            </span>
          )}
          {task.acknowledgedAt ? (
            <p className="text-[10px] font-semibold text-emerald-v">Acknowledged{task.acknowledgedBy ? ` by ${task.acknowledgedBy.displayName}` : ''} {formatClinicTime(task.acknowledgedAt, tz)}</p>
          ) : needsAcknowledgement(view) && live ? (
            <p className="text-[10px] font-semibold text-red-v">Not yet acknowledged</p>
          ) : null}
          <p className="text-[10px] text-t3">{task.assignedTo?.displayName ?? 'Unassigned'}{task.branch ? ` · ${task.branch.name}` : ''}</p>
        </div>
      </header>

      {restricted ? (
        <p className="text-xs text-t3">Details restricted to front-desk roles.</p>
      ) : full && (
        <div className="space-y-1.5 text-xs text-t2">
          {latest ? (
            <p className="text-t1">“{latest.text}”{latest.recordedAt && <span className="text-t3"> · {formatClinicTime(latest.recordedAt, tz)}</span>}</p>
          ) : (
            <p className="text-t3">No message text was recorded.</p>
          )}
          {earlier.length > 0 && (
            <div>
              <button type="button" onClick={() => setEarlierOpen(open => !open)} aria-expanded={earlierOpen} className="text-[11px] font-semibold text-indigo hover:underline">
                {earlierOpen ? 'Hide earlier messages' : `${earlier.length} earlier message${earlier.length === 1 ? '' : 's'}`}
              </button>
              {earlierOpen && (
                <ul className="mt-1 space-y-1 border-l border-[var(--b1)] pl-2">
                  {earlier.map((message, index) => (
                    <li key={`${message.recordedAt}-${index}`} className="text-[11px] text-t2">“{message.text}” <span className="text-t3">· {formatClinicTime(message.recordedAt, tz)}</span></li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {variant === 'full' && (
            <>
              {full.hasRequestedPhone && full.requestedPhoneMasked && (
                <p>Asked to be called on <span className="font-mono">{full.requestedPhoneMasked}</span> <span className="text-t3">(unverified)</span>{full.verifiedPhoneMasked ? <span className="text-t3"> · called from {full.verifiedPhoneMasked}</span> : null}</p>
              )}
              {!full.hasRequestedPhone && full.callbackPhoneMasked && (
                <p>Callback number <span className="font-mono">{full.callbackPhoneMasked}</span></p>
              )}
              {full.callbackWindow && (
                <p>Callback window: {formatClinicDateTime(full.callbackWindow.start, full.callbackWindow.timezone || tz)} – {formatClinicDateTime(full.callbackWindow.end, full.callbackWindow.timezone || tz, { weekday: undefined, month: undefined, day: undefined })}</p>
              )}
              {transferLabel[full.transferStatus] && <p>{transferLabel[full.transferStatus]}{full.transferUpdatedAt ? ` · ${formatClinicTime(full.transferUpdatedAt, tz)}` : ''}</p>}
              {full.denialReason && <p>Refused: {formatEnumLabel(full.denialReason)}</p>}
              {full.toolName && <p>Tool: {full.toolName}</p>}
              {full.staffNotes.length > 0 && (
                <ul className="space-y-0.5 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-2.5 py-1.5">
                  {full.staffNotes.map((note, index) => (
                    <li key={`${note.at}-${index}`} className="text-[11px]"><span className="text-t3">{formatClinicTime(note.at, tz) || 'staff'}{note.byDisplayName ? ` · ${note.byDisplayName}` : ''}:</span> {note.text}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {task.outcomeNote && !live && <p className="text-t3">Outcome note: {task.outcomeNote}</p>}
        </div>
      )}

      {live && (
        <div className="flex flex-wrap items-center gap-2">
          {ackNeeded && can.work && (
            <button type="button" disabled={busy} onClick={() => void acknowledge()} aria-label={`Acknowledge ${ariaSubject}`}
              className="inline-flex items-center gap-1 rounded-lg bg-red-v px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Acknowledge
            </button>
          )}
          {!restricted && can.readArtifacts && (
            dial ? (
              <a href={dial.href} aria-label={`Dial ${ariaSubject} on ${dial.masked}`}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-v px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90">
                <PhoneCall className="h-3 w-3" aria-hidden="true" /> Dial {dial.masked}
              </a>
            ) : (
              <button type="button" disabled={busy} onClick={() => void revealAndDial()} aria-label={`Call back ${ariaSubject}`}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">
                <Phone className="h-3 w-3" aria-hidden="true" /> Call back
              </button>
            )
          )}
          {!restricted && can.book && full?.appointmentRequestId && onBookIt && (
            <button type="button" disabled={busy} onClick={() => onBookIt(task, full.appointmentRequestId!)} aria-label={`Book it for ${ariaSubject}`}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
              <CalendarPlus className="h-3 w-3" aria-hidden="true" /> Book it
            </button>
          )}
          {!restricted && task.callLogId && onOpenCall && (
            <button type="button" onClick={() => onOpenCall(task.callLogId!)} aria-label={`Open call for ${ariaSubject}`}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]">
              <ExternalLink className="h-3 w-3" aria-hidden="true" /> Open call
            </button>
          )}
          {can.work && (
            <>
              <button type="button" disabled={busy} onClick={() => { setNoteOpen(open => !open); setDoneOpen(false); }} aria-expanded={noteOpen} aria-label={`Add note to ${ariaSubject}`}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">
                <MessageSquarePlus className="h-3 w-3" aria-hidden="true" /> Add note
              </button>
              <button type="button" disabled={busy} onClick={() => { setDoneOpen(open => !open); setNoteOpen(false); }} aria-expanded={doneOpen} aria-label={`Done with ${ariaSubject}`}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Done
              </button>
            </>
          )}
          {!can.work && <span className="text-[10px] text-t3">Your role can read this task but not change it.</span>}
        </div>
      )}

      {dialNotice && <p role="status" className="text-[11px] font-semibold text-amber-v">{dialNotice}</p>}

      {noteOpen && can.work && (
        <form onSubmit={event => { event.preventDefault(); void addNote(); }} className="space-y-1.5">
          <label className="block">
            <span className="sr-only">Note for {ariaSubject}</span>
            <textarea value={noteText} onChange={event => setNoteText(event.target.value)} maxLength={500} rows={2} placeholder="Minimum-necessary operational note (no card data, no clinical detail)."
              className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t1 outline-none focus:border-indigo" />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || noteText.trim().length === 0} className="rounded-lg bg-indigo px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-50">Save note</button>
            <button type="button" disabled={busy} onClick={() => setNoteOpen(false)} className="rounded-lg border border-[var(--b1)] px-3 py-1 text-[11px] font-semibold text-t2">Cancel</button>
          </div>
        </form>
      )}

      {doneOpen && can.work && (
        <form onSubmit={event => { event.preventDefault(); void complete(); }} className="space-y-1.5 rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-3">
          <label className="block space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Outcome <span className="text-red-v">*</span></span>
            <select value={outcomeCode} onChange={event => setOutcomeCode(event.target.value as TaskOutcomeCode | '')} aria-label={`Outcome for ${ariaSubject}`}
              className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1.5 text-xs text-t1">
              <option value="">Choose an outcome…</option>
              {TASK_OUTCOME_CODES.map(code => <option key={code} value={code}>{TASK_OUTCOME_LABEL[code]}</option>)}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-t3">Note (optional)</span>
            <textarea value={outcomeNote} onChange={event => setOutcomeNote(event.target.value)} maxLength={500} rows={2}
              className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t1 outline-none focus:border-indigo" />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !outcomeCode} className="rounded-lg bg-indigo px-3 py-1 text-[11px] font-semibold text-white disabled:opacity-50">Mark done</button>
            <button type="button" disabled={busy} onClick={() => setDoneOpen(false)} className="rounded-lg border border-[var(--b1)] px-3 py-1 text-[11px] font-semibold text-t2">Cancel</button>
          </div>
          {!outcomeCode && <p className="text-[10px] text-t3">An outcome is required to close a receptionist task.</p>}
        </form>
      )}

      <MutationNotice state={action.state} />
    </article>
  );
}
