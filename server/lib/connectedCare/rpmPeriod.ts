/**
 * Billing-period arithmetic in the clinic's own timezone.
 *
 * The period was previously a UTC calendar month for every tenant, which is
 * wrong for any clinic that is not on UTC, in two ways that pull in opposite
 * directions.
 *
 * It LOSES work. For a clinic at UTC-7, 17:00 on the last day of the local month
 * is already the 1st in UTC. For those final local hours the engine reports the
 * NEXT month, so a clinician reviewing a patient at 16:30 on the 31st is told
 * the session is "outside the current period" and cannot record it at all. The
 * page also flips from "22 device-days, awaiting signoff" to "0 device-days"
 * mid-afternoon with no explanation.
 *
 * And it INFLATES evidence. Device-days were bucketed by UTC calendar date, so a
 * patient in Los Angeles measuring at 08:00 and 18:00 local produces two
 * distinct UTC dates from one local day. Eight local days of transmission could
 * therefore satisfy a sixteen-device-day threshold — a patient reaching a CMS
 * bar on half the days they actually transmitted.
 *
 * Both are fixed by doing the arithmetic where the care happens. Boundaries are
 * still returned as absolute instants; only the definition of "which month" and
 * "which day" becomes local.
 */

export const DEFAULT_RPM_TIME_ZONE = 'UTC';

interface ZonedParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
}

/** Wall-clock parts of an instant, as read in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0');
  return {
    year: get('year'), month: get('month'), day: get('day'),
    // Intl can render midnight as hour 24 in some locales/zones.
    hour: get('hour') % 24, minute: get('minute'), second: get('second'),
  };
}

/**
 * The instant at which a given local wall-clock time occurs in `timeZone`.
 *
 * Resolved by guessing the instant as if the parts were UTC, measuring how that
 * guess actually reads in the zone, and correcting by the difference. The
 * correction is applied twice because the offset itself can change across the
 * first correction — which is exactly what happens on a DST boundary.
 */
export function zonedTimeToInstant(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  timeZone: string,
): Date {
  // The wall-clock we are aiming for, held fixed as the reference. Drift is
  // measured against THIS, not against the moving guess — comparing to the
  // guess re-measures the zone offset on every pass and walks away from the
  // answer instead of converging on it.
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = target;
  for (let pass = 0; pass < 2; pass++) {
    const seen = zonedParts(new Date(instant), timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    const drift = seenAsUtc - target;
    if (drift === 0) break;
    instant -= drift;
  }
  return new Date(instant);
}

/** The local calendar date of an instant, as `YYYY-MM-DD` in `timeZone`. */
export function zonedDateKey(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export interface MonthBounds {
  /** Inclusive start: local midnight on the 1st, as an absolute instant. */
  start: Date;
  /** Exclusive end: local midnight on the 1st of the next month. */
  end: Date;
}

/** The calendar month containing `instant`, as read in `timeZone`. */
export function zonedMonthBounds(instant: Date, timeZone: string): MonthBounds {
  const { year, month } = zonedParts(instant, timeZone);
  return {
    start: zonedTimeToInstant(year, month, 1, 0, 0, 0, timeZone),
    end: month === 12
      ? zonedTimeToInstant(year + 1, 1, 1, 0, 0, 0, timeZone)
      : zonedTimeToInstant(year, month + 1, 1, 0, 0, 0, timeZone),
  };
}

/**
 * Resolve a caller-supplied period start onto a real month boundary.
 *
 * Billing happens after a period closes, so a clinic must be able to address a
 * month that has ended. Any instant inside the intended month is accepted and
 * normalised to that month's true local boundary, so a caller cannot address a
 * half-month by passing an arbitrary timestamp.
 */
export function resolveRequestedMonth(requested: Date | undefined, now: Date, timeZone: string): MonthBounds {
  return zonedMonthBounds(requested ?? now, timeZone);
}

/** Whether a timezone identifier is one this runtime can actually resolve. */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
