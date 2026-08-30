import { getLocale } from './preferences';
import { resolveTimezone } from './clinicTime';

// ===========================================================================
// Front-desk timestamp formatting (C4).
//
// Every receptionist / front-desk / staff-task timestamp is rendered in the
// CLINIC's zone, never the viewer's: a callback due "at 14:30" means 14:30
// where the phone will ring. These helpers sit next to clinicTime.ts rather
// than inside it because C2 owns that file this wave; the intended end state
// is to move `formatClinicDateTime`, `formatClinicTime` and `formatRelativeDue`
// into clinicTime.ts unchanged once both cycles are merged.
// ===========================================================================

type DateInput = string | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Date + time in the clinic zone ("Tue, Aug 29, 14:02"). Empty string for null/invalid. */
export function formatClinicDateTime(
  value: DateInput,
  timeZone: string | null | undefined,
  opts?: Intl.DateTimeFormatOptions,
  locale: string = getLocale(),
): string {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone: resolveTimezone(timeZone),
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    ...opts,
  }).format(date);
}

/** Weekday + time in the clinic zone ("Tue 14:02"). Empty string for null/invalid. */
export function formatClinicTime(value: DateInput, timeZone: string | null | undefined, locale: string = getLocale()): string {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone: resolveTimezone(timeZone), weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

/** "3 min" / "2 h 05 min" / "1 d 3 h" — for countdowns and call durations. */
export function formatMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

/**
 * Relative due label for a task. Overdue is a fact about the clock, not about
 * the viewer, so it is computed from instants and needs no timezone.
 *
 *   in 12 min · Overdue · 3 min · No due date
 */
export function formatRelativeDue(dueAt: DateInput, now: Date = new Date()): { label: string; overdue: boolean } {
  const due = toDate(dueAt);
  if (!due) return { label: 'No due date', overdue: false };
  const deltaMinutes = (due.getTime() - now.getTime()) / 60_000;
  if (deltaMinutes < 0) return { label: `Overdue · ${formatMinutes(-deltaMinutes)}`, overdue: true };
  if (deltaMinutes < 1) return { label: 'Due now', overdue: false };
  return { label: `in ${formatMinutes(deltaMinutes)}`, overdue: false };
}

/** Call duration "1m 04s"; "—" when unknown or zero. */
export function formatCallDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}
