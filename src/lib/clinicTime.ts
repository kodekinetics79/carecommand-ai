// ===========================================================================
// Clinic-local time.
//
// The schedule belongs to the clinic, not to whoever is looking at it. A front
// desk in Chicago and a regional manager in London must see the same day
// containing the same appointments, and a reschedule typed as "2:30pm" must mean
// 2:30pm where the patient is going to walk in.
//
// The board used to compute all three of those from the browser instead: "today"
// came from toISOString() (which is UTC), the day it fetched was an unqualified
// UTC midnight-to-midnight window, and a rescheduled time was parsed in whatever
// zone the staff member's laptop was set to. For a Chicago clinic that means
// every appointment after 7pm CDT belongs to the next UTC day and silently drops
// out of today's view, and a reschedule from another timezone writes the wrong
// hour with no warning. The server already does real IANA conversion; only the
// client threw it away.
//
// Everything here is built on Intl, which carries the full IANA database
// including historical and future DST transitions. No offset is ever assumed.
// ===========================================================================

/** Falls back to the viewer's own zone, which is at least a real place. */
export function resolveTimezone(candidate: string | null | undefined): string {
  const trimmed = candidate?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
      return trimmed;
    } catch {
      // An unusable stored value must not take the screen down; fall through.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * How far `timeZone` sits from UTC at a specific instant, in milliseconds.
 *
 * Formatting the instant into the zone and reading the fields back is the only
 * way to get this from Intl, and it is DST-correct by construction because the
 * offset is asked for at the instant in question rather than assumed.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);

  const field = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0');
  // hourCycle h23 still reports midnight as "24" in some engines.
  const asIfUtc = Date.UTC(
    field('year'), field('month') - 1, field('day'),
    field('hour') % 24, field('minute'), field('second'),
  );
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which a wall-clock time occurs in a given zone.
 *
 * Solved by iteration: guess the offset from the naive reading, correct, then
 * re-check once. The second pass matters on DST boundaries, where the offset at
 * the guessed instant differs from the offset at the true one. Times inside a
 * spring-forward gap do not exist; they resolve forward, which is the same
 * choice the platform makes elsewhere.
 */
export function clinicTimeToUtc(dateISO: string, time: string, timeZone: string): Date {
  const naive = new Date(`${dateISO}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (Number.isNaN(naive.getTime())) return new Date(NaN);

  let instant = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  instant = new Date(naive.getTime() - zoneOffsetMs(instant, timeZone));
  return instant;
}

/** Today's calendar date in the clinic's zone, as YYYY-MM-DD. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is the shape every date input expects.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** A calendar date shifted by whole days, still in the clinic's zone. */
export function shiftClinicDate(dateISO: string, days: number, timeZone: string): string {
  // Step from midday so a whole-day shift cannot land on a DST transition and
  // move the date by one more or one fewer day than asked for.
  const midday = clinicTimeToUtc(dateISO, '12:00:00', timeZone);
  return todayInZone(timeZone, new Date(midday.getTime() + days * 86_400_000));
}

/**
 * The UTC window covering one clinic day, for a range query.
 *
 * `to` is the first instant of the NEXT day, so a caller filters with an
 * exclusive upper bound and never has to reason about whether 23:59:59.999 is
 * inside the day. Computed per day rather than as `from + 24h`, because a
 * DST-transition day is 23 or 25 hours long.
 */
export function clinicDayRangeUtc(dateISO: string, timeZone: string): { from: Date; to: Date } {
  return {
    from: clinicTimeToUtc(dateISO, '00:00:00', timeZone),
    to: clinicTimeToUtc(shiftClinicDate(dateISO, 1, timeZone), '00:00:00', timeZone),
  };
}

/** Short weekday-and-day label for a date, read in the clinic's zone. */
export function clinicDateLabel(dateISO: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options })
    .format(clinicTimeToUtc(dateISO, '12:00:00', timeZone));
}
