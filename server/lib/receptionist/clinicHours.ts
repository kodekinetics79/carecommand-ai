import { createHash } from 'node:crypto';
import { clinicLocalMinuteToUtc, partsAt } from '../scheduling';
import { canonicalJson } from './localePacks/render';
import type { LocaleFormat, LocalePackStrings } from './localePacks/types';

// ===========================================================================
// Clinic hours engine. Pure, DB-free, Intl-only. Weekly hours come from the
// clinic (and an optional per-location override), closures subtract days, and
// every instant is resolved in the clinic-local timezone via the same
// `partsAt` / `clinicLocalMinuteToUtc` helpers the scheduler uses (DST-safe).
// ===========================================================================

export const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export interface HoursWindow { open: boolean; start?: string; end?: string }
export type WeeklyHours = Partial<Record<DayKey, HoursWindow>>;

export interface ClosureRule {
  id: string;
  locationId: string | null;
  startsOn: string;
  endsOn: string;
  startTime?: string | null;
  endTime?: string | null;
  reason: string;
}

export interface HoursSource {
  /** branch.timezone for a location, clinic.timezone for the clinic. */
  timezone: string;
  clinicHours: WeeklyHours | null;
  /** Per-day override; a day present here wins over the clinic day. */
  locationHours?: WeeklyHours | null;
  /** Closures with locationId === this or null apply. */
  locationId?: string | null;
  closures: ClosureRule[];
}

export interface EffectiveDay {
  date: string;
  dayKey: DayKey;
  timezone: string;
  open: boolean;
  windows: Array<{ start: string; end: string }>;
  closure: { id: string; reason: string; allDay: boolean } | null;
  source: 'location' | 'clinic' | 'unconfigured';
}

export interface NextOpening { date: string; start: string; startsAt: string }

export interface HoursStatus {
  configured: boolean;
  timezone: string;
  at: string;
  isOpenNow: boolean;
  today: EffectiveDay;
  nextOpening: NextOpening | null;
  closureReason: string | null;
  todayHoursSpoken: string;
  nextOpeningSpoken: string | null;
}

const CLOCK_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toMinute(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
}

function fromMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function addDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Validate JSON read back from the database; malformed hours read as unconfigured. */
export function parseWeeklyHours(value: unknown): WeeklyHours | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: WeeklyHours = {};
  for (const key of DAY_KEYS) {
    const day = (value as Record<string, unknown>)[key];
    if (!day || typeof day !== 'object') continue;
    const window = day as Record<string, unknown>;
    if (typeof window.open !== 'boolean') continue;
    if (!window.open) { out[key] = { open: false }; continue; }
    if (typeof window.start !== 'string' || typeof window.end !== 'string' || !CLOCK_RE.test(window.start) || !CLOCK_RE.test(window.end) || window.start >= window.end) continue;
    out[key] = { open: true, start: window.start, end: window.end };
  }
  return Object.keys(out).length ? out : null;
}

export function effectiveWeeklyHours(clinic: WeeklyHours | null, location?: WeeklyHours | null): WeeklyHours {
  return { ...(clinic ?? {}), ...(location ?? {}) };
}

export function hoursConfigured(source: Pick<HoursSource, 'clinicHours' | 'locationHours'>): boolean {
  return Object.keys(effectiveWeeklyHours(source.clinicHours, source.locationHours)).length > 0;
}

function applicableClosures(source: HoursSource, dateISO: string): ClosureRule[] {
  return source.closures.filter(rule => rule.startsOn <= dateISO && rule.endsOn >= dateISO
    && (rule.locationId === null || rule.locationId === undefined || rule.locationId === (source.locationId ?? null)));
}

