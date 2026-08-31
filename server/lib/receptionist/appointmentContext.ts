import { partsAt } from '../scheduling';
import { spokenDate, spokenTime } from './clinicHours';
import type { LocaleFormat } from './localePacks/types';

// ===========================================================================
// The appointment a call is ABOUT, as runtime variables.
//
// An APPOINTMENT_REMINDER campaign used to carry its appointment details as
// static text inside `ReceptionistOutboundCampaign.script` — one clinician, one
// day, one time, written once, read to everybody on the list. This is the
// per-patient replacement: the bound appointment rendered in the BRANCH's
// timezone (where the patient is actually expected) and the CALL's locale
// format (12h/24h, weekday-month-day/weekday-day-month), so an en-GB patient is
// not read a US clock.
//
// It is `buildHoursDynamicVariables`' twin, and it obeys the same rule: a value
// we do not have is sent as an empty string. Never a placeholder like "your
// appointment" — a sentence the agent can speak without knowing anything is
// exactly how a reminder ends up stating an appointment that does not exist.
// ===========================================================================

/**
 * The appointment states voice is allowed to act on: the ones a patient could
 * still attend. It is the same answer to two questions — "may the agent change
 * this?" (liveTools) and "may a call be ABOUT this?" (the outbound binding) —
 * so it is defined once here, in the module with no database import, rather
 * than copied and left to drift apart.
 *
 * CANCELED, COMPLETED, NO_SHOW and ARRIVED are all appointments a reminder must
 * never state: the patient has already been, or already knows it is off.
 */
export const VOICE_MUTABLE_STATUSES = ['CONFIRMED', 'RISKY', 'WAITLIST'] as const;

export type VoiceMutableStatus = (typeof VOICE_MUTABLE_STATUSES)[number];

/** Every variable this module produces, present on EVERY outbound call. */
export const APPOINTMENT_DYNAMIC_VARIABLE_NAMES = [
  'appointment_id',
  'appointment_clinician',
  'appointment_date',
  'appointment_time',
  'appointment_service',
  'appointment_location',
] as const;

export type AppointmentDynamicVariableName = (typeof APPOINTMENT_DYNAMIC_VARIABLE_NAMES)[number];

/** The minimum an outbound call needs to state one appointment truthfully. */
export interface BoundAppointmentContext {
  id: string;
  startsAt: Date;
  service: string;
  /** The branch the patient is expected at; every time is rendered in it. */
  timezone: string;
  /** What the patient should hear as "where": the branch, not a database id. */
  locationName: string;
  /** Null when no clinician is recorded — spoken as nothing, never guessed. */
  clinicianName: string | null;
}

function emptyAppointmentVariables(): Record<AppointmentDynamicVariableName, string> {
  return Object.fromEntries(APPOINTMENT_DYNAMIC_VARIABLE_NAMES.map(name => [name, ''])) as Record<
    AppointmentDynamicVariableName,
    string
  >;
}

function localClock(minuteOfDay: number): string {
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
}

/**
 * The single producer of the appointment runtime variables. A target with no
 * bound appointment yields every key as an empty string rather than a missing
 * key, so the provider substitutes nothing instead of leaving `{{token}}` in a
 * sentence a patient would hear read aloud.
 */
export function buildAppointmentDynamicVariables(input: {
  appointment: BoundAppointmentContext | null;
  locale: LocaleFormat;
}): Record<AppointmentDynamicVariableName, string> {
  const { appointment, locale } = input;
  if (!appointment) return emptyAppointmentVariables();
  const local = partsAt(appointment.startsAt, appointment.timezone);
  return {
    appointment_id: appointment.id,
    appointment_clinician: appointment.clinicianName?.trim() ?? '',
    appointment_date: spokenDate(local.dateISO, locale),
    appointment_time: spokenTime(localClock(local.minuteOfDay), locale),
    appointment_service: appointment.service.trim(),
    appointment_location: appointment.locationName.trim(),
  };
}
