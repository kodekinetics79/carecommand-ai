// ===========================================================================
// "The patient said they are coming" — one reading, one wording, everywhere.
//
// WHY THIS IS NOT `status`
//
// `Appointment.status` defaults to CONFIRMED the moment a row is created, so it
// only ever means "the clinic booked this". A patient's own "yes" is a
// different fact and lives in its own columns (`patientConfirmedAt`,
// `patientConfirmationSource`, `patientConfirmedCallLogId`). A reminder
// campaign exists to turn the first into the second, so a screen that collapses
// them shows a clinic nothing it did not already know.
//
// Absence means "not confirmed", never "declined" — a patient who declines
// cancels, which is a status change. So nothing here ever renders a negative
// claim: a row with no confirmation gets no confirmation badge, not a
// "not confirmed" one.
//
// Every consumer reads through `readPatientConfirmation`, which returns null
// unless the SERVER sent a real timestamp. There is no default, no `?? now`,
// and no way to produce a confirmation from a field the response did not carry.
// ===========================================================================

/**
 * The only sources the database will accept
 * (`Appointment_patient_confirmation_source_known_check`). An unrecognised
 * string is read as "we cannot say how", never guessed at.
 */
export type PatientConfirmationSource = 'receptionist_call' | 'staff' | 'patient_portal';

const KNOWN_SOURCES: readonly string[] = ['receptionist_call', 'staff', 'patient_portal'];

/** A confirmation that actually happened, with the evidence that proves it. */
export interface PatientConfirmation {
  /** ISO instant the patient said they are attending. */
  readonly confirmedAt: string;
  /** How they told us, when the server said. Null = recorded without a source. */
  readonly source: PatientConfirmationSource | null;
  /** The call record that evidences it, when a call produced it. */
  readonly callLogId: string | null;
}

/** The raw appointment fields as the API sends them. */
export interface PatientConfirmationFields {
  patientConfirmedAt?: string | null;
  patientConfirmationSource?: string | null;
  patientConfirmedCallLogId?: string | null;
}

/**
 * The single admission test. A confirmation exists only when the response
 * carried a parseable instant; anything else — absent, empty, unparseable — is
 * "not confirmed", which renders as nothing at all.
 */
export function readPatientConfirmation(row: PatientConfirmationFields | null | undefined): PatientConfirmation | null {
  const raw = row?.patientConfirmedAt;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  if (Number.isNaN(new Date(raw).getTime())) return null;
  const rawSource = row?.patientConfirmationSource;
  const source = typeof rawSource === 'string' && KNOWN_SOURCES.includes(rawSource)
    ? (rawSource as PatientConfirmationSource)
    : null;
  const rawCallLogId = row?.patientConfirmedCallLogId;
  return {
    confirmedAt: raw,
    source,
    callLogId: typeof rawCallLogId === 'string' && rawCallLogId.trim() !== '' ? rawCallLogId : null,
  };
}

/**
 * The badge. Deliberately NOT the word "confirmed": the status badge beside it
 * already says the clinic's booking is confirmed, and two badges reading
 * "Confirmed" on one row is exactly the collapse this feature exists to avoid.
 */
export const PATIENT_CONFIRMED_BADGE = 'Patient said they’re coming';

/** What the clinic reads on hover, in their words rather than ours. */
export const PATIENT_CONFIRMED_EXPLANATION =
  'The patient themselves told us they are attending. This is separate from the clinic’s own booking status.';

const SOURCE_PHRASE: Record<PatientConfirmationSource, string> = {
  receptionist_call: 'on a phone call',
  staff: 'to a member of staff',
  patient_portal: 'in their patient portal',
};

/**
 * One plain sentence: how they told us and when. No provider names, no source
 * codes, no ids.
 */
export function patientConfirmationDetail(confirmation: PatientConfirmation, timezone?: string): string {
  const when = new Date(confirmation.confirmedAt).toLocaleString(undefined, {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  const how = confirmation.source ? ` ${SOURCE_PHRASE[confirmation.source]}` : '';
  return `Told us${how} on ${when}.`;
}

/**
 * "3 of 12 patients have told us they are coming."
 *
 * Both numbers must come from the SAME received response. Never call this to
 * fill a hole left by a failed or in-flight request — see src/lib/resourceState.ts.
 */
export function patientConfirmedSummary(confirmed: number, total: number): string {
  const people = total === 1 ? 'patient' : 'patients';
  return `${confirmed} of ${total} ${people} have told us they’re coming.`;
}
