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
  version: 3,
  strings: {
    emergencyNumber: '911',
    timeStyle: '12h',
    dateStyle: 'weekday-month-day',
    messages: {
      'disclosure.recording': RECORDING_DISCLOSURE_EVIDENCE_TEMPLATE,
      // AB 3030: the disclaimer is required at the end as well as the start.
      // It names what the caller was speaking to and how to reach a person,
      // because the same statute requires that instruction too.
      'disclosure.closing': 'Before you go — just so you know, you have been speaking with {{agent_name}}, an AI assistant for {{clinic_name}}, and not a member of staff. If you would like to speak with a person about anything from this call, call us back and ask for the front desk. Take care.',
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

      // C4 — the caller is greeted before they are asked to consent to anything.
      'greeting.inbound': "Thanks for calling {{clinic_name}}. You've reached the front desk, and I can book, move or cancel an appointment, answer a question, or take a message for the team. One quick thing before we start.",

      // C3/C4 — the consent ladder. Refusing recording never costs the caller
      // the service; only an objection to the AI itself routes away.
      'consent.granted.ack': 'Thank you. So, how can I help you today?',
      'consent.refused.continue': "That's absolutely fine. This call won't be recorded, and we can carry straight on. How can I help you today?",
      'consent.declined.route': "Of course. I'll check the approved staff option. If a transfer is unavailable, I can record a request for the front desk, but I cannot confirm a callback or response time.",
      'consent.refused.recorded': "That's recorded. This call won't be recorded or transcribed, and I can still help you here.",

      // C6 — a lapsed or drifted deployment. The caller keeps a way through.
      'receptionist.degraded.unverified': "I can't open the appointment book on this call, so I don't want to guess at a time. I can take a message for the front desk right now, or put you through to someone. Which would you prefer?",
      'receptionist.degraded.verification_stale': "I can't reach the appointment system on this call, so I won't guess at a time. I can take a message for the front desk right now, or put you through to someone. Which would you prefer?",
      'receptionist.degraded.deployment_drift': "The front desk system is being updated right now, so I can't book on this call. I can take a message for the team straight away, or put you through to someone. Which would you prefer?",

      // C7 — an admission denial is still answered, and still offers a person.
      'admission.denied.capacity': "We're taking more calls than usual right now, so rather than keep you waiting I'll put you through to the front desk.",
      'admission.denied.demo': "Thanks for calling. This line is set up for demonstration only and isn't taking patient calls, so I won't take your details here. Please call the practice on its main number.",
      'admission.denied.unavailable': "I'm sorry, the automated line isn't available right now. Let me put you through to the front desk instead.",
      // Caller safety — routed to a person before the receptionist takes a
      // turn. Neither line tells the caller why they were routed.
      'admission.denied.human_only': "Thanks for calling. I'm putting you straight through to someone at the front desk now — please stay on the line.",
      'admission.denied.repeat_caller': "Thanks for calling back. Rather than have you go through this again, I'm putting you straight through to someone at the front desk — please stay on the line.",

      // Caller safety — the emergency path happens on the call, not on a board
      // somebody may not be watching.
      'emergency.transfer.line': 'The staff review request is recorded. Do not delay seeking emergency help.',
      'emergency.callback.line': 'The staff review request is recorded. A callback is not confirmed. Do not delay seeking emergency help.',

      // Caller safety — comprehension. One retry, then a person. Nothing here
      // asks the caller to change how they speak or what they are calling from.
      'comprehension.retry': "I'm sorry, that's my fault — I didn't catch that. Could you tell me again?",
      'comprehension.bail_out.transfer': "I'm sorry — this is me, not you, and I don't want to keep you repeating yourself. I've recorded a request for staff and will try the transfer now.",
      'comprehension.bail_out.callback': "I'm sorry — this is me, not you, and I don't want to keep you repeating yourself. I've recorded a request for the front desk. I cannot confirm a callback or response time.",

      // C12 — what the caller hears when they ask for a human. The task id and
      // the acknowledgment state stay in the structured result, not here.
      'handoff.spoken': "Of course. I've passed this to the front desk with your number, so it won't be lost. Let me see if someone is free to pick up now.",
      'handoff.no_transfer': "I've recorded your request for the front desk. I cannot confirm a callback or response time. Is there anything you'd like me to add for them?",

      // C10 — booking and availability results, previously hardcoded en-US.
      'tool.availability.none': "I don't have any openings on {{date}}. Would a different day work?",
      'tool.availability.offer': 'On {{date}} I have {{times}}. Which works best for you?',
      'tool.availability.needs_review': "I can't confirm the right clinician for that on this call. I can take a message so the front desk can call you back with times.",
      'tool.booking.confirmed': "Perfect, {{first_name}}. You're booked for {{booking}}.{{confirmation}}",
      'tool.booking.already': "You're already booked for {{booking}}.{{confirmation}}",
      'tool.booking.confirmation_accepted': "I've sent your confirmation; I can't confirm it has arrived yet.",
      'tool.confirm.recorded': 'Thank you — I have recorded that you are attending.',
      'tool.confirm.already': 'Thank you — that appointment is already confirmed.',
      'tool.confirm.not_confirmable': "That appointment is not one I can confirm on this call. I can connect you with the front desk.",
      'tool.confirm.locked': "That appointment can no longer be confirmed automatically. I can connect you with the front desk.",
      'tool.message.recorded': "Thank you. I've recorded your message for the front desk. I cannot confirm a callback or response time.",
      'tool.message.appended': "Thank you. I've added that to the same note for the front desk. I cannot confirm a callback or response time.",
      // The reminder, in this patient's own details. The holes are runtime
      // variables resolved at dial time from the appointment the call target is
      // bound to; the campaign script no longer gets to state them.
      'reminder.appointment.line': "I'm calling about your {{appointment_service}} appointment on {{appointment_date}} at {{appointment_time}}, at {{appointment_location}}.",
      'reminder.appointment.clinician': "You're booked in with {{appointment_clinician}}.",
    },
  },
};