export function resolveEffectiveHours(source: HoursSource, dateISO: string): EffectiveDay {
  if (!DATE_RE.test(dateISO)) throw new Error('invalid local date');
  const [y, m, d] = dateISO.split('-').map(Number);
  const dayKey = DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const fromLocation = source.locationHours?.[dayKey];
  const fromClinic = source.clinicHours?.[dayKey];
  const configured = hoursConfigured(source);
  const window = fromLocation ?? fromClinic;
  const sourceKind: EffectiveDay['source'] = !configured ? 'unconfigured' : fromLocation ? 'location' : 'clinic';
  let windows: Array<{ start: string; end: string }> = window?.open && window.start && window.end ? [{ start: window.start, end: window.end }] : [];
  let closure: EffectiveDay['closure'] = null;
  for (const rule of applicableClosures(source, dateISO)) {
    const partial = typeof rule.startTime === 'string' && typeof rule.endTime === 'string' && CLOCK_RE.test(rule.startTime) && CLOCK_RE.test(rule.endTime);
    if (!partial) {
      windows = [];
      closure = { id: rule.id, reason: rule.reason, allDay: true };
      break;
    }
    // Partial-day closure: subtract [startTime, endTime) from every window.
    const cs = toMinute(rule.startTime!); const ce = toMinute(rule.endTime!);
    windows = windows.flatMap(({ start, end }) => {
      const ws = toMinute(start); const we = toMinute(end);
      if (ce <= ws || cs >= we) return [{ start, end }];
      const parts: Array<{ start: string; end: string }> = [];
      if (cs > ws) parts.push({ start, end: fromMinute(cs) });
      if (ce < we) parts.push({ start: fromMinute(ce), end });
      return parts;
    });
    closure ??= { id: rule.id, reason: rule.reason, allDay: false };
  }
  return { date: dateISO, dayKey, timezone: source.timezone, open: windows.length > 0, windows, closure, source: sourceKind };
}

export function isOpenAt(source: HoursSource, at: Date): { open: boolean; day: EffectiveDay; minuteOfDay: number } {
  const local = partsAt(at, source.timezone);
  const day = resolveEffectiveHours(source, local.dateISO);
  const open = day.windows.some(({ start, end }) => toMinute(start) <= local.minuteOfDay && local.minuteOfDay < toMinute(end));
  return { open, day, minuteOfDay: local.minuteOfDay };
}

export function nextOpening(source: HoursSource, from: Date, horizonDays = 14): NextOpening | null {
  if (!hoursConfigured(source)) return null;
  const local = partsAt(from, source.timezone);
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const dateISO = addDays(local.dateISO, offset);
    const day = resolveEffectiveHours(source, dateISO);
    for (const window of day.windows) {
      const startMinute = toMinute(window.start);
      if (offset === 0 && startMinute <= local.minuteOfDay) continue;
      const startsAt = clinicLocalMinuteToUtc(dateISO, startMinute, source.timezone);
      // A start inside a spring-forward gap does not exist; skip it.
      if (!startsAt) continue;
      return { date: dateISO, start: window.start, startsAt: startsAt.toISOString() };
    }
  }
  return null;
}

// --- Speech -----------------------------------------------------------------

