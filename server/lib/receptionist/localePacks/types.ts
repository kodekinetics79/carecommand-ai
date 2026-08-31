// ===========================================================================
// Locale pack contract (Phase 2 contract freeze §2).
//
// A pack is the complete set of caller-facing strings for one (language,
// country). Platform defaults live in code (defaults.ts); tenants adopt one as
// a DRAFT row and an OWNER/ADMIN approves it. Every string uses one placeholder
// syntax, `{{var}}` (Retell-compatible), and each key has its own allowlist of
// variables: an unknown placeholder is a validation error, so a rendered pack
// can never leak `{{` into a prompt.
// ===========================================================================

export type TimeStyle = '12h' | '24h';
export type DateStyle = 'weekday-month-day' | 'weekday-day-month';

export interface LocalePackStrings {
  /** Digits only, e.g. '911', '999', '112', '000'. */
  emergencyNumber: string;
  timeStyle: TimeStyle;
  dateStyle: DateStyle;
  /** Dotted-key message map; see LOCALE_PACK_MESSAGE_KEYS. */
  messages: Record<string, string>;
}

/** Formatting facts the hours engine and live tools need from a pack. */
export interface LocaleFormat {
  language: string;
  timeStyle: TimeStyle;
  dateStyle: DateStyle;
}

export interface MessageKeyContract {
  /** Placeholders this key may use. Anything else fails validation. */
  vars: readonly string[];
  /** Placeholders that MUST appear (e.g. the disclosure must name the agent). */
  mustContain?: readonly string[];
  /** Human description for the Studio editor. */
  describe: string;
}

