import { useCallback, useState } from 'react';
import { CalendarOff, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Field, Select, TextArea, TextInput } from '../ui/Field';
import { receptionistClinicApi, type Closure, type ClosureInput, type LocationRow } from '../../lib/receptionistClinic';
import { useResource } from '../../hooks/useResource';
import { receivedData, resourceFailure } from '../../lib/resourceState';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { clinicDateLabel, todayInZone } from '../../lib/clinicTime';
import { ConfirmedButton } from './shared';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';

export const CLOSURE_REASON_MAX = 160;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface ClosureForm {
  locationId: string;
  startsOn: string;
  endsOn: string;
  reason: string;
  internalNote: string;
}

/**
 * Whole-day closures for a clinic (or one of its locations). The reason is
 * spoken to callers, so it gets a counter against the server cap; the
 * internal note is staff-only. Partial-day closures are a pilot cut: the
 * columns exist, the UI does not offer them.
 */
export function ClosuresEditor({ clinicId, locations, timezone, locale = 'en-US' }: { clinicId: string; locations: LocationRow[]; timezone: string; locale?: string }) {
  const from = todayInZone(timezone);
  const loadClosures = useCallback(() => receptionistClinicApi.listClosures(clinicId, { from }), [clinicId, from]);
  const closuresResource = useResource<Closure[]>(loadClosures);
  const failure = resourceFailure(closuresResource.state);
  const closures = receivedData(closuresResource.state);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<ClosureForm>({ locationId: '', startsOn: from, endsOn: from, reason: '', internalNote: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const saveState = useMutationState();
  const removeState = useMutationState();
  const fieldErrors = saveState.state.status === 'error' ? saveState.state.fieldErrors : {};

  const setValue = <K extends keyof ClosureForm>(key: K, value: ClosureForm[K]) => setForm(previous => ({ ...previous, [key]: value }));

  function beginCreate() {
    setForm({ locationId: '', startsOn: from, endsOn: from, reason: '', internalNote: '' });
    setFormError(null);
    saveState.reset();
    setEditingId('new');
  }

  function beginEdit(closure: Closure) {
    setForm({ locationId: closure.locationId ?? '', startsOn: closure.startsOn, endsOn: closure.endsOn, reason: closure.reason, internalNote: closure.internalNote ?? '' });
    setFormError(null);
    saveState.reset();
    setEditingId(closure.id);
  }

  async function save() {
    if (!ISO_DATE.test(form.startsOn) || !ISO_DATE.test(form.endsOn)) {
      setFormError('Pick a start and end date.');
      return;
    }
    if (form.endsOn < form.startsOn) {
      setFormError('The end date must be on or after the start date.');
      return;
    }
    if (form.reason.trim().length < 2) {
      setFormError('Give callers a reason (at least 2 characters).');
      return;
    }
    setFormError(null);
    const body: ClosureInput = {
      locationId: form.locationId || null,
      startsOn: form.startsOn,
      endsOn: form.endsOn,
      reason: form.reason.trim(),
      internalNote: form.internalNote.trim() || null,
    };
    const saved = await saveState.run(async () => {
      if (editingId === 'new') await receptionistClinicApi.createClosure(clinicId, body);
      else if (editingId) await receptionistClinicApi.updateClosure(editingId, body);
      return true;
    });
    if (saved) {
      setEditingId(null);
      closuresResource.reload();
    }
  }

  async function remove(id: string) {
    await removeState.run(async () => {
      await receptionistClinicApi.deleteClosure(id);
      closuresResource.reload();
    }, { rethrow: true });
  }

  function locationName(locationId: string | null): string {
    if (!locationId) return 'All locations';
    return locations.find(location => location.id === locationId)?.name ?? 'Unknown location';
  }

  function dateRange(closure: Closure): string {
    const options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
    const start = clinicDateLabel(closure.startsOn, timezone, options, locale);
    if (closure.startsOn === closure.endsOn) return start;
    return `${start} – ${clinicDateLabel(closure.endsOn, timezone, options, locale)}`;
  }

  return (
    <div className="cc-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><CalendarOff className="w-4 h-4 text-indigo" aria-hidden="true" /> Closures</h3>
        <button type="button" onClick={editingId === 'new' ? () => setEditingId(null) : beginCreate} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)]">
          <Plus className="w-3 h-3" aria-hidden="true" /> Add closure
        </button>
      </div>
      <p className="text-[11px] text-t3">Holidays and training days. The reason is spoken to callers; the agent offers the next opening instead of a slot.</p>
      {failure && <LoadFailureNotice what="Closures" message={failure.message} onRetry={closuresResource.reload} />}
      {closuresResource.state.status === 'loading' && (
        <p className="inline-flex items-center gap-2 text-xs text-t3" aria-live="polite"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading closures…</p>
      )}
      <MutationNotice state={removeState.state} showSaved={false} />
      {closures && closures.length === 0 && editingId !== 'new' && <p className="text-xs text-t3">No upcoming closures.</p>}
      {closures && closures.length > 0 && (
        <ul className="space-y-2">
          {closures.map(closure => (
            <li key={closure.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-t1 truncate">{dateRange(closure)} <span className="text-[11px] font-normal text-t3">· {locationName(closure.locationId)}</span></p>
                <p className="text-[11px] text-t2 truncate">Callers hear: “{closure.reason}”</p>
                {closure.internalNote && <p className="text-[10px] text-t3 truncate">Staff note: {closure.internalNote}</p>}
              </div>
              <div className="flex gap-2">
                <button type="button" aria-label={`Edit closure ${closure.reason}`} title="Edit closure" onClick={() => beginEdit(closure)} className="text-t3 hover:text-indigo shrink-0"><Pencil className="w-3.5 h-3.5" aria-hidden="true" /></button>
                <ConfirmedButton
                  dialogTitle="Delete closure?"
                  message={`Delete the closure “${closure.reason}” (${dateRange(closure)})? The agent will treat those days as normal opening days.`}
                  confirmLabel="Delete closure"
                  tone="red"
                  ariaLabel={`Delete closure ${closure.reason}`}
                  buttonTitle="Delete closure"
                  disabled={isBusy(removeState.state)}
                  onConfirm={() => remove(closure.id)}
                  className="text-t3 hover:text-red-v shrink-0"
                ><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /></ConfirmedButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editingId && (
        <div className="grid gap-3 md:grid-cols-2 rounded-xl border border-dashed border-[var(--b2)] p-3">
          <Field label="First day closed" required><TextInput type="date" value={form.startsOn} onChange={e => setValue('startsOn', e.target.value)} /></Field>
          <Field label="Last day closed" required hint="Inclusive."><TextInput type="date" value={form.endsOn} min={form.startsOn} onChange={e => setValue('endsOn', e.target.value)} /></Field>
          <Field label="Applies to">
            <Select value={form.locationId} onChange={e => setValue('locationId', e.target.value)}>
              <option value="">All locations</option>
              {locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
            </Select>
          </Field>
          <Field label="Reason callers hear" required hint={`${form.reason.length}/${CLOSURE_REASON_MAX} characters`}>
            <TextInput value={form.reason} maxLength={CLOSURE_REASON_MAX} placeholder="Staff training day" aria-invalid={Boolean(fieldErrors.reason)} onChange={e => setValue('reason', e.target.value)} />
          </Field>
          {fieldErrors.reason && <p role="alert" className="md:col-span-2 text-xs font-semibold text-red-v">Reason: {fieldErrors.reason[0]}</p>}
          <div className="md:col-span-2">
            <Field label="Internal note" hint="Staff only — never spoken.">
              <TextArea rows={2} value={form.internalNote} maxLength={500} onChange={e => setValue('internalNote', e.target.value)} />
            </Field>
          </div>
          {formError && <p role="alert" className="md:col-span-2 text-xs font-semibold text-red-v">{formError}</p>}
          <MutationNotice state={saveState.state} showSaved={false} className="md:col-span-2" />
          <div className="md:col-span-2 flex items-center justify-end gap-2">
            <button type="button" onClick={() => setEditingId(null)} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm font-semibold text-t2">Cancel</button>
            <button type="button" disabled={isBusy(saveState.state)} onClick={save} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
              {isBusy(saveState.state) && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{isBusy(saveState.state) ? 'Saving…' : editingId === 'new' ? 'Create closure' : 'Save closure'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
