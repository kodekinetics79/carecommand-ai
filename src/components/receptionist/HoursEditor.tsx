import { useId } from 'react';
import type { HoursWindow, WeeklyHours } from '../../lib/receptionist';
import { WEEK_DAYS, standardWeek, type WeekDay } from '../../lib/receptionistClinic';
import { formatSpokenWindow, type TimeStyle } from '../../lib/clinicTime';

const WEEKDAYS: readonly WeekDay[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

const DAY_LABEL: Record<WeekDay, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

/**
 * Seven rows, one per day, editing the stored `WeeklyHours` object in place.
 *
 * The object emitted on every change carries ALL seven days — the six that
 * did not change are copied from the current value — so a Friday toggle can
 * never rewrite the week as "Monday only" (M24). For a location the editor
 * has two modes: inherit (rows read-only, showing the clinic's values, and the
 * value emitted is `null`) or custom.
 */
export function HoursEditor({
  value,
  onChange,
  timeStyle,
  inheritedFrom,
  label,
  disabled = false,
}: {
  value: WeeklyHours | null;
  onChange: (next: WeeklyHours | null) => void;
  timeStyle: TimeStyle;
  /** Present for a location (the clinic's hours). Absent for the clinic itself. */
  inheritedFrom?: WeeklyHours | null;
  label: string;
  disabled?: boolean;
}) {
  const id = useId();
  const canInherit = inheritedFrom !== undefined;
  const inheriting = canInherit && value === null;
  const shown: WeeklyHours = inheriting ? inheritedFrom ?? {} : value ?? {};
  const readOnly = disabled || inheriting;

  function setDay(day: WeekDay, next: HoursWindow) {
    onChange({ ...(value ?? {}), [day]: next });
  }

  function copyMondayToWeekdays() {
    const monday = shown.monday;
    if (!monday) return;
    const next: WeeklyHours = { ...(value ?? {}) };
    for (const day of WEEKDAYS) next[day] = { ...monday };
    onChange(next);
  }

  return (
    <fieldset className="space-y-2" aria-labelledby={`${id}-legend`} disabled={disabled}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <legend id={`${id}-legend`} className="text-[11px] font-bold uppercase tracking-wide text-t3">{label}</legend>
        <div className="flex flex-wrap items-center gap-2">
          {canInherit && (
            <div className="inline-flex rounded-lg border border-[var(--b1)] p-0.5" role="group" aria-label="Hours source">
              <button type="button" aria-pressed={inheriting} onClick={() => onChange(null)} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${inheriting ? 'bg-[var(--indigo-soft)] text-indigo' : 'text-t3 hover:text-t2'}`}>Use clinic hours</button>
              <button type="button" aria-pressed={!inheriting} onClick={() => { if (inheriting) onChange(inheritedFrom ?? standardWeek()); }} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${!inheriting ? 'bg-[var(--indigo-soft)] text-indigo' : 'text-t3 hover:text-t2'}`}>Custom hours</button>
            </div>
          )}
          {!readOnly && !value && !canInherit && (
            <button type="button" onClick={() => onChange(standardWeek())} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)]">Set Mon–Fri 9 to 5</button>
          )}
          {!readOnly && shown.monday?.open && (
            <button type="button" onClick={copyMondayToWeekdays} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]">Copy Monday to weekdays</button>
          )}
        </div>
      </div>
      {!value && !canInherit && (
        <p className="text-[11px] text-amber-v">No hours set — the agent cannot tell callers when you are open, and activation is blocked until hours exist.</p>
      )}
      {inheriting && (
        <p className="text-[11px] text-t3">{inheritedFrom ? 'Showing the clinic hours this location inherits.' : 'The clinic has no hours yet; this location inherits nothing.'}</p>
      )}
      <div className="grid gap-1.5">
        {WEEK_DAYS.map(day => {
          const window = shown[day];
          const open = Boolean(window?.open);
          return (
            <div key={day} className="grid grid-cols-[6.5rem_auto_1fr] items-center gap-2 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 md:grid-cols-[6.5rem_auto_auto_auto_1fr]">
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-t1">
                <input
                  type="checkbox"
                  checked={open}
                  disabled={readOnly}
                  aria-label={`${DAY_LABEL[day]} open`}
                  onChange={event => setDay(day, event.target.checked ? { open: true, start: window?.start ?? '09:00', end: window?.end ?? '17:00' } : { open: false })}
                />
                {DAY_LABEL[day]}
              </label>
              <input
                type="time"
                aria-label={`${DAY_LABEL[day]} opens at`}
                value={open ? window?.start ?? '' : ''}
                disabled={readOnly || !open}
                onChange={event => setDay(day, { open: true, start: event.target.value, end: window?.end ?? '17:00' })}
                className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-2 py-1 text-xs text-t1 disabled:opacity-40"
              />
              <span className="hidden text-[11px] text-t3 md:inline">to</span>
              <input
                type="time"
                aria-label={`${DAY_LABEL[day]} closes at`}
                value={open ? window?.end ?? '' : ''}
                disabled={readOnly || !open}
                onChange={event => setDay(day, { open: true, start: window?.start ?? '09:00', end: event.target.value })}
                className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-2 py-1 text-xs text-t1 disabled:opacity-40"
              />
              <span className="col-span-3 text-[11px] text-t3 md:col-span-1 md:text-right" aria-label={`${DAY_LABEL[day]} spoken as`}>
                {open ? `Spoken: ${formatSpokenWindow(window?.start, window?.end, timeStyle)}` : 'Closed'}
              </span>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
