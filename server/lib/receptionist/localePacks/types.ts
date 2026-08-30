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
} as const satisfies Record<string, MessageKeyContract>;

export type LocalePackMessageKey = keyof typeof LOCALE_PACK_MESSAGE_KEYS;

export const LOCALE_PACK_SOURCES = ['platform_default', 'tenant'] as const;
export type LocalePackSource = (typeof LOCALE_PACK_SOURCES)[number];

export const TIME_STYLES: readonly TimeStyle[] = ['12h', '24h'];
export const DATE_STYLES: readonly DateStyle[] = ['weekday-month-day', 'weekday-day-month'];