export function spokenTime(clock: string, locale: LocaleFormat): string {
  if (!CLOCK_RE.test(clock)) return clock;
  if (locale.timeStyle === '24h') return clock;
  const minute = toMinute(clock);
  const h24 = Math.floor(minute / 60); const mm = minute % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 || 12;
  return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

function dateParts(dateISO: string, language: string): { weekday: string; month: string; day: string } {
  const [y, m, d] = dateISO.split('-').map(Number);
  const instant = new Date(Date.UTC(y, m - 1, d, 12));
  const parts = new Intl.DateTimeFormat(language, { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return { weekday: pick('weekday'), month: pick('month'), day: pick('day') };
}

export function spokenDate(dateISO: string, locale: LocaleFormat): string {
  const { weekday, month, day } = dateParts(dateISO, locale.language);
  return locale.dateStyle === 'weekday-day-month' ? `${weekday} ${day} ${month}` : `${weekday}, ${month} ${day}`;
}

function spokenWindows(windows: EffectiveDay['windows'], locale: LocaleFormat): string {
  return windows.map(({ start, end }) => `${spokenTime(start, locale)} to ${spokenTime(end, locale)}`).join(' and ');
}

export function todayHoursSpoken(day: EffectiveDay, locale: LocaleFormat): string {
  if (day.source === 'unconfigured') return 'hours not configured';
  if (day.closure?.allDay) return `closed today: ${day.closure.reason}`;
  if (!day.open) return 'closed today';
  return spokenWindows(day.windows, locale);
}

function weekdayName(dayKey: DayKey, language: string): string {
  // 2024-01-07 is a Sunday; DAY_KEYS is Sunday-first.
  return dateParts(addDays('2024-01-07', DAY_KEYS.indexOf(dayKey)), language).weekday;
}

/** "Monday to Friday 9 AM to 5 PM, Saturday 9 AM to 1 PM, closed Sunday" */
export function hoursSummarySpoken(source: Pick<HoursSource, 'clinicHours' | 'locationHours'>, locale: LocaleFormat): string {
  const weekly = effectiveWeeklyHours(source.clinicHours, source.locationHours);
  if (!Object.keys(weekly).length) return 'not configured';
  const order: DayKey[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const spokenFor = (key: DayKey) => {
    const window = weekly[key];
    return window?.open && window.start && window.end ? spokenWindows([{ start: window.start, end: window.end }], locale) : null;
  };
  const groups: Array<{ from: DayKey; to: DayKey; spoken: string | null }> = [];
  for (const key of order) {
    const spoken = spokenFor(key);
    const last = groups[groups.length - 1];
    if (last && last.spoken === spoken) last.to = key;
    else groups.push({ from: key, to: key, spoken });
  }
  return groups.map(group => {
    const label = group.from === group.to
      ? weekdayName(group.from, locale.language)
      : `${weekdayName(group.from, locale.language)} to ${weekdayName(group.to, locale.language)}`;
    return group.spoken ? `${label} ${group.spoken}` : `closed ${label}`;
  }).join(', ');
}

/** "Closed Monday 31 August to Tuesday 1 September: Staff training" lines within `days`. */
export function upcomingClosuresSpoken(source: HoursSource, from: Date, days: number, locale: LocaleFormat): string[] {
  const today = partsAt(from, source.timezone).dateISO;
  const horizon = addDays(today, days);
  return source.closures
    .filter(rule => rule.endsOn >= today && rule.startsOn <= horizon && (rule.locationId == null || rule.locationId === (source.locationId ?? null)))
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn))
    .map(rule => {
      const range = rule.startsOn === rule.endsOn
        ? spokenDate(rule.startsOn, locale)
        : `${spokenDate(rule.startsOn, locale)} to ${spokenDate(rule.endsOn, locale)}`;
      const partial = rule.startTime && rule.endTime ? ` from ${spokenTime(rule.startTime, locale)} to ${spokenTime(rule.endTime, locale)}` : '';
      return `Closed ${range}${partial}: ${rule.reason}`;
    });
}

export function hoursStatus(source: HoursSource, now: Date, locale: LocaleFormat): HoursStatus {
  const configured = hoursConfigured(source);
  const { open, day } = isOpenAt(source, now);
  const next = open ? null : nextOpening(source, now);
  return {
    configured,
    timezone: source.timezone,
    at: now.toISOString(),
    isOpenNow: configured && open,
    today: day,
    nextOpening: next,
    closureReason: day.closure?.reason ?? null,
    todayHoursSpoken: todayHoursSpoken(day, locale),
    nextOpeningSpoken: next ? `${spokenDate(next.date, locale)} at ${spokenTime(next.start, locale)}` : null,
  };
}

/** sha256 of the canonical {timezone, effective weekly hours, closures}; stable under key order. */
export function hoursHash(source: HoursSource): string {
  const weekly = effectiveWeeklyHours(source.clinicHours, source.locationHours);
  const closures = [...source.closures].sort((a, b) => a.id.localeCompare(b.id)).map(rule => ({
    id: rule.id, locationId: rule.locationId ?? null, startsOn: rule.startsOn, endsOn: rule.endsOn,
    startTime: rule.startTime ?? null, endTime: rule.endTime ?? null, reason: rule.reason,
  }));
  return createHash('sha256').update(canonicalJson({ timezone: source.timezone, weekly, closures })).digest('hex');
}

/**
 * The single producer of the hours runtime variables (contract §3). Every
 * call-time caller (outbound dial, C3 call_inbound) spreads this result.
 */
export function buildHoursDynamicVariables(input: { status: HoursStatus | null; strings: Pick<LocalePackStrings, 'emergencyNumber'> | null }): Record<string, string> {
  const status = input.status;
  return {
    is_open_now: status?.configured ? String(status.isOpenNow) : 'unknown',
    hours_today: status?.configured ? status.todayHoursSpoken : '',
    next_opening: status?.nextOpeningSpoken ?? '',
    closure_reason: status?.closureReason ?? '',
    emergency_number: input.strings?.emergencyNumber ?? '',
  };
}
