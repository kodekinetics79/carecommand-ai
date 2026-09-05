export type ClinicLocalDateTimeResult =
  | { iso: string; error: null }
  | { iso: null; error: 'invalid' | 'nonexistent' | 'ambiguous' };

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...options,
  });
}

function partsAt(date: Date, timeZone: string): LocalParts {
  const values = Object.fromEntries(
    formatter(timeZone).formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function sameParts(left: LocalParts, right: LocalParts) {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}

function parseLocal(value: string): LocalParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]),
  };
  const roundTrip = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  if (roundTrip.getUTCFullYear() !== parts.year || roundTrip.getUTCMonth() + 1 !== parts.month
    || roundTrip.getUTCDate() !== parts.day || parts.hour > 23 || parts.minute > 59) return null;
  return parts;
}

/** Convert an HTML datetime-local value as clinic wall time, never browser time. */
export function clinicLocalDateTimeToIso(value: string, timeZone: string): ClinicLocalDateTimeResult {
  const wanted = parseLocal(value);
  if (!wanted) return { iso: null, error: 'invalid' };
  try {
    const wallClockMs = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
    let candidateMs = wallClockMs;
    // Converge from a UTC guess onto the instant whose rendered clinic wall time
    // matches the value the patient entered. Two passes cover modern IANA zones.
    for (let index = 0; index < 3; index += 1) {
      const shown = partsAt(new Date(candidateMs), timeZone);
      const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
      candidateMs += wallClockMs - shownAsUtc;
    }
    const candidate = new Date(candidateMs);
    if (!sameParts(partsAt(candidate, timeZone), wanted)) return { iso: null, error: 'nonexistent' };

    // A fall-back hour occurs twice. Refuse to guess which instant the patient
    // meant; staff can review the request instead of receiving a shifted time.
    const alternatives = [-3_600_000, 3_600_000]
      .map(delta => new Date(candidateMs + delta))
      .filter(date => sameParts(partsAt(date, timeZone), wanted));
    if (alternatives.length > 0) return { iso: null, error: 'ambiguous' };
    return { iso: candidate.toISOString(), error: null };
  } catch {
    return { iso: null, error: 'invalid' };
  }
}

export function formatClinicDateTime(value: string, timeZone: string, options: Intl.DateTimeFormatOptions = {}) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      ...options,
    }).format(new Date(value));
  } catch {
    return 'Time unavailable';
  }
}

export function formatClinicTime(value: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(value));
  } catch {
    return 'Time unavailable';
  }
}

export function clinicDateOffset(days: number, timeZone: string, now = new Date()) {
  const current = partsAt(now, timeZone);
  const shifted = new Date(Date.UTC(current.year, current.month - 1, current.day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}