// C2 seeds the keys it renders. C3 appends its keys (consent.*, tool.*,
// receptionist.degraded.*) here together with en-US/en-GB defaults as a new
// platform-default version; unknown keys are rejected by the validator so a
// typo cannot silently create dead wording.
export const LOCALE_PACK_MESSAGE_KEYS = {
  'disclosure.recording': {
    vars: ['agent_name', 'clinic_name', 'clinic_disclosure'],
    mustContain: ['agent_name', 'clinic_name'],
    describe: 'Opening AI + recording disclosure. Its rendered text is hashed as consent evidence.',
  },

  // --- Caller safety: the closing disclosure -------------------------------
  // California AB 3030 requires the AI disclaimer on an audio interaction to be
  // given verbally at the START *and* AT THE END. Every pack shipped an opening
  // key and no closing one at all, so a US clinic answering with this product
  // was out of compliance on every completed call.
  //
  // It is the opening disclosure's twin in every respect that matters: the
  // baseline text is product-owned, it is rendered as a required final turn
  // rather than a suggestion, its rendered text is hashed as evidence, and its
  // ABSENCE FROM THE APPROVED PACK is a blocking readiness failure. A pack that
  // acquires it only by platform backfill has not attested to it, and its
  // evidence hash does not cover it — which is exactly what the readiness check
  // refuses. AB 3030 also requires clear instructions for reaching a human, so
  // the closing line says how, in the same breath.
  'disclosure.closing': {
    vars: ['agent_name', 'clinic_name'],
    mustContain: ['agent_name', 'clinic_name'],
    describe: 'Closing AI disclosure, spoken as the last turn of every call. Required by California AB 3030 and hashed as evidence.',
  },
  'dnc.acknowledge': { vars: [], describe: 'Spoken immediately when a caller asks not to be contacted again.' },
  'dnc.confirmed': { vars: [], describe: 'Spoken only after the do-not-call tool confirms success.' },
  'dnc.failed': { vars: [], describe: 'Spoken when the do-not-call tool failed or was uncertain.' },
  'voicemail.script': { vars: ['agent_name', 'clinic_name', 'clinic_phone'], describe: 'The only words left on a voicemail.' },
  'summary.line': { vars: ['fields'], describe: 'Read-back before booking; {{fields}} is the intake field list.' },
  'not_interested.line': { vars: [], describe: 'Spoken when the caller declines the offer.' },
  'emergency.instruction': { vars: ['emergency_number'], describe: 'Life-threatening emergency instruction in the prompt.' },
  'after_hours.line': { vars: ['clinic_name', 'next_opening'], describe: 'First sentence when the office is closed.' },
  'human_fallback.line': { vars: [], describe: 'Spoken when no staff transfer is configured.' },
  'tool.emergency.message': { vars: ['emergency_number'], describe: 'Returned by the report_emergency tool for the agent to speak.' },
  'tool.availability.closed': { vars: ['clinic_name', 'date'], describe: 'check_availability on a closed day (no closure reason).' },
  'tool.availability.closed_reason': { vars: ['clinic_name', 'date', 'closure_reason'], describe: 'check_availability on a closure day with a spoken reason.' },

  // --- C4: the caller's first turn -----------------------------------------
  // The disclosure alone is an interrogation. This is the sentence spoken
  // immediately before it, in the same turn, so the caller is greeted by their
  // own clinic before being asked to consent to anything.
  'greeting.inbound': {
    vars: ['clinic_name', 'agent_name'],
    mustContain: ['clinic_name'],
    describe: 'Warm opening sentence an inbound caller hears, spoken immediately before the disclosure in the same turn.',
  },

  // --- C3/C4: the consent ladder (Phase 2 contract freeze section 2) --------
  // GRANTED hands the turn straight back to the caller. REFUSED stops the
  // recording, never the service. DECLINED is reserved for an explicit
  // objection to speaking with an AI, which is the only branch that routes
  // away from this line.
  'consent.granted.ack': { vars: [], describe: 'Spoken once recording consent is granted; hands the turn back to the caller.' },
  'consent.refused.continue': { vars: [], describe: 'Spoken when the caller refuses or withdraws recording. The call CONTINUES on basic attributes; it is never ended.' },
  'consent.declined.route': { vars: [], describe: 'Spoken only when the caller objects to speaking with an AI at all; routes to a person.' },
  'consent.refused.recorded': { vars: [], describe: 'Returned by record_recording_preference once a refusal or withdrawal is stored.' },

  // --- C6: the inbound degrade path ----------------------------------------
  // Keys are addressed by `inboundDegradePolicy().messageKey`; a lapsed or
  // drifted deployment speaks one of these and keeps the safe tools instead of
  // hanging up on the patient.
  'receptionist.degraded.unverified': { vars: [], describe: 'Spoken when this line has no verified receptionist configuration; message-taking and handoff still work.' },
  'receptionist.degraded.verification_stale': { vars: [], describe: 'Spoken when the verification lapsed; message-taking and handoff still work.' },
  'receptionist.degraded.deployment_drift': { vars: [], describe: 'Spoken when the deployment changed mid-call; message-taking and handoff still work.' },

  // --- C7: admission denial -------------------------------------------------
  // A denied caller must hear a sentence and be offered a person. Silence, or
  // a dropped line, is never an acceptable answer to a patient.
  'admission.denied.capacity': { vars: [], describe: 'Spoken when the tenant is already at its simultaneous-call limit.' },
  'admission.denied.demo': { vars: [], describe: 'Spoken when the workspace is in demonstration mode and may not take a patient call.' },
  'admission.denied.unavailable': { vars: [], describe: 'Spoken when the AI line is unavailable for any other admission reason.' },
  // Caller safety: the two routings that happen BEFORE the receptionist takes a
  // turn. Neither is a denial the caller caused, and neither says why — a
  // patient does not need to be told they are flagged, only that a person is
  // coming.
  'admission.denied.human_only': { vars: [], describe: 'Spoken when this caller is marked Human only. Routed straight to a person with no AI turn; never explains the flag.' },
  'admission.denied.repeat_caller': { vars: [], describe: 'Spoken when this number has reached the line repeatedly in a short window and the AI is evidently not helping.' },

  // --- C12: human handoff ---------------------------------------------------
  // Durable evidence (task id, acknowledgment state, transfer state) belongs in
  // the structured tool result. These are the only words the caller hears.
  'handoff.spoken': { vars: [], describe: 'Spoken by request_human_handoff when a staff transfer can be attempted on this line.' },
  'handoff.no_transfer': { vars: [], describe: 'Spoken by request_human_handoff when no transfer target is configured.' },

  // --- C10: tool results that were hardcoded en-US in liveTools -------------
  'tool.availability.none': { vars: ['date'], describe: 'check_availability found no offerable slot on an open day.' },
  'tool.availability.offer': { vars: ['date', 'times'], describe: 'check_availability offering real slots; {{times}} is the spoken slot list.' },
  'tool.availability.needs_review': { vars: [], describe: 'check_availability cannot resolve a clinician or service for this call.' },
  'tool.booking.confirmed': { vars: ['first_name', 'booking', 'confirmation'], describe: 'book_appointment succeeded; {{booking}} is the spoken appointment.' },
  'tool.booking.already': { vars: ['booking', 'confirmation'], describe: 'book_appointment replayed against an existing booking.' },
  'tool.booking.confirmation_accepted': { vars: [], describe: 'Appended to a booking confirmation only when the messaging provider accepted the send.' },
  'tool.confirm.recorded': { vars: [], describe: 'confirm_appointment recorded that the patient said they are attending. States what was written down, never that anything was changed.' },
  'tool.confirm.already': { vars: [], describe: 'confirm_appointment replayed against an appointment already confirmed. Thanks the caller without implying a second confirmation was recorded.' },
  'tool.confirm.not_confirmable': { vars: [], describe: 'confirm_appointment refused because the appointment has already started. Offers a human rather than explaining the rule.' },
  'tool.confirm.locked': { vars: [], describe: 'confirm_appointment refused because the appointment is cancelled, completed or otherwise no longer confirmable by voice. Offers a human.' },
  'tool.message.recorded': { vars: [], describe: 'take_message recorded a new callback request.' },
  'tool.message.appended': { vars: [], describe: 'take_message appended to the callback request already open for this call.' },

  // --- The appointment an outbound reminder is actually about --------------
  // Until now a reminder campaign stated its appointment from static text in
  // the campaign script: one clinician, one day, one time, written once and
  // read to every patient on the list. These two keys are the per-patient
  // replacement, and their holes are the runtime variables the dial resolves
  // from the target's BOUND appointment — so the words stay a clinic's to
  // change and the facts stay the patient's own.
  //
  // Split in two on purpose. Service, date, time and location are present on
  // every appointment row; a clinician is not. Folding an optional value into
  // the required sentence is how a patient ends up hearing "with , on Tuesday".
  'reminder.appointment.line': {
    vars: ['appointment_service', 'appointment_date', 'appointment_time', 'appointment_location'],
    mustContain: ['appointment_date', 'appointment_time'],
    describe: 'Outbound reminder: the appointment this call is about, in the branch timezone and this pack\'s date/time style. A reminder that cannot say when is not a reminder, so the date and time are required.',
  },
  'reminder.appointment.clinician': {
    vars: ['appointment_clinician'],
    mustContain: ['appointment_clinician'],
    describe: 'Outbound reminder: who the patient is booked in with. Spoken as its own sentence and ONLY when a clinician is recorded, never as an empty hole inside the appointment line.',
  },

  // --- Caller safety: the emergency path happens ON THE CALL ---------------
  // An emergency used to produce a StaffTask and a critical signal, and the
  // Front Desk board was the only thing that surfaced it: in-app only, a 20
  // second poll, nobody alerted if no tab is open. An emergency could sit
  // overnight behind a masked number. These two lines are what the receptionist
  // says while it actually places the transfer or takes the callback, in the
  // same turn as the emergency instruction. The board card becomes the record
  // of what happened, not the mechanism that makes it happen.
  'emergency.transfer.line': { vars: [], describe: 'Spoken immediately after the emergency instruction when the receptionist is placing the transfer to a person during the call.' },
  'emergency.callback.line': { vars: [], describe: 'Spoken immediately after the emergency instruction when no transfer target exists and an immediate callback is being arranged instead.' },

  // --- Caller safety: comprehension ----------------------------------------
  // A stroke survivor tried five times to book an appointment and could not get
  // past an AI line. After two consecutive turns it cannot parse, the
  // receptionist stops trying: it apologises plainly and hands over. There is no
  // third attempt, and none of these lines may instruct the caller to change how
  // they speak, what they are calling from, or where they are.
  'comprehension.retry': { vars: [], describe: 'Spoken after ONE turn the receptionist could not parse. The only retry there is; it never asks the caller to change anything about themselves.' },
  'comprehension.bail_out.transfer': { vars: [], describe: 'Spoken on the second consecutive unparseable turn when a person can be reached: apologise and hand over. Never a third attempt.' },
  'comprehension.bail_out.callback': { vars: [], describe: 'Spoken on the second consecutive unparseable turn when no transfer target exists: apologise and take a callback. Never a third attempt.' },
} as const satisfies Record<string, MessageKeyContract>;

export type LocalePackMessageKey = keyof typeof LOCALE_PACK_MESSAGE_KEYS;

export const LOCALE_PACK_SOURCES = ['platform_default', 'tenant'] as const;
export type LocalePackSource = (typeof LOCALE_PACK_SOURCES)[number];

export const TIME_STYLES: readonly TimeStyle[] = ['12h', '24h'];
export const DATE_STYLES: readonly DateStyle[] = ['weekday-month-day', 'weekday-day-month'];
