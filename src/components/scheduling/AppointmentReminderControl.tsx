import { useCallback, useId, useState } from 'react';
import { AlertTriangle, BellRing, CheckCircle2, CircleAlert, Info, RefreshCw } from 'lucide-react';
import { ApiError } from '../../lib/api';
import {
  appointmentsApi,
  appointmentCommunicationOutcome,
  type AppointmentCommunicationMode,
  type AppointmentCommunicationPlan,
} from '../../lib/appointments';

const OPTIONS: Array<{ value: AppointmentCommunicationMode; label: string }> = [
  { value: 'NONE', label: 'None' },
  { value: 'SMS', label: 'Text' },
  { value: 'VOICE', label: 'Call' },
  { value: 'BOTH', label: 'Both' },
];

interface AppointmentReminderControlProps {
  appointmentId: string;
  appointmentVersion: number;
  canEdit: boolean;
  eligible: boolean;
}

export default function AppointmentReminderControl({
  appointmentId,
  appointmentVersion,
  canEdit,
  eligible,
}: AppointmentReminderControlProps) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [plan, setPlan] = useState<AppointmentCommunicationPlan | null>(null);
  const [selected, setSelected] = useState<AppointmentCommunicationMode>('NONE');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'notice'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const next = await appointmentsApi.communicationPlan(appointmentId);
      setPlan(next);
      setSelected(next.mode);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Reminders could not be loaded.' });
    } finally {
      setLoading(false);
    }
  }, [appointmentId]);

  const stale = plan !== null && plan.appointmentVersion !== appointmentVersion;

  async function save() {
    if (!plan || stale || !canEdit || !eligible) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await appointmentsApi.saveCommunicationPlan(appointmentId, {
        mode: selected,
        reminderLeadMinutes: plan.reminderLeadMinutes,
        appointmentVersion: plan.appointmentVersion,
        revision: plan.revision,
      });
      setPlan(next);
      setSelected(next.mode);
      setMessage({ kind: 'notice', text: 'Reminder choice saved.' });
    } catch (error) {
      const text = error instanceof ApiError && error.status === 409
        ? 'This appointment or its reminder choice changed elsewhere. Refresh reminders, then try again.'
        : error instanceof Error ? error.message : 'Reminder choice could not be saved.';
      setMessage({ kind: 'error', text });
    } finally {
      setSaving(false);
    }
  }

  const outcome = plan ? appointmentCommunicationOutcome(plan) : null;
  const outcomeStyle = outcome?.tone === 'warning' ? 'border-amber-500/60 bg-[var(--amber-soft)]'
    : outcome?.tone === 'error' ? 'border-red-500/60 bg-[var(--red-soft)]'
    : outcome?.tone === 'success' ? 'border-emerald-500/60 bg-[var(--emerald-soft)]'
    : 'border-[var(--b2)] bg-[var(--s1)]';
  const OutcomeIcon = outcome?.tone === 'warning' ? AlertTriangle
    : outcome?.tone === 'error' ? CircleAlert
    : outcome?.tone === 'success' ? CheckCircle2
    : Info;
  const compactChoice = plan?.mode === 'SMS' ? 'Text'
    : plan?.mode === 'VOICE' ? 'Call'
    : plan?.mode === 'BOTH' ? 'Both'
    : plan ? 'None' : null;

  return (
    <div className="mt-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)]/70">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next && plan === null && !loading) void load();
        }}
        className="flex min-h-10 w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-xs font-semibold text-t2 hover:bg-[var(--s3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--indigo)]"
      >
        <span className="inline-flex items-center gap-2"><BellRing className="h-3.5 w-3.5" aria-hidden="true" /> Reminders</span>
        <span className="text-[11px] font-medium text-t2">{expanded ? 'Close' : compactChoice ?? (canEdit ? 'View or change' : 'View')}</span>
      </button>

      {expanded && (
        <div id={panelId} className="border-t border-[var(--b1)] p-3">
          {loading ? (
            <p role="status" className="text-[11px] text-t3">Loading reminder choice…</p>
          ) : plan ? (
            <>
              <fieldset disabled={saving || stale || !canEdit || !eligible}>
                <legend className="text-[11px] font-semibold text-t1">How should we remind this patient?</legend>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {OPTIONS.map(option => (
                    <label key={option.value} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${selected === option.value ? 'border-[var(--indigo)] bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] bg-[var(--s1)] text-t2 hover:bg-[var(--s3)]'} ${saving || !canEdit || !eligible ? 'cursor-not-allowed opacity-60' : ''}`}>
                      <input
                        type="radio"
                        name={`${panelId}-mode`}
                        value={option.value}
                        checked={selected === option.value}
                        onChange={() => setSelected(option.value)}
                        className="accent-[var(--indigo)]"
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </fieldset>

              {outcome ? (
                <div className={`mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 ${outcomeStyle}`}>
                  <OutcomeIcon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${outcome.tone === 'warning' ? 'text-amber-v' : outcome.tone === 'error' ? 'text-red-v' : outcome.tone === 'success' ? 'text-emerald-v' : 'text-t2'}`} aria-hidden="true" />
                  <p className="text-[11px] font-semibold leading-4 text-t1">{outcome.text}</p>
                </div>
              ) : null}
              {!canEdit ? <p className="mt-1 text-[11px] font-medium text-t2">You can view this choice, but your role cannot change it.</p> : null}
              {canEdit && !eligible ? <p className="mt-1 text-[11px] font-medium text-t2">Reminders can only be changed for an upcoming booked appointment.</p> : null}
              {stale ? (
                <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/60 bg-[var(--red-soft)] px-2.5 py-2 text-[11px] font-semibold text-t1">
                  <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-v" aria-hidden="true" />
                  <span>This appointment changed. Refresh reminders before saving.</span>
                  <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex items-center gap-1 font-bold text-t1 underline underline-offset-2 disabled:opacity-50">
                    <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh reminders
                  </button>
                </div>
              ) : null}

              {message && (
                <div className={`mt-2 flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px] font-semibold text-t1 ${message.kind === 'notice' ? 'border-[var(--b2)] bg-[var(--s1)]' : 'border-red-500/60 bg-[var(--red-soft)]'}`} role={message.kind === 'error' ? 'alert' : 'status'}>
                  {message.kind === 'error' ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-v" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-v" aria-hidden="true" />}
                  <span>{message.text}</span>
                  {message.kind === 'error' ? (
                    <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex items-center gap-1 font-bold text-t1 underline underline-offset-2 disabled:opacity-50">
                      <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh reminders
                    </button>
                  ) : null}
                </div>
              )}

              {canEdit && eligible ? (
                <button
                  type="button"
                  disabled={saving || stale || selected === plan.mode}
                  onClick={() => void save()}
                  className="mt-3 min-h-10 w-full rounded-lg bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--indigo)] focus-visible:ring-offset-2 disabled:opacity-40"
                >
                  {saving ? 'Saving reminder…' : 'Save reminder choice'}
                </button>
              ) : null}
            </>
          ) : (
            <div className="space-y-2">
              <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-500/60 bg-[var(--red-soft)] px-2.5 py-2 text-[11px] font-semibold text-t1"><CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-v" aria-hidden="true" /> {message?.text ?? 'Reminders could not be loaded.'}</p>
              <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
