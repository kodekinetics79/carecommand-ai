import { RECORDING_DISCLOSURE_EVIDENCE_TEMPLATE } from '../privacyLifecycle';
import { localePackEvidenceHash } from './render';
import type { LocalePackStrings } from './types';

// ===========================================================================
// Platform-default locale packs. These are the only caller-facing words that
// ship in code, and they are never spoken until a tenant adopts and approves
// them (approval carries approvedByUserId). Changing any string here is a
// deliberate, reviewed change: receptionistLocalePacks.unit.test.ts pins the
// evidence hashes as literals.
//
// en-US v1 `disclosure.recording` is byte-equal to the pre-C2 evidence
// template so every historical consent disclosureTextHash stays reproducible.
// ===========================================================================

export interface PlatformLocalePack {
  language: string;
  country: string;
  version: number;
  strings: LocalePackStrings;
}

const EN_US_V1: PlatformLocalePack = {
  language: 'en-US',
  country: 'US',
  version: 1,
  strings: {
    emergencyNumber: '911',
    timeStyle: '12h',
    dateStyle: 'weekday-month-day',
    messages: {
      'disclosure.recording': RECORDING_DISCLOSURE_EVIDENCE_TEMPLATE,
      'dnc.acknowledge': 'I heard your request. I am recording it now.',
      'dnc.confirmed': 'Your do-not-contact request is recorded. I will end the call now.',
      'dnc.failed': 'I could not confirm that the request was recorded. I will end this call and flag it for staff review.',
      'voicemail.script': 'This is {{agent_name}}, an AI assistant calling for {{clinic_name}}. Please call {{clinic_phone}}. Goodbye.',
      'summary.line': 'Perfect. I have {{fields}}. Is everything correct?',
      'not_interested.line': 'No problem at all. Would you like us not to contact you again about this offer?',
      'emergency.instruction': 'If this may be an emergency, hang up and call {{emergency_number}} now, or go to the nearest emergency room.',
      'after_hours.line': 'Thanks for calling {{clinic_name}}. The office is currently closed. Our next opening is {{next_opening}}.',
      'human_fallback.line': 'No staff transfer is available on this line right now. I can take a message for the front desk instead.',
      'tool.emergency.message': 'If you may be experiencing an emergency, hang up and call {{emergency_number}} now, or go to the nearest emergency room. Do not wait for a callback from this office.',
      'tool.availability.closed': '{{clinic_name}} is closed on {{date}}. Would a different day work?',
      'tool.availability.closed_reason': '{{clinic_name}} is closed on {{date}} for {{closure_reason}}. Would a different day work?',
    },
  },
};

const EN_GB_V1: PlatformLocalePack = {
  language: 'en-GB',
  country: 'GB',
  version: 1,
  strings: {
    emergencyNumber: '999',
    timeStyle: '24h',
    dateStyle: 'weekday-day-month',
    messages: {
      'disclosure.recording': "Hi, I'm {{agent_name}}, an AI assistant for {{clinic_name}}. This call may be recorded or monitored for quality and training purposes.{{clinic_disclosure}} Is that okay?",
      'dnc.acknowledge': 'I heard your request. I am recording it now.',
      'dnc.confirmed': 'Your do-not-contact request is recorded. I will end the call now.',
      'dnc.failed': 'I could not confirm that the request was recorded. I will end this call and flag it for the team to review.',
      'voicemail.script': 'This is {{agent_name}}, an AI assistant calling for {{clinic_name}}. Please call {{clinic_phone}}. Goodbye.',
      'summary.line': 'Perfect. I have {{fields}}. Is everything correct?',
      'not_interested.line': 'No problem at all. Would you like us not to contact you again about this offer?',
      'emergency.instruction': 'If this may be an emergency, please hang up and call {{emergency_number}} now, or go to your nearest A&E.',
      'after_hours.line': 'Thanks for calling {{clinic_name}}. The practice is currently closed. We next open {{next_opening}}.',
      'human_fallback.line': 'No staff transfer is available on this line right now. I can take a message for reception instead.',
      'tool.emergency.message': 'If you may be experiencing an emergency, hang up and call {{emergency_number}} now, or go to your nearest A&E. Do not wait for a call back from this practice.',
      'tool.availability.closed': '{{clinic_name}} is closed on {{date}}. Would a different day work?',
      'tool.availability.closed_reason': '{{clinic_name}} is closed on {{date}} for {{closure_reason}}. Would a different day work?',
    },
  },
};

export const PLATFORM_LOCALE_PACKS: readonly PlatformLocalePack[] = [EN_US_V1, EN_GB_V1];

export function platformLocalePack(language: string, country: string): PlatformLocalePack | null {
  return PLATFORM_LOCALE_PACKS.find(pack => pack.language === language && pack.country === country) ?? null;
}

/** Country-only fallback (first default listed for that country), used for legacy calls with no approved pack. */
export function platformLocalePackForCountry(country: string): PlatformLocalePack | null {
  return PLATFORM_LOCALE_PACKS.find(pack => pack.country === country) ?? null;
}

export function platformLocalePackHash(pack: PlatformLocalePack): string {
  return localePackEvidenceHash(pack.strings);
}

/** Number-free fallback when no pack and no country can be resolved for a call. */
export const EMERGENCY_FALLBACK_NUMBER_FREE = 'If this may be an emergency, hang up and call your local emergency number now.';