const EN_GB_V1: PlatformLocalePack = {
  language: 'en-GB',
  country: 'GB',
  version: 3,
  strings: {
    emergencyNumber: '999',
    timeStyle: '24h',
    dateStyle: 'weekday-day-month',
    messages: {
      'disclosure.recording': "Hi, I'm {{agent_name}}, an AI assistant for {{clinic_name}}. This call may be recorded or monitored for quality and training purposes.{{clinic_disclosure}} Is that okay?",
      'disclosure.closing': 'Before you go — just so you know, you have been speaking with {{agent_name}}, an AI assistant for {{clinic_name}}, and not a member of the team. If you would like to speak with a person about anything from this call, ring us back and ask for reception. Take care.',
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

      // C4 — the caller is greeted before they are asked to consent to anything.
      'greeting.inbound': "Thanks for calling {{clinic_name}}. You've reached reception, and I can book, move or cancel an appointment, answer a question, or take a message for the team. One quick thing before we start.",

      // C3/C4 — the consent ladder. Refusing recording never costs the caller
      // the service; only an objection to the AI itself routes away.
      'consent.granted.ack': 'Thank you. So, how can I help you today?',
      'consent.refused.continue': "That's absolutely fine. This call won't be recorded, and we can carry straight on. How can I help you today?",
      'consent.declined.route': "Of course. I'll check the approved staff option. If a transfer is unavailable, I can record a request for reception, but I cannot confirm a callback or response time.",
      'consent.refused.recorded': "That's recorded. This call won't be recorded or transcribed, and I can still help you here.",

      // C6 — a lapsed or drifted deployment. The caller keeps a way through.
      'receptionist.degraded.unverified': "I can't open the appointment book on this call, so I don't want to guess at a time. I can take a message for reception right now, or put you through to someone. Which would you prefer?",
      'receptionist.degraded.verification_stale': "I can't reach the appointment system on this call, so I won't guess at a time. I can take a message for reception right now, or put you through to someone. Which would you prefer?",
      'receptionist.degraded.deployment_drift': "The reception system is being updated right now, so I can't book on this call. I can take a message for the team straight away, or put you through to someone. Which would you prefer?",

      // C7 — an admission denial is still answered, and still offers a person.
      'admission.denied.capacity': "We're taking more calls than usual right now, so rather than keep you waiting I'll put you through to reception.",
      'admission.denied.demo': "Thanks for calling. This line is set up for demonstration only and isn't taking patient calls, so I won't take your details here. Please ring the practice on its main number.",
      'admission.denied.unavailable': "I'm sorry, the automated line isn't available right now. Let me put you through to reception instead.",
      // Caller safety — routed to a person before the receptionist takes a
      // turn. Neither line tells the caller why they were routed.
      'admission.denied.human_only': "Thanks for calling. I'm putting you straight through to someone at reception now — please stay on the line.",
      'admission.denied.repeat_caller': "Thanks for ringing back. Rather than have you go through this again, I'm putting you straight through to someone at reception — please stay on the line.",

      // Caller safety — the emergency path happens on the call, not on a board
      // somebody may not be watching.
      'emergency.transfer.line': 'The staff review request is recorded. Do not delay seeking emergency help.',
      'emergency.callback.line': 'The staff review request is recorded. A callback is not confirmed. Do not delay seeking emergency help.',

      // Caller safety — comprehension. One retry, then a person. Nothing here
      // asks the caller to change how they speak or what they are calling from.
      'comprehension.retry': "I'm sorry, that's my fault — I didn't catch that. Could you tell me again?",
      'comprehension.bail_out.transfer': "I'm sorry — this is me, not you, and I don't want to keep you repeating yourself. I've recorded a request for staff and will try the transfer now.",
      'comprehension.bail_out.callback': "I'm sorry — this is me, not you, and I don't want to keep you repeating yourself. I've recorded a request for reception. I cannot confirm a callback or response time.",

      // C12 — what the caller hears when they ask for a human. The task id and
      // the acknowledgment state stay in the structured result, not here.
      'handoff.spoken': "Of course. I've passed this to reception with your number, so it won't be lost. Let me see if someone is free to pick up now.",
      'handoff.no_transfer': "I've recorded your request for reception. I cannot confirm a callback or response time. Is there anything you'd like me to add for them?",

      // C10 — booking and availability results, previously hardcoded en-US.
      'tool.availability.none': "I don't have any openings on {{date}}. Would a different day work?",
      'tool.availability.offer': 'On {{date}} I have {{times}}. Which suits you best?',
      'tool.availability.needs_review': "I can't confirm the right clinician for that on this call. I can take a message so reception can ring you back with times.",
      'tool.booking.confirmed': "Perfect, {{first_name}}. You're booked for {{booking}}.{{confirmation}}",
      'tool.booking.already': "You're already booked for {{booking}}.{{confirmation}}",
      'tool.booking.confirmation_accepted': "I've sent your confirmation; I can't confirm it has arrived yet.",
      'tool.confirm.recorded': 'Thank you — I have recorded that you are attending.',
      'tool.confirm.already': 'Thank you — that appointment is already confirmed.',
      'tool.confirm.not_confirmable': "That appointment is not one I can confirm on this call. I can put you through to reception.",
      'tool.confirm.locked': "That appointment can no longer be confirmed automatically. I can put you through to reception.",
      'tool.message.recorded': "Thank you. I've recorded your message for reception. I cannot confirm a callback or response time.",
      'tool.message.appended': "Thank you. I've added that to the same note for reception. I cannot confirm a callback or response time.",
      'reminder.appointment.line': "I'm ringing about your {{appointment_service}} appointment on {{appointment_date}} at {{appointment_time}}, at {{appointment_location}}.",
      'reminder.appointment.clinician': "You're booked in with {{appointment_clinician}}.",
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
